import type { IProviderModel } from '../../../contracts/index.js';

import { CODEX_FAST_SERVICE_TIER } from '../constants.js';
import { parseNative } from '../index.js';

import { NativeModelsSchema } from './types.js';

/**
 * Narrows one native model page without inventing model or effort identifiers.
 * @returns Normalized choices and the native continuation.
 * @throws
 * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
 */
export const toCodexModels = (
  input: unknown,
): { data: IProviderModel[]; nextCursor: string | null } => {
  const page = parseNative(NativeModelsSchema, input);
  return {
    data: page.data.map((model) => ({
      id: model.id,
      model: model.model,
      name: model.displayName,
      description: model.description,
      efforts: model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
      defaultEffort: model.defaultReasoningEffort,
      isDefault: model.isDefault,
      supportsFast: model.serviceTiers?.some((tier) => tier.id === CODEX_FAST_SERVICE_TIER) ?? null,
    })),
    nextCursor: page.nextCursor,
  };
};
