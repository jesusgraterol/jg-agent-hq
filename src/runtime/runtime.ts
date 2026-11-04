import { join } from 'node:path';
import { hashValue } from 'jg-crypto';
import { Exception, extractMessage } from 'jg-exception';
import { listLocks } from 'jg-locks';
import { z } from 'zod';

import { HqRequestSchema, type IHqRequestInput, type IHqResponse } from '../contracts/index.js';
import { createActions, readControl } from '../actions/index.js';
import { CONTROL_SOCKET, createIpcServer, removeLeftoverSocket } from '../ipc/index.js';
import {
  createCodexProviderFactory,
  createClaudeProviderFactory,
  observeClaudeAgents,
} from '../providers/index.js';
import { createProviderRegistry } from '../providers/registry/index.js';
import {
  limitItemText,
  readActiveSessions,
  readNativeHistory,
  readUnstartedThreads,
  type IClaudeSessions,
} from '../sessions/index.js';
import { suggestThreadName } from '../sessions/names/index.js';
import { createSkills } from '../skills/index.js';
import { createStore } from '../store/index.js';
import { createStorage } from '../storage/index.js';
import { registerSnapshotContext } from '../snapshots/index.js';
import { HQ_ERRORS, isCleanupUnconfirmed } from '../errors/index.js';

import {
  claimRuntimeOwner,
  prepareDatabase,
  prepareActionKey,
  prepareStateRoot,
  recoverSnapshotLock,
  resolveAllowedRoots,
  resolveWorkspaceTarget,
} from './state/index.js';
import { createBrowserActions } from './browser/index.js';
import { AgentHqOptionsSchema, type IAgentHq, type IAgentHqOptions } from './types.js';

/**
 * Starts one local controller with private IPC, a SQLite worker and lazy native providers.
 * @returns The owned runtime. Client disconnects do not close it.
 * @throws
 * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
 * - JG_AGENT_HQ_STATE_DIRECTORY_UNSAFE: The HQ state directory is unsafe
 * - JG_AGENT_HQ_STATE_FILE_UNSAFE: The HQ state file is unsafe
 * - JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE: The HQ action key is unavailable
 * - JG_AGENT_HQ_RUNTIME_OWNER_UNVERIFIABLE: The HQ runtime owner is unverifiable
 * - JG_AGENT_HQ_RUNTIME_ALREADY_OWNED: The HQ runtime is already owned
 * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
 * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
 * - JG_AGENT_HQ_STORAGE_INVALID: The HQ storage is invalid
 * - LOCK_BUSY: The lock '<path>' is busy.
 * - LOCK_ACQUISITION_FAILED: The lock '<path>' could not be acquired.
 * - LOCK_NOT_OWNED: The lock '<path>' is no longer owned by this process.
 * - LOCK_RELEASE_FAILED: The lock '<path>' could not be released.
 * - NOT_A_DIRECTORY: The path '<path>' is not a directory.
 * - DIRECTORY_NOT_PRIVATE: The directory '<path>' can be accessed by other users.
 * - PATH_NOT_CANONICAL: The path '<path>' goes through a symbolic link.
 */
export const createAgentHq = async (options: IAgentHqOptions): Promise<IAgentHq> => {
  const parsed = AgentHqOptionsSchema.safeParse(options);
  if (!parsed.success)
    throw HQ_ERRORS.create('requestInvalid', {
      data: { kind: 'invalid-request' },
      cause: parsed.error,
    });
  const allowedRoots = await resolveAllowedRoots(parsed.data.allowedRoots);
  const codexExtraSkillRoots = parsed.data.codexExtraSkillRoots?.length
    ? await resolveAllowedRoots(parsed.data.codexExtraSkillRoots)
    : [];
  const claudeAdditionalDirectories = parsed.data.claudeAdditionalDirectories?.length
    ? await resolveAllowedRoots(parsed.data.claudeAdditionalDirectories)
    : [];
  const stateRoot = await prepareStateRoot(parsed.data.stateRoot);
  const startedAt = Date.now();
  const ownership = await claimRuntimeOwner(stateRoot, parsed.data.isPreviousRuntimeStopped);
  let store: Awaited<ReturnType<typeof createStore>> | undefined;
  let registry: ReturnType<typeof createProviderRegistry> | undefined;
  let ipc: Awaited<ReturnType<typeof createIpcServer>> | undefined;
  let actionKey: Uint8Array;
  try {
    // a runtime that stopped without releasing the state root left its snapshot lock and socket
    if (ownership.previous) {
      await recoverSnapshotLock(stateRoot, ownership.previous.pid);
      await removeLeftoverSocket(join(stateRoot, CONTROL_SOCKET));
    }
    const databasePath = await prepareDatabase(stateRoot);
    actionKey = await prepareActionKey(stateRoot, databasePath);
    store = await createStore(databasePath, ownership.epoch, actionKey);
    registry = createProviderRegistry(
      [
        createCodexProviderFactory(codexExtraSkillRoots, parsed.data.codexDaemonLauncher ?? []),
        createClaudeProviderFactory(store, claudeAdditionalDirectories),
      ],
      allowedRoots,
      ownership.epoch,
    );
  } catch (error) {
    const cleanup = await Promise.allSettled([registry?.close(), store?.close()]);
    const failed = cleanup.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected')
      throw new Exception(`The HQ transport failed: ${extractMessage(failed.reason)}`, {
        code: 'JG_AGENT_HQ_TRANSPORT_FAILED',
        data: { kind: 'operation-failed' },
        cause: error,
      });
    if (!isCleanupUnconfirmed(error)) await ownership.release();
    throw error;
  }
  const browser = createBrowserActions(store);
  const providers = registry;
  const projection = store;
  const storage = createStorage(projection);
  const skills = createSkills(providers, projection, allowedRoots);
  // terminal and background Claude sessions are observed while the runtime runs
  const claudeAgents = observeClaudeAgents(
    (sessions) =>
      storage.background(() => projection.call('sessions', 'observe', 'claude', sessions, true)),
    allowedRoots,
    (nativeId) => projection.call('sessions', 'claudeTranscriptRoot', nativeId),
  );
  const actions = createActions(
    providers,
    projection,
    allowedRoots,
    ownership.epoch,
    actionKey,
    skills,
    storage.background,
    (nativeId) => claudeAgents.terminalOf(nativeId),
  );
  /*
   * What session reads join to each summary: the poll's listing and, for a session HQ runs, the
   * background commands its live window holds, the larger count winning for a session in both.
   */
  const liveKey = (provider: string, nativeId: string) => JSON.stringify([provider, nativeId]);
  const claudeSessions: IClaudeSessions = {
    workspaceOf: (nativeId) => claudeAgents.workspaceOf(nativeId),
    terminalOf: (nativeId) => claudeAgents.terminalOf(nativeId),
    backgroundCommandsOf: (nativeId) =>
      Math.max(
        actions.live.backgroundCommandsOf(liveKey('claude', nativeId)),
        claudeAgents.backgroundCommandsOf(nativeId),
      ),
    refreshBackgroundCommands: async (nativeId) =>
      Math.max(
        actions.live.backgroundCommandsOf(liveKey('claude', nativeId)),
        await claudeAgents.refreshBackgroundCommands(nativeId),
      ),
    backgroundSessions: () => [
      ...actions.live.backgroundKeys().flatMap((key) => {
        const parsed = z.tuple([z.string(), z.string()]).safeParse(JSON.parse(key));
        return parsed.success ? [{ provider: parsed.data[0], nativeId: parsed.data[1] }] : [];
      }),
      ...claudeAgents.backgroundSessionIds().map((nativeId) => ({ provider: 'claude', nativeId })),
    ],
  };
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
        // receipt waits end first, so none holds up closing for its remaining time
        actions.waits.close();
        await browser.close();
        await claudeAgents.close();
        const results = await Promise.allSettled([ipc?.close(), actions.close()]);
        const storeCleanup = await Promise.allSettled([projection.close()]);
        results.push(...storeCleanup);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected')
          throw new Exception(`The HQ transport failed: ${extractMessage(failure.reason)}`, {
            code: 'JG_AGENT_HQ_TRANSPORT_FAILED',
            data: { kind: 'operation-failed' },
            cause: failure.reason,
          });
        await ownership.release();
        storage.dispose();
        resolveClosed();
      } catch (error) {
        rejectClosed(error);
        throw error;
      }
    })());

  const handleRequest = async (input: IHqRequestInput): Promise<IHqResponse> => {
    const result = HqRequestSchema.safeParse(input);
    if (!result.success)
      throw HQ_ERRORS.create('requestInvalid', {
        data: { kind: 'invalid-request' },
        cause: result.error,
      });
    if (closing) throw HQ_ERRORS.create('runtimeNotRunning', { data: { kind: 'state-conflict' } });
    const command = result.data;
    switch (command.kind) {
      case 'status':
        return {
          kind: 'status',
          result: {
            runtimeEpoch: ownership.epoch,
            pid: process.pid,
            startedAt,
            store: projection.isAvailable ? 'ready' : 'unavailable',
            providers: providers.statuses(),
          },
        };
      case 'stop': {
        setImmediate(() => {
          void storage.background(close).catch(() => undefined);
        });
        return { kind: 'stop', result: { accepted: true, runtimeEpoch: ownership.epoch } };
      }
      case 'capabilities': {
        const thread = command.threadId
          ? await projection.call('reads', 'getThread', command.threadId)
          : undefined;
        if (command.threadId && (!thread || thread.provider !== command.provider))
          throw HQ_ERRORS.create('requestInvalid', { data: { kind: 'invalid-request' } });
        if (thread) await resolveWorkspaceTarget(thread.workspaceRoot, allowedRoots);
        return {
          kind: 'capabilities',
          result: await providers.capabilities(command.provider, thread ?? undefined),
        };
      }
      case 'usage':
        return {
          kind: 'usage',
          result: await providers.readUsage(command.provider),
        };
      case 'models':
        return {
          kind: 'models',
          result: await (await providers.get(command.provider)).readModels(command),
        };
      case 'configuration': {
        const workspaceRoot = await resolveWorkspaceTarget(command.workspaceRoot, allowedRoots);
        const thread = command.threadId
          ? await projection.call('reads', 'getThread', command.threadId)
          : null;
        if (
          command.threadId &&
          (!thread ||
            thread.provider !== command.provider ||
            thread.workspaceRoot !== workspaceRoot ||
            !thread.nativeId)
        )
          throw HQ_ERRORS.create('requestInvalid', { data: { kind: 'invalid-request' } });
        return {
          kind: 'configuration',
          result: await (
            await providers.get(command.provider)
          ).readConfiguration({ ...command, workspaceRoot }, thread?.nativeId ?? undefined),
        };
      }
      case 'skills': {
        const workspaceRoot = await resolveWorkspaceTarget(command.workspaceRoot, allowedRoots);
        // a session's catalog answers only for the provider and folder the session runs in
        const thread = command.threadId
          ? await projection.call('reads', 'getThread', command.threadId)
          : null;
        if (
          command.threadId &&
          (!thread ||
            thread.provider !== command.provider ||
            thread.workspaceRoot !== workspaceRoot)
        )
          throw HQ_ERRORS.create('requestInvalid', { data: { kind: 'invalid-request' } });
        return { kind: command.kind, result: await skills.list({ ...command, workspaceRoot }) };
      }
      case 'action':
        return { kind: 'action', result: await actions.submit(command.action) };
      case 'suggest-thread-name':
        return {
          kind: command.kind,
          result: {
            name: await projection.call('reads', 'suggestName', suggestThreadName(command.topic)),
          },
        };
      case 'receipt':
      case 'action-wait':
      case 'managed-threads':
      case 'managed-thread':
      case 'actions':
      case 'approvals':
      case 'live-items':
        return readControl(command, projection, actions, allowedRoots);
      case 'session-states':
        return {
          kind: 'session-states',
          result: await projection.call(
            'sessions',
            'transitions',
            command.afterSequence,
            command.limit,
          ),
        };
      case 'active-sessions':
        return {
          kind: 'active-sessions',
          result: await readActiveSessions(projection, allowedRoots, claudeSessions),
        };
      case 'unstarted-threads':
        return {
          kind: 'unstarted-threads',
          result: await readUnstartedThreads(command, projection, allowedRoots, claudeSessions),
        };
      case 'observation-pace':
        claudeAgents.setPace(command.pace);
        return { kind: 'observation-pace', result: { pace: command.pace } };
      case 'locks': {
        // a read of the machine's locks folder; HQ never takes a lock there
        const { locks, isTruncated } = await listLocks();
        return { kind: 'locks', result: { data: locks, isTruncated } };
      }
      default: {
        const response = await readNativeHistory(
          command,
          providers,
          projection,
          allowedRoots,
          claudeSessions,
        );
        if (command.kind !== 'items' || response.kind !== 'items') return response;
        // live items reconcile against the persisted text before it is cut
        actions.live.reconcile(
          JSON.stringify([command.provider, command.nativeId]),
          response.result.data,
        );
        return {
          ...response,
          result: {
            ...response.result,
            data: limitItemText(response.result.data, command.textLimit),
          },
        };
      }
    }
  };
  const request = (input: IHqRequestInput): Promise<IHqResponse> =>
    storage.run(() => handleRequest(input));
  try {
    ipc = await createIpcServer(join(stateRoot, CONTROL_SOCKET), ownership.epoch, request);
  } catch (error) {
    await close();
    throw error;
  }
  const runtime: IAgentHq = {
    stateRoot,
    closed,
    request,
    get storage() {
      return structuredClone(projection.storage);
    },
    withStorageMaintenance: async (operation) => {
      if (closing)
        throw HQ_ERRORS.create('runtimeNotRunning', { data: { kind: 'state-conflict' } });
      return storage.withStorageMaintenance(operation);
    },
    close: () => storage.run(close),
    performBrowserAction: (input, operatorId, execute) =>
      storage.run(() => browser.perform(input, operatorId, execute)),
    readBrowserAction: (id, operatorId) => storage.run(() => browser.read(id, operatorId)),
  };
  registerSnapshotContext({
    runtime,
    stateRoot,
    actionKeyHash: hashValue(actionKey),
    allowedRoots,
    store: projection,
    admit: storage.run,
    isClosing: () => Boolean(closing),
  });
  return runtime;
};
