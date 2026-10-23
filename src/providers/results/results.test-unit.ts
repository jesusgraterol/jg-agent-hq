import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

import {
  OutputSchemaSchema,
  MAX_RESULT_BYTES,
  MAX_INPUT_FILES,
  MAX_INPUT_FILE_BYTES,
  MAX_TEXT_FILE_BYTES,
} from '../../contracts/index.js';
import { MAX_FRAME_BYTES } from '../../ipc/index.js';

import { toTurnResult } from './index.js';

const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};

test('native structured results preserve the complete value and reject a mismatched shape', () => {
  const text = JSON.stringify({ answer: 'verified' });
  expect(toTurnResult('completed', text, undefined, schema, null)).toStrictEqual({
    state: 'completed',
    format: 'json-schema',
    text: null,
    structuredOutput: { answer: 'verified' },
    isComplete: true,
    failure: null,
    usage: null,
  });
  expect(toTurnResult('completed', null, { answer: 1 }, schema, null)).toMatchObject({
    state: 'failed',
    structuredOutput: { answer: 1 },
    failure: 'invalid-structured-output',
  });
  expect(toTurnResult('completed', '{broken', undefined, schema, null)).toMatchObject({
    state: 'failed',
    failure: 'invalid-structured-output',
  });
});

test('result budgets reject complete payload overflow without substituting a truncated report', () => {
  const text = '🧪'.repeat(MAX_RESULT_BYTES / 4);
  expect(toTurnResult('completed', text, undefined, undefined, null)).toMatchObject({
    state: 'failed',
    text: null,
    structuredOutput: null,
    failure: 'result-too-large',
    isComplete: false,
  });
  expect(toTurnResult('completed', null, undefined, undefined, null)).toMatchObject({
    state: 'completed',
    isComplete: false,
    failure: 'missing-result',
  });
  expect(toTurnResult('interrupted', 'partial', undefined, schema, null)).toMatchObject({
    state: 'interrupted',
    text: 'partial',
    structuredOutput: null,
  });
});

test('a complete 1 MiB report survives worst-case JSON escaping without duplicate text', () => {
  const output = { report: '\u0001'.repeat(1_048_576) };
  const outputSchema = {
    type: 'object',
    properties: { report: { type: 'string' } },
    required: ['report'],
  };
  const result = toTurnResult('completed', JSON.stringify(output), undefined, outputSchema, null);
  expect(result.state).toBe('completed');
  expect(result.structuredOutput).toStrictEqual(output);
  expect(result.text).toBeNull();
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MAX_RESULT_BYTES);
});

test('output schemas reject unsupported references, excessive nesting and byte budgets before execution', () => {
  expect(OutputSchemaSchema.safeParse(schema).success).toBe(true);
  const shared = { type: 'string' };
  expect(
    OutputSchemaSchema.safeParse({ type: 'object', properties: { first: shared, second: shared } })
      .success,
  ).toBe(true);
  expect(OutputSchemaSchema.safeParse({ $ref: 'https://example.com/schema' }).success).toBe(false);
  expect(
    OutputSchemaSchema.safeParse({ type: 'string', description: 'x'.repeat(8192) }).success,
  ).toBe(false);
  let nested: object = { type: 'string' };
  for (let index = 0; index < 32; index++) nested = { type: 'array', items: nested };
  expect(OutputSchemaSchema.safeParse(nested).success).toBe(false);
});

test('documented file and result limits match the admitted capacities and frame budget', async () => {
  const api = await readFile(new URL('../../../api/README.md', import.meta.url), 'utf8');
  expect(api).toContain(`${MAX_INPUT_FILES} references`);
  for (const bytes of [MAX_RESULT_BYTES, MAX_INPUT_FILE_BYTES, MAX_TEXT_FILE_BYTES])
    expect(api).toContain(bytes.toLocaleString('en-US'));
  expect(MAX_RESULT_BYTES + 131_072).toBe(MAX_FRAME_BYTES);
});
