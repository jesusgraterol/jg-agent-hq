// runtime-owned provider routing
export { createProviderRegistry } from './registry.js';
export type {
  IBoundAgentProvider,
  IProviderRegistration,
  IProviderRegistryEvents,
} from './types.js';

// adapter failure classification
export { capabilityUnavailable } from './utilities.js';
