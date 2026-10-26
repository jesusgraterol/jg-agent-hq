import type { DatabaseSync } from 'node:sqlite';
import { Exception } from 'jg-exception';
import { z } from 'zod';

import {
  PlanMilestoneSchema,
  ActionPlanContextSchema,
  type IActionPlanContext,
} from '../../contracts/index.js';
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
    const row = this.__database
      .prepare('SELECT intent FROM hq_plan_operation WHERE id = ?')
      .get(id);
    return row ? PlanWriteIntentSchema.parse(JSON.parse(z.string().parse(row.intent))) : null;
  }

  /**
   * Records immutable action identity before any authoritative file is changed.
   * @throws
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   */
  public prepare(intent: IPlanWriteIntent): IPlanWriteIntent {
    const previous = this.getIntent(intent.id);
    if (previous) {
      if (previous.digest !== intent.digest || previous.directory !== intent.directory)
        throw new Exception('The HQ action conflicts with its recorded state', {
          code: 'JG_AGENT_HQ_ACTION_CONFLICT',
          data: {
            kind: 'state-conflict',
          },
        });
      return previous;
    }
    const unfinished = this.__database
      .prepare("SELECT id FROM hq_plan_operation WHERE directory = ? AND state = 'prepared'")
      .get(intent.directory);
    if (unfinished)
      throw new Exception('The HQ action conflicts with its recorded state', {
        code: 'JG_AGENT_HQ_ACTION_CONFLICT',
        data: {
          kind: 'state-conflict',
        },
      });
    this.__database
      .prepare('INSERT INTO hq_plan_operation (id, directory, state, intent) VALUES (?, ?, ?, ?)')
      .run(intent.id, intent.directory, 'prepared', JSON.stringify(intent));
    return intent;
  }

  /**
   * Drops completed write bodies while retaining durable replay identity.
   * @throws
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   */
  public complete(id: string): void {
    const intent = this.getIntent(id);
    if (!intent)
      throw new Exception('The HQ action conflicts with its recorded state', {
        code: 'JG_AGENT_HQ_ACTION_CONFLICT',
        data: {
          kind: 'state-conflict',
        },
      });
    intent.state = 'completed';
    intent.coordination = '';
    intent.plan = null;
    intent.milestones = { operation: 'keep' };
    this.__database
      .prepare("UPDATE hq_plan_operation SET state = 'completed', intent = ? WHERE id = ?")
      .run(JSON.stringify(intent), id);
  }

  /** Reads unresolved write state without loading its contents. */
  public getPendingId(directory: string): string | null {
    const row = this.__database
      .prepare(
        "SELECT id FROM hq_plan_operation WHERE directory = ? AND state = 'prepared' LIMIT 1",
      )
      .get(directory);
    return row ? z.string().parse(row.id) : null;
  }

  /** Replaces only a selected plan's derived milestone rows in one transaction. */
  public project(projection: IPlanProjection): void {
    const current = this.__database
      .prepare('SELECT source_hash FROM hq_plan_projection WHERE directory = ?')
      .get(projection.directory);
    if (current && current.source_hash === projection.sourceHash) return;
    this.__database.exec('BEGIN IMMEDIATE');
    try {
      this.__database
        .prepare('DELETE FROM hq_plan_milestone WHERE directory = ?')
        .run(projection.directory);
      const insert = this.__database.prepare(
        'INSERT INTO hq_plan_milestone (directory, ordinal, milestone) VALUES (?, ?, ?)',
      );
      for (const milestone of projection.milestones)
        insert.run(projection.directory, milestone.ordinal, JSON.stringify(milestone));
      this.__database
        .prepare(
          'INSERT INTO hq_plan_projection (directory, source_hash) VALUES (?, ?) ON CONFLICT(directory) DO UPDATE SET source_hash = excluded.source_hash',
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
        'SELECT milestone FROM hq_plan_milestone WHERE directory = ? AND ordinal > ? ORDER BY ordinal LIMIT ?',
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
  /** Records a plan directory for snapshot capture; an existing registration is kept. */
  public register(directory: string): void {
    this.__database
      .prepare(
        'INSERT INTO hq_plan_registration (directory) VALUES (?) ON CONFLICT(directory) DO NOTHING',
      )
      .run(directory);
  }

  /** Resolves one thread's current guided scope without trusting its display label. */
  public getThreadPlan(threadId: string): IActionPlanContext | null {
    const row = this.__database
      .prepare('SELECT context FROM hq_thread_plan WHERE thread_id = ?')
      .get(threadId);
    return row ? ActionPlanContextSchema.parse(JSON.parse(z.string().parse(row.context))) : null;
  }

  /** Finds the bounded managed/uncertain cohort that must stop before this plan can be edited. */
  public getPlanThreads(directory: string): string[] {
    const rows = this.__database
      .prepare(
        "SELECT hq_thread.id FROM hq_thread_plan INNER JOIN hq_thread ON hq_thread.id = hq_thread_plan.thread_id WHERE hq_thread_plan.directory = ? AND (hq_thread.runtime_epoch IS NOT NULL OR hq_thread.ownership = 'uncertain') ORDER BY hq_thread.id LIMIT 33",
      )
      .all(directory);
    if (rows.length > 32)
      throw new Exception('The HQ action conflicts with its recorded state', {
        code: 'JG_AGENT_HQ_ACTION_CONFLICT',
        data: {
          kind: 'state-conflict',
        },
      });
    return rows.map((row) => z.string().parse(row.id));
  }

  /**
   * Binds guided input inside the caller's existing admission savepoint.
   * @throws
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   */
  public bindThread(threadId: string, context: IActionPlanContext): void {
    if (!context.scope) return;
    const execution = context.scope.kind === 'execution' ? context.scope : null;
    if (execution) {
      const other = this.__database
        .prepare(
          'SELECT hq_thread.id, hq_thread.state, hq_thread.ownership, hq_thread.runtime_epoch FROM hq_thread_plan INNER JOIN hq_thread ON hq_thread.id = hq_thread_plan.thread_id WHERE hq_thread_plan.authorization_id = ? AND hq_thread_plan.milestone_id IS ? AND hq_thread_plan.thread_id != ? LIMIT 1',
        )
        .get(execution.authorizationId, execution.milestoneId, threadId);
      if (other) {
        if (
          other.state !== 'inactive' ||
          other.ownership !== 'managed' ||
          other.runtime_epoch !== null
        )
          throw new Exception('The HQ action conflicts with its recorded state', {
            code: 'JG_AGENT_HQ_ACTION_CONFLICT',
            data: {
              kind: 'state-conflict',
            },
          });
        this.__database
          .prepare('DELETE FROM hq_thread_plan WHERE thread_id = ?')
          .run(z.string().parse(other.id));
      }
    }
    this.__database
      .prepare(
        'INSERT INTO hq_thread_plan (thread_id, directory, context, authorization_id, milestone_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET directory = excluded.directory, context = excluded.context, authorization_id = excluded.authorization_id, milestone_id = excluded.milestone_id',
      )
      .run(
        threadId,
        context.directory,
        JSON.stringify(context),
        execution?.authorizationId ?? null,
        execution?.milestoneId ?? null,
      );
  }
}
