import { setImmediate } from 'node:timers/promises';
import { isException } from 'jg-exception';

import {
  DISPATCH_OUTPUT_SCHEMA,
  type IDispatchBlocked,
  type ICollaborationStatus,
} from '../../contracts/collaboration/index.js';
import type { createActions } from '../../actions/index.js';
import type { IStore } from '../../store/index.js';
import type { ICollaboration, ICollaborationBackground } from '../types.js';

/**
 * Recovers one local dispatch owner through bounded storage batches and persisted native events.
 * @returns Event-driven wakeup, visible failure state and a draining shutdown.
 */
export const createDispatch = (
  store: IStore,
  actions: ReturnType<typeof createActions>,
  collaboration: ICollaboration,
  background: ICollaborationBackground,
  runtimeEpoch: string,
) => {
  let isClosed = false;
  let dirty = false;
  let loop: Promise<void> | undefined;
  let failure: ICollaborationStatus['dispatchFailure'] = null;

  const processRequest = async (taskId: string, requestId: string): Promise<void> => {
    let job = await store.dispatchJob(taskId, requestId);
    if (job.request.currentActionId !== null) {
      const actionId = job.request.currentActionId;
      const collection = await store.collectDispatch(taskId, requestId, actionId);
      if (collection !== null) {
        collaboration.recover();
        if (job.thread) actions.advanceQueued(job.thread);
        dirty = true;
      } else {
        await store.blockDispatch(requestId, actionId, job.blockedReason);
        const shouldStop =
          job.request.state === 'canceled' ||
          (job.blockedReason !== null &&
            ['task-paused', 'agent-paused', 'grant-invalid'].includes(job.blockedReason));
        if (
          shouldStop &&
          job.thread?.activeTurnId &&
          job.context &&
          job.thread.state !== 'stopping' &&
          job.thread.ownership === 'managed' &&
          job.thread.runtimeEpoch === runtimeEpoch
        ) {
          const receipt = await store.getAction(actionId);
          if (
            receipt?.nativeTurnId === job.thread.activeTurnId &&
            !(await store.getAction(job.context.interruptActionId))
          )
            await actions.submit({
              id: job.context.interruptActionId,
              runtimeEpoch,
              command: {
                kind: 'interrupt',
                threadId: job.thread.id,
                expectedTurnId: job.thread.activeTurnId,
              },
            });
        }
      }
      return;
    }
    if (
      job.request.pendingActionId === null ||
      !['open', 'claimed', 'waiting-children'].includes(job.request.state)
    )
      return;
    let reason = job.blockedReason;
    if (reason === null && job.thread && job.packet !== null) {
      try {
        await actions.flushEvents(job.thread.provider);
        job = await store.dispatchJob(taskId, requestId);
        reason = job.blockedReason;
        if (
          reason === null &&
          job.thread &&
          job.packet !== null &&
          job.request.pendingActionId !== null
        )
          await actions.submit(
            {
              id: job.request.pendingActionId,
              runtimeEpoch,
              command: {
                kind: 'message',
                threadId: job.thread.id,
                input: { kind: 'text', text: job.packet },
                settings: { outputSchema: DISPATCH_OUTPUT_SCHEMA },
              },
            },
            { collaboration: { taskId, requestId, pendingActionId: job.request.pendingActionId } },
          );
      } catch (error) {
        if (!isException(error)) throw error;
        const reasons: Record<string, IDispatchBlocked> = {
          JG_AGENT_HQ_COLLABORATION_FORBIDDEN: 'grant-invalid',
          JG_AGENT_HQ_COLLABORATION_CONFLICT: 'action-conflict',
          JG_AGENT_HQ_ACTION_CONFLICT: 'plan-authorization-required',
          JG_AGENT_HQ_PLAN_INVALID: 'plan-stale',
          JG_AGENT_HQ_PLAN_FAILED: 'plan-stale',
          JG_AGENT_HQ_PROVIDER_FAILED: 'provider-unavailable',
          JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: 'provider-unavailable',
          JG_AGENT_HQ_SKILL_UNAVAILABLE: 'skill-unavailable',
          JG_AGENT_HQ_CODEX_FAILED: 'provider-unavailable',
          JG_AGENT_HQ_CLAUDE_FAILED: 'provider-unavailable',
        };
        reason = reasons[error.code] ?? null;
        if (reason === null) throw error;
      }
    }
    if (reason !== null && job.request.pendingActionId !== null)
      await store.blockDispatch(requestId, job.request.pendingActionId, reason);
  };

  const wake = (): void => {
    if (isClosed) return;
    dirty = true;
    if (loop) return;
    loop = (async () => {
      try {
        do {
          dirty = false;
          let after = 0;
          let boundary: number | undefined;
          while (!isClosed) {
            const page = await background(() => store.dispatchPage({ after, boundary }));
            boundary = page.boundary;
            if (page.data.length === 0) break;
            for (const entry of page.data) {
              if (isClosed) break;
              await background(() => processRequest(entry.taskId, entry.requestId));
              after = entry.sequence;
            }
            if (page.data.length < 32) break;
            await setImmediate();
          }
        } while (dirty && !isClosed);
        failure = null;
      } catch (error) {
        // Every action identity and pending intent remains durable; a later event can retry reads.
        failure =
          isException(error) && error.code === 'JG_AGENT_HQ_STORE_FAILED'
            ? 'JG_AGENT_HQ_STORE_FAILED'
            : 'recovery-failed';
      } finally {
        loop = undefined;
      }
    })();
  };
  return {
    wake,
    failure: () => failure,
    async close(): Promise<void> {
      isClosed = true;
      await loop;
    },
  };
};
