// constants
export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  PUBLIC_ERROR_CODES,
  PUBLIC_ERROR_MESSAGES,
} from './constants.js';

// wire contracts
export {
  HqRequestSchema,
  ThreadSummarySchema,
  TurnSummarySchema,
  HistoryItemSchema,
  LiveItemsSchema,
  UsageWindowSchema,
  UsageSnapshotSchema,
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
  ITurnSummary,
  IHistoryItem,
  IUsageSnapshot,
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
  PlanComparisonSchema,
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
  IPlanComparison,
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
  PlanCorrespondenceSchema,
  PlanDraftMilestoneSchema,
  PlanProposalSchema,
  PlanRevisionWorkflowSchema,
  PlanCorrespondenceRecordSchema,
  PlanCoordinationSummarySchema,
} from './plans/index.js';
export type {
  IPlanCheckout,
  IPlanWorktreeProof,
  IPlanCompletion,
  IPlanSnapshotMilestone,
  IPlanCorrespondence,
  IPlanDraftMilestone,
  IPlanProposal,
  IPlanRevisionWorkflow,
  IPlanCorrespondenceRecord,
} from './plans/index.js';

// saved revision baseline
export { PlanCheckpointSchema } from './plans/index.js';
export type { IPlanCheckpoint } from './plans/index.js';

// bounded revision reads
export { PlanCorrespondenceSummarySchema, PlanReconciliationEntrySchema } from './plans/index.js';
export type { IPlanReconciliationEntry } from './plans/index.js';

// guided plan scope
export { PlanActionScopeSchema, ActionPlanContextSchema } from './actions/index.js';
export type { IPlanActionScope, IActionPlanContext } from './actions/index.js';

// explicit cross-provider handoffs
export {
  HandoffSourceSchema,
  HandoffFindingsSchema,
  HandoffPhaseSchema,
  HandoffCommandSchema,
  HandoffDeliverySchema,
  HandoffSummarySchema,
  HandoffSchema,
  HandoffPreviewSchema,
  HandoffResultSchema,
} from './handoffs/index.js';
export type {
  IHandoffCommand,
  IHandoffPhase,
  IHandoffSource,
  IHandoffFindings,
  IHandoff,
  IHandoffSummary,
  IHandoffPreview,
  IHandoffResult,
} from './handoffs/index.js';

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

// host read models
export {
  BrowserRepositorySchema,
  BrowserPlanSummarySchema,
  BrowserPlanPageSchema,
  BrowserPlanDetailSchema,
  BrowserSessionSchema,
} from './browser/index.js';

// bounded host views
export {
  BrowserRepositoryPageSchema,
  BrowserSystemSchema,
  BrowserThreadDetailSchema,
  PublicationStatusSchema,
} from './browser/index.js';
export type { IPublicationStatus } from './browser/index.js';

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
