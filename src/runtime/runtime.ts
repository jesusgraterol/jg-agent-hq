import { join } from 'node:path';
import { Exception, extractMessage, isException } from 'jg-exception';
import { z } from 'zod';

import { HqRequestSchema, type IHqRequestInput, type IHqResponse } from '../contracts/index.js';
import { createActions, readControl } from '../actions/index.js';
import { createAccounts } from '../accounts/index.js';
import { createExtensions } from '../extensions/index.js';
import { createHandoffs } from '../handoffs/index.js';
import { createCollaboration } from '../collaboration/index.js';
import { createAgentTools } from '../agent-tools/index.js';
import { CONTROL_SOCKET, createIpcServer } from '../ipc/index.js';
import { createCodexProviderFactory, createClaudeProviderFactory } from '../providers/index.js';
import { createProviderRegistry } from '../providers/registry/index.js';
import { readNativeHistory } from '../sessions/index.js';
import { suggestThreadName } from '../sessions/names/index.js';
import { createSkills } from '../skills/index.js';
import { createStore } from '../store/index.js';
import { createStorage } from '../storage/index.js';
import { createPlans, type IPlanStopJob } from '../plans/index.js';

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
  const coordinationRoot = parsed.data.coordinationRoot
    ? (await resolveAllowedRoots([parsed.data.coordinationRoot]))[0]!
    : undefined;
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
  const plans = createPlans(
    coordinationRoot ?? stateRoot,
    allowedRoots,
    projection,
    ownership.owner.nonce,
    parsed.data.parsePlanContract,
  );
  const skills = createSkills(providers, projection, allowedRoots);
  const accounts = createAccounts(providers);
  const extensions = createExtensions(providers, projection, allowedRoots);
  const actions = createActions(
    providers,
    projection,
    allowedRoots,
    ownership.owner.nonce,
    actionKey,
    skills,
    plans,
    storage.background,
    () => {
      skills.invalidate();
      extensions.invalidate();
      accounts.invalidate();
    },
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
  const revisionJobs = new Map<string, Promise<void>>();
  plans.setStopHandler((job: IPlanStopJob) => {
    if (closing) return;
    if (revisionJobs.has(job.phaseActionId)) return;
    if (revisionJobs.size >= 32)
      throw new Exception('The HQ action conflicts with its recorded state', {
        code: 'JG_AGENT_HQ_ACTION_CONFLICT',
        data: {
          kind: 'state-conflict',
        },
      });
    const task = storage.background(async () => {
      let isQuiescent = false;
      try {
        await actions.quiescePlan(job.controls);
        isQuiescent = true;
        if (job.kind === 'observation') await plans.finishObservation(job, true);
        else if (job.kind === 'revision')
          await plans.checkpoint({ directory: job.directory }, job.revisionId, job.phaseActionId);
      } catch (cause) {
        try {
          if (job.kind === 'observation') await plans.finishObservation(job, false);
          else if (job.kind === 'revision')
            await plans.blockRevision(
              { directory: job.directory },
              job.revisionId,
              job.phaseActionId,
              isQuiescent ? 'checkpoint-unavailable' : 'native-quiescence-unavailable',
            );
          else
            process.stderr.write(
              `Unable to confirm native cleanup for invalid plan ${job.phaseActionId}.\n`,
            );
        } catch {
          process.stderr.write(`Unable to persist blocked revision ${job.phaseActionId}.\n`);
        }
      } finally {
        plans.stopFinished(job.phaseActionId);
        revisionJobs.delete(job.phaseActionId);
      }
    });
    revisionJobs.set(job.phaseActionId, task);
  });
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      try {
        await browser.close();
        const toolCleanup = await Promise.allSettled([agentTools.close()]);
        await collaboration.close();
        await Promise.allSettled([...revisionJobs.values()]);
        const results = await Promise.allSettled([ipc?.close(), actions.close()]);
        results.push(...toolCleanup);
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
      case 'agent-tool':
        return { kind: 'agent-tool', result: await agentTools.handleBridge(command) };
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
      case 'handoff':
        return { kind: 'handoff', result: await handoffs.handle(command.command) };
      case 'collaboration':
        return { kind: 'collaboration', result: await collaboration.handle(command) };
      case 'plan':
        return { kind: 'plan', result: await plans.handle(command.command) };
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
      case 'thread-plan':
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
      default: {
        const response = await readNativeHistory(command, providers, projection, allowedRoots);
        if (command.kind === 'items' && response.kind === 'items')
          actions.live.reconcile(
            JSON.stringify([command.provider, command.nativeId]),
            response.result.data,
          );
        return response;
      }
    }
  };
  const request = (input: IHqRequestInput): Promise<IHqResponse> =>
    storage.run(() => handleRequest(input));
  const collaboration = createCollaboration(projection, allowedRoots, storage.background);
  const agentTools = createAgentTools({
    stateRoot,
    runtimeEpoch: ownership.owner.nonce,
    allowedRoots,
    store: projection,
    collaboration,
    actions,
    run: storage.run,
    read: (command) => readNativeHistory(command, providers, projection, allowedRoots),
  });
  providers.setAgentTools(agentTools.forProvider);
  const handoffs = createHandoffs(
    projection,
    actions,
    skills,
    plans,
    request,
    allowedRoots,
    ownership.owner.nonce,
  );
  try {
    ipc = await createIpcServer(join(stateRoot, CONTROL_SOCKET), ownership.owner.nonce, request);
  } catch (error) {
    await close();
    throw error;
  }
  return {
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
};
