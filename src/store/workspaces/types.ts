import type { IWorkspaceTransition } from '../../contracts/index.js';

// the worker's journal row mirrors SQLite without additional serialized state
export type IWorkspaceTransitionRow = {
  sequence: number;
  action_id: string;
  thread_id: string;
  source_workspace_root: string;
  target_workspace_root: string;
  history_workspace_root: string | null;
  state: IWorkspaceTransition['state'];
  created_at: number;
  updated_at: number;
};
