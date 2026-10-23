import type {
  ICollaborationRequest,
  ICollaborationResponse,
} from '../contracts/collaboration/index.js';
import type { INativeToolBinding } from './identity/index.js';

// background batches participate individually in the runtime's maintenance admission
export type ICollaborationBackground = <T>(operation: () => Promise<T>) => Promise<T>;
export type ICollaboration = {
  /**
   * Applies trusted host metadata operations after canonical workspace admission.
   * @returns A bounded result or durable metadata receipt.
   * @throws
   * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
   * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
   * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
   * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
   * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  handle(
    request: ICollaborationRequest,
    binding?: INativeToolBinding,
  ): Promise<ICollaborationResponse>;
  /** Stops new recovery batches and drains the current owned batch.
   * @returns Completion of the owned background loop.
   */
  close(): Promise<void>;
};
