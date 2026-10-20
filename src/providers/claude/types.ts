import { z } from 'zod';

// the local reader is qualified against this exact CLI transcript capability
export const CLAUDE_HISTORY_VERSION = '2.1.304';
export const ClaudeInitializeSchema = z.object({ claude_code_version: z.string().min(1).max(128) });
export const ClaudeUsageSchema = z.object({
  subscription_type: z.string().nullable(),
  rate_limits_available: z.boolean(),
  rate_limits: z
    .object({
      limits: z
        .array(
          z.object({
            kind: z.string().min(1).max(128),
            group: z.string().min(1).max(128),
            percent: z.number().finite().nonnegative().nullable(),
            resets_at: z
              .string()
              .refine((text) => Number.isFinite(Date.parse(text)))
              .nullable(),
            is_active: z.boolean(),
            scope: z
              .object({
                model: z
                  .object({ id: z.string().max(256).nullable(), display_name: z.string().max(256) })
                  .nullable(),
                surface: z.string().max(256).nullable(),
              })
              .nullable(),
          }),
        )
        .max(128),
    })
    .nullable(),
  behaviors: z.null(),
});
export type IClaudeUsage = z.infer<typeof ClaudeUsageSchema>;
