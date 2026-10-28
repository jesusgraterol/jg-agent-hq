import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import {
  SessionStateSchema,
  SessionTransitionSchema,
  type ISessionState,
  type ISessionTransition,
} from '../../contracts/index.js';

import { ActiveSessionRecordSchema, type IActiveSessionRecord } from './types.js';

// closed observed sessions are forgotten after the same seven days that transitions are kept
const RETENTION_MS = 604_800_000;

const ActiveRowSchema = z.object({
  provider: z.string(),
  native_id: z.string(),
  state: z.string(),
  changed_at: z.number().int(),
  thread: z.string().nullable(),
  history: z.string().nullable(),
});
/*
 * Running and waiting sessions by their latest state change. A stopping managed thread reports the
 * state it stops, from its last transition, and an observed Claude session joins its indexed
 * transcript, if any, by session ID.
 */
const ACTIVE_SESSIONS = `SELECT provider, native_id, state, changed_at, thread, history FROM (
  SELECT hq_thread.provider, hq_thread.native_id,
    coalesce(map.session_state, (SELECT state FROM hq_session_transition WHERE thread_id = hq_thread.id ORDER BY sequence DESC LIMIT 1), 'unknown') AS state,
    coalesce((SELECT recorded_at FROM hq_session_transition WHERE thread_id = hq_thread.id ORDER BY sequence DESC LIMIT 1), hq_thread.updated_at) AS changed_at,
    json_object('id', hq_thread.id, 'ownership', hq_thread.ownership, 'name', hq_thread.name,
      'workspaceRoot', hq_thread.workspace_root, 'nativeLineage', json(hq_thread.native_lineage),
      'createdAt', hq_thread.created_at, 'updatedAt', hq_thread.updated_at) AS thread,
    NULL AS history
  FROM hq_thread INNER JOIN hq_session_state_map AS map ON map.thread_state = hq_thread.state
  WHERE hq_thread.native_id IS NOT NULL AND (map.session_state IS NULL OR map.session_state IN ('running', 'waiting'))
  UNION ALL
  SELECT observed.provider, observed.native_id, observed.state, observed.observed_at, NULL,
    CASE WHEN observed.provider = 'claude' THEN (
      SELECT json_object('name', name, 'createdAt', created_at, 'updatedAt', updated_at,
        'isSupported', json(CASE WHEN supported = 1 THEN 'true' ELSE 'false' END))
      FROM hq_claude_file WHERE native_id = observed.native_id AND workspace_state = 'matching'
      ORDER BY updated_at DESC LIMIT 1
    ) END
  FROM hq_observed_session AS observed WHERE observed.state IN ('running', 'waiting')
) WHERE state IN ('running', 'waiting') ORDER BY changed_at DESC, native_id DESC LIMIT ?`;

const TransitionRowSchema = z.object({
  sequence: z.number().int(),
  provider: z.string(),
  native_id: z.string().nullable(),
  thread_id: z.string().nullable(),
  ownership: z.string(),
  previous_state: z.string().nullable(),
  state: z.string(),
  reason: z.string(),
  recorded_at: z.number().int(),
});

/** Owns observed session states and the session transition log on the SQLite worker. */
export class SessionsModel {
  private readonly __database: DatabaseSync;

  /** Uses the existing worker connection without owning its lifecycle. */
  public constructor(database: DatabaseSync) {
    this.__database = database;
  }

  /**
   * Records the states of sessions HQ doesn't manage; the schema's triggers append the
   * transitions. A complete observation also closes every open session of that provider it omits.
   */
  public observe(
    provider: string,
    sessions: { nativeId: string; state: ISessionState }[],
    isComplete: boolean,
  ): void {
    const now = Date.now();
    this.__database.exec('BEGIN IMMEDIATE');
    try {
      const managed = this.__database.prepare(
        'SELECT 1 FROM hq_thread WHERE provider = ? AND native_id = ?',
      );
      // an adopted session keeps its transitions on its managed record instead
      const forget = this.__database.prepare(
        'DELETE FROM hq_observed_session WHERE provider = ? AND native_id = ?',
      );
      const known = this.__database.prepare(
        'SELECT 1 FROM hq_observed_session WHERE provider = ? AND native_id = ?',
      );
      const upsert = this.__database.prepare(
        'INSERT INTO hq_observed_session (provider, native_id, state, observed_at) VALUES (?, ?, ?, ?) ON CONFLICT (provider, native_id) DO UPDATE SET state = excluded.state, observed_at = excluded.observed_at WHERE hq_observed_session.state != excluded.state',
      );
      for (const session of sessions) {
        if (managed.get(provider, session.nativeId)) {
          forget.run(provider, session.nativeId);
          continue;
        }
        // a session first seen closed or unknown has no state change to report
        if (
          (session.state === 'closed' || session.state === 'unknown') &&
          !known.get(provider, session.nativeId)
        )
          continue;
        upsert.run(provider, session.nativeId, session.state, now);
      }
      if (isComplete) {
        const listed = new Set(sessions.map((session) => session.nativeId));
        const close = this.__database.prepare(
          "UPDATE hq_observed_session SET state = 'closed', observed_at = ? WHERE provider = ? AND native_id = ?",
        );
        for (const row of this.__database
          .prepare(
            "SELECT native_id FROM hq_observed_session WHERE provider = ? AND state != 'closed'",
          )
          .all(provider)) {
          const nativeId = z.string().parse(row.native_id);
          if (!listed.has(nativeId)) close.run(now, provider, nativeId);
        }
      }
      this.__database
        .prepare(
          "DELETE FROM hq_observed_session WHERE rowid IN (SELECT rowid FROM hq_observed_session WHERE state = 'closed' AND observed_at < ? LIMIT 128)",
        )
        .run(now - RETENTION_MS);
      this.__database.exec('COMMIT');
    } catch (cause) {
      this.__database.exec('ROLLBACK');
      throw cause;
    }
  }

  /** Marks a provider's open observed sessions unknown after its native connection was lost. */
  public markUnknown(provider: string): void {
    this.__database
      .prepare(
        "UPDATE hq_observed_session SET state = 'unknown', observed_at = ? WHERE provider = ? AND state IN ('running', 'waiting', 'idle')",
      )
      .run(Date.now(), provider);
  }

  /** Reads the live states of selected native sessions, managed or observed. */
  public states(
    provider: string,
    nativeIds: string[],
  ): { nativeId: string; state: ISessionState }[] {
    const managed = this.__database.prepare(
      "SELECT coalesce(hq_session_state_map.session_state, (SELECT state FROM hq_session_transition WHERE thread_id = hq_thread.id ORDER BY sequence DESC LIMIT 1), 'unknown') AS state FROM hq_thread INNER JOIN hq_session_state_map ON hq_session_state_map.thread_state = hq_thread.state WHERE hq_thread.provider = ? AND hq_thread.native_id = ?",
    );
    const observed = this.__database.prepare(
      'SELECT state FROM hq_observed_session WHERE provider = ? AND native_id = ?',
    );
    return nativeIds.flatMap((nativeId) => {
      const row = managed.get(provider, nativeId) ?? observed.get(provider, nativeId);
      return row ? [{ nativeId, state: SessionStateSchema.parse(row.state) }] : [];
    });
  }

  /**
   * Reads running and waiting sessions, managed and observed, newest state change first.
   * @returns At most `limit` records and whether more sessions are active.
   */
  public active(limit: number): { data: IActiveSessionRecord[]; isTruncated: boolean } {
    const rows = this.__database
      .prepare(ACTIVE_SESSIONS)
      .all(limit + 1)
      .map((row) => ActiveRowSchema.parse(row));
    return {
      data: rows.slice(0, limit).map((row) =>
        ActiveSessionRecordSchema.parse({
          provider: row.provider,
          nativeId: row.native_id,
          state: row.state,
          changedAt: row.changed_at,
          thread: row.thread === null ? null : JSON.parse(row.thread),
          history: row.history === null ? null : JSON.parse(row.history),
        }),
      ),
      isTruncated: rows.length > limit,
    };
  }

  /** Reads transitions after a sequence, in order, with one row of lookahead for continuation. */
  public transitions(
    afterSequence: number,
    limit: number,
  ): { data: ISessionTransition[]; hasMore: boolean } {
    const rows = this.__database
      .prepare(
        'SELECT sequence, provider, native_id, thread_id, ownership, previous_state, state, reason, recorded_at FROM hq_session_transition WHERE sequence > ? ORDER BY sequence LIMIT ?',
      )
      .all(afterSequence, limit + 1)
      .map((row) => TransitionRowSchema.parse(row));
    const hasMore = rows.length > limit;
    return {
      data: rows.slice(0, limit).map((row) =>
        SessionTransitionSchema.parse({
          sequence: row.sequence,
          provider: row.provider,
          nativeId: row.native_id,
          threadId: row.thread_id,
          ownership: row.ownership,
          previousState: row.previous_state,
          state: row.state,
          reason: row.reason,
          recordedAt: row.recorded_at,
        }),
      ),
      hasMore,
    };
  }
}
