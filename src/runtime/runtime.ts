import { join } from 'node:path';
import { Exception, extractMessage } from 'error-message-utils';
import { z } from 'zod';

import { HqRequestSchema, type IHqRequestInput, type IHqResponse } from '../contracts/index.js';
import { createActions, readControl } from '../actions/index.js';
import { CONTROL_SOCKET, createIpcServer } from '../ipc/index.js';
import { createCodexProvider, type ICodexProvider } from '../providers/index.js';
import { readNativeHistory } from '../sessions/index.js';
import { createStore } from '../store/index.js';

import {
  claimRuntimeOwner,
  prepareDatabase,
  prepareActionKey,
  prepareStateRoot,
  resolveAllowedRoots,
} from './state/index.js';
import { AgentHqOptionsSchema, type IAgentHq, type IAgentHqOptions } from './types.js';

const UnconfirmedCleanupSchema = z.object({ cleanupUnconfirmed: z.literal(true) });

/**
 * Starts one local controller with private IPC, a SQLite worker and the installed native CLI.
 * @returns The owned runtime. Client disconnects do not close it.
 * @throws
 * - -1: The HQ request is invalid
 * - -1: The HQ lock requires Linux or macOS
 * - -1: The HQ runtime directory must be a real directory
 * - -1: The HQ runtime directory must be private and owned by the current user
 * - -1: The HQ state directory is unsafe
 * - -1: The HQ state file is unsafe
 * - -1: The HQ action key is unavailable
 * - -1: The HQ runtime owner is unverifiable
 * - -1: The HQ runtime is already owned
 * - -1: The HQ runtime is not running
 * - -1: The Codex integration failed
 * - -1: The HQ transport failed
 * - -1: The HQ store failed
 */
export const createAgentHq = async (options: IAgentHqOptions): Promise<IAgentHq> => {
  const parsed = AgentHqOptionsSchema.safeParse(options);
  if (!parsed.success)
    throw new Exception(
      'The HQ request is invalid',
      undefined,
      { kind: 'invalid-request' },
      { cause: parsed.error },
    );
  const allowedRoots = await resolveAllowedRoots(parsed.data.allowedRoots);
  const stateRoot = await prepareStateRoot(parsed.data.stateRoot);
  const ownership = await claimRuntimeOwner(stateRoot);
  let store: Awaited<ReturnType<typeof createStore>> | undefined;
  let provider: ICodexProvider | undefined;
  let ipc: Awaited<ReturnType<typeof createIpcServer>> | undefined;
  let actionKey: Uint8Array;
  try {
    const databasePath = await prepareDatabase(stateRoot);
    actionKey = await prepareActionKey(stateRoot, databasePath);
    store = await createStore(databasePath, ownership.owner.nonce, actionKey);
    provider = await createCodexProvider();
  } catch (error) {
    const cleanup = await Promise.allSettled([provider?.close(), store?.close()]);
    const failed = cleanup.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected')
      throw new Exception(
        `The HQ transport failed: ${extractMessage(failed.reason)}`,
        undefined,
        { kind: 'operation-failed' },
        { cause: error },
      );
    if (!(error instanceof Exception && UnconfirmedCleanupSchema.safeParse(error.data).success))
      await ownership.release();
    throw error;
  }
  const native = provider;
  const projection = store;
  const actions = createActions(native, projection, allowedRoots, ownership.owner.nonce, actionKey);
  let resolveClosed: () => void = () => undefined;
  let rejectClosed: (error: unknown) => void = () => undefined;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  // close() still reports errors; the lifetime promise may be awaited later by its owner
  void closed.catch(() => undefined);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      try {
        const results = await Promise.allSettled([ipc?.close(), actions.close()]);
        const storeCleanup = await Promise.allSettled([projection.close()]);
        results.push(...storeCleanup);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected')
          throw new Exception(
            `The HQ transport failed: ${extractMessage(failure.reason)}`,
            undefined,
            { kind: 'operation-failed' },
            { cause: failure.reason },
          );
        await ownership.release();
        resolveClosed();
      } catch (error) {
        rejectClosed(error);
        throw error;
      }
    })());

  const request = async (input: IHqRequestInput): Promise<IHqResponse> => {
    const result = HqRequestSchema.safeParse(input);
    if (!result.success)
      throw new Exception(
        'The HQ request is invalid',
        undefined,
        { kind: 'invalid-request' },
        { cause: result.error },
      );
    if (closing)
      throw new Exception('The HQ runtime is not running', undefined, { kind: 'state-conflict' });
    const command = result.data;
    switch (command.kind) {
      case 'status':
        return {
          kind: 'status',
          result: {
            runtimeEpoch: ownership.owner.nonce,
            pid: process.pid,
            startedAt: Date.parse(ownership.owner.createdAt),
            store: projection.isAvailable ? 'ready' : 'unavailable',
            codex: {
              state: native.isAvailable ? 'ready' : 'unavailable',
              userAgent: native.userAgent,
            },
          },
        };
      case 'stop': {
        setImmediate(() => {
          void close().catch(() => undefined);
        });
        return { kind: 'stop', result: { accepted: true, runtimeEpoch: ownership.owner.nonce } };
      }
      case 'usage':
        return { kind: 'usage', result: await native.readUsage() };
      case 'action':
        return { kind: 'action', result: await actions.submit(command.action) };
      case 'receipt':
      case 'managed-threads':
      case 'managed-thread':
      case 'actions':
      case 'events':
      case 'approvals':
      case 'live-items':
        return readControl(command, projection, actions, allowedRoots);
      default: {
        const response = await readNativeHistory(command, native, projection, allowedRoots);
        if (command.kind === 'items' && response.kind === 'items')
          actions.live.reconcile(command.nativeId, response.result.data);
        return response;
      }
    }
  };
  try {
    ipc = await createIpcServer(join(stateRoot, CONTROL_SOCKET), ownership.owner.nonce, request);
  } catch (error) {
    await close();
    throw error;
  }
  return { stateRoot, closed, request, close };
};
