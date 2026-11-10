import { z } from 'zod';

// complete structured presentation leaves room for identity and text within bounded responses
export const MAX_ASYNC_INPUT_BYTES = 32_768;

// native question positions and choices retain their original order and exact strings
export const AsyncQuestionSchema = z.object({
  title: z.string().min(1).max(8192),
  options: z.array(z.string().min(1).max(8192)).max(32).optional(),
});
export type IAsyncQuestion = z.infer<typeof AsyncQuestionSchema>;

// unavailable metadata preserves explicit async semantics without presenting a partial answer contract
export const AsyncInputSchema = z
  .discriminatedUnion('state', [
    z.object({
      delivery: z.literal('async'),
      state: z.literal('available'),
      questions: z.array(AsyncQuestionSchema).min(1).max(32),
    }),
    z.object({
      delivery: z.literal('async'),
      state: z.literal('unavailable'),
      reason: z.enum(['invalid', 'too-large']),
    }),
  ])
  .refine(
    (input) => new TextEncoder().encode(JSON.stringify(input)).length <= MAX_ASYNC_INPUT_BYTES,
  );
export type IAsyncInput = z.infer<typeof AsyncInputSchema>;
