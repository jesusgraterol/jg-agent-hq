import { Exception } from 'jg-exception';
import { measureJsonBytes } from 'jg-utilities';
import { z } from 'zod';

import {
  AgentToolCallSchema,
  AgentToolResultSchema,
  type IAgentToolResult,
} from '../contracts/agent-tools/index.js';
import { toPublicError } from '../errors/index.js';
import { PUBLIC_ERROR_CODES } from '../contracts/index.js';

import { AGENT_TOOL_DESCRIPTIONS } from './constants.js';
import type { IAgentToolDefinition } from './types.js';

/**
 * Produces a bounded JSON tool result without silent truncation or semantic summarization.
 * @returns Exact structured content encoded once as model-visible text.
 * @throws
 * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
 */
export const agentToolResult = (payload: unknown, isError = false): IAgentToolResult => {
  if (measureJsonBytes(payload, 65_536) > 65_536)
    throw new Exception('The HQ request is invalid', {
      code: 'JG_AGENT_HQ_REQUEST_INVALID',
      data: { kind: 'invalid-request' },
    });
  return AgentToolResultSchema.parse({
    isError,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  });
};

/** Returns only safe public classifications; private errors and payloads never become tool text. */
export const agentToolError = (error: unknown): IAgentToolResult => {
  const exposed = toPublicError(error);
  return agentToolResult({ error: { ...exposed, code: PUBLIC_ERROR_CODES[exposed.kind] } }, true);
};

/** Builds native JSON descriptors from the same closed schemas used by the gateway and MCP. */
export const agentToolDefinitions = (): IAgentToolDefinition[] =>
  AgentToolCallSchema.options.map((option) => ({
    name: option.shape.name.value,
    description: AGENT_TOOL_DESCRIPTIONS[option.shape.name.value],
    inputSchema: z
      .record(z.string(), z.json())
      .parse(z.toJSONSchema(option.shape.arguments, { io: 'input' })),
  }));
