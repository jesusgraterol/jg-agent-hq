import type { IActionReceipt } from '../../../contracts/index.js';

import { ControlModel } from '../control.model.js';
import { toActionReceipt } from '../transformers.js';
import type { INativeOutcome } from '../types.js';

/** Applies native request outcomes to the actions whose phases they answer. */
export class ControlOutcomes extends ControlModel {
  /**
   * Applies an exact native request outcome without downgrading a known acknowledgement. An
   * outcome answers the phase its action takes now; one for a phase the action has left, or from
   * another runtime, is stale and changes nothing.
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
          "UPDATE agent_hq_action SET phase = 'close', updated_at = ? WHERE id = ?",
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
        if (ownsThread && thread.pending_action_id === action.id) {
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
      } else {
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
          else if (outcome.kind === 'resumed')
            this._statements.run(
              'UPDATE agent_hq_thread SET pending_action_id = NULL, ownership = ?, state = ?, native_lineage = ?, updated_at = ? WHERE id = ? AND pending_action_id = ?',
              outcome.nativeState === 'idle' ? 'managed' : 'uncertain',
              outcome.nativeState === 'idle' ? 'idle' : 'unknown',
              outcome.nativeLineage === null ? null : JSON.stringify(outcome.nativeLineage),
              now,
              thread.id,
              action.id,
            );
          else if (outcome.kind === 'renamed') {
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
}
