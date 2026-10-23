import { z } from 'zod';

// provider identifiers stay opaque and bounded at every public boundary
export const NativeIdSchema = z.string().min(1).max(4096);

// continuations contain bounded provider data plus HQ query binding
export const CursorSchema = z.string().min(1).max(16_384);

// native session trees remain distinct from HQ agent and request relationships
export const NativeLineageSchema = z.object({
  sessionId: NativeIdSchema.nullable(),
  parentThreadId: NativeIdSchema.nullable(),
  forkedFromId: NativeIdSchema.nullable(),
});
export type INativeLineage = z.infer<typeof NativeLineageSchema>;
