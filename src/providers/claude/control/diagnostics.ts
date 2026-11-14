import { z } from 'zod';

import type { IClaudeSession } from './types.js';

// failure output is bounded and contains only validated identities, never native bodies
const MAX_DIAGNOSTIC_IDS = 64;
const ResultIdentitySchema = z.object({ user_message_uuid: z.uuid().optional() });
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

/** Reports one rejected result without exposing prompts, output, paths or parser payloads. */
export const reportRejectedClaudeResult = (
  session: IClaudeSession,
  result: unknown,
  reason: 'invalid-result' | 'no-active-turn' | 'input-mismatch',
): void => {
  const identity = ResultIdentitySchema.safeParse(result);
  console.error(
    '[jg-agent-hq] Claude result rejected',
    JSON.stringify({
      reason,
      sessionId: uuidOrNull(session.id),
      userMessageUuid: identity.success ? (identity.data.user_message_uuid ?? null) : null,
      inputId: uuidOrNull(session.input?.id),
      nativeTurnId: uuidOrNull(session.nativeTurn?.id),
      pendingSteerCount: session.steers.size,
      pendingSteerIds: collectIds(session.steers.keys()),
      replayedSteerIds: collectIds(session.replayedSteers ?? []),
    }),
  );
};
