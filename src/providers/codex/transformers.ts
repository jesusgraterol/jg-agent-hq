import { z } from 'zod';

import {
  UsageSnapshotSchema,
  UsageCreditsSchema,
  ThreadSummarySchema,
  TurnSummarySchema,
  HistoryItemSchema,
  MAX_ITEM_TEXT_LENGTH,
  type IHistoryFile,
  type IHistoryItem,
  type IThreadSummary,
  type ITurnSummary,
  type IUsageSnapshot,
  type INativeLineage,
  type ISessionState,
} from '../../contracts/index.js';

import { countLines } from '../../sessions/index.js';
import { nativeProvenance } from '../../sessions/evidence/index.js';

import type { INativeItem, INativeThread, INativeTurn, INativeUsage } from './types.js';
import { parseNative } from './validations.js';

/** Preserves exact native tree identities independently of managed-agent relationships. */
export const toNativeLineage = (thread: INativeThread): INativeLineage => ({
  sessionId: thread.sessionId ?? null,
  parentThreadId: thread.parentThreadId ?? null,
  forkedFromId: thread.forkedFromId ?? null,
});

/** Maps a native thread status to the shared session state; an active thread can wait on the operator. */
export const toSessionState = (status: INativeThread['status']): ISessionState =>
  status.type === 'active'
    ? status.activeFlags?.some(
        (flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput',
      )
      ? 'waiting'
      : 'running'
    : status.type === 'idle'
      ? 'idle'
      : status.type === 'notLoaded'
        ? 'closed'
        : 'failed';

/**
 * Converts native seconds to the public millisecond-based metadata contract.
 * @throws
 * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
 */
export const toThreadSummary = (thread: INativeThread): IThreadSummary =>
  parseNative(ThreadSummarySchema, {
    provider: 'codex',
    nativeId: thread.id,
    nativeLineage: toNativeLineage(thread),
    workspaceRoot: thread.cwd,
    name: thread.name ?? null,
    createdAt: thread.createdAt * 1000,
    updatedAt: thread.updatedAt * 1000,
    nativeState: thread.status.type,
    state: toSessionState(thread.status),
    ownership: 'external',
    managedId: null,
    historyState: 'available',
    terminal: null,
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
const StatusSchema = z.object({ status: z.string() });
const CommandSchema = z.object({
  command: z.string(),
  aggregatedOutput: z.string().nullable().optional(),
});
const ChangesSchema = z.object({
  changes: z
    .array(
      z.object({
        path: z.string().min(1).max(4096),
        kind: z.object({ type: z.string() }),
        diff: z.string(),
      }),
    )
    .max(128),
});
const ToolSchema = z.object({
  tool: z.string(),
  server: z.string().optional(),
  status: z.string(),
  arguments: z.unknown(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  contentItems: z.unknown().optional(),
});

/** Counts one change's lines; an added or deleted file without hunks is its whole content. */
const toHistoryFile = (change: z.infer<typeof ChangesSchema>['changes'][number]): IHistoryFile => {
  const lines = change.diff.split('\n');
  const hunk = lines.findIndex((line) => line.startsWith('@@'));
  if (hunk === -1)
    return {
      path: change.path,
      added: change.kind.type === 'add' ? countLines(change.diff) : 0,
      removed: change.kind.type === 'delete' ? countLines(change.diff) : 0,
    };
  const body = lines.slice(hunk);
  return {
    path: change.path,
    added: body.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
    removed: body.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
  };
};

/**
 * Presents one native item as the CLI shows it, shared by history pages, live items and evidence.
 * Outcome and files come from the full item, before the text is cut. Times come from the item's
 * turn, which Codex times across all of its history: an operator message takes its turn's start
 * and every other item its turn's end, or its start while the turn runs; an item whose turn isn't
 * known has no time.
 * @returns The item, or null for reasoning, which the CLI leaves out of history.
 * @throws
 * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
 */
export const toHistoryItem = (
  { turnId, item }: INativeItem,
  turn: Pick<ITurnSummary, 'startedAt' | 'completedAt'> | undefined,
  fullBody = false,
): IHistoryItem | null => {
  let kind: IHistoryItem['kind'] = 'unsupported';
  let text = '';
  let files: IHistoryFile[] = [];
  let outcome: IHistoryItem['outcome'] = null;
  switch (item.type) {
    case 'reasoning':
      return null;
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
    case 'contextCompaction':
      // Codex records no summary of what it compacted
      kind = 'notice';
      break;
    case 'commandExecution': {
      kind = 'command';
      const command = parseNative(CommandSchema, item);
      text = `${command.command}\n${command.aggregatedOutput ?? ''}`;
      break;
    }
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      kind = 'tool';
      const tool = parseNative(ToolSchema, item);
      text = `${tool.server ? tool.server + '/' : ''}${tool.tool} (${tool.status})\n${JSON.stringify(tool.arguments)}\n${JSON.stringify(tool.result ?? tool.contentItems ?? tool.error ?? null)}`;
      break;
    }
    case 'webSearch':
      kind = 'tool';
      text = parseNative(z.object({ query: z.string() }), item).query;
      break;
    case 'imageView':
      kind = 'tool';
      text = parseNative(z.object({ path: z.string() }), item).path;
      break;
    case 'fileChange': {
      kind = 'file-change';
      const { changes } = parseNative(ChangesSchema, item);
      text = changes.map((change) => `${change.path}\n${change.diff}`).join('\n');
      files = changes.map(toHistoryFile);
      break;
    }
  }
  if (
    item.type === 'commandExecution' ||
    item.type === 'fileChange' ||
    item.type === 'mcpToolCall' ||
    item.type === 'dynamicToolCall'
  ) {
    const { status } = parseNative(StatusSchema, item);
    outcome =
      status === 'completed'
        ? 'succeeded'
        : status === 'failed' || status === 'declined'
          ? 'failed'
          : null;
  }
  let end = fullBody ? text.length : Math.min(text.length, MAX_ITEM_TEXT_LENGTH);
  const last = text.charCodeAt(end - 1);
  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return parseNative(HistoryItemSchema, {
    nativeId: item.id,
    turnId,
    nativeType: item.type,
    kind,
    provenance: nativeProvenance(
      kind,
      kind === 'user-message' && typeof item.clientId === 'string' ? item.clientId : null,
    ),
    text: text.slice(0, end),
    isTruncated: end < text.length,
    // a Codex item holds its call and its result together
    callId: null,
    outcome,
    files,
    createdAt:
      turn === undefined
        ? null
        : item.type === 'userMessage'
          ? turn.startedAt
          : (turn.completedAt ?? turn.startedAt),
  });
};

/**
 * Preserves actual bucket/window identities and reset boundaries without inventing missing data.
 * @throws
 * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
 */
export const toUsageSnapshot = (usage: INativeUsage, observedAt: number): IUsageSnapshot => {
  const nativeBuckets = usage.rateLimitsByLimitId;
  const buckets =
    nativeBuckets && Object.keys(nativeBuckets).length > 0
      ? nativeBuckets
      : usage.rateLimits
        ? { [usage.rateLimits.limitId ?? 'single']: usage.rateLimits }
        : {};
  const windows: IUsageSnapshot['windows'] = [];
  const credits: NonNullable<IUsageSnapshot['credits']> = [];
  for (const [bucketId, bucket] of Object.entries(buckets)) {
    if (bucket.credits) {
      const observed = UsageCreditsSchema.safeParse({
        bucket: bucketId,
        hasCredits: bucket.credits.hasCredits,
        isUnlimited: bucket.credits.unlimited,
        balance: bucket.credits.balance,
      });
      if (observed.success) credits.push(observed.data);
    }
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
          period:
            entry.windowDurationMins === 300
              ? 'five-hour'
              : entry.windowDurationMins === 10080
                ? 'seven-day'
                : 'other',
          nativeKind: null,
          group: null,
          scope: null,
        });
    }
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
    credits: credits.length > 0 ? credits : null,
    resetCredits: usage.rateLimitResetCredits ?? null,
  });
};
