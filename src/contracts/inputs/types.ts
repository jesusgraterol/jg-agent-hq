import { z } from 'zod';

/*
 * Fixed aggregate budgets leave headroom in the native 32 MiB structured frame: in the worst
 * case, seven text files of characters JSON escapes six times over plus one binary file in
 * base64 fill about 30 MiB of it.
 */
export const MAX_INPUT_FILES = 8;
export const MAX_INPUT_FILE_BYTES = 16_777_216;
export const MAX_TEXT_FILE_BYTES = 262_144;

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
  bytes: z.number().int().positive().max(MAX_INPUT_FILE_BYTES),
});
export type IBoundInputFile = z.infer<typeof BoundInputFileSchema>;
