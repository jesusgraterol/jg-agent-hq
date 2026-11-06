import { z } from 'zod';

import {
  MessageInputSchema,
  ProviderCapabilitySetSchema,
  type IProviderCapability,
  type IProviderCapabilitySet,
  type IProviderId,
} from '../contracts/index.js';

// current input support is described by the same schema that admits HQ commands
export const PROVIDER_INPUT_SCHEMA = ProviderCapabilitySetSchema.shape.inputSchema
  .unwrap()
  .parse(z.toJSONSchema(MessageInputSchema));
export const SUPPORTED_PROVIDER_OPERATION = {
  state: 'supported',
  changeMode: 'live',
  reason: null,
} as const;

// the operations both providers support, which a provider overrides where it differs
const DEFAULT_PROVIDER_OPERATIONS: IProviderCapabilitySet['operations'] = {
  create: SUPPORTED_PROVIDER_OPERATION,
  adopt: SUPPORTED_PROVIDER_OPERATION,
  resume: SUPPORTED_PROVIDER_OPERATION,
  rename: SUPPORTED_PROVIDER_OPERATION,
  close: SUPPORTED_PROVIDER_OPERATION,
  interrupt: SUPPORTED_PROVIDER_OPERATION,
  recover: SUPPORTED_PROVIDER_OPERATION,
  steer: SUPPORTED_PROVIDER_OPERATION,
  history: SUPPORTED_PROVIDER_OPERATION,
  usage: SUPPORTED_PROVIDER_OPERATION,
  skills: SUPPORTED_PROVIDER_OPERATION,
  models: SUPPORTED_PROVIDER_OPERATION,
  configuration: SUPPORTED_PROVIDER_OPERATION,
  workspaceChange: {
    state: 'unsupported',
    changeMode: null,
    reason: {
      code: 'workspace-change-unsupported',
      message: 'Native workspace changes are unsupported.',
    },
  },
};

/*
 * Each provider's operation support, which never changes while it runs, so admission reads it here
 * instead of asking the native CLI. A capabilities read reports what the CLI says of the model
 * catalog and Claude's session skills in their place.
 */
export const PROVIDER_OPERATIONS: Record<IProviderId, IProviderCapabilitySet['operations']> = {
  codex: { ...DEFAULT_PROVIDER_OPERATIONS, workspaceChange: SUPPORTED_PROVIDER_OPERATION },
  claude: DEFAULT_PROVIDER_OPERATIONS,
};

// the model operation of a provider whose native model catalog can't be read
export const MODEL_CATALOG_UNAVAILABLE: IProviderCapability = {
  state: 'unavailable',
  changeMode: null,
  reason: {
    code: 'native-model-catalog-unavailable',
    message: 'The native model catalog is unavailable.',
  },
};
