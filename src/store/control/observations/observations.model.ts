import { signHmac } from 'jg-crypto';

import type { IManagedThread } from '../../../contracts/index.js';

import { ControlModel } from '../control.model.js';
import { CONTROLLED_THREAD_CAPACITY } from '../constants.js';
import { toManagedThread } from '../transformers.js';
import type {
  IApprovalRecord,
  INativeObservation,
  IObservationResult,
  IThreadRow,
} from '../types.js';

/** Applies ordered native evidence, such as turns, items and approvals, to controlled threads. */
export class ControlObservations extends ControlModel {
  /**
   * Records only native approval identities; question text and answers stay out of SQLite.
   * @returns The stable prompt identity when its current turn is controlled here.
   * @throws
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   */
  public openApproval(approval: IApprovalRecord): { id: string; thread: IManagedThread } | null {
    return this._transaction(() => {
      const thread = this._nativeThread(approval.provider, approval.nativeThreadId);
      if (
        !thread ||
        thread.ownership !== 'managed' ||
        thread.runtime_epoch !== this._epoch ||
        thread.active_turn_id !== approval.nativeTurnId
      )
        return null;
      const existing = this._statements.get<{
        id: string;
        thread_id: string;
        native_turn_id: string;
        digest: string;
        state: string;
      }>(
        'SELECT id, thread_id, native_turn_id, digest, state FROM agent_hq_native_approval WHERE runtime_epoch = ? AND thread_id = ? AND native_request_id = ?',
        this._epoch,
        thread.id,
        approval.requestId,
      );
      if (existing) {
        if (
          existing.thread_id !== thread.id ||
          existing.native_turn_id !== approval.nativeTurnId ||
          existing.digest !== approval.digest
        )
          this._conflict();
        return existing.state === 'pending'
          ? { id: existing.id, thread: toManagedThread(thread) }
          : null;
      }
      const pending = this._statements.all(
        "SELECT id FROM agent_hq_native_approval WHERE runtime_epoch = ? AND state = 'pending' LIMIT 32",
        this._epoch,
      );
      if (pending.length >= 32) this._conflict();
      const now = Date.now();
      this._statements.run(
        "INSERT INTO agent_hq_native_approval (id, thread_id, native_turn_id, runtime_epoch, native_request_id, digest, kind, is_blocking, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
        approval.id,
        thread.id,
        approval.nativeTurnId,
        this._epoch,
        approval.requestId,
        approval.digest,
        approval.kind,
        approval.isBlocking ? 1 : 0,
        now,
        now,
      );
      if (approval.isBlocking && thread.state !== 'stopping')
        this._statements.run(
          'UPDATE agent_hq_thread SET state = ?, updated_at = ? WHERE id = ?',
          approval.kind === 'question' ? 'waiting-input' : 'waiting-approval',
          now,
          thread.id,
        );
      return { id: approval.id, thread: this._managedThread(thread.id)! };
    });
  }

  /**
   * Applies ordered native lifecycle evidence and deduplicates repeated observations. The end of
   * a turn a close interrupts moves the close on to clean, for dispatch to continue.
   * @returns The refreshed thread, whether its next-turn queue may advance, and the action it
   * moved to its next phase, if any.
   * @throws
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   */
  public observe(observation: INativeObservation): IObservationResult {
    return this._transaction(() => {
      const now = Date.now();
      if (observation.kind === 'native-unavailable') {
        const affected = this._statements.all<{ id: string }>(
          'SELECT id FROM agent_hq_thread WHERE runtime_epoch = ? AND provider = ? AND (? IS NULL OR native_id = ?) LIMIT ?',
          this._epoch,
          observation.provider,
          observation.nativeThreadId ?? null,
          observation.nativeThreadId ?? null,
          CONTROLLED_THREAD_CAPACITY,
        );
        for (const { id } of affected) {
          this._statements.run(
            "UPDATE agent_hq_thread SET ownership = 'uncertain', state = 'unknown', updated_at = ? WHERE id = ?",
            now,
            id,
          );
          this._statements.run(
            "UPDATE agent_hq_action SET delivery = 'uncertain', updated_at = ? WHERE thread_id = ? AND delivery = 'submitted'",
            now,
            id,
          );
          this._statements.run(
            "UPDATE agent_hq_action SET queue_ready = 0 WHERE thread_id = ? AND delivery = 'queued'",
            id,
          );
          this._statements.run(
            "UPDATE agent_hq_native_approval SET state = 'expired', updated_at = ? WHERE thread_id = ? AND state = 'pending'",
            now,
            id,
          );
        }
        return { thread: null, canDispatchQueued: false };
      }
      const thread = this._nativeThread(observation.provider, observation.nativeThreadId);
      if (!thread || thread.runtime_epoch !== this._epoch)
        return { thread: null, canDispatchQueued: false };
      let continued: string | null = null;
      const tuple = [
        observation.provider,
        observation.kind,
        observation.nativeThreadId,
        'nativeTurnId' in observation ? observation.nativeTurnId : null,
        'requestId' in observation ? observation.requestId : null,
      ];
      const key = signHmac(JSON.stringify(tuple), this._digestKey);
      const digest = signHmac(JSON.stringify(observation), this._digestKey);
      const prior = this._statements.get<{ digest: string }>(
        'SELECT digest FROM agent_hq_event WHERE runtime_epoch = ? AND event_key = ?',
        this._epoch,
        key,
      );
      if (prior) {
        /*
         * a turn's end can arrive twice, once read back from its saved history after a lost
         * notification and once as the notification itself: the first recorded stands, and the
         * other only fills in a result the first lacked
         */
        if (prior.digest !== digest && observation.kind !== 'turn-completed') this._conflict();
        if (prior.digest !== digest && observation.kind === 'turn-completed' && observation.result)
          this._statements.run(
            "UPDATE agent_hq_action SET result = ?, updated_at = ? WHERE thread_id = ? AND native_turn_id = ? AND kind IN ('message', 'queue', 'thread-create') AND result IS NULL",
            JSON.stringify(observation.result),
            now,
            thread.id,
            observation.nativeTurnId,
          );
        return { thread: toManagedThread(thread), canDispatchQueued: false };
      }
      if (observation.kind === 'turn-started') {
        const unexpected =
          thread.active_turn_id !== null && thread.active_turn_id !== observation.nativeTurnId;
        this._statements.run(
          'UPDATE agent_hq_thread SET active_turn_id = ?, state = ?, ownership = ?, updated_at = ? WHERE id = ?',
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
        if (observation.result) {
          const encoded = JSON.stringify(observation.result);
          this._statements.run(
            "UPDATE agent_hq_action SET result = ?, updated_at = ? WHERE thread_id = ? AND kind IN ('message', 'queue', 'thread-create') AND (native_turn_id = ? OR (id = ? AND native_turn_id IS NULL AND ? = ?))",
            encoded,
            now,
            thread.id,
            observation.nativeTurnId,
            thread.pending_action_id,
            thread.active_turn_id,
            observation.nativeTurnId,
          );
        }
        this._statements.run(
          'UPDATE agent_hq_action SET completion = ?, updated_at = ? WHERE thread_id = ? AND native_turn_id = ?',
          observation.state,
          now,
          thread.id,
          observation.nativeTurnId,
        );
        this._statements.run(
          "UPDATE agent_hq_action SET delivery = 'uncertain', updated_at = ? WHERE delivery = 'submitted' AND id IN (SELECT reply_action_id FROM agent_hq_native_approval WHERE thread_id = ? AND native_turn_id = ? AND state = 'pending')",
          now,
          thread.id,
          observation.nativeTurnId,
        );
        this._statements.run(
          "UPDATE agent_hq_native_approval SET state = 'expired', updated_at = ? WHERE thread_id = ? AND native_turn_id = ? AND state = 'pending'",
          now,
          thread.id,
          observation.nativeTurnId,
        );
        if (thread.active_turn_id === observation.nativeTurnId) {
          const closing = thread.pending_action_id ? this._action(thread.pending_action_id) : null;
          if (
            closing?.kind === 'thread-close' &&
            closing.phase === 'interrupt' &&
            closing.delivery === 'submitted'
          ) {
            this._statements.run(
              "UPDATE agent_hq_action SET phase = 'clean', updated_at = ? WHERE id = ?",
              now,
              closing.id,
            );
            continued = closing.id;
          }
          const mayAdvance =
            observation.state === 'completed' &&
            thread.state !== 'stopping' &&
            thread.ownership === 'managed';
          this._statements.run(
            'UPDATE agent_hq_thread SET active_turn_id = NULL, last_turn_id = ?, last_turn_state = ?, state = ?, updated_at = ? WHERE id = ?',
            observation.nativeTurnId,
            observation.state,
            thread.ownership === 'uncertain' ? 'unknown' : observation.state,
            now,
            thread.id,
          );
          if (mayAdvance)
            this._statements.run(
              "UPDATE agent_hq_action SET queue_ready = 1 WHERE thread_id = ? AND expected_turn_id = ? AND delivery = 'queued' AND runtime_epoch = ?",
              thread.id,
              observation.nativeTurnId,
              this._epoch,
            );
          else
            this._statements.run(
              "UPDATE agent_hq_action SET queue_ready = 0 WHERE thread_id = ? AND delivery = 'queued'",
              thread.id,
            );
        }
      } else if (observation.kind === 'request-canceled') {
        const approval = this._statements.get<{ reply_action_id: string | null }>(
          "SELECT reply_action_id FROM agent_hq_native_approval WHERE thread_id = ? AND runtime_epoch = ? AND native_request_id = ? AND state = 'pending'",
          thread.id,
          this._epoch,
          observation.requestId,
        );
        if (approval) {
          this._statements.run(
            "UPDATE agent_hq_native_approval SET state = 'expired', updated_at = ? WHERE thread_id = ? AND runtime_epoch = ? AND native_request_id = ? AND state = 'pending'",
            now,
            thread.id,
            this._epoch,
            observation.requestId,
          );
          if (approval.reply_action_id)
            this._statements.run(
              "UPDATE agent_hq_action SET delivery = 'uncertain', updated_at = ? WHERE id = ? AND delivery = 'submitted'",
              now,
              approval.reply_action_id,
            );
          this.__refreshApprovalState(thread, now);
        }
      } else if (observation.kind === 'request-resolved') {
        const approval = this._statements.get<{
          id: string;
          native_turn_id: string;
          reply_action_id: string | null;
        }>(
          "SELECT id, native_turn_id, reply_action_id FROM agent_hq_native_approval WHERE thread_id = ? AND runtime_epoch = ? AND native_request_id = ? AND state = 'pending'",
          thread.id,
          this._epoch,
          observation.requestId,
        );
        if (approval) {
          const replyId = approval.reply_action_id;
          this._statements.run(
            'UPDATE agent_hq_native_approval SET state = ?, updated_at = ? WHERE id = ?',
            replyId ? 'answered' : 'expired',
            now,
            approval.id,
          );
          if (replyId)
            this._statements.run(
              "UPDATE agent_hq_action SET delivery = 'acknowledged', failure = NULL, updated_at = ? WHERE id = ? AND delivery IN ('submitted', 'uncertain')",
              now,
              replyId,
            );
          this.__refreshApprovalState(thread, now);
        }
      }
      this._statements.run(
        'INSERT INTO agent_hq_event (runtime_epoch, event_key, digest) VALUES (?, ?, ?)',
        this._epoch,
        key,
        digest,
      );
      const current = this._thread(thread.id)!;
      return {
        thread: toManagedThread(current),
        canDispatchQueued:
          current.ownership === 'managed' &&
          current.state === 'completed' &&
          current.active_turn_id === null &&
          current.pending_action_id === null,
        continued: continued === null ? null : this._receipt(continued),
      };
    });
  }

  /** Recomputes the visible wait state after one of several native prompts ends. */
  private __refreshApprovalState(thread: IThreadRow, now: number): void {
    if (!thread.active_turn_id || thread.state === 'stopping' || thread.ownership !== 'managed')
      return;
    const remaining = this._statements.get<{ kind: string }>(
      "SELECT kind FROM agent_hq_native_approval WHERE thread_id = ? AND native_turn_id = ? AND state = 'pending' AND is_blocking = 1 LIMIT 1",
      thread.id,
      thread.active_turn_id,
    );
    this._statements.run(
      'UPDATE agent_hq_thread SET state = ?, updated_at = ? WHERE id = ?',
      remaining
        ? remaining.kind === 'question'
          ? 'waiting-input'
          : 'waiting-approval'
        : 'running',
      now,
      thread.id,
    );
  }
}
