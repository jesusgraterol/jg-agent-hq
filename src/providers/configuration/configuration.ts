import { Exception, extractMessage } from 'jg-exception';
import { hashValue } from 'jg-crypto';
import { z } from 'zod';

import type { IConfigurationChoice, IConfigurationRequest } from '../../contracts/index.js';
import { decodeHistoryCursor, encodeHistoryCursor } from '../../sessions/index.js';

const PositionSchema = z.object({ key: z.string(), revision: z.string() });

/**
 * Pages the bounded native agent/profile inventory using stable keys and a content revision.
 * @returns One query-bound page; changed native inventory invalidates continuation.
 * @throws
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 */
export const pageConfigurationChoices = (
  choices: IConfigurationChoice[],
  command: IConfigurationRequest,
) => {
  const entries = choices
    .map((choice) => ({ key: `${choice.kind}:${choice.id}`, choice }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const revision = hashValue(JSON.stringify(entries));
  const { cursor, ...filters } = command;
  const nativeCursor = decodeHistoryCursor(cursor, filters);
  let after = '';
  if (nativeCursor) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(nativeCursor);
    } catch (cause) {
      throw new Exception(`The HQ cursor does not match this request: ${extractMessage(cause)}`, {
        code: 'JG_AGENT_HQ_CURSOR_INVALID',
        data: { kind: 'invalid-request' },
        cause,
      });
    }
    const position = PositionSchema.safeParse(decoded);
    if (
      !position.success ||
      position.data.revision !== revision ||
      !entries.some((entry) => entry.key === position.data.key)
    )
      throw new Exception('The HQ cursor does not match this request', {
        code: 'JG_AGENT_HQ_CURSOR_INVALID',
        data: { kind: 'invalid-request' },
      });
    after = position.data.key;
  }
  const start = after ? entries.findIndex((entry) => entry.key === after) + 1 : 0;
  const selected = entries.slice(start, start + command.limit);
  return {
    choices: selected.map((entry) => entry.choice),
    nextCursor: encodeHistoryCursor(
      start + selected.length < entries.length
        ? JSON.stringify({ key: selected.at(-1)!.key, revision })
        : null,
      filters,
    ),
  };
};
