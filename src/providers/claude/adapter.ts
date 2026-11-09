import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  SessionSettingsSchema,
  TurnSettingsSchema,
  type IProviderCapability,
  type IProviderCapabilitySet,
} from '../../contracts/index.js';
import type { IStore } from '../../store/index.js';

import {
  buildProviderCapabilities,
  MODEL_CATALOG_UNAVAILABLE,
  SUPPORTED_PROVIDER_OPERATION,
  type IAgentProviderFactory,
} from '../index.js';
import { HQ_ERRORS } from '../../errors/index.js';
import { createClaudeProvider } from './claude.js';
import { CLAUDE_STEER_MEDIA_TYPES, createClaudeControl } from './control/index.js';
import { deleteTranscript } from './history/index.js';

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
    const reader = createClaudeProvider(store, additionalDirectories);
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
        let models: IProviderCapability = SUPPORTED_PROVIDER_OPERATION;
        try {
          await reader.readModels({ kind: 'models', provider: 'claude', limit: 1 });
        } catch {
          models = MODEL_CATALOG_UNAVAILABLE;
        }
        let skills: IProviderCapability = SUPPORTED_PROVIDER_OPERATION;
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
        return buildProviderCapabilities({
          provider: 'claude',
          operations: { models, skills },
          supportedMediaTypes: [
            'image/png',
            'image/jpeg',
            'image/webp',
            'image/gif',
            'application/pdf',
            'text/plain',
          ],
          steerMediaTypes: CLAUDE_STEER_MEDIA_TYPES,
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
        });
      },
      listThreads: (workspaceRoot, page, call) =>
        reader.listThreads(workspaceRoot, page, call.signal),
      async readHistory(command) {
        const response = await reader.readHistory(command);
        const items =
          response.kind === 'items' || response.kind === 'session-evidence'
            ? response.result.data
            : response.kind === 'item-detail' && response.result
              ? [response.result.item]
              : [];
        control.confirmSavedSteers(command.nativeId, command.workspaceRoot, items);
        return response;
      },
      readModels: (command) => reader.readModels(command),
      readConfiguration: (command, nativeId, call) =>
        nativeId
          ? control.readConfiguration(command, nativeId)
          : reader.readConfiguration(command, call.signal),
      async inspectThread(nativeId, workspaceRoot) {
        const response = await reader.readHistory({
          kind: 'thread',
          provider: 'claude',
          nativeId,
          workspaceRoot,
        });
        if (response.kind !== 'thread')
          throw HQ_ERRORS.create('claudeFailed', { data: { kind: 'agent-unavailable' } });
        const available = response.result.historyState === 'available';
        return { thread: response.result, canAdopt: available, canResume: available };
      },
      readUsage: () => reader.readUsage(),
      readSkills: (workspaceRoot, nativeId, call) =>
        nativeId === undefined
          ? reader.readWorkspaceSkills(workspaceRoot, call.signal)
          : control.readSkills(nativeId),
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
        // a first input has no session yet, and Claude accepts every media type HQ does
        if (nativeId) control.validateInput(nativeId, input.settings);
      },
      startTurn: (requestId, nativeId, text, _skill, settings, files, call) =>
        control.startTurn(requestId, nativeId, text, settings, call.signal, files),
      steer: (requestId, nativeId, expectedTurnId, text, files) =>
        control.steer(requestId, nativeId, expectedTurnId, text, files),
      interrupt: (requestId, nativeId, nativeTurnId) =>
        control.interrupt(requestId, nativeId, nativeTurnId),
      cleanThread: (requestId, nativeId) => control.stopSession(requestId, nativeId),
      releaseThread: (requestId, nativeId) => control.releaseSession(requestId, nativeId),
      // a session's files go before its index rows, so no scan indexes them again once forgotten
      async deleteThread(_requestId, nativeId, workspaceRoot) {
        await deleteTranscript(workspaceRoot, nativeId);
        await store.call('claudeHistory', 'forget', nativeId);
      },
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
