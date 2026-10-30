import { Exception } from 'jg-exception';

import {
  DEFAULT_PAGE_SIZE,
  HqResponseSchema,
  MAX_PAGE_SIZE,
  type IActiveSessions,
  type IHqResponse,
  type IHqRequest,
  type IManagedThread,
  type ISessionState,
  type IThreadSummary,
  type IUnstartedThreads,
} from '../contracts/index.js';
import { retainNativeLineage } from '../providers/index.js';
import type { createProviderRegistry } from '../providers/registry/index.js';
import { resolveWorkspaceTarget } from '../runtime/state/index.js';
import type { IStore } from '../store/index.js';
import type { IActiveSessionRecord } from '../store/sessions/index.js';

import type { IClaudeSessions, IHistoryRequest } from './types.js';
import { imageUnavailable } from './utilities.js';
import {
  evidencePosition,
  verifyEvidencePage,
  evidenceCursor,
  utf8Chunk,
  resetProvenance,
  EVIDENCE_SOURCE_PAGE_SIZE,
} from './evidence/index.js';

/**
 * Authorizes native history before loading content and records only its discovery projection.
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
  command: IHistoryRequest | Extract<IHqRequest, { kind: 'sessions' }>,
  registry: ReturnType<typeof createProviderRegistry>,
  projection: IStore,
  allowedRoots: string[],
  claude: IClaudeSessions,
): Promise<IHqResponse> => {
  const workspaceRoot = await resolveWorkspaceTarget(command.workspaceRoot, allowedRoots);
  if (command.kind === 'sessions') {
    const selected = { ...command, workspaceRoot };
    const position = evidencePosition(selected);
    const page = await readNativeHistory(
      {
        kind: 'threads',
        provider: command.provider,
        workspaceRoot,
        limit: EVIDENCE_SOURCE_PAGE_SIZE,
        search: command.search,
        cursor: position.sourceCursor,
      },
      registry,
      projection,
      allowedRoots,
      claude,
    );
    if (page.kind !== 'threads')
      throw new Exception('The HQ provider integration failed', {
        code: 'JG_AGENT_HQ_PROVIDER_FAILED',
        data: { kind: 'agent-unavailable' },
      });
    const digest = verifyEvidencePage(position, page.result.data);
    const result: Extract<IHqResponse, { kind: 'sessions' }> = {
      kind: 'sessions',
      result: { data: [], nextCursor: null, source: 'native' },
    };
    let index = position.index;
    for (
      ;
      index < page.result.data.length && result.result.data.length < command.limit;
      index += 1
    ) {
      const thread = page.result.data[index]!;
      const name = thread.name === null ? null : utf8Chunk(Buffer.from(thread.name), 0, 1024);
      const item = { ...thread, name, isNameTruncated: name !== thread.name };
      const candidate = {
        ...result.result,
        data: [...result.result.data, item],
        nextCursor: evidenceCursor(selected, { ...position, digest, index: index + 1, offset: 0 }),
      };
      if (Buffer.byteLength(JSON.stringify(candidate)) > 45_056) {
        if (result.result.data.length === 0)
          throw new Exception('The HQ provider integration failed', {
            code: 'JG_AGENT_HQ_PROVIDER_FAILED',
            data: { kind: 'agent-unavailable' },
          });
        break;
      }
      result.result.data.push(item);
    }
    result.result.nextCursor = evidenceCursor(
      selected,
      index < page.result.data.length
        ? { ...position, digest, index, offset: 0 }
        : page.result.nextCursor === null
          ? null
          : { sourceCursor: page.result.nextCursor, digest: null, index: 0, offset: 0 },
    );
    return HqResponseSchema.parse(result);
  }
  // a thread HQ created has no native history until its first turn, so its record answers
  if (
    command.kind === 'thread' ||
    command.kind === 'items' ||
    command.kind === 'item-detail' ||
    command.kind === 'item-image'
  ) {
    const unstarted = await projection.getUnstartedThread(command.provider, command.nativeId);
    if (unstarted?.workspaceRoot === workspaceRoot) {
      if (command.kind === 'items')
        return HqResponseSchema.parse({
          kind: 'items',
          result: { data: [], history: 'persisted', source: 'native', nextCursor: null },
        });
      if (command.kind === 'item-detail')
        return HqResponseSchema.parse({ kind: 'item-detail', result: null });
      if (command.kind === 'item-image') return imageUnavailable();
      const [summary] = await toManagedSummaries(projection, [unstarted]);
      return HqResponseSchema.parse({ kind: 'thread', result: withTerminal(summary!, claude) });
    }
  }
  const adapter = await registry.get(command.provider);
  const response = await adapter.readHistory({ ...command, workspaceRoot });
  const threads =
    response.kind === 'threads'
      ? response.result.data
      : response.kind === 'thread'
        ? [response.result]
        : [];
  const resolvedRoots = new Map<string, string>();
  for (const thread of threads) {
    let actualRoot = resolvedRoots.get(thread.workspaceRoot);
    if (!actualRoot) {
      actualRoot = await resolveWorkspaceTarget(thread.workspaceRoot, allowedRoots);
      resolvedRoots.set(thread.workspaceRoot, actualRoot);
    }
    if (actualRoot !== workspaceRoot)
      throw new Exception('The HQ target is outside the allowed workspaces', {
        code: 'JG_AGENT_HQ_TARGET_FORBIDDEN',
        data: { kind: 'access-denied' },
      });
    thread.workspaceRoot = actualRoot;
  }
  if (threads.length) {
    const managed = new Map(
      (
        await projection.getNativeThreads(
          command.provider,
          threads.map((thread) => thread.nativeId),
        )
      ).map((thread) => [thread.nativeId, thread]),
    );
    const states = new Map(
      (
        await projection.getSessionStates(
          command.provider,
          threads.map((thread) => thread.nativeId),
        )
      ).map((session) => [session.nativeId, session.state]),
    );
    for (const thread of threads) {
      const control = managed.get(thread.nativeId);
      if (control) {
        thread.ownership = control.ownership;
        thread.managedId = control.id;
        thread.name = control.name;
        thread.nativeLineage = retainNativeLineage(control.nativeLineage, thread.nativeLineage);
      }
      thread.state = states.get(thread.nativeId) ?? thread.state;
      thread.terminal = withTerminal(thread, claude).terminal;
    }
  }
  const items =
    response.kind === 'session-evidence' || response.kind === 'items'
      ? response.result.data
      : response.kind === 'item-detail' && response.result
        ? [response.result.item]
        : [];
  if (items.length && 'nativeId' in command) {
    /*
     * Provider assertions alone never establish an operator or an HQ action link. A user message
     * links to the action whose input it holds by its native input and the hash of the text that
     * input sent, so attachments and a cut text don't hide it.
     */
    for (const item of items) item.provenance = resetProvenance(item.kind, item.provenance);
    const origins = await projection.getEvidenceOrigins({
      provider: command.provider,
      nativeId: command.nativeId,
      items: items.map(({ kind, provenance, ...item }) => ({
        nativeInputId: kind === 'user-message' ? provenance.nativeInputId : null,
        turnId: 'reference' in item ? item.reference.turnId : item.turnId,
        sha256: provenance.nativeInputSha256,
      })),
    });
    for (const [index, origin] of origins.entries())
      if (origin && items[index]) items[index].provenance = origin;
  }
  if (response.kind === 'session-evidence' && Buffer.byteLength(JSON.stringify(response)) > 65_280)
    throw new Exception('The HQ provider integration failed', {
      code: 'JG_AGENT_HQ_PROVIDER_FAILED',
      data: { kind: 'agent-unavailable' },
    });
  return HqResponseSchema.parse(response);
};

// a summary with the terminal that runs it, which only Claude sessions report
const withTerminal = (summary: IThreadSummary, claude: IClaudeSessions): IThreadSummary => ({
  ...summary,
  terminal: summary.provider === 'claude' ? claude.terminalOf(summary.nativeId) : null,
});

/**
 * Summarizes managed threads as `threads` does, each in the state its record maps to.
 * @returns One summary per thread, in order.
 * @throws
 * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
 */
const toManagedSummaries = async (
  projection: IStore,
  threads: IManagedThread[],
): Promise<IThreadSummary[]> => {
  const states = new Map<string, ISessionState>();
  for (const provider of new Set(threads.map((thread) => thread.provider)))
    for (const session of await projection.getSessionStates(
      provider,
      threads.flatMap((thread) =>
        thread.provider === provider && thread.nativeId ? [thread.nativeId] : [],
      ),
    ))
      states.set(JSON.stringify([provider, session.nativeId]), session.state);
  return threads.map((thread) => ({
    provider: thread.provider,
    nativeId: thread.nativeId!,
    nativeLineage: thread.nativeLineage,
    workspaceRoot: thread.workspaceRoot,
    name: thread.name,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    nativeState: 'unknown',
    state: states.get(JSON.stringify([thread.provider, thread.nativeId])) ?? 'unknown',
    ownership: thread.ownership,
    managedId: thread.id,
    historyState: 'available',
    terminal: null,
  }));
};

/**
 * Reads one workspace's managed threads that no turn has started, newest first, so a session HQ
 * created shows before Claude or Codex has written any history.
 * @returns At most 32 summaries and whether more such threads exist.
 * @throws
 * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
 * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
 */
export const readUnstartedThreads = async (
  command: Extract<IHqRequest, { kind: 'unstarted-threads' }>,
  projection: IStore,
  allowedRoots: string[],
  claude: IClaudeSessions,
): Promise<IUnstartedThreads> => {
  const workspaceRoot = await resolveWorkspaceTarget(command.workspaceRoot, allowedRoots);
  const page = await projection.listUnstartedThreads(
    command.provider,
    workspaceRoot,
    DEFAULT_PAGE_SIZE,
  );
  return {
    data: (await toManagedSummaries(projection, page.data)).map((summary) =>
      withTerminal(summary, claude),
    ),
    isTruncated: page.isTruncated,
  };
};

/**
 * Summarizes one active session, or returns null for one left out: outside the allowed workspaces,
 * an observed Claude session the latest `claude agents --json` run didn't list, and an observed
 * session its provider can't read, as observation itself leaves such a session out.
 */
const toActiveSummary = async (
  record: IActiveSessionRecord,
  registry: ReturnType<typeof createProviderRegistry>,
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
    };
  }
  let thread: IThreadSummary;
  try {
    const adapter = await registry.get(record.provider);
    if (!adapter.readObservedThread) return null;
    thread = await adapter.readObservedThread(record.nativeId);
  } catch {
    return null;
  }
  const workspaceRoot = await resolveRoot(thread.workspaceRoot);
  if (workspaceRoot === null) return null;
  return { ...thread, ...base, workspaceRoot, ownership: 'external', managedId: null };
};

/**
 * Reads every running and waiting session, managed and observed, newest state change first, each
 * as the summary `threads` returns. An observed Claude session's workspace is the `cwd` the
 * latest `claude agents --json` run reported, and other observed sessions' come from their
 * provider's `readObservedThread`.
 * @returns At most 128 summaries and whether more sessions are active.
 * @throws
 * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
 */
export const readActiveSessions = async (
  registry: ReturnType<typeof createProviderRegistry>,
  projection: IStore,
  allowedRoots: string[],
  claude: IClaudeSessions,
): Promise<IActiveSessions> => {
  const records = await projection.listActiveSessions(MAX_PAGE_SIZE);
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
    const summary = await toActiveSummary(record, registry, resolveRoot, claude);
    if (summary) data.push(withTerminal(summary, claude));
  }
  return { data, isTruncated: records.isTruncated };
};
