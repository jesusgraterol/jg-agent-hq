// native runtime and local client
export type { IAsyncInputSource, IAsyncInputEvent, IAsyncInputListener } from './runtime/index.js';
export { createAgentHq } from './runtime/index.js';
export type {
  IAgentHq,
  IAgentHqOptions,
  IPreviousRuntimeCheck,
  IPreviousRuntimeOwner,
} from './runtime/index.js';
export { requestAgentHq } from './ipc/index.js';

// safe error classification
export { getErrorKind } from './errors/index.js';

// provider identity, status and capabilities
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
export { openHostDatabase } from './storage/index.js';
export type { IStorageDescriptor, IStorageMaintenanceOperation } from './storage/index.js';

// trusted host snapshot packing and offline recovery
export { restoreHqSnapshot, packHqSnapshot, unpackHqSnapshot } from './snapshots/index.js';
export type {
  IHqSnapshotInspection,
  IHqRestoreOptions,
  IHqRestoreResult,
} from './snapshots/index.js';

// file inputs and complete native results
export type {
  IInputFile,
  IBoundInputFile,
  IOutputSchema,
  ITurnUsage,
  ITurnResult,
  IPreparedInput,
} from './contracts/index.js';
