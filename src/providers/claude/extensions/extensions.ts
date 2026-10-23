import { createHash } from 'node:crypto';
import { Exception, isException } from 'jg-exception';
import { z } from 'zod';

import {
  MAX_MCP_CATALOG_BYTES,
  MAX_MCP_ITEMS,
  McpServerSchema,
  McpToolSchema,
} from '../../../contracts/index.js';
import type {
  IProviderMcpServerPage,
  IProviderMcpTools,
  IProviderMcpResources,
} from '../../extensions/index.js';
import type { createClaudeRpc } from '../rpc.js';

const ServerSchema = z.object({
  name: z.string(),
  status: z.string(),
  source: z.string().nullish(),
  scope: z.string().nullish(),
  serverInfo: z.object({ name: z.string(), version: z.string() }).nullish(),
  tools: z.unknown().optional(),
});
const ToolSchema = z.object({
  name: z.string(),
  description: z.string().nullish(),
  annotations: z
    .object({
      readOnly: z.boolean().nullish(),
      destructive: z.boolean().nullish(),
      openWorld: z.boolean().nullish(),
    })
    .nullish(),
});
const StatusSchema = z.object({ mcpServers: z.array(z.unknown()).max(MAX_MCP_ITEMS) });

/**
 * Reads the selected native Claude controller without inspecting config or credential files.
 * @returns Safe MCP metadata; unavailable native resource discovery remains explicit.
 */
export const createClaudeExtensions = (connection: Awaited<ReturnType<typeof createClaudeRpc>>) => {
  const status = async () =>
    StatusSchema.parse(await connection.requestControl({ subtype: 'mcp_status' }));
  return {
    /**
     * @returns A bounded server-name seek page of the native session's configuration.
     * @throws
     * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
     */
    async readMcpServers(limit: number, cursor?: string): Promise<IProviderMcpServerPage> {
      const empty: IProviderMcpServerPage = {
        state: 'unavailable',
        observedAt: null,
        unavailableCount: 0,
        nextCursor: null,
        data: [],
      };
      try {
        const native = await status();
        const data: IProviderMcpServerPage['data'] = [];
        let unavailableCount = 0;
        for (const raw of native.mcpServers) {
          const server = ServerSchema.safeParse(raw);
          if (!server.success) {
            unavailableCount++;
            continue;
          }
          const parsed = McpServerSchema.safeParse({
            name: server.data.name,
            connectionState: server.data.status,
            authState: server.data.status === 'needs-auth' ? 'notLoggedIn' : null,
            source: server.data.source ?? server.data.scope ?? null,
            serverInfo: server.data.serverInfo ?? null,
          });
          if (parsed.success) data.push(parsed.data);
          else unavailableCount++;
        }
        if (Buffer.byteLength(JSON.stringify(data)) > MAX_MCP_CATALOG_BYTES) return empty;
        data.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
        if (data.some((entry, index) => index > 0 && data[index - 1]!.name === entry.name))
          return empty;
        // the runtime wraps this exact native inventory revision and seek tuple
        const revision = createHash('sha256').update(JSON.stringify(data)).digest('hex');
        let after: string | null = null;
        if (cursor) {
          let raw: unknown;
          try {
            raw = JSON.parse(cursor);
          } catch {
            raw = null;
          }
          const position = z
            .strictObject({ revision: z.literal(revision), name: z.string().min(1).max(4096) })
            .safeParse(raw);
          if (!position.success)
            throw new Exception('The HQ cursor does not match this request', {
              code: 'JG_AGENT_HQ_CURSOR_INVALID',
              data: { kind: 'invalid-request' },
            });
          after = position.data.name;
        }
        const start = after === null ? 0 : data.findIndex((entry) => entry.name > after!);
        const selected = start < 0 ? [] : data.slice(start, start + limit);
        const last = selected.at(-1);
        return {
          state: unavailableCount ? 'partial' : 'available',
          observedAt: Date.now(),
          unavailableCount,
          data: selected,
          nextCursor:
            last && start + selected.length < data.length
              ? JSON.stringify({ revision, name: last.name })
              : null,
        };
      } catch (cause) {
        if (isException(cause) && cause.code === 'JG_AGENT_HQ_CURSOR_INVALID') throw cause;
        return empty;
      }
    },
    /** @returns Native tool names and annotations; this interface does not expose input schemas. */
    async readMcpTools(serverName: string): Promise<IProviderMcpTools> {
      const empty: IProviderMcpTools = {
        state: 'unavailable',
        observedAt: null,
        unavailableCount: 0,
        data: [],
      };
      try {
        const native = await status();
        const raw = native.mcpServers.find(
          (row) => z.object({ name: z.literal(serverName) }).safeParse(row).success,
        );
        const server = ServerSchema.safeParse(raw);
        if (!server.success) return empty;
        const tools = z.array(z.unknown()).max(MAX_MCP_ITEMS).safeParse(server.data.tools);
        if (!tools.success) return empty;
        const data: IProviderMcpTools['data'] = [];
        let unavailableCount = 0;
        for (const rawTool of tools.data) {
          const tool = ToolSchema.safeParse(rawTool);
          if (!tool.success) {
            unavailableCount++;
            continue;
          }
          const parsed = McpToolSchema.safeParse({
            name: tool.data.name,
            title: null,
            description: tool.data.description ?? null,
            inputSchema: null,
            isReadOnly: tool.data.annotations?.readOnly ?? null,
            isDestructive: tool.data.annotations?.destructive ?? null,
            isOpenWorld: tool.data.annotations?.openWorld ?? null,
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
    /** @returns Explicit unsupported state; native MCP status does not list resource catalogs. */
    async readMcpResources(): Promise<IProviderMcpResources> {
      return { state: 'unsupported', observedAt: null, unavailableCount: 0, data: [] };
    },
  };
};
