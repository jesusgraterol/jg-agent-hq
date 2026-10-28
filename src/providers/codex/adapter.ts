import { randomUUID } from 'node:crypto';
import { Exception } from 'jg-exception';
import { z } from 'zod';

import {
  SessionSettingsSchema,
  MAX_PAGE_SIZE,
  MAX_INPUT_FILES,
  MAX_INPUT_FILE_BYTES,
  MAX_TEXT_FILE_BYTES,
  TurnSettingsSchema,
  type IProviderCapabilitySet,
  type ISessionState,
} from '../../contracts/index.js';
import { resolveWorkspaceTarget } from '../../runtime/state/index.js';
import { decodeHistoryCursor, encodeHistoryCursor } from '../../sessions/index.js';
import type { IHistoryRequest } from '../../sessions/index.js';
import {
  buildEvidencePage,
  evidencePosition,
  EVIDENCE_SOURCE_PAGE_SIZE,
} from '../../sessions/evidence/index.js';

import {
  PROVIDER_INPUT_SCHEMA,
  SUPPORTED_PROVIDER_OPERATION,
  type IAgentProviderFactory,
} from '../index.js';

import { capabilityUnavailable } from '../registry/index.js';

import { createCodexProvider } from './codex.js';
import { MAX_LOADED_THREAD_PAGES } from './constants.js';
import { createCodexEvents, toProviderThread } from './events.js';

/**
 * Describes current Codex controls and lazily owns a connection to the shared app-server daemon.
 * @returns A built-in factory that preserves native settings, authentication and permission policy.
 */
export const createCodexProviderFactory = (extraSkillRoots: string[]): IAgentProviderFactory => ({
  id: 'codex',
  async create(context) {
    const native = await createCodexProvider(extraSkillRoots, context.agentTools);
    // whether each session is observed, read once: Codex saves it and it's inside an allowed workspace
    const allowedSessions = new Map<string, boolean>();
    let observations = Promise.resolve();
    // records a session's state, read from Codex when no status change reported it
    const record = async (nativeId: string, reported: ISessionState | null): Promise<void> => {
      let isAllowed = allowedSessions.get(nativeId);
      let state = reported;
      if (isAllowed === undefined || state === null) {
        const observed = await native.readObservedThread(nativeId);
        state ??= observed.thread.state;
        isAllowed =
          !observed.isEphemeral &&
          (await resolveWorkspaceTarget(observed.thread.workspaceRoot, context.allowedRoots)
            .then(() => true)
            .catch(() => false));
        if (allowedSessions.size >= 1024)
          allowedSessions.delete(allowedSessions.keys().next().value!);
        allowedSessions.set(nativeId, isAllowed);
      }
      if (isAllowed) context.events.session(nativeId, state);
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
        throw new Exception('The HQ target is outside the allowed workspaces', {
          code: 'JG_AGENT_HQ_TARGET_FORBIDDEN',
          data: { kind: 'access-denied' },
        });
    };
    const readHistory = async (command: IHistoryRequest) => {
      const position = command.kind === 'session-evidence' ? evidencePosition(command) : undefined;
      const { cursor, ...filters } = {
        ...command,
        cursor: 'cursor' in command ? command.cursor : undefined,
      };
      if (command.kind === 'threads') {
        const page = await native.listThreads(
          command.workspaceRoot,
          command.limit,
          decodeHistoryCursor(cursor, filters),
          command.search,
        );
        const checkedRoots = new Set<string>();
        for (const thread of page.data) {
          if (!checkedRoots.has(thread.workspaceRoot)) {
            await verifyRoot(thread.workspaceRoot, command.workspaceRoot);
            checkedRoots.add(thread.workspaceRoot);
          }
          thread.workspaceRoot = command.workspaceRoot;
        }
        return {
          kind: 'threads' as const,
          result: {
            data: page.data,
            nextCursor: encodeHistoryCursor(page.nextCursor, filters),
            source: 'native' as const,
          },
        };
      }
      const thread = await native.readThread(command.nativeId);
      await verifyRoot(thread.workspaceRoot, command.workspaceRoot);
      thread.workspaceRoot = command.workspaceRoot;
      if (command.kind === 'thread') return { kind: 'thread' as const, result: thread };
      if (command.kind === 'session-evidence') {
        const page = await native.listItems(
          command.nativeId,
          EVIDENCE_SOURCE_PAGE_SIZE,
          position!.sourceCursor,
          command.turnId,
          true,
        );
        return {
          kind: 'session-evidence' as const,
          result: buildEvidencePage(command, position!, page.data, page.nextCursor),
        };
      }
      const nativeCursor = decodeHistoryCursor(cursor, filters);
      if (command.kind === 'turns') {
        const page = await native.listTurns(command.nativeId, command.limit, nativeCursor);
        return {
          kind: 'turns' as const,
          result: {
            data: page.data,
            nextCursor: encodeHistoryCursor(page.nextCursor, filters),
            source: 'native' as const,
          },
        };
      }
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
      async readCapabilities(nativeId): Promise<IProviderCapabilitySet> {
        if (!native.isAvailable)
          throw new Exception('The Codex integration failed', {
            code: 'JG_AGENT_HQ_CODEX_FAILED',
            data: { kind: 'agent-unavailable' },
          });
        let models: IProviderCapabilitySet['operations']['models'] = SUPPORTED_PROVIDER_OPERATION;
        try {
          await native.readModels(1);
        } catch {
          models = {
            state: 'unavailable',
            changeMode: null,
            reason: {
              code: 'native-model-catalog-unavailable',
              message: 'The native model catalog is unavailable.',
            },
          };
        }
        return {
          operations: {
            create: SUPPORTED_PROVIDER_OPERATION,
            adopt: SUPPORTED_PROVIDER_OPERATION,
            resume: SUPPORTED_PROVIDER_OPERATION,
            rename: SUPPORTED_PROVIDER_OPERATION,
            close: SUPPORTED_PROVIDER_OPERATION,
            interrupt: SUPPORTED_PROVIDER_OPERATION,
            recover: SUPPORTED_PROVIDER_OPERATION,
            steer: SUPPORTED_PROVIDER_OPERATION,
            history: SUPPORTED_PROVIDER_OPERATION,
            usage: SUPPORTED_PROVIDER_OPERATION,
            skills: SUPPORTED_PROVIDER_OPERATION,
            models,
            fork: SUPPORTED_PROVIDER_OPERATION,
            archive: SUPPORTED_PROVIDER_OPERATION,
            unarchive: SUPPORTED_PROVIDER_OPERATION,
            compact: SUPPORTED_PROVIDER_OPERATION,
            revert: SUPPORTED_PROVIDER_OPERATION,
            configuration: SUPPORTED_PROVIDER_OPERATION,
            account: SUPPORTED_PROVIDER_OPERATION,
            skillsReload: SUPPORTED_PROVIDER_OPERATION,
            mcpReload: SUPPORTED_PROVIDER_OPERATION,
            mcpReconnect: {
              state: 'unsupported',
              changeMode: null,
              reason: {
                code: 'native-control-unsupported',
                message:
                  'The native interface has no qualified structured control for this operation.',
              },
            },
            mcpSetEnabled: {
              state: 'unsupported',
              changeMode: null,
              reason: {
                code: 'native-control-unsupported',
                message:
                  'The native interface has no qualified structured control for this operation.',
              },
            },
            mcpLogin: SUPPORTED_PROVIDER_OPERATION,
            pluginsReload: {
              state: 'unsupported',
              changeMode: null,
              reason: {
                code: 'native-control-unsupported',
                message:
                  'The native interface has no qualified structured control for this operation.',
              },
            },
            accountLogin: SUPPORTED_PROVIDER_OPERATION,
            accountLoginCancel: SUPPORTED_PROVIDER_OPERATION,
            accountLogout: SUPPORTED_PROVIDER_OPERATION,
            agentTools:
              context.agentTools && (!nativeId || native.hasAgentTools(nativeId))
                ? SUPPORTED_PROVIDER_OPERATION
                : {
                    state: 'unknown',
                    changeMode: null,
                    reason: {
                      code: 'native-tools-unobserved',
                      message:
                        'Experimental native tool registration has not been observed for this session.',
                    },
                  },
            mcpServers: SUPPORTED_PROVIDER_OPERATION,
            mcpTools: SUPPORTED_PROVIDER_OPERATION,
            mcpResources: SUPPORTED_PROVIDER_OPERATION,
          },
          inputSchema: {
            ...PROVIDER_INPUT_SCHEMA,
            supportedMediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'text/plain'],
            maxFiles: MAX_INPUT_FILES,
            maxFileBytes: MAX_INPUT_FILE_BYTES,
            maxTextFileBytes: MAX_TEXT_FILE_BYTES,
          },
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
        };
      },
      readHistory,
      readObservedThread: async (nativeId) => (await native.readObservedThread(nativeId)).thread,
      readConfiguration: (command, nativeId, call) =>
        native.readConfiguration(command, nativeId, call.signal),
      forkThread: async (requestId, nativeId) =>
        toProviderThread(await native.forkThread(requestId, nativeId)),
      async archiveThread(requestId, nativeId, call) {
        await native.verifyTerminalsClosed(nativeId);
        if (call.signal.aborted)
          throw new Exception('The Codex integration failed', {
            code: 'JG_AGENT_HQ_CODEX_FAILED',
            data: { kind: 'agent-unavailable' },
          });
        await native.archiveThread(requestId, nativeId);
      },
      unarchiveThread: async (requestId, nativeId) =>
        toProviderThread(await native.unarchiveThread(requestId, nativeId)),
      revertThread: async (requestId, nativeId, beforeTurnId) =>
        toProviderThread(await native.revertThread(requestId, nativeId, beforeTurnId)),
      async compactThread(requestId, nativeId) {
        await native.compactThread(requestId, nativeId);
        return { id: null };
      },
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
      readUsage: () => native.readUsage(),
      readAccount: () => native.readAccount(),
      readLogin: (requestId) => native.readLogin(requestId),
      controlAccount: (requestId, command, loginRequestId) =>
        native.controlAccount(requestId, command, loginRequestId),
      controlExtensions: (requestId, nativeId, workspaceRoot, command) =>
        native.controlExtensions(requestId, nativeId, workspaceRoot, command),
      readMcpServers: (nativeId, limit, cursor) => native.readMcpServers(nativeId, limit, cursor),
      readMcpTools: (nativeId, serverName) => native.readMcpTools(nativeId, serverName),
      readMcpResources: (nativeId, serverName) => native.readMcpResources(nativeId, serverName),
      readSkills: (_nativeId, workspaceRoot) => native.readSkills(workspaceRoot),
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
