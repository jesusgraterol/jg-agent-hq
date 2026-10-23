import { createHash } from 'node:crypto';
import { z } from 'zod';

import {
  MAX_MCP_CATALOG_BYTES,
  MAX_MCP_ITEMS,
  McpServerSchema,
  McpToolSchema,
  McpResourceSchema,
} from '../../../contracts/index.js';
import type {
  IProviderMcpServerPage,
  IProviderMcpTools,
  IProviderMcpResources,
} from '../../extensions/index.js';
import type { createCodexRpc } from '../rpc.js';

const ServerSchema = z.object({
  name: z.string(),
  runtimeStatus: z.string().nullish(),
  authStatus: z.string().nullish(),
  pluginId: z.string().nullish(),
  serverInfo: z.object({ name: z.string(), version: z.string() }).nullish(),
  tools: z.record(z.string(), z.unknown()).optional(),
  toolsError: z.string().nullish(),
  resources: z.array(z.unknown()).optional(),
  resourceTemplates: z.array(z.unknown()).optional(),
});
const PageSchema = z.object({
  data: z.array(z.unknown()).max(128),
  nextCursor: z.string().max(8192).nullable(),
});
const ToolSchema = z.object({
  name: z.string(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  inputSchema: z.record(z.string(), z.json()).nullish(),
  annotations: z
    .object({
      readOnlyHint: z.boolean().nullish(),
      destructiveHint: z.boolean().nullish(),
      openWorldHint: z.boolean().nullish(),
    })
    .nullish(),
});
const ResourceSchema = z.object({
  name: z.string(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  mimeType: z.string().nullish(),
  uri: z.string().optional(),
  uriTemplate: z.string().optional(),
});

/**
 * Reads only configured native MCP metadata, never server configuration or credential material.
 * @returns Native server pages and bounded leaf inventories without altering configuration.
 */
export const createCodexExtensions = (connection: Awaited<ReturnType<typeof createCodexRpc>>) => {
  const selected = async (
    nativeId: string,
    serverName: string,
    detail: 'full' | 'toolsAndAuthOnly',
  ) => {
    const page = PageSchema.parse(
      await connection.request('mcpServerStatus/list', {
        threadId: nativeId,
        serverName,
        limit: 1,
        detail,
      }),
    );
    if (page.data.length !== 1) return null;
    const server = ServerSchema.safeParse(page.data[0]);
    return server.success && server.data.name === serverName ? server.data : null;
  };
  return {
    /** @returns One native continuation page with safe server identity and connection metadata. */
    async readMcpServers(
      nativeId: string,
      limit: number,
      cursor?: string,
    ): Promise<IProviderMcpServerPage> {
      const empty: IProviderMcpServerPage = {
        state: 'unavailable',
        observedAt: null,
        unavailableCount: 0,
        nextCursor: null,
        data: [],
      };
      try {
        const page = PageSchema.parse(
          await connection.request('mcpServerStatus/list', {
            threadId: nativeId,
            limit,
            cursor,
            detail: 'toolsAndAuthOnly',
          }),
        );
        if (page.data.length > limit) return empty;
        const data: IProviderMcpServerPage['data'] = [];
        let unavailableCount = 0;
        for (const raw of page.data) {
          const native = ServerSchema.safeParse(raw);
          if (!native.success) {
            unavailableCount++;
            continue;
          }
          const server = native.data;
          const parsed = McpServerSchema.safeParse({
            name: server.name,
            connectionState: server.runtimeStatus ?? null,
            authState: server.authStatus ?? null,
            source: server.pluginId ?? null,
            serverInfo: server.serverInfo ?? null,
          });
          if (parsed.success) data.push(parsed.data);
          else unavailableCount++;
        }
        const result: IProviderMcpServerPage = {
          state: unavailableCount ? 'partial' : 'available',
          observedAt: Date.now(),
          unavailableCount,
          data,
          nextCursor: page.nextCursor,
        };
        return Buffer.byteLength(JSON.stringify(result)) <= MAX_MCP_CATALOG_BYTES ? result : empty;
      } catch {
        return empty;
      }
    },
    /** @returns One bounded native tool inventory with no configuration fields. */
    async readMcpTools(nativeId: string, serverName: string): Promise<IProviderMcpTools> {
      const empty: IProviderMcpTools = {
        state: 'unavailable',
        observedAt: null,
        unavailableCount: 0,
        data: [],
      };
      try {
        const server = await selected(nativeId, serverName, 'toolsAndAuthOnly');
        if (!server?.tools || server.toolsError) return empty;
        if (Object.keys(server.tools).length > MAX_MCP_ITEMS) return empty;
        const data: IProviderMcpTools['data'] = [];
        let unavailableCount = 0;
        for (const raw of Object.values(server.tools)) {
          const native = ToolSchema.safeParse(raw);
          if (!native.success) {
            unavailableCount++;
            continue;
          }
          const tool = native.data;
          const parsed = McpToolSchema.safeParse({
            name: tool.name,
            title: tool.title ?? null,
            description: tool.description ?? null,
            inputSchema: tool.inputSchema ?? null,
            isReadOnly: tool.annotations?.readOnlyHint ?? null,
            isDestructive: tool.annotations?.destructiveHint ?? null,
            isOpenWorld: tool.annotations?.openWorldHint ?? null,
          });
          if (parsed.success) data.push(parsed.data);
          else unavailableCount++;
        }
        const result: IProviderMcpTools = {
          state: unavailableCount ? 'partial' : 'available',
          observedAt: Date.now(),
          unavailableCount,
          data,
        };
        return Buffer.byteLength(JSON.stringify(result)) <= MAX_MCP_CATALOG_BYTES ? result : empty;
      } catch {
        return empty;
      }
    },
    /** @returns Resource and template descriptions without fetching their contents. */
    async readMcpResources(nativeId: string, serverName: string): Promise<IProviderMcpResources> {
      const empty: IProviderMcpResources = {
        state: 'unavailable',
        observedAt: null,
        unavailableCount: 0,
        data: [],
      };
      try {
        const server = await selected(nativeId, serverName, 'full');
        if (!server?.resources || !server.resourceTemplates) return empty;
        if (server.resources.length + server.resourceTemplates.length > MAX_MCP_ITEMS) return empty;
        const data: IProviderMcpResources['data'] = [];
        let unavailableCount = 0;
        for (const kind of ['resource', 'template'] as const)
          for (const raw of kind === 'resource' ? server.resources : server.resourceTemplates) {
            const native = ResourceSchema.safeParse(raw);
            if (!native.success) {
              unavailableCount++;
              continue;
            }
            const resource = native.data;
            const uri = kind === 'resource' ? resource.uri : resource.uriTemplate;
            const parsed = McpResourceSchema.safeParse({
              id: createHash('sha256')
                .update(JSON.stringify([kind, uri]))
                .digest('hex'),
              kind,
              uri,
              name: resource.name,
              title: resource.title ?? null,
              description: resource.description ?? null,
              mediaType: resource.mimeType ?? null,
            });
            if (parsed.success) data.push(parsed.data);
            else unavailableCount++;
          }
        const result: IProviderMcpResources = {
          state: unavailableCount ? 'partial' : 'available',
          observedAt: Date.now(),
          unavailableCount,
          data,
        };
        return Buffer.byteLength(JSON.stringify(result)) <= MAX_MCP_CATALOG_BYTES ? result : empty;
      } catch {
        return empty;
      }
    },
  };
};
