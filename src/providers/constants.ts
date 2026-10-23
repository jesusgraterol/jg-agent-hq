import { z } from 'zod';

import { MessageInputSchema, ProviderCapabilitySetSchema } from '../contracts/index.js';

// current input support is described by the same schema that admits HQ commands
export const PROVIDER_INPUT_SCHEMA = ProviderCapabilitySetSchema.shape.inputSchema
  .unwrap()
  .parse(z.toJSONSchema(MessageInputSchema));
export const SUPPORTED_PROVIDER_OPERATION = {
  state: 'supported',
  changeMode: 'live',
  reason: null,
} as const;
