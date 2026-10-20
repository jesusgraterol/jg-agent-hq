import { z } from 'zod';

// provider identifiers stay opaque and bounded at every public boundary
export const NativeIdSchema = z.string().min(1).max(4096);
