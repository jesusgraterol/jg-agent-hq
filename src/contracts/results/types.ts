import { z } from 'zod';

// reserve 128 KiB in the 8 MiB frame for action and transport metadata
export const MAX_RESULT_BYTES = 8_388_608 - 131_072;

/** Rejects pathological schema depth and size before recursive library validation. */
const boundSchema = (input: unknown): unknown => {
  const pending = [{ input, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (++nodes > 1024 || entry.depth > 16) return undefined;
    if (entry.input && typeof entry.input === 'object') {
      for (const child of Object.values(entry.input))
        pending.push({ input: child, depth: entry.depth + 1 });
    }
  }
  return input;
};

export const OutputSchemaSchema = z
  .preprocess(boundSchema, z.record(z.string(), z.json()))
  .superRefine((schema, context) => {
    try {
      if (new TextEncoder().encode(JSON.stringify(schema)).length > 8192) {
        context.addIssue({ code: 'custom', message: 'The output schema exceeds its byte budget.' });
        return;
      }
      z.fromJSONSchema(schema);
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'A bounded, locally supported JSON Schema is required.',
      });
    }
  });
export type IOutputSchema = z.infer<typeof OutputSchemaSchema>;

// token observations retain native accounting scope; they are never billing counters
export const TurnUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().safe().nullable(),
  outputTokens: z.number().int().nonnegative().safe().nullable(),
  cachedInputTokens: z.number().int().nonnegative().safe().nullable(),
  scope: z.enum(['turn', 'thread']),
});
export type ITurnUsage = z.infer<typeof TurnUsageSchema>;
export const TurnResultSchema = z
  .object({
    state: z.enum(['completed', 'failed', 'interrupted']),
    format: z.enum(['text', 'json-schema']),
    text: z.string().nullable(),
    structuredOutput: z.json().nullable(),
    isComplete: z.boolean(),
    failure: z
      .enum(['native-error', 'invalid-structured-output', 'result-too-large', 'missing-result'])
      .nullable(),
    usage: TurnUsageSchema.nullable(),
  })
  .refine((result) => new TextEncoder().encode(JSON.stringify(result)).length <= MAX_RESULT_BYTES);
export type ITurnResult = z.infer<typeof TurnResultSchema>;
