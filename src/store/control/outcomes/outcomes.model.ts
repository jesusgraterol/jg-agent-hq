import type { IActionReceipt } from '../../../contracts/index.js';
import type { IEvidenceOriginsRequest } from '../../../sessions/evidence/index.js';

import { ControlModel } from '../control.model.js';
import { toActionReceipt } from '../transformers.js';
import type { INativeOutcome } from '../types.js';

/** Applies native request outcomes to the actions whose phases they answer. */
export class ControlOutcomes extends ControlModel {
  /**
   * Confirms saved Claude input against its exact admitted steer, including an earlier runtime's
   * uncertain receipt. This changes delivery only; it never restores control or dispatches work.
   * @returns The thread IDs whose receipt changed.
   */
  public confirmClaudeSteers(
    command: IEvidenceOriginsRequest & { workspaceRoot: string },
  ): string[] {
    if (command.provider !== 'claude') return [];
    return this._transaction(() => {
      const threads = new Set<string>();
      for (const item of command.items) {
        if (item.nativeInputId === null || item.sha256 === null) continue;
        const updated = this._statements.get<{ thread_id: string }>(
          `UPDATE agent_hq_action SET delivery = 'acknowledged', failure = NULL, updated_at = ?
          WHERE id = ? AND provider = 'claude' AND kind = 'steer' AND phase = 'steer'
          AND delivery IN ('submitted', 'uncertain') AND input_sha256 = ?
          AND native_turn_id IS NOT NULL AND native_turn_id = expected_turn_id
          AND (native_turn_id = ? OR id = ?)
          AND thread_id IN (SELECT id FROM agent_hq_thread
            WHERE provider = 'claude' AND native_id = ? AND workspace_root = ?)
          RETURNING thread_id`,
          Date.now(),
          item.nativeInputId,
          item.sha256,
          item.turnId,
          item.turnId,
          command.nativeId,
          command.workspaceRoot,
        );
        if (updated) threads.add(updated.thread_id);
      }
      return [...threads];
    });
  }

  /**
   * Applies an exact native request outcome without downgrading a known acknowledgement. An
   * outcome answers the phase its action takes now; one for a phase the action has left, or from
   * another runtime, is stale and changes nothing. A phase that continues the same action moves
   * it to its next phase: a named session with a first input to turn, a closed session being
   * deleted to delete. A close that interrupts its session's turn continues on the turn's end, so
   * the interrupt's acknowledgement changes nothing.
   * @returns The current receipt, or null for an unrecognized/stale response.
   * @throws
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   */
  public applyOutcome(outcome: INativeOutcome): IActionReceipt | null {
    return this._transaction(() => {
      const action = this._action(outcome.actionId);
      if (!action || action.runtime_epoch !== this._epoch || action.phase !== outcome.phase)
        return action ? toActionReceipt(action) : null;
      if (['failed', 'canceled', 'acknowledged'].includes(action.delivery))
        return toActionReceipt(action);
      const thread = action.thread_id ? this._thread(action.thread_id) : null;
      const ownsThread = thread?.runtime_epoch === this._epoch && thread.ownership === 'managed';
      const now = Date.now();
      if (outcome.kind === 'created') {
        const collision = thread ? this._nativeThread(thread.provider, outcome.nativeId) : null;
        if (collision && collision.id !== thread?.id) this._conflict();
        if (
          !thread ||
          !ownsThread ||
          thread.pending_action_id !== action.id ||
          (thread.native_id !== null && thread.native_id !== outcome.nativeId)
        )
          this._conflict();
        this._statements.run(
          "UPDATE agent_hq_thread SET native_id = ?, native_lineage = ?, state = 'creating', updated_at = ? WHERE id = ?",
          outcome.nativeId,
          outcome.nativeLineage === null ? null : JSON.stringify(outcome.nativeLineage),
          now,
          thread.id,
        );
        // a created session is named next
        this._statements.run(
          "UPDATE agent_hq_action SET delivery = 'submitted', phase = 'name', updated_at = ? WHERE id = ?",
          now,
          action.id,
        );
      } else if (outcome.kind === 'cleaned') {
        if (!ownsThread || thread.pending_action_id !== action.id) this._conflict();
        // a cleaned session is closed next
        this._statements.run(
          "UPDATE agent_hq_action SET delivery = 'submitted', phase = 'close', updated_at = ? WHERE id = ?",
          now,
          action.id,
        );
      } else if (outcome.kind === 'uncertain' || outcome.kind === 'failed') {
        this._statements.run(
          'UPDATE agent_hq_action SET delivery = ?, failure = ?, updated_at = ? WHERE id = ?',
          outcome.kind,
          outcome.kind === 'failed' ? outcome.failure : null,
          now,
          action.id,
        );
        /*
         * A close whose interrupt didn't go leaves the turn running, stopping as an interrupt's
         * would, and a deletion that didn't go leaves the closed session as it was; either way the
         * session is released for the next action.
         */
        const isReleased =
          (action.kind === 'thread-close' && action.phase === 'interrupt') ||
          (action.kind === 'thread-delete' && action.phase === 'delete');
        if (isReleased && thread?.pending_action_id === action.id)
          this._statements.run(
            'UPDATE agent_hq_thread SET pending_action_id = NULL, updated_at = ? WHERE id = ?',
            now,
            thread.id,
          );
        else if (ownsThread && thread.pending_action_id === action.id) {
          if (action.kind === 'thread-rename' && outcome.kind === 'failed')
            this._statements.run(
              'UPDATE agent_hq_thread SET pending_action_id = NULL, updated_at = ? WHERE id = ?',
              now,
              thread.id,
            );
          else if (action.kind !== 'thread-rename')
            this._statements.run(
              "UPDATE agent_hq_thread SET state = 'unknown', updated_at = ? WHERE id = ?",
              now,
              thread.id,
            );
        }
      } else if (outcome.kind === 'reply-written') {
        // a successful pipe write is not a native resolution acknowledgement
      } else if (outcome.kind === 'interrupt-accepted' && action.kind === 'thread-close') {
        // the interrupted turn's end continues the close
      } else if (
        outcome.kind === 'renamed' &&
        action.kind === 'thread-create' &&
        action.queued_input !== null
      ) {
        if (!ownsThread || thread.pending_action_id !== action.id || !action.requested_name)
          this._conflict();
        // the session opens with its name, then its first turn starts under the same action
        this._statements.run(
          "UPDATE agent_hq_thread SET name = ?, state = 'idle', updated_at = ? WHERE id = ?",
          action.requested_name,
          now,
          thread.id,
        );
        this._statements.run(
          "UPDATE agent_hq_thread SET state = 'starting', updated_at = ? WHERE id = ?",
          now,
          thread.id,
        );
        this._statements.run(
          "UPDATE agent_hq_action SET delivery = 'submitted', phase = 'turn', updated_at = ? WHERE id = ?",
          now,
          action.id,
        );
      } else if (outcome.kind === 'closed' && action.kind === 'thread-delete') {
        if (!ownsThread || thread.pending_action_id !== action.id) this._conflict();
        // the closed session stays held by its deletion, which continues with delete
        this._statements.run(
          "UPDATE agent_hq_thread SET runtime_epoch = NULL, active_turn_id = NULL, state = 'inactive', updated_at = ? WHERE id = ?",
          now,
          thread.id,
        );
        this._statements.run(
          "UPDATE agent_hq_action SET delivery = 'submitted', phase = 'delete', updated_at = ? WHERE id = ?",
          now,
          action.id,
        );
      } else if (outcome.kind === 'deleted') {
        if (thread) {
          if (thread.pending_action_id !== action.id) this._conflict();
          this.__deleteThread(thread.id, action.id);
        }
        this._statements.run(
          'DELETE FROM agent_hq_observed_session WHERE provider = ? AND native_id = ?',
          action.provider,
          outcome.nativeId,
        );
        // the deletion's own receipt stays, without the thread it deleted
        this._statements.run(
          "UPDATE agent_hq_action SET delivery = 'acknowledged', failure = NULL, thread_id = NULL, updated_at = ? WHERE id = ?",
          now,
          action.id,
        );
      } else {
        if (
          outcome.kind === 'resumed' &&
          outcome.latestTurn !== undefined &&
          (!ownsThread ||
            thread.pending_action_id !== action.id ||
            (thread.active_turn_id !== null &&
              thread.active_turn_id !== outcome.latestTurn?.nativeTurnId))
        )
          this._conflict();
        let nativeTurnId = action.native_turn_id;
        if (outcome.kind === 'turn-accepted' || outcome.kind === 'steer-accepted')
          nativeTurnId = outcome.nativeTurnId;
        if (outcome.kind === 'steer-accepted' && outcome.nativeTurnId !== action.expected_turn_id)
          this._conflict();
        const completion =
          thread?.last_turn_id === nativeTurnId ? thread.last_turn_state : action.completion;
        this._statements.run(
          "UPDATE agent_hq_action SET delivery = 'acknowledged', native_turn_id = ?, completion = ?, failure = NULL, queued_input = NULL, updated_at = ? WHERE id = ?",
          nativeTurnId,
          completion,
          now,
          action.id,
        );
        if (ownsThread) {
          if (outcome.kind === 'closed')
            this._statements.run(
              "UPDATE agent_hq_thread SET runtime_epoch = NULL, pending_action_id = NULL, active_turn_id = NULL, state = 'inactive', updated_at = ? WHERE id = ? AND pending_action_id = ?",
              now,
              thread.id,
              action.id,
            );
          else if (outcome.kind === 'resumed') {
            if (outcome.latestTurn !== undefined) {
              const latest = outcome.latestTurn;
              const hasFinished =
                latest &&
                thread.last_turn_id === latest.nativeTurnId &&
                thread.last_turn_state !== null &&
                thread.active_turn_id === null;
              const isRunning = latest?.state === 'running' && !hasFinished;
              const state = isRunning
                ? ['waiting-input', 'waiting-approval'].includes(thread.state)
                  ? thread.state
                  : 'running'
                : hasFinished
                  ? thread.last_turn_state!
                  : (latest?.state ?? 'idle');
              this._statements.run(
                'UPDATE agent_hq_thread SET pending_action_id = NULL, active_turn_id = ?, last_turn_id = ?, last_turn_state = ?, state = ?, native_lineage = ?, updated_at = ? WHERE id = ?',
                isRunning ? latest!.nativeTurnId : null,
                latest && !isRunning ? latest.nativeTurnId : thread.last_turn_id,
                hasFinished
                  ? thread.last_turn_state
                  : latest && !isRunning
                    ? latest.state
                    : thread.last_turn_state,
                state,
                outcome.nativeLineage === null ? null : JSON.stringify(outcome.nativeLineage),
                now,
                thread.id,
              );
            } else
              this._statements.run(
                'UPDATE agent_hq_thread SET pending_action_id = NULL, ownership = ?, state = ?, native_lineage = ?, updated_at = ? WHERE id = ? AND pending_action_id = ?',
                outcome.nativeState === 'idle' ? 'managed' : 'uncertain',
                outcome.nativeState === 'idle' ? 'idle' : 'unknown',
                outcome.nativeLineage === null ? null : JSON.stringify(outcome.nativeLineage),
                now,
                thread.id,
                action.id,
              );
          } else if (outcome.kind === 'renamed') {
            if (!action.requested_name) this._conflict();
            this._statements.run(
              'UPDATE agent_hq_thread SET name = ?, pending_action_id = NULL, state = ?, updated_at = ? WHERE id = ? AND pending_action_id = ?',
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
            this._statements.run(
              'UPDATE agent_hq_thread SET pending_action_id = NULL, active_turn_id = ?, state = ?, updated_at = ? WHERE id = ?',
              active,
              state,
              now,
              thread.id,
            );
          }
        }
      }
      return this._receipt(action.id);
    });
  }

  /**
   * Deletes a managed thread with its actions, approvals and host receipts, except the action
   * deleting it. The thread and its registration action name each other, so its actions leave it
   * before it goes, and then go themselves; the transition log keeps its entries.
   */
  private __deleteThread(threadId: string, actionId: string): void {
    const actionIds = JSON.stringify(
      this._statements
        .all<{
          id: string;
        }>('SELECT id FROM agent_hq_action WHERE thread_id = ? AND id != ?', threadId, actionId)
        .map(({ id }) => id),
    );
    this._statements.run('DELETE FROM agent_hq_native_approval WHERE thread_id = ?', threadId);
    this._statements.run(
      'DELETE FROM agent_hq_browser_action WHERE native_action_id IN (SELECT value FROM json_each(?))',
      actionIds,
    );
    this._statements.run(
      'UPDATE agent_hq_action SET thread_id = NULL WHERE thread_id = ?',
      threadId,
    );
    this._statements.run('DELETE FROM agent_hq_thread WHERE id = ?', threadId);
    this._statements.run(
      'DELETE FROM agent_hq_action WHERE id IN (SELECT value FROM json_each(?))',
      actionIds,
    );
  }
}
