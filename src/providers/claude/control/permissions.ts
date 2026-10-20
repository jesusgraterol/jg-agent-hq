import { Exception } from 'error-message-utils';
import { z } from 'zod';

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
const RequestSchema = z.object({
  subtype: z.literal('can_use_tool'),
  tool_name: z.string().min(1).max(256),
  tool_use_id: z.string().min(1).max(4096),
  input: z.record(z.string(), z.unknown()),
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
): { prompt: INativePrompt; toolId: string } | null => {
  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(raw)) > 32_768) return null;
  const request = parsed.data;
  const questions =
    request.tool_name === 'AskUserQuestion'
      ? z.object({ questions: z.array(QuestionSchema).min(1).max(32) }).safeParse(request.input)
      : null;
  if (questions && !questions.success) return null;
  const questionRows = questions?.success ? questions.data.questions : [];
  if (new Set(questionRows.map((question) => question.question)).size !== questionRows.length)
    return null;
  const respond = (response: unknown) =>
    write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    });
  const invalid: () => never = () => {
    throw new Exception('The HQ request is invalid', undefined, { kind: 'invalid-request' });
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
        detail: questionRows.length ? '' : JSON.stringify(request.input),
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
