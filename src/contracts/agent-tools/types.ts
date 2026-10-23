import { z } from 'zod';

import {
  CollaborationCommandSchema,
  MessageSummarySchema,
  type ICollaborationCommand,
} from '../collaboration/index.js';
import { CursorSchema } from '../identities/index.js';
import { ProviderIdSchema } from '../providers/index.js';
import { EvidenceRequestSchema, SessionDiscoveryRequestSchema } from '../evidence/index.js';

type ICommandSchema = (typeof CollaborationCommandSchema.options)[number];
type IArgumentsSchema<TKind extends ICollaborationCommand['kind']> =
  Extract<ICommandSchema, { shape: { kind: z.ZodLiteral<TKind> } }> extends z.ZodObject<
    infer TShape
  >
    ? z.ZodObject<Omit<TShape, 'kind'>, z.core.$strict>
    : never;

/** Derives tool inputs from closed HQ commands while retaining server-only sender derivation. */
const collaborationArguments = <TKind extends ICollaborationCommand['kind']>(
  kind: TKind,
): IArgumentsSchema<TKind> => {
  const found = CollaborationCommandSchema.options.find(
    (schema) => schema.shape.kind.value === kind,
  );
  if (!found) throw new Error('The collaboration tool command has no schema');
  const schema = found as Extract<ICommandSchema, { shape: { kind: z.ZodLiteral<TKind> } }>;
  const { kind: _kind, ...fields } = schema.shape;
  return z.strictObject(fields) as unknown as IArgumentsSchema<TKind>;
};

// native identity is session-bound; a selected task still requires current membership
export const AgentIdentityArgumentsSchema = z.strictObject({
  taskId: z.uuid().optional(),
  limit: z.number().int().min(1).max(128).default(32),
  cursor: CursorSchema.optional(),
});
export const AgentSpawnArgumentsSchema = z.strictObject({
  id: z.uuid(),
  taskId: z.uuid(),
  provider: ProviderIdSchema,
  workspaceRoot: z.string().min(1).max(4096),
  purpose: MessageSummarySchema.shape.summary.min(1),
});
export type IAgentSpawnArguments = z.infer<typeof AgentSpawnArgumentsSchema>;

// each implemented tool has a closed input contract; there is no arbitrary RPC forwarding
export const AgentToolCallSchema = z.discriminatedUnion('name', [
  z.strictObject({ name: z.literal('hq_identity'), arguments: AgentIdentityArgumentsSchema }),
  z.strictObject({
    name: z.literal('hq_invocation_read'),
    arguments: collaborationArguments('invocation-read'),
  }),
  z.strictObject({
    name: z.literal('hq_report_read'),
    arguments: collaborationArguments('report-read'),
  }),
  z.strictObject({
    name: z.literal('hq_request_input'),
    arguments: collaborationArguments('request-input'),
  }),
  z.strictObject({
    name: z.literal('hq_agents_list'),
    arguments: collaborationArguments('agents-list'),
  }),
  z.strictObject({ name: z.literal('hq_agent_spawn'), arguments: AgentSpawnArgumentsSchema }),
  z.strictObject({
    name: z.literal('hq_sessions_list'),
    arguments: SessionDiscoveryRequestSchema.omit({ kind: true }).extend({ taskId: z.uuid() }),
  }),
  z.strictObject({
    name: z.literal('hq_session_evidence_read'),
    arguments: EvidenceRequestSchema.omit({ kind: true }).extend({ taskId: z.uuid() }),
  }),
  z.strictObject({
    name: z.literal('hq_streams_list'),
    arguments: collaborationArguments('streams-list'),
  }),
  z.strictObject({
    name: z.literal('hq_stream_create'),
    arguments: collaborationArguments('stream-create'),
  }),
  z.strictObject({
    name: z.literal('hq_subscription_set'),
    arguments: collaborationArguments('subscription-set'),
  }),
  z.strictObject({
    name: z.literal('hq_messages_list'),
    arguments: collaborationArguments('messages-list'),
  }),
  z.strictObject({
    name: z.literal('hq_message_read'),
    arguments: collaborationArguments('message-read'),
  }),
  z.strictObject({
    name: z.literal('hq_messages_search'),
    arguments: collaborationArguments('messages-search'),
  }),
  z.strictObject({
    name: z.literal('hq_message_publish'),
    arguments: collaborationArguments('message-publish'),
  }),
  z.strictObject({
    name: z.literal('hq_message_ack'),
    arguments: collaborationArguments('message-ack'),
  }),
  z.strictObject({
    name: z.literal('hq_deliveries_list'),
    arguments: collaborationArguments('deliveries-list').omit({
      recipientAgentId: true,
      state: true,
    }),
  }),
  z.strictObject({
    name: z.literal('hq_request_read'),
    arguments: collaborationArguments('request-read'),
  }),
  z.strictObject({
    name: z.literal('hq_requests_list'),
    arguments: collaborationArguments('requests-list'),
  }),
  z.strictObject({
    name: z.literal('hq_request_claim'),
    arguments: collaborationArguments('request-claim'),
  }),
  z.strictObject({
    name: z.literal('hq_request_resolve'),
    arguments: collaborationArguments('request-resolve'),
  }),
]);
export type IAgentToolCall = z.infer<typeof AgentToolCallSchema>;
export type IAgentToolName = IAgentToolCall['name'];

// bridge credentials stay in the private transport envelope, outside model arguments and receipts
export const AgentToolRequestSchema = z
  .strictObject({
    kind: z.literal('agent-tool'),
    credential: z.string().regex(/^[a-f0-9]{64}$/),
    call: AgentToolCallSchema,
  })
  .refine(
    (request) => new TextEncoder().encode(JSON.stringify(request)).byteLength <= 64_512,
    'Agent tool input exceeds the transport budget',
  );
export type IAgentToolRequest = z.infer<typeof AgentToolRequestSchema>;
export const AgentToolResultSchema = z
  .object({
    isError: z.boolean(),
    content: z.array(z.object({ type: z.literal('text'), text: z.string().max(65_536) })).length(1),
  })
  .refine(
    (result) => new TextEncoder().encode(JSON.stringify(result)).byteLength <= 2 * 65_536 + 1024,
    'Agent tool result exceeds the transport budget',
  );
export type IAgentToolResult = z.infer<typeof AgentToolResultSchema>;
