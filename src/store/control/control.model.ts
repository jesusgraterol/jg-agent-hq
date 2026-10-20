import { createHmac, createSecretKey, randomUUID, type KeyObject } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Exception } from 'error-message-utils';
import { z } from 'zod';

import {
  LifecycleEventSchema,
  type IActionReceipt,
  type IActionSummary,
  type IManagedThread,
  type ILifecycleEvent,
} from '../../contracts/index.js';
import { getErrorKind } from '../../errors/index.js';

import {
  ACTION_COLUMNS,
  ACTION_METADATA_COLUMNS,
  CONTROLLED_THREAD_CAPACITY,
  EVENT_COLUMNS,
  THREAD_COLUMNS,
} from './constants.js';
import { toActionReceipt, toActionSummary, toManagedThread } from './transformers.js';
import {
  ActionRowSchema,
  ThreadRowSchema,
  type IActionRow,
  type IThreadRow,
  type IAdmission,
  type IAdmissionResult,
  type IControlPage,
  type IEventPage,
  type INativeOutcome,
  type INativeObservation,
  type IObservationResult,
  type IDispatch,
  type IApprovalRecord,
} from './types.js';

const FailureSchema = z.object({
  kind: z.enum(['state-conflict', 'access-denied', 'agent-unavailable', 'operation-failed']),
});
const ActionMetadataSchema = ActionRowSchema.omit({ queued_text: true });

/** Owns synchronous control-ledger transactions inside the dedicated SQLite worker. */
export class ControlModel {
  private readonly __database: DatabaseSync;
  private readonly __epoch: string;
  private readonly __digestKey: KeyObject;

  /** Quarantines unsettled controls from another runtime before accepting new actions. */
  public constructor(database: DatabaseSync, runtimeEpoch: string, digestKey: Uint8Array) {
    this.__database = database;
    this.__epoch = runtimeEpoch;
    this.__digestKey = createSecretKey(digestKey);
    const now = Date.now();
    this.__transaction(() => {
      database
        .prepare(
          "UPDATE thread SET ownership = 'uncertain', state = 'unknown', updated_at = ? WHERE runtime_epoch IS NOT NULL AND runtime_epoch != ? AND ownership = 'managed'",
        )
        .run(now, runtimeEpoch);
      database
        .prepare(
          "UPDATE action SET delivery = 'uncertain', updated_at = ? WHERE runtime_epoch != ? AND delivery = 'submitted'",
        )
        .run(now, runtimeEpoch);
      database
        .prepare(
          "UPDATE action SET queue_ready = 0 WHERE runtime_epoch != ? AND delivery = 'queued'",
        )
        .run(runtimeEpoch);
      database
        .prepare(
          "UPDATE native_approval SET state = 'expired', updated_at = ? WHERE runtime_epoch != ? AND state = 'pending'",
        )
        .run(now, runtimeEpoch);
    });
  }

  /** Returns one receipt, including an undelivered queue body when present. */
  public getAction(id: string): IActionReceipt | null {
    const action = this.__action(id);
    return action ? toActionReceipt(action) : null;
  }

  /** Returns one control record by immutable identity. */
  public getThread(id: string): IManagedThread | null {
    const thread = this.__thread(id);
    return thread ? toManagedThread(thread) : null;
  }

  /** Resolves a registered native session without claiming it. */
  public getThreadByNativeId(
    provider: IManagedThread['provider'],
    nativeId: string,
  ): IManagedThread | null {
    const thread = this.__nativeThread(provider, nativeId);
    return thread ? toManagedThread(thread) : null;
  }

  /** Resolves one native discovery page in a single indexed worker operation. */
  public getNativeThreads(
    provider: IManagedThread['provider'],
    nativeIds: string[],
  ): IManagedThread[] {
    return this.__database
      .prepare(
        `SELECT ${THREAD_COLUMNS} FROM thread WHERE provider = ? AND native_id IN (SELECT json_each.value FROM json_each(?))`,
      )
      .all(provider, JSON.stringify(nativeIds))
      .map((row) => toManagedThread(ThreadRowSchema.parse(row)));
  }

  /** Reads a bounded descending creation/UUID seek page. */
  public listThreads(
    workspaceRoot: string,
    page: IControlPage,
  ): { data: IManagedThread[]; hasMore: boolean } {
    const seek = page.position ? 'AND (thread.created_at, thread.id) < (?, ?)' : '';
    const rows = this.__database
      .prepare(
        `SELECT ${THREAD_COLUMNS} FROM thread
      WHERE workspace_root = ? ${seek}
      ORDER BY thread.created_at DESC, thread.id DESC LIMIT ?`,
      )
      .all(
        workspaceRoot,
        ...(page.position ? [page.position.createdAt, page.position.id] : []),
        page.limit + 1,
      );
    return {
      data: rows.slice(0, page.limit).map((row) => toManagedThread(ThreadRowSchema.parse(row))),
      hasMore: rows.length > page.limit,
    };
  }

  /** Reads action metadata without selecting queued message bodies. */
  public listActions(
    threadId: string,
    page: IControlPage,
  ): { data: IActionSummary[]; hasMore: boolean } {
    const seek = page.position ? 'AND (action.created_at, action.id) < (?, ?)' : '';
    const rows = this.__database
      .prepare(
        `SELECT ${ACTION_METADATA_COLUMNS} FROM action
      WHERE thread_id = ? ${seek}
      ORDER BY action.created_at DESC, action.id DESC LIMIT ?`,
      )
      .all(
        threadId,
        ...(page.position ? [page.position.createdAt, page.position.id] : []),
        page.limit + 1,
      );
    return {
      data: rows
        .slice(0, page.limit)
        .map((row) => toActionSummary(ActionMetadataSchema.parse(row))),
      hasMore: rows.length > page.limit,
    };
  }

  /** Replays lifecycle metadata by sequence, never token or tool-output bodies. */
  public listEvents(page: IEventPage): { data: ILifecycleEvent[]; hasMore: boolean } {
    const rows = this.__database
      .prepare(
        `SELECT ${EVENT_COLUMNS} FROM event WHERE thread_id = ? AND sequence > ? ORDER BY event.sequence ASC LIMIT ?`,
      )
      .all(page.threadId, page.after, page.limit + 1);
    return {
      data: rows.slice(0, page.limit).map((row) =>
        LifecycleEventSchema.parse({
          sequence: row.sequence,
          runtimeEpoch: row.runtime_epoch,
          threadId: row.thread_id,
          actionId: row.action_id,
          nativeTurnId: row.native_turn_id,
          nativeItemId: row.native_item_id,
          kind: row.kind,
          createdAt: row.created_at,
        }),
      ),
      hasMore: rows.length > page.limit,
    };
  }

  /**
   * Admits a command exactly once before any native write, with all ownership checks atomic.
   * @returns The durable receipt and the one action permitted to dispatch.
   * @throws
   * - -1: The HQ action conflicts with its recorded state
   */
  public admit(input: IAdmission): IAdmissionResult {
    return this.__transaction(() => {
      const { action, prepared } = input;
      const digest = createHmac('sha256', this.__digestKey)
        .update(JSON.stringify(action))
        .digest('hex');
      const existing = this.__action(action.id);
      if (existing) {
        if (existing.digest !== digest) this.__conflict();
        return {
          receipt: toActionReceipt(existing),
          thread: existing.thread_id ? this.getThread(existing.thread_id) : null,
          isNew: false,
          dispatchActionId: null,
        };
      }
      if (action.runtimeEpoch !== this.__epoch) this.__conflict();
      const now = Date.now();
      const command = action.command;
      const expectedTurn = 'expectedTurnId' in command ? command.expectedTurnId : null;
      const nativeTurn = command.kind === 'queue' ? null : expectedTurn;
      const requestedName = 'name' in command ? command.name : null;
      this.__database
        .prepare(
          `INSERT INTO action (id, digest, requested_runtime_epoch, runtime_epoch, kind, delivery, expected_turn_id, native_turn_id, requested_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?)`,
        )
        .run(
          action.id,
          digest,
          action.runtimeEpoch,
          this.__epoch,
          command.kind,
          expectedTurn,
          nativeTurn,
          requestedName,
          now,
          now,
        );
      // rejected controls still belong in the known session's action history
      const targetId =
        'threadId' in command
          ? command.threadId
          : 'queuedActionId' in command
            ? this.__action(command.queuedActionId)?.thread_id
            : null;
      if (targetId && this.__thread(targetId))
        this.__database
          .prepare('UPDATE action SET thread_id = ? WHERE id = ?')
          .run(targetId, action.id);
      this.__database.exec('SAVEPOINT admission');
      let dispatchActionId: string | null = action.id;
      try {
        if (command.kind === 'thread-create' || command.kind === 'thread-adopt') {
          this.__availableSlot();
          this.__availableName(command.name, action.id, null);
          if (!prepared.workspaceRoot) this.__conflict();
          const nativeId = command.kind === 'thread-adopt' ? prepared.nativeId : null;
          if (command.kind === 'thread-adopt' && (!nativeId || nativeId !== command.nativeId))
            this.__conflict();
          if (nativeId && this.__nativeThread(command.provider, nativeId)) this.__conflict();
          const threadId = randomUUID();
          this.__database
            .prepare(
              `INSERT INTO thread (id, provider, native_id, name, workspace_root, ownership, runtime_epoch, pending_action_id, state, registration_action_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'managed', ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              threadId,
              command.provider,
              nativeId ?? null,
              command.name,
              prepared.workspaceRoot,
              this.__epoch,
              action.id,
              nativeId ? 'starting' : 'creating',
              action.id,
              now,
              now,
            );
          this.__database
            .prepare('UPDATE action SET thread_id = ?, native_request_id = ? WHERE id = ?')
            .run(threadId, `${action.id}:${nativeId ? 'resume' : 'create'}`, action.id);
        } else {
          let threadId: string;
          let queued: IActionRow | null = null;
          if (command.kind === 'queue-send' || command.kind === 'queue-cancel') {
            queued = this.__action(command.queuedActionId);
            if (
              !queued ||
              queued.kind !== 'queue' ||
              queued.delivery !== 'queued' ||
              !queued.thread_id
            )
              this.__conflict();
            threadId = queued.thread_id;
            this.__database
              .prepare('UPDATE action SET related_action_id = ? WHERE id = ?')
              .run(queued.id, action.id);
          } else threadId = command.threadId;
          const thread = this.__thread(threadId);
          if (!thread) this.__conflict();
          if (command.kind === 'queue-cancel') {
            this.__database
              .prepare(
                "UPDATE action SET delivery = 'canceled', queued_text = NULL, queue_ready = 0, updated_at = ? WHERE id = ?",
              )
              .run(now, queued!.id);
            this.__database
              .prepare("UPDATE action SET delivery = 'acknowledged' WHERE id = ?")
              .run(action.id);
            dispatchActionId = null;
          } else if (command.kind === 'thread-resume' || command.kind === 'thread-recover') {
            if (thread.pending_action_id && thread.runtime_epoch === this.__epoch)
              this.__conflict();
            if (command.kind === 'thread-resume') {
              if (
                thread.ownership !== 'managed' ||
                thread.state !== 'inactive' ||
                thread.runtime_epoch !== null ||
                !thread.native_id
              )
                this.__conflict();
            } else {
              if (thread.ownership !== 'uncertain' || thread.runtime_epoch === this.__epoch)
                this.__conflict();
              if (command.recovery.kind === 'create') {
                if (thread.native_id !== null) this.__conflict();
              } else if (command.recovery.kind === 'attach') {
                if (
                  thread.native_id !== null ||
                  !prepared.nativeId ||
                  prepared.nativeId !== command.recovery.nativeId
                )
                  this.__conflict();
                this.__database
                  .prepare('UPDATE thread SET native_id = ? WHERE id = ?')
                  .run(prepared.nativeId, threadId);
              } else if (!thread.native_id) this.__conflict();
            }
            this.__availableSlot();
            const creating =
              command.kind === 'thread-recover' && command.recovery.kind === 'create';
            this.__database
              .prepare(
                "UPDATE thread SET ownership = 'managed', runtime_epoch = ?, pending_action_id = ?, active_turn_id = NULL, state = ?, updated_at = ? WHERE id = ?",
              )
              .run(this.__epoch, action.id, creating ? 'creating' : 'starting', now, threadId);
            this.__database
              .prepare('UPDATE action SET native_request_id = ?, requested_name = ? WHERE id = ?')
              .run(
                `${action.id}:${creating ? 'create' : 'resume'}`,
                creating ? thread.name : null,
                action.id,
              );
          } else {
            if (command.kind === 'interrupt') {
              if (thread.runtime_epoch !== this.__epoch || !thread.native_id) this.__conflict();
            } else this.__requireOwned(thread);
            switch (command.kind) {
              case 'thread-rename':
                if (thread.pending_action_id) this.__conflict();
                this.__availableName(command.name, action.id, thread.id);
                this.__database
                  .prepare('UPDATE thread SET pending_action_id = ? WHERE id = ?')
                  .run(action.id, threadId);
                this.__database
                  .prepare('UPDATE action SET native_request_id = ? WHERE id = ?')
                  .run(`${action.id}:name`, action.id);
                break;
              case 'thread-close':
                this.__requireIdle(thread);
                this.__database
                  .prepare(
                    "UPDATE thread SET pending_action_id = ?, state = 'stopping', updated_at = ? WHERE id = ?",
                  )
                  .run(action.id, now, threadId);
                this.__database
                  .prepare(
                    "UPDATE action SET queue_ready = 0 WHERE thread_id = ? AND delivery = 'queued'",
                  )
                  .run(threadId);
                this.__database
                  .prepare('UPDATE action SET native_request_id = ? WHERE id = ?')
                  .run(`${action.id}:clean`, action.id);
                break;
              case 'message':
                this.__requireIdle(thread);
                this.__beginTurn(action.id, threadId);
                break;
              case 'queue':
                this.__requireTurn(thread, command.expectedTurnId);
                this.__database
                  .prepare("UPDATE action SET delivery = 'queued', queued_text = ? WHERE id = ?")
                  .run(command.text, action.id);
                dispatchActionId = null;
                break;
              case 'queue-send':
                this.__requireIdle(thread);
                this.__beginTurn(queued!.id, threadId);
                this.__database
                  .prepare("UPDATE action SET delivery = 'acknowledged' WHERE id = ?")
                  .run(action.id);
                dispatchActionId = queued!.id;
                break;
              case 'steer':
                this.__requireTurn(thread, command.expectedTurnId);
                this.__database
                  .prepare('UPDATE action SET native_request_id = ? WHERE id = ?')
                  .run(`${action.id}:steer`, action.id);
                break;
              case 'interrupt':
                this.__requireTurn(thread, command.expectedTurnId);
                this.__database
                  .prepare("UPDATE thread SET state = 'stopping', updated_at = ? WHERE id = ?")
                  .run(now, threadId);
                this.__database
                  .prepare(
                    "UPDATE action SET queue_ready = 0 WHERE thread_id = ? AND delivery = 'queued'",
                  )
                  .run(threadId);
                this.__database
                  .prepare('UPDATE action SET native_request_id = ? WHERE id = ?')
                  .run(`${action.id}:interrupt`, action.id);
                break;
              case 'native-reply': {
                this.__requireTurn(thread, command.expectedTurnId);
                const approval = this.__database
                  .prepare(
                    "SELECT id FROM native_approval WHERE id = ? AND thread_id = ? AND native_turn_id = ? AND runtime_epoch = ? AND state = 'pending' AND reply_action_id IS NULL",
                  )
                  .get(command.approvalId, threadId, command.expectedTurnId, this.__epoch);
                if (!approval) this.__conflict();
                this.__database
                  .prepare(
                    'UPDATE native_approval SET reply_action_id = ?, updated_at = ? WHERE id = ?',
                  )
                  .run(action.id, now, command.approvalId);
                this.__database
                  .prepare('UPDATE action SET native_request_id = ? WHERE id = ?')
                  .run(`${action.id}:reply`, action.id);
                break;
              }
            }
          }
        }
        this.__database.exec('RELEASE admission');
      } catch (error) {
        this.__database.exec('ROLLBACK TO admission');
        this.__database.exec('RELEASE admission');
        const metadata = FailureSchema.safeParse({ kind: getErrorKind(error) });
        this.__database
          .prepare(
            "UPDATE action SET delivery = 'failed', failure = ?, updated_at = ? WHERE id = ?",
          )
          .run(metadata.success ? metadata.data.kind : 'operation-failed', now, action.id);
        dispatchActionId = null;
      }
      const saved = this.__action(action.id)!;
      this.__event('action-admitted', saved.thread_id, saved.id, saved.native_turn_id);
      return {
        receipt: toActionReceipt(saved),
        thread: saved.thread_id ? this.getThread(saved.thread_id) : null,
        isNew: true,
        dispatchActionId,
      };
    });
  }

  /**
   * Applies an exact native request outcome without downgrading a known acknowledgement.
   * @returns The current receipt, or null for an unrecognized/stale response.
   * @throws
   * - -1: The HQ action conflicts with its recorded state
   */
  public applyOutcome(outcome: INativeOutcome): IActionReceipt | null {
    return this.__transaction(() => {
      const action = this.__action(outcome.actionId);
      if (
        !action ||
        action.runtime_epoch !== this.__epoch ||
        action.native_request_id !== outcome.requestId
      )
        return action ? toActionReceipt(action) : null;
      if (['acknowledged', 'failed', 'canceled'].includes(action.delivery))
        return toActionReceipt(action);
      const thread = action.thread_id ? this.__thread(action.thread_id) : null;
      const ownsThread = thread?.runtime_epoch === this.__epoch && thread.ownership === 'managed';
      const now = Date.now();
      if (outcome.kind === 'created') {
        if (
          !thread ||
          !ownsThread ||
          thread.pending_action_id !== action.id ||
          (thread.native_id !== null && thread.native_id !== outcome.nativeId)
        )
          this.__conflict();
        this.__database
          .prepare(
            "UPDATE thread SET native_id = ?, state = 'creating', updated_at = ? WHERE id = ?",
          )
          .run(outcome.nativeId, now, thread.id);
        this.__database
          .prepare(
            "UPDATE action SET delivery = 'submitted', native_request_id = ?, updated_at = ? WHERE id = ?",
          )
          .run(`${action.id}:name`, now, action.id);
      } else if (outcome.kind === 'cleaned') {
        if (!ownsThread || thread.pending_action_id !== action.id) this.__conflict();
        this.__database
          .prepare('UPDATE action SET native_request_id = ?, updated_at = ? WHERE id = ?')
          .run(`${action.id}:close`, now, action.id);
      } else if (outcome.kind === 'uncertain' || outcome.kind === 'failed') {
        this.__database
          .prepare('UPDATE action SET delivery = ?, failure = ?, updated_at = ? WHERE id = ?')
          .run(outcome.kind, outcome.kind === 'failed' ? outcome.failure : null, now, action.id);
        if (ownsThread && thread.pending_action_id === action.id) {
          if (action.kind === 'thread-rename' && outcome.kind === 'failed')
            this.__database
              .prepare('UPDATE thread SET pending_action_id = NULL, updated_at = ? WHERE id = ?')
              .run(now, thread.id);
          else if (action.kind !== 'thread-rename')
            this.__database
              .prepare("UPDATE thread SET state = 'unknown', updated_at = ? WHERE id = ?")
              .run(now, thread.id);
        }
      } else if (outcome.kind === 'reply-written') {
        // a successful pipe write is not a native resolution acknowledgement
      } else {
        let nativeTurnId = action.native_turn_id;
        if (outcome.kind === 'turn-accepted' || outcome.kind === 'steer-accepted')
          nativeTurnId = outcome.nativeTurnId;
        if (outcome.kind === 'steer-accepted' && outcome.nativeTurnId !== action.expected_turn_id)
          this.__conflict();
        const completion =
          thread?.last_turn_id === nativeTurnId ? thread.last_turn_state : action.completion;
        this.__database
          .prepare(
            "UPDATE action SET delivery = 'acknowledged', native_turn_id = ?, completion = ?, failure = NULL, queued_text = NULL, updated_at = ? WHERE id = ?",
          )
          .run(nativeTurnId, completion, now, action.id);
        if (ownsThread) {
          if (outcome.kind === 'closed')
            this.__database
              .prepare(
                "UPDATE thread SET runtime_epoch = NULL, pending_action_id = NULL, active_turn_id = NULL, state = 'inactive', updated_at = ? WHERE id = ? AND pending_action_id = ?",
              )
              .run(now, thread.id, action.id);
          else if (outcome.kind === 'resumed')
            this.__database
              .prepare(
                'UPDATE thread SET pending_action_id = NULL, ownership = ?, state = ?, updated_at = ? WHERE id = ? AND pending_action_id = ?',
              )
              .run(
                outcome.nativeState === 'idle' ? 'managed' : 'uncertain',
                outcome.nativeState === 'idle' ? 'idle' : 'unknown',
                now,
                thread.id,
                action.id,
              );
          else if (outcome.kind === 'renamed') {
            if (!action.requested_name) this.__conflict();
            this.__database
              .prepare(
                'UPDATE thread SET name = ?, pending_action_id = NULL, state = ?, updated_at = ? WHERE id = ? AND pending_action_id = ?',
              )
              .run(
                action.requested_name,
                thread.state === 'creating' ? 'idle' : thread.state,
                now,
                thread.id,
                action.id,
              );
          } else if (outcome.kind === 'turn-accepted' && thread.pending_action_id === action.id) {
            const finished =
              thread.last_turn_id === nativeTurnId && thread.last_turn_state !== null;
            const active = finished ? null : (thread.active_turn_id ?? nativeTurnId);
            const state = finished
              ? thread.last_turn_state!
              : ['stopping', 'waiting-input', 'waiting-approval'].includes(thread.state)
                ? thread.state
                : 'running';
            this.__database
              .prepare(
                'UPDATE thread SET pending_action_id = NULL, active_turn_id = ?, state = ?, updated_at = ? WHERE id = ?',
              )
              .run(active, state, now, thread.id);
          }
        }
      }
      this.__event('action-updated', action.thread_id, action.id, action.native_turn_id);
      return this.getAction(action.id);
    });
  }

  /**
   * Claims one ready queue entry once; an explicit selection may release a paused entry.
   * @returns The single dispatch payload, or null when the queue cannot advance safely.
   */
  public claimQueued(threadId: string): IDispatch | null {
    return this.__transaction(() => {
      const thread = this.__thread(threadId);
      if (
        !thread ||
        thread.ownership !== 'managed' ||
        thread.runtime_epoch !== this.__epoch ||
        thread.active_turn_id ||
        thread.pending_action_id ||
        thread.state !== 'completed'
      )
        return null;
      const row = this.__database
        .prepare(
          `SELECT ${ACTION_COLUMNS} FROM action WHERE thread_id = ? AND delivery = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1`,
        )
        .get(threadId);
      if (!row) return null;
      const queued = ActionRowSchema.parse(row);
      if (
        !queued.queue_ready ||
        queued.runtime_epoch !== this.__epoch ||
        queued.queued_text === null
      )
        return null;
      this.__beginTurn(queued.id, threadId);
      this.__event('action-updated', threadId, queued.id);
      return {
        receipt: this.getAction(queued.id)!,
        thread: this.getThread(threadId)!,
        text: queued.queued_text,
      };
    });
  }

  /**
   * Records only native approval identities; question text and answers stay out of SQLite.
   * @returns The stable prompt identity when its current turn is controlled here.
   * @throws
   * - -1: The HQ action conflicts with its recorded state
   */
  public openApproval(approval: IApprovalRecord): { id: string; thread: IManagedThread } | null {
    return this.__transaction(() => {
      const thread = this.__nativeThread(approval.provider, approval.nativeThreadId);
      if (
        !thread ||
        thread.ownership !== 'managed' ||
        thread.runtime_epoch !== this.__epoch ||
        thread.active_turn_id !== approval.nativeTurnId
      )
        return null;
      const existing = this.__database
        .prepare(
          'SELECT id, thread_id, native_turn_id, digest, state FROM native_approval WHERE runtime_epoch = ? AND native_request_id = ?',
        )
        .get(this.__epoch, approval.requestId);
      if (existing) {
        if (
          existing.thread_id !== thread.id ||
          existing.native_turn_id !== approval.nativeTurnId ||
          existing.digest !== approval.digest
        )
          this.__conflict();
        return existing.state === 'pending'
          ? { id: z.uuid().parse(existing.id), thread: toManagedThread(thread) }
          : null;
      }
      const pending = this.__database
        .prepare(
          "SELECT id FROM native_approval WHERE runtime_epoch = ? AND state = 'pending' LIMIT 32",
        )
        .all(this.__epoch);
      if (pending.length >= 32) this.__conflict();
      const now = Date.now();
      this.__database
        .prepare(
          "INSERT INTO native_approval (id, thread_id, native_turn_id, runtime_epoch, native_request_id, digest, kind, is_blocking, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
        )
        .run(
          approval.id,
          thread.id,
          approval.nativeTurnId,
          this.__epoch,
          approval.requestId,
          approval.digest,
          approval.kind,
          approval.isBlocking ? 1 : 0,
          now,
          now,
        );
      if (approval.isBlocking && thread.state !== 'stopping')
        this.__database
          .prepare('UPDATE thread SET state = ?, updated_at = ? WHERE id = ?')
          .run(approval.kind === 'question' ? 'waiting-input' : 'waiting-approval', now, thread.id);
      this.__event('approval-opened', thread.id, null, approval.nativeTurnId);
      return { id: approval.id, thread: this.getThread(thread.id)! };
    });
  }

  /**
   * Applies ordered native lifecycle evidence and deduplicates repeated observations.
   * @returns The refreshed thread and whether its next-turn queue may advance.
   * @throws
   * - -1: The HQ action conflicts with its recorded state
   */
  public observe(observation: INativeObservation): IObservationResult {
    return this.__transaction(() => {
      const now = Date.now();
      if (observation.kind === 'native-unavailable') {
        const affected = this.__database
          .prepare(
            'SELECT id FROM thread WHERE runtime_epoch = ? AND provider = ? AND (? IS NULL OR native_id = ?) LIMIT ?',
          )
          .all(
            this.__epoch,
            observation.provider,
            observation.nativeThreadId ?? null,
            observation.nativeThreadId ?? null,
            CONTROLLED_THREAD_CAPACITY,
          );
        for (const row of affected) {
          const id = z.uuid().parse(row.id);
          this.__database
            .prepare(
              "UPDATE thread SET ownership = 'uncertain', state = 'unknown', updated_at = ? WHERE id = ?",
            )
            .run(now, id);
          this.__database
            .prepare(
              "UPDATE action SET delivery = 'uncertain', updated_at = ? WHERE thread_id = ? AND delivery = 'submitted'",
            )
            .run(now, id);
          this.__database
            .prepare(
              "UPDATE action SET queue_ready = 0 WHERE thread_id = ? AND delivery = 'queued'",
            )
            .run(id);
          this.__database
            .prepare(
              "UPDATE native_approval SET state = 'expired', updated_at = ? WHERE thread_id = ? AND state = 'pending'",
            )
            .run(now, id);
          this.__event('native-unavailable', id, null);
        }
        return { thread: null, canDispatchQueued: false };
      }
      const thread = this.__nativeThread(observation.provider, observation.nativeThreadId);
      if (!thread || thread.runtime_epoch !== this.__epoch)
        return { thread: null, canDispatchQueued: false };
      const tuple = [
        observation.provider,
        observation.kind,
        observation.nativeThreadId,
        'nativeTurnId' in observation ? observation.nativeTurnId : null,
        'nativeItemId' in observation ? observation.nativeItemId : null,
        'requestId' in observation ? observation.requestId : null,
        'name' in observation ? observation.name : null,
      ];
      const key = createHmac('sha256', this.__digestKey)
        .update(JSON.stringify(tuple))
        .digest('hex');
      const digest = createHmac('sha256', this.__digestKey)
        .update(JSON.stringify(observation))
        .digest('hex');
      const prior = this.__database
        .prepare('SELECT digest FROM event WHERE runtime_epoch = ? AND event_key = ?')
        .get(this.__epoch, key);
      if (prior) {
        if (prior.digest !== digest) this.__conflict();
        return { thread: toManagedThread(thread), canDispatchQueued: false };
      }
      const turnId = 'nativeTurnId' in observation ? observation.nativeTurnId : null;
      let eventKind: ILifecycleEvent['kind'] = 'thread-updated';
      if (observation.kind === 'turn-started') {
        const unexpected =
          thread.active_turn_id !== null && thread.active_turn_id !== observation.nativeTurnId;
        this.__database
          .prepare(
            'UPDATE thread SET active_turn_id = ?, state = ?, ownership = ?, updated_at = ? WHERE id = ?',
          )
          .run(
            observation.nativeTurnId,
            unexpected || thread.ownership === 'uncertain'
              ? 'unknown'
              : thread.state === 'stopping'
                ? 'stopping'
                : 'running',
            unexpected ? 'uncertain' : thread.ownership,
            now,
            thread.id,
          );
      } else if (observation.kind === 'turn-completed') {
        this.__database
          .prepare(
            'UPDATE action SET completion = ?, updated_at = ? WHERE thread_id = ? AND native_turn_id = ?',
          )
          .run(observation.state, now, thread.id, observation.nativeTurnId);
        this.__database
          .prepare(
            "UPDATE action SET delivery = 'uncertain', updated_at = ? WHERE delivery = 'submitted' AND id IN (SELECT reply_action_id FROM native_approval WHERE thread_id = ? AND native_turn_id = ? AND state = 'pending')",
          )
          .run(now, thread.id, observation.nativeTurnId);
        this.__database
          .prepare(
            "UPDATE native_approval SET state = 'expired', updated_at = ? WHERE thread_id = ? AND native_turn_id = ? AND state = 'pending'",
          )
          .run(now, thread.id, observation.nativeTurnId);
        if (thread.active_turn_id === observation.nativeTurnId) {
          const mayAdvance =
            observation.state === 'completed' &&
            thread.state !== 'stopping' &&
            thread.ownership === 'managed';
          this.__database
            .prepare(
              'UPDATE thread SET active_turn_id = NULL, last_turn_id = ?, last_turn_state = ?, state = ?, updated_at = ? WHERE id = ?',
            )
            .run(
              observation.nativeTurnId,
              observation.state,
              thread.ownership === 'uncertain' ? 'unknown' : observation.state,
              now,
              thread.id,
            );
          if (mayAdvance)
            this.__database
              .prepare(
                "UPDATE action SET queue_ready = 1 WHERE thread_id = ? AND expected_turn_id = ? AND delivery = 'queued' AND runtime_epoch = ?",
              )
              .run(thread.id, observation.nativeTurnId, this.__epoch);
          else
            this.__database
              .prepare(
                "UPDATE action SET queue_ready = 0 WHERE thread_id = ? AND delivery = 'queued'",
              )
              .run(thread.id);
        }
      } else if (observation.kind === 'request-canceled') {
        const approval = this.__database
          .prepare(
            "SELECT reply_action_id FROM native_approval WHERE thread_id = ? AND runtime_epoch = ? AND native_request_id = ? AND state = 'pending'",
          )
          .get(thread.id, this.__epoch, observation.requestId);
        if (approval) {
          this.__database
            .prepare(
              "UPDATE native_approval SET state = 'expired', updated_at = ? WHERE thread_id = ? AND runtime_epoch = ? AND native_request_id = ? AND state = 'pending'",
            )
            .run(now, thread.id, this.__epoch, observation.requestId);
          if (approval.reply_action_id)
            this.__database
              .prepare(
                "UPDATE action SET delivery = 'uncertain', updated_at = ? WHERE id = ? AND delivery = 'submitted'",
              )
              .run(now, z.uuid().parse(approval.reply_action_id));
          this.__refreshApprovalState(thread, now);
        }
        eventKind = 'approval-resolved';
      } else if (observation.kind === 'request-resolved') {
        const approval = this.__database
          .prepare(
            "SELECT id, native_turn_id, reply_action_id FROM native_approval WHERE thread_id = ? AND runtime_epoch = ? AND native_request_id = ? AND state = 'pending'",
          )
          .get(thread.id, this.__epoch, observation.requestId);
        if (approval) {
          const replyId = z.uuid().nullable().parse(approval.reply_action_id);
          this.__database
            .prepare('UPDATE native_approval SET state = ?, updated_at = ? WHERE id = ?')
            .run(replyId ? 'answered' : 'expired', now, z.uuid().parse(approval.id));
          if (replyId)
            this.__database
              .prepare(
                "UPDATE action SET delivery = 'acknowledged', failure = NULL, updated_at = ? WHERE id = ? AND delivery IN ('submitted', 'uncertain')",
              )
              .run(now, replyId);
          this.__refreshApprovalState(thread, now);
        }
        eventKind = 'approval-resolved';
      } else if (observation.kind === 'item-started' || observation.kind === 'item-completed')
        eventKind = observation.kind;
      this.__database
        .prepare(
          'INSERT INTO event (runtime_epoch, thread_id, action_id, native_turn_id, native_item_id, kind, event_key, digest, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          this.__epoch,
          thread.id,
          turnId,
          'nativeItemId' in observation ? observation.nativeItemId : null,
          eventKind,
          key,
          digest,
          now,
        );
      const current = this.__thread(thread.id)!;
      return {
        thread: toManagedThread(current),
        canDispatchQueued:
          current.ownership === 'managed' &&
          current.state === 'completed' &&
          current.active_turn_id === null &&
          current.pending_action_id === null,
      };
    });
  }

  /** Marks controls inactive only after its caller has proven native shutdown. */
  public releaseControls(): void {
    this.__transaction(() => {
      const now = Date.now();
      this.__database
        .prepare(
          "UPDATE thread SET runtime_epoch = NULL, pending_action_id = NULL, active_turn_id = NULL, ownership = CASE WHEN native_id IS NULL THEN 'uncertain' ELSE 'managed' END, state = CASE WHEN native_id IS NULL THEN 'unknown' ELSE 'inactive' END, updated_at = ? WHERE runtime_epoch = ?",
        )
        .run(now, this.__epoch);
      this.__database
        .prepare(
          "UPDATE action SET delivery = 'uncertain', updated_at = ? WHERE runtime_epoch = ? AND delivery = 'submitted'",
        )
        .run(now, this.__epoch);
      this.__database
        .prepare(
          "UPDATE action SET queue_ready = 0 WHERE runtime_epoch = ? AND delivery = 'queued'",
        )
        .run(this.__epoch);
      this.__database
        .prepare(
          "UPDATE native_approval SET state = 'expired', updated_at = ? WHERE runtime_epoch = ? AND state = 'pending'",
        )
        .run(now, this.__epoch);
    });
  }

  private __thread(id: string): IThreadRow | null {
    const row = this.__database
      .prepare(`SELECT ${THREAD_COLUMNS} FROM thread WHERE id = ?`)
      .get(id);
    return row ? ThreadRowSchema.parse(row) : null;
  }

  /** Recomputes the visible wait state after one of several native prompts ends. */
  private __refreshApprovalState(thread: IThreadRow, now: number): void {
    if (!thread.active_turn_id || thread.state === 'stopping' || thread.ownership !== 'managed')
      return;
    const remaining = this.__database
      .prepare(
        "SELECT kind FROM native_approval WHERE thread_id = ? AND native_turn_id = ? AND state = 'pending' AND is_blocking = 1 LIMIT 1",
      )
      .get(thread.id, thread.active_turn_id);
    this.__database
      .prepare('UPDATE thread SET state = ?, updated_at = ? WHERE id = ?')
      .run(
        remaining
          ? remaining.kind === 'question'
            ? 'waiting-input'
            : 'waiting-approval'
          : 'running',
        now,
        thread.id,
      );
  }

  private __action(id: string): IActionRow | null {
    const row = this.__database
      .prepare(`SELECT ${ACTION_COLUMNS} FROM action WHERE id = ?`)
      .get(id);
    return row ? ActionRowSchema.parse(row) : null;
  }

  private __nativeThread(
    provider: IManagedThread['provider'],
    nativeId: string,
  ): IThreadRow | null {
    const row = this.__database
      .prepare(`SELECT ${THREAD_COLUMNS} FROM thread WHERE provider = ? AND native_id = ?`)
      .get(provider, nativeId);
    return row ? ThreadRowSchema.parse(row) : null;
  }

  private __availableSlot(): void {
    const owners = this.__database
      .prepare('SELECT id FROM thread WHERE runtime_epoch = ? LIMIT ?')
      .all(this.__epoch, CONTROLLED_THREAD_CAPACITY);
    if (owners.length >= CONTROLLED_THREAD_CAPACITY) this.__conflict();
  }

  private __availableName(name: string, actionId: string, threadId: string | null): void {
    const assigned = this.__database
      .prepare(
        'SELECT id FROM thread WHERE name = ? COLLATE NOCASE AND (? IS NULL OR id != ?) LIMIT 1',
      )
      .get(name, threadId, threadId);
    const reserved = this.__database
      .prepare(
        "SELECT action.id FROM action INNER JOIN thread ON thread.pending_action_id = action.id WHERE action.requested_name = ? AND action.delivery IN ('submitted', 'uncertain') AND action.id != ? LIMIT 1",
      )
      .get(name, actionId);
    if (assigned || reserved) this.__conflict();
  }

  private __requireOwned(thread: IThreadRow): void {
    if (
      thread.ownership !== 'managed' ||
      thread.runtime_epoch !== this.__epoch ||
      !thread.native_id
    )
      this.__conflict();
  }

  private __requireIdle(thread: IThreadRow): void {
    if (
      thread.active_turn_id ||
      thread.pending_action_id ||
      !['idle', 'completed', 'failed', 'interrupted'].includes(thread.state)
    )
      this.__conflict();
  }

  private __requireTurn(thread: IThreadRow, expectedTurnId: string): void {
    if (thread.active_turn_id !== expectedTurnId) this.__conflict();
  }

  private __beginTurn(actionId: string, threadId: string): void {
    const now = Date.now();
    this.__database
      .prepare(
        "UPDATE action SET delivery = 'submitted', runtime_epoch = ?, native_turn_id = NULL, completion = NULL, native_request_id = ?, queue_ready = 0, updated_at = ? WHERE id = ?",
      )
      .run(this.__epoch, `${actionId}:turn`, now, actionId);
    this.__database
      .prepare(
        "UPDATE thread SET state = 'starting', pending_action_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(actionId, now, threadId);
  }

  private __event(
    kind: ILifecycleEvent['kind'],
    threadId: string | null,
    actionId: string | null,
    nativeTurnId: string | null = null,
    nativeItemId: string | null = null,
  ): void {
    this.__database
      .prepare(
        'INSERT INTO event (runtime_epoch, thread_id, action_id, native_turn_id, native_item_id, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(this.__epoch, threadId, actionId, nativeTurnId, nativeItemId, kind, Date.now());
  }

  private __conflict(): never {
    throw new Exception('The HQ action conflicts with its recorded state', undefined, {
      kind: 'state-conflict',
    });
  }

  /** Keeps the admission record and its related state mutation in one worker-owned transaction. */
  private __transaction<T>(operation: () => T): T {
    this.__database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.__database.exec('COMMIT');
      return result;
    } catch (error) {
      this.__database.exec('ROLLBACK');
      throw error;
    }
  }
}
