import { randomUUID } from 'node:crypto';
import { withPlanDocumentLocks } from 'jg-plans';
import { z } from 'zod';
import { Exception, extractMessage, hasErrorCode } from 'jg-exception';

import {
  PlanMilestoneSchema,
  type IPlanCommand,
  type IActionEnvelope,
  type IPlanResult,
  type IPlanRevisionWorkflow,
} from '../contracts/index.js';
import { getErrorKind } from '../errors/index.js';
import { withHqLock } from '../locks/index.js';
import { resolveWorkspaceTarget } from '../runtime/state/index.js';
import type { IStore } from '../store/index.js';

import { canExecutePlanUnit, describePlan, updatePlanAuthority } from './authority.js';
import { createPlanAdmission } from './admission.js';
import { readPlanPage } from './projections.js';
import { invalid, prepareAggregateProgress, prepareSequenceMarkers } from './documents.js';
import { finalizeInitialSequence } from './finalization.js';
import {
  beginPlanRevision,
  finishPlanCheckpoint,
  recordPlanCompletion,
  refreshPlanBaseline,
} from './revisions.js';
import { capturePlanWorktrees } from './evidence.js';
import {
  proposeReconciliation,
  confirmReconciliation,
  renderReconciledSequence,
} from './reconciliation.js';
import {
  parsePlanCoordination,
  serializePlanCoordination,
  readPlanArtifacts,
  readPlanFile,
  writePlanFile,
  removePlanMilestones,
  resolvePlanDirectory,
} from './files.js';
import {
  hashPlanContent,
  isSamePlanRevision,
  computePlanRevision,
  parsePlanMilestones,
} from './utilities.js';
import type {
  IPlanArtifacts,
  IPlanWriteIntent,
  IPlanContractParser,
  IPlanStopJob,
  IApplyPlanIntent,
} from './types.js';

const conflict = (): never => {
  throw new Exception('The HQ action conflicts with its recorded state', {
    code: 'JG_AGENT_HQ_ACTION_CONFLICT',
    data: {
      kind: 'state-conflict',
    },
  });
};

/**
 * Coordinates bounded selected-plan files under the existing metadata lock.
 * @returns A handler for plan records and projections; it never dispatches native input.
 */
export const createPlans = (
  coordinationRoot: string,
  roots: string[],
  store: IStore,
  runtimeEpoch: string,
  parseContract?: IPlanContractParser,
) => {
  const assertWriteBounds = (intent: IPlanWriteIntent): void => {
    const markdown = [
      intent.plan,
      intent.milestones.operation === 'write' ? intent.milestones.source : null,
    ];
    if (
      markdown.some(
        (source) =>
          source !== null &&
          (Buffer.byteLength(source) > 1_048_576 || /[\uD800-\uDFFF]/u.test(source)),
      ) ||
      Buffer.byteLength(intent.coordination) > 8_388_608
    )
      throw new Exception('The HQ plan is invalid', {
        code: 'JG_AGENT_HQ_PLAN_INVALID',
        data: { kind: 'invalid-request' },
      });
  };
  const prepareWrite = (intent: IPlanWriteIntent) => {
    assertWriteBounds(intent);
    return store.preparePlanOperation(intent);
  };
  const activeStopPhases = new Set<string>();
  const invalidStops = new Map<string, string>();
  let stopHandler: ((job: IPlanStopJob) => void) | undefined;
  const describeCurrent = (artifacts: IPlanArtifacts, pendingActionId: string | null = null) => {
    const status = describePlan(artifacts, pendingActionId);
    const workflow = artifacts.coordination.revision;
    if (
      workflow &&
      ['quiescing', 'editing', 'reconciling', 'blocked'].includes(workflow.phase) &&
      (workflow.ownerRuntimeEpoch !== runtimeEpoch ||
        (workflow.phase === 'quiescing' && !activeStopPhases.has(workflow.phaseActionId)))
    ) {
      status.state = 'blocked';
      if (status.coordination.revision)
        status.coordination.revision.reason = 'revision-owner-unavailable';
    }
    return status;
  };
  /** Converts unavailable contract reads into paused input, preserving the underlying diagnostics. */
  const readAdmissionPlan = async (
    directory: string,
    translateError: boolean,
    apply: IApplyPlanIntent,
  ): Promise<IPlanArtifacts> => {
    try {
      return await readPlanArtifacts({ directory }, roots, parseContract);
    } catch (cause) {
      if (
        stopHandler &&
        !invalidStops.has(directory) &&
        invalidStops.size < 32 &&
        getErrorKind(cause) !== 'access-denied'
      ) {
        const threadIds = await store.getPlanThreads(directory);
        if (threadIds.length) {
          const id = randomUUID();
          invalidStops.set(directory, id);
          let hasStarted = false;
          try {
            let observation: Awaited<ReturnType<typeof retainUnavailable>> | undefined;
            let persistenceFailure: unknown;
            try {
              observation = await retainUnavailable(directory, id, threadIds, apply);
            } catch (error) {
              persistenceFailure = error;
            }
            stopHandler({
              kind: observation ? 'observation' : 'invalid-artifact',
              directory,
              revisionId: id,
              phaseActionId: id,
              controls:
                observation?.controls ??
                threadIds.map((threadId) => ({
                  threadId,
                  interruptActionId: randomUUID(),
                  closeActionId: randomUUID(),
                })),
            });
            hasStarted = true;
            if (persistenceFailure) throw persistenceFailure;
          } catch (error) {
            if (!hasStarted) invalidStops.delete(directory);
            throw error;
          }
        }
      }
      if (!translateError) throw cause;
      throw new Exception(
        `The HQ action conflicts with its recorded state: ${extractMessage(cause)}`,
        { code: 'JG_AGENT_HQ_ACTION_CONFLICT', data: { kind: 'state-conflict' }, cause },
      );
    }
  };
  /**
   * Replays only a recorded exact write or its unchanged baseline; external edits remain conflicts.
   * @returns A promise resolved after the authoritative files and derived ledger agree.
   * @throws
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
   * - JG_AGENT_HQ_PLAN_FAILED: The HQ plan operation failed
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  const applyFiles = async (intent: IPlanWriteIntent): Promise<void> => {
    if (intent.state === 'completed') return;
    assertWriteBounds(intent);
    const [plan, milestones, coordination] = await Promise.all([
      intent.before.plan === null ? null : readPlanFile(intent.directory, 'plan.md'),
      intent.before.plan === null ? null : readPlanFile(intent.directory, 'milestones.md', true),
      readPlanFile(intent.directory, 'coordination.json', true, 8_388_608),
    ]);
    const hash = (text: string | null) => (text === null ? null : hashPlanContent(text));
    const desiredMilestones =
      intent.milestones.operation === 'write'
        ? intent.milestones.source
        : intent.milestones.operation === 'remove'
          ? null
          : milestones;
    if (
      intent.before.plan === null &&
      (intent.plan !== null || intent.milestones.operation !== 'keep')
    )
      conflict();
    if (
      intent.before.plan !== null &&
      hash(plan) !== intent.before.plan &&
      (intent.plan === null || plan !== intent.plan)
    )
      conflict();
    if (
      intent.before.plan !== null &&
      hash(milestones) !== intent.before.milestones &&
      (intent.milestones.operation === 'keep' || milestones !== desiredMilestones)
    )
      conflict();
    if (hash(coordination) !== intent.before.coordination && coordination !== intent.coordination)
      conflict();
    // All guards precede any write. Replaying desired bytes flushes durability and explicit privacy.
    if (intent.plan !== null) await writePlanFile(intent.directory, 'plan.md', intent.plan, plan);
    if (intent.milestones.operation === 'write')
      await writePlanFile(intent.directory, 'milestones.md', intent.milestones.source, milestones);
    else if (intent.milestones.operation === 'remove')
      await removePlanMilestones(intent.directory, milestones);
    await writePlanFile(intent.directory, 'coordination.json', intent.coordination, coordination);
  };
  /** The HQ metadata owner remains held through document release and durable ledger completion. */
  const withDocuments = async <T>(
    selected: string,
    operation: (apply: IApplyPlanIntent) => Promise<T>,
  ): Promise<T> => {
    const directory = await resolvePlanDirectory(selected, roots);
    const applied = new Set<string>();
    const apply: IApplyPlanIntent = async (intent) => {
      await applyFiles(intent);
      if (intent.state !== 'completed') applied.add(intent.id);
    };
    let result: T | undefined;
    let operationFailed = false;
    let operationFailure: unknown;
    const run = async () => {
      try {
        return await operation(apply);
      } catch (cause) {
        operationFailed = true;
        operationFailure = cause;
        throw cause;
      }
    };
    try {
      result = await withPlanDocumentLocks(directory, ['plan', 'milestones'], run);
    } catch (cause) {
      // The callback's exact error can escape only after successful document release.
      if (!(operationFailed && cause === operationFailure)) {
        if (hasErrorCode(cause, 'JG_PLANS_LOCK_BUSY'))
          throw new Exception('The HQ action conflicts with its recorded state', {
            code: 'JG_AGENT_HQ_ACTION_CONFLICT',
            data: { kind: 'state-conflict', reason: 'document-locked' },
            cause,
          });
        if (hasErrorCode(cause, 'JG_PLANS_LOCK_FAILED')) {
          const outcome = z
            .object({
              data: z.object({
                mutationOutcome: z.enum(['not-applied', 'uncertain']),
                phase: z.enum(['canonicalize', 'acquire', 'release']),
                operationCompleted: z.boolean(),
              }),
            })
            .safeParse(cause);
          throw new Exception(`The HQ plan operation failed: ${extractMessage(cause)}`, {
            code: 'JG_AGENT_HQ_PLAN_FAILED',
            data: {
              kind: 'operation-failed',
              outcome: outcome.success ? outcome.data.data.mutationOutcome : 'uncertain',
              ...(outcome.success
                ? {
                    phase: outcome.data.data.phase,
                    operationCompleted: outcome.data.data.operationCompleted,
                  }
                : {}),
            },
            cause,
          });
        }
        throw cause;
      }
    }
    for (const id of applied) await store.completePlanOperation(id);
    if (operationFailed) throw operationFailure;
    return result as T;
  };
  /** Retains a closed gate even when current contract framing cannot be parsed. */
  const retainUnavailable = async (
    selected: string,
    id: string,
    threadIds: string[],
    apply: IApplyPlanIntent,
  ) => {
    const directory = await resolveWorkspaceTarget(selected, roots);
    const text = await readPlanFile(directory, 'coordination.json', true, 8_388_608);
    if (text === null || (await store.getPendingPlanOperationId(directory))) return null;
    let coordination;
    try {
      coordination = parsePlanCoordination(text);
    } catch {
      return null;
    }
    if (coordination.observedConflict) return null;
    const observation = {
      id,
      revision: null,
      observedAt: Date.now(),
      ownerRuntimeEpoch: runtimeEpoch,
      phase: 'quiescing' as const,
      controls: threadIds.map((threadId) => ({
        threadId,
        interruptActionId: randomUUID(),
        closeActionId: randomUUID(),
      })),
    };
    coordination.observedConflict = observation;
    const intent = await prepareWrite({
      id,
      digest: hashPlanContent(JSON.stringify(observation)),
      directory,
      before: { plan: null, milestones: null, coordination: hashPlanContent(text) },
      coordination: serializePlanCoordination(coordination),
      plan: null,
      milestones: { operation: 'keep' },
      state: 'prepared',
    });
    await apply(intent);
    return observation;
  };
  /** Persists an observed external contract change before asking the runtime to stop its exact threads. */
  const observeChange = async (
    artifacts: IPlanArtifacts,
    apply: IApplyPlanIntent,
  ): Promise<IPlanArtifacts> => {
    const coordination = artifacts.coordination;
    const workflow = coordination.revision;
    if (
      !coordination.baseline ||
      coordination.observedConflict ||
      (workflow && workflow.phase !== 'finished') ||
      (isSamePlanRevision(coordination.baseline.revision, artifacts.revision) &&
        artifacts.skillsBinding !== 'stale') ||
      (await store.getPendingPlanOperationId(artifacts.directory))
    )
      return artifacts;
    const threadIds = await store.getPlanThreads(artifacts.directory);
    const id = randomUUID();
    const observedConflict = {
      id,
      revision: artifacts.revision,
      observedAt: Date.now(),
      ownerRuntimeEpoch: runtimeEpoch,
      phase: 'quiescing' as const,
      controls: threadIds.map((threadId) => ({
        threadId,
        interruptActionId: randomUUID(),
        closeActionId: randomUUID(),
      })),
    };
    const next = { ...coordination, observedConflict };
    try {
      const intent = await prepareWrite({
        id,
        digest: hashPlanContent(JSON.stringify(observedConflict)),
        directory: artifacts.directory,
        before: artifacts.hashes,
        coordination: serializePlanCoordination(next),
        plan: null,
        milestones: { operation: 'keep' },
        state: 'prepared',
      });
      await apply(intent);
    } catch (cause) {
      stopHandler?.({
        kind: 'invalid-artifact',
        directory: artifacts.directory,
        revisionId: id,
        phaseActionId: id,
        controls: observedConflict.controls,
      });
      throw cause;
    }
    if (stopHandler)
      stopHandler({
        kind: 'observation',
        directory: artifacts.directory,
        revisionId: id,
        phaseActionId: id,
        controls: observedConflict.controls,
      });
    return readPlanArtifacts({ directory: artifacts.directory }, roots, parseContract);
  };
  const implementationDigest = (action: IActionEnvelope) =>
    hashPlanContent(JSON.stringify(['implementation-progress', action]));
  const resumeImplementation = async (
    directory: string,
    action: IActionEnvelope,
  ): Promise<void> => {
    const previous = await store.getPlanOperation(action.id);
    if (!previous) return;
    if (previous.directory !== directory || previous.digest !== implementationDigest(action))
      conflict();
    if (previous.state === 'prepared') await withDocuments(directory, (apply) => apply(previous));
  };
  const prepareImplementation = async (
    artifacts: IPlanArtifacts,
    action: IActionEnvelope,
    milestoneId: string | null,
    apply: IApplyPlanIntent,
  ): Promise<void> => {
    const previous = await store.getPlanOperation(action.id);
    if (previous) {
      if (
        previous.directory !== artifacts.directory ||
        previous.digest !== implementationDigest(action)
      )
        conflict();
      return;
    }
    // Native replay owns its existing receipt. A reused identity cannot start new progress.
    if (await store.getAction(action.id)) return;
    const plan = prepareAggregateProgress(artifacts.plan, 'in progress');
    const entry = artifacts.parsed.find((item) => item.id === milestoneId);
    const milestones =
      artifacts.milestones !== null && entry?.id && entry.status === 'pending'
        ? prepareSequenceMarkers(artifacts.milestones, [
            { ordinal: entry.ordinal, id: entry.id, status: 'in progress' },
          ])
        : artifacts.milestones;
    if (plan === null && milestones === artifacts.milestones) return;
    const coordination = structuredClone(artifacts.coordination);
    coordination.lastActionId = action.id;
    coordination.baseline = refreshPlanBaseline(artifacts, milestones, artifacts.revision);
    if (plan !== null) coordination.baseline.plan = plan;
    const intent = await prepareWrite({
      id: action.id,
      digest: implementationDigest(action),
      directory: artifacts.directory,
      before: artifacts.hashes,
      plan,
      milestones:
        milestones === artifacts.milestones
          ? { operation: 'keep' }
          : { operation: 'write', source: milestones! },
      coordination: serializePlanCoordination(coordination),
      state: 'prepared',
    });
    await apply(intent);
  };
  const admission = createPlanAdmission(
    coordinationRoot,
    store,
    runtimeEpoch,
    async (directory, apply) =>
      observeChange(await readAdmissionPlan(directory, true, apply), apply),
    withDocuments,
    prepareImplementation,
    resumeImplementation,
  );
  return {
    ...admission,
    /** Installs the runtime's one owner for stop/checkpoint work. */
    setStopHandler(handler: (job: IPlanStopJob) => void): void {
      stopHandler = handler;
    },
    /** Releases an owned phase after confirmed success or a retained failure. */
    stopFinished(phaseActionId: string): void {
      activeStopPhases.delete(phaseActionId);
      for (const [directory, id] of invalidStops)
        if (id === phaseActionId) invalidStops.delete(directory);
    },
    /**
     * Reads the current stop phase for the runtime owner.
     * @returns The selected workflow, or null when no revision exists.
     * @throws
     * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
     * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
     * - JG_AGENT_HQ_PLAN_FAILED: The HQ plan operation failed
     */
    async stopPhase(target: IPlanCommand['target']): Promise<IPlanRevisionWorkflow | null> {
      return (await readPlanArtifacts(target, roots, parseContract)).coordination.revision;
    },
    /**
     * Retains failed quiescence/checkpoint work without releasing the editing gate.
     * @returns A promise resolved after the blocked state is retained or the phase is no longer current.
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
    async blockRevision(
      target: IPlanCommand['target'],
      revisionId: string,
      phaseActionId: string,
      reason: 'native-quiescence-unavailable' | 'checkpoint-unavailable',
    ): Promise<void> {
      await withHqLock(coordinationRoot, 'plan-revision-blocked', () =>
        withDocuments(target.directory, async (apply) => {
          const artifacts = await readPlanArtifacts(target, roots, parseContract);
          const workflow = artifacts.coordination.revision;
          if (
            !workflow ||
            workflow.id !== revisionId ||
            workflow.phaseActionId !== phaseActionId ||
            (await store.getPendingPlanOperationId(artifacts.directory))
          )
            return;
          const previous = await store.getPlanOperation(workflow.blockActionId);
          if (previous) {
            await apply(previous);
            return;
          }
          const coordination = structuredClone(artifacts.coordination);
          coordination.revision!.phase = 'blocked';
          coordination.revision!.reason = reason;
          const intent = await prepareWrite({
            id: workflow.blockActionId,
            digest: hashPlanContent(JSON.stringify([revisionId, phaseActionId, 'blocked'])),
            directory: artifacts.directory,
            before: artifacts.hashes,
            coordination: serializePlanCoordination(coordination),
            plan: null,
            milestones: { operation: 'keep' },
            state: 'prepared',
          });
          await apply(intent);
        }),
      );
    },
    /**
     * Reads or explicitly changes plan authority without approving native tools or starting execution.
     * @returns A bounded status/page, full finalized presentation, or exact authorization check.
     * @throws
     * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
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
    async handle(command: IPlanCommand): Promise<IPlanResult> {
      const completionWorktrees =
        command.kind === 'complete' ? await capturePlanWorktrees(command.checkouts, roots) : [];
      const result = await withHqLock(coordinationRoot, `plan-${command.kind}`, () =>
        withDocuments(command.target.directory, async (apply): Promise<IPlanResult> => {
          let artifacts = await readAdmissionPlan(command.target.directory, false, apply);
          const pendingActionId = await store.getPendingPlanOperationId(artifacts.directory);
          if (['status', 'milestones', 'check-execution'].includes(command.kind))
            artifacts = await observeChange(artifacts, apply);
          if (command.kind === 'status')
            return { kind: 'status', result: describeCurrent(artifacts, pendingActionId) };
          if (command.kind === 'milestones' || command.kind === 'reconciliation')
            return readPlanPage(store, artifacts, command);
          if (command.kind === 'check-execution') {
            const status = describePlan(artifacts, pendingActionId);
            const execution = artifacts.coordination.execution;
            if (
              pendingActionId ||
              status.state === 'blocked' ||
              !execution ||
              execution.runtimeEpoch !== runtimeEpoch ||
              execution.revokedBy ||
              execution.action.id !== command.authorizationId ||
              execution.mode !== command.mode ||
              !canExecutePlanUnit(artifacts, command.milestoneId) ||
              !isSamePlanRevision(command.expected, artifacts.revision) ||
              !isSamePlanRevision(execution.revision, artifacts.revision)
            )
              conflict();
            return {
              kind: 'execution-check',
              result: { isAuthorized: true, authorization: execution! },
            };
          }
          const digest = hashPlanContent(
            JSON.stringify({
              ...command,
              target: { ...command.target, directory: artifacts.directory },
            }),
          );
          const previous = await store.getPlanOperation(command.action.id);
          if (previous) {
            if (previous.digest !== digest || previous.directory !== artifacts.directory)
              conflict();
            await apply(previous);
            artifacts = await readPlanArtifacts(command.target, roots, parseContract);
            const current = describeCurrent(
              artifacts,
              await store.getPendingPlanOperationId(artifacts.directory),
            );
            return command.kind === 'finalize' && current.isFinalized
              ? { kind: 'finalized', result: current, content: artifacts.milestones }
              : { kind: 'status', result: current };
          }
          if (pendingActionId || !isSamePlanRevision(command.expected, artifacts.revision))
            conflict();
          const coordination = structuredClone(artifacts.coordination);
          let milestones: string | null = null;
          let planSource: string | null = null;
          let needsReconciliation = false;
          if (command.kind === 'begin-revision') {
            const threadIds = [
              ...new Set([
                ...command.threadIds,
                ...(await store.getPlanThreads(artifacts.directory)),
              ]),
            ];
            if (threadIds.length > 32) conflict();
            Object.assign(
              coordination,
              beginPlanRevision(artifacts, {
                ...command,
                threadIds,
                ownerRuntimeEpoch: runtimeEpoch,
              }),
            );
          } else if (command.kind === 'revision-invoke') {
            const workflow = coordination.revision;
            if (
              !workflow ||
              workflow.id !== command.revisionId ||
              !workflow.checkpoint ||
              !['editing', 'reconciling', 'blocked'].includes(workflow.phase)
            )
              conflict();
            if (command.skill === 'jg-breakdown' && !describePlan(artifacts).isPlanApproved)
              conflict();
            workflow!.hasUncertainEffects ||= !isSamePlanRevision(
              workflow!.checkpoint!.revision,
              artifacts.revision,
            );
            workflow!.proposal = null;
            workflow!.phase = 'quiescing';
            workflow!.phaseActionId = command.action.id;
            workflow!.ownerRuntimeEpoch = runtimeEpoch;
            workflow!.checkpointActionId = randomUUID();
            workflow!.blockActionId = randomUUID();
            workflow!.threadIds = [
              ...new Set([
                ...workflow!.threadIds,
                ...(await store.getPlanThreads(artifacts.directory)),
              ]),
            ];
            if (workflow!.threadIds.length > 32) conflict();
            workflow!.controls = workflow!.threadIds.map((threadId) => ({
              threadId,
              interruptActionId: randomUUID(),
              closeActionId: randomUUID(),
            }));
            workflow!.reason = null;
            workflow!.invocation = { action: command.action, skill: command.skill };
          } else if (command.kind === 'complete') {
            const receipt = recordPlanCompletion(artifacts, command, completionWorktrees);
            coordination.completions.push(receipt);
            if (
              artifacts.milestones !== null &&
              artifacts.parsed.some((entry) => entry.id === command.milestoneId)
            ) {
              const drafts = artifacts.parsed.map((entry) => ({
                ...entry,
                id: entry.id ?? conflict(),
                contractDigest: entry.contractDigest ?? conflict(),
                matchedSourceId: null,
                status: entry.id === command.milestoneId ? ('done' as const) : entry.status,
              }));
              milestones = renderReconciledSequence(artifacts.milestones, drafts);
              coordination.baseline = refreshPlanBaseline(
                artifacts,
                milestones,
                artifacts.revision,
              );
            }
          } else if (command.kind === 'finalize') {
            if (!artifacts.conformance.sequence) invalid();
            if (artifacts.skillsBinding === 'stale') conflict();
            const workflow = coordination.revision;
            let finalized: { content: string | null; revision: typeof artifacts.revision } | null =
              null;
            if (workflow && workflow.phase !== 'finished') {
              if (!['editing', 'reconciling', 'awaiting-approval'].includes(workflow.phase))
                conflict();
              if ((await store.getPlanThreads(artifacts.directory)).length) conflict();
              if (!workflow.checkpoint?.isQuiescent) conflict();
              const proposal =
                workflow.proposal ?? proposeReconciliation(artifacts, command.action);
              if (
                proposal.inspectionHash !== artifacts.hashes.milestones ||
                !isSamePlanRevision(proposal.revision, artifacts.revision)
              )
                conflict();
              workflow.proposal = proposal;
              if (proposal.unmatchedSourceIds.length && !command.confirmation) {
                workflow.phase = 'reconciling';
                needsReconciliation = true;
              } else {
                let drafts = proposal.drafts;
                if (proposal.unmatchedSourceIds.length) {
                  if (command.confirmation!.proposalId !== proposal.id) conflict();
                  const confirmed = confirmReconciliation(
                    artifacts,
                    proposal,
                    command.action,
                    command.confirmation!.decisions,
                  );
                  drafts = confirmed.drafts;
                  coordination.correspondences.push(...confirmed.records);
                  proposal.confirmation = {
                    action: command.action,
                    decisions: command.confirmation!.decisions,
                  };
                } else if (command.confirmation) conflict();
                const content =
                  artifacts.milestones === null
                    ? null
                    : renderReconciledSequence(artifacts.milestones, drafts);
                const revision = computePlanRevision({
                  ...artifacts.contract,
                  milestones: content,
                });
                for (const record of coordination.correspondences)
                  if (record.action.id === command.action.id) record.revision = revision;
                finalized = { content, revision };
                workflow.phase = 'awaiting-approval';
                workflow.reason = null;
              }
            } else {
              if (command.confirmation) conflict();
              finalized = finalizeInitialSequence(artifacts);
            }
            if (finalized) {
              milestones = finalized.content;
              coordination.finalized = {
                action: command.action,
                revision: finalized.revision,
                fileHash: milestones === null ? null : hashPlanContent(milestones),
                createdAt: Date.now(),
              };
              coordination.baseline = refreshPlanBaseline(
                artifacts,
                milestones,
                finalized.revision,
              );
            }
          } else Object.assign(coordination, updatePlanAuthority(artifacts, command, runtimeEpoch));
          if (milestones !== null && Buffer.byteLength(milestones) > 1_048_576)
            throw new Exception('The HQ plan is invalid', {
              code: 'JG_AGENT_HQ_PLAN_INVALID',
              data: { kind: 'invalid-request' },
            });
          const progressed = {
            ...artifacts,
            coordination,
            parsed: milestones === null ? artifacts.parsed : parsePlanMilestones(milestones),
          };
          if (describePlan(progressed).state === 'completed')
            planSource = prepareAggregateProgress(artifacts.plan, 'done');
          else if (
            command.kind === 'complete' &&
            (command.milestoneId === null ||
              artifacts.parsed.some((entry) => entry.id === command.milestoneId))
          )
            planSource = prepareAggregateProgress(artifacts.plan, 'in progress');
          if (planSource !== null && coordination.baseline) coordination.baseline.plan = planSource;
          coordination.lastActionId = command.action.id;
          const intent = await prepareWrite({
            id: command.action.id,
            digest,
            directory: artifacts.directory,
            before: artifacts.hashes,
            coordination: serializePlanCoordination(coordination),
            plan: planSource,
            milestones:
              milestones === null || milestones === artifacts.milestones
                ? { operation: 'keep' }
                : { operation: 'write', source: milestones },
            state: 'prepared',
          });
          await apply(intent);
          artifacts = await readPlanArtifacts(command.target, roots, parseContract);
          await store.projectPlan({
            directory: artifacts.directory,
            sourceHash: artifacts.hashes.milestones,
            milestones: artifacts.parsed.map((milestone) => PlanMilestoneSchema.parse(milestone)),
          });
          if (needsReconciliation)
            return { kind: 'reconciliation-required', result: describeCurrent(artifacts) };
          return command.kind === 'finalize'
            ? {
                kind: 'finalized',
                result: describeCurrent(artifacts),
                content: artifacts.milestones,
              }
            : { kind: 'status', result: describeCurrent(artifacts) };
        }),
      );
      if (command.kind === 'begin-revision' || command.kind === 'revision-invoke') {
        const workflow = await this.stopPhase(command.target);
        if (
          workflow?.phase === 'quiescing' &&
          workflow.phaseActionId === command.action.id &&
          stopHandler
        ) {
          activeStopPhases.add(workflow.phaseActionId);
          try {
            stopHandler({
              kind: 'revision',
              directory: command.target.directory,
              revisionId: workflow.id,
              phaseActionId: workflow.phaseActionId,
              controls: workflow.controls,
            });
          } catch (cause) {
            activeStopPhases.delete(workflow.phaseActionId);
            throw cause;
          }
          return this.handle({ kind: 'status', target: command.target });
        }
      }
      return result;
    },
    /**
     * Records observed-change cleanup without creating operator authority or an editing lease.
     * @returns A promise resolved after the current observation is updated.
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
    async finishObservation(job: IPlanStopJob, isQuiescent: boolean): Promise<void> {
      await withHqLock(coordinationRoot, 'plan-observation-result', () =>
        withDocuments(job.directory, async (apply) => {
          const directory = await resolveWorkspaceTarget(job.directory, roots);
          if (await store.getPendingPlanOperationId(directory)) return;
          const text = await readPlanFile(directory, 'coordination.json', false, 8_388_608);
          const coordination = parsePlanCoordination(text);
          const observation = coordination.observedConflict;
          if (
            !observation ||
            observation.id !== job.revisionId ||
            observation.ownerRuntimeEpoch !== runtimeEpoch
          )
            return;
          observation.phase = isQuiescent ? 'quiescent' : 'blocked';
          const id = randomUUID();
          const intent = await prepareWrite({
            id,
            digest: hashPlanContent(JSON.stringify([observation.id, isQuiescent])),
            directory,
            before: { plan: null, milestones: null, coordination: hashPlanContent(text!) },
            coordination: serializePlanCoordination(coordination),
            plan: null,
            milestones: { operation: 'keep' },
            state: 'prepared',
          });
          await apply(intent);
        }),
      );
    },
    /**
     * Saves a checkpoint only after proven owned native/background shutdown.
     * @returns A promise resolved after the durable editing state is retained.
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
    async checkpoint(
      target: IPlanCommand['target'],
      revisionId: string,
      phaseActionId: string,
    ): Promise<void> {
      const selected = await readPlanArtifacts(target, roots, parseContract);
      const current = selected.coordination.revision;
      if (!current || current.id !== revisionId || current.phaseActionId !== phaseActionId)
        conflict();
      const proofs = await capturePlanWorktrees(current!.checkouts, roots);
      await withHqLock(coordinationRoot, 'plan-checkpoint', () =>
        withDocuments(target.directory, async (apply) => {
          const artifacts = await readPlanArtifacts(target, roots, parseContract);
          const workflow = artifacts.coordination.revision;
          if (!workflow || workflow.id !== revisionId || workflow.phaseActionId !== phaseActionId)
            conflict();
          let coordination;
          if (workflow!.checkpoint?.isQuiescent) {
            coordination = structuredClone(artifacts.coordination);
            coordination.revision!.phase = 'editing';
            coordination.revision!.reason = null;
          } else coordination = finishPlanCheckpoint(artifacts, revisionId, proofs);
          const actionId = workflow!.invocation?.action.id ?? workflow!.action.id;
          const id = workflow!.checkpointActionId;
          const prior = await store.getPlanOperation(id);
          if (prior) {
            await apply(prior);
            return;
          }
          const intent = await prepareWrite({
            id,
            digest: hashPlanContent(
              JSON.stringify([revisionId, actionId, 'checkpoint', artifacts.hashes]),
            ),
            directory: artifacts.directory,
            before: artifacts.hashes,
            coordination: serializePlanCoordination(coordination),
            plan: null,
            milestones: { operation: 'keep' },
            state: 'prepared',
          });
          await apply(intent);
        }),
      );
    },
  };
};
