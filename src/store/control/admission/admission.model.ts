import { randomUUID } from 'node:crypto';
import { hashValue, signHmac } from 'jg-crypto';
import { isException } from 'jg-exception';
import { z } from 'zod';

import {
  ErrorKindSchema,
  type IActionEnvelope,
  type IActionPhase,
} from '../../../contracts/index.js';
import { toActionFailure } from '../../../errors/index.js';

import { ControlModel } from '../control.model.js';
import { ACTION_COLUMNS } from '../constants.js';
import { toActionReceipt } from '../transformers.js';
import type { IActionRow, IAdmission, IAdmissionResult, IDispatch, IThreadRow } from '../types.js';

import { ADMISSION_RULES } from './constants.js';
import type { IAdmissionRule } from './types.js';

type ICommand = IActionEnvelope['command'];

// a coded failure carries one of HQ's error kinds, unlike a defect such as a SQLite error
const KnownFailureSchema = z.object({ kind: ErrorKindSchema });

/** Admits actions into the control ledger, fencing the one native dispatch each may start. */
export class ControlAdmission extends ControlModel {
  /**
   * Admits a command exactly once before any native write, with all ownership checks atomic and
   * driven by its kind's admission rule. A check that fails with a coded HQ error records the
   * action as failed; any other error, such as a SQLite one, rolls the whole admission back and
   * propagates, so the action isn't recorded.
   * @returns The durable receipt and the one action permitted to dispatch.
   * @throws
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   */
  public admit(input: IAdmission): IAdmissionResult {
    return this._transaction(() => {
      const { action, prepared } = input;
      const digest = signHmac(JSON.stringify(action), this._digestKey);
      const existing = this._action(action.id);
      if (existing) {
        if (existing.digest !== digest) this._conflict();
        return {
          receipt: toActionReceipt(existing),
          thread: existing.thread_id ? this._managedThread(existing.thread_id) : null,
          isNew: false,
          dispatchActionId: null,
        };
      }
      if (action.runtimeEpoch !== this._epoch) this._conflict();
      const now = Date.now();
      const command = action.command;
      const expectedTurn = 'expectedTurnId' in command ? command.expectedTurnId : null;
      const nativeTurn =
        command.kind === 'queue' || command.kind === 'workspace-change' ? null : expectedTurn;
      const requestedName = 'name' in command ? command.name : null;
      this._statements.run(
        `INSERT INTO agent_hq_action (id, digest, requested_runtime_epoch, runtime_epoch, kind, provider, delivery, expected_turn_id, native_turn_id, requested_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?)`,
        action.id,
        digest,
        action.runtimeEpoch,
        this._epoch,
        command.kind,
        'provider' in command ? command.provider : null,
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
            ? this._action(command.queuedActionId)?.thread_id
            : null;
      const target = targetId ? this._thread(targetId) : null;
      if (target)
        this._statements.run(
          'UPDATE agent_hq_action SET thread_id = ?, provider = ? WHERE id = ?',
          target.id,
          target.provider,
          action.id,
        );
      const inputText = command.kind === 'steer' ? command.text : prepared.input?.text;
      if (
        inputText !== undefined &&
        ['message', 'queue', 'steer', 'thread-create'].includes(command.kind)
      ) {
        const inputSha256 = hashValue(inputText);
        this._statements.run(
          'UPDATE agent_hq_action SET input_sha256 = ? WHERE id = ?',
          inputSha256,
          action.id,
        );
        /*
         * An explicit skill's text exists only once it's prepared, so a browser submission of one
         * learns its fingerprint here. Its receipt's native action ID is a random UUID that browser
         * admission hands only to its own dispatch, so the action holding it is the one the operator
         * submitted, sent to the thread the browser selected.
         */
        if (
          (command.kind === 'message' || command.kind === 'queue') &&
          command.input.kind === 'skill'
        )
          this._statements.run(
            `UPDATE agent_hq_browser_action SET native_input_sha256 = ?
            WHERE native_action_id = ? AND native_thread_id = ? AND native_input_sha256 IS NULL`,
            inputSha256,
            action.id,
            command.threadId,
          );
      }
      this._database.exec('SAVEPOINT admission');
      let dispatchActionId: string | null;
      try {
        dispatchActionId = this.__admitCommand(
          action,
          prepared,
          ADMISSION_RULES[command.kind],
          now,
        );
        this._database.exec('RELEASE admission');
      } catch (error) {
        // only a coded failure fails the action; anything else rolls the whole admission back
        if (!isException(error) || !KnownFailureSchema.safeParse(error.data).success) throw error;
        this._database.exec('ROLLBACK TO admission');
        this._database.exec('RELEASE admission');
        this._statements.run(
          "UPDATE agent_hq_action SET delivery = 'failed', failure = ?, updated_at = ? WHERE id = ?",
          toActionFailure(error),
          now,
          action.id,
        );
        dispatchActionId = null;
      }
      const saved = this._action(action.id)!;
      return {
        receipt: toActionReceipt(saved),
        thread: saved.thread_id ? this._managedThread(saved.thread_id) : null,
        isNew: true,
        dispatchActionId,
      };
    });
  }

  /**
   * Claims one ready queue entry once; an explicit selection may release a paused entry.
   * @returns The single dispatch payload, or null when the queue cannot advance safely.
   */
  public claimQueued(threadId: string): IDispatch | null {
    return this._transaction(() => {
      const thread = this._thread(threadId);
      if (
        !thread ||
        thread.ownership !== 'managed' ||
        thread.runtime_epoch !== this._epoch ||
        thread.active_turn_id ||
        thread.pending_action_id ||
        thread.state !== 'completed'
      )
        return null;
      const queued = this._statements.get<IActionRow>(
        `SELECT ${ACTION_COLUMNS} FROM agent_hq_action WHERE thread_id = ? AND delivery = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1`,
        threadId,
      );
      if (
        !queued ||
        !queued.queue_ready ||
        queued.runtime_epoch !== this._epoch ||
        queued.queued_input === null
      )
        return null;
      const transition = this._workspaces.get(queued.id);
      if (
        transition &&
        (transition.state !== 'prepared' ||
          queued.expected_turn_id !== thread.last_turn_id ||
          thread.last_turn_state !== 'completed')
      )
        return null;
      this.__beginTurn(queued.id, threadId);
      this.__setPhase(queued.id, transition ? 'workspace' : 'turn');
      const dispatched = this._receipt(queued.id)!;
      return {
        receipt: dispatched,
        thread: this._managedThread(threadId)!,
        input: dispatched.queuedInput!,
      };
    });
  }

  /**
   * Checks an admitted command against its kind's rule and records the state change it makes.
   * @returns The action that may dispatch, or null when none does.
   * @throws
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   */
  private __admitCommand(
    action: IActionEnvelope,
    prepared: IAdmission['prepared'],
    rule: IAdmissionRule,
    now: number,
  ): string | null {
    const command = action.command;
    if (rule.takesSlot) this._availableSlot();
    let queued: IActionRow | null = null;
    let phase = rule.phase;
    if (rule.target === 'thread' || rule.target === 'queued')
      ({ queued, phase } = this.__admitToThread(action, prepared, rule, now));
    else if (command.kind === 'thread-delete') phase = this.__admitDelete(action.id, prepared, now);
    else if (command.kind === 'thread-create' || command.kind === 'thread-adopt')
      this.__register(action.id, command, prepared, now);
    else this._conflict();
    if (rule.delivery === 'settle' || rule.delivery === 'dispatch-queued')
      this._statements.run(
        "UPDATE agent_hq_action SET delivery = 'acknowledged' WHERE id = ?",
        action.id,
      );
    const dispatchActionId =
      rule.delivery === 'dispatch'
        ? action.id
        : rule.delivery === 'dispatch-queued'
          ? queued!.id
          : null;
    if (dispatchActionId && phase) this.__setPhase(dispatchActionId, phase);
    return dispatchActionId;
  }

  /**
   * Checks a command on an existing thread against its kind's rule and records the state change
   * it makes.
   * @returns The queued action the command names, if any, and the phase its dispatch takes.
   * @throws
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   */
  private __admitToThread(
    action: IActionEnvelope,
    prepared: IAdmission['prepared'],
    rule: IAdmissionRule,
    now: number,
  ): { queued: IActionRow | null; phase: IActionPhase | null } {
    const command = action.command;
    let queued: IActionRow | null = null;
    let threadId: string;
    if (rule.target === 'queued') {
      if (!('queuedActionId' in command)) this._conflict();
      queued = this._action(command.queuedActionId);
      if (!queued || queued.kind !== 'queue' || queued.delivery !== 'queued' || !queued.thread_id)
        this._conflict();
      threadId = queued.thread_id;
      this._statements.run(
        'UPDATE agent_hq_action SET related_action_id = ? WHERE id = ?',
        queued.id,
        action.id,
      );
    } else if ('threadId' in command) threadId = command.threadId;
    else this._conflict();
    const thread = this._thread(threadId);
    if (!thread) this._conflict();
    this.__requireControl(rule.control, thread);
    if (
      ['message', 'queue', 'queue-send', 'workspace-change'].includes(command.kind) &&
      this._workspaces.hasPending(threadId, queued?.id ?? action.id)
    )
      this._conflict();
    if (rule.requiresNoPendingAction && thread.pending_action_id) this._conflict();
    // a close that interrupts a running turn first doesn't need an idle session
    const isInterrupting =
      command.kind === 'thread-close' &&
      command.interrupt === true &&
      thread.active_turn_id !== null;
    if (rule.requiresIdle && !isInterrupting) this.__requireIdle(thread);
    const expectedTurnId = 'expectedTurnId' in command ? command.expectedTurnId : null;
    if (rule.requiresActiveTurn && thread.active_turn_id !== expectedTurnId) this._conflict();
    let phase = rule.phase;
    switch (command.kind) {
      case 'thread-resume':
      case 'thread-recover': {
        const isCreating = command.kind === 'thread-recover' && command.recovery.kind === 'create';
        if (command.kind === 'thread-recover') {
          if (command.recovery.kind === 'create') {
            if (thread.native_id !== null) this._conflict();
          } else if (command.recovery.kind === 'attach') {
            if (
              thread.native_id !== null ||
              !prepared.nativeId ||
              prepared.nativeId !== command.recovery.nativeId
            )
              this._conflict();
            this._statements.run(
              'UPDATE agent_hq_thread SET native_id = ? WHERE id = ?',
              prepared.nativeId,
              threadId,
            );
          } else if (!thread.native_id) this._conflict();
        }
        if (isCreating) phase = 'create';
        this._statements.run(
          "UPDATE agent_hq_thread SET ownership = 'managed', runtime_epoch = ?, pending_action_id = ?, active_turn_id = NULL, state = ?, updated_at = ? WHERE id = ?",
          this._epoch,
          action.id,
          isCreating ? 'creating' : 'starting',
          now,
          threadId,
        );
        if (prepared.recoveryTurn !== undefined) {
          if (
            command.kind !== 'thread-recover' ||
            command.recovery.kind !== 'resume' ||
            thread.provider !== 'codex' ||
            thread.native_id !== prepared.nativeId
          )
            this._conflict();
          const latest = prepared.recoveryTurn;
          const isRunning = latest?.state === 'running';
          // bind before joining so a reissued native request finds the exact active turn
          this._statements.run(
            'UPDATE agent_hq_thread SET active_turn_id = ?, last_turn_id = ?, last_turn_state = ?, state = ? WHERE id = ?',
            isRunning ? latest.nativeTurnId : null,
            latest && !isRunning ? latest.nativeTurnId : thread.last_turn_id,
            latest && !isRunning ? latest.state : thread.last_turn_state,
            latest?.state ?? 'idle',
            threadId,
          );
          this._statements.run(
            "UPDATE agent_hq_action SET queue_ready = 0 WHERE thread_id = ? AND delivery = 'queued'",
            threadId,
          );
        }
        if (isCreating)
          this._statements.run(
            'UPDATE agent_hq_action SET requested_name = ? WHERE id = ?',
            thread.name,
            action.id,
          );
        break;
      }
      case 'thread-rename':
        if (!this._isNameAvailable(command.name, action.id, thread.id)) this._conflict();
        this._statements.run(
          'UPDATE agent_hq_thread SET pending_action_id = ? WHERE id = ?',
          action.id,
          threadId,
        );
        break;
      case 'thread-close':
        // the turn's end, once the interrupt stopped it, continues the close from clean
        if (isInterrupting) {
          if (thread.pending_action_id) this._conflict();
          phase = 'interrupt';
        }
        this._statements.run(
          'UPDATE agent_hq_thread SET pending_action_id = ? WHERE id = ?',
          action.id,
          threadId,
        );
        break;
      case 'message':
        if (prepared.input?.workspaceChange) {
          phase = 'workspace';
          this._statements.run(
            'UPDATE agent_hq_action SET queued_input = ? WHERE id = ?',
            JSON.stringify(prepared.input),
            action.id,
          );
        }
        this.__beginTurn(action.id, threadId);
        break;
      case 'workspace-change':
        if (
          thread.last_turn_id !== command.expectedTurnId ||
          thread.last_turn_state !== 'completed'
        )
          this._conflict();
        this._statements.run(
          'UPDATE agent_hq_thread SET pending_action_id = ?, updated_at = ? WHERE id = ?',
          action.id,
          now,
          thread.id,
        );
        break;
      case 'queue':
        this._statements.run(
          "UPDATE agent_hq_action SET delivery = 'queued', queued_input = ? WHERE id = ?",
          JSON.stringify(prepared.input ?? this._conflict()),
          action.id,
        );
        break;
      case 'queue-send':
        if (this._workspaces.get(queued!.id)) {
          if (
            queued!.expected_turn_id !== thread.last_turn_id ||
            thread.last_turn_state !== 'completed'
          )
            this._conflict();
          phase = 'workspace';
        }
        this.__beginTurn(queued!.id, threadId);
        break;
      case 'queue-cancel':
        this._workspaces.settle(queued!.id, 'failed');
        this._statements.run(
          "UPDATE agent_hq_action SET delivery = 'canceled', queued_input = NULL, queue_ready = 0, updated_at = ? WHERE id = ?",
          now,
          queued!.id,
        );
        break;
      case 'native-reply': {
        const approval = this._statements.get(
          "SELECT id FROM agent_hq_native_approval WHERE id = ? AND thread_id = ? AND native_turn_id = ? AND runtime_epoch = ? AND state = 'pending' AND reply_action_id IS NULL",
          command.approvalId,
          threadId,
          command.expectedTurnId,
          this._epoch,
        );
        if (!approval) this._conflict();
        this._statements.run(
          'UPDATE agent_hq_native_approval SET reply_action_id = ?, updated_at = ? WHERE id = ?',
          action.id,
          now,
          command.approvalId,
        );
        break;
      }
    }
    const change =
      command.kind === 'workspace-change'
        ? command.workspaceChange
        : prepared.input?.workspaceChange;
    if (
      (command.kind === 'message' ||
        command.kind === 'queue' ||
        command.kind === 'workspace-change') &&
      change
    ) {
      if (change.expectedWorkspaceRoot !== thread.workspace_root) this._conflict();
      this._workspaces.prepare(action.id, thread.id, change, now);
    }
    if (rule.stops) {
      this._statements.run(
        "UPDATE agent_hq_thread SET state = 'stopping', updated_at = ? WHERE id = ?",
        now,
        threadId,
      );
      this._statements.run(
        "UPDATE agent_hq_action SET queue_ready = 0 WHERE thread_id = ? AND delivery = 'queued'",
        threadId,
      );
    }
    return { queued, phase };
  }

  /** Records the native step an action dispatches in, which its native request names. */
  private __setPhase(actionId: string, phase: IActionPhase): void {
    this._statements.run('UPDATE agent_hq_action SET phase = ? WHERE id = ?', phase, actionId);
  }

  /**
   * Admits the deletion of a native session no process runs. A session HQ runs is closed first,
   * from clean, so it must be idle; a session HQ closed must have no action of this runtime in
   * flight; and a session HQ doesn't manage has no record to check here.
   * @returns The phase the deletion starts in.
   * @throws
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   */
  private __admitDelete(
    actionId: string,
    prepared: IAdmission['prepared'],
    now: number,
  ): IActionPhase {
    const action = this._action(actionId)!;
    if (!prepared.workspaceRoot || !prepared.nativeId || !action.provider) this._conflict();
    const thread = this._nativeThread(action.provider, prepared.nativeId);
    if (!thread) return 'delete';
    if (thread.workspace_root !== prepared.workspaceRoot) this._conflict();
    this._statements.run(
      'UPDATE agent_hq_action SET thread_id = ? WHERE id = ?',
      thread.id,
      actionId,
    );
    if (thread.runtime_epoch === this._epoch) {
      this.__requireControl('owned', thread);
      this.__requireIdle(thread);
      this._statements.run(
        "UPDATE agent_hq_thread SET pending_action_id = ?, state = 'stopping', updated_at = ? WHERE id = ?",
        actionId,
        now,
        thread.id,
      );
      this._statements.run(
        "UPDATE agent_hq_action SET queue_ready = 0 WHERE thread_id = ? AND delivery = 'queued'",
        thread.id,
      );
      return 'clean';
    }
    if (
      thread.ownership !== 'managed' ||
      thread.state !== 'inactive' ||
      thread.runtime_epoch !== null ||
      this.__hasActionInFlight(thread)
    )
      this._conflict();
    this._statements.run(
      'UPDATE agent_hq_thread SET pending_action_id = ? WHERE id = ?',
      actionId,
      thread.id,
    );
    return 'delete';
  }

  /** Tells whether an action of this runtime holds a thread its runtime released. */
  private __hasActionInFlight(thread: IThreadRow): boolean {
    return (
      thread.pending_action_id !== null &&
      this._action(thread.pending_action_id)?.runtime_epoch === this._epoch
    );
  }

  /**
   * Registers the new thread a create or adoption controls, before its native session exists. A
   * create's first input waits on the action as its queued input until its turn delivers it, and a
   * browser submission of the create selected the session it makes.
   */
  private __register(
    actionId: string,
    command: Extract<ICommand, { kind: 'thread-create' | 'thread-adopt' }>,
    prepared: IAdmission['prepared'],
    now: number,
  ): void {
    const provider = command.provider;
    const name = this._suggestName(command.name);
    if (!prepared.workspaceRoot) this._conflict();
    const nativeId = command.kind === 'thread-adopt' ? prepared.nativeId : null;
    if (command.kind === 'thread-adopt' && (!nativeId || nativeId !== command.nativeId))
      this._conflict();
    if (nativeId && this._nativeThread(provider, nativeId)) this._conflict();
    const threadId = randomUUID();
    this._statements.run(
      `INSERT INTO agent_hq_thread (id, provider, native_id, name, workspace_root, ownership, runtime_epoch, pending_action_id, state, registration_action_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'managed', ?, ?, ?, ?, ?, ?)`,
      threadId,
      provider,
      nativeId ?? null,
      name,
      prepared.workspaceRoot,
      this._epoch,
      actionId,
      nativeId ? 'starting' : 'creating',
      actionId,
      now,
      now,
    );
    this._statements.run(
      'UPDATE agent_hq_action SET thread_id = ?, requested_name = ?, provider = ? WHERE id = ?',
      threadId,
      name,
      provider,
      actionId,
    );
    if (prepared.input) {
      this._statements.run(
        'UPDATE agent_hq_action SET queued_input = ? WHERE id = ?',
        JSON.stringify(prepared.input),
        actionId,
      );
      this._statements.run(
        `UPDATE agent_hq_browser_action SET native_thread_id = ?, native_input_sha256 = coalesce(native_input_sha256, ?)
        WHERE native_action_id = ? AND native_thread_id IS NULL`,
        threadId,
        hashValue(prepared.input.text),
        actionId,
      );
    }
  }

  /** Requires the control the rule names over the thread. */
  private __requireControl(control: IAdmissionRule['control'], thread: IThreadRow): void {
    if (control === null) return;
    if (control === 'owned') {
      if (
        thread.ownership !== 'managed' ||
        thread.runtime_epoch !== this._epoch ||
        !thread.native_id
      )
        this._conflict();
      return;
    }
    if (control === 'attached') {
      if (thread.runtime_epoch !== this._epoch || !thread.native_id) this._conflict();
      return;
    }
    if (thread.pending_action_id && thread.runtime_epoch === this._epoch) this._conflict();
    // a session HQ closed may be deleted by an action of this runtime
    if (this.__hasActionInFlight(thread)) this._conflict();
    if (control === 'resumable') {
      if (
        thread.ownership !== 'managed' ||
        thread.state !== 'inactive' ||
        thread.runtime_epoch !== null ||
        !thread.native_id
      )
        this._conflict();
    } else if (thread.ownership !== 'uncertain' || thread.runtime_epoch === this._epoch)
      this._conflict();
  }

  private __requireIdle(thread: IThreadRow): void {
    if (
      thread.active_turn_id ||
      thread.pending_action_id ||
      !['idle', 'completed', 'failed', 'interrupted'].includes(thread.state)
    )
      this._conflict();
  }

  /** Starts the turn an action's input begins, holding the thread until native acknowledges it. */
  private __beginTurn(actionId: string, threadId: string): void {
    const now = Date.now();
    this._statements.run(
      "UPDATE agent_hq_action SET delivery = 'submitted', runtime_epoch = ?, native_turn_id = NULL, completion = NULL, queue_ready = 0, updated_at = ? WHERE id = ?",
      this._epoch,
      now,
      actionId,
    );
    this._statements.run(
      "UPDATE agent_hq_thread SET state = 'starting', pending_action_id = ?, updated_at = ? WHERE id = ?",
      actionId,
      now,
      threadId,
    );
  }
}
