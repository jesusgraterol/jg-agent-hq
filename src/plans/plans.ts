import { Exception } from 'error-message-utils';

import { PlanMilestoneSchema, type IPlanCommand, type IPlanResult } from '../contracts/index.js';
import { withHqLock } from '../locks/index.js';
import { decodeHistoryCursor, encodeHistoryCursor } from '../sessions/index.js';
import type { IStore } from '../store/index.js';

import { describePlan, updatePlanAuthority } from './authority.js';
import { finalizeInitialSequence } from './finalization.js';
import { readPlanArtifacts, readPlanFile, writePlanFile } from './files.js';
import { hashPlanContent, isSamePlanRevision } from './utilities.js';
import {
  PlanMilestonePositionSchema,
  type IPlanArtifacts,
  type IPlanWriteIntent,
} from './types.js';

const conflict = (): never => {
  throw new Exception('The HQ action conflicts with its recorded state', undefined, {
    kind: 'state-conflict',
  });
};

/**
 * Coordinates bounded selected-plan files under the existing metadata lock.
 * @returns A handler for plan records and projections; it never dispatches native input.
 */
export const createPlans = (stateRoot: string, roots: string[], store: IStore) => {
  /**
   * Replays only a recorded exact write or its unchanged baseline; external edits remain conflicts.
   * @returns A promise resolved after the authoritative files and derived ledger agree.
   * @throws
   * - -1: The HQ action conflicts with its recorded state
   * - -1: The HQ plan is invalid
   * - -1: The HQ plan operation failed
   * - -1: The HQ store failed
   */
  const apply = async (intent: IPlanWriteIntent): Promise<void> => {
    if (intent.state === 'completed') return;
    const [plan, milestones, coordination] = await Promise.all([
      readPlanFile(intent.directory, 'plan.md'),
      readPlanFile(intent.directory, 'milestones.md', true),
      readPlanFile(intent.directory, 'coordination.json', true),
    ]);
    const hash = (text: string | null) => (text === null ? null : hashPlanContent(text));
    if (hash(plan) !== intent.before.plan) conflict();
    if (
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
  return {
    /**
     * Reads or explicitly changes plan authority without approving native tools or starting execution.
     * @returns A bounded status/page, full finalized presentation, or exact authorization check.
     * @throws
     * - -1: The HQ target is outside the allowed workspaces
     * - -1: The HQ action conflicts with its recorded state
     * - -1: The HQ cursor does not match this request
     * - -1: The HQ plan is invalid
     * - -1: The HQ plan operation failed
     * - -1: The HQ store failed
     * - -1: The HQ lock acquisition arguments are invalid
     * - -1: The HQ lock requires Linux or macOS
     * - -1: The HQ runtime directory must be a real directory
     * - -1: The HQ runtime directory must be private and owned by the current user
     * - -1: The HQ lock must be a regular file
     * - -1: The HQ lock must be private and owned by the current user
     * - -1: The HQ lock owner exceeds the supported size
     * - -1: The HQ lock owner could not be read. Inspect .runtime/hq.lock
     * - -1: The HQ lock owner is incomplete. Inspect .runtime/hq.lock and remove it only after its owner stopped
     * - -1: The HQ lock has an inactive owner
     * - -1: The HQ lock owner could not be verified
     * - -1: Timed out waiting for the HQ lock
     * - -1: HQ lock ownership changed before release
     */
    async handle(command: IPlanCommand): Promise<IPlanResult> {
      return withHqLock(stateRoot, `plan-${command.kind}`, async () => {
        let artifacts = await readPlanArtifacts(command.target, roots);
        const pendingActionId = await store.getPendingPlanOperationId(artifacts.directory);
        if (command.kind === 'status')
          return { kind: 'status', result: describePlan(artifacts, pendingActionId) };
        if (command.kind === 'milestones') {
          const filters = {
            directory: artifacts.directory,
            context: command.target.context ?? null,
            limit: command.limit,
          };
          const decoded = decodeHistoryCursor(command.cursor, filters);
          let after = 0;
          if (decoded) {
            try {
              const position = PlanMilestonePositionSchema.parse(JSON.parse(decoded));
              if (
                !isSamePlanRevision(position.revision, artifacts.revision) ||
                position.inspection !== artifacts.hashes.milestones
              )
                conflict();
              after = position.ordinal;
            } catch (cause) {
              throw new Exception(
                'The HQ cursor does not match this request',
                undefined,
                { kind: 'invalid-request' },
                { cause },
              );
            }
          }
          await store.projectPlan({
            directory: artifacts.directory,
            sourceHash: artifacts.hashes.milestones,
            milestones: artifacts.parsed.map((milestone) => PlanMilestoneSchema.parse(milestone)),
          });
          const page = await store.listPlanMilestones({
            directory: artifacts.directory,
            limit: command.limit,
            after,
          });
          return {
            kind: 'milestones',
            result: {
              data: page.data,
              nextCursor: encodeHistoryCursor(
                page.hasMore
                  ? JSON.stringify({
                      ordinal: page.data.at(-1)!.ordinal,
                      inspection: artifacts.hashes.milestones,
                      revision: artifacts.revision,
                    })
                  : null,
                filters,
              ),
            },
          };
        }
        if (command.kind === 'check-execution') {
          const status = describePlan(artifacts, pendingActionId);
          const execution = artifacts.coordination.execution;
          if (
            pendingActionId ||
            status.state === 'blocked' ||
            !status.isSequenceApproved ||
            !execution ||
            execution.revokedBy ||
            execution.action.id !== command.authorizationId ||
            execution.mode !== command.mode ||
            !execution.milestoneIds.includes(command.milestoneId) ||
            !isSamePlanRevision(command.expected, artifacts.revision) ||
            !isSamePlanRevision(execution.revision, artifacts.revision) ||
            !artifacts.parsed.some(
              (milestone) => milestone.id === command.milestoneId && milestone.status !== 'done',
            )
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
          if (previous.digest !== digest || previous.directory !== artifacts.directory) conflict();
          await apply(previous);
          artifacts = await readPlanArtifacts(command.target, roots);
          const current = describePlan(
            artifacts,
            await store.getPendingPlanOperationId(artifacts.directory),
          );
          return command.kind === 'finalize' && current.isFinalized && artifacts.milestones !== null
            ? { kind: 'finalized', result: current, content: artifacts.milestones }
            : { kind: 'status', result: current };
        }
        if (pendingActionId || !isSamePlanRevision(command.expected, artifacts.revision))
          conflict();
        const coordination = structuredClone(artifacts.coordination);
        let milestones: string | null = null;
        if (command.kind === 'finalize') {
          const finalized = finalizeInitialSequence(artifacts, command.target);
          milestones = finalized.content;
          const revised = finalized.revision;
          coordination.finalized = {
            action: command.action,
            revision: revised,
            fileHash: hashPlanContent(milestones),
            createdAt: Date.now(),
          };
        } else Object.assign(coordination, updatePlanAuthority(artifacts, command));
        if (milestones !== null && Buffer.byteLength(milestones) > 1_048_576)
          throw new Exception('The HQ plan is invalid', undefined, { kind: 'invalid-request' });
        coordination.lastActionId = command.action.id;
        const intent = await store.preparePlanOperation({
          id: command.action.id,
          digest,
          directory: artifacts.directory,
          before: artifacts.hashes,
          coordination: `${JSON.stringify(coordination, null, 2)}\n`,
          milestones,
          state: 'prepared',
        });
        await apply(intent);
        artifacts = await readPlanArtifacts(command.target, roots);
        await store.projectPlan({
          directory: artifacts.directory,
          sourceHash: artifacts.hashes.milestones,
          milestones: artifacts.parsed.map((milestone) => PlanMilestoneSchema.parse(milestone)),
        });
        return command.kind === 'finalize'
          ? { kind: 'finalized', result: describePlan(artifacts), content: artifacts.milestones! }
          : { kind: 'status', result: describePlan(artifacts) };
      });
    },
  };
};
