import { Exception } from 'jg-exception';
import { z } from 'zod';

import { NativeElicitationSchema, OutputSchemaSchema } from '../../../contracts/index.js';
import { presentElicitation, validateElicitation } from '../../elicitation/index.js';
import type { INativePrompt } from '../../types.js';

const QuestionSchema = z.object({
  question: z.string().min(1).max(4096),
  header: z.string().max(256),
  multiSelect: z.boolean(),
  options: z
    .array(z.object({ label: z.string().max(8192), description: z.string().max(8192) }))
    .min(1)
    .max(32),
});
const RequestSchema = z.strictObject({
  subtype: z.literal('can_use_tool'),
  tool_name: z.string().min(1).max(256),
  tool_use_id: z.string().min(1).max(4096),
  input: z.record(z.string(), z.unknown()),
  mcp_server: z.unknown().optional(),
  permission_suggestions: z.array(z.unknown()).max(128).optional(),
  blocked_path: z.string().max(4096).optional(),
  decision_reason: z.string().max(8192).optional(),
  decision_reason_type: z
    .enum([
      'rule',
      'mode',
      'subcommandResults',
      'permissionPromptTool',
      'hook',
      'asyncAgent',
      'sandboxOverride',
      'workingDir',
      'safetyCheck',
      'classifier',
      'other',
    ])
    .optional(),
  decision_reason_rule_source: z.string().max(256).optional(),
  server_policy_ask_only: z.boolean().optional(),
  classifier_approvable: z.boolean().optional(),
  suppress_always_allow_rule: z.boolean().optional(),
  default_to_no: z.boolean().optional(),
  matched_ask_rule: z
    .object({ source: z.string(), tool_name: z.string(), rule_content: z.string().optional() })
    .optional(),
  title: z.string().max(4096).optional(),
  display_name: z.string().max(4096).optional(),
  agent_id: z.string().max(4096).optional(),
  description: z.string().max(8192).optional(),
  requires_user_interaction: z.boolean().optional(),
});
const ElicitationRequestSchema = z.strictObject({
  subtype: z.literal('elicitation'),
  mcp_server_name: z.string().min(1).max(256),
  message: z.string().max(8192),
  mode: z.enum(['form', 'url']).default('form'),
  url: NativeElicitationSchema.shape.url.unwrap().optional(),
  elicitation_id: z.string().min(1).max(4096).optional(),
  requested_schema: OutputSchemaSchema.optional(),
  property_order: z.array(z.string().max(4096)).max(128).optional(),
  title: z.string().max(4096).optional(),
  display_name: z.string().max(4096).optional(),
  description: z.string().max(8192).optional(),
});

/**
 * Binds a native tool request to one turn without accepting arbitrary tool-input edits.
 * @returns The scoped prompt and tool identity, or null for an unsupported request.
 */
export const createClaudePrompt = (
  raw: unknown,
  nativeId: string,
  turnId: string,
  scope: string,
  requestId: string,
  write: (message: unknown) => Promise<void>,
): { prompt: INativePrompt; toolId: string | null } | null => {
  if (Buffer.byteLength(JSON.stringify(raw)) > 32_768) return null;
  const elicitation = ElicitationRequestSchema.safeParse(raw);
  if (elicitation.success) {
    const request = elicitation.data;
    if (
      request.mode === 'form' ? !request.requested_schema : !request.url || !request.elicitation_id
    )
      return null;
    const presentation = presentElicitation({
      mode: request.mode,
      serverName: request.mcp_server_name,
      message: request.message,
      requestedSchema: request.mode === 'form' ? request.requested_schema! : null,
      url: request.mode === 'url' ? request.url! : null,
      elicitationId: request.elicitation_id ?? null,
    });
    const respond = (response: unknown) =>
      write({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response },
      });
    return {
      toolId: null,
      prompt: {
        provider: 'claude',
        nativeThreadId: nativeId,
        nativeTurnId: turnId,
        requestId: JSON.stringify(['claude', scope, requestId]),
        fingerprint: JSON.stringify(raw),
        presentation,
        validate: (response) => validateElicitation(presentation.elicitation!, response),
        reply: respond,
        reject: () => respond({ action: 'decline', content: null }),
      },
    };
  }
  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success) return null;
  const request = parsed.data;
  const questions =
    request.tool_name === 'AskUserQuestion'
      ? z.object({ questions: z.array(QuestionSchema).min(1).max(32) }).safeParse(request.input)
      : null;
  if (questions && !questions.success) return null;
  const questionRows = questions?.success ? questions.data.questions : [];
  if (request.requires_user_interaction && !questionRows.length) return null;
  if (new Set(questionRows.map((question) => question.question)).size !== questionRows.length)
    return null;
  const respond = (response: unknown) =>
    write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    });
  const invalid: () => never = () => {
    throw new Exception('The HQ request is invalid', {
      code: 'JG_AGENT_HQ_REQUEST_INVALID',
      data: { kind: 'invalid-request' },
    });
  };
  return {
    toolId: request.tool_use_id,
    prompt: {
      provider: 'claude',
      nativeThreadId: nativeId,
      nativeTurnId: turnId,
      requestId: JSON.stringify(['claude', scope, requestId]),
      fingerprint: JSON.stringify(raw),
      presentation: {
        kind: questionRows.length ? 'question' : 'permission',
        isBlocking: true,
        title: questionRows.length ? 'Claude needs your answer' : `Allow ${request.tool_name}?`,
        detail: JSON.stringify(request),
        decisions: questionRows.length ? [] : ['accept', 'decline'],
        questions: questionRows.map((question) => ({
          id: question.question,
          header: question.header,
          question: question.question,
          isSecret: false,
          isOther: true,
          allowsMultiple: question.multiSelect,
          options: question.options,
        })),
      },
      validate(response) {
        if (questionRows.length) {
          if (
            response.kind !== 'answers' ||
            Object.keys(response.answers).length !== questionRows.length
          )
            invalid();
          const answers: Record<string, string> = {};
          for (const question of questionRows) {
            const selected = response.answers[question.question];
            if (!selected || (!question.multiSelect && selected.length !== 1)) invalid();
            Object.defineProperty(answers, question.question, {
              enumerable: true,
              value: selected.join(', '),
            });
          }
          return { behavior: 'allow', updatedInput: { ...request.input, answers } };
        }
        if (response.kind !== 'decision' || !['accept', 'decline'].includes(response.decision))
          invalid();
        return response.decision === 'accept'
          ? { behavior: 'allow', updatedInput: request.input }
          : { behavior: 'deny', message: 'The operator declined this request' };
      },
      reply: respond,
      reject: () => respond({ behavior: 'deny', message: 'HQ cannot answer this request' }),
    },
  };
};
