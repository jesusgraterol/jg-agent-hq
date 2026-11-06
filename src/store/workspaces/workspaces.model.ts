import type { IWorkspaceChange, IWorkspaceTransition } from '../../contracts/index.js';
import { HQ_ERRORS } from '../../errors/index.js';

import type { IStatements } from '../utilities.js';

import type { IWorkspaceTransitionRow } from './types.js';

/** Owns indexed workspace provenance on the control ledger's existing worker connection. */
export class WorkspacesModel {
  private readonly __statements: IStatements;

  /** Shares the existing worker's statement cache without owning its connection. */
  public constructor(statements: IStatements) {
    this.__statements = statements;
  }

  /** Returns the exact transition of one immutable action, without a collection scan. */
  public get(actionId: string): IWorkspaceTransition | null {
    const row = this.__statements.get<IWorkspaceTransitionRow>(
      'SELECT * FROM agent_hq_workspace_transition WHERE action_id = ?',
      actionId,
    );
    return row
      ? {
          actionId: row.action_id,
          threadId: row.thread_id,
          sourceWorkspaceRoot: row.source_workspace_root,
          targetWorkspaceRoot: row.target_workspace_root,
          historyWorkspaceRoot: row.history_workspace_root,
          state: row.state,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null;
  }

  /** Whether another unresolved transition prevents new input or directory changes. */
  public hasPending(threadId: string, exceptActionId: string): boolean {
    return Boolean(
      this.__statements.get(
        "SELECT 1 FROM agent_hq_workspace_transition WHERE thread_id = ? AND state IN ('prepared', 'submitted', 'uncertain') AND action_id != ? LIMIT 1",
        threadId,
        exceptActionId,
      ),
    );
  }

  /**
   * Records intent inside admission's existing transaction, before any provider effect.
   * @throws
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   */
  public prepare(actionId: string, threadId: string, change: IWorkspaceChange, now: number): void {
    if (this.hasPending(threadId, actionId))
      throw HQ_ERRORS.create('actionConflict', { data: { kind: 'state-conflict' } });
    this.__statements.run(
      "INSERT INTO agent_hq_workspace_transition (action_id, thread_id, source_workspace_root, target_workspace_root, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'prepared', ?, ?)",
      actionId,
      threadId,
      change.expectedWorkspaceRoot,
      change.workspaceRoot,
      now,
      now,
    );
  }

  /** Settles a pending transition without replacing already confirmed provenance. */
  public settle(
    actionId: string,
    state: IWorkspaceTransition['state'],
    historyRoot: string | null = null,
  ): void {
    this.__statements.run(
      "UPDATE agent_hq_workspace_transition SET state = ?, history_workspace_root = ?, updated_at = ? WHERE action_id = ? AND state IN ('prepared', 'submitted', 'uncertain')",
      state,
      historyRoot,
      Date.now(),
      actionId,
    );
  }

  /** Tests one historical root through confirmed, identity-scoped indexed membership. */
  public hasContext(threadId: string, workspaceRoot: string): boolean {
    return ['source_workspace_root', 'target_workspace_root', 'history_workspace_root'].some(
      (column) =>
        Boolean(
          this.__statements.get(
            `SELECT 1 FROM agent_hq_workspace_transition WHERE thread_id = ? AND state = 'confirmed' AND ${column} = ? LIMIT 1`,
            threadId,
            workspaceRoot,
          ),
        ),
    );
  }

  /**
   * Returns one bounded, deterministically ordered journal page for native history recovery.
   * @throws
   * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
   */
  public page(
    threadId: string,
    limit: number,
    before: { updatedAt: number; actionId: string } | null,
  ): IWorkspaceTransitionRow[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 128)
      throw HQ_ERRORS.create('requestInvalid', { data: { kind: 'invalid-request' } });
    return this.__statements.all<IWorkspaceTransitionRow>(
      `SELECT * FROM agent_hq_workspace_transition WHERE thread_id = ?${before ? ' AND (updated_at, action_id) < (?, ?)' : ''} ORDER BY updated_at DESC, action_id DESC LIMIT ?`,
      threadId,
      ...(before ? [before.updatedAt, before.actionId] : []),
      limit,
    );
  }
}
