// native authentication and extension controls
export {
  AccountControlCommandSchema,
  LoginObservationSchema,
  LoginRequestSchema,
  NativeControlResultSchema,
} from './accounts/index.js';
export type {
  IAccountControlCommand,
  ILoginObservation,
  INativeControlResult,
} from './accounts/index.js';
export { ExtensionControlCommandSchema } from './extensions/index.js';
export type { IExtensionControlCommand } from './extensions/index.js';

// constants
export {
  DEFAULT_PAGE_SIZE,
  MAX_ITEM_TEXT_LENGTH,
  MAX_PAGE_SIZE,
  PUBLIC_ERROR_CODES,
  PUBLIC_ERROR_MESSAGES,
} from './constants.js';

// wire contracts
export {
  HqRequestSchema,
  ThreadSummarySchema,
  ActiveSessionsSchema,
  UnstartedThreadsSchema,
  TurnSummarySchema,
  HistoryFileSchema,
  HistoryItemSchema,
  LiveItemsSchema,
  UsageWindowSchema,
  UsageSnapshotSchema,
  UsageCreditsSchema,
  UsageResetCreditsSchema,
  UsageWindowScopeSchema,
  RuntimeStatusSchema,
  HqResponseSchema,
  ErrorKindSchema,
  IpcRequestSchema,
  IpcResponseSchema,
} from './types.js';

// provider identity and capability discovery
export {
  ProviderIdSchema,
  ProviderCapabilitySchema,
  ProviderCapabilitySetSchema,
  ProviderCapabilitiesSchema,
  ProviderStatusSchema,
  MAX_PROVIDERS,
} from './providers/index.js';
export type {
  IProviderId,
  IProviderCapability,
  IProviderCapabilitySet,
  IProviderCapabilities,
  IProviderStatus,
} from './providers/index.js';
export type {
  IHqRequest,
  IHqRequestInput,
  IThreadSummary,
  IActiveSessions,
  IUnstartedThreads,
  ITurnSummary,
  IHistoryFile,
  IHistoryItem,
  IUsageSnapshot,
  IUsageCredits,
  IUsageResetCredits,
  IUsageWindowScope,
  IRuntimeStatus,
  IHqResponse,
  IErrorKind,
  IIpcResponse,
} from './types.js';

// native identities
export { NativeLineageSchema } from './identities/index.js';
export type { INativeLineage } from './identities/index.js';

// native model discovery
export {
  ProviderModelSchema,
  ProviderModelsRequestSchema,
  ProviderModelPageSchema,
} from './models/index.js';
export type { IProviderModel, IProviderModelsRequest, IProviderModelPage } from './models/index.js';

// managed control and durable delivery
export {
  PreparedInputSchema,
  ActionCommandSchema,
  ActionEnvelopeSchema,
  ActionReceiptSchema,
  ActionSummarySchema,
  ManagedThreadSchema,
  NativeApprovalSchema,
  NativeApprovalSummarySchema,
  ApprovalPresentationSchema,
  NativeElicitationSchema,
  LifecycleEventSchema,
} from './actions/index.js';
export type {
  IPreparedInput,
  IActionCommand,
  IActionEnvelope,
  IActionReceipt,
  IActionSummary,
  IManagedThread,
  INativeApproval,
  INativeApprovalSummary,
  IApprovalPresentation,
  INativeElicitation,
  ILifecycleEvent,
} from './actions/index.js';

// native skills and explicit message input
export {
  SkillIdSchema,
  NativeSkillInputSchema,
  SkillSchema,
  SkillPageSchema,
  SkillPreviewSchema,
  MessageInputSchema,
} from './skills/index.js';
export type {
  INativeSkillInput,
  ISkill,
  ISkillPage,
  ISkillPreview,
  IMessageInput,
} from './skills/index.js';

// plan revisions and explicit authority
export {
  PlanDigestSchema,
  PlanRevisionSchema,
  PlanMetadataSchema,
  PlanTargetSchema,
  PlanOperatorActionSchema,
  PlanCommandSchema,
  PlanApprovalSchema,
  PlanExecutionSchema,
  PlanFinalizationSchema,
  PlanCoordinationSchema,
  PlanMilestoneSchema,
  PlanStatusSchema,
  PlanResultSchema,
} from './plans/index.js';
export type {
  IPlanRevision,
  IPlanMetadata,
  IPlanTarget,
  IPlanOperatorAction,
  IPlanCommand,
  IPlanCommandInput,
  IPlanCoordination,
  IPlanMilestone,
  IPlanStatus,
  IPlanResult,
} from './plans/index.js';

// revision checkpoints and retained verification
export {
  PlanCheckSchema,
  PlanCheckoutSchema,
  PlanWorktreeProofSchema,
  PlanCompletionSchema,
  PlanSnapshotMilestoneSchema,
  PlanRevisionWorkflowSchema,
  PlanCoordinationSummarySchema,
} from './plans/index.js';
export type {
  IPlanCheckout,
  IPlanWorktreeProof,
  IPlanCompletion,
  IPlanSnapshotMilestone,
  IPlanRevisionWorkflow,
} from './plans/index.js';

// saved revision baseline
export { PlanCheckpointSchema } from './plans/index.js';
export type { IPlanCheckpoint } from './plans/index.js';

// guided plan scope
export { PlanActionScopeSchema, ActionPlanContextSchema } from './actions/index.js';
export type { IPlanActionScope, IActionPlanContext } from './actions/index.js';

// authenticated host actions
export {
  BrowserCommandSchema,
  BrowserActionSchema,
  BrowserReceiptSchema,
} from './browser/index.js';
export type { IBrowserAction, IBrowserReceipt } from './browser/index.js';

// native session configuration
export {
  TurnSettingsSchema,
  SessionSettingsSchema,
  ConfigurationRequestSchema,
  ConfigurationChoiceSchema,
  SessionConfigurationSchema,
} from './configuration/index.js';
export type {
  ITurnSettings,
  ISessionSettings,
  IConfigurationRequest,
  IConfigurationChoice,
  ISessionConfiguration,
} from './configuration/index.js';

// bounded host views
export { BrowserThreadDetailSchema } from './browser/index.js';

// bounded file inputs and complete native results
export {
  InputFileSchema,
  BoundInputFileSchema,
  MAX_INPUT_FILES,
  MAX_INPUT_FILE_BYTES,
  MAX_TEXT_FILE_BYTES,
} from './inputs/index.js';
export type { IInputFile, IBoundInputFile } from './inputs/index.js';
export {
  MAX_RESULT_BYTES,
  OutputSchemaSchema,
  TurnUsageSchema,
  TurnResultSchema,
} from './results/index.js';
export type { IOutputSchema, ITurnUsage, ITurnResult } from './results/index.js';
// native accounts and configured MCP inventories
export { AccountRequestSchema, AccountObservationSchema } from './accounts/index.js';
export type { IAccountRequest, IAccountObservation } from './accounts/index.js';
export {
  MAX_MCP_ITEMS,
  MAX_MCP_CATALOG_BYTES,
  McpRequestSchema,
  McpServerSchema,
  McpToolSchema,
  McpResourceSchema,
  McpServerPageSchema,
  McpToolPageSchema,
  McpResourcePageSchema,
} from './extensions/index.js';
export type {
  IMcpRequest,
  IMcpServer,
  IMcpTool,
  IMcpResource,
  IMcpServerPage,
  IMcpToolPage,
  IMcpResourcePage,
} from './extensions/index.js';
// bounded historical evidence
export {
  EvidenceRequestSchema,
  EvidencePageSchema,
  EvidenceItemSchema,
  HistoryProvenanceSchema,
} from './evidence/index.js';
export type {
  IEvidenceRequest,
  IEvidencePage,
  IEvidenceItem,
  IHistoryProvenance,
} from './evidence/index.js';

// durable task collaboration
export {
  COLLABORATION_LIMITS,
  CollaborationActorSchema,
  MessageAuthorSchema,
  DispatchFailureSchema,
  DispatchBlockedSchema,
  InvocationSchema,
  DispatchCollectionSchema,
  ContinuationSchema,
  MAX_REPORT_BYTES,
  DispatchResponseSchema,
  DISPATCH_OUTPUT_SCHEMA,
  ReportSummarySchema,
  ReportReadSchema,
  CollaborationEffectSchema,
  AgentPermissionsSchema,
  TaskPolicySchema,
  CollaborationPlanSchema,
  PathScopeSchema,
  ArtifactReferenceSchema,
  SkillSelectionSchema,
  SkillGrantSchema,
  RequestSpecificationSchema,
  CollaborationLifecycleSchema,
  CollaborationTaskSchema,
  TaskAgentSchema,
  StreamSchema,
  SubscriptionSchema,
  MessageSummarySchema,
  MessageReadSchema,
  CollaborationRequestRecordSchema,
  DeliverySchema,
  CollaborationCommandSchema,
  CollaborationRequestSchema,
  TaskSummarySchema,
  TaskAgentSummarySchema,
  SkillGrantSummarySchema,
  RequestSummarySchema,
  CollaborationStatusSchema,
  CollaborationResultSchema,
  CollaborationOperationSchema,
  CollaborationResponseSchema,
} from './collaboration/index.js';
export type {
  ICollaborationActor,
  IMessageAuthor,
  IDispatchFailure,
  IDispatchBlocked,
  IInvocation,
  IDispatchCollection,
  IContinuation,
  IDispatchResponse,
  IReportSummary,
  IReportRead,
  IAgentPermissions,
  ITaskPolicy,
  ICollaborationPlan,
  IPathScope,
  IArtifactReference,
  ISkillGrant,
  IRequestSpecification,
  ICollaborationTask,
  ITaskAgent,
  IStream,
  ISubscription,
  IMessageSummary,
  IMessageRead,
  ICollaborationRequestRecord,
  IDelivery,
  ICollaborationCommand,
  ICollaborationRequest,
  IRequestSummary,
  ICollaborationStatus,
  ICollaborationResult,
  ICollaborationOperation,
  ICollaborationResponse,
} from './collaboration/index.js';
// native agent tools
export {
  AgentIdentityArgumentsSchema,
  AgentSpawnArgumentsSchema,
  AgentToolCallSchema,
  AgentToolRequestSchema,
  AgentToolResultSchema,
} from './agent-tools/index.js';
export type {
  IAgentSpawnArguments,
  IAgentToolCall,
  IAgentToolName,
  IAgentToolRequest,
  IAgentToolResult,
} from './agent-tools/index.js';
export { SessionDiscoveryRequestSchema } from './evidence/index.js';

// session states and transitions
export {
  SessionStateSchema,
  SessionTransitionReasonSchema,
  SessionTransitionSchema,
  SessionTransitionPageSchema,
  ObservationPaceSchema,
} from './sessions/index.js';
export type {
  ISessionState,
  ISessionTransitionReason,
  ISessionTransition,
  IObservationPace,
} from './sessions/index.js';
