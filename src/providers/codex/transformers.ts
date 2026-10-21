import { z } from 'zod';

import {
  UsageSnapshotSchema,
  ThreadSummarySchema,
  TurnSummarySchema,
  HistoryItemSchema,
  type IHistoryItem,
  type IThreadSummary,
  type ITurnSummary,
  type IUsageSnapshot,
} from '../../contracts/index.js';

import type { INativeItem, INativeThread, INativeTurn, INativeUsage } from './types.js';
import { parseNative } from './validations.js';

/**
 * Converts native seconds to the public millisecond-based metadata contract.
 * @throws
 * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
 */
export const toThreadSummary = (thread: INativeThread): IThreadSummary =>
  parseNative(ThreadSummarySchema, {
    provider: 'codex',
    nativeId: thread.id,
    workspaceRoot: thread.cwd,
    name: thread.name ?? null,
    createdAt: thread.createdAt * 1000,
    updatedAt: thread.updatedAt * 1000,
    nativeState: thread.status.type,
    ownership: 'external',
    managedId: null,
    historyState: 'available',
  });

/**
 * Returns turn metadata without hydrating its potentially growing item collection.
 * @throws
 * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
 */
export const toTurnSummary = (turn: INativeTurn): ITurnSummary =>
  parseNative(TurnSummarySchema, {
    nativeId: turn.id,
    state: turn.status,
    startedAt: turn.startedAt == null ? null : turn.startedAt * 1000,
    completedAt: turn.completedAt == null ? null : turn.completedAt * 1000,
  });

const TextPartsSchema = z.object({
  content: z
    .array(
      z.union([
        z.object({ type: z.literal('text'), text: z.string() }),
        z.object({ type: z.string().refine((type) => type !== 'text') }),
      ]),
    )
    .max(128),
});
const MessageSchema = z.object({ text: z.string() });
const CommandSchema = z.object({
  command: z.string(),
  aggregatedOutput: z.string().nullable().optional(),
});
const ChangesSchema = z.object({
  changes: z.array(z.object({ path: z.string(), diff: z.string() })).max(128),
});

/**
 * Produces explicit history presentation fields and marks truncated/unsupported content.
 * @throws
 * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
 */
export const toHistoryItem = ({ turnId, item }: INativeItem): IHistoryItem => {
  let kind: IHistoryItem['kind'] = 'unsupported';
  let text = '';
  switch (item.type) {
    case 'userMessage':
      kind = 'user-message';
      text = parseNative(TextPartsSchema, item)
        .content.map((part) => ('text' in part ? part.text : `[${part.type}]`))
        .join('\n');
      break;
    case 'agentMessage':
      kind = 'agent-message';
      text = parseNative(MessageSchema, item).text;
      break;
    case 'commandExecution': {
      kind = 'command';
      const command = parseNative(CommandSchema, item);
      text = `${command.command}\n${command.aggregatedOutput ?? ''}`;
      break;
    }
    case 'fileChange':
      kind = 'file-change';
      text = parseNative(ChangesSchema, item)
        .changes.map((change) => `${change.path}\n${change.diff}`)
        .join('\n');
      break;
  }
  let end = Math.min(text.length, 65_536);
  const last = text.charCodeAt(end - 1);
  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return parseNative(HistoryItemSchema, {
    nativeId: item.id,
    turnId,
    nativeType: item.type,
    kind,
    text: text.slice(0, end),
    isTruncated: end < text.length,
  });
};

/**
 * Preserves actual bucket/window identities and reset boundaries without inventing missing data.
 * @throws
 * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
 */
export const toUsageSnapshot = (usage: INativeUsage, observedAt: number): IUsageSnapshot => {
  const buckets = usage.rateLimitsByLimitId ?? {};
  const windows: IUsageSnapshot['windows'] = [];
  for (const [bucketId, bucket] of Object.entries(buckets))
    for (const window of ['primary', 'secondary'] as const) {
      const entry = bucket[window];
      if (entry)
        windows.push({
          id: `${bucketId}:${window}`,
          bucket: bucketId,
          label: bucket.limitName ?? null,
          window,
          usedPercent: entry.usedPercent,
          remainingPercent: Math.max(0, 100 - entry.usedPercent),
          durationMinutes: entry.windowDurationMins ?? null,
          resetsAt: entry.resetsAt == null ? null : entry.resetsAt * 1000,
        });
    }
  const reached = Object.values(buckets).some((bucket) => bucket.rateLimitReachedType != null);
  const state =
    windows.length === 0
      ? 'unavailable'
      : usage.ordinaryUsageAllowed === false || reached
        ? 'exhausted'
        : 'available';
  return parseNative(UsageSnapshotSchema, {
    provider: 'codex',
    state,
    source: 'native',
    observedAt,
    ordinaryUsageAllowed: usage.ordinaryUsageAllowed ?? null,
    windows,
  });
};
