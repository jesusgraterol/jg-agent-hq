import { Exception } from 'jg-exception';
import { z } from 'zod';

import type {
  IActionCommand,
  IApprovalPresentation,
  INativeElicitation,
} from '../../contracts/index.js';

/** Presents the complete native form or URL without opening links or fetching schemas. */
export const presentElicitation = (elicitation: INativeElicitation): IApprovalPresentation => ({
  kind: 'elicitation',
  title: `${elicitation.serverName} needs your input`,
  detail: elicitation.message,
  isBlocking: true,
  decisions: [],
  questions: [],
  elicitation,
});

/**
 * Validates an explicit response against this exact native form or URL request.
 * @returns The response content without inventing answers or extending permission scope.
 * @throws
 * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
 */
export const validateElicitation = (
  elicitation: INativeElicitation,
  reply: Extract<IActionCommand, { kind: 'native-reply' }>['response'],
) => {
  const invalid = (): never => {
    throw new Exception('The HQ request is invalid', {
      code: 'JG_AGENT_HQ_REQUEST_INVALID',
      data: { kind: 'invalid-request' },
    });
  };
  if (reply.kind !== 'elicitation') return invalid();
  if (reply.action !== 'accept' || elicitation.mode === 'url') {
    if (reply.content !== null) return invalid();
  } else {
    if (!elicitation.requestedSchema || reply.content === null) return invalid();
    if (!z.fromJSONSchema(elicitation.requestedSchema).safeParse(reply.content).success)
      return invalid();
  }
  return { action: reply.action, content: reply.content };
};
