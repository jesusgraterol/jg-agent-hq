import { Exception } from 'jg-exception';

import { HqResponseSchema, type IHqResponse } from '../contracts/index.js';
import type { createProviderRegistry } from '../providers/registry/index.js';
import { resolveWorkspaceTarget } from '../runtime/state/index.js';
import type { IStore } from '../store/index.js';

import type { IHistoryRequest } from './types.js';

/**
 * Authorizes native history before loading content and records only its discovery projection.
 * @returns One provider-paged read result, never a complete transcript scan.
 * @throws
 * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
 * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
 * - JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE: The Claude history is unavailable
 * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
 * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
 * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
 * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
 */
export const readNativeHistory = async (
  command: IHistoryRequest,
  registry: ReturnType<typeof createProviderRegistry>,
  projection: IStore,
  allowedRoots: string[],
): Promise<IHqResponse> => {
  const workspaceRoot = await resolveWorkspaceTarget(command.workspaceRoot, allowedRoots);
  const adapter = await registry.get(command.provider);
  const response = await adapter.readHistory({ ...command, workspaceRoot });
  const threads =
    response.kind === 'threads'
      ? response.result.data
      : response.kind === 'thread'
        ? [response.result]
        : [];
  const resolvedRoots = new Map<string, string>();
  for (const thread of threads) {
    let actualRoot = resolvedRoots.get(thread.workspaceRoot);
    if (!actualRoot) {
      actualRoot = await resolveWorkspaceTarget(thread.workspaceRoot, allowedRoots);
      resolvedRoots.set(thread.workspaceRoot, actualRoot);
    }
    if (actualRoot !== workspaceRoot)
      throw new Exception('The HQ target is outside the allowed workspaces', {
        code: 'JG_AGENT_HQ_TARGET_FORBIDDEN',
        data: { kind: 'access-denied' },
      });
    thread.workspaceRoot = actualRoot;
  }
  if (threads.length) {
    const managed = new Map(
      (
        await projection.getNativeThreads(
          command.provider,
          threads.map((thread) => thread.nativeId),
        )
      ).map((thread) => [thread.nativeId, thread]),
    );
    for (const thread of threads) {
      const control = managed.get(thread.nativeId);
      if (control) {
        thread.ownership = control.ownership;
        thread.managedId = control.id;
        thread.name = control.name;
      }
    }
    await projection.remember(
      threads,
      response.kind === 'threads' ? response.result.nextCursor : null,
    );
  }
  return HqResponseSchema.parse(response);
};
