import { z } from 'zod';

// native diagnostics are bounded independently of the normalized public message.
export const CodexTurnErrorSchema = z.object({
  message: z.string().min(1).max(131_072),
  codexErrorInfo: z
    .union([z.string().max(256), z.record(z.string().max(256), z.unknown())])
    .nullish(),
  additionalDetails: z.string().max(131_072).nullish(),
});
export type ICodexTurnError = z.infer<typeof CodexTurnErrorSchema>;
