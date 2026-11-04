import { z } from 'zod';

import type { IHqResponse } from '../../../contracts/index.js';

// private worker progress; the adapter completes bounded chunks before answering a client
export type IClaudeHistoryRead = IHqResponse | { kind: 'indexing' };

// the new transcript bytes one worker call may still index, and whether it has indexed a record
export type IIndexingBudget = { bytes: number; hasIndexed: boolean };

// byte locations and chain identities stay inside the Claude adapter
export type IFileRow = {
  native_id: string;
  workspace_root: string;
  identity: string;
  file_size: number;
  modified_at: number | null;
  byte_offset: number;
  revision: string;
  leaf_id: string | null;
  name: string | null;
  created_at: number;
  updated_at: number;
  supported: number;
  // matching once a record ran inside the workspace; foreign while every record named another folder
  workspace_state: 'unknown' | 'matching' | 'foreign';
};
// native API diagnostics have no conversation position and must never become history items
export const ApiRequestMetadataSchema = z.object({
  type: z.literal('api-request-blob'),
  sessionId: z.uuid(),
  uuid: z.never().optional(),
  parentUuid: z.never().optional(),
  cwd: z.string().optional(),
});
// one indexed record's position, chain and turn
export type IEntryRow = {
  uuid: string;
  parent_uuid: string | null;
  turn_id: string;
  byte_offset: number;
  byte_length: number;
  created_at: number;
  is_visible: number;
};
export const RecordSchema = z.object({
  type: z.string().min(1).max(256),
  uuid: z.string().min(1).max(4096).optional(),
  // bounded like a UUID, since a `!` shell output presents its parent as its item's call ID
  parentUuid: z.string().min(1).max(4096).nullable().optional(),
  // a compaction boundary starts a new chain, and names the record it follows here
  logicalParentUuid: z.string().nullable().optional(),
  subtype: z.string().optional(),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  timestamp: z.string().optional(),
  isSidechain: z.boolean().optional(),
  isMeta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  customTitle: z.string().max(4096).optional(),
  message: z.object({ role: z.string(), content: z.unknown() }).optional(),
  // the CLI's own result metadata, such as an edit's patch, which live frames call tool_use_result
  toolUseResult: z.unknown().optional(),
  // the call a tool result answers, which Claude Code also writes as the result's parent
  sourceToolAssistantUUID: z.string().optional(),
});
export type IRecord = z.infer<typeof RecordSchema>;
// the file Claude Code records on an Edit or Write result; a created file's patch is empty
export const FilePatchSchema = z.object({
  filePath: z.string().min(1).max(4096),
  type: z.string().optional(),
  content: z.string().optional(),
  structuredPatch: z.array(
    z.object({
      oldStart: z.number().int().nonnegative(),
      oldLines: z.number().int().nonnegative(),
      newStart: z.number().int().nonnegative(),
      newLines: z.number().int().nonnegative(),
      lines: z.array(z.string()),
    }),
  ),
});
export type IFilePatch = z.infer<typeof FilePatchSchema>;
export const SeekSchema = z.strictObject({
  updatedAt: z.number().int(),
  nativeId: z.uuid(),
});
export const EntrySeekSchema = z.strictObject({
  revision: z.uuid(),
  offset: z.number().int().nonnegative(),
});
