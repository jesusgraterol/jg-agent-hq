import { ProviderCapabilitySchema, ProviderIdSchema } from 'jg-agent-hq/contracts';
import { expectToRejectCode } from 'jg-exception/testing';
import { expect, test } from 'vitest';

import { HQ_ERRORS } from '../../errors/index.js';
import type { IAgentProviderFactory } from '../index.js';

import { createProviderRegistry } from './index.js';

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

test('failed scoped Claude cleanup leaves peer operations available and preserves scope proof', async () => {
  const failedId = '11111111-1111-4111-8111-111111111111';
  const healthyId = '22222222-2222-4222-8222-222222222222';
  const scope = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const workspaceRoot = '/workspace';
  let isClosed = false;
  let hasRenamed = false;
  const observedScopes: (string | undefined)[] = [];
  const unsupported = async (): Promise<never> => {
    throw HQ_ERRORS.create('capabilityUnavailable');
  };
  const factory: IAgentProviderFactory = {
    id: 'claude',
    async create() {
      return {
        state: 'ready',
        version: null,
        isAvailable: true,
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
        nameThread: async () => {
          hasRenamed = true;
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
          observedScopes.push(call.controlScope);
          if (nativeId === failedId) throw HQ_ERRORS.create('transportFailed');
          if (nativeId === undefined || call.controlScope === undefined) return unsupported();
          return { nativeId, workspaceRoot, scope: call.controlScope };
        },
        async close() {
          isClosed = true;
        },
      };
    },
  };
  const registry = createProviderRegistry([factory], [workspaceRoot], 'test-runtime');
  try {
    const adapter = await registry.get('claude');
    await expectToRejectCode(
      registry.stopControl('claude', failedId, scope),
      'JG_AGENT_HQ_TRANSPORT_FAILED',
    );
    expect(adapter.isAvailable).toBe(true);
    expect(isClosed).toBe(false);
    await adapter.nameThread('request', healthyId, 'healthy-session');
    expect(hasRenamed).toBe(true);
    expect(await registry.stopControl('claude', healthyId, scope)).toStrictEqual({
      nativeId: healthyId,
      workspaceRoot,
      scope,
    });
    expect(observedScopes).toStrictEqual([scope, scope]);
  } finally {
    await registry.close();
  }
});
