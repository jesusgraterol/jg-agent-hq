import { Exception } from 'error-message-utils';

import { HqResponseSchema, type IHqResponse } from '../contracts/index.js';
import type { ICodexProvider } from '../providers/index.js';
import { resolveWorkspaceTarget } from '../runtime/state/index.js';
import type { IStore } from '../store/index.js';

import type { IHistoryRequest } from './types.js';
import { decodeHistoryCursor, encodeHistoryCursor } from './utilities.js';

/**
 * Authorizes native history before loading content and records only its discovery projection.
 * @returns One provider-paged read result, never a complete transcript scan.
 * @throws
 * - -1: The HQ target is outside the allowed workspaces
 * - -1: The HQ cursor does not match this request
 * - -1: The Codex integration failed
 * - -1: The HQ store failed
 */
export const readNativeHistory = async (
  command: IHistoryRequest,
  native: ICodexProvider,
  projection: IStore,
  allowedRoots: string[],
): Promise<IHqResponse> => {
  const workspaceRoot = await resolveWorkspaceTarget(command.workspaceRoot, allowedRoots);
  if (command.kind === 'threads') {
    const { cursor, ...filters } = { ...command, workspaceRoot };
    const page = await native.listThreads(
      workspaceRoot,
      command.limit,
      decodeHistoryCursor(cursor, filters),
      command.search,
    );
    const resolvedRoots = new Map([[workspaceRoot, workspaceRoot]]);
    for (const thread of page.data) {
      let actualRoot = resolvedRoots.get(thread.workspaceRoot);
      if (!actualRoot) {
        actualRoot = await resolveWorkspaceTarget(thread.workspaceRoot, allowedRoots);
        resolvedRoots.set(thread.workspaceRoot, actualRoot);
      }
      if (actualRoot !== workspaceRoot)
        throw new Exception('The HQ target is outside the allowed workspaces', undefined, {
          kind: 'access-denied',
        });
      thread.workspaceRoot = actualRoot;
    }
    const nextCursor = encodeHistoryCursor(page.nextCursor, filters);
    const managed = new Map(
      (await projection.getNativeThreads(page.data.map((thread) => thread.nativeId))).map(
        (thread) => [thread.nativeId, thread],
      ),
    );
    for (const thread of page.data) {
      const control = managed.get(thread.nativeId);
      if (control) {
        thread.ownership = control.ownership;
        thread.managedId = control.id;
        thread.name = control.name;
      }
    }
    const result = HqResponseSchema.parse({
      kind: 'threads',
      result: { data: page.data, nextCursor, source: 'native' },
    });
    await projection.remember(page.data, nextCursor);
    return result;
  }
  const thread = await native.readThread(command.nativeId);
  if ((await resolveWorkspaceTarget(thread.workspaceRoot, allowedRoots)) !== workspaceRoot)
    throw new Exception('The HQ target is outside the allowed workspaces', undefined, {
      kind: 'access-denied',
    });
  thread.workspaceRoot = workspaceRoot;
  const control = await projection.getThreadByNativeId(command.nativeId);
  if (control) {
    thread.ownership = control.ownership;
    thread.managedId = control.id;
    thread.name = control.name;
  }
  await projection.remember([thread], null);
  if (command.kind === 'thread') return { kind: 'thread', result: thread };
  const { cursor, ...filters } = { ...command, workspaceRoot };
  const nativeCursor = decodeHistoryCursor(cursor, filters);
  if (command.kind === 'turns') {
    const page = await native.listTurns(command.nativeId, command.limit, nativeCursor);
    return HqResponseSchema.parse({
      kind: 'turns',
      result: {
        data: page.data,
        nextCursor: encodeHistoryCursor(page.nextCursor, filters),
        source: 'native',
      },
    });
  }
  const page = await native.listItems(
    command.nativeId,
    command.limit,
    nativeCursor,
    command.turnId,
  );
  return HqResponseSchema.parse({
    kind: 'items',
    result: {
      data: page.data,
      nextCursor: encodeHistoryCursor(page.nextCursor, filters),
      source: 'native',
      history: 'persisted',
    },
  });
};
