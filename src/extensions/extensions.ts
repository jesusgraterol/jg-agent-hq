import { createHash } from 'node:crypto';
import { Exception } from 'jg-exception';
import { z } from 'zod';

import type { IHqResponse, IMcpRequest, IManagedThread } from '../contracts/index.js';
import { getErrorKind } from '../errors/index.js';
import type { createProviderRegistry, IBoundAgentProvider } from '../providers/registry/index.js';
import { resolveWorkspaceTarget } from '../runtime/state/index.js';
import { decodeHistoryCursor, encodeHistoryCursor } from '../sessions/index.js';
import type { IStore } from '../store/index.js';

type IMcpResponse = Extract<IHqResponse, { kind: 'mcp-servers' | 'mcp-tools' | 'mcp-resources' }>;
const PositionSchema = z.strictObject({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  id: z.string().min(1).max(4096),
});

/**
 * Uses full bounded native leaf inventories to bind a stable seek cursor to their content.
 * @returns One content-revision page; native additions and removals invalidate continuation.
 * @throws
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 */
const pageInventory = <T extends { name: string; id?: string }>(
  data: T[],
  command: IMcpRequest,
) => {
  const { cursor, ...filters } = command;
  const key = (entry: T) => entry.id ?? entry.name;
  data.sort((left, right) => (key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0));
  const revision = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  const invalid = (): never => {
    throw new Exception('The HQ cursor does not match this request', {
      code: 'JG_AGENT_HQ_CURSOR_INVALID',
      data: { kind: 'invalid-request' },
    });
  };
  const decoded = decodeHistoryCursor(cursor, filters);
  let after: string | null = null;
  if (decoded) {
    let raw: unknown;
    try {
      raw = JSON.parse(decoded);
    } catch {
      return invalid();
    }
    const position = PositionSchema.safeParse(raw);
    if (!position.success || position.data.revision !== revision) return invalid();
    after = position.data.id;
  }
  if (data.some((entry, index) => index > 0 && key(data[index - 1]!) === key(entry))) return null;
  const start = after === null ? 0 : data.findIndex((entry) => key(entry) > after!);
  const selected = start < 0 ? [] : data.slice(start, start + command.limit);
  const last = selected.at(-1);
  return {
    data: selected,
    nextCursor: encodeHistoryCursor(
      last && start + selected.length < data.length
        ? JSON.stringify({ revision, id: key(last) })
        : null,
      filters,
    ),
  };
};

/**
 * Authorizes session-scoped native MCP reads with bounded, query-bound presentation.
 * @returns Configured server and leaf-inventory reads without global configuration injection.
 */
export const createExtensions = (
  registry: ReturnType<typeof createProviderRegistry>,
  store: IStore,
  roots: string[],
) => {
  const pending = new Map<string, Promise<IMcpResponse>>();
  const unavailable = (command: IMcpRequest, thread: IManagedThread): IMcpResponse => ({
    kind: command.kind,
    result: {
      provider: thread.provider,
      state: 'unavailable',
      observedAt: null,
      unavailableCount: 0,
      data: [],
      nextCursor: null,
    },
  });
  const scan = async (
    command: IMcpRequest,
    thread: IManagedThread,
    provider: IBoundAgentProvider,
  ): Promise<IMcpResponse> => {
    if (command.kind === 'mcp-servers') {
      const { cursor, ...filters } = command;
      const nativeCursor = decodeHistoryCursor(cursor, filters) ?? undefined;
      const page = await provider.readMcpServers(thread.nativeId!, command.limit, nativeCursor);
      return {
        kind: command.kind,
        result: {
          ...page,
          provider: thread.provider,
          nextCursor: encodeHistoryCursor(page.nextCursor, filters),
        },
      };
    }
    if (command.kind === 'mcp-tools') {
      const inventory = await provider.readMcpTools(thread.nativeId!, command.serverName);
      if (inventory.state === 'unavailable' || inventory.state === 'unsupported')
        return {
          kind: command.kind,
          result: { ...inventory, provider: thread.provider, nextCursor: null },
        };
      const page = pageInventory(inventory.data, command);
      if (!page) return unavailable(command, thread);
      return { kind: command.kind, result: { ...inventory, ...page, provider: thread.provider } };
    }
    const inventory = await provider.readMcpResources(thread.nativeId!, command.serverName);
    if (inventory.state === 'unavailable' || inventory.state === 'unsupported')
      return {
        kind: command.kind,
        result: { ...inventory, provider: thread.provider, nextCursor: null },
      };
    const page = pageInventory(inventory.data, command);
    if (!page) return unavailable(command, thread);
    return { kind: command.kind, result: { ...inventory, ...page, provider: thread.provider } };
  };
  return {
    /** Stops new reads joining an observation started before a native change. */
    invalidate(): void {
      pending.clear();
    },
    /**
     * Reads native metadata for the exact currently controlled session.
     * @returns One bounded page, preserving unsupported/unavailable catalogs explicitly.
     * @throws
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
     * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
     * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
     */
    async read(command: IMcpRequest): Promise<IMcpResponse> {
      const thread = await store.getThread(command.threadId);
      if (!thread)
        throw new Exception('The HQ action conflicts with its recorded state', {
          code: 'JG_AGENT_HQ_ACTION_CONFLICT',
          data: { kind: 'state-conflict' },
        });
      await resolveWorkspaceTarget(thread.workspaceRoot, roots);
      const { cursor, ...filters } = command;
      const decoded = decodeHistoryCursor(cursor, filters);
      if (decoded && command.kind !== 'mcp-servers') {
        try {
          PositionSchema.parse(JSON.parse(decoded));
        } catch (cause) {
          throw new Exception('The HQ cursor does not match this request', {
            code: 'JG_AGENT_HQ_CURSOR_INVALID',
            data: { kind: 'invalid-request' },
            cause,
          });
        }
      }
      if (
        !thread.nativeId ||
        !thread.runtimeEpoch ||
        thread.ownership !== 'managed' ||
        thread.state === 'inactive'
      )
        return unavailable(command, thread);
      const key = JSON.stringify(command);
      let operation = pending.get(key);
      if (!operation) {
        if (pending.size >= 32) return unavailable(command, thread);
        operation = (async () => {
          try {
            return await scan(command, thread, await registry.get(thread.provider));
          } catch (error) {
            if (getErrorKind(error) === 'invalid-request') throw error;
            return unavailable(command, thread);
          }
        })();
        pending.set(key, operation);
      }
      try {
        return await operation;
      } finally {
        if (pending.get(key) === operation) pending.delete(key);
      }
    },
  };
};
