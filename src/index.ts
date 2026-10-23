// shared lock contracts and lifecycle
export {
  type IHqLockOwner,
  type IOwnerLiveness,
  type IHqLockOptions,
  type IHqLockState,
  RUNTIME_DIRECTORY,
  HQ_LOCK_FILE,
  getOwnerLiveness,
  acquireHqLock,
  withHqLock,
  releaseHqLock,
  readHqLockState,
} from './locks/index.js';

// native runtime and local client
export { createAgentHq } from './runtime/index.js';
export type { IAgentHq, IAgentHqOptions } from './runtime/index.js';
export { requestAgentHq } from './ipc/index.js';

// trusted native provider adapters
export type {
  IAgentProvider,
  IAgentProviderFactory,
  IAgentProviderContext,
  IAgentProviderEvents,
  IAgentProviderOutcome,
  INativePrompt,
  IProviderCall,
  IProviderThread,
  IProviderInspection,
  IProviderSkills,
  IProviderMcpServerPage,
  IProviderMcpTools,
  IProviderMcpResources,
} from './providers/index.js';
export type {
  IProviderAgentTools,
  IAgentToolDefinition,
  IAgentMcpLease,
} from './agent-tools/index.js';
export type {
  IProviderId,
  IProviderCapability,
  IProviderCapabilitySet,
  IProviderCapabilities,
  IProviderStatus,
} from './contracts/providers/index.js';
export type {
  IProviderModel,
  IProviderModelPage,
  IProviderModelsRequest,
} from './contracts/models/index.js';
export type {
  ITurnSettings,
  ISessionSettings,
  IConfigurationRequest,
  IConfigurationChoice,
  ISessionConfiguration,
} from './contracts/configuration/index.js';
export type { INativeLineage } from './contracts/identities/index.js';

// trusted host storage
export type { IStorageDescriptor, IStorageMaintenanceOperation } from './storage/index.js';

// pure execution revision contracts
export { computePlanRevision } from './plans/index.js';
export type { IPlanContract, IPlanContractParser } from './plans/index.js';

// native media transport and results
export type { IProviderInputFile } from './providers/index.js';
export type {
  IInputFile,
  IBoundInputFile,
  IOutputSchema,
  ITurnUsage,
  ITurnResult,
  IPreparedInput,
} from './contracts/index.js';
