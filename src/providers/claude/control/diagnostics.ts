import { hashValue } from 'jg-crypto';
import { z } from 'zod';

import type { IClaudeSession } from './types.js';

// keep result diagnostics independent of structural validation so malformed results are visible too
const MAX_DIAGNOSTIC_IDS = 64;
const ResultDiagnosticSchema = z.object({
  user_message_uuid: z.unknown().optional(),
  subtype: z.unknown().optional(),
  is_error: z.unknown().optional(),
  num_turns: z.unknown().optional(),
  duration_api_ms: z.unknown().optional(),
  usage: z.unknown().optional(),
});
const KnownSubtypeSchema = z.enum([
  'success',
  'error_during_execution',
  'error_max_turns',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
]);
const TurnCountSchema = z.int().nonnegative();
const uuidOrNull = (candidate: unknown): string | null => {
  const parsed = z.uuid().safeParse(candidate);
  return parsed.success ? parsed.data : null;
};
const collectIds = (identities: Iterable<string>): string[] => {
  const selected: string[] = [];
  let inspected = 0;
  for (const identity of identities) {
    inspected += 1;
    const uuid = uuidOrNull(identity);
    if (uuid !== null) selected.push(uuid);
    if (inspected === MAX_DIAGNOSTIC_IDS) break;
  }
  return selected;
};

/**
 * Projects safe result metadata. Short unfamiliar subtypes get a stable fingerprint so repeated
 * observations can be matched without copying arbitrary provider strings into logs.
 */
const describeResult = (session: IClaudeSession, result: unknown) => {
  const { data: metadata } = ResultDiagnosticSchema.safeParse(result);
  const subtype = metadata?.subtype;
  const knownSubtype = KnownSubtypeSchema.safeParse(subtype);
  return {
    sessionId: uuidOrNull(session.id),
    userMessageUuid: uuidOrNull(metadata?.user_message_uuid),
    hasUserMessageUuid: metadata?.user_message_uuid !== undefined,
    inputId: uuidOrNull(session.input?.id),
    nativeTurnId: uuidOrNull(session.nativeTurn?.id),
    pendingSteerCount: session.steers.size,
    pendingSteerIds: collectIds(session.steers.keys()),
    replayedSteerIds: collectIds(session.replayedSteers ?? []),
    subtype: knownSubtype.success ? knownSubtype.data : null,
    subtypeFingerprint:
      !knownSubtype.success && typeof subtype === 'string' && subtype.length <= 64
        ? hashValue(subtype, 'sha256')
        : null,
    isError: typeof metadata?.is_error === 'boolean' ? metadata.is_error : null,
    numTurns: TurnCountSchema.safeParse(metadata?.num_turns).data ?? null,
    hasDurationApiMs: metadata?.duration_api_ms !== undefined,
    hasUsage: metadata?.usage !== undefined,
  };
};

/** Reports one rejected result without exposing prompts, output, paths or parser payloads. */
export const reportRejectedClaudeResult = (
  session: IClaudeSession,
  result: unknown,
  reason: 'invalid-result' | 'missing-input-uuid' | 'input-mismatch',
): void => {
  console.error(
    '[jg-agent-hq] Claude result rejected',
    JSON.stringify({ reason, ...describeResult(session, result) }),
  );
};

/** Reports an autonomous cycle that finished without opening a live turn. */
export const reportEmptyClaudeCycle = (session: IClaudeSession, result: unknown): void => {
  console.warn(
    '[jg-agent-hq] Claude empty cycle completed',
    JSON.stringify(describeResult(session, result)),
  );
};
