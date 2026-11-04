import { z } from 'zod';

import {
  MessageInputSchema,
  ProviderCapabilitySetSchema,
  type IProviderCapability,
  type IProviderCapabilitySet,
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

// the operations both providers support, which an adapter overrides where it differs
export const DEFAULT_PROVIDER_OPERATIONS: IProviderCapabilitySet['operations'] = {
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
