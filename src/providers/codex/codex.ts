import { Exception } from 'jg-exception';
import { runInOrder } from 'jg-utilities';
import { z } from 'zod';

import {
  MAX_PAGE_SIZE,
  type IUsageSnapshot,
  type ISessionSettings,
  type IOutputSchema,
} from '../../contracts/index.js';
import { NativeIdSchema } from '../../contracts/identities/index.js';
import { decodeBase64Image, imageUnavailable, readImageFile } from '../../sessions/index.js';

import {
  LOADED_THREADS_PAGE_SIZE,
  MAX_TURN_TIME_PAGES,
  SKILL_HINT_READ_CONCURRENCY,
  TURN_TIMES_PAGE_SIZE,
} from './constants.js';
import { createCodexRpc } from './rpc.js';
import {
  NativeBucketSchema,
  NativeSkillsSchema,
  NativeItemPageSchema,
  NativeThreadPageSchema,
  NativeThreadSchema,
  NativeTurnPageSchema,
  NativeUsageSchema,
  NativeTurnSchema,
  type ICodexEvents,
  type ICodexProvider,
  type INativeItem,
  type INativePage,
  type ITurnSummary,
} from './types.js';
import {
  toHistoryItem,
  toImageSources,
  toItemDetail,
  toThreadSummary,
  toTurnSummary,
  toUsageSnapshot,
} from './transformers.js';
import { parseNative } from './validations.js';
import { toCodexModels } from './models/index.js';
import {
  HOST_SKILL_SCOPE,
  readSkillHint,
  readSkillRoots,
  toCapabilityRoots,
} from './skill-roots/index.js';
import {
  toCodexConfiguration,
  toCodexServiceTier,
  toCodexSessionSettings,
  readCodexConfigurationObservation,
} from './configuration/index.js';

/**
 * Connects native history, usage observations and explicitly admitted runtime controls.
 * @returns The owned adapter. Its caller must close it on shutdown.
 * @throws
 * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
 * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
 */
export const createCodexProvider = async (
  extraSkillRoots: string[] = [],
  daemonLauncher: string[] = [],
): Promise<ICodexProvider> => {
  let latest: IUsageSnapshot = {
    provider: 'codex',
    state: 'unavailable',
    source: 'native',
    observedAt: null,
    ordinaryUsageAllowed: null,
    windows: [],
    credits: null,
    resetCredits: null,
  };
  let rpc: Awaited<ReturnType<typeof createCodexRpc>> | undefined;
  let refresh: Promise<IUsageSnapshot> | undefined;
  let accountGeneration = 0;
  let events: ICodexEvents | undefined;
  const controlled = new Set<string>();
  const outputSchemas = new Map<string, IOutputSchema>();
  const configurations = new Map<
    string,
    {
      response: NonNullable<ReturnType<typeof readCodexConfigurationObservation>>;
      settings: ISessionSettings;
    }
  >();
  const assertActive = (signal?: AbortSignal): void => {
    if (signal?.aborted)
      throw new Exception('The Codex integration failed', {
        code: 'JG_AGENT_HQ_CODEX_FAILED',
        data: { kind: 'agent-unavailable' },
      });
  };
  // an uncertain idle-control release requires recovery before further input
  const releaseControlState = (nativeId: string): void => {
    controlled.delete(nativeId);
    outputSchemas.delete(nativeId);
    events?.forgetTurn(nativeId);
  };
  /** Keeps bounded startup evidence for fields omitted by the native history read. */
  const rememberConfiguration = (
    nativeId: string,
    response: unknown,
    settings: ISessionSettings,
  ): void => {
    const observation = readCodexConfigurationObservation(response);
    if (!observation) {
      configurations.delete(nativeId);
      return;
    }
    if (!configurations.has(nativeId) && configurations.size >= 32)
      configurations.delete(configurations.keys().next().value!);
    configurations.set(nativeId, {
      response: observation,
      settings,
    });
  };
  const readUsage = (): Promise<IUsageSnapshot> => {
    if (refresh) return refresh;
    const connection = rpc;
    if (!connection) return Promise.resolve(latest);
    const generation = accountGeneration;
    return (refresh = (async () => {
      try {
        const observation = toUsageSnapshot(
          parseNative(NativeUsageSchema, await connection.request('account/rateLimits/read', {})),
          Date.now(),
        );
        if (generation === accountGeneration) latest = observation;
      } catch {
        if (generation === accountGeneration)
          latest = { ...latest, state: latest.observedAt === null ? 'unavailable' : 'stale' };
      } finally {
        refresh = undefined;
      }
      if (
        (latest.observedAt !== null && Date.now() - latest.observedAt > 60_000) ||
        latest.windows.some((window) => window.resetsAt !== null && window.resetsAt <= Date.now())
      )
        latest = { ...latest, state: 'stale' };
      return latest;
    })());
  };
  rpc = await createCodexRpc(daemonLauncher, {
    request: (id, method, params) => {
      if (events) events.request(id, method, params);
      else void rpc?.reject(id).catch(() => undefined);
    },
    lateResponse: (id, result, error) => events?.lateResponse(id, result, error),
    unavailable: () => events?.unavailable(),
    opened: () => events?.connected(),
    discarded: () => events?.discarded(),
    notify: (method, params) => {
      events?.notify(method, params);
      if (method !== 'account/rateLimits/updated' && method !== 'account/updated') return;
      if (method === 'account/updated') {
        accountGeneration += 1;
        latest = {
          provider: 'codex',
          state: 'unavailable',
          source: 'native',
          observedAt: null,
          ordinaryUsageAllowed: null,
          windows: [],
          credits: null,
          resetCredits: null,
        };
      }
      if (
        method === 'account/rateLimits/updated' &&
        !z.object({ rateLimits: NativeBucketSchema }).safeParse(params).success
      ) {
        latest = { ...latest, state: latest.observedAt === null ? 'unavailable' : 'stale' };
        return;
      }
      // sparse updates invalidate the account observation; one native refresh reconciles all buckets
      latest = { ...latest, state: latest.observedAt === null ? 'unavailable' : 'stale' };
      void readUsage();
    },
  });
  const connection = rpc;
  const listTurns = async (
    nativeId: string,
    limit: number,
    cursor?: string,
  ): Promise<INativePage<ITurnSummary>> => {
    const page = parseNative(
      NativeTurnPageSchema,
      await connection.request('thread/turns/list', {
        threadId: nativeId,
        limit,
        cursor,
        sortDirection: 'desc',
        itemsView: 'notLoaded',
      }),
    );
    if (page.data.length > limit)
      throw new Exception('The Codex integration failed', {
        code: 'JG_AGENT_HQ_CODEX_FAILED',
        data: {
          kind: 'agent-unavailable',
        },
      });
    return { data: page.data.map(toTurnSummary), nextCursor: page.nextCursor };
  };
  /*
   * Reads turns newest first until every turn a history page's items belong to is found, so a
   * recent page takes one read; a turn older than the most pages read leaves its items untimed.
   */
  const readItemTurns = async (
    nativeId: string,
    turnIds: Set<string>,
  ): Promise<Map<string, ITurnSummary>> => {
    const turns = new Map<string, ITurnSummary>();
    let cursor: string | undefined;
    for (let read = 0; read < MAX_TURN_TIME_PAGES && turns.size < turnIds.size; read += 1) {
      const page = await listTurns(nativeId, TURN_TIMES_PAGE_SIZE, cursor);
      for (const turn of page.data) if (turnIds.has(turn.nativeId)) turns.set(turn.nativeId, turn);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return turns;
  };
  /**
   * Finds one item of a turn; Codex has no lookup of one item, so the turn's items are read,
   * 128 at a time, until it appears.
   * @returns The native item, or null when the turn holds no such item.
   * @throws
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   */
  const findItem = async (
    nativeId: string,
    turnId: string,
    nativeItemId: string,
  ): Promise<INativeItem | null> => {
    let cursor: string | undefined;
    do {
      const page = parseNative(
        NativeItemPageSchema,
        await connection.request('thread/items/list', {
          threadId: nativeId,
          turnId,
          limit: MAX_PAGE_SIZE,
          cursor,
          sortDirection: 'desc',
        }),
      );
      const entry = page.data.find((candidate) => candidate.item.id === nativeItemId);
      if (entry) return entry;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return null;
  };
  return {
    get userAgent() {
      return connection.userAgent;
    },
    get isAvailable() {
      return connection.isAvailable;
    },
    async listThreads(workspaceRoot, limit, cursor, search) {
      const page = parseNative(
        NativeThreadPageSchema,
        await connection.request('thread/list', {
          cwd: workspaceRoot,
          limit,
          cursor,
          searchTerm: search,
          // last activity first, as the CLI's own session list orders them
          sortKey: 'updated_at',
          sortDirection: 'desc',
          useStateDbOnly: true,
        }),
      );
      if (page.data.length > limit)
        throw new Exception('The Codex integration failed', {
          code: 'JG_AGENT_HQ_CODEX_FAILED',
          data: {
            kind: 'agent-unavailable',
          },
        });
      return { data: page.data.map(toThreadSummary), nextCursor: page.nextCursor };
    },
    async readModels(limit, cursor) {
      return toCodexModels(await connection.request('model/list', { limit, cursor }));
    },
    async readConfiguration(command, nativeId, signal) {
      assertActive(signal);
      const config = await connection.request('config/read', {
        cwd: command.workspaceRoot,
        includeLayers: false,
      });
      const recorded = nativeId ? configurations.get(nativeId) : undefined;
      assertActive(signal);
      const response = nativeId
        ? {
            ...recorded?.response,
            ...parseNative(
              z.record(z.string(), z.unknown()),
              await connection.request('thread/read', { threadId: nativeId, includeTurns: false }),
            ),
          }
        : undefined;
      return toCodexConfiguration(config, response, recorded?.settings ?? {}, command);
    },
    observeServiceTier(nativeId, serviceTier) {
      const recorded = configurations.get(nativeId);
      if (recorded) recorded.response = { ...recorded.response, serviceTier };
    },
    async readNativeThread(nativeId) {
      return parseNative(
        z.object({ thread: NativeThreadSchema.refine((thread) => thread.id === nativeId) }),
        await connection.request('thread/read', { threadId: nativeId, includeTurns: false }),
      ).thread;
    },
    async readThread(nativeId) {
      const result = parseNative(
        z.object({ thread: NativeThreadSchema.refine((thread) => thread.id === nativeId) }),
        await connection.request('thread/read', { threadId: nativeId, includeTurns: false }),
      );
      return toThreadSummary(result.thread);
    },
    async readObservedThread(nativeId) {
      const { thread } = parseNative(
        z.object({ thread: NativeThreadSchema.refine((thread) => thread.id === nativeId) }),
        await connection.request('thread/read', { threadId: nativeId, includeTurns: false }),
      );
      return { thread: toThreadSummary(thread), isEphemeral: thread.ephemeral === true };
    },
    async listLoadedThreads(cursor) {
      const page = parseNative(
        z.object({
          data: z.array(NativeIdSchema).max(LOADED_THREADS_PAGE_SIZE),
          nextCursor: z.string().max(4096).nullable().optional(),
        }),
        await connection.request('thread/loaded/list', {
          limit: LOADED_THREADS_PAGE_SIZE,
          cursor,
        }),
      );
      return { data: page.data, nextCursor: page.nextCursor ?? null };
    },
    listTurns,
    async listItems(nativeId, limit, cursor, turnId, fullBody = false) {
      const page = parseNative(
        NativeItemPageSchema,
        await connection.request('thread/items/list', {
          threadId: nativeId,
          turnId,
          limit,
          cursor,
          sortDirection: 'desc',
        }),
      );
      if (page.data.length > limit)
        throw new Exception('The Codex integration failed', {
          code: 'JG_AGENT_HQ_CODEX_FAILED',
          data: {
            kind: 'agent-unavailable',
          },
        });
      const turns = await readItemTurns(nativeId, new Set(page.data.map((item) => item.turnId)));
      return {
        // reasoning is left out, so a page can hold fewer items than its limit
        data: page.data.flatMap(
          (item) => toHistoryItem(item, turns.get(item.turnId), fullBody) ?? [],
        ),
        nextCursor: page.nextCursor,
      };
    },
    async readItemDetail(nativeId, turnId, nativeItemId) {
      const entry = await findItem(nativeId, turnId, nativeItemId);
      if (!entry) return null;
      const turns = await readItemTurns(nativeId, new Set([entry.turnId]));
      const item = toHistoryItem(entry, turns.get(entry.turnId));
      return item && { item, ...toItemDetail(entry) };
    },
    async readItemImage(nativeId, turnId, nativeItemId, index) {
      const entry = await findItem(nativeId, turnId, nativeItemId);
      const source = entry && toImageSources(entry)[index];
      if (source?.kind === 'path') return readImageFile(source.path);
      if (source?.kind === 'data') return decodeBase64Image(source.data);
      return imageUnavailable();
    },
    readUsage,
    async readSkills(workspaceRoot) {
      const result = parseNative(
        NativeSkillsSchema,
        await connection.request('skills/list', { cwds: [workspaceRoot], forceReload: true }),
      );
      const entry = result.data[0]!;
      if (entry.cwd !== workspaceRoot)
        throw new Exception('The Codex integration failed', {
          code: 'JG_AGENT_HQ_CODEX_FAILED',
          data: {
            kind: 'agent-unavailable',
          },
        });
      // native discovery reports no argument hints, so HQ reads each listed skill file's own
      const hints = await runInOrder(entry.skills, {
        concurrency: SKILL_HINT_READ_CONCURRENCY,
        execute: (skill) => readSkillHint(skill.path),
      });
      // native discovery never lists a thread's capability roots, so HQ adds its own; native wins
      const roots = await readSkillRoots(extraSkillRoots);
      const nativeNames = new Set(entry.skills.map((skill) => skill.name));
      return {
        invocationPrefix: '$',
        unavailableCount: entry.errors.length + roots.unavailableCount,
        observedAt: Date.now(),
        skills: [
          ...entry.skills.map((skill, index) => ({
            name: skill.name,
            description: skill.description,
            argumentHint: hints[index] ?? null,
            kind: 'skill' as const,
            path: skill.path,
            scope: skill.scope,
            isEnabled: skill.enabled,
            requiresExplicitInvocation: null,
            prerequisites:
              skill.dependencies?.tools.map((tool) => ({
                type: tool.type,
                name: tool.value,
                description: tool.description ?? null,
              })) ?? null,
          })),
          ...roots.skills
            .filter((skill) => !nativeNames.has(skill.name))
            .map((skill) => ({
              ...skill,
              kind: 'skill' as const,
              scope: HOST_SKILL_SCOPE,
              isEnabled: true,
              requiresExplicitInvocation: null,
              prerequisites: null,
            })),
        ],
      };
    },
    setEvents: (handlers) => {
      events = handlers;
    },
    async startThread(requestId, workspaceRoot, settings = {}) {
      const selected = { ...settings };
      const response = await connection.request(
        'thread/start',
        {
          cwd: workspaceRoot,
          ...toCodexSessionSettings(selected),
          // per-thread roots; forks inherit them, and other daemon sessions never see them
          ...(extraSkillRoots.length
            ? { selectedCapabilityRoots: toCapabilityRoots(extraSkillRoots) }
            : {}),
        },
        requestId,
      );
      const thread = parseNative(z.object({ thread: NativeThreadSchema }), response).thread;
      controlled.add(thread.id);
      if (selected.outputSchema) outputSchemas.set(thread.id, selected.outputSchema);
      rememberConfiguration(thread.id, response, selected);
      return thread;
    },
    async resumeThread(requestId, nativeId, settings = {}, signal) {
      assertActive(signal);
      const selected = { ...settings };
      if (Object.keys(selected).length) {
        const current = await connection.request('thread/read', {
          threadId: nativeId,
          includeTurns: false,
        });
        if (
          parseNative(z.object({ thread: NativeThreadSchema }), current).thread.status.type !==
          'notLoaded'
        )
          throw new Exception('The HQ capability is unavailable', {
            code: 'JG_AGENT_HQ_CAPABILITY_UNAVAILABLE',
            data: { kind: 'agent-unavailable' },
          });
      }
      assertActive(signal);
      const response = await connection.request(
        'thread/resume',
        { threadId: nativeId, excludeTurns: true, ...toCodexSessionSettings(selected) },
        requestId,
      );
      const result = parseNative(
        z.object({ thread: NativeThreadSchema.refine((thread) => thread.id === nativeId) }),
        response,
      );
      controlled.add(nativeId);
      if (selected.outputSchema) outputSchemas.set(nativeId, selected.outputSchema);
      else outputSchemas.delete(nativeId);
      rememberConfiguration(nativeId, response, selected);
      return result.thread;
    },
    async nameThread(requestId, nativeId, name) {
      parseNative(
        z.object({}),
        await connection.request('thread/name/set', { threadId: nativeId, name }, requestId),
      );
    },
    async startTurn(requestId, nativeId, text, skill, settings = {}, files = []) {
      const { fast, ...turnSettings } = settings;
      const outputSchema = settings.outputSchema ?? outputSchemas.get(nativeId);
      events?.prepareTurn(nativeId, outputSchema);
      return parseNative(
        z.object({ turn: NativeTurnSchema }),
        await connection.request(
          'turn/start',
          {
            threadId: nativeId,
            clientUserMessageId: requestId,
            ...turnSettings,
            ...(fast !== undefined ? { serviceTier: toCodexServiceTier(fast) } : {}),
            ...(outputSchema ? { outputSchema } : {}),
            input: [
              { type: 'text', text },
              ...(skill ? [{ type: 'skill', name: skill.name, path: skill.path }] : []),
              ...files.map((file) =>
                file.mediaType === 'text/plain'
                  ? {
                      type: 'text',
                      text: `File ${file.path} (SHA-256 ${file.sha256}):\n${new TextDecoder('utf-8', { fatal: true }).decode(file.content)}`,
                    }
                  : {
                      type: 'image',
                      url: `data:${file.mediaType};base64,${Buffer.from(file.content).toString('base64')}`,
                    },
              ),
            ],
          },
          requestId,
        ),
      ).turn;
    },
    async steer(requestId, nativeId, expectedTurnId, text) {
      const result = parseNative(
        z.object({ turnId: z.literal(expectedTurnId) }),
        await connection.request(
          'turn/steer',
          {
            threadId: nativeId,
            expectedTurnId,
            clientUserMessageId: requestId,
            input: [{ type: 'text', text }],
          },
          requestId,
        ),
      );
      return result.turnId;
    },
    async interrupt(requestId, nativeId, nativeTurnId) {
      parseNative(
        z.object({}),
        await connection.request(
          'turn/interrupt',
          { threadId: nativeId, turnId: nativeTurnId },
          requestId,
        ),
      );
    },
    async cleanTerminals(requestId, nativeId) {
      parseNative(
        z.object({}),
        await connection.request(
          'thread/backgroundTerminals/clean',
          { threadId: nativeId },
          requestId,
        ),
      );
    },
    async verifyTerminalsClosed(nativeId) {
      const page = parseNative(
        z.object({
          data: z.array(z.unknown()).max(1),
          nextCursor: z.string().nullable().optional(),
        }),
        await connection.request('thread/backgroundTerminals/list', {
          threadId: nativeId,
          limit: 1,
        }),
      );
      if (page.data.length || page.nextCursor)
        throw new Exception('The Codex integration failed', {
          code: 'JG_AGENT_HQ_CODEX_FAILED',
          data: {
            kind: 'agent-unavailable',
          },
        });
    },
    async unsubscribe(requestId, nativeId) {
      try {
        const result = parseNative(
          z.object({ status: z.string() }),
          await connection.request('thread/unsubscribe', { threadId: nativeId }, requestId),
        );
        if (!['unsubscribed', 'notSubscribed', 'notLoaded'].includes(result.status))
          throw new Exception('The Codex integration failed', {
            code: 'JG_AGENT_HQ_CODEX_FAILED',
            data: {
              kind: 'agent-unavailable',
            },
          });
      } finally {
        releaseControlState(nativeId);
      }
    },
    reply: connection.reply,
    reject: connection.reject,
    // a lost daemon leaves no controlled session; the next request reconnects
    disconnect: async () => {
      await connection.disconnect();
      for (const nativeId of [...controlled]) releaseControlState(nativeId);
    },
    close: async () => {
      await connection.close();
      controlled.clear();
    },
  };
};
