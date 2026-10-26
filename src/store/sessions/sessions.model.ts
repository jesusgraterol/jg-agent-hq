import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import {
  SessionStateSchema,
  SessionTransitionSchema,
  type ISessionState,
  type ISessionTransition,
} from '../../contracts/index.js';

// closed observed sessions are forgotten after the same seven days that transitions are kept
const RETENTION_MS = 604_800_000;

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
