import type { DatabaseSync } from 'node:sqlite';

import type { IManagedThread } from '../../../contracts/index.js';

import type { IStatements } from '../../utilities.js';

import { ControlModel } from '../control.model.js';
import {
  CONTROLLED_THREAD_CAPACITY,
  KEPT_SESSION_CONDITION,
  THREAD_COLUMNS,
} from '../constants.js';
import { toManagedThread } from '../transformers.js';
import type { IObservationResult, IReattachment, IThreadRow } from '../types.js';

/**
 * Binds controls to the runtime's lifetime: it quarantines what another runtime left unsettled,
 * rejoins the sessions a native process kept running and releases control at shutdown.
 */
export class ControlLifecycle extends ControlModel {
  /**
   * Quarantines unsettled controls from another runtime before accepting new actions, except the
   * sessions Codex's shared daemon still runs, which the runtime rejoins, and deletes the
   * observations earlier runtimes recorded.
   */
  public constructor(
    database: DatabaseSync,
    statements: IStatements,
    runtimeEpoch: string,
    digestKey: Uint8Array,
  ) {
    super(database, statements, runtimeEpoch, digestKey);
    const now = Date.now();
    this._transaction(() => {
      statements.run(
        `UPDATE agent_hq_thread SET ownership = 'uncertain', state = 'unknown', updated_at = ? WHERE runtime_epoch IS NOT NULL AND runtime_epoch != ? AND ownership = 'managed' AND NOT (${KEPT_SESSION_CONDITION})`,
        now,
        runtimeEpoch,
      );
      statements.run(
        "UPDATE agent_hq_action SET delivery = 'uncertain', updated_at = ? WHERE runtime_epoch != ? AND delivery = 'submitted'",
        now,
        runtimeEpoch,
      );
      statements.run(
        "UPDATE agent_hq_action SET queue_ready = 0 WHERE runtime_epoch != ? AND delivery = 'queued'",
        runtimeEpoch,
      );
      statements.run(
        "UPDATE agent_hq_native_approval SET state = 'expired', updated_at = ? WHERE runtime_epoch != ? AND state = 'pending'",
        now,
        runtimeEpoch,
      );
      // a repeated observation is recognized within one runtime, so earlier runtimes' rows go
      statements.run('DELETE FROM agent_hq_event WHERE runtime_epoch != ?', runtimeEpoch);
    });
  }

  /**
   * Tells whether host maintenance can start: earlier worker commands have run, and no native
   * work is unresolved.
   * @returns Whether no controlled thread is active and no action of this runtime is submitted.
   */
  public canStartMaintenance(): boolean {
    const activeThread = this._statements.get(
      "SELECT 1 FROM agent_hq_thread WHERE runtime_epoch IS NOT NULL AND (active_turn_id IS NOT NULL OR pending_action_id IS NOT NULL OR state NOT IN ('inactive', 'idle', 'completed', 'failed', 'interrupted')) LIMIT 1",
    );
    const activeAction = this._statements.get(
      "SELECT 1 FROM agent_hq_action WHERE runtime_epoch = ? AND delivery = 'submitted' LIMIT 1",
      this._epoch,
    );
    return !activeThread && !activeAction;
  }

  /**
   * Marks controls inactive only after its caller has proven native shutdown. A session a native
   * process keeps running stays bound to this runtime, for the next one to rejoin.
   * Quarantined Codex controls retain their producing epoch and evidence for explicit recovery.
   */
  public releaseControls(): void {
    this._transaction(() => {
      const now = Date.now();
      this._statements.run(
        `UPDATE agent_hq_thread SET runtime_epoch = NULL, pending_action_id = NULL, active_turn_id = NULL, ownership = CASE WHEN native_id IS NULL THEN 'uncertain' ELSE 'managed' END, state = CASE WHEN native_id IS NULL THEN 'unknown' ELSE 'inactive' END, updated_at = ? WHERE runtime_epoch = ? AND NOT (${KEPT_SESSION_CONDITION}) AND NOT (provider = 'codex' AND ownership = 'uncertain')`,
        now,
        this._epoch,
      );
      this.__settleReleasedWork('runtime_epoch', this._epoch, now);
    });
  }

  /**
   * Releases one known Claude conversation after its owner proves exact controller/group exit.
   * @returns The inactive thread, or null when its identity or producing runtime changed.
   */
  public releaseControl(
    threadId: string,
    nativeId: string,
    workspaceRoot: string,
    runtimeEpoch: string,
  ): IManagedThread | null {
    if (runtimeEpoch !== this._epoch) return null;
    return this._transaction(() => {
      const thread = this._statements.get<IThreadRow>(
        `SELECT ${THREAD_COLUMNS} FROM agent_hq_thread WHERE id = ? AND provider = 'claude' AND native_id = ? AND workspace_root = ? AND runtime_epoch = ? AND ownership = 'uncertain'`,
        threadId,
        nativeId,
        workspaceRoot,
        runtimeEpoch,
      );
      if (!thread) return null;
      const now = Date.now();
      this._statements.run(
        "UPDATE agent_hq_thread SET runtime_epoch = NULL, pending_action_id = NULL, active_turn_id = NULL, ownership = 'managed', state = 'inactive', updated_at = ? WHERE id = ?",
        now,
        thread.id,
      );
      this.__settleReleasedWork('thread_id', thread.id, now);
      return this._managedThread(thread.id);
    });
  }

  /**
   * Releases a quarantined controller's reservation only after its matching dispatch has ended.
   * @returns The still-uncertain thread, or null for a changed action, identity or runtime.
   */
  public releaseEndedControlAction(
    actionId: string,
    nativeId: string,
    workspaceRoot: string,
    runtimeEpoch: string,
  ): IManagedThread | null {
    if (runtimeEpoch !== this._epoch) return null;
    return this._transaction(() => {
      const action = this._action(actionId);
      if (
        !action?.thread_id ||
        action.runtime_epoch !== this._epoch ||
        action.delivery === 'submitted' ||
        action.delivery === 'queued'
      )
        return null;
      const thread = this._thread(action.thread_id);
      if (
        !thread ||
        thread.provider !== 'claude' ||
        thread.native_id !== nativeId ||
        thread.workspace_root !== workspaceRoot ||
        thread.runtime_epoch !== this._epoch ||
        thread.ownership !== 'uncertain' ||
        thread.pending_action_id !== actionId
      )
        return null;
      this._statements.run(
        "UPDATE agent_hq_thread SET pending_action_id = NULL, state = 'unknown', updated_at = ? WHERE id = ?",
        Date.now(),
        thread.id,
      );
      return this._managedThread(thread.id);
    });
  }

  /** Lists the sessions another runtime left running, which this runtime rejoins, oldest first. */
  public listReattachable(): IManagedThread[] {
    return this._statements
      .all<IThreadRow>(
        `SELECT ${THREAD_COLUMNS} FROM agent_hq_thread WHERE runtime_epoch IS NOT NULL AND runtime_epoch != ? AND ${KEPT_SESSION_CONDITION} ORDER BY created_at ASC, id ASC LIMIT ?`,
        this._epoch,
        CONTROLLED_THREAD_CAPACITY,
      )
      .map(toManagedThread);
  }

  /**
   * Lists the current controls that have no unacknowledged operation in flight.
   * @returns The bounded cohort eligible for rechecking after a connection loss.
   */
  public listReconnectable(): IManagedThread[] {
    return this._statements
      .all<IThreadRow>(
        `SELECT ${THREAD_COLUMNS} FROM agent_hq_thread WHERE runtime_epoch = ? AND ${KEPT_SESSION_CONDITION} ORDER BY created_at ASC, id ASC LIMIT ?`,
        this._epoch,
        CONTROLLED_THREAD_CAPACITY,
      )
      .map(toManagedThread);
  }

  /**
   * Binds a kept or reconnecting session to this runtime, as its native process reports
   * it before the runtime rejoins it. A turn that finished meanwhile completes its action and lets
   * the session's queued input advance, which this runtime then delivers. A session whose latest
   * turn isn't the one HQ recorded, because another client started one, has its ownership marked
   * uncertain instead.
   * @returns The thread and whether its queue may advance, or null when it is no longer one to rejoin.
   * @throws
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   */
  public reattach(input: IReattachment): IObservationResult | null {
    return this._transaction(() => {
      const thread = this._statements.get<IThreadRow>(
        `SELECT ${THREAD_COLUMNS} FROM agent_hq_thread WHERE id = ? AND ${
          input.isReconnect
            ? "runtime_epoch = ? AND ownership = 'uncertain' AND native_id IS NOT NULL AND pending_action_id IS NULL AND provider = 'codex'"
            : `runtime_epoch IS NOT NULL AND runtime_epoch != ? AND ${KEPT_SESSION_CONDITION}`
        }`,
        input.threadId,
        this._epoch,
      );
      if (!thread) return null;
      const now = Date.now();
      const latest = input.latestTurn;
      const isRunning = latest?.state === 'running';
      if (
        (latest?.nativeTurnId ?? null) !== (thread.active_turn_id ?? thread.last_turn_id) ||
        (isRunning && thread.active_turn_id === null)
      ) {
        if (!input.isReconnect) this.__quarantine(thread.id, now);
        return { thread: this._managedThread(thread.id), canDispatchQueued: false };
      }
      this._availableSlot();
      // the turn HQ left running, when it has finished since
      const finished =
        thread.active_turn_id !== null && latest && latest.state !== 'running'
          ? { nativeTurnId: latest.nativeTurnId, state: latest.state }
          : null;
      const state = isRunning
        ? thread.state === 'stopping'
          ? 'stopping'
          : 'running'
        : (finished?.state ??
          (input.isReconnect ? (thread.last_turn_state ?? 'idle') : thread.state));
      this._statements.run(
        "UPDATE agent_hq_thread SET ownership = 'managed', runtime_epoch = ?, active_turn_id = ?, last_turn_id = ?, last_turn_state = ?, state = ?, updated_at = ? WHERE id = ?",
        this._epoch,
        isRunning ? latest.nativeTurnId : null,
        finished?.nativeTurnId ?? thread.last_turn_id,
        finished?.state ?? thread.last_turn_state,
        state,
        now,
        thread.id,
      );
      this._statements.run(
        "UPDATE agent_hq_action SET runtime_epoch = ?, updated_at = ? WHERE thread_id = ? AND delivery = 'queued'",
        this._epoch,
        now,
        thread.id,
      );
      const canDispatchQueued = finished?.state === 'completed' && thread.state !== 'stopping';
      if (finished) {
        this._statements.run(
          'UPDATE agent_hq_action SET completion = ?, updated_at = ? WHERE thread_id = ? AND native_turn_id = ? AND completion IS NULL',
          finished.state,
          now,
          thread.id,
          finished.nativeTurnId,
        );
        if (canDispatchQueued)
          this._statements.run(
            "UPDATE agent_hq_action SET queue_ready = 1 WHERE thread_id = ? AND expected_turn_id = ? AND delivery = 'queued' AND related_action_id IS NULL",
            thread.id,
            finished.nativeTurnId,
          );
      }
      return { thread: this._managedThread(thread.id), canDispatchQueued };
    });
  }

  /** Marks a session's ownership uncertain when this runtime can't rejoin it. */
  public quarantineThread(threadId: string): void {
    this._transaction(() => this.__quarantine(threadId, Date.now()));
  }

  /** Keeps released work uncertain or paused without acknowledging or dispatching it. */
  private __settleReleasedWork(
    scopeColumn: 'thread_id' | 'runtime_epoch',
    scopeId: string,
    now: number,
  ): void {
    this._statements.run(
      `UPDATE agent_hq_action SET delivery = 'uncertain', updated_at = ? WHERE ${scopeColumn} = ? AND delivery = 'submitted'`,
      now,
      scopeId,
    );
    this._statements.run(
      `UPDATE agent_hq_action SET queue_ready = 0 WHERE ${scopeColumn} = ? AND delivery = 'queued'`,
      scopeId,
    );
    this._statements.run(
      `UPDATE agent_hq_native_approval SET state = 'expired', updated_at = ? WHERE ${scopeColumn} = ? AND state = 'pending'`,
      now,
      scopeId,
    );
  }

  /** Quarantines one session another runtime left bound to itself, once. */
  private __quarantine(threadId: string, now: number): void {
    this._statements.run(
      "UPDATE agent_hq_thread SET ownership = 'uncertain', state = 'unknown', updated_at = ? WHERE id = ? AND runtime_epoch IS NOT NULL AND runtime_epoch != ? AND ownership = 'managed'",
      now,
      threadId,
      this._epoch,
    );
  }
}
