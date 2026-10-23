import type {
  IAgentToolCall,
  IAgentToolName,
  IAgentToolRequest,
  IAgentToolResult,
} from '../contracts/agent-tools/index.js';
import type { IHqRequest, IHqResponse, IProviderCapabilitySet } from '../contracts/index.js';
import type { createActions } from '../actions/index.js';
import type { ICollaboration } from '../collaboration/index.js';
import type { IStore } from '../store/index.js';

// descriptors contain public schemas only; they never carry session credentials
export type IAgentToolDefinition = {
  name: IAgentToolName;
  description: string;
  inputSchema: NonNullable<IProviderCapabilitySet['inputSchema']>;
};
export type IAgentMcpLease = {
  serverName: string;
  configuration: { command: string; args: string[]; env: Record<string, string> };
  release(): Promise<void>;
};

// trusted provider factories receive a provider-bound bridge, never model-selected sender identity
export type IProviderAgentTools = {
  definitions(): IAgentToolDefinition[];
  /**
   * Calls one closed tool from a verified native connection.
   * @returns A bounded native tool result with safe errors.
   */
  call(
    nativeId: string,
    turnId: string | undefined,
    name: string,
    argumentsValue: unknown,
    signal?: AbortSignal,
  ): Promise<IAgentToolResult>;
  /**
   * Creates private session-specific stdio configuration while preserving other native MCP servers.
   * @returns Configuration and its revocable private-file lease.
   * @throws
   * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
   * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
   * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
   */
  mcp(nativeId: string): Promise<IAgentMcpLease>;
};
export type IAgentTools = {
  forProvider(provider: string): IProviderAgentTools;
  /**
   * Resolves the private bridge credential before native session and task admission.
   * @returns A bounded native tool result with safe errors.
   */
  handleBridge(request: IAgentToolRequest, signal?: AbortSignal): Promise<IAgentToolResult>;
  /**
   * Stops admission, drains owned tool calls and removes private bridge credentials.
   * @returns Confirmed tool and credential cleanup.
   * @throws
   * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
   */
  close(): Promise<void>;
};
export type IAgentToolsOptions = {
  stateRoot: string;
  runtimeEpoch: string;
  allowedRoots: string[];
  store: IStore;
  collaboration: ICollaboration;
  actions: ReturnType<typeof createActions>;
  run<T>(operation: () => Promise<T>): Promise<T>;
  read(
    request: Extract<IHqRequest, { kind: 'sessions' | 'session-evidence' }>,
  ): Promise<IHqResponse>;
};
export type ICollaborationToolName = Exclude<
  IAgentToolCall['name'],
  'hq_identity' | 'hq_agent_spawn' | 'hq_sessions_list' | 'hq_session_evidence_read'
>;
