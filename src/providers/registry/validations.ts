import { Exception } from 'jg-exception';
import { z } from 'zod';

import { HqResponseSchema, type IHqResponse, type IProviderId } from '../../contracts/index.js';
import type { IHistoryRequest } from '../../sessions/index.js';
import {
  NativeObservationSchema,
  NativeOutcomeSchema,
  type INativeObservation,
  type INativeOutcome,
} from '../../store/control/index.js';

import { normalizeProviderError } from './utilities.js';

// independently deployed adapters may add harmless fields; the worker still receives closed commands
const ObservationSchema = z.discriminatedUnion('kind', [
  NativeObservationSchema.options[0].strip(),
  ...NativeObservationSchema.options.slice(1).map((schema) => schema.strip()),
]);
const OutcomeSchema = z.discriminatedUnion('kind', [
  NativeOutcomeSchema.options[0].strip(),
  ...NativeOutcomeSchema.options.slice(1).map((schema) => schema.strip()),
]);

// each acknowledgement proves only its concrete native request phase
const OUTCOME_PHASES = {
  created: 'create',
  resumed: 'resume',
  closed: 'close',
  cleaned: 'clean',
  renamed: 'name',
  'turn-accepted': 'turn',
  'steer-accepted': 'steer',
  'interrupt-accepted': 'interrupt',
  'reply-written': 'reply',
} satisfies Record<Exclude<INativeOutcome['kind'], 'failed' | 'uncertain'>, string>;

/**
 * Validates consumed lifecycle evidence while tolerating additive adapter metadata.
 * @returns The known observation fields.
 * @throws
 * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
 */
export const parseProviderObservation = (input: unknown): INativeObservation => {
  const parsed = ObservationSchema.safeParse(input);
  if (!parsed.success) throw normalizeProviderError(parsed.error, false);
  return parsed.data;
};

/**
 * Derives action identity from the runtime-issued request, never an adapter-selected action ID.
 * @returns A validated closed outcome for the action ledger.
 * @throws
 * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
 */
export const parseProviderOutcome = (input: unknown): INativeOutcome => {
  const record = z.record(z.string(), z.unknown()).safeParse(input);
  const identity = z.object({ requestId: z.string() }).safeParse(input);
  if (!record.success) throw normalizeProviderError(record.error, false);
  if (!identity.success) throw normalizeProviderError(identity.error, false);
  const parsed = OutcomeSchema.safeParse({
    ...record.data,
    actionId: identity.data.requestId.slice(0, 36),
  });
  if (!parsed.success) throw normalizeProviderError(parsed.error, false);
  if (
    parsed.data.kind !== 'failed' &&
    parsed.data.kind !== 'uncertain' &&
    !parsed.data.requestId.endsWith(`:${OUTCOME_PHASES[parsed.data.kind]}`)
  )
    rejectProviderResponse();
  return parsed.data;
};

/**
 * Rejects evidence that cannot establish the selected provider operation's result.
 * @throws
 * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
 */
export const rejectProviderResponse: () => never = () => {
  throw new Exception('The HQ provider integration failed', {
    code: 'JG_AGENT_HQ_PROVIDER_FAILED',
    data: { kind: 'agent-unavailable' },
  });
};

/**
 * Enforces the selected operation, provider, identity and page budget on adapter history output.
 * @returns The validated response, retaining additive producer fields only through its schema.
 * @throws
 * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
 */
export const validateProviderHistory = (
  input: unknown,
  command: IHistoryRequest,
  provider: IProviderId,
): IHqResponse => {
  const parsed = HqResponseSchema.safeParse(input);
  if (!parsed.success) throw normalizeProviderError(parsed.error, false);
  const response = parsed.data;
  if (response.kind !== command.kind) rejectProviderResponse();
  if (response.kind === 'threads') {
    if (command.kind !== 'threads' || response.result.data.length > command.limit)
      rejectProviderResponse();
    if (response.result.data.some((thread) => thread.provider !== provider))
      rejectProviderResponse();
  } else if (response.kind === 'thread') {
    if (
      command.kind !== 'thread' ||
      response.result.provider !== provider ||
      response.result.nativeId !== command.nativeId
    )
      rejectProviderResponse();
  } else if (response.kind === 'turns' || response.kind === 'items') {
    if (!('limit' in command) || response.result.data.length > command.limit)
      rejectProviderResponse();
  } else rejectProviderResponse();
  return response;
};
