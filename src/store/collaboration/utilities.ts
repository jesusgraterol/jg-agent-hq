import { Exception } from 'jg-exception';
import { measureJsonBytes, takeWithinByteBudget } from 'jg-utilities';

import {
  CollaborationResultSchema,
  COLLABORATION_LIMITS,
  type ICollaborationActor,
  type ICollaborationCommand,
  type ICollaborationResponse,
  type ICollaborationResult,
} from '../../contracts/collaboration/index.js';
import { COLLABORATION_RESPONSE_HEADROOM } from '../../collaboration/index.js';
import { decodeHistoryCursor, encodeHistoryCursor } from '../../sessions/index.js';

import {
  CollaborationPositionSchema,
  type ICollaborationPageEntry,
  type ICollaborationPosition,
} from './types.js';

/**
 * Rejects metadata that cannot be represented within the public byte contract.
 * @throws
 * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
 */
export const assertCollaborationBudget = (response: ICollaborationResponse): void => {
  if (
    measureJsonBytes(response, COLLABORATION_LIMITS.responseBytes) >
    COLLABORATION_LIMITS.responseBytes - COLLABORATION_RESPONSE_HEADROOM
  )
    throw new Exception('The HQ request is invalid', {
      code: 'JG_AGENT_HQ_REQUEST_INVALID',
      data: { kind: 'invalid-request' },
    });
};

const cursorScope = (actor: ICollaborationActor, command: ICollaborationCommand) => {
  const { cursor: _cursor, ...scope } =
    'cursor' in command ? command : { ...command, cursor: undefined };
  return { actor, command: scope };
};

/**
 * Validates immutable sequence bounds and exact actor/query binding before querying a page.
 * @throws
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 */
export const readCollaborationPosition = (
  actor: ICollaborationActor,
  command: ICollaborationCommand,
): ICollaborationPosition | undefined => {
  const encoded = decodeHistoryCursor(
    'cursor' in command ? command.cursor : undefined,
    cursorScope(actor, command),
  );
  if (!encoded) return undefined;
  try {
    return CollaborationPositionSchema.parse(JSON.parse(encoded));
  } catch (cause) {
    throw new Exception('The HQ cursor does not match this request', {
      code: 'JG_AGENT_HQ_CURSOR_INVALID',
      data: { kind: 'invalid-request' },
      cause,
    });
  }
};

/** Encodes the same stable sequence scope used for the initial page. */
export const collaborationCursor = (
  actor: ICollaborationActor,
  command: ICollaborationCommand,
  position: ICollaborationPosition | null,
): string | null =>
  encodeHistoryCursor(
    position === null ? null : JSON.stringify(position),
    cursorScope(actor, command),
  );

/**
 * Fits a prefix of already bounded SQL rows and continues after the last returned sequence.
 * @returns A validated page; no skipped rows are hidden behind a client-side slice.
 * @throws
 * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
 */
export const collaborationPage = (
  kind: 'tasks' | 'agents' | 'grants' | 'streams' | 'messages' | 'requests' | 'deliveries',
  actor: ICollaborationActor,
  command: ICollaborationCommand,
  entries: ICollaborationPageEntry[],
  boundary: number,
  hasMore: boolean,
): ICollaborationResult => {
  const budget = COLLABORATION_LIMITS.responseBytes - COLLABORATION_RESPONSE_HEADROOM;
  const selected = takeWithinByteBudget(
    entries.map((entry) => entry.item),
    {
      maxBytes: budget,
      measurePage: (page, itemsBytes) => {
        const last = entries[page.length - 1];
        const nextCursor = last
          ? collaborationCursor(actor, command, { boundary, sequence: last.sequence })
          : null;
        return itemsBytes + measureJsonBytes({ kind, data: [], nextCursor }, budget) - 2;
      },
    },
  );
  if (entries.length > 0 && selected.length === 0)
    throw new Exception('The HQ request is invalid', {
      code: 'JG_AGENT_HQ_REQUEST_INVALID',
      data: { kind: 'invalid-request' },
    });
  const last = entries[selected.length - 1];
  return CollaborationResultSchema.parse({
    kind,
    data: selected,
    nextCursor:
      last && (hasMore || selected.length < entries.length)
        ? collaborationCursor(actor, command, { boundary, sequence: last.sequence })
        : null,
  });
};
