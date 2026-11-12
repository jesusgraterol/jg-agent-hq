import { ProviderCapabilitySchema, ProviderIdSchema } from 'jg-agent-hq/contracts';
import { expectToRejectCode } from 'jg-exception/testing';
import { expect, test } from 'vitest';
import { z } from 'zod';

import { HQ_ERRORS } from '../../errors/index.js';
import type { IAgentProviderEvents, IAgentProviderFactory, IControlSource } from '../index.js';

import { createProviderRegistry, type IProviderRegistryEvents } from './index.js';

test.each([
  ['codex', true],
  ['claude', true],
  ['review-provider', false],
  ['Codex', false],
  ['', false],
])('ProviderIdSchema(%s) -> accepted=%s', (provider, accepted) => {
  expect(ProviderIdSchema.safeParse(provider).success).toBe(accepted);
});

test('unsupported and unknown capability observations cannot imply supported control', () => {
  expect(
    ProviderCapabilitySchema.safeParse({ state: 'unknown', changeMode: 'live', reason: null })
      .success,
  ).toBe(false);
  expect(
    ProviderCapabilitySchema.safeParse({ state: 'unsupported', changeMode: null, reason: null })
      .success,
  ).toBe(false);
  expect(
    ProviderCapabilitySchema.parse({
      state: 'supported',
      changeMode: 'idle-restart',
      reason: null,
      futureObservation: { value: true },
    }),
  ).toStrictEqual({ state: 'supported', changeMode: 'idle-restart', reason: null });
});

// typed provider stand-ins exercise registry routing; integration tests establish native group proof
const scopedRegistry = (behavior: { failStop?: boolean; invalidName?: boolean } = {}) => {
  const workspaceRoot = '/workspace';
  const left = {
    nativeId: '11111111-1111-4111-8111-111111111111',
    workspaceRoot,
    scope: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  };
  const right = {
    nativeId: '22222222-2222-4222-8222-222222222222',
    workspaceRoot,
    scope: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  };
  const sources = new Map([
    [left.nativeId, left],
    [right.nativeId, right],
  ]);
  const quarantined = new Set<string>();
  const state = {
    isClosed: false,
    names: [] as string[],
    observedScopes: [] as (string | undefined)[],
    quarantined: [] as IControlSource[],
  };
  let nativeEvents: IAgentProviderEvents | undefined;
  const matches = (source: IControlSource) =>
    sources.get(source.nativeId)?.scope === source.scope &&
    sources.get(source.nativeId)?.workspaceRoot === source.workspaceRoot;
  const unsupported = async (): Promise<never> => {
    throw HQ_ERRORS.create('capabilityUnavailable');
  };
  const factory: IAgentProviderFactory = {
    id: 'claude',
    async create(context) {
      nativeEvents = context.events;
      return {
        state: 'ready',
        version: null,
        get isAvailable() {
          return !state.isClosed;
        },
        getControlSource: (nativeId) => sources.get(nativeId),
        isControlQuarantined: (source) => matches(source) && quarantined.has(source.scope),
        quarantineControl(source) {
          if (!matches(source)) return false;
          if (!quarantined.has(source.scope)) {
            quarantined.add(source.scope);
            state.quarantined.push(source);
            context.events.quarantined(source);
          }
          return true;
        },
        readCapabilities: unsupported,
        readModels: unsupported,
        readConfiguration: unsupported,
        listThreads: unsupported,
        readHistory: unsupported,
        inspectThread: unsupported,
        readUsage: unsupported,
        readSkills: unsupported,
        formatSkill: () => {
          throw HQ_ERRORS.create('capabilityUnavailable');
        },
        startThread: unsupported,
        resumeThread: unsupported,
        nameThread: async (_requestId, nativeId) => {
          if (behavior.invalidName && nativeId === left.nativeId)
            z.object({ id: z.string() }).parse({ id: 42 });
          state.names.push(nativeId);
        },
        validateInput: unsupported,
        startTurn: unsupported,
        steer: unsupported,
        interrupt: unsupported,
        cleanThread: unsupported,
        releaseThread: unsupported,
        deleteThread: unsupported,
        prepareShutdown: unsupported,
        async stopControl(nativeId, call) {
          state.observedScopes.push(call.controlScope);
          if (behavior.failStop && nativeId === left.nativeId)
            throw HQ_ERRORS.create('transportFailed');
          const source = nativeId === undefined ? undefined : sources.get(nativeId);
          if (!source || source.scope !== call.controlScope)
            throw HQ_ERRORS.create('actionConflict');
          return source;
        },
        async close() {
          state.isClosed = true;
        },
      };
    },
  };
  const registry = createProviderRegistry([factory], [workspaceRoot], 'test-runtime');
  return {
    registry,
    left,
    right,
    state,
    async open() {
      const adapter = await registry.get('claude');
      if (!nativeEvents)
        throw new Error('The unit provider did not receive its native event channel');
      return { adapter, native: nativeEvents };
    },
  };
};

const ignoredEvents = (): IProviderRegistryEvents => ({
  observe: () => undefined,
  item: () => undefined,
  gap: () => undefined,
  background: () => undefined,
  delta: () => undefined,
  prompt: () => undefined,
  unpresentable: () => undefined,
  resync: () => undefined,
  outcome: () => undefined,
  session: () => undefined,
  unavailable: () => undefined,
  quarantined: () => undefined,
  quiescent: () => undefined,
});

test('failed scoped Claude cleanup leaves peer operations available and preserves scope proof', async () => {
  const { registry, left, right, state, open } = scopedRegistry({ failStop: true });
  try {
    const { adapter } = await open();
    await expectToRejectCode(
      registry.stopControl('claude', left.nativeId, left.scope),
      'JG_AGENT_HQ_TRANSPORT_FAILED',
    );
    expect(adapter.isAvailable).toBe(true);
    expect(state.isClosed).toBe(false);
    await adapter.nameThread('request', right.nativeId, 'healthy-session');
    expect(state.names).toStrictEqual([right.nativeId]);
    expect(await registry.stopControl('claude', right.nativeId, right.scope)).toStrictEqual(right);
    expect(state.observedScopes).toStrictEqual([left.scope, right.scope]);
  } finally {
    await registry.close();
  }
});

test.each(['callback', 'response'])(
  'an attributable Claude %s failure quarantines only its source and keeps peer callbacks and controls usable',
  async (mode) => {
    const { registry, left, right, state, open } = scopedRegistry({
      invalidName: mode === 'response',
    });
    try {
      const { adapter, native } = await open();
      const gaps: string[] = [];
      registry.setEvents({
        ...ignoredEvents(),
        gap: (_provider, nativeId) => {
          if (mode === 'callback' && nativeId === left.nativeId)
            throw new Error('Invalid normalized native callback');
          gaps.push(nativeId);
        },
      });
      if (mode === 'callback') native.gap(left.nativeId, left);
      else
        await expectToRejectCode(
          adapter.nameThread('request', left.nativeId, 'left'),
          'JG_AGENT_HQ_PROVIDER_FAILED',
        );
      expect(state.quarantined).toStrictEqual([left]);
      expect(state.isClosed).toBe(false);
      expect(adapter.isAvailable).toBe(true);
      native.gap(left.nativeId, left);
      native.gap(right.nativeId, right);
      expect(gaps).toStrictEqual([right.nativeId]);
      await adapter.nameThread('request', right.nativeId, 'healthy');
      expect(state.names).toStrictEqual([right.nativeId]);
    } finally {
      await registry.close();
    }
  },
);

test.each(['scope', 'workspace', 'payload-native'])(
  'Claude %s mismatch never delivers evidence into another source',
  async (mode) => {
    const { registry, left, right, state, open } = scopedRegistry();
    try {
      const { native } = await open();
      const gaps: string[] = [];
      registry.setEvents({
        ...ignoredEvents(),
        gap: (_provider, nativeId) => {
          gaps.push(nativeId);
        },
      });
      if (mode === 'scope') native.gap(left.nativeId, { ...left, scope: right.scope });
      else if (mode === 'workspace')
        native.gap(left.nativeId, { ...left, workspaceRoot: '/other' });
      else native.gap(right.nativeId, left);
      expect(gaps).toStrictEqual([]);
      expect(state.quarantined).toStrictEqual(mode === 'payload-native' ? [left] : []);
      expect(state.isClosed).toBe(false);
      native.gap(right.nativeId, right);
      expect(gaps).toStrictEqual([right.nativeId]);
    } finally {
      await registry.close();
    }
  },
);

test('a source-bound loss without a payload ID stays local to its trusted controller', async () => {
  const { registry, left, state, open } = scopedRegistry();
  try {
    const { native } = await open();
    const losses: (string | undefined)[] = [];
    const observations: unknown[] = [];
    registry.setEvents({
      ...ignoredEvents(),
      unavailable: (_provider, nativeId) => {
        losses.push(nativeId);
      },
      observe: (_provider, observation) => {
        observations.push(observation);
      },
    });
    native.unavailable(undefined, left.scope, left);
    native.observe({ kind: 'native-unavailable', provider: 'codex' }, left);
    expect(losses).toStrictEqual([left.nativeId]);
    expect(observations).toStrictEqual([
      { kind: 'native-unavailable', provider: 'claude', nativeThreadId: left.nativeId },
    ]);
    expect(state.isClosed).toBe(false);
  } finally {
    await registry.close();
  }
});

test('an unattributable registry callback failure retains provider-wide shutdown', async () => {
  const { registry, left, state, open } = scopedRegistry();
  const { native } = await open();
  registry.setEvents({
    ...ignoredEvents(),
    gap: () => {
      throw new Error('Unattributable callback failure');
    },
  });
  native.gap(left.nativeId);
  await registry.close();
  expect(state.isClosed).toBe(true);
  expect(state.quarantined).toStrictEqual([]);
});
