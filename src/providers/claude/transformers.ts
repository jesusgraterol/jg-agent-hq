import { Exception } from 'error-message-utils';

import type { IUsageSnapshot } from '../../contracts/index.js';

import type { IClaudeUsage } from './types.js';

/**
 * Preserves independent native meters and leaves unreported quantities unknown.
 * @returns The complete replacement observation, never a sum across sessions.
 * @throws
 * - -1: The Claude integration failed
 */
export const toClaudeUsageSnapshot = (result: IClaudeUsage, observedAt: number): IUsageSnapshot => {
  const seen = new Set<string>();
  const windows: IUsageSnapshot['windows'] = [];
  for (const row of result.rate_limits_available ? (result.rate_limits?.limits ?? []) : []) {
    if (row.percent === null) continue;
    const bucket = JSON.stringify([row.kind, row.group, row.scope]);
    if (seen.has(bucket))
      throw new Exception('The Claude integration failed', undefined, {
        kind: 'agent-unavailable',
      });
    seen.add(bucket);
    windows.push({
      id: bucket,
      bucket,
      label: row.scope?.model?.display_name ?? row.scope?.surface ?? row.group,
      window: row.group === 'session' ? 'primary' : 'secondary',
      usedPercent: row.percent,
      remainingPercent: Math.max(0, 100 - row.percent),
      durationMinutes: null,
      resetsAt: row.resets_at === null ? null : Date.parse(row.resets_at),
    });
  }
  return {
    provider: 'claude',
    source: 'native',
    observedAt,
    ordinaryUsageAllowed: null,
    windows,
    state:
      !result.rate_limits_available || windows.length === 0
        ? 'unavailable'
        : result.rate_limits?.limits.some(
              (row) => row.is_active && row.percent !== null && row.percent >= 100,
            )
          ? 'exhausted'
          : 'available',
  };
};
