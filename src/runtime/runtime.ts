import { join } from 'node:path';
import { hashValue } from 'jg-crypto';
import { Exception, extractMessage, isException } from 'jg-exception';
import { z } from 'zod';

import { HqRequestSchema, type IHqRequestInput, type IHqResponse } from '../contracts/index.js';
import { createActions, readControl } from '../actions/index.js';
import { createAccounts } from '../accounts/index.js';
import { createExtensions } from '../extensions/index.js';
import { CONTROL_SOCKET, createIpcServer } from '../ipc/index.js';
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
} from '../sessions/index.js';
import { suggestThreadName } from '../sessions/names/index.js';
import { createSkills } from '../skills/index.js';
import { createStore } from '../store/index.js';
import { createStorage } from '../storage/index.js';
import { registerSnapshotContext } from '../snapshots/index.js';

import {
  claimRuntimeOwner,
  prepareDatabase,
  prepareActionKey,
  prepareStateRoot,
  resolveAllowedRoots,
  resolveWorkspaceTarget,
} from './state/index.js';
import { createBrowserActions } from './browser/index.js';
import { AgentHqOptionsSchema, type IAgentHq, type IAgentHqOptions } from './types.js';

const UnconfirmedCleanupSchema = z.object({ cleanupUnconfirmed: z.literal(true) });

/**
 * Starts one local controller with private IPC, a SQLite worker and lazy native providers.
 * @returns The owned runtime. Client disconnects do not close it.
 * @throws
 * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
 * - JG_AGENT_HQ_LOCK_UNSUPPORTED_PLATFORM: The HQ lock requires Linux or macOS
 * - JG_AGENT_HQ_RUNTIME_DIRECTORY_INVALID: The HQ runtime directory must be a real directory
 * - JG_AGENT_HQ_RUNTIME_DIRECTORY_PERMISSIONS: The HQ runtime directory must be private and owned by the current user
 * - JG_AGENT_HQ_STATE_DIRECTORY_UNSAFE: The HQ state directory is unsafe
 * - JG_AGENT_HQ_STATE_FILE_UNSAFE: The HQ state file is unsafe
 * - JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE: The HQ action key is unavailable
 * - JG_AGENT_HQ_RUNTIME_OWNER_UNVERIFIABLE: The HQ runtime owner is unverifiable
 * - JG_AGENT_HQ_RUNTIME_ALREADY_OWNED: The HQ runtime is already owned
 * - JG_AGENT_HQ_RUNTIME_NOT_RUNNING: The HQ runtime is not running
 * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
 * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
 * - JG_AGENT_HQ_STORAGE_INVALID: The HQ storage is invalid
 */
export const createAgentHq = async (options: IAgentHqOptions): Promise<IAgentHq> => {
  const parsed = AgentHqOptionsSchema.safeParse(options);
  if (!parsed.success)
    throw new Exception('The HQ request is invalid', {
      code: 'JG_AGENT_HQ_REQUEST_INVALID',
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
  const ownership = await claimRuntimeOwner(stateRoot);
  let store: Awaited<ReturnType<typeof createStore>> | undefined;
  let registry: ReturnType<typeof createProviderRegistry> | undefined;
  let ipc: Awaited<ReturnType<typeof createIpcServer>> | undefined;
  let actionKey: Uint8Array;
  try {
    const databasePath = await prepareDatabase(stateRoot);
    actionKey = await prepareActionKey(stateRoot, databasePath);
    store = await createStore(databasePath, ownership.owner.nonce, actionKey);
    registry = createProviderRegistry(
      [
        { factory: createCodexProviderFactory(codexExtraSkillRoots), isBuiltIn: true },
        {
          factory: createClaudeProviderFactory(store, claudeAdditionalDirectories),
          isBuiltIn: true,
        },
        ...(parsed.data.providerFactories ?? []).map((factory) => ({ factory, isBuiltIn: false })),
      ],
      allowedRoots,
      ownership.owner.nonce,
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
    if (!(isException(error) && UnconfirmedCleanupSchema.safeParse(error.data).success))
      await ownership.release();
    throw error;
  }
  const browser = createBrowserActions(store);
  const providers = registry;
  const projection = store;
  const storage = createStorage(projection);
  const skills = createSkills(providers, projection, allowedRoots);
  // terminal and background Claude sessions are observed while the runtime runs
  const claudeAgents = observeClaudeAgents(
    (sessions) => storage.background(() => projection.observeSessions('claude', sessions, true)),
    allowedRoots,
  );
  const accounts = createAccounts(providers);
  const extensions = createExtensions(providers, projection, allowedRoots);
  const actions = createActions(
    providers,
    projection,
    allowedRoots,
    ownership.owner.nonce,
    actionKey,
    skills,
    storage.background,
    () => {
      skills.invalidate();
      extensions.invalidate();
      accounts.invalidate();
    },
    (nativeId) => claudeAgents.terminalOf(nativeId),
  );
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
      throw new Exception('The HQ request is invalid', {
        code: 'JG_AGENT_HQ_REQUEST_INVALID',
        data: { kind: 'invalid-request' },
        cause: result.error,
      });
    if (closing)
      throw new Exception('The HQ runtime is not running', {
        code: 'JG_AGENT_HQ_RUNTIME_NOT_RUNNING',
        data: { kind: 'state-conflict' },
      });
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
            providers: providers.statuses(),
          },
        };
      case 'stop': {
        setImmediate(() => {
          void storage.background(close).catch(() => undefined);
        });
        return { kind: 'stop', result: { accepted: true, runtimeEpoch: ownership.owner.nonce } };
      }
      case 'capabilities': {
        const thread = command.threadId ? await projection.getThread(command.threadId) : undefined;
        if (command.threadId && (!thread || thread.provider !== command.provider))
          throw new Exception('The HQ request is invalid', {
            code: 'JG_AGENT_HQ_REQUEST_INVALID',
            data: { kind: 'invalid-request' },
          });
        if (thread) await resolveWorkspaceTarget(thread.workspaceRoot, allowedRoots);
        return {
          kind: 'capabilities',
          result: await providers.capabilities(command.provider, thread ?? undefined),
        };
      }
      case 'account':
        return { kind: command.kind, result: await accounts.read(command) };
      case 'mcp-servers':
      case 'mcp-tools':
      case 'mcp-resources':
        return extensions.read(command);
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
        const thread = command.threadId ? await projection.getThread(command.threadId) : null;
        if (
          command.threadId &&
          (!thread ||
            thread.provider !== command.provider ||
            thread.workspaceRoot !== workspaceRoot ||
            !thread.nativeId)
        )
          throw new Exception('The HQ request is invalid', {
            code: 'JG_AGENT_HQ_REQUEST_INVALID',
            data: { kind: 'invalid-request' },
          });
        return {
          kind: 'configuration',
          result: await (
            await providers.get(command.provider)
          ).readConfiguration({ ...command, workspaceRoot }, thread?.nativeId ?? undefined),
        };
      }
      case 'skills':
        return { kind: command.kind, result: await skills.list(command) };
      case 'skill-preview':
        return {
          kind: command.kind,
          result: await skills.preview(command.threadId, command.skillId, command.arguments),
        };
      case 'action':
        return { kind: 'action', result: await actions.submit(command.action) };
      case 'suggest-thread-name':
        return {
          kind: command.kind,
          result: { name: await projection.suggestThreadName(suggestThreadName(command.topic)) },
        };
      case 'managed-thread-name':
      case 'receipt':
      case 'managed-threads':
      case 'managed-thread':
      case 'actions':
      case 'provider-actions':
      case 'login':
      case 'events':
      case 'approvals':
      case 'live-items':
        return readControl(command, projection, actions, allowedRoots);
      case 'session-states':
        return {
          kind: 'session-states',
          result: await projection.listSessionTransitions(command.afterSequence, command.limit),
        };
      case 'active-sessions':
        return {
          kind: 'active-sessions',
          result: await readActiveSessions(providers, projection, allowedRoots, claudeAgents),
        };
      case 'unstarted-threads':
        return {
          kind: 'unstarted-threads',
          result: await readUnstartedThreads(command, projection, allowedRoots, claudeAgents),
        };
      case 'observation-pace':
        claudeAgents.setPace(command.pace);
        return { kind: 'observation-pace', result: { pace: command.pace } };
      default: {
        const response = await readNativeHistory(
          command,
          providers,
          projection,
          allowedRoots,
          claudeAgents,
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
    ipc = await createIpcServer(join(stateRoot, CONTROL_SOCKET), ownership.owner.nonce, request);
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
        throw new Exception('The HQ runtime is not running', {
          code: 'JG_AGENT_HQ_RUNTIME_NOT_RUNNING',
          data: { kind: 'state-conflict' },
        });
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
