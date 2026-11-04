import {
  ACTION_PHASES,
  MAX_INPUT_FILE_BYTES,
  MAX_INPUT_FILES,
  MAX_TEXT_FILE_BYTES,
  type IActionPhase,
  type IProviderCapabilitySet,
  type IProviderId,
} from '../contracts/index.js';

import { PROVIDER_INPUT_SCHEMA, PROVIDER_OPERATIONS } from './constants.js';

// the request ID HQ sends a native CLI for an action's phase, `<action ID>:<phase>`
const ACTION_REQUEST_ID = new RegExp(`^([a-f0-9-]{36}):(${ACTION_PHASES.join('|')})$`);

/**
 * Names an action's phase in the request ID the native CLI receives, and echoes in its responses
 * and, for Codex, as the ID of the input a turn or steer sends.
 * @param actionId The action's ID.
 * @param phase The phase the action takes.
 * @returns The native request ID.
 */
export const toActionRequestId = (actionId: string, phase: IActionPhase): string =>
  `${actionId}:${phase}`;

/**
 * Reads the action and phase a native request ID names, as a native response echoes the ID.
 * @param requestId The request ID the native response answers.
 * @returns The action and the phase it took, or null for a request no action phase sent.
 */
export const parseActionRequest = (
  requestId: string,
): { actionId: string; phase: IActionPhase } | null => {
  const match = ACTION_REQUEST_ID.exec(requestId);
  return match ? { actionId: match[1]!, phase: match[2] as IActionPhase } : null;
};

/**
 * Builds a provider's capabilities from its operation support and the input limits both providers
 * share.
 * @param overrides The provider, the operations its native CLI reports now, the media types it
 * accepts, and its configuration schema.
 * @returns The provider's capability set.
 */
export const buildProviderCapabilities = ({
  provider,
  operations,
  supportedMediaTypes,
  configurationSchema,
}: {
  provider: IProviderId;
  operations: Partial<IProviderCapabilitySet['operations']>;
  supportedMediaTypes: string[];
  configurationSchema: IProviderCapabilitySet['configurationSchema'];
}): IProviderCapabilitySet => ({
  operations: { ...PROVIDER_OPERATIONS[provider], ...operations },
  inputSchema: {
    ...PROVIDER_INPUT_SCHEMA,
    supportedMediaTypes,
    maxFiles: MAX_INPUT_FILES,
    maxFileBytes: MAX_INPUT_FILE_BYTES,
    maxTextFileBytes: MAX_TEXT_FILE_BYTES,
  },
  configurationSchema,
});
