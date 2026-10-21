import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { Exception, extractMessage } from 'jg-exception';
import { z } from 'zod';

import type { createActions } from '../actions/index.js';
import {
  HandoffPreviewSchema,
  type IHandoff,
  type IHandoffCommand,
  type IHandoffPhase,
  type IHandoffPreview,
  type IHandoffResult,
  type IHqResponse,
  type IManagedThread,
} from '../contracts/index.js';
import type { createPlans } from '../plans/index.js';
import { resolveWorkspaceTarget } from '../runtime/state/index.js';
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  type IHistoryRequest,
} from '../sessions/index.js';
import type { createSkills } from '../skills/index.js';
import type { IStore } from '../store/index.js';

import type { IHandoffRecord } from './types.js';
import { hashHandoff, handoffArguments, handoffDelivery } from './utilities.js';

const run = promisify(execFile);
const PositionSchema = z.strictObject({ createdAt: z.number().int(), id: z.uuid() });
const conflict = (): never => {
  throw new Exception('The HQ action conflicts with its recorded state', {
    code: 'JG_AGENT_HQ_ACTION_CONFLICT',
    data: {
      kind: 'state-conflict',
    },
  });
};

/**
 * Owns handoff preparation only; native actions, history and permissions retain their existing owners.
 * @returns The explicit handoff command handler.
 */
export const createHandoffs = (
  store: IStore,
  actions: ReturnType<typeof createActions>,
  skills: ReturnType<typeof createSkills>,
  plans: ReturnType<typeof createPlans>,
  readHistory: (command: IHistoryRequest) => Promise<IHqResponse>,
  roots: string[],
  runtimeEpoch: string,
) => {
  /**
   * Checks selected Git attribution without staging files or traversing history.
   * @returns Whether the selected commit is still HEAD; omitted attribution requires no Git read.
   * @throws
   * - JG_AGENT_HQ_HANDOFF_FAILED: The HQ handoff operation failed
   */
  const checkCommit = async (directory: string, expected: string | null): Promise<boolean> => {
    if (!expected) return true;
    try {
      const result = await run('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: directory,
        timeout: 5000,
        maxBuffer: 4096,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      return result.stdout.trim() === expected;
    } catch (cause) {
      throw new Exception(`The HQ handoff operation failed: ${extractMessage(cause)}`, {
        code: 'JG_AGENT_HQ_HANDOFF_FAILED',
        data: { kind: 'operation-failed' },
        cause,
      });
    }
  };
  /**
   * Reads and authorizes a selected record before exposing its retained evidence.
   * @returns The bounded persisted handoff.
   * @throws
   * - JG_AGENT_HQ_HANDOFF_UNAVAILABLE: The HQ handoff is unavailable
   * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  const selected = async (id: string): Promise<IHandoffRecord> => {
    const record = await store.getHandoff(id);
    if (!record)
      throw new Exception('The HQ handoff is unavailable', {
        code: 'JG_AGENT_HQ_HANDOFF_UNAVAILABLE',
        data: { kind: 'not-found' },
      });
    await resolveWorkspaceTarget(record.source.workspaceRoot, roots);
    return record;
  };
  /**
   * Resolves the original native creation receipt; discovery never creates another controller.
   * @returns The current control record, or null before creation admission.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  const target = async (record: IHandoffRecord): Promise<IManagedThread | null> => {
    const creation = await store.getAction(record.creation.id);
    return creation?.threadId ? store.getThread(creation.threadId) : null;
  };
  /**
   * Projects delivery from the action ledger, with no mirrored acknowledgement state.
   * @returns Selected findings and current native receipts, preserving the original reviewer identity.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  const show = async (record: IHandoffRecord): Promise<IHandoff> => {
    const [creation, reviewDispatch, feedbackDispatch] = await Promise.all([
      store.getAction(record.creation.id),
      store.getHandoffDispatch(record.id, 'review'),
      store.getHandoffDispatch(record.id, 'feedback'),
    ]);
    const reviewer = creation?.threadId ? await store.getThread(creation.threadId) : null;
    const reference = reviewDispatch?.destination;
    const [review, feedback] = await Promise.all([
      reviewDispatch ? store.getAction(reviewDispatch.action.id) : null,
      feedbackDispatch ? store.getAction(feedbackDispatch.action.id) : null,
    ]);
    return {
      id: record.id,
      purpose: record.purpose,
      source: record.source,
      targetProvider: record.source.provider === 'codex' ? 'claude' : 'codex',
      targetThreadId: reference?.threadId ?? reviewer?.id ?? null,
      targetNativeId: reference?.nativeId ?? reviewer?.nativeId ?? null,
      creation: handoffDelivery(creation),
      review: handoffDelivery(review),
      feedback: handoffDelivery(feedback),
      hasFindings: record.findings !== null,
      findings: record.findings,
      createdAt: record.createdAt,
    };
  };
  /**
   * Checks that feedback still concerns the selected repository and execution contracts.
   * @returns Whether source identity, selected commit and current contracts still match.
   * @throws
   * - JG_AGENT_HQ_HANDOFF_FAILED: The HQ handoff operation failed
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
   * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
   * - JG_AGENT_HQ_PLAN_FAILED: The HQ plan operation failed
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
  const isSourceCurrent = async (record: IHandoffRecord): Promise<boolean> => {
    const source = await store.getThread(record.source.threadId);
    if (
      !source ||
      source.nativeId !== record.source.nativeId ||
      source.provider !== record.source.provider ||
      source.workspaceRoot !== record.source.workspaceRoot
    )
      return false;
    const binding = await store.getThreadPlan(source.id);
    if (binding?.directory !== record.source.plan?.directory) return false;
    if (record.source.plan) {
      const status = await plans.handle({
        kind: 'status',
        target: { directory: record.source.plan.directory },
      });
      if (
        status.kind !== 'status' ||
        hashHandoff(status.result.revision) !== hashHandoff(record.source.plan.observedRevision)
      )
        return false;
    }
    return checkCommit(record.source.workspaceRoot, record.source.commit);
  };
  /**
   * Resolves native skill metadata and exact invocation text without sending it.
   * @returns A digest-bound preview with explicit unavailable states.
   * @throws
   * - JG_AGENT_HQ_HANDOFF_FAILED: The HQ handoff operation failed
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
   * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
   * - JG_AGENT_HQ_PLAN_FAILED: The HQ plan operation failed
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
  const preview = async (
    record: IHandoffRecord,
    phase: IHandoffPhase,
  ): Promise<IHandoffPreview> => {
    const reviewer = await target(record);
    const reference = (await store.getHandoffDispatch(record.id, 'review'))?.destination;
    const destination =
      phase === 'review' ? reviewer : await store.getThread(record.source.threadId);
    let state: IHandoffPreview['state'] = 'ready';
    let skillId: string | null = null;
    let text: string | null = null;
    if (!(await isSourceCurrent(record))) state = 'source-changed';
    else if (
      !reviewer?.nativeId ||
      (phase === 'review' && reference && reference.nativeId !== reviewer.nativeId) ||
      !destination?.nativeId ||
      destination.runtimeEpoch !== runtimeEpoch ||
      destination.ownership !== 'managed' ||
      ![
        'idle',
        'completed',
        'failed',
        'interrupted',
        'running',
        'waiting-input',
        'waiting-approval',
      ].includes(destination.state)
    )
      state = 'target-unavailable';
    else if (phase === 'feedback' && !record.findings) state = 'findings-unavailable';
    else {
      const name =
        phase === 'feedback'
          ? 'jg-feedback'
          : record.purpose === 'challenge'
            ? 'jg-challenge-session'
            : 'jg-review-session';
      const arguments_ = handoffArguments(
        record,
        phase,
        reference ?? { provider: reviewer.provider, nativeId: reviewer.nativeId },
      );
      if (arguments_.length > 16_384 || Buffer.byteLength(arguments_) > 16_384) conflict();
      const native = await skills.previewName(destination.id, name, arguments_);
      if (native.state !== 'ready' || !native.text || !native.skill)
        state = native.state === 'missing' ? 'missing-skill' : 'skill-unavailable';
      else {
        skillId = native.skill.id;
        text = native.text;
      }
    }
    const content = {
      handoffId: record.id,
      phase,
      state,
      targetThreadId: destination?.id ?? null,
      targetNativeId: destination?.nativeId ?? null,
      skillId,
      text,
    };
    return HandoffPreviewSchema.parse({ ...content, digest: hashHandoff(content) });
  };

  return {
    /**
     * Creates, previews, explicitly sends or collects one handoff without an automatic reply loop.
     * @returns A bounded handoff, native invocation preview or seek page.
     * @throws
     * - JG_AGENT_HQ_HANDOFF_UNAVAILABLE: The HQ handoff is unavailable
     * - JG_AGENT_HQ_HANDOFF_FAILED: The HQ handoff operation failed
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_SKILL_UNAVAILABLE: The HQ skill is unavailable
     * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
     * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
     * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
     * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE: The Claude history is unavailable
     * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
     * - JG_AGENT_HQ_PLAN_FAILED: The HQ plan operation failed
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
    async handle(command: IHandoffCommand): Promise<IHandoffResult> {
      if (command.kind === 'list') {
        const workspaceRoot = await resolveWorkspaceTarget(command.workspaceRoot, roots);
        const { cursor, ...filters } = { ...command, workspaceRoot };
        const continuation = decodeHistoryCursor(cursor, filters);
        let after: z.infer<typeof PositionSchema> | undefined;
        if (continuation) {
          let value: unknown;
          try {
            value = JSON.parse(continuation);
          } catch {
            throw new Exception('The HQ cursor does not match this request', {
              code: 'JG_AGENT_HQ_CURSOR_INVALID',
              data: {
                kind: 'invalid-request',
              },
            });
          }
          const parsed = PositionSchema.safeParse(value);
          if (!parsed.success)
            throw new Exception('The HQ cursor does not match this request', {
              code: 'JG_AGENT_HQ_CURSOR_INVALID',
              data: {
                kind: 'invalid-request',
              },
            });
          after = parsed.data;
        }
        const page = await store.listHandoffs({
          workspaceRoot,
          sourceThreadId: command.sourceThreadId,
          limit: command.limit,
          after,
        });
        const data = page.data;
        const last = page.data.at(-1);
        return {
          kind: 'page',
          data,
          nextCursor: encodeHistoryCursor(
            page.hasMore && last
              ? JSON.stringify({ createdAt: last.createdAt, id: last.id })
              : null,
            filters,
          ),
        };
      }
      if (command.kind === 'create') {
        const digest = hashHandoff(command);
        let record = await store.getHandoff(command.id);
        if (record && record.digest !== digest) conflict();
        if (!record) {
          if (command.runtimeEpoch !== runtimeEpoch) conflict();
          const source = await store.getThread(command.sourceThreadId);
          if (!source?.nativeId || source.ownership !== 'managed') conflict();
          const workspaceRoot = await resolveWorkspaceTarget(source!.workspaceRoot, roots);
          const history = await readHistory({
            kind: 'thread',
            provider: source!.provider,
            workspaceRoot,
            nativeId: source!.nativeId!,
          });
          if (history.kind !== 'thread' || history.result.historyState !== 'available') conflict();
          if (!(await checkCommit(workspaceRoot, command.commit))) conflict();
          const binding = await store.getThreadPlan(source!.id);
          if (binding) {
            const status = await plans.handle({
              kind: 'status',
              target: { directory: binding.directory },
            });
            if (status.kind !== 'status') return conflict();
            binding.observedRevision = status.result.revision;
          }
          record = await store.prepareHandoff({
            id: command.id,
            digest,
            purpose: command.purpose,
            source: {
              threadId: source!.id,
              provider: source!.provider,
              nativeId: source!.nativeId!,
              workspaceRoot,
              plan: binding,
              commit: command.commit,
            },
            creation: {
              id: randomUUID(),
              runtimeEpoch,
              command: {
                kind: 'thread-create',
                provider: source!.provider === 'codex' ? 'claude' : 'codex',
                workspaceRoot,
                name: `${command.purpose}-${source!.name}`.slice(0, 32).replace(/-+$/, ''),
              },
            },
            findings: null,
            createdAt: Date.now(),
          });
        }
        await resolveWorkspaceTarget(record.source.workspaceRoot, roots);
        await actions.submit(record.creation);
        return { kind: 'handoff', handoff: await show(record) };
      }
      let record = await selected(command.id);
      if (command.kind === 'show') return { kind: 'handoff', handoff: await show(record) };
      if (command.kind === 'preview')
        return { kind: 'preview', preview: await preview(record, command.phase) };
      if (command.kind === 'collect') {
        const dispatch = await store.getHandoffDispatch(record.id, 'review');
        const reviewer = dispatch?.destination;
        const receipt = dispatch ? await store.getAction(dispatch.action.id) : null;
        if (
          !reviewer?.nativeId ||
          receipt?.completion !== 'completed' ||
          receipt.nativeTurnId !== command.turnId
        )
          conflict();
        const history = await readHistory({
          kind: 'items',
          provider: reviewer!.provider,
          workspaceRoot: record.source.workspaceRoot,
          nativeId: reviewer!.nativeId!,
          turnId: command.turnId,
          cursor: command.cursor,
          limit: command.limit,
        });
        if (history.kind !== 'items') return conflict();
        const matches = history.result.data.filter(
          (item) => item.nativeId === command.itemId && item.turnId === command.turnId,
        );
        const item = matches[0];
        if (
          matches.length !== 1 ||
          !item ||
          item.kind !== 'agent-message' ||
          item.isTruncated ||
          !item.text.trim() ||
          Buffer.byteLength(item.text) > 8192
        )
          conflict();
        record = await store.collectHandoff(record.id, {
          turnId: command.turnId,
          itemId: command.itemId,
          text: item!.text,
          hash: hashHandoff(item!.text),
        });
        return { kind: 'handoff', handoff: await show(record) };
      }
      const saved = await store.getHandoffDispatch(record.id, command.phase);
      if (saved) {
        if (saved.previewDigest !== command.expectedPreviewDigest) conflict();
        await actions.submit(saved.action);
      } else {
        const current = await preview(record, command.phase);
        if (
          current.state !== 'ready' ||
          current.digest !== command.expectedPreviewDigest ||
          !current.targetThreadId ||
          !current.targetNativeId ||
          !current.skillId
        )
          conflict();
        const reviewer = await target(record);
        const destination = await store.getThread(current.targetThreadId!);
        if (!reviewer?.nativeId || !destination || destination.nativeId !== current.targetNativeId)
          conflict();
        const reference = (await store.getHandoffDispatch(record.id, 'review'))?.destination;
        const input = {
          kind: 'skill' as const,
          skillId: current.skillId!,
          arguments: handoffArguments(
            record,
            command.phase,
            reference ?? { provider: reviewer!.provider, nativeId: reviewer!.nativeId! },
          ),
        };
        const dispatch = await store.prepareHandoffDispatch({
          handoffId: record.id,
          phase: command.phase,
          previewDigest: current.digest,
          destination: {
            threadId: destination!.id,
            nativeId: destination!.nativeId!,
            provider: destination!.provider,
          },
          action: {
            id: randomUUID(),
            runtimeEpoch,
            ...(command.phase === 'feedback' ? { expectedPlan: record.source.plan } : {}),
            command: destination!.activeTurnId
              ? {
                  kind: 'queue',
                  threadId: destination!.id,
                  expectedTurnId: destination!.activeTurnId,
                  input,
                }
              : { kind: 'message', threadId: destination!.id, input },
          },
        });
        await actions.submit(dispatch.action);
      }
      return { kind: 'handoff', handoff: await show(record) };
    },
  };
};
