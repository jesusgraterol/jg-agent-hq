import { Exception, isException } from 'jg-exception';
import { z } from 'zod';
import { abortable, createDeadline } from 'jg-utilities';

import type { IUsageSnapshot, ISessionSettings, IOutputSchema } from '../../contracts/index.js';
import type { IProviderAgentTools } from '../../agent-tools/index.js';

import { createCodexRpc } from './rpc.js';
import { createCodexExtensions } from './extensions/index.js';
import { createCodexAccounts } from './accounts/index.js';
import { createCodexAuthentication } from './authentication/index.js';
import { capabilityUnavailable } from '../registry/index.js';
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
import { HOST_SKILL_SCOPE, readSkillRoots, toCapabilityRoots } from './skill-roots/index.js';
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
  agentTools?: IProviderAgentTools,
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
  const toolLifetime = new AbortController();
  const toolCalls = new Set<Promise<void>>();
  const controlled = new Set<string>();
  const toolSessions = new Set<string>();
  let authentication: ReturnType<typeof createCodexAuthentication> | undefined;
  const extensionRequests = new Map<string, 'skills-reload' | 'mcp-reload'>();
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
    toolSessions.delete(nativeId);
    outputSchemas.delete(nativeId);
    events?.forgetTurn(nativeId);
  };
  /** Routes verifiable native children through their owning managed session's identity. */
  const performTool = async (
    id: string | number,
    params: unknown,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!agentTools || toolCalls.size >= 32 || toolLifetime.signal.aborted) {
      await rpc?.reject(id);
      return;
    }
    const parsed = z
      .object({
        threadId: z.string().min(1).max(4096),
        turnId: z.string().min(1).max(4096),
        callId: z.string().min(1).max(4096),
        namespace: z.null().optional(),
        tool: z.string().min(1).max(128),
        arguments: z.json(),
      })
      .safeParse(params);
    if (!parsed.success) {
      await rpc?.reject(id);
      return;
    }
    let nativeId = parsed.data.threadId;
    const isChild = !controlled.has(nativeId);
    let childRoot: string | undefined;
    const visited = new Set<string>();
    while (!controlled.has(nativeId) && visited.size < 32 && !visited.has(nativeId)) {
      visited.add(nativeId);
      const child = parseNative(
        z.object({ thread: NativeThreadSchema }),
        await abortable(rpc!.request('thread/read', { threadId: nativeId, includeTurns: false }), {
          signal,
        }),
      ).thread;
      if (
        child.id !== nativeId ||
        !child.parentThreadId ||
        (childRoot && child.cwd !== childRoot)
      ) {
        await rpc?.reject(id);
        return;
      }
      childRoot = child.cwd;
      nativeId = child.parentThreadId;
      signal.throwIfAborted();
    }
    if (!controlled.has(nativeId)) {
      await rpc?.reject(id);
      return;
    }
    if (isChild) {
      const owner = parseNative(
        z.object({ thread: NativeThreadSchema }),
        await abortable(rpc!.request('thread/read', { threadId: nativeId, includeTurns: false }), {
          signal,
        }),
      ).thread;
      if (owner.id !== nativeId || owner.cwd !== childRoot) {
        await rpc?.reject(id);
        return;
      }
    }
    const result = await agentTools.call(
      nativeId,
      isChild ? undefined : parsed.data.turnId,
      parsed.data.tool,
      parsed.data.arguments,
      signal,
    );
    toolSessions.add(nativeId);
    await rpc?.reply(id, {
      contentItems: result.content.map((item) => ({ type: 'inputText', text: item.text })),
      success: !result.isError,
    });
  };
  /** Bounds the complete native lineage lookup and tool call under one owned deadline. */
  const callTool = async (id: string | number, params: unknown): Promise<void> => {
    const deadline = createDeadline({ timeoutSeconds: 30, signal: toolLifetime.signal });
    try {
      deadline.throwIfStopped();
      await performTool(id, params, deadline.signal);
    } finally {
      deadline.dispose();
    }
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
  rpc = await createCodexRpc({
    request: (id, method, params) => {
      if (method === 'item/tool/call') {
        const operation = callTool(id, params);
        toolCalls.add(operation);
        void operation
          .catch(() => rpc?.reject(id))
          .finally(() => toolCalls.delete(operation))
          .catch(() => undefined);
        return;
      }
      if (events) events.request(id, method, params);
      else void rpc?.reject(id).catch(() => undefined);
    },
    lateResponse: (id, result, error) => {
      if (authentication?.lateResponse(id, result, error)) return;
      if (extensionRequests.has(id)) {
        extensionRequests.delete(id);
        if (error !== undefined)
          events?.controlOutcome({ kind: 'failed', requestId: id, failure: 'agent-unavailable' });
        else {
          z.object({}).parse(result);
          events?.controlOutcome({
            kind: 'control-accepted',
            requestId: id,
            state: 'applied',
            completion: 'completed',
          });
        }
        return;
      }
      events?.lateResponse(id, result, error);
    },
    unavailable: () => {
      authentication?.unavailable();
      extensionRequests.clear();
      events?.unavailable();
    },
    notify: (method, params) => {
      authentication?.notify(method, params);
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
  authentication = createCodexAuthentication(connection, (outcome) =>
    events?.controlOutcome(outcome),
  );
  return {
    hasAgentTools: (nativeId) => toolSessions.has(nativeId),
    ...createCodexExtensions(connection),
    ...createCodexAccounts(connection),
    readLogin: authentication.readLogin,
    controlAccount: authentication.controlAccount,
    /**
     * Applies supported native reloads or starts exact-session MCP OAuth.
     * @returns Native control acknowledgement, separate from authentication completion.
     * @throws
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
     * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async controlExtensions(requestId, nativeId, workspaceRoot, command) {
      if (command.kind === 'mcp-login')
        return authentication!.loginMcp(requestId, nativeId, command.serverName);
      if (command.kind !== 'skills-reload' && command.kind !== 'mcp-reload')
        capabilityUnavailable();
      if (extensionRequests.size >= 32)
        throw new Exception('The HQ action conflicts with its recorded state', {
          code: 'JG_AGENT_HQ_ACTION_CONFLICT',
          data: { kind: 'state-conflict' },
        });
      extensionRequests.set(requestId, command.kind);
      try {
        z.object({}).parse(
          await connection.request(
            command.kind === 'skills-reload' ? 'skills/list' : 'config/mcpServer/reload',
            command.kind === 'skills-reload' ? { cwds: [workspaceRoot], forceReload: true } : {},
            requestId,
          ),
        );
        extensionRequests.delete(requestId);
        return { state: 'applied', completion: 'completed' };
      } catch (error) {
        if (
          isException(error) &&
          z.object({ nativeCode: z.number() }).safeParse(error.data).success
        )
          extensionRequests.delete(requestId);
        throw error;
      }
    },
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
      controlled.add(result.thread.id);
      if (toolSessions.has(nativeId)) toolSessions.add(result.thread.id);
      return result.thread;
    },
    async archiveThread(requestId, nativeId) {
      try {
        parseNative(
          z.object({}),
          await connection.request('thread/archive', { threadId: nativeId }, requestId),
        );
      } finally {
        releaseControlState(nativeId);
      }
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
    async listItems(nativeId, limit, cursor, turnId, evidence = false) {
      const page = parseNative(
        NativeItemPageSchema,
        await connection.request('thread/items/list', {
          threadId: nativeId,
          turnId,
          limit,
          cursor,
          sortDirection: evidence ? 'desc' : 'asc',
        }),
      );
      if (page.data.length > limit)
        throw new Exception('The Codex integration failed', {
          code: 'JG_AGENT_HQ_CODEX_FAILED',
          data: {
            kind: 'agent-unavailable',
          },
        });
      return {
        data: page.data.map((item) => toHistoryItem(item, evidence)),
        nextCursor: page.nextCursor,
      };
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
      // native discovery never lists a thread's capability roots, so HQ adds its own; native wins
      const roots = await readSkillRoots(extraSkillRoots);
      const nativeNames = new Set(entry.skills.map((skill) => skill.name));
      return {
        unavailableCount: entry.errors.length + roots.unavailableCount,
        observedAt: Date.now(),
        skills: [
          ...entry.skills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            argumentHint: null,
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
              argumentHint: null,
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
          ...(agentTools
            ? {
                dynamicTools: agentTools
                  .definitions()
                  .map((tool) => ({ type: 'function', ...tool })),
              }
            : {}),
        },
        requestId,
      );
      const thread = parseNative(z.object({ thread: NativeThreadSchema }), response).thread;
      controlled.add(thread.id);
      if (agentTools) toolSessions.add(thread.id);
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
      const outputSchema = settings.outputSchema ?? outputSchemas.get(nativeId);
      events?.prepareTurn(nativeId, outputSchema);
      return parseNative(
        z.object({ turn: NativeTurnSchema }),
        await connection.request(
          'turn/start',
          {
            threadId: nativeId,
            clientUserMessageId: requestId,
            ...settings,
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
    close: async () => {
      toolLifetime.abort();
      await connection.close();
      await Promise.allSettled([...toolCalls]);
      controlled.clear();
      toolSessions.clear();
    },
  };
};
