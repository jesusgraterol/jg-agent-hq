import type { DatabaseSync } from 'node:sqlite';

import type { IActionReceipt, IManagedThread } from '../../contracts/index.js';
import { HQ_ERRORS } from '../../errors/index.js';
import { suffixThreadName } from '../../sessions/names/index.js';

import type { IStatements } from '../utilities.js';

import { ACTION_RECEIPT_COLUMNS, CONTROLLED_THREAD_CAPACITY, THREAD_COLUMNS } from './constants.js';
import { toActionReceipt, toManagedThread } from './transformers.js';
import type { IActionReceiptRow, IThreadRow } from './types.js';

/**
 * Owns the control ledger's shared records inside the dedicated SQLite worker. Its reads,
 * admission, native outcomes, native observations and runtime lifecycle extend it, each running
 * its synchronous transactions on the one worker connection.
 */
export abstract class ControlModel {
  protected readonly _database: DatabaseSync;
  protected readonly _statements: IStatements;
  protected readonly _epoch: string;
  protected readonly _digestKey: Uint8Array;

  /** Uses the existing worker connection without owning its lifecycle. */
  public constructor(
    database: DatabaseSync,
    statements: IStatements,
    runtimeEpoch: string,
    digestKey: Uint8Array,
  ) {
    this._database = database;
    this._statements = statements;
    this._epoch = runtimeEpoch;
    this._digestKey = digestKey;
  }

  /** Returns one receipt, including an undelivered queue body when present. */
  protected _receipt(id: string): IActionReceipt | null {
    const action = this._action(id);
    return action ? toActionReceipt(action) : null;
  }

  /** Returns one control record by immutable identity. */
  protected _managedThread(id: string): IManagedThread | null {
    const thread = this._thread(id);
    return thread ? toManagedThread(thread) : null;
  }

  /** Finds a free label against assigned names and pending native renames. */
  protected _suggestName(name: string): string {
    let candidate = name;
    let ordinal = 2;
    while (!this._isNameAvailable(candidate, '', null)) {
      candidate = suffixThreadName(name, ordinal++);
    }
    return candidate;
  }

  protected _thread(id: string): IThreadRow | null {
    return (
      this._statements.get<IThreadRow>(
        `SELECT ${THREAD_COLUMNS} FROM agent_hq_thread WHERE id = ?`,
        id,
      ) ?? null
    );
  }

  protected _action(id: string): IActionReceiptRow | null {
    return (
      this._statements.get<IActionReceiptRow>(
        `SELECT ${ACTION_RECEIPT_COLUMNS} FROM agent_hq_action WHERE id = ?`,
        id,
      ) ?? null
    );
  }

  protected _nativeThread(
    provider: IManagedThread['provider'],
    nativeId: string,
  ): IThreadRow | null {
    return (
      this._statements.get<IThreadRow>(
        `SELECT ${THREAD_COLUMNS} FROM agent_hq_thread WHERE provider = ? AND native_id = ?`,
        provider,
        nativeId,
      ) ?? null
    );
  }

  protected _availableSlot(): void {
    const owners = this._statements.all(
      'SELECT id FROM agent_hq_thread WHERE runtime_epoch = ? LIMIT ?',
      this._epoch,
      CONTROLLED_THREAD_CAPACITY,
    );
    if (owners.length >= CONTROLLED_THREAD_CAPACITY) this._conflict();
  }

  protected _isNameAvailable(name: string, actionId: string, threadId: string | null): boolean {
    const assigned = this._statements.get(
      'SELECT id FROM agent_hq_thread WHERE name = ? COLLATE NOCASE AND (? IS NULL OR id != ?) LIMIT 1',
      name,
      threadId,
      threadId,
    );
    const reserved = this._statements.get(
      "SELECT agent_hq_action.id FROM agent_hq_action INNER JOIN agent_hq_thread ON agent_hq_thread.pending_action_id = agent_hq_action.id WHERE agent_hq_action.requested_name = ? AND agent_hq_action.delivery IN ('submitted', 'uncertain') AND agent_hq_action.id != ? LIMIT 1",
      name,
      actionId,
    );
    return !assigned && !reserved;
  }

  protected _conflict(): never {
    throw HQ_ERRORS.create('actionConflict', {
      data: { kind: 'state-conflict' },
    });
  }

  /** Keeps an operation's records and their related state changes in one transaction. */
  protected _transaction<T>(operation: () => T): T {
    this._database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this._database.exec('COMMIT');
      return result;
    } catch (error) {
      this._database.exec('ROLLBACK');
      throw error;
    }
  }
}
