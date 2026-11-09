import {
  MAX_PAGE_SIZE,
  type IActiveSessions,
  type IHqResponse,
  type IProviderId,
  type IThreadSummary,
} from '../contracts/index.js';
import type { createProviderRegistry } from '../providers/registry/index.js';
import { resolveWorkspaceTarget } from '../runtime/state/index.js';
import type { IStore } from '../store/index.js';
import type { IActiveSessionRecord } from '../store/sessions/index.js';
import { getErrorKind, HQ_ERRORS } from '../errors/index.js';

import type { IClaudeSessions, IHistoryRequest } from './types.js';
import { imageUnavailable } from './utilities.js';
import { joinRecords, toManagedSummaries, withListing } from './summaries.js';
import { correlateEvidenceOrigins } from './evidence/index.js';

/**
 * Authorizes native history before loading content. A `thread` read whose history its provider
 * can't read answers from HQ's records of the session, with its history unavailable, and fails
 * as the provider did only when HQ records no such session in that workspace.
 * @returns One provider-paged read result, never a complete transcript scan.
 * @throws
 * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
 * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
 * - JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE: The Claude history is unavailable
 * - JG_AGENT_HQ_IMAGE_UNAVAILABLE: The HQ image is unavailable
 * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
 * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
 * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
 * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
 */
export const readNativeHistory = async (
  command: IHistoryRequest,
  registry: ReturnType<typeof createProviderRegistry>,
  projection: IStore,
  allowedRoots: string[],
  claude: IClaudeSessions,
  onInputAcknowledged: (threadId: string, nativeId: string) => void,
): Promise<IHqResponse> => {
  const workspaceRoot = await resolveWorkspaceTarget(command.workspaceRoot, allowedRoots);
  // a thread HQ created has no native history until its first turn, so its record answers
  if (
    command.kind === 'thread' ||
    command.kind === 'items' ||
    command.kind === 'item-detail' ||
    command.kind === 'item-image'
  ) {
    const unstarted = await projection.call(
      'reads',
      'getUnstartedThread',
      command.provider,
      command.nativeId,
    );
    if (unstarted?.workspaceRoot === workspaceRoot) {
      if (command.kind === 'items')
        return {
          kind: 'items',
          result: { data: [], history: 'persisted', source: 'native', nextCursor: null },
        };
      if (command.kind === 'item-detail') return { kind: 'item-detail', result: null };
      if (command.kind === 'item-image') return imageUnavailable();
      const [summary] = await toManagedSummaries(projection, [unstarted]);
      return { kind: 'thread', result: withListing(summary!, claude) };
    }
  }
  let response: IHqResponse;
  try {
    response = await (
      await registry.get(command.provider)
    ).readHistory({ ...command, workspaceRoot });
  } catch (error) {
    // a session whose history can't be read still has the summary HQ's records give it
    if (command.kind !== 'thread' || getErrorKind(error) !== 'agent-unavailable') throw error;
    const recorded = await readRecordedThread(
      command.provider,
      command.nativeId,
      workspaceRoot,
      projection,
      allowedRoots,
      claude,
    );
    if (!recorded) throw error;
    return { kind: 'thread', result: recorded };
  }
  if (response.kind === 'thread') {
    if (
      (await resolveWorkspaceTarget(response.result.workspaceRoot, allowedRoots)) !== workspaceRoot
    )
      throw HQ_ERRORS.create('targetForbidden', { data: { kind: 'access-denied' } });
    response.result.workspaceRoot = workspaceRoot;
    // one session's read counts its background commands from what its transcript holds now
    if (command.provider === 'claude')
      await claude.refreshBackgroundCommands(response.result.nativeId);
    await joinRecords(projection, claude, command.provider, [response.result]);
  }
  const items =
    response.kind === 'session-evidence' || response.kind === 'items'
      ? response.result.data
      : response.kind === 'item-detail' && response.result
        ? [response.result.item]
        : [];
  if (items.length && 'nativeId' in command)
    await correlateEvidenceOrigins(items, command.provider, command.nativeId, projection, {
      workspaceRoot,
      onAcknowledged: (threadId) => onInputAcknowledged(threadId, command.nativeId),
    });
  if (response.kind === 'session-evidence' && Buffer.byteLength(JSON.stringify(response)) > 65_280)
    throw HQ_ERRORS.create('providerFailed', { data: { kind: 'agent-unavailable' } });
  return response;
};

/**
 * Summarizes a session whose history can't be read from HQ's records: its managed thread, or else
 * the active session HQ observes, in the same workspace.
 * @returns The summary with its history unavailable, or null when HQ records no such session.
 * @throws
 * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
 */
const readRecordedThread = async (
  provider: IProviderId,
  nativeId: string,
  workspaceRoot: string,
  projection: IStore,
  allowedRoots: string[],
  claude: IClaudeSessions,
): Promise<IThreadSummary | null> => {
  const [managed] = await projection.call('reads', 'getNativeThreads', provider, [nativeId]);
  const [summary] = managed ? await toManagedSummaries(projection, [managed]) : [];
  const recorded =
    summary ??
    (await readActiveSessions(projection, allowedRoots, claude)).data.find(
      (session) => session.provider === provider && session.nativeId === nativeId,
    );
  return recorded?.workspaceRoot === workspaceRoot
    ? { ...withListing(recorded, claude), historyState: 'unavailable' }
    : null;
};

/**
 * Summarizes one active session, or returns null for one left out: outside the allowed workspaces,
 * or an observed Claude session the latest `claude agents --json` run didn't list.
 */
const toActiveSummary = async (
  record: IActiveSessionRecord,
  resolveRoot: (directory: string) => Promise<string | null>,
  claude: IClaudeSessions,
): Promise<IThreadSummary | null> => {
  const base = { provider: record.provider, nativeId: record.nativeId, state: record.state };
  if (record.thread) {
    const workspaceRoot = await resolveRoot(record.thread.workspaceRoot);
    if (workspaceRoot === null) return null;
    return {
      ...base,
      nativeLineage: record.thread.nativeLineage,
      workspaceRoot,
      name: record.thread.name,
      createdAt: record.thread.createdAt,
      updatedAt: record.thread.updatedAt,
      nativeState: 'unknown',
      ownership: record.thread.ownership,
      managedId: record.thread.id,
      historyState: 'available',
      terminal: null,
      backgroundCommands: 0,
      continuedIn: null,
    };
  }
  if (record.provider === 'claude') {
    const cwd = claude.workspaceOf(record.nativeId);
    const workspaceRoot = cwd === undefined ? null : await resolveRoot(cwd);
    if (workspaceRoot === null) return null;
    return {
      ...base,
      nativeLineage: { sessionId: record.nativeId, parentThreadId: null, forkedFromId: null },
      workspaceRoot,
      name: record.history?.name ?? null,
      createdAt: record.history?.createdAt ?? record.changedAt,
      updatedAt: record.history?.updatedAt ?? record.changedAt,
      nativeState: 'unknown',
      ownership: 'external',
      managedId: null,
      historyState: record.history?.isSupported === false ? 'unavailable' : 'available',
      terminal: null,
      backgroundCommands: 0,
      continuedIn: null,
    };
  }
  // an observed Codex session keeps its latest confirmed metadata
  if (!record.observed) return null;
  const workspaceRoot = await resolveRoot(record.observed.workspaceRoot);
  if (workspaceRoot === null) return null;
  return {
    ...base,
    nativeLineage: { sessionId: null, parentThreadId: null, forkedFromId: null },
    workspaceRoot,
    name: record.observed.name,
    createdAt: record.observed.createdAt,
    updatedAt: record.changedAt,
    nativeState: 'unknown',
    ownership: 'external',
    managedId: null,
    historyState: 'available',
    terminal: null,
    backgroundCommands: 0,
    continuedIn: null,
  };
};

/**
 * Reads every running and waiting session, managed and observed, and every idle one that runs
 * background commands, newest state change first, each as the summary `threads` returns, without
 * a native read. An observed Claude session's workspace is the `cwd` the latest
 * `claude agents --json` run reported, and an observed Codex session's comes from its record.
 * @returns At most 128 summaries and whether more sessions are active.
 * @throws
 * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
 */
export const readActiveSessions = async (
  projection: IStore,
  allowedRoots: string[],
  claude: IClaudeSessions,
): Promise<IActiveSessions> => {
  const records = await projection.call(
    'sessions',
    'active',
    MAX_PAGE_SIZE,
    claude.backgroundSessions(),
  );
  // each directory is authorized once per read
  const roots = new Map<string, Promise<string | null>>();
  const resolveRoot = (directory: string): Promise<string | null> => {
    let root = roots.get(directory);
    if (!root) {
      root = resolveWorkspaceTarget(directory, allowedRoots).catch(() => null);
      roots.set(directory, root);
    }
    return root;
  };
  const data: IThreadSummary[] = [];
  for (const record of records.data) {
    const summary = await toActiveSummary(record, resolveRoot, claude);
    if (summary) data.push(withListing(summary, claude));
  }
  return { data, isTruncated: records.isTruncated };
};
