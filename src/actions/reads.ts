import { z } from 'zod';

import type { IHqRequest, IHqResponse, IManagedThread } from '../contracts/index.js';
import { resolveWorkspaceTarget } from '../runtime/state/index.js';
import { createRequestCursors } from '../sessions/index.js';
import type { IStore } from '../store/index.js';
import { HQ_ERRORS } from '../errors/index.js';

import type { createActions } from './actions.js';

type IControlRead = Extract<
  IHqRequest,
  {
    kind:
      | 'receipt'
      | 'action-wait'
      | 'managed-threads'
      | 'managed-thread'
      | 'actions'
      | 'approvals'
      | 'live-items';
  }
>;
// a control page continues after its final row's complete ordering tuple
const positions = createRequestCursors(
  z.strictObject({ createdAt: z.number().int(), id: z.uuid() }),
);

/** Encodes the final row's complete ordering tuple only when another page exists. */
const nextPageCursor = (
  page: { data: { createdAt: number; id: string }[]; hasMore: boolean },
  filters: object,
): string | null => {
  const last = page.data.at(-1);
  return positions.encode(
    page.hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
    filters,
  );
};

/**
 * Authorizes bounded control reads and binds seek positions to their exact query.
 * @returns The selected record or bounded page, or a receipt once its wait ends.
 * @throws
 * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
 * - JG_AGENT_HQ_RUNTIME_NOT_RUNNING: The HQ runtime is not running
 * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
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
  if (command.kind === 'receipt' || command.kind === 'action-wait') {
    const receipt = await store.getAction(command.actionId);
    if (receipt?.threadId) await authorize(await store.getThread(receipt.threadId));
    if (command.kind === 'receipt') return { kind: 'receipt', result: receipt };
    // an unknown action has nothing to wait for
    if (!receipt) return { kind: 'action-wait', result: { receipt: null, isTimedOut: false } };
    return {
      kind: 'action-wait',
      result: await actions.waits.wait(command.actionId, command.until, command.timeoutMs),
    };
  }
  if (command.kind === 'managed-threads') {
    const { cursor, ...filters } = command;
    filters.workspaceRoot = await resolveWorkspaceTarget(command.workspaceRoot, roots);
    const page = await store.listThreads(filters.workspaceRoot, {
      limit: command.limit,
      position: positions.decode(cursor, filters) ?? null,
    });
    return {
      kind: 'managed-threads',
      result: { data: page.data, nextCursor: nextPageCursor(page, filters) },
    };
  }
  if (command.kind === 'actions') {
    const { cursor, ...filters } = command;
    await authorize(await store.getThread(command.threadId));
    const page = await store.listActions(command.threadId, {
      limit: command.limit,
      position: positions.decode(cursor, filters) ?? null,
    });
    return {
      kind: 'actions',
      result: { data: page.data, nextCursor: nextPageCursor(page, filters) },
    };
  }
  const thread = await store.getThread(command.threadId);
  await authorize(thread);
  if (command.kind === 'managed-thread') return { kind: command.kind, result: thread };
  if (!thread)
    throw HQ_ERRORS.create('actionConflict', {
      data: { kind: 'state-conflict' },
    });
  if (command.kind === 'approvals') {
    const { cursor, ...filters } = command;
    const page = await store.listApprovals(thread.id, {
      limit: command.limit,
      position: positions.decode(cursor, filters) ?? null,
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
      : {
          data: [],
          hasGap: false,
          revision: 0,
          unchanged: command.afterRevision === 0,
          backgroundCommands: 0,
        },
  };
};
