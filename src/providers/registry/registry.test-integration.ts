import { randomUUID } from 'node:crypto';
import { readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Exception } from 'jg-exception';
import { expectToRejectCode } from 'jg-exception/testing';
import {
  createAgentHq,
  type IAgentProviderContext,
  type IAgentProviderFactory,
  type IAgentProvider,
  type IProviderCapabilitySet,
} from 'jg-agent-hq';
import {
  HqRequestSchema,
  MessageInputSchema,
  type IActionCommand,
  type IThreadSummary,
} from 'jg-agent-hq/contracts';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';

import { withClaudeRuntime, writeFixtureControl } from '../../../scripts/test-support/index.js';
import { nativeProvenance } from '../../sessions/evidence/index.js';

const supported = { state: 'supported', changeMode: 'live', reason: null } as const;
const unsupported = {
  state: 'unsupported',
  changeMode: null,
  reason: {
    code: 'fixture-observation-unsupported',
    message: 'The test provider does not expose this native observation.',
  },
} as const;

/** Models only an external provider; HQ admission, actions, persistence and IPC remain real. */
const createFixtureProvider = () => {
  let context: IAgentProviderContext | undefined;
  let isClosed = false;
  let creations = 0;
  let closes = 0;
  let shouldReturnActive = false;
  let shouldSpoofIdentity = false;
  let shouldFloodEvents = false;
  let stops = 0;
  let names = 0;
  let shouldDeferCreation = false;
  let shouldSendMalformedPrompt = false;
  let shouldFailAvailability = false;
  let pendingCreation: { requestId: string; nativeId: string; workspaceRoot: string } | undefined;
  const threads = new Map<string, IThreadSummary>();
  const inputs: { text: string; skill: { name: string; path: string | null } | null }[] = [];
  const requireThread = (nativeId: string): IThreadSummary => {
    const thread = threads.get(nativeId);
    if (!thread)
      throw new Exception('The HQ capability is unavailable', {
        code: 'JG_AGENT_HQ_CAPABILITY_UNAVAILABLE',
      });
    return thread;
  };
  const capabilities: IProviderCapabilitySet = {
    operations: {
      create: supported,
      adopt: supported,
      resume: supported,
      rename: supported,
      close: supported,
      interrupt: supported,
      recover: supported,
      steer: supported,
      history: supported,
      usage: supported,
      skills: supported,
      models: supported,
      fork: supported,
      archive: supported,
      unarchive: supported,
      compact: supported,
      revert: supported,
      configuration: supported,
      account: unsupported,
      mcpServers: unsupported,
      mcpTools: unsupported,
      mcpResources: unsupported,
      skillsReload: unsupported,
      mcpReload: unsupported,
      mcpReconnect: unsupported,
      mcpSetEnabled: unsupported,
      mcpLogin: unsupported,
      pluginsReload: unsupported,
      accountLogin: unsupported,
      accountLoginCancel: unsupported,
      accountLogout: unsupported,
      agentTools: unsupported,
    },
    inputSchema: z.record(z.string(), z.json()).parse(z.toJSONSchema(MessageInputSchema)),
    configurationSchema: null,
  };
  const factory: IAgentProviderFactory = {
    id: 'review-provider',
    async create(owner) {
      context = owner;
      creations += 1;
      const adapter: IAgentProvider = {
        get state() {
          return isClosed ? 'unavailable' : 'ready';
        },
        version: 'fixture-next-build',
        get isAvailable() {
          if (shouldFailAvailability) throw new TypeError('The provider availability read failed');
          return !isClosed;
        },
        readCapabilities: async () => capabilities,
        // a session another client drives; one asked for as spoofed answers with another identity
        readObservedThread: async (nativeId) => ({
          provider: factory.id,
          nativeId: nativeId === 'spoofed-observed' ? 'another-session' : nativeId,
          nativeLineage: null,
          workspaceRoot: owner.allowedRoots[0]!,
          name: 'Observed elsewhere',
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
          nativeState: 'active',
          state: 'unknown',
          ownership: 'external',
          managedId: null,
          historyState: 'available',
          terminal: null,
        }),
        readLogin: async () => ({
          state: 'unavailable',
          authorizationUrl: null,
          canCancel: false,
          observedAt: null,
        }),
        controlAccount: async () => {
          throw new Error('Unsupported fixture operation');
        },
        controlExtensions: async () => {
          throw new Error('Unsupported fixture operation');
        },
        readAccount: async () => ({
          provider: factory.id,
          state: 'unavailable',
          accountType: null,
          email: null,
          organization: null,
          subscription: null,
          isAuthenticationRequired: null,
          observedAt: null,
          source: 'native',
        }),
        readMcpServers: async () => ({
          state: 'unsupported',
          data: [],
          observedAt: null,
          unavailableCount: 0,
          nextCursor: null,
        }),
        readMcpTools: async () => ({
          state: 'unsupported',
          data: [],
          observedAt: null,
          unavailableCount: 0,
        }),
        readMcpResources: async () => ({
          state: 'unsupported',
          data: [],
          observedAt: null,
          unavailableCount: 0,
        }),
        readConfiguration: async (command, nativeId) => ({
          provider: factory.id,
          nativeId: nativeId ?? null,
          workingDirectory: command.workspaceRoot,
          effective: {
            model: null,
            effort: null,
            nativeAgent: null,
            nativeProfile: null,
            permissionMode: null,
            sandbox: null,
            systemInstructions: null,
            developerInstructions: null,
          },
          instructionSources: { data: [], isComplete: false },
          choices: [],
          nextCursor: null,
          source: 'native',
          observedAt: Date.now(),
        }),
        readModels: async (command) => ({
          provider: factory.id,
          source: 'native',
          observedAt: Date.now(),
          data: [],
          nextCursor: null,
        }),
        async readHistory(command) {
          if (command.kind === 'threads')
            return {
              kind: 'threads',
              result: {
                data: [...threads.values()]
                  .filter((thread) => thread.workspaceRoot === command.workspaceRoot)
                  .slice(0, command.limit),
                nextCursor: null,
                source: 'native',
              },
            };
          const thread = requireThread(command.nativeId);
          if (command.kind === 'thread') return { kind: 'thread', result: { ...thread } };
          if (command.kind === 'turns')
            return { kind: 'turns', result: { data: [], nextCursor: null, source: 'native' } };
          return {
            kind: 'items',
            result: { data: [], nextCursor: null, source: 'native', history: 'persisted' },
          };
        },
        async inspectThread(nativeId) {
          const thread = requireThread(nativeId);
          return {
            thread: { ...thread },
            canAdopt: thread.nativeState === 'notLoaded',
            canResume: thread.nativeState === 'idle',
          };
        },
        readUsage: async () => ({
          provider: factory.id,
          state: 'unavailable',
          source: 'native',
          observedAt: null,
          ordinaryUsageAllowed: null,
          windows: [],
        }),
        readSkills: async () => ({
          skills: [
            {
              name: 'review-design',
              description: 'Review the selected change',
              argumentHint: 'scope',
              kind: 'skill',
              path: null,
              scope: 'fixture',
              isEnabled: true,
              requiresExplicitInvocation: true,
              prerequisites: null,
            },
          ],
          unavailableCount: 0,
          observedAt: 1_900_000_000_000,
        }),
        formatSkill: (skill, argumentsText) => `!${skill.name} ${argumentsText}`.trim(),
        async startThread(requestId, workspaceRoot) {
          const nativeId = 'fixture-session-' + randomUUID();
          threads.set(nativeId, {
            provider: factory.id,
            nativeId,
            nativeLineage: { sessionId: nativeId, parentThreadId: null, forkedFromId: null },
            workspaceRoot,
            name: null,
            createdAt: 1_900_000_000_000,
            updatedAt: 1_900_000_000_000,
            nativeState: 'idle',
            state: 'idle',
            ownership: 'external',
            managedId: null,
            historyState: 'available',
            terminal: null,
          });
          if (shouldDeferCreation) {
            pendingCreation = { requestId, nativeId, workspaceRoot };
            throw new TypeError('The native create acknowledgement was interrupted');
          }
          return {
            nativeId,
            workspaceRoot,
            nativeState: shouldReturnActive ? 'active' : 'idle',
            nativeLineage: { sessionId: nativeId, parentThreadId: null, forkedFromId: null },
          };
        },
        async forkThread(requestId, sourceNativeId, workspaceRoot, call) {
          requireThread(sourceNativeId);
          let created;
          try {
            created = await adapter.startThread(requestId, workspaceRoot, {}, call);
          } catch (cause) {
            if (pendingCreation?.requestId === requestId)
              requireThread(pendingCreation.nativeId).nativeLineage = {
                sessionId: pendingCreation.nativeId,
                parentThreadId: null,
                forkedFromId: sourceNativeId,
              };
            throw cause;
          }
          const nativeLineage = {
            sessionId: created.nativeId,
            parentThreadId: null,
            forkedFromId: sourceNativeId,
          };
          requireThread(created.nativeId).nativeLineage = nativeLineage;
          return { ...created, nativeLineage };
        },
        async archiveThread(_requestId, nativeId) {
          requireThread(nativeId).nativeState = 'notLoaded';
        },
        async unarchiveThread(_requestId, nativeId) {
          const thread = requireThread(nativeId);
          return { ...thread, nativeState: 'notLoaded' };
        },
        async revertThread(_requestId, nativeId) {
          const thread = requireThread(nativeId);
          return { ...thread, nativeState: 'idle' };
        },
        compactThread: (requestId, nativeId, call) =>
          adapter.startTurn(requestId, nativeId, '/compact', null, {}, [], call),
        async resumeThread(_requestId, nativeId, workspaceRoot) {
          requireThread(nativeId).nativeState = 'idle';
          return {
            nativeId,
            workspaceRoot,
            nativeState: 'idle',
            nativeLineage: { sessionId: nativeId, parentThreadId: null, forkedFromId: null },
          };
        },
        async nameThread(_requestId, nativeId, name) {
          names += 1;
          requireThread(nativeId).name = name;
        },
        async validateInput() {},
        async startTurn(_requestId, nativeId, text, skill) {
          inputs.push({ text, skill });
          const turnId = 'fixture-turn-' + randomUUID();
          const provider = shouldSpoofIdentity ? 'another-provider' : factory.id;
          owner.events.observe({
            kind: 'turn-started',
            provider,
            nativeThreadId: nativeId,
            nativeTurnId: turnId,
          });
          if (shouldSendMalformedPrompt) {
            owner.events.prompt({
              provider,
              nativeThreadId: nativeId,
              nativeTurnId: turnId,
              requestId: '',
              fingerprint: 'fixture-prompt',
              presentation: {
                kind: 'permission',
                title: 'Native request',
                detail: 'Fixture permission',
                decisions: ['accept', 'decline'],
                questions: [],
                isBlocking: true,
              },
              validate: (response) => response,
              reply: async () => undefined,
              reject: async () => undefined,
            });
          }
          if (shouldFloodEvents) {
            for (let index = 0; index < 256; index += 1)
              owner.events.item(
                nativeId,
                {
                  nativeId: `fixture-item-${index}`,
                  turnId,
                  kind: 'agent-message',
                  nativeType: 'fixture-output',
                  text: 'Provider result',
                  isTruncated: false,
                  callId: null,
                  outcome: null,
                  files: [],
                  provenance: nativeProvenance('agent-message'),
                },
                true,
              );
          }
          owner.events.item(
            nativeId,
            {
              nativeId: 'fixture-item-' + randomUUID(),
              turnId,
              kind: 'agent-message',
              nativeType: 'fixture-output',
              text: 'Provider result',
              isTruncated: false,
              callId: null,
              outcome: null,
              files: [],
              provenance: nativeProvenance('agent-message'),
            },
            true,
          );
          owner.events.observe({
            kind: 'turn-completed',
            provider,
            nativeThreadId: nativeId,
            nativeTurnId: turnId,
            state: 'completed',
          });
          return { id: turnId };
        },
        steer: async (_requestId, _nativeId, turnId) => turnId,
        interrupt: async () => undefined,
        cleanThread: async () => undefined,
        async releaseThread(_requestId, nativeId) {
          requireThread(nativeId).nativeState = 'notLoaded';
        },
        prepareShutdown: async () => undefined,
        async stopControl() {
          stops += 1;
          owner.events.unavailable();
          isClosed = true;
        },
        async close() {
          closes += 1;
          isClosed = true;
        },
      };
      return adapter;
    },
  };
  return {
    factory,
    inputs,
    get creations() {
      return creations;
    },
    get closes() {
      return closes;
    },
    get stops() {
      return stops;
    },
    get names() {
      return names;
    },
    get context() {
      return context;
    },
    returnActive() {
      shouldReturnActive = true;
    },
    spoofIdentity() {
      shouldSpoofIdentity = true;
    },
    floodEvents() {
      shouldFloodEvents = true;
    },
    malformedPrompt() {
      shouldSendMalformedPrompt = true;
    },
    deferCreation() {
      shouldDeferCreation = true;
    },
    failAvailability() {
      shouldFailAvailability = true;
    },
    completeCreation(requestId?: string) {
      if (!pendingCreation || !context) throw new Error('Missing pending native creation');
      const outcome = {
        kind: 'created' as const,
        requestId: requestId ?? pendingCreation.requestId,
        nativeId: pendingCreation.nativeId,
        actionId: randomUUID(),
        futureMetadata: { label: 'additive callback evidence' },
      };
      context.events.outcome(outcome, {
        nativeId: pendingCreation.nativeId,
        nativeLineage: threads.get(pendingCreation.nativeId)!.nativeLineage,
        workspaceRoot: pendingCreation.workspaceRoot,
        nativeState: 'idle',
      });
    },
    reportIncorrectCreationPhase() {
      if (!pendingCreation || !context) throw new Error('Missing pending native creation');
      context.events.outcome({ kind: 'renamed', requestId: pendingCreation.requestId });
    },
    reportUnavailable() {
      context?.events.unavailable();
    },
    oversizeCapabilities() {
      capabilities.configurationSchema = { description: 'x'.repeat(65_536) };
    },
  };
};

test('a third provider uses public creation, skill input, native completion, close and resume without vendor routing', async () => {
  const provider = createFixtureProvider();
  await withClaudeRuntime(
    async ({ runtime, workspaceRoot, root }) => {
      const status = await runtime.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing status');
      expect(provider.creations).toBe(0);
      expect(await readFile(join(root, 'calls.jsonl'), 'utf8')).toBe('');
      expect(status.result.providers).toContainEqual({
        provider: provider.factory.id,
        state: 'idle',
        version: null,
      });
      const submit = async (command: IActionCommand) => {
        const response = await runtime.request({
          kind: 'action',
          action: { id: randomUUID(), runtimeEpoch: status.result.runtimeEpoch, command },
        });
        if (response.kind !== 'action') throw new Error('Missing action');
        return response.result;
      };
      const created = await submit({
        kind: 'thread-create',
        provider: provider.factory.id,
        workspaceRoot,
        name: 'third-provider',
      });
      const threadId = created.threadId!;
      await expect
        .poll(() => runtime.request({ kind: 'managed-thread', threadId }))
        .toMatchObject({
          kind: 'managed-thread',
          result: { state: 'idle', provider: provider.factory.id },
        });
      const catalog = await runtime.request({ kind: 'skills', threadId });
      if (catalog.kind !== 'skills') throw new Error('Missing skills');
      const skillId = catalog.result.data[0]!.id;
      expect(
        await runtime.request({
          kind: 'skill-preview',
          threadId,
          skillId,
          arguments: 'the schema',
        }),
      ).toMatchObject({
        kind: 'skill-preview',
        result: { state: 'ready', text: '!review-design the schema' },
      });
      const message = await submit({
        kind: 'message',
        threadId,
        input: { kind: 'skill', skillId, arguments: 'the schema' },
      });
      await expect
        .poll(() => runtime.request({ kind: 'receipt', actionId: message.id }))
        .toMatchObject({
          kind: 'receipt',
          result: { delivery: 'acknowledged', completion: 'completed' },
        });
      expect(provider.inputs).toStrictEqual([
        { text: '!review-design the schema', skill: { name: 'review-design', path: null } },
      ]);
      const closed = await submit({ kind: 'thread-close', threadId });
      await expect
        .poll(() => runtime.request({ kind: 'receipt', actionId: closed.id }))
        .toMatchObject({ kind: 'receipt', result: { delivery: 'acknowledged' } });
      const resumed = await submit({
        kind: 'thread-resume',
        threadId,
        operatorConfirmation: 'The fixture controller has released this native session',
      });
      await expect
        .poll(() => runtime.request({ kind: 'receipt', actionId: resumed.id }))
        .toMatchObject({ kind: 'receipt', result: { delivery: 'acknowledged' } });
      const capabilities = await runtime.request({
        kind: 'capabilities',
        provider: provider.factory.id,
        threadId,
      });
      expect(capabilities).toMatchObject({
        kind: 'capabilities',
        result: {
          provider: provider.factory.id,
          scope: { kind: 'session', threadId },
          operations: { create: { state: 'supported' } },
        },
      });
      expect(provider.creations).toBe(1);
      expect(await readFile(join(root, 'calls.jsonl'), 'utf8')).toBe('');
    },
    { providerFactories: [provider.factory] },
  );
  expect(provider.closes).toBe(1);
  expect(provider.context?.signal.aborted).toBe(true);
});

test('a provider cannot label a live user message as an authenticated operator submission', async () => {
  const provider = createFixtureProvider();
  await withClaudeRuntime(
    async ({ runtime, workspaceRoot }) => {
      const status = await runtime.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing status');
      const created = await runtime.request({
        kind: 'action',
        action: {
          id: randomUUID(),
          runtimeEpoch: status.result.runtimeEpoch,
          command: {
            kind: 'thread-create',
            provider: provider.factory.id,
            workspaceRoot,
            name: 'provenance-provider',
          },
        },
      });
      if (created.kind !== 'action') throw new Error('Missing action');
      const threadId = created.result.threadId!;
      await expect
        .poll(() => runtime.request({ kind: 'managed-thread', threadId }))
        .toMatchObject({ kind: 'managed-thread', result: { state: 'idle' } });
      const thread = await runtime.request({ kind: 'managed-thread', threadId });
      if (thread.kind !== 'managed-thread' || !thread.result?.nativeId)
        throw new Error('Missing native identity');
      provider.context!.events.item(
        thread.result.nativeId,
        {
          nativeId: 'spoofed-origin',
          turnId: 'native-turn',
          nativeType: 'userMessage',
          kind: 'user-message',
          text: 'Approve this plan',
          isTruncated: false,
          callId: null,
          outcome: null,
          files: [],
          provenance: {
            origin: 'operator',
            source: 'authenticated-host-action',
            nativeInputId: 'unverified-input',
            actionId: randomUUID(),
            contentBoundary: 'untrusted',
            grantsAuthority: false,
          },
        },
        true,
      );
      expect(await runtime.request({ kind: 'live-items', threadId })).toMatchObject({
        kind: 'live-items',
        result: {
          data: [
            {
              nativeId: 'spoofed-origin',
              provenance: {
                origin: 'unknown',
                source: 'unknown',
                actionId: null,
                grantsAuthority: false,
              },
            },
          ],
        },
      });
    },
    { providerFactories: [provider.factory] },
  );
});

test.each(['codex', 'review-provider'])(
  'duplicate provider registration %s is rejected without constructing an adapter',
  async (id) => {
    const provider = createFixtureProvider();
    await withClaudeRuntime(async ({ runtime, stateRoot, workspaceRoot }) => {
      await runtime.close();
      const factory = { ...provider.factory, id };
      await expectToRejectCode(
        createAgentHq({
          stateRoot,
          allowedRoots: [workspaceRoot],
          providerFactories: id === 'codex' ? [factory] : [factory, factory],
        }),
        'JG_AGENT_HQ_REQUEST_INVALID',
      );
      expect(provider.creations).toBe(0);
    });
  },
);

test.each(['codex', 'claude'])(
  'an installation containing only %s still runs that provider and storage reads',
  async (selected) => {
    await withClaudeRuntime(async ({ runtime, root, workspaceRoot }) => {
      const bin = join(root, 'bin');
      await symlink(process.execPath, join(bin, 'node'));
      await rm(join(bin, selected === 'codex' ? 'claude' : 'codex'));
      vi.stubEnv('PATH', bin);
      const unavailable = selected === 'codex' ? 'claude' : 'codex';
      expect(await runtime.request({ kind: 'capabilities', provider: unavailable })).toMatchObject({
        kind: 'capabilities',
        result: { operations: { create: { state: 'unavailable' } } },
      });
      const status = await runtime.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing status');
      const created = await runtime.request({
        kind: 'action',
        action: {
          id: randomUUID(),
          runtimeEpoch: status.result.runtimeEpoch,
          command: {
            kind: 'thread-create',
            provider: selected,
            workspaceRoot,
            name: 'one-provider',
          },
        },
      });
      if (created.kind !== 'action' || !created.result.threadId) throw new Error('Missing thread');
      await expect
        .poll(() => runtime.request({ kind: 'managed-thread', threadId: created.result.threadId! }))
        .toMatchObject({ kind: 'managed-thread', result: { provider: selected, state: 'idle' } });
      expect(await runtime.request({ kind: 'managed-threads', workspaceRoot })).toMatchObject({
        kind: 'managed-threads',
      });
    });
  },
);

test('third-party initialization errors are normalized and do not disable another provider', async () => {
  const broken: IAgentProviderFactory = {
    id: 'unavailable-provider',
    async create() {
      throw new TypeError('synthetic provider failure');
    },
  };
  await withClaudeRuntime(
    async ({ runtime, workspaceRoot }) => {
      await expectToRejectCode(
        runtime.request({ kind: 'threads', provider: broken.id, workspaceRoot }),
        'JG_AGENT_HQ_PROVIDER_FAILED',
        'The HQ provider integration failed',
      );
      expect(
        await runtime.request({ kind: 'threads', provider: 'codex', workspaceRoot }),
      ).toMatchObject({ kind: 'threads' });
      expect(
        HqRequestSchema.safeParse({ kind: 'status', providerFactories: [broken] }).success,
      ).toBe(false);
    },
    { providerFactories: [broken] },
  );
});

test('a failing provider availability getter cannot escape as an unclassified host error', async () => {
  const provider = createFixtureProvider();
  provider.failAvailability();
  await withClaudeRuntime(
    async ({ runtime, workspaceRoot }) => {
      const status = await runtime.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing status');
      await expectToRejectCode(
        runtime.request({
          kind: 'action',
          action: {
            id: randomUUID(),
            runtimeEpoch: status.result.runtimeEpoch,
            command: {
              kind: 'thread-create',
              provider: provider.factory.id,
              workspaceRoot,
              name: 'availability-failure',
            },
          },
        }),
        'JG_AGENT_HQ_PROVIDER_FAILED',
      );
      expect(
        await runtime.request({ kind: 'threads', provider: 'codex', workspaceRoot }),
      ).toMatchObject({ kind: 'threads' });
    },
    { providerFactories: [provider.factory] },
  );
});

test.each(['spoofed-identity', 'event-overflow', 'malformed-permission-identity'])(
  '%s quarantines the affected provider while another provider remains usable',
  async (mode) => {
    const provider = createFixtureProvider();
    await withClaudeRuntime(
      async ({ runtime, workspaceRoot }) => {
        const status = await runtime.request({ kind: 'status' });
        if (status.kind !== 'status') throw new Error('Missing status');
        const created = await runtime.request({
          kind: 'action',
          action: {
            id: randomUUID(),
            runtimeEpoch: status.result.runtimeEpoch,
            command: {
              kind: 'thread-create',
              provider: provider.factory.id,
              workspaceRoot,
              name: 'quarantine-provider',
            },
          },
        });
        if (created.kind !== 'action') throw new Error('Missing action');
        const threadId = created.result.threadId!;
        await expect
          .poll(() => runtime.request({ kind: 'managed-thread', threadId }))
          .toMatchObject({ kind: 'managed-thread', result: { state: 'idle' } });
        if (mode === 'spoofed-identity') provider.spoofIdentity();
        else if (mode === 'malformed-permission-identity') provider.malformedPrompt();
        else provider.floodEvents();
        const messageId = randomUUID();
        await runtime.request({
          kind: 'action',
          action: {
            id: messageId,
            runtimeEpoch: status.result.runtimeEpoch,
            command: {
              kind: 'message',
              threadId,
              input: { kind: 'text', text: 'Test evidence isolation' },
            },
          },
        });
        // an overflow records unavailability only after its 128 queued events commit with full sync
        await expect
          .poll(() => runtime.request({ kind: 'managed-thread', threadId }), { timeout: 4000 })
          .toMatchObject({
            kind: 'managed-thread',
            result: { state: 'unknown', ownership: 'uncertain' },
          });
        await expect
          .poll(() => runtime.request({ kind: 'receipt', actionId: messageId }))
          .toMatchObject({ kind: 'receipt', result: { delivery: 'uncertain', completion: null } });
        expect(
          await runtime.request({ kind: 'threads', provider: 'codex', workspaceRoot }),
        ).toMatchObject({ kind: 'threads' });
        expect(provider.inputs).toHaveLength(1);
      },
      { providerFactories: [provider.factory] },
    );
    expect(provider.closes).toBe(1);
  },
);

test('late additive acknowledgements use the exact issued request and continue creation only once', async () => {
  const provider = createFixtureProvider();
  provider.deferCreation();
  await withClaudeRuntime(
    async ({ runtime, workspaceRoot }) => {
      const status = await runtime.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing status');
      const id = randomUUID();
      const created = await runtime.request({
        kind: 'action',
        action: {
          id,
          runtimeEpoch: status.result.runtimeEpoch,
          command: {
            kind: 'thread-create',
            provider: provider.factory.id,
            workspaceRoot,
            name: 'late-provider',
          },
        },
      });
      if (created.kind !== 'action') throw new Error('Missing action');
      await expect
        .poll(() => runtime.request({ kind: 'receipt', actionId: id }))
        .toMatchObject({ kind: 'receipt', result: { delivery: 'uncertain' } });
      provider.completeCreation(`${randomUUID()}:create`);
      expect(await runtime.request({ kind: 'receipt', actionId: id })).toMatchObject({
        kind: 'receipt',
        result: { delivery: 'uncertain' },
      });
      expect(provider.names).toBe(0);
      provider.completeCreation();
      await expect
        .poll(() => runtime.request({ kind: 'receipt', actionId: id }))
        .toMatchObject({ kind: 'receipt', result: { delivery: 'acknowledged' } });
      provider.completeCreation();
      expect(
        await runtime.request({ kind: 'managed-thread', threadId: created.result.threadId! }),
      ).toMatchObject({ kind: 'managed-thread', result: { state: 'idle', ownership: 'managed' } });
      expect(provider.names).toBe(1);
    },
    { providerFactories: [provider.factory] },
  );
  expect(provider.names).toBe(1);
});

test('a late fork result keeps the exact child and source without replay or inherited authority', async () => {
  const provider = createFixtureProvider();
  await withClaudeRuntime(
    async ({ runtime, workspaceRoot }) => {
      const status = await runtime.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing runtime');
      const sourceId = randomUUID();
      const source = await runtime.request({
        kind: 'action',
        action: {
          id: sourceId,
          runtimeEpoch: status.result.runtimeEpoch,
          command: {
            kind: 'thread-create',
            provider: provider.factory.id,
            workspaceRoot,
            name: 'fork-parent',
          },
        },
      });
      if (source.kind !== 'action' || !source.result.threadId) throw new Error('Missing source');
      await expect
        .poll(() => runtime.request({ kind: 'receipt', actionId: sourceId }))
        .toMatchObject({ kind: 'receipt', result: { delivery: 'acknowledged' } });
      const parent = await runtime.request({
        kind: 'managed-thread',
        threadId: source.result.threadId,
      });
      if (parent.kind !== 'managed-thread' || !parent.result) throw new Error('Missing parent');
      provider.deferCreation();
      const action = {
        id: randomUUID(),
        runtimeEpoch: status.result.runtimeEpoch,
        command: { kind: 'thread-fork' as const, threadId: parent.result.id, name: 'late-fork' },
      };
      const child = await runtime.request({ kind: 'action', action });
      if (child.kind !== 'action' || !child.result.threadId) throw new Error('Missing child');
      await expect
        .poll(() => runtime.request({ kind: 'receipt', actionId: action.id }))
        .toMatchObject({ kind: 'receipt', result: { delivery: 'uncertain' } });
      const childId = child.result.threadId;
      expect(await runtime.request({ kind: 'managed-thread', threadId: childId })).toMatchObject({
        kind: 'managed-thread',
        result: { nativeId: null, forkedFromThreadId: parent.result.id },
      });
      provider.completeCreation();
      await expect
        .poll(() => runtime.request({ kind: 'receipt', actionId: action.id }))
        .toMatchObject({ kind: 'receipt', result: { delivery: 'acknowledged' } });
      provider.completeCreation();
      expect(await runtime.request({ kind: 'action', action })).toMatchObject({
        kind: 'action',
        result: { threadId: childId, delivery: 'acknowledged' },
      });
      expect(await runtime.request({ kind: 'managed-thread', threadId: childId })).toMatchObject({
        kind: 'managed-thread',
        result: { state: 'idle', nativeLineage: { forkedFromId: parent.result.nativeId } },
      });
      expect(await runtime.request({ kind: 'thread-plan', threadId: childId })).toStrictEqual({
        kind: 'thread-plan',
        result: null,
      });
      expect(provider.names).toBe(2);
    },
    { providerFactories: [provider.factory] },
  );
});

test('an acknowledgement for the wrong native phase cannot settle the action', async () => {
  const provider = createFixtureProvider();
  provider.deferCreation();
  await withClaudeRuntime(
    async ({ runtime, workspaceRoot }) => {
      const status = await runtime.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing status');
      const id = randomUUID();
      const created = await runtime.request({
        kind: 'action',
        action: {
          id,
          runtimeEpoch: status.result.runtimeEpoch,
          command: {
            kind: 'thread-create',
            provider: provider.factory.id,
            workspaceRoot,
            name: 'phase-fence',
          },
        },
      });
      if (created.kind !== 'action') throw new Error('Missing action');
      await expect
        .poll(() => runtime.request({ kind: 'receipt', actionId: id }))
        .toMatchObject({ kind: 'receipt', result: { delivery: 'uncertain' } });
      provider.reportIncorrectCreationPhase();
      await expect
        .poll(() => runtime.request({ kind: 'managed-thread', threadId: created.result.threadId! }))
        .toMatchObject({
          kind: 'managed-thread',
          result: { state: 'unknown', ownership: 'uncertain' },
        });
      expect(await runtime.request({ kind: 'receipt', actionId: id })).toMatchObject({
        kind: 'receipt',
        result: { delivery: 'uncertain' },
      });
      expect(
        await runtime.request({ kind: 'threads', provider: 'codex', workspaceRoot }),
      ).toMatchObject({ kind: 'threads' });
      expect(provider.names).toBe(0);
    },
    { providerFactories: [provider.factory] },
  );
});

test('a reentrant native-unavailable notification coalesces shutdown without losing its confirmation', async () => {
  const provider = createFixtureProvider();
  await withClaudeRuntime(
    async ({ runtime }) => {
      await runtime.request({ kind: 'capabilities', provider: provider.factory.id });
      provider.reportUnavailable();
      await expect.poll(() => provider.stops).toBe(1);
      await runtime.close();
      expect(provider.stops).toBe(1);
    },
    { providerFactories: [provider.factory] },
  );
  expect(provider.closes).toBe(1);
});

test('an unusable optional capability descriptor does not disable ordinary session controls', async () => {
  const provider = createFixtureProvider();
  provider.oversizeCapabilities();
  await withClaudeRuntime(
    async ({ runtime, workspaceRoot }) => {
      expect(
        await runtime.request({ kind: 'capabilities', provider: provider.factory.id }),
      ).toMatchObject({
        kind: 'capabilities',
        result: { operations: { create: { state: 'unavailable' } } },
      });
      const status = await runtime.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing status');
      const created = await runtime.request({
        kind: 'action',
        action: {
          id: randomUUID(),
          runtimeEpoch: status.result.runtimeEpoch,
          command: {
            kind: 'thread-create',
            provider: provider.factory.id,
            workspaceRoot,
            name: 'optional-descriptor',
          },
        },
      });
      if (created.kind !== 'action') throw new Error('Missing action');
      await expect
        .poll(() => runtime.request({ kind: 'managed-thread', threadId: created.result.threadId! }))
        .toMatchObject({ kind: 'managed-thread', result: { state: 'idle' } });
    },
    { providerFactories: [provider.factory] },
  );
});

test('a contradictory native creation state cannot become a managed idle session', async () => {
  const provider = createFixtureProvider();
  provider.returnActive();
  await withClaudeRuntime(
    async ({ runtime, workspaceRoot }) => {
      const status = await runtime.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing status');
      const id = randomUUID();
      const created = await runtime.request({
        kind: 'action',
        action: {
          id,
          runtimeEpoch: status.result.runtimeEpoch,
          command: {
            kind: 'thread-create',
            provider: provider.factory.id,
            workspaceRoot,
            name: 'invalid-creation',
          },
        },
      });
      if (created.kind !== 'action') throw new Error('Missing action');
      await expect
        .poll(() => runtime.request({ kind: 'receipt', actionId: id }))
        .toMatchObject({ kind: 'receipt', result: { delivery: 'uncertain' } });
      expect(
        await runtime.request({ kind: 'managed-thread', threadId: created.result.threadId! }),
      ).toMatchObject({
        kind: 'managed-thread',
        result: { state: 'unknown', ownership: 'uncertain' },
      });
      expect(
        await runtime.request({ kind: 'threads', provider: 'codex', workspaceRoot }),
      ).toMatchObject({ kind: 'threads' });
    },
    { providerFactories: [provider.factory] },
  );
  expect(provider.closes).toBe(1);
});

test.each(['codex', 'claude'])(
  'missing diagnostic version metadata and additive initialization fields do not block %s control',
  async (provider) => {
    await withClaudeRuntime(async ({ runtime, root, workspaceRoot, control }) => {
      if (provider === 'claude')
        await control({ omitVersion: true, futureMetadata: { label: 'compatible extension' } });
      else
        await writeFixtureControl(root, 'control.json', {
          omitVersion: true,
          futureMetadata: { label: 'compatible extension' },
        });
      const status = await runtime.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing status');
      const created = await runtime.request({
        kind: 'action',
        action: {
          id: randomUUID(),
          runtimeEpoch: status.result.runtimeEpoch,
          command: { kind: 'thread-create', provider, workspaceRoot, name: 'version-metadata' },
        },
      });
      if (created.kind !== 'action') throw new Error('Missing action');
      await expect
        .poll(() => runtime.request({ kind: 'managed-thread', threadId: created.result.threadId! }))
        .toMatchObject({ kind: 'managed-thread', result: { state: 'idle' } });
      expect(await runtime.request({ kind: 'status' })).toMatchObject({
        kind: 'status',
        result: {
          providers: expect.arrayContaining([{ provider, state: 'ready', version: null }]),
        },
      });
    });
  },
);

test('a third provider reads its observed sessions for active-sessions, and an answer for another session is left out', async () => {
  const provider = createFixtureProvider();
  await withClaudeRuntime(
    async ({ runtime, workspaceRoot }) => {
      await runtime.request({ kind: 'capabilities', provider: provider.factory.id });
      provider.context!.events.session('observed-session', 'running');
      provider.context!.events.session('spoofed-observed', 'waiting');
      await expect
        .poll(async () => {
          const page = await runtime.request({ kind: 'session-states', limit: 128 });
          return page.kind === 'session-states'
            ? page.result.data.filter((transition) => transition.provider === provider.factory.id)
                .length
            : 0;
        })
        .toBe(2);
      const active = await runtime.request({ kind: 'active-sessions' });
      if (active.kind !== 'active-sessions') throw new Error('Missing active sessions');
      expect(active.result).toStrictEqual({
        data: [
          {
            provider: provider.factory.id,
            nativeId: 'observed-session',
            nativeLineage: null,
            workspaceRoot,
            name: 'Observed elsewhere',
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
            nativeState: 'active',
            state: 'running',
            ownership: 'external',
            managedId: null,
            historyState: 'available',
            terminal: null,
          },
        ],
        isTruncated: false,
      });
    },
    { providerFactories: [provider.factory] },
  );
});
