import { Exception } from 'jg-exception';
import { z } from 'zod';

import type { IUsageSnapshot, ISessionSettings } from '../../contracts/index.js';

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
} from './types.js';
import { toHistoryItem, toThreadSummary, toTurnSummary, toUsageSnapshot } from './transformers.js';
import { parseNative } from './validations.js';
import { toCodexModels } from './models/index.js';
import {
  toCodexConfiguration,
  toCodexSessionSettings,
  readCodexConfigurationObservation,
} from './configuration/index.js';

/**
 * Connects native history, account observations and explicitly admitted runtime controls.
 * @returns The owned adapter. Its caller must close it on shutdown.
 * @throws
 * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
 * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
 */
export const createCodexProvider = async (
  extraSkillRoots: string[] = [],
): Promise<ICodexProvider> => {
  let latest: IUsageSnapshot = {
    provider: 'codex',
    state: 'unavailable',
    source: 'native',
    observedAt: null,
    ordinaryUsageAllowed: null,
    windows: [],
  };
  let rpc: Awaited<ReturnType<typeof createCodexRpc>> | undefined;
  let refresh: Promise<IUsageSnapshot> | undefined;
  let accountGeneration = 0;
  let events: ICodexEvents | undefined;
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
  rpc = await createCodexRpc(
    {
      request: (id, method, params) => {
        if (events) events.request(id, method, params);
        else void rpc?.reject(id).catch(() => undefined);
      },
      lateResponse: (id, result, error) => events?.lateResponse(id, result, error),
      unavailable: () => events?.unavailable(),
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
    },
    extraSkillRoots,
  );
  const connection = rpc;
  return {
    userAgent: connection.userAgent,
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
          sortKey: 'created_at',
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
    async forkThread(requestId, nativeId) {
      const result = parseNative(
        z.object({
          thread: NativeThreadSchema.refine(
            (thread) => thread.id !== nativeId && thread.forkedFromId === nativeId,
          ),
        }),
        await connection.request(
          'thread/fork',
          { threadId: nativeId, excludeTurns: true },
          requestId,
        ),
      );
      return result.thread;
    },
    async archiveThread(requestId, nativeId) {
      parseNative(
        z.object({}),
        await connection.request('thread/archive', { threadId: nativeId }, requestId),
      );
    },
    async unarchiveThread(requestId, nativeId) {
      return parseNative(
        z.object({ thread: NativeThreadSchema.refine((thread) => thread.id === nativeId) }),
        await connection.request('thread/unarchive', { threadId: nativeId }, requestId),
      ).thread;
    },
    async compactThread(requestId, nativeId) {
      parseNative(
        z.object({}),
        await connection.request('thread/compact/start', { threadId: nativeId }, requestId),
      );
    },
    async revertThread(requestId, nativeId, beforeTurnId) {
      return parseNative(
        z.object({
          thread: NativeThreadSchema.refine(
            (thread) => thread.id === nativeId && thread.status.type === 'idle',
          ),
        }),
        await connection.request('thread/revert', { threadId: nativeId, beforeTurnId }, requestId),
      ).thread;
    },
    async readThread(nativeId) {
      const result = parseNative(
        z.object({ thread: NativeThreadSchema.refine((thread) => thread.id === nativeId) }),
        await connection.request('thread/read', { threadId: nativeId, includeTurns: false }),
      );
      return toThreadSummary(result.thread);
    },
    async listTurns(nativeId, limit, cursor) {
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
    },
    async listItems(nativeId, limit, cursor, turnId) {
      const page = parseNative(
        NativeItemPageSchema,
        await connection.request('thread/items/list', {
          threadId: nativeId,
          turnId,
          limit,
          cursor,
          sortDirection: 'asc',
        }),
      );
      if (page.data.length > limit)
        throw new Exception('The Codex integration failed', {
          code: 'JG_AGENT_HQ_CODEX_FAILED',
          data: {
            kind: 'agent-unavailable',
          },
        });
      return { data: page.data.map(toHistoryItem), nextCursor: page.nextCursor };
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
      return {
        unavailableCount: entry.errors.length,
        observedAt: Date.now(),
        skills: entry.skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          argumentHint: null,
          kind: 'skill',
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
      };
    },
    setEvents: (handlers) => {
      events = handlers;
    },
    async startThread(requestId, workspaceRoot, settings = {}) {
      const selected = { ...settings };
      const response = await connection.request(
        'thread/start',
        { cwd: workspaceRoot, ...toCodexSessionSettings(selected) },
        requestId,
      );
      const thread = parseNative(z.object({ thread: NativeThreadSchema }), response).thread;
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
      rememberConfiguration(nativeId, response, selected);
      return result.thread;
    },
    async nameThread(requestId, nativeId, name) {
      parseNative(
        z.object({}),
        await connection.request('thread/name/set', { threadId: nativeId, name }, requestId),
      );
    },
    async startTurn(requestId, nativeId, text, skill, settings = {}) {
      return parseNative(
        z.object({ turn: NativeTurnSchema }),
        await connection.request(
          'turn/start',
          {
            threadId: nativeId,
            ...settings,
            input: [
              { type: 'text', text },
              ...(skill ? [{ type: 'skill', name: skill.name, path: skill.path }] : []),
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
          { threadId: nativeId, expectedTurnId, input: [{ type: 'text', text }] },
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
    },
    reply: connection.reply,
    reject: connection.reject,
    close: connection.close,
  };
};
