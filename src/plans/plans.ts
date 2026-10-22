import { randomUUID } from 'node:crypto';
import { Exception, extractMessage } from 'jg-exception';

import {
  PlanMilestoneSchema,
  type IPlanCommand,
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
} from './files.js';
import { hashPlanContent, isSamePlanRevision, computePlanRevision } from './utilities.js';
import type {
  IPlanArtifacts,
  IPlanWriteIntent,
  IPlanContractParser,
  IPlanStopJob,
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
    translateError = true,
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
              observation = await retainUnavailable(directory, id, threadIds);
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
  const apply = async (intent: IPlanWriteIntent): Promise<void> => {
    if (intent.state === 'completed') return;
    const [plan, milestones, coordination] = await Promise.all([
      intent.before.plan === null ? null : readPlanFile(intent.directory, 'plan.md'),
      intent.before.plan === null ? null : readPlanFile(intent.directory, 'milestones.md', true),
      readPlanFile(intent.directory, 'coordination.json', true, 8_388_608),
    ]);
    const hash = (text: string | null) => (text === null ? null : hashPlanContent(text));
    if (intent.before.plan === null && intent.milestones !== null) conflict();
    if (intent.before.plan !== null && hash(plan) !== intent.before.plan) conflict();
    if (
      intent.before.plan !== null &&
      hash(milestones) !== intent.before.milestones &&
      (!intent.milestones || hash(milestones) !== hash(intent.milestones))
    )
      conflict();
    if (
      hash(coordination) !== intent.before.coordination &&
      hash(coordination) !== hash(intent.coordination)
    )
      conflict();
    if (intent.milestones !== null && milestones !== intent.milestones)
      await writePlanFile(intent.directory, 'milestones.md', intent.milestones);
    if (coordination !== intent.coordination)
      await writePlanFile(intent.directory, 'coordination.json', intent.coordination);
    await store.completePlanOperation(intent.id);
  };
  /** Retains a closed gate even when current contract framing cannot be parsed. */
  const retainUnavailable = async (selected: string, id: string, threadIds: string[]) => {
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
    const intent = await store.preparePlanOperation({
      id,
      digest: hashPlanContent(JSON.stringify(observation)),
      directory,
      before: { plan: null, milestones: null, coordination: hashPlanContent(text) },
      coordination: serializePlanCoordination(coordination),
      milestones: null,
      state: 'prepared',
    });
    await apply(intent);
    return observation;
  };
  /** Persists an observed external contract change before asking the runtime to stop its exact threads. */
  const observeChange = async (artifacts: IPlanArtifacts): Promise<IPlanArtifacts> => {
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
      const intent = await store.preparePlanOperation({
        id,
        digest: hashPlanContent(JSON.stringify(observedConflict)),
        directory: artifacts.directory,
        before: artifacts.hashes,
        coordination: serializePlanCoordination(next),
        milestones: null,
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
  const admission = createPlanAdmission(coordinationRoot, store, runtimeEpoch, async (directory) =>
    observeChange(await readAdmissionPlan(directory)),
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
      await withHqLock(coordinationRoot, 'plan-revision-blocked', async () => {
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
        const intent = await store.preparePlanOperation({
          id: workflow.blockActionId,
          digest: hashPlanContent(JSON.stringify([revisionId, phaseActionId, 'blocked'])),
          directory: artifacts.directory,
          before: artifacts.hashes,
          coordination: serializePlanCoordination(coordination),
          milestones: null,
          state: 'prepared',
        });
        await apply(intent);
      });
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
      const result = await withHqLock(
        coordinationRoot,
        `plan-${command.kind}`,
        async (): Promise<IPlanResult> => {
          let artifacts = await readAdmissionPlan(command.target.directory, false);
          const pendingActionId = await store.getPendingPlanOperationId(artifacts.directory);
          if (['status', 'milestones', 'check-execution'].includes(command.kind))
            artifacts = await observeChange(artifacts);
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
          coordination.lastActionId = command.action.id;
          const intent = await store.preparePlanOperation({
            id: command.action.id,
            digest,
            directory: artifacts.directory,
            before: artifacts.hashes,
            coordination: serializePlanCoordination(coordination),
            milestones,
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
        },
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
      await withHqLock(coordinationRoot, 'plan-observation-result', async () => {
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
        const intent = await store.preparePlanOperation({
          id,
          digest: hashPlanContent(JSON.stringify([observation.id, isQuiescent])),
          directory,
          before: { plan: null, milestones: null, coordination: hashPlanContent(text!) },
          coordination: serializePlanCoordination(coordination),
          milestones: null,
          state: 'prepared',
        });
        await apply(intent);
      });
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
      await withHqLock(coordinationRoot, 'plan-checkpoint', async () => {
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
        const intent = await store.preparePlanOperation({
          id,
          digest: hashPlanContent(
            JSON.stringify([revisionId, actionId, 'checkpoint', artifacts.hashes]),
          ),
          directory: artifacts.directory,
          before: artifacts.hashes,
          coordination: serializePlanCoordination(coordination),
          milestones: null,
          state: 'prepared',
        });
        await apply(intent);
      });
    },
  };
};
