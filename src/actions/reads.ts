import { Exception } from 'jg-exception';
import { z } from 'zod';

import type { IHqRequest, IHqResponse, IManagedThread } from '../contracts/index.js';
import { resolveWorkspaceTarget } from '../runtime/state/index.js';
import { decodeHistoryCursor, encodeHistoryCursor } from '../sessions/index.js';
import type { IStore } from '../store/index.js';

import type { createActions } from './actions.js';

type IControlRead = Extract<
  IHqRequest,
  {
    kind:
      | 'thread-plan'
      | 'receipt'
      | 'managed-threads'
      | 'managed-thread'
      | 'managed-thread-name'
      | 'actions'
      | 'provider-actions'
      | 'login'
      | 'events'
      | 'approvals'
      | 'live-items';
  }
>;
const PositionSchema = z.strictObject({ createdAt: z.number().int(), id: z.uuid() });

/**
 * Validates the application-owned seek position after the shared query-binding check.
 * @throws
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 */
const readPosition = (
  cursor: string | undefined,
  filters: object,
): z.infer<typeof PositionSchema> | null => {
  const decoded = decodeHistoryCursor(cursor, filters);
  if (!decoded) return null;
  try {
    return PositionSchema.parse(JSON.parse(decoded));
  } catch (cause) {
    throw new Exception('The HQ cursor does not match this request', {
      code: 'JG_AGENT_HQ_CURSOR_INVALID',
      data: { kind: 'invalid-request' },
      cause,
    });
  }
};

/** Encodes the final row's complete ordering tuple only when another page exists. */
const nextPageCursor = (
  page: { data: { createdAt: number; id: string }[]; hasMore: boolean },
  filters: object,
): string | null => {
  const last = page.data.at(-1);
  return encodeHistoryCursor(
    page.hasMore && last ? JSON.stringify({ createdAt: last.createdAt, id: last.id }) : null,
    filters,
  );
};

/**
 * Authorizes bounded control reads and binds seek positions to their exact query.
 * @returns The selected record or bounded page.
 * @throws
 * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
 * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
 * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
 * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
 * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
 * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
 * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
 */
export const readControl = async (
  command: IControlRead,
  store: IStore,
  actions: ReturnType<typeof createActions>,
  roots: string[],
): Promise<IHqResponse> => {
  const authorize = async (thread: IManagedThread | null): Promise<void> => {
    if (thread) await resolveWorkspaceTarget(thread.workspaceRoot, roots);
  };
  if (command.kind === 'login')
    return { kind: 'login', result: await actions.readLogin(command.actionId) };
  if (command.kind === 'provider-actions') {
    const { cursor, ...filters } = command;
    const page = await store.listProviderActions(command.provider, {
      limit: command.limit,
      position: readPosition(cursor, filters),
    });
    return {
      kind: command.kind,
      result: { data: page.data, nextCursor: nextPageCursor(page, filters) },
    };
  }
  if (command.kind === 'receipt') {
    const receipt = await store.getAction(command.actionId);
    if (receipt?.threadId) await authorize(await store.getThread(receipt.threadId));
    return { kind: 'receipt', result: receipt };
  }
  if (command.kind === 'managed-threads') {
    const { cursor, ...filters } = command;
    filters.workspaceRoot = await resolveWorkspaceTarget(command.workspaceRoot, roots);
    const page = await store.listThreads(filters.workspaceRoot, {
      limit: command.limit,
      position: readPosition(cursor, filters),
    });
    return {
      kind: 'managed-threads',
      result: { data: page.data, nextCursor: nextPageCursor(page, filters) },
    };
  }
  if (command.kind === 'managed-thread-name') {
    const thread = await store.getThreadByName(command.name);
    await authorize(thread);
    return { kind: command.kind, result: thread };
  }
  if (command.kind === 'actions') {
    const { cursor, ...filters } = command;
    await authorize(await store.getThread(command.threadId));
    const page = await store.listActions(command.threadId, {
      limit: command.limit,
      position: readPosition(cursor, filters),
    });
    return {
      kind: 'actions',
      result: { data: page.data, nextCursor: nextPageCursor(page, filters) },
    };
  }
  const thread = await store.getThread(command.threadId);
  await authorize(thread);
  if (command.kind === 'thread-plan')
    return { kind: 'thread-plan', result: thread ? await store.getThreadPlan(thread.id) : null };
  if (command.kind === 'managed-thread') return { kind: command.kind, result: thread };
  if (!thread)
    throw new Exception('The HQ action conflicts with its recorded state', {
      code: 'JG_AGENT_HQ_ACTION_CONFLICT',
      data: {
        kind: 'state-conflict',
      },
    });
  if (command.kind === 'events')
    return {
      kind: 'events',
      result: await store.listEvents({
        threadId: thread.id,
        after: command.after,
        limit: command.limit,
      }),
    };
  if (command.kind === 'approvals') {
    const { cursor, ...filters } = command;
    const page = await store.listApprovals(thread.id, {
      limit: command.limit,
      position: readPosition(cursor, filters),
      ...(command.state ? { state: command.state } : {}),
    });
    return {
      kind: 'approvals',
      result: {
        data: page.data.map(actions.approvalPresentation),
        nextCursor: nextPageCursor(page, filters),
      },
    };
  }
  return {
    kind: 'live-items',
    result: thread.nativeId
      ? actions.live.read(JSON.stringify([thread.provider, thread.nativeId]), command.afterRevision)
      : { data: [], hasGap: false, revision: 0, unchanged: command.afterRevision === 0 },
  };
};
