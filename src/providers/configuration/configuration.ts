import { hashValue } from 'jg-crypto';
import { z } from 'zod';

import type { IConfigurationChoice, IConfigurationRequest } from '../../contracts/index.js';
import { createRequestCursors } from '../../sessions/index.js';
import { HQ_ERRORS } from '../../errors/index.js';

// a choice page continues after its final key, in the inventory revision it was read from
const positions = createRequestCursors(z.strictObject({ key: z.string(), revision: z.string() }));

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
  const position = positions.decode(cursor, filters);
  if (
    position &&
    (position.revision !== revision || !entries.some((entry) => entry.key === position.key))
  )
    throw HQ_ERRORS.create('cursorInvalid', { data: { kind: 'invalid-request' } });
  const after = position?.key ?? '';
  const start = after ? entries.findIndex((entry) => entry.key === after) + 1 : 0;
  const selected = entries.slice(start, start + command.limit);
  return {
    choices: selected.map((entry) => entry.choice),
    nextCursor: positions.encode(
      start + selected.length < entries.length ? { key: selected.at(-1)!.key, revision } : null,
      filters,
    ),
  };
};
