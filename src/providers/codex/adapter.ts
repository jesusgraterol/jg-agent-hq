import { randomUUID } from 'node:crypto';
import { Exception } from 'jg-exception';

import type { IProviderCapabilitySet } from '../../contracts/index.js';
import { resolveWorkspaceTarget } from '../../runtime/state/index.js';
import { decodeHistoryCursor, encodeHistoryCursor } from '../../sessions/index.js';
import type { IHistoryRequest } from '../../sessions/index.js';

import {
  PROVIDER_INPUT_SCHEMA,
  SUPPORTED_PROVIDER_OPERATION,
  type IAgentProviderFactory,
} from '../index.js';

import { createCodexProvider } from './codex.js';
import { createCodexEvents, toProviderThread } from './events.js';

/**
 * Describes current Codex controls and lazily owns their native app-server connection.
 * @returns A built-in factory that preserves native settings, authentication and permission policy.
 */
export const createCodexProviderFactory = (extraSkillRoots: string[]): IAgentProviderFactory => ({
  id: 'codex',
  async create(context) {
    const native = await createCodexProvider(extraSkillRoots);
    native.setEvents(createCodexEvents(native, context.events));
    const verifyRoot = async (workspaceRoot: string, expectedRoot: string): Promise<void> => {
      if ((await resolveWorkspaceTarget(workspaceRoot, context.allowedRoots)) !== expectedRoot)
        throw new Exception('The HQ target is outside the allowed workspaces', {
          code: 'JG_AGENT_HQ_TARGET_FORBIDDEN',
          data: { kind: 'access-denied' },
        });
    };
    const readHistory = async (command: IHistoryRequest) => {
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
          throw new Exception('The Codex integration failed', {
            code: 'JG_AGENT_HQ_CODEX_FAILED',
            data: { kind: 'agent-unavailable' },
          });
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
          },
          inputSchema: PROVIDER_INPUT_SCHEMA,
          configurationSchema: null,
        };
      },
      readHistory,
      async inspectThread(nativeId, workspaceRoot) {
        const thread = await native.readThread(nativeId);
        await verifyRoot(thread.workspaceRoot, workspaceRoot);
        return {
          thread,
          canAdopt: thread.nativeState === 'notLoaded',
          canResume: thread.nativeState === 'idle',
        };
      },
      readUsage: () => native.readUsage(),
      readSkills: (_nativeId, workspaceRoot) => native.readSkills(workspaceRoot),
      formatSkill: (skill, argumentsText) =>
        `$${skill.name}${argumentsText ? ` ${argumentsText}` : ''}`,
      startThread: async (requestId, workspaceRoot) =>
        toProviderThread(await native.startThread(requestId, workspaceRoot)),
      resumeThread: async (requestId, nativeId) =>
        toProviderThread(await native.resumeThread(requestId, nativeId)),
      nameThread: (requestId, nativeId, name) => native.nameThread(requestId, nativeId, name),
      startTurn: (requestId, nativeId, text, skill) =>
        native.startTurn(requestId, nativeId, text, skill),
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
      stopControl: () => native.close(),
      close: () => native.close(),
    };
  },
});
