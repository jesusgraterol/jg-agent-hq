import { join } from 'node:path';
import { Exception, extractMessage } from 'error-message-utils';
import { z } from 'zod';

import { HqRequestSchema, type IHqRequestInput, type IHqResponse } from '../contracts/index.js';
import { createActions, readControl } from '../actions/index.js';
import { createHandoffs } from '../handoffs/index.js';
import { CONTROL_SOCKET, createIpcServer } from '../ipc/index.js';
import {
  createCodexProvider,
  createClaudeProvider,
  createClaudeControl,
  type ICodexProvider,
} from '../providers/index.js';
import { readNativeHistory } from '../sessions/index.js';
import { suggestThreadName } from '../sessions/names/index.js';
import { createSkills } from '../skills/index.js';
import { createStore } from '../store/index.js';
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
  let provider: ICodexProvider | undefined;
  let ipc: Awaited<ReturnType<typeof createIpcServer>> | undefined;
  let actionKey: Uint8Array;
  try {
    const databasePath = await prepareDatabase(stateRoot);
    actionKey = await prepareActionKey(stateRoot, databasePath);
    store = await createStore(databasePath, ownership.owner.nonce, actionKey);
    provider = await createCodexProvider(codexExtraSkillRoots);
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
  const browser = createBrowserActions(store);
  const native = provider;
  const projection = store;
  const claude = createClaudeProvider(projection);
  const claudeControl = createClaudeControl(claudeAdditionalDirectories);
  const plans = createPlans(
    coordinationRoot ?? stateRoot,
    allowedRoots,
    projection,
    ownership.owner.nonce,
    parsed.data.parsePlanContract,
  );
  const skills = createSkills(native, claudeControl, projection, allowedRoots);
  const actions = createActions(
    native,
    claudeControl,
    async (nativeId, workspaceRoot) => {
      const response = await claude.readHistory({
        kind: 'thread',
        provider: 'claude',
        nativeId,
        workspaceRoot,
      });
      if (response.kind !== 'thread')
        throw new Exception('The Claude integration failed', undefined, {
          kind: 'agent-unavailable',
        });
      return response.result;
    },
    projection,
    allowedRoots,
    ownership.owner.nonce,
    actionKey,
    skills,
    plans,
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
      throw new Exception('The HQ action conflicts with its recorded state', undefined, {
        kind: 'state-conflict',
      });
    const task = (async () => {
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
    })();
    revisionJobs.set(job.phaseActionId, task);
  });
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      try {
        await browser.close();
        await Promise.allSettled([...revisionJobs.values()]);
        const results = await Promise.allSettled([ipc?.close(), actions.close(), claude.close()]);
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
              steering: 'available',
            },
            claude: {
              state:
                claudeControl.state === 'ready'
                  ? 'ready'
                  : claude.state === 'idle'
                    ? claudeControl.state
                    : claude.state,
              version: claude.version ?? claudeControl.version,
              steering: 'unavailable',
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
        return {
          kind: 'usage',
          result: await (command.provider === 'claude' ? claude.readUsage() : native.readUsage()),
        };
      case 'handoff':
        return { kind: 'handoff', result: await handoffs.handle(command.command) };
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
      case 'events':
      case 'approvals':
      case 'live-items':
        return readControl(command, projection, actions, allowedRoots);
      default: {
        if (command.provider === 'claude') {
          const workspaceRoot = await resolveWorkspaceTarget(command.workspaceRoot, allowedRoots);
          const response = await claude.readHistory({ ...command, workspaceRoot });
          if (response.kind === 'threads') {
            const managed = new Map(
              (
                await projection.getNativeThreads(
                  'claude',
                  response.result.data.map((thread) => thread.nativeId),
                )
              ).map((thread) => [thread.nativeId, thread]),
            );
            for (const thread of response.result.data) {
              const control = managed.get(thread.nativeId);
              if (control) {
                thread.managedId = control.id;
                thread.ownership = control.ownership;
                thread.name = control.name;
              }
            }
          } else if (response.kind === 'thread') {
            const control = await projection.getThreadByNativeId(
              'claude',
              response.result.nativeId,
            );
            if (control) {
              response.result.managedId = control.id;
              response.result.ownership = control.ownership;
              response.result.name = control.name;
            }
          }
          if (command.kind === 'items' && response.kind === 'items')
            actions.live.reconcile(
              JSON.stringify(['claude', command.nativeId]),
              response.result.data,
            );
          return response;
        }
        const response = await readNativeHistory(command, native, projection, allowedRoots);
        if (command.kind === 'items' && response.kind === 'items')
          actions.live.reconcile(JSON.stringify(['codex', command.nativeId]), response.result.data);
        return response;
      }
    }
  };
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
    close,
    performBrowserAction: browser.perform,
    readBrowserAction: browser.read,
  };
};
