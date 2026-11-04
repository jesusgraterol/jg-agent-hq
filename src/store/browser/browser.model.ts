import { randomUUID } from 'node:crypto';
import { hashValue, signHmac } from 'jg-crypto';

import type { IBrowserAction, IBrowserReceipt } from '../../contracts/index.js';
import { HQ_ERRORS } from '../../errors/index.js';

import type { IStatements } from '../utilities.js';

// a receipt's columns, which mirror its public fields without the native action's own receipt
type IReceiptRow = {
  id: string;
  runtime_epoch: string;
  kind: IBrowserReceipt['kind'];
  state: IBrowserReceipt['state'];
  native_action_id: string;
  created_at: number;
  updated_at: number;
};
const RECEIPT_COLUMNS = 'id, runtime_epoch, kind, state, native_action_id, created_at, updated_at';

/** Converts a stored receipt; the native action's own receipt is read separately. */
const toReceipt = (row: IReceiptRow): IBrowserReceipt => ({
  id: row.id,
  runtimeEpoch: row.runtime_epoch,
  kind: row.kind,
  state: row.state,
  nativeActionId: row.native_action_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  native: null,
});

/** Owns host-action nonces on the existing SQLite worker, without retaining message bodies. */
export class BrowserModel {
  private readonly __statements: IStatements;
  private readonly __epoch: string;
  private readonly __key: Uint8Array;

  /** Quarantines work whose former process can no longer establish its outcome. */
  public constructor(statements: IStatements, epoch: string, key: Uint8Array) {
    this.__statements = statements;
    this.__epoch = epoch;
    this.__key = key;
    statements.run(
      "UPDATE agent_hq_browser_action SET state = 'uncertain', updated_at = ? WHERE runtime_epoch != ? AND state = 'submitted'",
      Date.now(),
      epoch,
    );
  }

  /** Reads only the authenticated operator's selected receipt. */
  public get(id: string, operatorId: string): IBrowserReceipt | null {
    const row = this.__statements.get<IReceiptRow>(
      `SELECT ${RECEIPT_COLUMNS} FROM agent_hq_browser_action WHERE id = ? AND operator_id = ?`,
      id,
      operatorId,
    );
    return row ? toReceipt(row) : null;
  }

  /**
   * Persists one intent before invoking any host effect; replay never runs it a second time.
   * @throws
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   */
  public admit(
    action: IBrowserAction,
    operatorId: string,
  ): { receipt: IBrowserReceipt; isNew: boolean } {
    const digest = signHmac(JSON.stringify(action), this.__key);
    const previous = this.__statements.get<IReceiptRow & { digest: string; operator_id: string }>(
      `SELECT ${RECEIPT_COLUMNS}, digest, operator_id FROM agent_hq_browser_action WHERE id = ?`,
      action.id,
    );
    if (previous) {
      if (previous.digest !== digest || previous.operator_id !== operatorId) this.__conflict();
      return { receipt: toReceipt(previous), isNew: false };
    }
    if (action.runtimeEpoch !== this.__epoch) this.__conflict();
    const now = Date.now();
    const receipt: IBrowserReceipt = {
      id: action.id,
      runtimeEpoch: this.__epoch,
      kind: action.command.kind,
      state: 'submitted',
      nativeActionId: randomUUID(),
      createdAt: now,
      updatedAt: now,
      native: null,
    };
    const native = action.command.kind === 'native' ? action.command.action.command : null;
    const nativeText =
      native?.kind === 'steer'
        ? native.text
        : native &&
            (native.kind === 'message' || native.kind === 'queue') &&
            native.input.kind === 'text'
          ? native.input.text
          : null;
    this.__statements.run(
      'INSERT INTO agent_hq_browser_action (id, operator_id, digest, runtime_epoch, kind, state, native_action_id, native_thread_id, native_input_sha256, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      action.id,
      operatorId,
      digest,
      receipt.runtimeEpoch,
      receipt.kind,
      receipt.state,
      receipt.nativeActionId,
      native && 'threadId' in native ? native.threadId : null,
      nativeText === null ? null : hashValue(nativeText),
      now,
      now,
    );
    return { receipt, isNew: true };
  }

  /** Records acknowledgement or uncertainty; a lost response never authorizes another effect. */
  public settle(
    id: string,
    operatorId: string,
    state: 'acknowledged' | 'uncertain',
  ): IBrowserReceipt | null {
    this.__statements.run(
      "UPDATE agent_hq_browser_action SET state = ?, updated_at = ? WHERE id = ? AND operator_id = ? AND state = 'submitted'",
      state,
      Date.now(),
      id,
      operatorId,
    );
    return this.get(id, operatorId);
  }

  private __conflict(): never {
    throw HQ_ERRORS.create('actionConflict', {
      data: { kind: 'state-conflict' },
    });
  }
}
