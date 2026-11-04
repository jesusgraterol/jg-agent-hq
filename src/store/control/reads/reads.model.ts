import type {
  IActionReceipt,
  IManagedThread,
  IHistoryProvenance,
  INativeApprovalSummary,
} from '../../../contracts/index.js';
import type { IEvidenceOriginsRequest } from '../../../sessions/evidence/index.js';

import { ControlModel } from '../control.model.js';
import { ACTION_METADATA_COLUMNS, THREAD_COLUMNS, UNSTARTED_CONDITION } from '../constants.js';
import { toActionSummary, toManagedThread } from '../transformers.js';
import type {
  IActionPage,
  IActionRow,
  IApprovalPage,
  IApprovalPageRequest,
  IControlPage,
  IThreadPage,
  IThreadRow,
  ITurnRecord,
} from '../types.js';

// an approval's durable metadata, without its native request or response
type IApprovalRow = {
  id: string;
  thread_id: string;
  native_turn_id: string;
  runtime_epoch: string;
  kind: INativeApprovalSummary['kind'];
  state: INativeApprovalSummary['state'];
  reply_action_id: string | null;
  is_blocking: number;
  created_at: number;
  updated_at: number;
};

/** Reads the control ledger's receipts, threads and approvals without changing them. */
export class ControlReads extends ControlModel {
  /** Returns one receipt, including an undelivered queue body when present. */
  public getAction(id: string): IActionReceipt | null {
    return this._receipt(id);
  }

  /**
   * Resolves exact native input identities and content hashes; native roles grant no identity.
   * An input matches the action and phase its native ID names, or the turn it started.
   */
  public getEvidenceOrigins(command: IEvidenceOriginsRequest): (IHistoryProvenance | null)[] {
    return command.items.map((item) => {
      if (item.nativeInputId === null || item.sha256 === null) return null;
      const rows = this._statements.all<{ id: string; authenticated: number }>(
        `SELECT a.id, EXISTS(SELECT 1 FROM agent_hq_browser_action b WHERE b.native_action_id = a.id AND b.native_thread_id = a.thread_id AND b.native_input_sha256 = a.input_sha256) AS authenticated
      FROM agent_hq_action a JOIN agent_hq_thread t ON t.id = a.thread_id
      WHERE t.provider = ? AND t.native_id = ? AND a.native_turn_id = ? AND a.input_sha256 = ?
      AND a.delivery = 'acknowledged' AND ((a.id = ? AND a.phase = ?) OR a.native_turn_id = ?)
      ORDER BY a.id LIMIT 2`,
        command.provider,
        command.nativeId,
        item.turnId,
        item.sha256,
        item.request?.actionId ?? null,
        item.request?.phase ?? null,
        item.nativeInputId,
      );
      if (rows.length !== 1) return null;
      const row = rows[0]!;
      return {
        origin: row.authenticated === 1 ? 'operator' : 'unknown',
        source: row.authenticated === 1 ? 'authenticated-host-action' : 'host-action',
        actionId: row.id,
        nativeInputId: item.nativeInputId,
        nativeInputSha256: item.sha256,
        contentBoundary: 'untrusted',
        grantsAuthority: false,
      };
    });
  }

  /** Returns one control record by immutable identity. */
  public getThread(id: string): IManagedThread | null {
    return this._managedThread(id);
  }

  /** Finds a free label against assigned names and pending native renames. */
  public suggestName(name: string): string {
    return this._suggestName(name);
  }

  /** Resolves a registered native session without claiming it. */
  public getThreadByNativeId(
    provider: IManagedThread['provider'],
    nativeId: string,
  ): IManagedThread | null {
    const thread = this._nativeThread(provider, nativeId);
    return thread ? toManagedThread(thread) : null;
  }

  /** Reads the turns a registered native session recorded, which a live re-check compares. */
  public getTurnRecord(provider: IManagedThread['provider'], nativeId: string): ITurnRecord | null {
    const thread = this._nativeThread(provider, nativeId);
    return thread
      ? {
          threadId: thread.id,
          workspaceRoot: thread.workspace_root,
          activeTurnId: thread.active_turn_id,
          lastTurnId: thread.last_turn_id,
          hasPendingAction: thread.pending_action_id !== null,
        }
      : null;
  }

  /** Resolves one native discovery page in a single indexed worker operation. */
  public getNativeThreads(
    provider: IManagedThread['provider'],
    nativeIds: string[],
  ): IManagedThread[] {
    return this._statements
      .all<IThreadRow>(
        `SELECT ${THREAD_COLUMNS} FROM agent_hq_thread WHERE provider = ? AND native_id IN (SELECT json_each.value FROM json_each(?))`,
        provider,
        JSON.stringify(nativeIds),
      )
      .map(toManagedThread);
  }

  /** Reads a bounded descending creation/UUID seek page. */
  public listThreads(workspaceRoot: string, page: IControlPage): IThreadPage {
    const seek = page.position
      ? 'AND (agent_hq_thread.created_at, agent_hq_thread.id) < (?, ?)'
      : '';
    const rows = this._statements.all<IThreadRow>(
      `SELECT ${THREAD_COLUMNS} FROM agent_hq_thread
      WHERE workspace_root = ? ${seek}
      ORDER BY agent_hq_thread.created_at DESC, agent_hq_thread.id DESC LIMIT ?`,
      workspaceRoot,
      ...(page.position ? [page.position.createdAt, page.position.id] : []),
      page.limit + 1,
    );
    return {
      data: rows.slice(0, page.limit).map(toManagedThread),
      hasMore: rows.length > page.limit,
    };
  }

  /**
   * Reads one provider's managed threads in a workspace that no turn has started, newest first:
   * each was created empty with `thread-create`, has a native ID and no active or last turn, and
   * is not closed.
   * @returns At most `limit` threads and whether more exist.
   */
  public listUnstartedThreads(
    provider: IManagedThread['provider'],
    workspaceRoot: string,
    limit: number,
  ): { data: IManagedThread[]; isTruncated: boolean } {
    const rows = this._statements.all<IThreadRow>(
      `SELECT ${THREAD_COLUMNS} FROM agent_hq_thread
      WHERE workspace_root = ? AND provider = ? AND native_id IS NOT NULL AND ${UNSTARTED_CONDITION}
      ORDER BY agent_hq_thread.created_at DESC, agent_hq_thread.id DESC LIMIT ?`,
      workspaceRoot,
      provider,
      limit + 1,
    );
    return {
      data: rows.slice(0, limit).map(toManagedThread),
      isTruncated: rows.length > limit,
    };
  }

  /** Reads a managed thread by its native ID when no turn has started it. */
  public getUnstartedThread(
    provider: IManagedThread['provider'],
    nativeId: string,
  ): IManagedThread | null {
    const row = this._statements.get<IThreadRow>(
      `SELECT ${THREAD_COLUMNS} FROM agent_hq_thread WHERE provider = ? AND native_id = ? AND ${UNSTARTED_CONDITION}`,
      provider,
      nativeId,
    );
    return row ? toManagedThread(row) : null;
  }

  /** Reads action metadata without selecting queued message bodies. */
  public listActions(threadId: string, page: IControlPage): IActionPage {
    const seek = page.position
      ? 'AND (agent_hq_action.created_at, agent_hq_action.id) < (?, ?)'
      : '';
    const rows = this._statements.all<Omit<IActionRow, 'queued_input' | 'result'>>(
      `SELECT ${ACTION_METADATA_COLUMNS} FROM agent_hq_action
      WHERE thread_id = ? ${seek}
      ORDER BY agent_hq_action.created_at DESC, agent_hq_action.id DESC LIMIT ?`,
      threadId,
      ...(page.position ? [page.position.createdAt, page.position.id] : []),
      page.limit + 1,
    );
    return {
      data: rows.slice(0, page.limit).map(toActionSummary),
      hasMore: rows.length > page.limit,
    };
  }

  /** Reads indexed approval history without sensitive native request or response content. */
  public listApprovals(threadId: string, page: IApprovalPageRequest): IApprovalPage {
    const seek = page.position
      ? 'AND (agent_hq_native_approval.created_at, agent_hq_native_approval.id) < (?, ?)'
      : '';
    const state = page.state ? 'AND state = ?' : '';
    const rows = this._statements.all<IApprovalRow>(
      `SELECT id, thread_id, native_turn_id, runtime_epoch, kind, state, reply_action_id, is_blocking, created_at, updated_at FROM agent_hq_native_approval WHERE thread_id = ? ${state} ${seek} ORDER BY agent_hq_native_approval.created_at DESC, agent_hq_native_approval.id DESC LIMIT ?`,
      threadId,
      ...(page.state ? [page.state] : []),
      ...(page.position ? [page.position.createdAt, page.position.id] : []),
      page.limit + 1,
    );
    return {
      data: rows.slice(0, page.limit).map((row) => ({
        id: row.id,
        threadId: row.thread_id,
        nativeTurnId: row.native_turn_id,
        runtimeEpoch: row.runtime_epoch,
        kind: row.kind,
        state: row.state,
        replyActionId: row.reply_action_id,
        isBlocking: row.is_blocking === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      hasMore: rows.length > page.limit,
    };
  }
}
