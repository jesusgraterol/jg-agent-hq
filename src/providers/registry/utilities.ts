import { Exception, extractMessage, isException } from 'jg-exception';

/**
 * Keeps the adapters' own exception contracts and classifies any other failure.
 * @returns The adapter's exception, or a provider failure whose public message remains static.
 */
export const normalizeProviderError = (cause: unknown): Exception =>
  isException(cause)
    ? cause
    : new Exception(`The HQ provider integration failed: ${extractMessage(cause)}`, {
        code: 'JG_AGENT_HQ_PROVIDER_FAILED',
        data: { kind: 'agent-unavailable' },
        cause,
      });

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
