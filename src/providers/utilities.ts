import {
  MAX_INPUT_FILE_BYTES,
  MAX_INPUT_FILES,
  MAX_TEXT_FILE_BYTES,
  type IProviderCapabilitySet,
} from '../contracts/index.js';

import { DEFAULT_PROVIDER_OPERATIONS, PROVIDER_INPUT_SCHEMA } from './constants.js';

/**
 * Builds a provider's capabilities from the operations and input limits both providers share.
 * @param overrides The operations that differ from the shared ones, the media types the provider
 * accepts, and its configuration schema.
 * @returns The provider's capability set.
 */
export const buildProviderCapabilities = ({
  operations,
  supportedMediaTypes,
  configurationSchema,
}: {
  operations: Partial<IProviderCapabilitySet['operations']>;
  supportedMediaTypes: string[];
  configurationSchema: IProviderCapabilitySet['configurationSchema'];
}): IProviderCapabilitySet => ({
  operations: { ...DEFAULT_PROVIDER_OPERATIONS, ...operations },
  inputSchema: {
    ...PROVIDER_INPUT_SCHEMA,
    supportedMediaTypes,
    maxFiles: MAX_INPUT_FILES,
    maxFileBytes: MAX_INPUT_FILE_BYTES,
    maxTextFileBytes: MAX_TEXT_FILE_BYTES,
  },
  configurationSchema,
});
