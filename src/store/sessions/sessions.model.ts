import type { DatabaseSync } from 'node:sqlite';

import type { IProviderId, ISessionState, ISessionTransition } from '../../contracts/index.js';

import type { IStatements } from '../utilities.js';

import { ACTIVE_SESSIONS, RETENTION_MS } from './constants.js';
import type { IActiveSessionRecord, IObservedSession } from './types.js';

// one active session row, whose thread, observed thread and history are JSON objects SQLite built
type IActiveRow = {
  provider: IActiveSessionRecord['provider'];
  native_id: string;
  state: IActiveSessionRecord['state'];
  changed_at: number;
  thread: string | null;
  observed_thread: string | null;
  history: string | null;
};
type ITransitionRow = {
  sequence: number;
  provider: ISessionTransition['provider'];
  native_id: string | null;
  thread_id: string | null;
  workspace_root: string | null;
  ownership: ISessionTransition['ownership'];
  previous_state: ISessionTransition['previousState'];
  state: ISessionTransition['state'];
  reason: ISessionTransition['reason'];
  recorded_at: number;
};

/** Owns observed session states and the session transition log on the SQLite worker. */
export class SessionsModel {
  private readonly __database: DatabaseSync;
  private readonly __statements: IStatements;

  /** Uses the existing worker connection without owning its lifecycle. */
  public constructor(database: DatabaseSync, statements: IStatements) {
    this.__database = database;
    this.__statements = statements;
  }

  /**
   * Records the states of sessions HQ doesn't manage, and on a session's first record what its
   * provider's first read of it found; the schema's triggers append the transitions, each with the
   * session's folder. A Claude session's folder follows the poll's listing, while a Codex session
   * keeps the one its first read found. A complete observation also closes every open session of
   * that provider it omits.
   */
  public observe(provider: IProviderId, sessions: IObservedSession[], isComplete: boolean): void {
    const now = Date.now();
    this.__database.exec('BEGIN IMMEDIATE');
    try {
      for (const session of sessions) {
        /*
         * A session HQ runs keeps its transitions on its managed record instead; one HQ closed is
         * observed again, so a terminal that continues it shows.
         */
        if (
          this.__statements.get(
            "SELECT 1 FROM agent_hq_thread WHERE provider = ? AND native_id = ? AND state != 'inactive'",
            provider,
            session.nativeId,
          )
        ) {
          this.__statements.run(
            'DELETE FROM agent_hq_observed_session WHERE provider = ? AND native_id = ?',
            provider,
            session.nativeId,
          );
          continue;
        }
        // a session first seen closed or unknown has no state change to report
        if (
          (session.state === 'closed' || session.state === 'unknown') &&
          !this.__statements.get(
            'SELECT 1 FROM agent_hq_observed_session WHERE provider = ? AND native_id = ?',
            provider,
            session.nativeId,
          )
        )
          continue;
        this.__statements.run(
          'INSERT INTO agent_hq_observed_session (provider, native_id, state, observed_at, workspace_root, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (provider, native_id) DO UPDATE SET state = excluded.state, observed_at = excluded.observed_at, workspace_root = coalesce(excluded.workspace_root, agent_hq_observed_session.workspace_root) WHERE agent_hq_observed_session.state != excluded.state',
          provider,
          session.nativeId,
          session.state,
          now,
          session.thread?.workspaceRoot ?? session.workspaceRoot ?? null,
          session.thread?.name ?? null,
          session.thread?.createdAt ?? null,
        );
      }
      if (isComplete) {
        const listed = new Set(sessions.map((session) => session.nativeId));
        for (const { native_id: nativeId } of this.__statements.all<{ native_id: string }>(
          "SELECT native_id FROM agent_hq_observed_session WHERE provider = ? AND state != 'closed'",
          provider,
        ))
          if (!listed.has(nativeId))
            this.__statements.run(
              "UPDATE agent_hq_observed_session SET state = 'closed', observed_at = ? WHERE provider = ? AND native_id = ?",
              now,
              provider,
              nativeId,
            );
      }
      this.__statements.run(
        "DELETE FROM agent_hq_observed_session WHERE rowid IN (SELECT rowid FROM agent_hq_observed_session WHERE state = 'closed' AND observed_at < ? LIMIT 128)",
        now - RETENTION_MS,
      );
      this.__database.exec('COMMIT');
    } catch (cause) {
      this.__database.exec('ROLLBACK');
      throw cause;
    }
  }

  /** Marks a provider's open observed sessions unknown after its native connection was lost. */
  public markUnknown(provider: IProviderId): void {
    this.__statements.run(
      "UPDATE agent_hq_observed_session SET state = 'unknown', observed_at = ? WHERE provider = ? AND state IN ('running', 'waiting', 'idle')",
      Date.now(),
      provider,
    );
  }

  /** Reads the live states of selected native sessions, managed or observed. */
  public states(
    provider: IProviderId,
    nativeIds: string[],
  ): { nativeId: string; state: ISessionState }[] {
    return nativeIds.flatMap((nativeId) => {
      const record = this.__statements.get<{ state: ISessionState; is_closed: number }>(
        "SELECT coalesce(agent_hq_session_state_map.session_state, (SELECT state FROM agent_hq_session_transition WHERE thread_id = agent_hq_thread.id ORDER BY sequence DESC LIMIT 1), 'unknown') AS state, agent_hq_thread.state = 'inactive' AS is_closed FROM agent_hq_thread INNER JOIN agent_hq_session_state_map ON agent_hq_session_state_map.thread_state = agent_hq_thread.state WHERE agent_hq_thread.provider = ? AND agent_hq_thread.native_id = ?",
        provider,
        nativeId,
      );
      const observed = (): { state: ISessionState } | undefined =>
        this.__statements.get(
          'SELECT state FROM agent_hq_observed_session WHERE provider = ? AND native_id = ?',
          provider,
          nativeId,
        );
      // a session HQ closed takes the state observed since, while a terminal continues it
      const row = record?.is_closed ? (observed() ?? record) : (record ?? observed());
      return row ? [{ nativeId, state: row.state }] : [];
    });
  }

  /**
   * Reads running and waiting sessions, managed and observed, newest state change first, with the
   * included sessions that are idle.
   * @param limit The most records to return.
   * @param includedKeys The sessions that run background commands, which count as active while idle.
   * @returns At most `limit` records and whether more sessions are active.
   */
  public active(
    limit: number,
    includedKeys: { provider: string; nativeId: string }[],
  ): { data: IActiveSessionRecord[]; isTruncated: boolean } {
    const included = JSON.stringify(
      includedKeys.map(({ provider, nativeId }) => [provider, nativeId]),
    );
    const rows = this.__statements.all<IActiveRow>(ACTIVE_SESSIONS, included, limit + 1);
    return {
      data: rows.slice(0, limit).map((row) => ({
        provider: row.provider,
        nativeId: row.native_id,
        state: row.state,
        changedAt: row.changed_at,
        thread: row.thread === null ? null : JSON.parse(row.thread),
        observed: row.observed_thread === null ? null : JSON.parse(row.observed_thread),
        history: row.history === null ? null : JSON.parse(row.history),
      })),
      isTruncated: rows.length > limit,
    };
  }

  /**
   * Finds the workspace whose Claude project directory holds a session's indexed transcript.
   * @param nativeId The session's ID.
   * @returns The workspace root, or null when no transcript of it is indexed in a workspace it ran in.
   */
  public claudeTranscriptRoot(nativeId: string): string | null {
    return (
      this.__statements.get<{ workspace_root: string }>(
        `SELECT workspace_root FROM agent_hq_claude_file
        WHERE native_id = ? AND workspace_state = 'matching' ORDER BY updated_at DESC LIMIT 1`,
        nativeId,
      )?.workspace_root ?? null
    );
  }

  /**
   * Reads transitions after a sequence, in order, with one row of lookahead for continuation.
   * AUTOINCREMENT keeps the highest sequence ever issued in sqlite_sequence, even once pruning
   * deleted that transition, and only pruning deletes one, so a missing sequence at or below it
   * was pruned.
   * @returns The page, the highest sequence ever issued, and whether the cursor can't continue.
   */
  public transitions(
    afterSequence: number,
    limit: number,
  ): { data: ISessionTransition[]; hasMore: boolean; latestSequence: number; isReset: boolean } {
    const latestSequence =
      this.__statements.get<{ seq: number }>(
        "SELECT seq FROM sqlite_sequence WHERE name = 'agent_hq_session_transition'",
      )?.seq ?? 0;
    const isReset =
      afterSequence > latestSequence ||
      (afterSequence > 0 &&
        !this.__statements.get(
          'SELECT 1 FROM agent_hq_session_transition WHERE sequence = ?',
          afterSequence,
        ));
    const rows = this.__statements.all<ITransitionRow>(
      'SELECT sequence, provider, native_id, thread_id, workspace_root, ownership, previous_state, state, reason, recorded_at FROM agent_hq_session_transition WHERE sequence > ? ORDER BY sequence LIMIT ?',
      afterSequence,
      limit + 1,
    );
    return {
      data: rows.slice(0, limit).map((row) => ({
        sequence: row.sequence,
        provider: row.provider,
        nativeId: row.native_id,
        threadId: row.thread_id,
        workspaceRoot: row.workspace_root,
        ownership: row.ownership,
        previousState: row.previous_state,
        state: row.state,
        reason: row.reason,
        recordedAt: row.recorded_at,
      })),
      hasMore: rows.length > limit,
      latestSequence,
      isReset,
    };
  }
}
