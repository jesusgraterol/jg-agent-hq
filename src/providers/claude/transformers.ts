import { Exception } from 'jg-exception';

import type { IUsageSnapshot } from '../../contracts/index.js';

import type { IClaudeUsage } from './types.js';

/**
 * Preserves independent native meters and leaves unreported quantities unknown.
 * @returns The complete replacement observation, never a sum across sessions.
 * @throws
 * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
 */
export const toClaudeUsageSnapshot = (result: IClaudeUsage, observedAt: number): IUsageSnapshot => {
  const seen = new Set<string>();
  const windows: IUsageSnapshot['windows'] = [];
  for (const row of result.rate_limits_available ? (result.rate_limits?.limits ?? []) : []) {
    if (row.percent === null) continue;
    const bucket = JSON.stringify([row.kind, row.group, row.scope]);
    if (seen.has(bucket))
      throw new Exception('The Claude integration failed', {
        code: 'JG_AGENT_HQ_CLAUDE_FAILED',
        data: {
          kind: 'agent-unavailable',
        },
      });
    seen.add(bucket);
    windows.push({
      id: bucket,
      bucket,
      label: row.scope?.model?.display_name ?? row.scope?.surface ?? row.group,
      window: row.group === 'session' ? 'primary' : 'secondary',
      usedPercent: row.percent,
      remainingPercent: Math.max(0, 100 - row.percent),
      durationMinutes: row.group === 'session' ? 300 : row.group === 'weekly' ? 10080 : null,
      resetsAt: row.resets_at === null ? null : Date.parse(row.resets_at),
      period:
        row.group === 'session' ? 'five-hour' : row.group === 'weekly' ? 'seven-day' : 'other',
      nativeKind: row.kind,
      group: row.group,
      scope: row.scope
        ? {
            model: row.scope.model
              ? { id: row.scope.model.id, displayName: row.scope.model.display_name }
              : null,
            surface: row.scope.surface,
          }
        : null,
    });
  }
  return {
    provider: 'claude',
    source: 'native',
    observedAt,
    ordinaryUsageAllowed: null,
    windows,
    credits: null,
    resetCredits: null,
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
