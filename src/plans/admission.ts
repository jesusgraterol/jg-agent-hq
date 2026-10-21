import { Exception } from 'jg-exception';

import type { IActionEnvelope, IActionPlanContext } from '../contracts/index.js';
import { getErrorKind } from '../errors/index.js';
import { withHqLock } from '../locks/index.js';
import type { IStore } from '../store/index.js';
import type { IAdmission } from '../store/control/index.js';

import { canExecutePlanUnit, describePlan } from './authority.js';
import { isSamePlanRevision } from './utilities.js';
import type { IPlanArtifacts } from './types.js';

const conflict = (): never => {
  throw new Exception('The HQ action conflicts with its recorded state', {
    code: 'JG_AGENT_HQ_ACTION_CONFLICT',
    data: {
      kind: 'state-conflict',
    },
  });
};

/**
 * Keeps native scope admission and queue claims under the plan's canonical short lock.
 * @returns The existing action owner's scoped admission and queue operations.
 */
export const createPlanAdmission = (
  coordinationRoot: string,
  store: IStore,
  runtimeEpoch: string,
  readPlan: (directory: string) => Promise<IPlanArtifacts>,
) => {
  /** Resolves a small immutable scope reference against the current authoritative file. */
  const scopeContext = async (
    scope: NonNullable<IActionEnvelope['plan']>,
  ): Promise<{ artifacts: IPlanArtifacts; context: IActionPlanContext }> => {
    const source = await store.getPlanOperation(
      scope.kind === 'execution' ? scope.authorizationId : scope.revisionId,
    );
    if (!source) conflict();
    const artifacts = await readPlan(source!.directory);
    if (await store.getPendingPlanOperationId(artifacts.directory)) conflict();
    if (scope.kind === 'execution') {
      const status = describePlan(artifacts);
      const execution = artifacts.coordination.execution;
      if (
        !execution ||
        execution.runtimeEpoch !== runtimeEpoch ||
        execution.revokedBy ||
        execution.action.id !== scope.authorizationId ||
        execution.mode !== scope.mode ||
        !canExecutePlanUnit(artifacts, scope.milestoneId) ||
        !isSamePlanRevision(execution.revision, scope.revision) ||
        !isSamePlanRevision(scope.revision, artifacts.revision) ||
        status.state === 'blocked' ||
        (artifacts.coordination.revision && artifacts.coordination.revision.phase !== 'finished') ||
        artifacts.coordination.observedConflict
      )
        conflict();
    } else {
      const workflow = artifacts.coordination.revision;
      if (
        !workflow ||
        workflow.id !== scope.revisionId ||
        workflow.phase !== 'editing' ||
        workflow.ownerRuntimeEpoch !== runtimeEpoch ||
        !workflow.checkpoint?.isQuiescent ||
        workflow.invocation?.action.id !== scope.invocationId
      )
        conflict();
    }
    return {
      artifacts,
      context: { directory: artifacts.directory, scope, observedRevision: artifacts.revision },
    };
  };
  /** Blocks work on a bound thread while its contracts or owner are being reconciled. */
  const boundArtifacts = async (context: IActionPlanContext): Promise<IPlanArtifacts> => {
    const artifacts = await readPlan(context.directory);
    if (
      (await store.getPendingPlanOperationId(artifacts.directory)) ||
      artifacts.coordination.observedConflict ||
      describePlan(artifacts).state === 'blocked' ||
      (artifacts.coordination.revision && artifacts.coordination.revision.phase !== 'finished') ||
      !isSamePlanRevision(context.observedRevision, artifacts.revision)
    )
      conflict();
    return artifacts;
  };
  return {
    /**
     * Validates guided scope and admits under the same short lock as revision gate closure.
     * @returns The existing action owner's receipt and dispatch identity.
     * @throws
     * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
     * - JG_AGENT_HQ_PLAN_FAILED: The HQ plan operation failed
     * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
     * - JG_AGENT_HQ_LOCK_INVALID_ARGUMENTS: The HQ lock acquisition arguments are invalid
     * - JG_AGENT_HQ_LOCK_UNSUPPORTED_PLATFORM: The HQ lock requires Linux or macOS
     * - JG_AGENT_HQ_RUNTIME_DIRECTORY_INVALID: The HQ runtime directory must be a real directory
     * - JG_AGENT_HQ_RUNTIME_DIRECTORY_PERMISSIONS: The HQ runtime directory must be private and owned by the current user
     * - JG_AGENT_HQ_LOCK_FILE_INVALID: The HQ lock must be a regular file
     * - JG_AGENT_HQ_LOCK_FILE_PERMISSIONS: The HQ lock must be private and owned by the current user
     * - JG_AGENT_HQ_LOCK_OWNER_OVERSIZED: The HQ lock owner exceeds the supported size
     * - JG_AGENT_HQ_LOCK_OWNER_UNREADABLE: The HQ lock owner could not be read. Inspect .runtime/hq.lock
     * - JG_AGENT_HQ_LOCK_OWNER_INCOMPLETE: The HQ lock owner is incomplete. Inspect .runtime/hq.lock and remove it only after its owner stopped
     * - JG_AGENT_HQ_LOCK_OWNER_INACTIVE: The HQ lock has an inactive owner
     * - JG_AGENT_HQ_LOCK_OWNER_UNVERIFIABLE: The HQ lock owner could not be verified
     * - JG_AGENT_HQ_LOCK_TIMEOUT: Timed out waiting for the HQ lock
     * - JG_AGENT_HQ_LOCK_OWNERSHIP_CHANGED: HQ lock ownership changed before release
     */
    async admitNative(action: IActionEnvelope, prepared: IAdmission['prepared']) {
      return withHqLock(coordinationRoot, 'plan-native-admission', async () => {
        const command = action.command;
        const queued =
          'queuedActionId' in command ? await store.getAction(command.queuedActionId) : null;
        const threadId = 'threadId' in command ? command.threadId : queued?.threadId;
        const binding = threadId ? await store.getThreadPlan(threadId) : null;
        const safe =
          command.kind === 'interrupt' ||
          command.kind === 'thread-close' ||
          command.kind === 'queue-cancel' ||
          (command.kind === 'native-reply' &&
            command.response.kind !== 'answers' &&
            ['decline', 'cancel'].includes(command.response.decision));
        if ('expectedPlan' in action) {
          if (!['message', 'queue'].includes(command.kind) || !threadId) conflict();
          const expected = action.expectedPlan;
          if (binding?.directory !== expected?.directory) conflict();
          if (expected) {
            const current = await readPlan(expected.directory);
            if (!isSamePlanRevision(expected.observedRevision, current.revision)) conflict();
          }
        }
        // explicit assessment keeps its revision guard without inheriting implementation authority
        const isFeedbackAssessment =
          !!action.expectedPlan &&
          (command.kind === 'message' || command.kind === 'queue') &&
          command.input.kind === 'skill' &&
          prepared.skill?.name === 'jg-feedback';
        // current-turn permission replies and labels do not start another implementation unit
        const isSeparateNativeControl =
          command.kind === 'native-reply' || command.kind === 'thread-rename';
        if (action.plan) {
          if (
            !['message', 'queue', 'steer', 'thread-resume', 'thread-recover'].includes(
              command.kind,
            ) ||
            !threadId
          )
            conflict();
          const selected = await scopeContext(action.plan);
          if (binding && JSON.stringify(binding.scope) !== JSON.stringify(action.plan)) {
            const current = await store.getThread(threadId!);
            if (
              !current ||
              current.state !== 'inactive' ||
              current.runtimeEpoch !== null ||
              current.ownership !== 'managed'
            )
              conflict();
          }
          const requestedMilestone =
            action.plan.kind === 'execution' ? action.plan.milestoneId : null;
          if (action.plan.kind === 'planning') {
            const existing = binding?.scope;
            if (
              (command.kind === 'message' || command.kind === 'queue') &&
              command.input.kind === 'skill'
            ) {
              if (
                prepared.skill?.name !== selected.artifacts.coordination.revision!.invocation!.skill
              )
                conflict();
            } else if (
              (command.kind === 'message' ||
                command.kind === 'queue' ||
                command.kind === 'steer') &&
              (!existing ||
                existing.kind !== 'planning' ||
                existing.revisionId !== action.plan.revisionId ||
                existing.invocationId !== action.plan.invocationId)
            )
              conflict();
          } else if (command.kind === 'message' || command.kind === 'queue') {
            if (
              describePlan(selected.artifacts).state === 'blocked' ||
              selected.artifacts.parsed.some(
                (entry) => entry.id === requestedMilestone && entry.status === 'done',
              )
            )
              conflict();
          }
          prepared.planContext = selected.context;
        } else if (command.kind === 'queue-send' && queued?.planContext) {
          const context = queued.planContext;
          if (context.scope) {
            const current = await scopeContext(context.scope);
            if (
              !isSamePlanRevision(context.observedRevision, current.artifacts.revision) &&
              context.scope.kind === 'execution'
            )
              conflict();
          } else await boundArtifacts(context);
          prepared.planContext = context;
        } else if (binding && !safe) {
          if (
            binding.scope &&
            !isFeedbackAssessment &&
            !(binding.scope.kind === 'execution' && isSeparateNativeControl)
          ) {
            prepared.planContext = (await scopeContext(binding.scope)).context;
          } else {
            const artifacts = await boundArtifacts(binding);
            prepared.planContext = {
              directory: binding.directory,
              scope: null,
              observedRevision: artifacts.revision,
            };
          }
        }
        return store.admit({ action, prepared });
      });
    },
    /**
     * Claims queued input only after current scope and the editing gate are checked.
     * @returns One existing dispatch or null while the plan is paused.
     * @throws
     * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
     * - JG_AGENT_HQ_PLAN_FAILED: The HQ plan operation failed
     * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
     * - JG_AGENT_HQ_LOCK_INVALID_ARGUMENTS: The HQ lock acquisition arguments are invalid
     * - JG_AGENT_HQ_LOCK_UNSUPPORTED_PLATFORM: The HQ lock requires Linux or macOS
     * - JG_AGENT_HQ_RUNTIME_DIRECTORY_INVALID: The HQ runtime directory must be a real directory
     * - JG_AGENT_HQ_RUNTIME_DIRECTORY_PERMISSIONS: The HQ runtime directory must be private and owned by the current user
     * - JG_AGENT_HQ_LOCK_FILE_INVALID: The HQ lock must be a regular file
     * - JG_AGENT_HQ_LOCK_FILE_PERMISSIONS: The HQ lock must be private and owned by the current user
     * - JG_AGENT_HQ_LOCK_OWNER_OVERSIZED: The HQ lock owner exceeds the supported size
     * - JG_AGENT_HQ_LOCK_OWNER_UNREADABLE: The HQ lock owner could not be read. Inspect .runtime/hq.lock
     * - JG_AGENT_HQ_LOCK_OWNER_INCOMPLETE: The HQ lock owner is incomplete. Inspect .runtime/hq.lock and remove it only after its owner stopped
     * - JG_AGENT_HQ_LOCK_OWNER_INACTIVE: The HQ lock has an inactive owner
     * - JG_AGENT_HQ_LOCK_OWNER_UNVERIFIABLE: The HQ lock owner could not be verified
     * - JG_AGENT_HQ_LOCK_TIMEOUT: Timed out waiting for the HQ lock
     * - JG_AGENT_HQ_LOCK_OWNERSHIP_CHANGED: HQ lock ownership changed before release
     */
    async claimQueued(threadId: string) {
      return withHqLock(coordinationRoot, 'plan-queue-admission', async () => {
        const queued = await store.peekQueued(threadId);
        if (!queued) return null;
        try {
          const context = queued.planContext;
          if (!context && (await store.getThreadPlan(threadId))) return null;
          const queuedMilestone =
            context?.scope?.kind === 'execution' ? context.scope.milestoneId : null;
          if (context?.scope) {
            const current = await scopeContext(context.scope);
            if (
              context.scope.kind === 'execution' &&
              (!isSamePlanRevision(context.observedRevision, current.artifacts.revision) ||
                current.artifacts.parsed.some(
                  (entry) => entry.id === queuedMilestone && entry.status === 'done',
                ))
            )
              return null;
          } else if (context) await boundArtifacts(context);
        } catch (error) {
          if (getErrorKind(error) === 'state-conflict') return null;
          throw error;
        }
        return store.claimQueued(threadId);
      });
    },
  };
};
