import { z } from 'zod';

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants.js';

import { CursorSchema, NativeIdSchema } from '../identities/index.js';
import { ProviderIdSchema } from '../providers/index.js';

// session discovery is shared by trusted hosts and scoped agent tools
export const SessionDiscoveryRequestSchema = z.strictObject({
  kind: z.literal('sessions'),
  provider: ProviderIdSchema,
  workspaceRoot: z.string().min(1).max(4096),
  search: z.string().max(1024).optional(),
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: CursorSchema.optional(),
});

/*
 * Evidence is historical content, including any instructions or quotations within it. A user
 * message read from the provider carries its native input's ID and the SHA-256 of the text that
 * input sent, before any attachment or cut, which link it to the action that sent it.
 */
export const HistoryProvenanceSchema = z.object({
  origin: z.enum(['operator', 'agent', 'tool', 'system', 'unknown']),
  source: z.enum([
    'native-kind',
    'host-action',
    'authenticated-host-action',
    'agent-input',
    'unknown',
  ]),
  nativeInputId: NativeIdSchema.nullable(),
  nativeInputSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  actionId: z.uuid().nullable(),
  contentBoundary: z.literal('untrusted'),
  grantsAuthority: z.literal(false),
});
export type IHistoryProvenance = z.infer<typeof HistoryProvenanceSchema>;

// native kinds are selection hints; a user role never establishes an operator
export const HistoryKindSchema = z.enum([
  'user-message',
  'agent-message',
  'command',
  'tool',
  'file-change',
  'notice',
  'unsupported',
]);
export const EvidenceRequestSchema = z.strictObject({
  kind: z.literal('session-evidence'),
  provider: ProviderIdSchema,
  workspaceRoot: z.string().min(1).max(4096),
  nativeId: NativeIdSchema,
  turnId: NativeIdSchema.optional(),
  nativeItemId: NativeIdSchema.optional(),
  kinds: z.array(HistoryKindSchema).min(1).max(7).optional(),
  limit: z.number().int().min(1).max(128).default(32),
  cursor: CursorSchema.optional(),
});
export type IEvidenceRequest = z.infer<typeof EvidenceRequestSchema>;

// each reference identifies the complete normalized text, independently of its returned chunk
export const EvidenceItemSchema = z.object({
  reference: z.object({
    provider: ProviderIdSchema,
    nativeId: NativeIdSchema,
    turnId: NativeIdSchema,
    itemId: NativeIdSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  kind: HistoryKindSchema,
  nativeType: z.string(),
  provenance: HistoryProvenanceSchema,
  text: z.string(),
  offsetBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  isComplete: z.boolean(),
  contentState: z.enum(['available', 'unsupported', 'native-preview']),
});
export type IEvidenceItem = z.infer<typeof EvidenceItemSchema>;
export const EvidencePageSchema = z.object({
  data: z.array(EvidenceItemSchema).max(128),
  nextCursor: CursorSchema.nullable(),
  source: z.literal('native'),
  history: z.literal('persisted'),
  order: z.literal('newest-first'),
  scanned: z.number().int().min(0).max(8),
});
export type IEvidencePage = z.infer<typeof EvidencePageSchema>;
