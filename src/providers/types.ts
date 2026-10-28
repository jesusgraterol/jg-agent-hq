import { z } from 'zod';

import { SkillSchema, ThreadSummarySchema } from '../contracts/index.js';
import type {
  IActionCommand,
  IManagedThread,
  IApprovalPresentation,
  ISkill,
  IHqResponse,
  IProviderId,
  IProviderCapabilitySet,
  IHistoryItem,
  IUsageSnapshot,
  INativeSkillInput,
  IProviderModelsRequest,
  IProviderModelPage,
  ISessionSettings,
  ITurnSettings,
  IConfigurationRequest,
  ISessionConfiguration,
  IPreparedInput,
  IAccountObservation,
  IAccountControlCommand,
  IExtensionControlCommand,
  ILoginObservation,
  INativeControlResult,
  ISessionState,
  IThreadSummary,
} from '../contracts/index.js';
import type { IProviderInputFile } from './inputs/index.js';
import type {
  IProviderMcpServerPage,
  IProviderMcpTools,
  IProviderMcpResources,
} from './extensions/index.js';
import type { IHistoryRequest } from '../sessions/index.js';
import type { INativeObservation, INativeOutcome } from '../store/control/index.js';

// control acknowledgements retain exact identities without interpreting unknown execution states
export const ProviderThreadSchema = ThreadSummarySchema.pick({
  nativeId: true,
  nativeLineage: true,
  workspaceRoot: true,
}).extend({ nativeState: z.enum(['notLoaded', 'idle', 'systemError', 'active']) });
export type IProviderThread = z.infer<typeof ProviderThreadSchema>;
export const ProviderInspectionSchema = z.object({
  thread: ThreadSummarySchema,
  canAdopt: z.boolean(),
  canResume: z.boolean(),
});
export type IProviderInspection = z.infer<typeof ProviderInspectionSchema>;

// adapters must honor cancellation and keep delivery uncertain when native consumption is unproven
export type IProviderCall = { signal: AbortSignal };

// adapters echo the opaque request identity; the runtime derives its own action identity
export type IAgentProviderOutcome = INativeOutcome extends infer TOutcome
  ? TOutcome extends unknown
    ? Omit<TOutcome, 'actionId' | 'nativeLineage'>
    : never
  : never;

// runtime-owned callbacks accept normalized evidence, never arbitrary native RPC
export type IAgentProviderEvents = {
  observe(observation: INativeObservation): void;
  item(nativeId: string, item: IHistoryItem, isComplete: boolean, replacedIds?: string[]): void;
  gap(nativeId: string): void;
  delta(nativeId: string, turnId: string, itemId: string, text: string): void;
  prompt(prompt: INativePrompt): void;
  outcome(outcome: IAgentProviderOutcome, thread?: IProviderThread): void;
  // the live state of a session another client drives, inside the allowed workspaces
  session(nativeId: string, state: ISessionState): void;
  unavailable(nativeId?: string): void;
};

// factories receive trusted configuration and runtime lifetime ownership
export type IAgentProviderContext = {
  agentTools?: import('../agent-tools/index.js').IProviderAgentTools;
  allowedRoots: string[];
  runtimeEpoch: string;
  signal: AbortSignal;
  events: IAgentProviderEvents;
};
export type IAgentProviderFactory = {
  id: IProviderId;
  /**
   * Creates one lazy adapter, cleaning up partial initialization before rejecting.
   * @returns The runtime-owned adapter; its close method confirms complete cleanup.
   */
  create(context: IAgentProviderContext): Promise<IAgentProvider>;
};

/*
 * Each native integration implements these concrete HQ operations with its own protocol validation.
 * Adapter failures may carry provider diagnostics; registry-bound calls normalize them to the
 * canonical provider/request/access/state/capability contracts documented in api/README.md.
 */
export type IAgentProvider = {
  readonly state: 'idle' | 'ready' | 'unavailable';
  readonly version: string | null;
  readonly isAvailable: boolean;
  /** @returns Current operation support and supported input/configuration schemas. */
  readCapabilities(
    nativeId: string | undefined,
    call: IProviderCall,
  ): Promise<IProviderCapabilitySet>;
  /** @returns One bounded native model catalog page with query-bound continuation. */
  readModels(command: IProviderModelsRequest, call: IProviderCall): Promise<IProviderModelPage>;
  /** @returns Known native settings and one bounded agent/profile choice page. */
  readConfiguration(
    command: IConfigurationRequest,
    nativeId: string | undefined,
    call: IProviderCall,
  ): Promise<ISessionConfiguration>;
  /** @returns An idle native fork with the exact source recorded in native lineage. */
  forkThread(
    requestId: string,
    nativeId: string,
    workspaceRoot: string,
    call: IProviderCall,
  ): Promise<IProviderThread>;
  /** @returns Native archive acknowledgement; the session becomes inactive. */
  archiveThread(requestId: string, nativeId: string, call: IProviderCall): Promise<void>;
  /** @returns The exact unarchived session, without assuming control or starting inference. */
  unarchiveThread(
    requestId: string,
    nativeId: string,
    call: IProviderCall,
  ): Promise<IProviderThread>;
  /** @returns Compaction admission; a null turn ID is correlated from native lifecycle events. */
  compactThread(
    requestId: string,
    nativeId: string,
    call: IProviderCall,
  ): Promise<{ id: string | null }>;
  /** @returns Native history-revert acknowledgement, which does not revert filesystem changes. */
  revertThread(
    requestId: string,
    nativeId: string,
    beforeTurnId: string,
    call: IProviderCall,
  ): Promise<IProviderThread>;
  /** @returns One authorized, bounded native history response with query-bound continuation. */
  readHistory(command: IHistoryRequest, call: IProviderCall): Promise<IHqResponse>;
  /**
   * Reads a session another client drives by its identity alone, for active-session reads; a
   * provider without it has its observed sessions left out of them.
   * @returns The session's summary, whose workspace is where it runs.
   */
  readObservedThread?(nativeId: string, call: IProviderCall): Promise<IThreadSummary>;
  /** @returns Verified native metadata and explicit eligibility for adoption or reattachment. */
  inspectThread(
    nativeId: string,
    workspaceRoot: string,
    call: IProviderCall,
  ): Promise<IProviderInspection>;
  /** @returns Native quota observations without starting a model turn. */
  readUsage(call: IProviderCall): Promise<IUsageSnapshot>;
  /** @returns Safe native account metadata, with an explicit unavailable observation when absent. */
  readAccount(call: IProviderCall): Promise<IAccountObservation>;
  /** @returns Safe live authentication presentation for one exact admitted request. */
  readLogin(requestId: string, call: IProviderCall): Promise<ILoginObservation>;
  /** @returns Native account-control acknowledgement; completion is observed separately for login. */
  controlAccount(
    requestId: string,
    command: IAccountControlCommand,
    loginRequestId: string | undefined,
    call: IProviderCall,
  ): Promise<INativeControlResult>;
  /** @returns Native acknowledgement for a concrete extension operation. */
  controlExtensions(
    requestId: string,
    nativeId: string,
    workspaceRoot: string,
    command: IExtensionControlCommand,
    call: IProviderCall,
  ): Promise<INativeControlResult>;
  /** @returns One native server page without configuration credentials. */
  readMcpServers(
    nativeId: string,
    limit: number,
    cursor: string | undefined,
    call: IProviderCall,
  ): Promise<IProviderMcpServerPage>;
  /** @returns A bounded inventory for one configured native MCP server. */
  readMcpTools(
    nativeId: string,
    serverName: string,
    call: IProviderCall,
  ): Promise<IProviderMcpTools>;
  /** @returns Bounded native resource metadata, or an explicit unsupported state. */
  readMcpResources(
    nativeId: string,
    serverName: string,
    call: IProviderCall,
  ): Promise<IProviderMcpResources>;
  /** @returns The bounded native skill inventory for the selected session. */
  readSkills(
    nativeId: string,
    workspaceRoot: string,
    call: IProviderCall,
  ): Promise<IProviderSkills>;
  /** @returns The exact native invocation spelling from validated inventory metadata. */
  formatSkill(skill: ISkill, argumentsText: string): string;
  /** @returns The exact created native session identity and workspace. */
  startThread(
    requestId: string,
    workspaceRoot: string,
    settings: ISessionSettings,
    call: IProviderCall,
  ): Promise<IProviderThread>;
  /** @returns The exact resumed native session identity and workspace. */
  resumeThread(
    requestId: string,
    nativeId: string,
    workspaceRoot: string,
    name: string,
    settings: ISessionSettings,
    call: IProviderCall,
  ): Promise<IProviderThread>;
  /** @returns Native acknowledgement of the selected session's name change. */
  nameThread(requestId: string, nativeId: string, name: string, call: IProviderCall): Promise<void>;
  /**
   * Checks media and output options before action admission and dispatch.
   * @returns Confirmation that the selected native control supports the input.
   * @throws
   * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
   * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
   * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
   */
  validateInput(nativeId: string, input: IPreparedInput, call: IProviderCall): Promise<void>;
  /**
   * Starts one native turn; completion arrives separately.
   * @returns The acknowledged native turn identity.
   * @throws
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
   * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
   * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
   * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
   * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
   */
  startTurn(
    requestId: string,
    nativeId: string,
    text: string,
    skill: INativeSkillInput | null,
    settings: ITurnSettings,
    files: IProviderInputFile[],
    call: IProviderCall,
  ): Promise<{ id: string }>;
  /** @returns The acknowledged active turn identity, without creating a new turn. */
  steer(
    requestId: string,
    nativeId: string,
    expectedTurnId: string,
    text: string,
    call: IProviderCall,
  ): Promise<string>;
  /** @returns Acknowledgement of the interruption request, without implying completion. */
  interrupt(
    requestId: string,
    nativeId: string,
    nativeTurnId: string,
    call: IProviderCall,
  ): Promise<void>;
  /** @returns Native cleanup acknowledgement for the selected owned session. */
  cleanThread(requestId: string, nativeId: string, call: IProviderCall): Promise<void>;
  /** @returns Confirmed cleanup and release of the selected owned native controller. */
  releaseThread(requestId: string, nativeId: string, call: IProviderCall): Promise<void>;
  /** @returns Confirmed native background cleanup before the runtime closes its transports. */
  prepareShutdown(nativeId: string, call: IProviderCall): Promise<void>;
  /** @returns Confirmed shutdown of the affected native control connection. */
  stopControl(nativeId: string | undefined, call: IProviderCall): Promise<void>;
  /** @returns Confirmed shutdown of every process and resource owned by this adapter. */
  close(): Promise<void>;
};

// owned native process transport; adapters own all provider protocol semantics
export type IProviderProcess = {
  readonly isRunning: boolean;
  write(message: unknown): Promise<void>;
  close(): Promise<void>;
};

/*
 * How messages travel over an owned native process's pipes. A preamble is written first, and
 * messages wait until the decoder reports the native answer to it. A decoder may probe the
 * connection itself, failing the transport when it stops answering, until it is stopped.
 */
export type IProviderFraming = {
  preamble: Buffer | null;
  createDecoder(handlers: {
    receive(message: unknown): void;
    reply(bytes: Buffer): void;
    open(): void;
    fail(cause: unknown): void;
  }): { push(chunk: Buffer): void; end(): void; stop(): void };
  encode(message: unknown): Buffer;
};

// a native request owns its validation and exact response channel; bodies remain in memory
export type INativePrompt = {
  provider: IManagedThread['provider'];
  nativeThreadId: string;
  nativeTurnId: string;
  requestId: string;
  fingerprint: string;
  presentation: IApprovalPresentation;
  /**
   * Validates a reply against the exact displayed native request.
   * @returns The native response payload without widening the requested scope.
   * @throws
   * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
   */
  validate(response: Extract<IActionCommand, { kind: 'native-reply' }>['response']): unknown;
  /**
   * Writes this request's response on its owning native channel.
   * @returns Confirmation of the write, which does not prove native consumption.
   * @throws
   * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
   * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
   */
  reply(response: unknown): Promise<void>;
  /**
   * Denies this request without granting any native permission.
   * @returns Confirmation that the denial was written.
   * @throws
   * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
   * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
   */
  reject(): Promise<void>;
};

// normalized native inventory, bounded before client paging
export const ProviderSkillsSchema = z.object({
  skills: z.array(SkillSchema.omit({ id: true })).max(4096),
  unavailableCount: z.number().int().nonnegative(),
  observedAt: z.number().int().safe(),
});
export type IProviderSkills = z.infer<typeof ProviderSkillsSchema>;
