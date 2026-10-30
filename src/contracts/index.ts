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
  MAX_ITEM_IMAGE_BYTES,
  MAX_ITEM_IMAGES,
  MAX_ITEM_TEXT_LENGTH,
  MAX_PAGE_SIZE,
  PUBLIC_ERROR_CODES,
  PUBLIC_ERROR_MESSAGES,
} from './constants.js';

// wire contracts
export {
  HqRequestSchema,
  SessionTerminalSchema,
  ThreadSummarySchema,
  ActiveSessionsSchema,
  UnstartedThreadsSchema,
  TurnSummarySchema,
  HistoryFileSchema,
  HistoryItemSchema,
  ItemImageMediaTypeSchema,
  ItemDetailSchema,
  ItemImageSchema,
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
  ISessionTerminal,
  IThreadSummary,
  IActiveSessions,
  IUnstartedThreads,
  ITurnSummary,
  IHistoryFile,
  IHistoryItem,
  IItemImageMediaType,
  IItemDetail,
  IItemImage,
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
  SessionDiscoveryRequestSchema,
} from './evidence/index.js';
export type {
  IEvidenceRequest,
  IEvidencePage,
  IEvidenceItem,
  IHistoryProvenance,
} from './evidence/index.js';

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
