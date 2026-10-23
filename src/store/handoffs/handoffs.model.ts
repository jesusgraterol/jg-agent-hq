import type { DatabaseSync } from 'node:sqlite';
import { Exception } from 'jg-exception';
import { z } from 'zod';

import {
  ActionReceiptSchema,
  type IHandoffFindings,
  type IHandoffPhase,
  type IHandoffSummary,
} from '../../contracts/index.js';
import {
  HandoffRecordSchema,
  HandoffDispatchSchema,
  handoffDelivery,
  type IHandoffRecord,
  type IHandoffDispatch,
  type IHandoffPageRequest,
} from '../../handoffs/index.js';

const SummaryRecordSchema = HandoffRecordSchema.omit({ findings: true });
const DeliveryRowSchema = z.object({
  id: z.uuid(),
  delivery: ActionReceiptSchema.shape.delivery,
  completion: ActionReceiptSchema.shape.completion,
  native_turn_id: ActionReceiptSchema.shape.nativeTurnId,
  thread_id: z.uuid().nullable(),
});

const conflict = (): never => {
  throw new Exception('The HQ action conflicts with its recorded state', {
    code: 'JG_AGENT_HQ_ACTION_CONFLICT',
    data: {
      kind: 'state-conflict',
    },
  });
};

/** Stores bounded handoff evidence and immutable action intents on the existing worker connection. */
export class HandoffsModel {
  private readonly __database: DatabaseSync;
  /** Uses the existing worker connection without owning its lifecycle. */
  public constructor(database: DatabaseSync) {
    this.__database = database;
  }

  /** Reads a selected intent without loading any conversation history. */
  public get(id: string): IHandoffRecord | null {
    const row = this.__database.prepare('SELECT intent FROM hq_handoff WHERE id = ?').get(id);
    return row ? HandoffRecordSchema.parse(JSON.parse(z.string().parse(row.intent))) : null;
  }

  /**
   * Keeps the first identical creation intent, including its original runtime and native action.
   * @throws
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   */
  public prepare(record: IHandoffRecord): IHandoffRecord {
    const previous = this.get(record.id);
    if (previous) {
      if (previous.digest !== record.digest) conflict();
      return previous;
    }
    this.__database
      .prepare(
        'INSERT INTO hq_handoff (id, workspace_root, source_thread_id, created_at, intent) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        record.id,
        record.source.workspaceRoot,
        record.source.threadId,
        record.createdAt,
        JSON.stringify(record),
      );
    return record;
  }

  /** Reads only a selected phase's immutable native dispatch. */
  public getDispatch(id: string, phase: IHandoffPhase): IHandoffDispatch | null {
    const row = this.__database
      .prepare('SELECT intent FROM hq_handoff_dispatch WHERE handoff_id = ? AND phase = ?')
      .get(id, phase);
    return row ? HandoffDispatchSchema.parse(JSON.parse(z.string().parse(row.intent))) : null;
  }

  /**
   * Serializes concurrent sends before native admission; never creates a replacement action.
   * @throws
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   */
  public prepareDispatch(dispatch: IHandoffDispatch): IHandoffDispatch {
    const previous = this.getDispatch(dispatch.handoffId, dispatch.phase);
    if (previous) {
      if (previous.previewDigest !== dispatch.previewDigest) conflict();
      return previous;
    }
    if (!this.get(dispatch.handoffId)) conflict();
    this.__database
      .prepare(
        'INSERT INTO hq_handoff_dispatch (handoff_id, phase, action_id, intent) VALUES (?, ?, ?, ?)',
      )
      .run(dispatch.handoffId, dispatch.phase, dispatch.action.id, JSON.stringify(dispatch));
    return dispatch;
  }

  /**
   * Saves one native message as bounded findings; a changed message requires another handoff.
   * @throws
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   */
  public collect(id: string, findings: IHandoffFindings): IHandoffRecord {
    const record = this.get(id);
    if (!record) conflict();
    if (record!.findings && JSON.stringify(record!.findings) !== JSON.stringify(findings))
      conflict();
    record!.findings = findings;
    this.__database
      .prepare('UPDATE hq_handoff SET intent = ? WHERE id = ?')
      .run(JSON.stringify(record), id);
    return record!;
  }

  /** Reads a deterministic seek page; equal timestamps use the immutable UUID tie-breaker. */
  public list(page: IHandoffPageRequest): { data: IHandoffSummary[]; hasMore: boolean } {
    const filters = ['workspace_root = ?'];
    const parameters: (string | number)[] = [page.workspaceRoot];
    if (page.sourceThreadId) {
      filters.push('source_thread_id = ?');
      parameters.push(page.sourceThreadId);
    }
    if (page.after) {
      filters.push('(created_at < ? OR (created_at = ? AND id < ?))');
      parameters.push(page.after.createdAt, page.after.createdAt, page.after.id);
    }
    parameters.push(page.limit + 1);
    const rows = this.__database
      .prepare(
        "SELECT json_remove(intent, '$.findings') AS intent, json_type(intent, '$.findings') != 'null' AS has_findings FROM hq_handoff WHERE " +
          filters.join(' AND ') +
          ' ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(...parameters);
    const hasMore = rows.length > page.limit;
    if (hasMore) rows.pop();
    return {
      data: rows.map((row) =>
        this.__summary(
          SummaryRecordSchema.parse(JSON.parse(z.string().parse(row.intent))),
          row.has_findings === 1,
        ),
      ),
      hasMore,
    };
  }

  private __summary(
    record: Omit<IHandoffRecord, 'findings'>,
    hasFindings: boolean,
  ): IHandoffSummary {
    const receipt = (id: string) => {
      const row = this.__database
        .prepare(
          'SELECT id, delivery, completion, native_turn_id, thread_id FROM hq_action WHERE id = ?',
        )
        .get(id);
      const parsed = row ? DeliveryRowSchema.parse(row) : null;
      return parsed ? { ...parsed, nativeTurnId: parsed.native_turn_id } : null;
    };
    const creation = receipt(record.creation.id);
    const review = this.getDispatch(record.id, 'review');
    const feedback = this.getDispatch(record.id, 'feedback');
    const target = creation?.thread_id
      ? this.__database
          .prepare('SELECT id, native_id FROM hq_thread WHERE id = ?')
          .get(creation.thread_id)
      : null;
    return {
      id: record.id,
      purpose: record.purpose,
      source: record.source,
      targetThreadId: review?.destination.threadId ?? (target ? z.uuid().parse(target.id) : null),
      targetNativeId:
        review?.destination.nativeId ??
        (target ? z.string().nullable().parse(target.native_id) : null),
      targetProvider: record.source.provider === 'codex' ? 'claude' : 'codex',
      creation: handoffDelivery(creation),
      review: handoffDelivery(review ? receipt(review.action.id) : null),
      feedback: handoffDelivery(feedback ? receipt(feedback.action.id) : null),
      hasFindings,
      createdAt: record.createdAt,
    };
  }
}
