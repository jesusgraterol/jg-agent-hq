import { z } from 'zod';

// references travel over local IPC; file bytes are read only inside the trusted host
export const InputFileSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  mediaType: z.enum([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'application/pdf',
    'text/plain',
  ]),
});
export type IInputFile = z.infer<typeof InputFileSchema>;
export const BoundInputFileSchema = InputFileSchema.extend({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive().max(2_097_152),
});
export type IBoundInputFile = z.infer<typeof BoundInputFileSchema>;

// fixed aggregate budgets leave headroom in the native 8 MiB structured frame
export const MAX_INPUT_FILES = 8;
export const MAX_INPUT_FILE_BYTES = 2_097_152;
export const MAX_TEXT_FILE_BYTES = 65_536;
