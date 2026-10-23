import { Exception, extractMessage, isException } from 'jg-exception';
import { z } from 'zod';

const NativeRejectionSchema = z.union([
  z.object({ nativeRejection: z.literal(true) }),
  z.object({ nativeCode: z.number() }),
]);
const CleanupSchema = z.object({ cleanupUnconfirmed: z.literal(true) });

/**
 * Preserves built-in contracts and normalizes adapter failures without losing explicit rejection.
 * @returns A classified integration error whose public transport message remains static.
 */
export const normalizeProviderError = (cause: unknown, isBuiltIn: boolean): Exception => {
  if (
    isException(cause) &&
    (isBuiltIn ||
      [
        'JG_AGENT_HQ_CAPABILITY_UNAVAILABLE',
        'JG_AGENT_HQ_PROVIDER_FAILED',
        'JG_AGENT_HQ_REQUEST_INVALID',
        'JG_AGENT_HQ_ACTION_CONFLICT',
        'JG_AGENT_HQ_TARGET_FORBIDDEN',
      ].includes(cause.code))
  )
    return cause;
  const isRejected = isException(cause) && NativeRejectionSchema.safeParse(cause.data).success;
  const hasUnconfirmedCleanup = isException(cause) && CleanupSchema.safeParse(cause.data).success;
  return new Exception(`The HQ provider integration failed: ${extractMessage(cause)}`, {
    code: 'JG_AGENT_HQ_PROVIDER_FAILED',
    data: {
      kind: 'agent-unavailable',
      ...(isRejected ? { nativeRejection: true } : {}),
      ...(hasUnconfirmedCleanup ? { cleanupUnconfirmed: true } : {}),
    },
    cause,
  });
};

/**
 * Reports an unsupported or unavailable concrete operation without starting native work.
 * @throws
 * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
 */
export const capabilityUnavailable: () => never = () => {
  throw new Exception('The HQ capability is unavailable', {
    code: 'JG_AGENT_HQ_CAPABILITY_UNAVAILABLE',
    data: { kind: 'agent-unavailable' },
  });
};
