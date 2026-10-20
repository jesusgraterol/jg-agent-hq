import { Exception } from 'error-message-utils';

import type { IActionCommand, INativeApproval } from '../../../contracts/index.js';

import {
  CommandApprovalSchema,
  FileApprovalSchema,
  PermissionApprovalSchema,
  QuestionApprovalSchema,
  type ICodexPrompt,
} from './types.js';

type IReply = Extract<IActionCommand, { kind: 'native-reply' }>['response'];

/** Decodes supported requests; unknown or excessive permission scopes cannot be approved. */
export const parseCodexPrompt = (method: string, params: unknown): ICodexPrompt | null => {
  const detail = JSON.stringify(params);
  if (!detail || Buffer.byteLength(detail) > 65_536) return null;
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const parsed = CommandApprovalSchema.safeParse(params);
      return parsed.success ? { kind: 'command', params: parsed.data } : null;
    }
    case 'item/fileChange/requestApproval': {
      const parsed = FileApprovalSchema.safeParse(params);
      return parsed.success ? { kind: 'file-change', params: parsed.data } : null;
    }
    case 'item/permissions/requestApproval': {
      const parsed = PermissionApprovalSchema.safeParse(params);
      return parsed.success ? { kind: 'permission', params: parsed.data } : null;
    }
    case 'item/tool/requestUserInput': {
      const parsed = QuestionApprovalSchema.safeParse(params);
      if (
        !parsed.success ||
        new Set(parsed.data.questions.map((question) => question.id)).size !==
          parsed.data.questions.length
      )
        return null;
      return { kind: 'question', params: parsed.data };
    }
    default:
      return null;
  }
};

/** Exposes the complete request scope without persisting prompt bodies or answers. */
export const toApprovalPresentation = (
  prompt: ICodexPrompt,
): Pick<
  INativeApproval,
  'kind' | 'title' | 'detail' | 'questions' | 'isBlocking' | 'decisions'
> => ({
  kind: prompt.kind,
  title:
    prompt.kind === 'question'
      ? 'Codex needs your input'
      : prompt.kind === 'command'
        ? prompt.params.kind === 'writeStdin'
          ? 'Codex requests terminal input'
          : 'Codex requests command approval'
        : prompt.kind === 'file-change'
          ? 'Codex requests file changes'
          : 'Codex requests additional permissions',
  detail: JSON.stringify(prompt.params, null, 2),
  decisions:
    prompt.kind === 'command'
      ? (['accept', 'acceptForSession', 'decline', 'cancel'] as const).filter(
          (decision) =>
            !prompt.params.availableDecisions ||
            prompt.params.availableDecisions.includes(decision),
        )
      : prompt.kind === 'file-change'
        ? ['accept', 'acceptForSession', 'decline', 'cancel']
        : [],
  isBlocking: prompt.kind === 'question' ? prompt.params.isBlocking : true,
  questions:
    prompt.kind === 'question'
      ? prompt.params.questions.map((question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          isSecret: question.isSecret,
          isOther: question.isOther,
          options: question.options ?? null,
        }))
      : [],
});

/**
 * Restricts replies to the exact displayed request, including native decision choices.
 * @throws
 * - -1: The HQ request is invalid
 */
export const buildCodexReply = (prompt: ICodexPrompt, response: IReply): unknown => {
  const invalid = (): never => {
    throw new Exception('The HQ request is invalid', undefined, { kind: 'invalid-request' });
  };
  if (prompt.kind === 'question') {
    if (response.kind !== 'answers') return invalid();
    const questions = prompt.params.questions;
    if (Object.keys(response.answers).length !== questions.length) return invalid();
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of questions) {
      const reply = response.answers[question.id];
      if (
        !reply ||
        reply.length !== 1 ||
        (!question.isOther &&
          question.options?.length &&
          !question.options.some((option) => option.label === reply[0]))
      )
        return invalid();
      Object.defineProperty(answers, question.id, { enumerable: true, value: { answers: reply } });
    }
    return { answers };
  }
  if (prompt.kind === 'permission') {
    if (response.kind !== 'permission') return invalid();
    return {
      permissions: response.decision === 'accept' ? prompt.params.permissions : {},
      scope: response.scope,
    };
  }
  if (response.kind !== 'decision') return invalid();
  if (
    prompt.kind === 'command' &&
    prompt.params.availableDecisions &&
    !prompt.params.availableDecisions.includes(response.decision)
  )
    return invalid();
  return { decision: response.decision };
};
