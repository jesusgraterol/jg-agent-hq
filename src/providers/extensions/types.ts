import { z } from 'zod';

import {
  MAX_MCP_ITEMS,
  McpServerPageSchema,
  McpToolPageSchema,
  McpResourcePageSchema,
  McpServerSchema,
  McpToolSchema,
  McpResourceSchema,
} from '../../contracts/index.js';

// native server continuation is wrapped and query-bound by the runtime before public delivery
export const ProviderMcpServerPageSchema = McpServerPageSchema.omit({ provider: true }).extend({
  data: z.array(McpServerSchema).max(128),
  nextCursor: z.string().max(8192).nullable(),
});
export type IProviderMcpServerPage = z.infer<typeof ProviderMcpServerPageSchema>;
// leaf inventories are bounded before a content-revision seek page is generated
export const ProviderMcpToolsSchema = McpToolPageSchema.omit({
  provider: true,
  nextCursor: true,
}).extend({ data: z.array(McpToolSchema).max(MAX_MCP_ITEMS) });
export type IProviderMcpTools = z.infer<typeof ProviderMcpToolsSchema>;
export const ProviderMcpResourcesSchema = McpResourcePageSchema.omit({
  provider: true,
  nextCursor: true,
}).extend({ data: z.array(McpResourceSchema).max(MAX_MCP_ITEMS) });
export type IProviderMcpResources = z.infer<typeof ProviderMcpResourcesSchema>;
