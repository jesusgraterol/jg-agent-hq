import { hashValue } from 'jg-crypto';
import { Exception, extractMessage } from 'jg-exception';

import type {
  IProviderModel,
  IProviderModelPage,
  IProviderModelsRequest,
} from '../../../contracts/index.js';
import { createRequestCursors } from '../../../sessions/index.js';
import { HQ_ERRORS } from '../../../errors/index.js';

import { ModelPositionSchema, NativeModelsSchema } from './types.js';

// a model page continues after its final model, in the catalog revision it was read from
const positions = createRequestCursors(ModelPositionSchema);

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
      supportsFast: model.supportsFastMode ?? null,
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
  const position = positions.decode(cursor, filters);
  if (position && position.revision !== revision)
    throw HQ_ERRORS.create('cursorInvalid', { data: { kind: 'invalid-request' } });
  const after = position?.id;
  const start = after === undefined ? 0 : models.findIndex((model) => model.id > after);
  const data = start < 0 ? [] : models.slice(start, start + command.limit);
  const last = data.at(-1);
  const hasMore = start >= 0 && start + data.length < models.length;
  return {
    provider: 'claude',
    source: 'native',
    observedAt: Date.now(),
    data,
    nextCursor: positions.encode(hasMore && last ? { revision, id: last.id } : null, filters),
  };
};
