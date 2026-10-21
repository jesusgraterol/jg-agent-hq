import { createHmac, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Exception } from 'error-message-utils';
import { z } from 'zod';

import {
  BrowserReceiptSchema,
  type IBrowserAction,
  type IBrowserReceipt,
} from '../../contracts/index.js';

const RecordSchema = z.object({ digest: z.string(), operator_id: z.string(), receipt: z.string() });

/** Owns host-action nonces on the existing SQLite worker, without retaining message bodies. */
export class BrowserModel {
  private readonly __database: DatabaseSync;
  private readonly __epoch: string;
  private readonly __key: Uint8Array;

  /** Quarantines work whose former process can no longer establish its outcome. */
  public constructor(database: DatabaseSync, epoch: string, key: Uint8Array) {
    this.__database = database;
    this.__epoch = epoch;
    this.__key = key;
    database
      .prepare(
        `UPDATE browser_action SET receipt = json_set(receipt, '$.state', 'uncertain', '$.updatedAt', ?)
      WHERE json_extract(receipt, '$.runtimeEpoch') != ? AND json_extract(receipt, '$.state') = 'submitted'`,
      )
      .run(Date.now(), epoch);
  }

  /** Reads only the authenticated operator's selected receipt. */
  public get(id: string, operatorId: string): IBrowserReceipt | null {
    const row = this.__database
      .prepare('SELECT receipt FROM browser_action WHERE id = ? AND operator_id = ?')
      .get(id, operatorId);
    return row ? BrowserReceiptSchema.parse(JSON.parse(z.string().parse(row.receipt))) : null;
  }

  /**
   * Persists one intent before invoking any host effect; replay never runs it a second time.
   * @throws
   * - -1: The HQ action conflicts with its recorded state
   */
  public admit(
    action: IBrowserAction,
    operatorId: string,
  ): { receipt: IBrowserReceipt; isNew: boolean } {
    const digest = createHmac('sha256', this.__key).update(JSON.stringify(action)).digest('hex');
    const previous = this.__database
      .prepare('SELECT digest, operator_id, receipt FROM browser_action WHERE id = ?')
      .get(action.id);
    if (previous) {
      const record = RecordSchema.parse(previous);
      if (record.digest !== digest || record.operator_id !== operatorId) this.__conflict();
      return { receipt: BrowserReceiptSchema.parse(JSON.parse(record.receipt)), isNew: false };
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
    this.__database
      .prepare('INSERT INTO browser_action (id, operator_id, digest, receipt) VALUES (?, ?, ?, ?)')
      .run(action.id, operatorId, digest, JSON.stringify(receipt));
    return { receipt, isNew: true };
  }

  /** Records acknowledgement or uncertainty; a lost response never authorizes another effect. */
  public settle(
    id: string,
    operatorId: string,
    state: 'acknowledged' | 'uncertain',
  ): IBrowserReceipt | null {
    this.__database
      .prepare(
        `UPDATE browser_action SET receipt = json_set(receipt, '$.state', ?, '$.updatedAt', ?)
      WHERE id = ? AND operator_id = ? AND json_extract(receipt, '$.state') = 'submitted'`,
      )
      .run(state, Date.now(), id, operatorId);
    return this.get(id, operatorId);
  }

  private __conflict(): never {
    throw new Exception('The HQ action conflicts with its recorded state', undefined, {
      kind: 'state-conflict',
    });
  }
}
