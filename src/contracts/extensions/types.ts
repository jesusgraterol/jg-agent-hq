import { z } from 'zod';

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants.js';
import { CursorSchema, NativeIdSchema } from '../identities/index.js';
import { ProviderIdSchema } from '../providers/index.js';

// concrete native extension changes; no arbitrary RPC or configuration payload is admitted
export const ExtensionControlCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('skills-reload'), threadId: z.uuid() }),
  z.strictObject({ kind: z.literal('mcp-reload'), threadId: z.uuid() }),
  z.strictObject({
    kind: z.literal('mcp-reconnect'),
    threadId: z.uuid(),
    serverName: z.string().min(1).max(4096),
  }),
  z.strictObject({
    kind: z.literal('mcp-set-enabled'),
    threadId: z.uuid(),
    serverName: z.string().min(1).max(4096),
    isEnabled: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('mcp-login'),
    threadId: z.uuid(),
    serverName: z.string().min(1).max(4096),
  }),
  z.strictObject({ kind: z.literal('plugins-reload'), threadId: z.uuid() }),
]);
export type IExtensionControlCommand = z.infer<typeof ExtensionControlCommandSchema>;

// native inventories have one aggregate budget before HQ presents their bounded pages
export const MAX_MCP_ITEMS = 4096;
export const MAX_MCP_CATALOG_BYTES = 1_048_576;
const PageFields = {
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: CursorSchema.optional(),
};
export const McpRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('mcp-servers'), threadId: z.uuid(), ...PageFields }),
  z.strictObject({
    kind: z.literal('mcp-tools'),
    threadId: z.uuid(),
    serverName: NativeIdSchema,
    ...PageFields,
  }),
  z.strictObject({
    kind: z.literal('mcp-resources'),
    threadId: z.uuid(),
    serverName: NativeIdSchema,
    ...PageFields,
  }),
]);
export type IMcpRequest = z.infer<typeof McpRequestSchema>;

// native configuration, environment, headers, error payloads and OAuth credentials are excluded
export const McpServerSchema = z.object({
  name: NativeIdSchema,
  connectionState: z.string().max(128).nullable(),
  authState: z.string().max(128).nullable(),
  source: z.string().max(256).nullable(),
  serverInfo: z.object({ name: z.string().max(256), version: z.string().max(256) }).nullable(),
});
export type IMcpServer = z.infer<typeof McpServerSchema>;
export const McpToolSchema = z.object({
  name: NativeIdSchema,
  title: z.string().max(1024).nullable(),
  description: z.string().max(16_384).nullable(),
  inputSchema: z.record(z.string(), z.json()).nullable(),
  isReadOnly: z.boolean().nullable(),
  isDestructive: z.boolean().nullable(),
  isOpenWorld: z.boolean().nullable(),
});
export type IMcpTool = z.infer<typeof McpToolSchema>;
export const McpResourceSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(['resource', 'template']),
  uri: z.string().min(1).max(8192),
  name: z.string().min(1).max(4096),
  title: z.string().max(1024).nullable(),
  description: z.string().max(16_384).nullable(),
  mediaType: z.string().max(256).nullable(),
});
export type IMcpResource = z.infer<typeof McpResourceSchema>;

const ObservationFields = {
  provider: ProviderIdSchema,
  state: z.enum(['available', 'partial', 'unavailable', 'unsupported']),
  observedAt: z.number().int().safe().nullable(),
  unavailableCount: z.number().int().nonnegative(),
  nextCursor: CursorSchema.nullable(),
};
export const McpServerPageSchema = z.object({
  ...ObservationFields,
  data: z.array(McpServerSchema).max(MAX_PAGE_SIZE),
});
export type IMcpServerPage = z.infer<typeof McpServerPageSchema>;
export const McpToolPageSchema = z.object({
  ...ObservationFields,
  data: z.array(McpToolSchema).max(MAX_PAGE_SIZE),
});
export type IMcpToolPage = z.infer<typeof McpToolPageSchema>;
export const McpResourcePageSchema = z.object({
  ...ObservationFields,
  data: z.array(McpResourceSchema).max(MAX_PAGE_SIZE),
});
export type IMcpResourcePage = z.infer<typeof McpResourcePageSchema>;
