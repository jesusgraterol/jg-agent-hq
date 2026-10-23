import { z } from 'zod';

import { HqResponseSchema } from '../../../contracts/index.js';

// private worker progress; the adapter completes bounded chunks before answering a client
export const ClaudeHistoryReadSchema = z.union([
  HqResponseSchema,
  z.strictObject({ kind: z.literal('indexing') }),
]);
export type IClaudeHistoryRead = z.infer<typeof ClaudeHistoryReadSchema>;

// byte locations and chain identities stay inside the Claude adapter
export const FileRowSchema = z.object({
  native_id: z.string(),
  workspace_root: z.string(),
  identity: z.string(),
  file_size: z.number(),
  byte_offset: z.number(),
  revision: z.string(),
  leaf_id: z.string().nullable(),
  name: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  supported: z.number(),
  workspace_state: z.enum(['unknown', 'matching', 'foreign']),
});
export type IFileRow = z.infer<typeof FileRowSchema>;
// native API diagnostics have no conversation position and must never become history items
export const ApiRequestMetadataSchema = z.object({
  type: z.literal('api-request-blob'),
  sessionId: z.uuid(),
  uuid: z.never().optional(),
  parentUuid: z.never().optional(),
  cwd: z.string().optional(),
});
export const EntryRowSchema = z.object({
  uuid: z.string(),
  parent_uuid: z.string().nullable(),
  turn_id: z.string(),
  byte_offset: z.number(),
  byte_length: z.number(),
  created_at: z.number(),
  is_visible: z.number(),
});
export const RecordSchema = z.object({
  type: z.string().min(1).max(256),
  uuid: z.string().min(1).max(4096).optional(),
  parentUuid: z.string().nullable().optional(),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  timestamp: z.string().optional(),
  isSidechain: z.boolean().optional(),
  isMeta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  customTitle: z.string().max(4096).optional(),
  message: z.object({ role: z.string(), content: z.unknown() }).optional(),
});
export type IRecord = z.infer<typeof RecordSchema>;
export const SeekSchema = z.strictObject({
  createdAt: z.number().int(),
  nativeId: z.uuid(),
});
export const EntrySeekSchema = z.strictObject({
  revision: z.uuid(),
  offset: z.number().int().nonnegative(),
});
