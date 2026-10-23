import { readFile } from 'node:fs/promises';
import { McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

import { AgentToolCallSchema } from '../../contracts/agent-tools/index.js';
import { readBridgeCredential } from '../../collaboration/identity/index.js';
import { requestAgentHq } from '../../ipc/index.js';

import { AGENT_TOOL_DESCRIPTIONS } from '../constants.js';
import { agentToolError } from '../utilities.js';

/**
 * Serves only implemented HQ tools over native stdio, authenticating through a private file.
 * @returns The SDK-owned connection handle; EOF aborts outstanding client requests.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 */
export const serveAgentBridge = async (credentialPath: string) => {
  const credentials = await readBridgeCredential(credentialPath);
  const manifest = z
    .object({ version: z.string() })
    .parse(JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')));
  return serveStdio(
    () => {
      const server = new McpServer(
        { name: 'jg-agent-hq', version: manifest.version },
        { maxToolInputElements: 4096 },
      );
      for (const option of AgentToolCallSchema.options) {
        const name = option.shape.name.value;
        server.registerTool(
          name,
          {
            description: AGENT_TOOL_DESCRIPTIONS[name],
            inputSchema: option.shape.arguments,
          },
          async (argumentsValue: unknown, context: ServerContext) => {
            try {
              const call = AgentToolCallSchema.parse({ name, arguments: argumentsValue });
              const response = await requestAgentHq(
                credentials.stateRoot,
                {
                  kind: 'agent-tool',
                  credential: credentials.credential,
                  call,
                },
                context.mcpReq.signal,
              );
              if (response.kind !== 'agent-tool') throw new Error('Unexpected HQ response');
              return response.result;
            } catch (error) {
              return agentToolError(error);
            }
          },
        );
      }
      return server;
    },
    {
      transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 65_536 }),
      onerror: () => process.stderr.write('HQ agent bridge transport failed.\n'),
    },
  );
};
