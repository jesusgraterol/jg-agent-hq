import type { DatabaseSync } from 'node:sqlite';
import { Exception } from 'error-message-utils';
import { z } from 'zod';

import { PlanMilestoneSchema } from '../../contracts/index.js';
import {
  PlanWriteIntentSchema,
  type IPlanWriteIntent,
  type IPlanProjection,
} from '../../plans/index.js';

/** Owns selected-plan projections and write replay identities inside the SQLite worker. */
export class PlansModel {
  private readonly __database: DatabaseSync;

  /** Uses the existing worker connection without owning its lifecycle. */
  public constructor(database: DatabaseSync) {
    this.__database = database;
  }

  /**
   * Returns a previously admitted write, including a resumable prepared intent.
   */
  public getIntent(id: string): IPlanWriteIntent | null {
    const row = this.__database.prepare('SELECT intent FROM plan_operation WHERE id = ?').get(id);
    return row ? PlanWriteIntentSchema.parse(JSON.parse(z.string().parse(row.intent))) : null;
  }

  /**
   * Records immutable action identity before any authoritative file is changed.
   * @throws
   * - -1: The HQ action conflicts with its recorded state
   */
  public prepare(intent: IPlanWriteIntent): IPlanWriteIntent {
    const previous = this.getIntent(intent.id);
    if (previous) {
      if (previous.digest !== intent.digest || previous.directory !== intent.directory)
        throw new Exception('The HQ action conflicts with its recorded state', undefined, {
          kind: 'state-conflict',
        });
      return previous;
    }
    const unfinished = this.__database
      .prepare("SELECT id FROM plan_operation WHERE directory = ? AND state = 'prepared'")
      .get(intent.directory);
    if (unfinished)
      throw new Exception('The HQ action conflicts with its recorded state', undefined, {
        kind: 'state-conflict',
      });
    this.__database
      .prepare('INSERT INTO plan_operation (id, directory, state, intent) VALUES (?, ?, ?, ?)')
      .run(intent.id, intent.directory, 'prepared', JSON.stringify(intent));
    return intent;
  }

  /**
   * Drops completed write bodies while retaining durable replay identity.
   * @throws
   * - -1: The HQ action conflicts with its recorded state
   */
  public complete(id: string): void {
    const intent = this.getIntent(id);
    if (!intent)
      throw new Exception('The HQ action conflicts with its recorded state', undefined, {
        kind: 'state-conflict',
      });
    intent.state = 'completed';
    intent.coordination = '';
    intent.milestones = null;
    this.__database
      .prepare("UPDATE plan_operation SET state = 'completed', intent = ? WHERE id = ?")
      .run(JSON.stringify(intent), id);
  }

  /** Reads unresolved write state without loading its contents. */
  public getPendingId(directory: string): string | null {
    const row = this.__database
      .prepare("SELECT id FROM plan_operation WHERE directory = ? AND state = 'prepared' LIMIT 1")
      .get(directory);
    return row ? z.string().parse(row.id) : null;
  }

  /** Replaces only a selected plan's derived milestone rows in one transaction. */
  public project(projection: IPlanProjection): void {
    const current = this.__database
      .prepare('SELECT source_hash FROM plan_projection WHERE directory = ?')
      .get(projection.directory);
    if (current && current.source_hash === projection.sourceHash) return;
    this.__database.exec('BEGIN IMMEDIATE');
    try {
      this.__database
        .prepare('DELETE FROM plan_milestone WHERE directory = ?')
        .run(projection.directory);
      const insert = this.__database.prepare(
        'INSERT INTO plan_milestone (directory, ordinal, milestone) VALUES (?, ?, ?)',
      );
      for (const milestone of projection.milestones)
        insert.run(projection.directory, milestone.ordinal, JSON.stringify(milestone));
      this.__database
        .prepare(
          'INSERT INTO plan_projection (directory, source_hash) VALUES (?, ?) ON CONFLICT(directory) DO UPDATE SET source_hash = excluded.source_hash',
        )
        .run(projection.directory, projection.sourceHash);
      this.__database.exec('COMMIT');
    } catch (error) {
      this.__database.exec('ROLLBACK');
      throw error;
    }
  }

  /** Reads a bounded ordinal seek page from the selected, revision-guarded projection. */
  public list(
    directory: string,
    limit: number,
    after: number,
  ): { data: z.infer<typeof PlanMilestoneSchema>[]; hasMore: boolean } {
    const rows = this.__database
      .prepare(
        'SELECT milestone FROM plan_milestone WHERE directory = ? AND ordinal > ? ORDER BY ordinal LIMIT ?',
      )
      .all(directory, after, limit + 1);
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return {
      data: rows.map((row) =>
        PlanMilestoneSchema.parse(JSON.parse(z.string().parse(row.milestone))),
      ),
      hasMore,
    };
  }
}
