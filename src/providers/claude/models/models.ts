import { hashValue } from 'jg-crypto';
import { Exception, extractMessage } from 'jg-exception';

import type {
  IProviderModel,
  IProviderModelPage,
  IProviderModelsRequest,
} from '../../../contracts/index.js';
import { decodeHistoryCursor, encodeHistoryCursor } from '../../../sessions/index.js';

import { ModelPositionSchema, NativeModelsSchema } from './types.js';

/**
 * Pages native choices by stable identity and rejects continuation against a changed inventory.
 * @returns One bounded model page from validated native metadata.
 * @throws
 * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 */
export const readClaudeModels = (
  input: unknown,
  command: IProviderModelsRequest,
): IProviderModelPage => {
  let models: IProviderModel[];
  try {
    models = NativeModelsSchema.parse(input).models.map((model) => ({
      id: model.value,
      model: model.resolvedModel ?? null,
      name: model.displayName,
      description: model.description,
      efforts: model.supportedEffortLevels ?? null,
      defaultEffort: null,
      isDefault: null,
    }));
    models.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  } catch (cause) {
    throw new Exception(`The Claude integration failed: ${extractMessage(cause)}`, {
      code: 'JG_AGENT_HQ_CLAUDE_FAILED',
      data: { kind: 'agent-unavailable' },
      cause,
    });
  }
  const { cursor, ...filters } = command;
  const revision = hashValue(JSON.stringify(models));
  const decoded = decodeHistoryCursor(cursor, filters);
  let after: string | undefined;
  if (decoded) {
    let position: ReturnType<typeof ModelPositionSchema.parse>;
    try {
      position = ModelPositionSchema.parse(JSON.parse(decoded));
    } catch (cause) {
      throw new Exception(`The HQ cursor does not match this request: ${extractMessage(cause)}`, {
        code: 'JG_AGENT_HQ_CURSOR_INVALID',
        data: { kind: 'invalid-request' },
        cause,
      });
    }
    if (position.revision !== revision)
      throw new Exception('The HQ cursor does not match this request', {
        code: 'JG_AGENT_HQ_CURSOR_INVALID',
        data: { kind: 'invalid-request' },
      });
    after = position.id;
  }
  const start = after === undefined ? 0 : models.findIndex((model) => model.id > after);
  const data = start < 0 ? [] : models.slice(start, start + command.limit);
  const last = data.at(-1);
  const hasMore = start >= 0 && start + data.length < models.length;
  return {
    provider: 'claude',
    source: 'native',
    observedAt: Date.now(),
    data,
    nextCursor: encodeHistoryCursor(
      hasMore && last ? JSON.stringify({ revision, id: last.id }) : null,
      filters,
    ),
  };
};
