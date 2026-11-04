import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  SessionSettingsSchema,
  MAX_PAGE_SIZE,
  TurnSettingsSchema,
  type IProviderCapability,
  type IProviderCapabilitySet,
  type ISessionState,
} from '../../contracts/index.js';
import { resolveWorkspaceTarget } from '../../runtime/state/index.js';
import { decodeHistoryCursor, encodeHistoryCursor } from '../../sessions/index.js';
import type { IHistoryRequest } from '../../sessions/index.js';
import type { IObservedThread } from '../../store/sessions/index.js';
import {
  buildEvidencePage,
  evidencePosition,
  EVIDENCE_SOURCE_PAGE_SIZE,
} from '../../sessions/evidence/index.js';

import {
  buildProviderCapabilities,
  MODEL_CATALOG_UNAVAILABLE,
  SUPPORTED_PROVIDER_OPERATION,
  type IAgentProviderFactory,
  type IProviderReattachment,
  type IProviderThread,
} from '../index.js';

import { capabilityUnavailable } from '../registry/index.js';
import { HQ_ERRORS } from '../../errors/index.js';

import { createCodexProvider } from './codex.js';
import { MAX_LOADED_THREAD_PAGES } from './constants.js';
import { createCodexEvents, toProviderThread } from './events.js';

/**
 * Describes current Codex controls and lazily owns a connection to the shared app-server daemon.
 * @param extraSkillRoots The capability roots of each thread HQ starts.
 * @param daemonLauncher The command and arguments run before `codex app-server daemon start`.
 * @returns A built-in factory that preserves native settings, authentication and permission policy.
 */
export const createCodexProviderFactory = (
  extraSkillRoots: string[],
  daemonLauncher: string[],
): IAgentProviderFactory => ({
  id: 'codex',
  async create(context) {
    const native = await createCodexProvider(extraSkillRoots, daemonLauncher);
    /*
     * Each session's workspace, name and creation time, read once, or null for one that isn't
     * observed: Codex doesn't save it, or it runs outside the allowed workspaces.
     */
    const observedThreads = new Map<string, IObservedThread | null>();
    let observations = Promise.resolve();
    // records a session's state, read from Codex when no status change reported it
    const record = async (nativeId: string, reported: ISessionState | null): Promise<void> => {
      let thread = observedThreads.get(nativeId);
      let state = reported;
      if (thread === undefined || state === null) {
        const observed = await native.readObservedThread(nativeId);
        const { workspaceRoot, name, createdAt } = observed.thread;
        state ??= observed.thread.state;
        thread =
          !observed.isEphemeral &&
          (await resolveWorkspaceTarget(workspaceRoot, context.allowedRoots)
            .then(() => true)
            .catch(() => false))
            ? { workspaceRoot, name, createdAt }
            : null;
        if (observedThreads.size >= 1024)
          observedThreads.delete(observedThreads.keys().next().value!);
        observedThreads.set(nativeId, thread);
      }
      if (thread) context.events.session(nativeId, state, thread);
    };
    const observeSession = (nativeId: string, state: ISessionState): void => {
      observations = observations
        .then(() => record(nativeId, state))
        // an unreadable session stays unobserved until its next status change
        .catch(() => undefined);
    };
    /*
     * A session the daemon already ran when this connection opened reports no status change until
     * it next changes, so every loaded thread's state is read on each connect.
     */
    const observeLoaded = (): void => {
      observations = observations
        .then(async () => {
          let cursor: string | undefined;
          for (let page = 0; page < MAX_LOADED_THREAD_PAGES; page += 1) {
            const loaded = await native.listLoadedThreads(cursor);
            for (const nativeId of loaded.data) await record(nativeId, null).catch(() => undefined);
            if (loaded.nextCursor === null) return;
            cursor = loaded.nextCursor;
          }
        })
        .catch(() => undefined);
    };
    native.setEvents(createCodexEvents(native, context.events, observeSession, observeLoaded));
    observeLoaded();
    const verifyRoot = async (workspaceRoot: string, expectedRoot: string): Promise<void> => {
      if ((await resolveWorkspaceTarget(workspaceRoot, context.allowedRoots)) !== expectedRoot)
        throw HQ_ERRORS.create('targetForbidden', { data: { kind: 'access-denied' } });
    };
    // a session's latest turn, which runs only while the daemon reports the session active
    const readLatestTurn = async (
      thread: IProviderThread,
    ): Promise<IProviderReattachment['latestTurn']> => {
      const [turn] = (await native.listTurns(thread.nativeId, 1)).data;
      if (!turn) return null;
      if (turn.state !== 'inProgress' && turn.state !== 'unknown')
        return { nativeId: turn.nativeId, state: turn.state, isInferred: false };
      /*
       * A turn cut short when the daemon stopped stays in progress in its saved history, and so
       * does one whose end the history hasn't saved yet, so its state comes from the status.
       */
      return {
        nativeId: turn.nativeId,
        state: thread.nativeState === 'active' ? 'running' : 'interrupted',
        isInferred: true,
      };
    };
    const readHistory = async (command: IHistoryRequest) => {
      const position = command.kind === 'session-evidence' ? evidencePosition(command) : undefined;
      const { cursor, ...filters } = {
        ...command,
        cursor: 'cursor' in command ? command.cursor : undefined,
      };
      const thread = await native.readThread(command.nativeId);
      await verifyRoot(thread.workspaceRoot, command.workspaceRoot);
      thread.workspaceRoot = command.workspaceRoot;
      if (command.kind === 'thread') return { kind: 'thread' as const, result: thread };
      if (command.kind === 'item-detail')
        return {
          kind: 'item-detail' as const,
          result: await native.readItemDetail(
            command.nativeId,
            command.turnId,
            command.nativeItemId,
          ),
        };
      if (command.kind === 'item-image')
        return {
          kind: 'item-image' as const,
          result: await native.readItemImage(
            command.nativeId,
            command.turnId,
            command.nativeItemId,
            command.index,
          ),
        };
      if (command.kind === 'session-evidence') {
        const page = await native.listItems(
          command.nativeId,
          EVIDENCE_SOURCE_PAGE_SIZE,
          position!.sourceCursor ?? undefined,
          command.turnId,
          true,
        );
        return {
          kind: 'session-evidence' as const,
          result: buildEvidencePage(command, position!, page.data, page.nextCursor),
        };
      }
      const nativeCursor = decodeHistoryCursor(cursor, filters);
      if (command.nativeItemId !== undefined) {
        // Codex has no lookup of one item, so its turn's items are read until it appears
        let itemCursor: string | undefined;
        do {
          const page = await native.listItems(
            command.nativeId,
            MAX_PAGE_SIZE,
            itemCursor,
            command.turnId,
          );
          const item = page.data.find((entry) => entry.nativeId === command.nativeItemId);
          if (item)
            return {
              kind: 'items' as const,
              result: {
                data: [item],
                nextCursor: null,
                source: 'native' as const,
                history: 'persisted' as const,
              },
            };
          itemCursor = page.nextCursor ?? undefined;
        } while (itemCursor);
        return {
          kind: 'items' as const,
          result: {
            data: [],
            nextCursor: null,
            source: 'native' as const,
            history: 'persisted' as const,
          },
        };
      }
      const page = await native.listItems(
        command.nativeId,
        command.limit,
        nativeCursor,
        command.turnId,
      );
      return {
        kind: 'items' as const,
        result: {
          data: page.data,
          nextCursor: encodeHistoryCursor(page.nextCursor, filters),
          source: 'native' as const,
          history: 'persisted' as const,
        },
      };
    };
    return {
      get state() {
        return native.isAvailable ? 'ready' : 'unavailable';
      },
      get version() {
        return native.userAgent;
      },
      get isAvailable() {
        return native.isAvailable;
      },
      async readCapabilities(): Promise<IProviderCapabilitySet> {
        if (!native.isAvailable)
          throw HQ_ERRORS.create('codexFailed', { data: { kind: 'agent-unavailable' } });
        let models: IProviderCapability = SUPPORTED_PROVIDER_OPERATION;
        try {
          await native.readModels(1);
        } catch {
          models = MODEL_CATALOG_UNAVAILABLE;
        }
        return buildProviderCapabilities({
          provider: 'codex',
          operations: { models },
          supportedMediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'text/plain'],
          configurationSchema: {
            session: z
              .json()
              .parse(z.toJSONSchema(SessionSettingsSchema.omit({ nativeAgent: true }))),
            turn: z.json().parse(z.toJSONSchema(TurnSettingsSchema)),
            sessionChangeMode: 'idle-restart',
            turnChangeMode: 'live',
            permissionModes: ['untrusted', 'on-request', 'never'],
            sandboxModes: ['read-only', 'workspace-write', 'danger-full-access'],
          },
        });
      },
      async listThreads(workspaceRoot, page) {
        const listed = await native.listThreads(
          workspaceRoot,
          page.limit,
          page.cursor ?? undefined,
          page.search,
        );
        const checkedRoots = new Set<string>();
        for (const thread of listed.data) {
          if (!checkedRoots.has(thread.workspaceRoot)) {
            await verifyRoot(thread.workspaceRoot, workspaceRoot);
            checkedRoots.add(thread.workspaceRoot);
          }
          thread.workspaceRoot = workspaceRoot;
        }
        return listed;
      },
      readHistory,
      readConfiguration: (command, nativeId, call) =>
        native.readConfiguration(command, nativeId, call.signal),
      async readModels(command) {
        const { cursor, ...filters } = command;
        const page = await native.readModels(command.limit, decodeHistoryCursor(cursor, filters));
        return {
          provider: 'codex',
          source: 'native',
          observedAt: Date.now(),
          data: page.data,
          nextCursor: encodeHistoryCursor(page.nextCursor, filters),
        };
      },
      async inspectThread(nativeId, workspaceRoot) {
        const thread = await native.readThread(nativeId);
        await verifyRoot(thread.workspaceRoot, workspaceRoot);
        return {
          thread,
          // handover: a session another client drives becomes adoptable once it is closed there
          canAdopt: thread.nativeState === 'notLoaded',
          canResume: thread.nativeState === 'idle',
        };
      },
      async readReattachment(nativeId, workspaceRoot) {
        const thread = toProviderThread(await native.readNativeThread(nativeId));
        await verifyRoot(thread.workspaceRoot, workspaceRoot);
        return { thread, latestTurn: await readLatestTurn(thread) };
      },
      async reattachThread(requestId, nativeId, workspaceRoot, call) {
        // without settings, Codex joins a session it has loaded rather than refusing it
        const thread = toProviderThread(
          await native.resumeThread(requestId, nativeId, {}, call.signal),
        );
        await verifyRoot(thread.workspaceRoot, workspaceRoot);
        return { thread, latestTurn: await readLatestTurn(thread) };
      },
      readUsage: () => native.readUsage(),
      readSkills: (workspaceRoot) => native.readSkills(workspaceRoot),
      formatSkill: (skill, argumentsText) =>
        `$${skill.name}${argumentsText ? ` ${argumentsText}` : ''}`,
      startThread: async (requestId, workspaceRoot, settings) =>
        toProviderThread(await native.startThread(requestId, workspaceRoot, settings)),
      resumeThread: async (requestId, nativeId, _workspaceRoot, _name, settings, call) =>
        toProviderThread(await native.resumeThread(requestId, nativeId, settings, call.signal)),
      nameThread: (requestId, nativeId, name) => native.nameThread(requestId, nativeId, name),
      async validateInput(_nativeId, input) {
        if (
          input.files.some(
            (file) => file.mediaType === 'application/pdf' || file.mediaType === 'image/gif',
          )
        )
          capabilityUnavailable();
      },
      startTurn: (requestId, nativeId, text, skill, settings, files) =>
        native.startTurn(requestId, nativeId, text, skill, settings, files),
      steer: (requestId, nativeId, expectedTurnId, text) =>
        native.steer(requestId, nativeId, expectedTurnId, text),
      interrupt: (requestId, nativeId, nativeTurnId) =>
        native.interrupt(requestId, nativeId, nativeTurnId),
      cleanThread: (requestId, nativeId) => native.cleanTerminals(requestId, nativeId),
      async releaseThread(requestId, nativeId) {
        await native.verifyTerminalsClosed(nativeId);
        await native.unsubscribe(requestId, nativeId);
      },
      async prepareShutdown(nativeId) {
        await native.cleanTerminals(`${randomUUID()}:shutdown-clean`, nativeId);
        await native.verifyTerminalsClosed(nativeId);
      },
      stopControl: () => native.disconnect(),
      close: () => native.close(),
    };
  },
});
