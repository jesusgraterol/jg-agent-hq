import { z } from 'zod';

import {
  MAX_RESULT_BYTES,
  type IOutputSchema,
  type ITurnResult,
  type ITurnUsage,
} from '../../contracts/index.js';

/**
 * Validates a complete native final result without substituting a presentation excerpt.
 * @returns A complete result, or an explicit failed result when capture/validation cannot succeed.
 */
export const toTurnResult = (
  state: ITurnResult['state'],
  text: string | null,
  structuredOutput: unknown,
  schema: IOutputSchema | undefined,
  usage: ITurnUsage | null,
): ITurnResult => {
  const result: ITurnResult = {
    state,
    format: schema ? 'json-schema' : 'text',
    text,
    structuredOutput: null,
    isComplete: true,
    failure: state === 'failed' ? 'native-error' : null,
    usage,
  };
  try {
    if (Buffer.byteLength(JSON.stringify([text, structuredOutput ?? null])) > MAX_RESULT_BYTES) {
      result.failure = 'result-too-large';
      result.isComplete = false;
      result.text = null;
    } else if (schema && state === 'completed') {
      const value: unknown =
        structuredOutput === undefined && text !== null ? JSON.parse(text) : structuredOutput;
      result.structuredOutput = z.json().parse(value);
      result.text = null;
      const validation = z.fromJSONSchema(schema).safeParse(value);
      if (!validation.success) result.failure = 'invalid-structured-output';
    } else if (state === 'completed' && text === null) {
      result.failure = 'missing-result';
      result.isComplete = false;
    }
  } catch {
    result.failure = 'invalid-structured-output';
  }
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) {
    result.failure = 'result-too-large';
    result.isComplete = false;
    result.text = null;
    result.structuredOutput = null;
  }
  if (result.failure && result.failure !== 'missing-result') result.state = 'failed';
  return result;
};
