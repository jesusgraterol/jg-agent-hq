import { randomUUID } from 'node:crypto';
import { Exception } from 'jg-exception';

import type { IProviderCapabilitySet } from '../../contracts/index.js';
import type { IStore } from '../../store/index.js';

import {
  PROVIDER_INPUT_SCHEMA,
  SUPPORTED_PROVIDER_OPERATION,
  type IAgentProviderFactory,
} from '../index.js';
import { capabilityUnavailable } from '../registry/index.js';

import { createClaudeProvider } from './claude.js';
import { createClaudeControl } from './control/index.js';

/**
 * Combines native Claude reads and persistent controls behind the provider boundary.
 * @returns A lazy built-in factory that retains normal native settings and subscription auth.
 */
export const createClaudeProviderFactory = (
  store: IStore,
  additionalDirectories: string[],
): IAgentProviderFactory => ({
  id: 'claude',
  async create(context) {
    const reader = createClaudeProvider(store);
    const control = createClaudeControl(additionalDirectories);
    control.setEvents(context.events);
    return {
      get state() {
        return control.state === 'ready'
          ? 'ready'
          : reader.state === 'idle'
            ? control.state
            : reader.state;
      },
      get version() {
        return control.version ?? reader.version;
      },
      get isAvailable() {
        return control.isAvailable;
      },
      async readCapabilities(nativeId): Promise<IProviderCapabilitySet> {
        await reader.ensureReady();
        let skills: IProviderCapabilitySet['operations']['skills'] = SUPPORTED_PROVIDER_OPERATION;
        if (nativeId) {
          try {
            await control.readSkills(nativeId);
          } catch {
            skills = {
              state: 'unavailable',
              changeMode: null,
              reason: {
                code: 'native-catalog-unavailable',
                message: 'The native session skill catalog is unavailable.',
              },
            };
          }
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
            steer: {
              state: 'unsupported',
              changeMode: null,
              reason: {
                code: 'native-control-unsupported',
                message:
                  'The structured Claude interface does not support steering an active turn.',
              },
            },
            history: SUPPORTED_PROVIDER_OPERATION,
            usage: SUPPORTED_PROVIDER_OPERATION,
            skills,
          },
          inputSchema: PROVIDER_INPUT_SCHEMA,
          configurationSchema: null,
        };
      },
      readHistory: (command) => reader.readHistory(command),
      async inspectThread(nativeId, workspaceRoot) {
        const response = await reader.readHistory({
          kind: 'thread',
          provider: 'claude',
          nativeId,
          workspaceRoot,
        });
        if (response.kind !== 'thread')
          throw new Exception('The Claude integration failed', {
            code: 'JG_AGENT_HQ_CLAUDE_FAILED',
            data: { kind: 'agent-unavailable' },
          });
        const available = response.result.historyState === 'available';
        return { thread: response.result, canAdopt: available, canResume: available };
      },
      readUsage: () => reader.readUsage(),
      readSkills: (nativeId) => control.readSkills(nativeId),
      formatSkill: (skill, argumentsText) =>
        `/${skill.name}${argumentsText ? ` ${argumentsText}` : ''}`,
      async startThread(requestId, workspaceRoot) {
        const result = await control.startThread(requestId, workspaceRoot);
        return { nativeId: result.id, workspaceRoot: result.cwd, nativeState: result.status.type };
      },
      async resumeThread(requestId, nativeId, workspaceRoot, name) {
        const result = await control.resumeThread(requestId, nativeId, workspaceRoot, name);
        return { nativeId: result.id, workspaceRoot: result.cwd, nativeState: result.status.type };
      },
      nameThread: (requestId, nativeId, name) => control.nameThread(requestId, nativeId, name),
      startTurn: (requestId, nativeId, text) => control.startTurn(requestId, nativeId, text),
      steer: async () => capabilityUnavailable(),
      interrupt: (requestId, nativeId, nativeTurnId) =>
        control.interrupt(requestId, nativeId, nativeTurnId),
      cleanThread: (requestId, nativeId) => control.stopSession(requestId, nativeId),
      releaseThread: (requestId, nativeId) => control.releaseSession(requestId, nativeId),
      prepareShutdown: (nativeId) =>
        control.stopSession(`${randomUUID()}:shutdown-clean`, nativeId),
      async stopControl(nativeId) {
        if (nativeId) await control.stopSession(`${randomUUID()}:reject`, nativeId);
        else await control.close();
      },
      async close() {
        const results = await Promise.allSettled([reader.close(), control.close()]);
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      },
    };
  },
});
