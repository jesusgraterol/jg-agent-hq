// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';

import { getOwnerLiveness } from 'jg-agent-hq';

afterEach(() => vi.restoreAllMocks());

test('permission-denied liveness is unknown rather than dead', () => {
  vi.spyOn(process, 'kill').mockImplementationOnce(() => {
    throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
  });
  expect(getOwnerLiveness(1)).toBe('unknown');
});

test('a missing process is dead', () => {
  vi.spyOn(process, 'kill').mockImplementationOnce(() => {
    throw Object.assign(new Error('missing'), { code: 'ESRCH' });
  });
  expect(getOwnerLiveness(1)).toBe('dead');
});
