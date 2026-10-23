import { randomUUID } from 'node:crypto';
import { Exception } from 'jg-exception';
import { z } from 'zod';

import {
  SessionSettingsSchema,
  MAX_INPUT_FILES,
  MAX_INPUT_FILE_BYTES,
  MAX_TEXT_FILE_BYTES,
  TurnSettingsSchema,
  type IProviderCapabilitySet,
} from '../../contracts/index.js';
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
        let models: IProviderCapabilitySet['operations']['models'] = SUPPORTED_PROVIDER_OPERATION;
        try {
          await reader.readModels({ kind: 'models', provider: 'claude', limit: 1 });
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
            models,
            fork: SUPPORTED_PROVIDER_OPERATION,
            compact: SUPPORTED_PROVIDER_OPERATION,
            configuration: SUPPORTED_PROVIDER_OPERATION,
            archive: {
              state: 'unsupported',
              changeMode: null,
              reason: {
                code: 'native-control-unsupported',
                message: 'The structured Claude interface has no native archive operation.',
              },
            },
            unarchive: {
              state: 'unsupported',
              changeMode: null,
              reason: {
                code: 'native-control-unsupported',
                message: 'The structured Claude interface has no native unarchive operation.',
              },
            },
            revert: {
              state: 'unsupported',
              changeMode: null,
              reason: {
                code: 'native-control-unsupported',
                message:
                  'The structured Claude interface has no supported conversation-revert control.',
              },
            },
            skills,
          },
          inputSchema: {
            ...PROVIDER_INPUT_SCHEMA,
            supportedMediaTypes: [
              'image/png',
              'image/jpeg',
              'image/webp',
              'image/gif',
              'application/pdf',
              'text/plain',
            ],
            maxFiles: MAX_INPUT_FILES,
            maxFileBytes: MAX_INPUT_FILE_BYTES,
            maxTextFileBytes: MAX_TEXT_FILE_BYTES,
          },
          configurationSchema: {
            session: z.json().parse(z.toJSONSchema(SessionSettingsSchema.omit({ sandbox: true }))),
            turn: z.json().parse(z.toJSONSchema(TurnSettingsSchema.omit({ outputSchema: true }))),
            sessionChangeMode: 'idle-restart',
            turnChangeMode: 'live',
            outputSchemaChangeMode: 'idle-restart',
            permissionModes: [
              'default',
              'acceptEdits',
              'auto',
              'bypassPermissions',
              'dontAsk',
              'plan',
            ],
          },
        };
      },
      readHistory: (command) => reader.readHistory(command),
      readModels: (command) => reader.readModels(command),
      readConfiguration: (command, nativeId, call) =>
        nativeId
          ? control.readConfiguration(command, nativeId)
          : reader.readConfiguration(command, call.signal),
      archiveThread: async () => capabilityUnavailable(),
      unarchiveThread: async () => capabilityUnavailable(),
      revertThread: async () => capabilityUnavailable(),
      compactThread: (requestId, nativeId, call) =>
        control.startTurn(requestId, nativeId, '/compact', {}, call.signal),
      async forkThread(requestId, nativeId, workspaceRoot, call) {
        const result = await control.forkThread(requestId, nativeId, workspaceRoot, call.signal);
        return {
          nativeId: result.id,
          workspaceRoot: result.cwd,
          nativeState: result.status.type,
          nativeLineage: {
            sessionId: result.id,
            parentThreadId: null,
            forkedFromId: result.forkedFromId,
          },
        };
      },
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
      async startThread(requestId, workspaceRoot, settings, call) {
        const result = await control.startThread(requestId, workspaceRoot, settings, call.signal);
        return {
          nativeId: result.id,
          workspaceRoot: result.cwd,
          nativeState: result.status.type,
          nativeLineage: { sessionId: result.id, parentThreadId: null, forkedFromId: null },
        };
      },
      async resumeThread(requestId, nativeId, workspaceRoot, name, settings, call) {
        const result = await control.resumeThread(
          requestId,
          nativeId,
          workspaceRoot,
          name,
          settings,
          call.signal,
        );
        return {
          nativeId: result.id,
          workspaceRoot: result.cwd,
          nativeState: result.status.type,
          nativeLineage: { sessionId: result.id, parentThreadId: null, forkedFromId: null },
        };
      },
      nameThread: (requestId, nativeId, name) => control.nameThread(requestId, nativeId, name),
      async validateInput(nativeId, input) {
        control.validateInput(nativeId, input.settings);
      },
      startTurn: (requestId, nativeId, text, _skill, settings, files, call) =>
        control.startTurn(requestId, nativeId, text, settings, call.signal, files),
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
