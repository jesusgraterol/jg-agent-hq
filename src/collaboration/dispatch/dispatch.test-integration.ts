import { randomUUID, createHash } from 'node:crypto';
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expectToRejectCode } from 'jg-exception/testing';
import { createAgentHq } from 'jg-agent-hq';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import type { IDispatchResponse, IRequestSpecification } from 'jg-agent-hq/contracts';

import {
  countHeldDelays,
  releaseHeldDelays,
  startHoldingDelays,
  withCollaboration,
  writeFixtureControl,
  type ICollaborationFixture,
} from '../../../scripts/test-support/index.js';

// every case starts native processes and collects state through IPC and SQLite
vi.setConfig({ expect: { poll: { timeout: 30_000 } } });

// a Claude agent's 60-minute idle period is released by the test that needs it
vi.mock('jg-utilities', async (original) => {
  const actual = await original<typeof import('jg-utilities')>();
  const { holdDelays } = await import('../../../scripts/test-support/delays.js');
  return { ...actual, delay: holdDelays(actual.delay) };
});
startHoldingDelays(3_600);

const readRequest = async (fixture: ICollaborationFixture, requestId: string) => {
  const response = await fixture.call({ kind: 'request-read', taskId: fixture.taskId, requestId });
  if (response.kind !== 'request') throw new Error('Missing request');
  return response.request;
};

const publish = async (
  fixture: ICollaborationFixture,
  requestId: string,
  agentId: string,
  effects: ('read' | 'pause')[] = ['read'],
  actor = fixture.host,
  selection: Partial<IRequestSpecification> = {},
) => {
  await fixture.call(
    {
      kind: 'message-publish',
      id: requestId,
      taskId: fixture.taskId,
      streamId: fixture.streamId,
      messageKind: 'request',
      summary: 'Inspect an exact invariant',
      body: 'Return your findings without changing files.',
      references: [],
      replyToMessageId: null,
      request: {
        targetAgentId: agentId,
        claimable: false,
        skill: null,
        grantId: null,
        grantRevision: null,
        arguments: 'Inspect the invariant.',
        effects,
        scopes: [{ workspaceRoot: fixture.native.workspaceRoot, pathPrefixes: [''] }],
        plan: null,
        targetReferences: [],
        ...selection,
      },
    },
    actor,
  );
};

const dispatch = (fixture: ICollaborationFixture, requestId: string) =>
  fixture.call({ kind: 'request-dispatch', id: randomUUID(), taskId: fixture.taskId, requestId });

const finishNative = async (
  fixture: ICollaborationFixture,
  agentId: string,
  response: IDispatchResponse,
) => {
  const thread = await fixture.native.request({ kind: 'managed-thread', threadId: agentId });
  if (thread.kind !== 'managed-thread' || !thread.result?.nativeId || !thread.result.activeTurnId)
    throw new Error('Missing active native turn');
  const { provider, nativeId, activeTurnId } = thread.result;
  const catalog = z
    .object({ skillNames: z.array(z.string()).optional() })
    .parse(
      JSON.parse(
        await readFile(
          join(fixture.native.root, provider === 'claude' ? 'claude-control.json' : 'control.json'),
          'utf8',
        ),
      ),
    );

  if (provider === 'claude') {
    await writeFixtureControl(fixture.native.root, 'claude-control.json', {
      holdTurn: true,
      release: true,
      releaseOnce: true,
      skillNames: catalog.skillNames,
      structuredOutput: response,
    });
  } else {
    await writeFixtureControl(fixture.native.root, 'control.json', {
      holdTurn: true,
      emitOnce: true,
      skillNames: catalog.skillNames,
      emit: [
        {
          method: 'item/completed',
          params: {
            threadId: nativeId,
            turnId: activeTurnId,
            item: {
              id: `final-${activeTurnId}`,
              type: 'agentMessage',
              text: JSON.stringify(response),
            },
          },
        },
        {
          method: 'turn/completed',
          params: { threadId: nativeId, turn: { id: activeTurnId, status: 'completed' } },
        },
      ],
    });
    await fixture.native.request({ kind: 'skills', threadId: agentId });
  }
};

const parentOutcome = (
  requestId: string,
  outcome: IDispatchResponse['outcome'],
  children: string[] = [],
  requiredAuthority: IDispatchResponse['requiredAuthority'] = null,
): IDispatchResponse => ({
  requestId,
  outcome,
  childRequestIds: children,
  requiredAuthority,
  report: `Exact ${outcome} report for ${requestId}.`,
});

const publishChild = (
  fixture: ICollaborationFixture,
  parentId: string,
  childId: string,
  parentAgentId: string,
  targetAgentId: string,
) =>
  fixture.call(
    {
      kind: 'message-publish',
      id: childId,
      taskId: fixture.taskId,
      streamId: fixture.streamId,
      messageKind: 'request',
      summary: 'Review the parent work',
      body: 'Return exact findings.',
      references: [],
      replyToMessageId: null,
      parentRequestId: parentId,
      request: {
        targetAgentId,
        claimable: false,
        skill: null,
        grantId: null,
        grantRevision: null,
        arguments: 'Review the parent work.',
        effects: ['read'],
        scopes: [{ workspaceRoot: fixture.native.workspaceRoot, pathPrefixes: [''] }],
        plan: null,
        targetReferences: [],
      },
    },
    { kind: 'agent', agentId: parentAgentId },
  );

const startParent = async (fixture: ICollaborationFixture, parentId: string, agentId: string) => {
  await writeFixtureControl(fixture.native.root, 'control.json', { holdTurn: true });
  await writeFixtureControl(fixture.native.root, 'claude-control.json', { holdTurn: true });
  await fixture.call({
    kind: 'task-policy-set',
    id: randomUUID(),
    taskId: fixture.taskId,
    expectedRevision: 1,
    policy: { ...fixture.policy, automaticDispatch: true },
  });
  await publish(fixture, parentId, agentId);
  await expect
    .poll(async () => (await readRequest(fixture, parentId)).currentActionId)
    .toBe(parentId);
  await expect
    .poll(async () => {
      const receipt = await fixture.native.request({ kind: 'receipt', actionId: parentId });
      return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
    })
    .toBe('acknowledged');
};

test.each(['codex', 'claude'] as const)(
  'directed %s completion stores an exact report without a publishing turn',
  async (provider) =>
    withCollaboration(async (fixture) => {
      const requestId = randomUUID();
      const report = '# Findings\n\nNo mutation was needed.\n';
      const response = {
        requestId,
        outcome: 'completed',
        report,
        childRequestIds: [],
        requiredAuthority: null,
      };
      await writeFixtureControl(
        fixture.native.root,
        provider === 'codex' ? 'control.json' : 'claude-control.json',
        { structuredOutput: response, autoComplete: true },
      );
      await publish(fixture, requestId, fixture.agentIds[provider === 'codex' ? 0 : 1]!);
      expect((await readRequest(fixture, requestId)).dispatchCount).toBe(0);
      await dispatch(fixture, requestId);
      await expect.poll(async () => (await readRequest(fixture, requestId)).state).toBe('resolved');
      const request = await readRequest(fixture, requestId);
      const delivered = await fixture.call({
        kind: 'deliveries-list',
        taskId: fixture.taskId,
        recipientAgentId: request.assigneeAgentId!,
        state: 'all',
      });
      expect(
        delivered.kind === 'deliveries' &&
          delivered.data.find((entry) => entry.messageId === requestId),
      ).toMatchObject({
        nativeActionId: request.lastActionId,
        deliveredAt: expect.any(Number),
        acknowledgedAt: null,
      });
      expect(request).toMatchObject({
        outcome: 'completed',
        dispatchCount: 1,
        currentActionId: null,
        pendingActionId: null,
        failureReason: null,
      });
      const stored = await fixture.call({
        kind: 'report-read',
        taskId: fixture.taskId,
        reportId: request.lastReportId!,
      });
      expect(stored).toMatchObject({
        kind: 'report',
        result: {
          text: report,
          offsetBytes: 0,
          isComplete: true,
          nextCursor: null,
          report: {
            requestId,
            actionId: request.lastActionId,
            authorAgentId: request.assigneeAgentId,
            provider,
            byteCount: Buffer.byteLength(report),
            sha256: createHash('sha256').update(report).digest('hex'),
          },
        },
      });
      const collected = await fixture.call({
        kind: 'request-collect',
        id: randomUUID(),
        taskId: fixture.taskId,
        requestId,
        actionId: request.lastActionId!,
      });
      expect(collected.kind === 'operation' && collected.operation?.result).toMatchObject({
        kind: 'collection',
        collection: { state: 'resolved', actionId: request.lastActionId },
      });
      const calls = (
        await readFile(
          join(fixture.native.root, provider === 'codex' ? 'calls.jsonl' : 'claude-calls.jsonl'),
          'utf8',
        )
      )
        .trim()
        .split('\n')
        .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
      expect(
        calls.filter((call) =>
          provider === 'codex' ? call.method === 'turn/start' : call.type === 'user',
        ),
      ).toHaveLength(1);
    }),
);

test('operator input requires the exact checkpoint and resumes only that request', async () =>
  withCollaboration(async (fixture) => {
    const requestId = randomUUID();
    await writeFixtureControl(fixture.native.root, 'control.json', {
      structuredOutput: {
        requestId,
        outcome: 'needs-input',
        report: 'Choose the accepted scope.',
        childRequestIds: [],
        requiredAuthority: 'operator',
      },
    });
    await publish(fixture, requestId, fixture.agentIds[0]!);
    await dispatch(fixture, requestId);
    await expect
      .poll(async () => (await readRequest(fixture, requestId)).state)
      .toBe('waiting-input');
    const waiting = await readRequest(fixture, requestId);
    expect(waiting).toMatchObject({
      outcome: null,
      childRequestIds: [],
      requiredAuthority: 'operator',
      currentActionId: null,
      dispatchCount: 1,
    });
    const answer = {
      kind: 'request-input' as const,
      id: randomUUID(),
      taskId: fixture.taskId,
      requestId,
      expectedActionId: waiting.lastActionId!,
      body: 'Use the selected scope.',
    };
    await expectToRejectCode(
      fixture.call(answer, { kind: 'agent', agentId: fixture.agentIds[1]! }),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
    await expectToRejectCode(
      fixture.call({ ...answer, expectedActionId: randomUUID() }),
      'JG_AGENT_HQ_COLLABORATION_CONFLICT',
    );
    await writeFixtureControl(fixture.native.root, 'control.json', {
      structuredOutput: {
        requestId,
        outcome: 'completed',
        report: 'Finished within the selected scope.',
        childRequestIds: [],
        requiredAuthority: null,
      },
    });
    const accepted = await fixture.call(answer);
    expect(await fixture.call(answer)).toStrictEqual(accepted);
    await expect.poll(async () => (await readRequest(fixture, requestId)).state).toBe('resolved');
    const completed = await readRequest(fixture, requestId);
    expect(completed).toMatchObject({
      dispatchCount: 2,
      outcome: 'completed',
      childRequestIds: [],
      requiredAuthority: null,
      lastActionId: answer.id,
    });
    expect(completed.lastReportId).not.toBe(waiting.lastReportId);
  }));

test('a paused outcome requires its selected effect and explicit current-revision resumption', async () =>
  withCollaboration(async (fixture) => {
    const requestId = randomUUID();
    await writeFixtureControl(fixture.native.root, 'claude-control.json', {
      structuredOutput: {
        requestId,
        outcome: 'paused',
        report: 'Paused at the requested checkpoint.',
        childRequestIds: [],
        requiredAuthority: null,
      },
    });
    await publish(fixture, requestId, fixture.agentIds[1]!, ['read', 'pause']);
    await dispatch(fixture, requestId);
    await expect
      .poll(async () => (await readRequest(fixture, requestId)).state)
      .toBe('interrupted');
    const paused = await readRequest(fixture, requestId);
    expect(paused).toMatchObject({
      pauseAgentRevision: 2,
      outcome: null,
      failureReason: null,
      dispatchCount: 1,
    });
    await expectToRejectCode(
      fixture.call({
        kind: 'request-resume',
        id: randomUUID(),
        taskId: fixture.taskId,
        requestId,
        expectedActionId: paused.lastActionId!,
        expectedAgentRevision: 1,
        expectedTaskRevision: 1,
        body: 'Continue.',
      }),
      'JG_AGENT_HQ_COLLABORATION_CONFLICT',
    );
    await writeFixtureControl(fixture.native.root, 'claude-control.json', {
      structuredOutput: {
        requestId,
        outcome: 'completed',
        report: 'Resumed explicitly.',
        childRequestIds: [],
        requiredAuthority: null,
      },
    });
    await fixture.call({
      kind: 'request-resume',
      id: randomUUID(),
      taskId: fixture.taskId,
      requestId,
      expectedActionId: paused.lastActionId!,
      expectedAgentRevision: paused.pauseAgentRevision!,
      expectedTaskRevision: 1,
      body: 'Continue.',
    });
    await expect.poll(async () => (await readRequest(fixture, requestId)).state).toBe('resolved');
    expect(await readRequest(fixture, requestId)).toMatchObject({
      outcome: 'completed',
      dispatchCount: 2,
    });
  }));

test.each([
  [
    'wrong-request',
    () => ({
      requestId: randomUUID(),
      outcome: 'completed',
      report: 'Wrong binding',
      childRequestIds: [],
      requiredAuthority: null,
    }),
  ],
  [
    'invalid-response',
    (requestId: string) => ({
      requestId,
      outcome: 'completed',
      report: 'Wrong authority',
      childRequestIds: [],
      requiredAuthority: 'operator',
    }),
  ],
  ['invalid-response', () => ({ invented: 'completion' })],
  [
    'report-too-large',
    (requestId: string) => ({
      requestId,
      outcome: 'completed',
      report: 'x'.repeat(1_048_577),
      childRequestIds: [],
      requiredAuthority: null,
    }),
  ],
  [
    'report-invalid-utf8',
    (requestId: string) => ({
      requestId,
      outcome: 'completed',
      report: '\ud800',
      childRequestIds: [],
      requiredAuthority: null,
    }),
  ],
] as const)(
  'invalid native completion records %s without an assignee success',
  async (failureReason, envelope) =>
    withCollaboration(async (fixture) => {
      const requestId = randomUUID();
      await writeFixtureControl(fixture.native.root, 'control.json', {
        structuredOutput: envelope(requestId),
      });
      await publish(fixture, requestId, fixture.agentIds[0]!);
      await dispatch(fixture, requestId);
      await expect.poll(async () => (await readRequest(fixture, requestId)).state).toBe('resolved');
      expect(await readRequest(fixture, requestId)).toMatchObject({
        outcome: 'failed',
        failureReason,
        lastReportId: null,
        dispatchCount: 1,
      });
      const replies = await fixture.call({ kind: 'messages-list', taskId: fixture.taskId });
      expect(replies.kind === 'messages' && replies.data[0]).toMatchObject({
        author: { kind: 'runtime' },
        kind: 'reply',
      });
    }),
);

test('failed collection rolls back the report, reply and resolution and recovers from saved native output', async () =>
  withCollaboration(async (fixture) => {
    await fixture.native.runtime.withStorageMaintenance(async ({ databasePath }) => {
      const database = new DatabaseSync(databasePath);
      try {
        database.exec(
          "CREATE TRIGGER fixture_fail_report BEFORE INSERT ON hq_report BEGIN SELECT RAISE(ABORT, 'Injected report failure'); END",
        );
      } finally {
        database.close();
      }
    });
    const requestId = randomUUID();
    await writeFixtureControl(fixture.native.root, 'control.json', {
      structuredOutput: {
        requestId,
        outcome: 'completed',
        report: 'Durable native findings.',
        childRequestIds: [],
        requiredAuthority: null,
      },
    });
    await publish(fixture, requestId, fixture.agentIds[0]!);
    await dispatch(fixture, requestId);
    await expect
      .poll(async () => {
        const status = await fixture.call({ kind: 'status', taskId: fixture.taskId });
        return status.kind === 'status' ? status.status.dispatchFailure : null;
      })
      .toBe('JG_AGENT_HQ_STORE_FAILED');
    expect(await readRequest(fixture, requestId)).toMatchObject({
      state: 'claimed',
      currentActionId: requestId,
      lastReportId: null,
    });
    const before = await fixture.call({ kind: 'messages-list', taskId: fixture.taskId });
    expect(before.kind === 'messages' && before.data).toHaveLength(1);
    const nativeStatus = await fixture.native.request({ kind: 'status' });
    if (nativeStatus.kind !== 'status') throw new Error('Missing native epoch');
    const competing = await fixture.native.request({
      kind: 'action',
      action: {
        id: randomUUID(),
        runtimeEpoch: nativeStatus.result.runtimeEpoch,
        command: {
          kind: 'message',
          threadId: fixture.agentIds[0]!,
          input: { kind: 'text', text: 'This input must wait for outcome collection.' },
        },
      },
    });
    expect(competing.kind === 'action' && competing.result).toMatchObject({
      delivery: 'failed',
      failure: 'state-conflict',
    });
    await fixture.native.runtime.withStorageMaintenance(async ({ databasePath }) => {
      const database = new DatabaseSync(databasePath);
      try {
        database.exec('DROP TRIGGER fixture_fail_report');
      } finally {
        database.close();
      }
    });
    await fixture.call({ kind: 'fanout-recover', id: randomUUID(), taskId: fixture.taskId });
    await expect.poll(async () => (await readRequest(fixture, requestId)).state).toBe('resolved');
    expect(await readRequest(fixture, requestId)).toMatchObject({
      dispatchCount: 1,
      outcome: 'completed',
      lastReportId: requestId,
    });
  }));

test('a maximum-size report is indexed and read exactly without native transcripts', async () =>
  withCollaboration(async (fixture) => {
    const requestId = randomUUID();
    const prefix = `${'Heading 😀\n'.repeat(32_768)}needle-in-report-only\n`;
    const report = prefix + 'x'.repeat(1_048_576 - Buffer.byteLength(prefix));
    await writeFixtureControl(fixture.native.root, 'claude-control.json', {
      structuredOutput: {
        requestId,
        outcome: 'completed',
        report,
        childRequestIds: [],
        requiredAuthority: null,
      },
      autoComplete: true,
    });
    await publish(fixture, requestId, fixture.agentIds[1]!);
    await dispatch(fixture, requestId);
    await expect.poll(async () => (await readRequest(fixture, requestId)).state).toBe('resolved');
    const request = await readRequest(fixture, requestId);
    expect(request.failureReason).toBeNull();
    const native = await fixture.native.request({
      kind: 'managed-thread',
      threadId: fixture.agentIds[1]!,
    });
    if (native.kind !== 'managed-thread' || !native.result?.nativeId)
      throw new Error('Missing native identity');
    await rm(fixture.native.transcript(native.result.nativeId));
    const search = await fixture.call({
      kind: 'messages-search',
      taskId: fixture.taskId,
      query: 'needle-in-report-only',
    });
    expect(search.kind === 'messages' && search.data).toMatchObject([
      {
        reportMatch: {
          reportId: request.lastReportId,
          excerpt: expect.stringContaining('needle-in-report-only'),
        },
      },
    ]);
    let cursor: string | undefined;
    let text = '';
    do {
      const chunk = await fixture.call({
        kind: 'report-read',
        taskId: fixture.taskId,
        reportId: request.lastReportId!,
        ...(cursor ? { cursor } : {}),
      });
      if (chunk.kind !== 'report') throw new Error('Missing report chunk');
      if (text.length === 0 && chunk.result.nextCursor !== null) {
        const token = z
          .object({ version: z.number(), filterHash: z.string(), nativeCursor: z.string() })
          .parse(JSON.parse(Buffer.from(chunk.result.nextCursor, 'base64url').toString('utf8')));
        const invalidCursor = Buffer.from(JSON.stringify({ ...token, nativeCursor: '9' })).toString(
          'base64url',
        );
        await expectToRejectCode(
          fixture.call({
            kind: 'report-read',
            taskId: fixture.taskId,
            reportId: request.lastReportId!,
            cursor: invalidCursor,
          }),
          'JG_AGENT_HQ_CURSOR_INVALID',
        );
        await expectToRejectCode(
          fixture.call(
            {
              kind: 'report-read',
              taskId: fixture.taskId,
              reportId: request.lastReportId!,
              cursor: chunk.result.nextCursor,
            },
            { kind: 'agent', agentId: fixture.agentIds[0]! },
          ),
          'JG_AGENT_HQ_CURSOR_INVALID',
        );
      }
      expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThanOrEqual(65_536);
      expect(chunk.result.offsetBytes).toBe(Buffer.byteLength(text));
      text += chunk.result.text;
      cursor = chunk.result.nextCursor ?? undefined;
    } while (cursor);
    expect(text).toBe(report);
  }));

test('Claude installs the envelope through idle resume and preserves live settings and ordinary reports', async () =>
  withCollaboration(async (fixture) => {
    const status = await fixture.native.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('Missing runtime epoch');
    const send = async (text: string, model?: string) => {
      const action = await fixture.native.request({
        kind: 'action',
        action: {
          id: randomUUID(),
          runtimeEpoch: status.result.runtimeEpoch,
          command: {
            kind: 'message',
            threadId: fixture.agentIds[1]!,
            input: { kind: 'text', text },
            ...(model ? { settings: { model, effort: 'native-effort' } } : {}),
          },
        },
      });
      if (action.kind !== 'action') throw new Error('Missing native receipt');
      await expect
        .poll(async () => {
          const result = await fixture.native.request({
            kind: 'receipt',
            actionId: action.result.id,
          });
          return result.kind === 'receipt' ? result.result?.completion : null;
        })
        .toBe('completed');
      const receipt = await fixture.native.request({ kind: 'receipt', actionId: action.result.id });
      if (receipt.kind !== 'receipt' || !receipt.result) throw new Error('Missing final receipt');
      return receipt.result;
    };
    await writeFixtureControl(fixture.native.root, 'claude-control.json', {
      outputText: 'An ordinary conversation.',
    });
    await send('Ordinary first turn', 'model-0002');
    const requestId = randomUUID();
    await writeFixtureControl(fixture.native.root, 'claude-control.json', {
      structuredOutput: {
        requestId,
        outcome: 'completed',
        report: 'Selected findings.',
        childRequestIds: [],
        requiredAuthority: null,
      },
      rejectDialectReference: true,
    });
    await publish(fixture, requestId, fixture.agentIds[1]!);
    await dispatch(fixture, requestId);
    await expect.poll(async () => (await readRequest(fixture, requestId)).state).toBe('resolved');
    const starts = (await readFile(join(fixture.native.root, 'claude-starts.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) =>
        z.object({ id: z.string(), args: z.array(z.string()) }).parse(JSON.parse(line)),
      );
    expect(starts).toHaveLength(2);
    expect(starts[1]!.id).toBe(starts[0]!.id);
    const args = starts[1]!.args;
    expect(args[args.indexOf('--resume') + 1]).toBe(starts[0]!.id);
    expect(args[args.indexOf('--model') + 1]).toBe('model-0002');
    expect(args).toContain('--json-schema');
    await writeFixtureControl(fixture.native.root, 'claude-control.json', {
      structuredOutput: {
        requestId: null,
        outcome: 'completed',
        report: 'A normal Markdown answer.',
        childRequestIds: [],
        requiredAuthority: null,
      },
    });
    const ordinary = await send('Ordinary follow-up');
    expect(ordinary.result).toMatchObject({
      format: 'text',
      text: 'A normal Markdown answer.',
      structuredOutput: null,
      isComplete: true,
    });
    expect((await readRequest(fixture, requestId)).dispatchCount).toBe(1);
  }));

test('a request to a Claude agent that gave up its idle process reopens it once, with the envelope and its agent bridge', async () =>
  withCollaboration(async (fixture) => {
    const status = await fixture.native.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('Missing runtime epoch');
    await writeFixtureControl(fixture.native.root, 'claude-control.json', {
      outputText: 'An ordinary conversation.',
    });
    const action = await fixture.native.request({
      kind: 'action',
      action: {
        id: randomUUID(),
        runtimeEpoch: status.result.runtimeEpoch,
        command: {
          kind: 'message',
          threadId: fixture.agentIds[1]!,
          input: { kind: 'text', text: 'Ordinary first turn' },
        },
      },
    });
    if (action.kind !== 'action') throw new Error('Missing native receipt');
    await expect
      .poll(async () => {
        const result = await fixture.native.request({
          kind: 'receipt',
          actionId: action.result.id,
        });
        return result.kind === 'receipt' ? result.result?.completion : null;
      })
      .toBe('completed');
    const readStarts = async () =>
      (await readFile(join(fixture.native.root, 'claude-starts.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) =>
          z.object({ id: z.string(), args: z.array(z.string()) }).parse(JSON.parse(line)),
        );
    const [first] = await readStarts();
    // the agent's turn ended its idle period, so its process goes once that period passes
    await expect.poll(() => countHeldDelays(3_600)).toBe(1);
    expect(releaseHeldDelays(3_600)).toBe(1);
    const requestId = randomUUID();
    await writeFixtureControl(fixture.native.root, 'claude-control.json', {
      structuredOutput: {
        requestId,
        outcome: 'completed',
        report: 'Selected findings.',
        childRequestIds: [],
        requiredAuthority: null,
      },
    });
    await publish(fixture, requestId, fixture.agentIds[1]!);
    await dispatch(fixture, requestId);
    await expect.poll(async () => (await readRequest(fixture, requestId)).state).toBe('resolved');
    const starts = await readStarts();
    expect(starts).toHaveLength(2);
    const args = starts[1]!.args;
    expect(args[args.indexOf('--resume') + 1]).toBe(first!.id);
    expect(args).toContain('--json-schema');
    expect(args).toContain('--mcp-config');
  }));

test('a busy agent retains a directed request until its native boundary and checks capacity again', async () =>
  withCollaboration(async (fixture) => {
    const status = await fixture.native.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('Missing epoch');
    await writeFixtureControl(fixture.native.root, 'control.json', { holdTurn: true });
    await fixture.native.request({
      kind: 'action',
      action: {
        id: randomUUID(),
        runtimeEpoch: status.result.runtimeEpoch,
        command: {
          kind: 'message',
          threadId: fixture.agentIds[0]!,
          input: { kind: 'text', text: 'Finish current work first.' },
        },
      },
    });
    await expect
      .poll(async () => {
        const thread = await fixture.native.request({
          kind: 'managed-thread',
          threadId: fixture.agentIds[0]!,
        });
        return thread.kind === 'managed-thread' ? thread.result?.state : null;
      })
      .toBe('running');
    const requestId = randomUUID();
    await publish(fixture, requestId, fixture.agentIds[0]!);
    await dispatch(fixture, requestId);
    await expect
      .poll(async () => (await readRequest(fixture, requestId)).dispatchBlockedReason)
      .toBe('busy');
    expect((await readRequest(fixture, requestId)).dispatchCount).toBe(0);
    const thread = await fixture.native.request({
      kind: 'managed-thread',
      threadId: fixture.agentIds[0]!,
    });
    if (thread.kind !== 'managed-thread' || !thread.result?.nativeId)
      throw new Error('Missing native identity');
    await writeFixtureControl(fixture.native.root, 'control.json', {
      releaseThreadId: thread.result.nativeId,
      structuredOutput: {
        requestId,
        outcome: 'completed',
        report: 'Ran at the safe boundary.',
        childRequestIds: [],
        requiredAuthority: null,
      },
    });
    await fixture.native.request({ kind: 'skills', threadId: fixture.agentIds[0]! });
    await expect.poll(async () => (await readRequest(fixture, requestId)).state).toBe('resolved');
    expect(await readRequest(fixture, requestId)).toMatchObject({
      dispatchCount: 1,
      outcome: 'completed',
    });
  }));

test('automatic task turns consume a cumulative limit and status/read/ack traffic cannot bypass it', async () =>
  withCollaboration(async (fixture) => {
    await fixture.call({
      kind: 'task-policy-set',
      id: randomUUID(),
      taskId: fixture.taskId,
      expectedRevision: 1,
      policy: { ...fixture.policy, automaticDispatch: true, automaticTurnLimit: 1 },
    });
    const firstId = randomUUID();
    await writeFixtureControl(fixture.native.root, 'control.json', {
      structuredOutput: {
        requestId: firstId,
        outcome: 'completed',
        report: 'First automatic result.',
        childRequestIds: [],
        requiredAuthority: null,
      },
    });
    await publish(fixture, firstId, fixture.agentIds[0]!);
    await expect.poll(async () => (await readRequest(fixture, firstId)).state).toBe('resolved');
    const nextId = randomUUID();
    await publish(fixture, nextId, fixture.agentIds[0]!);
    await expect
      .poll(async () => (await readRequest(fixture, nextId)).dispatchBlockedReason)
      .toBe('turn-limit');
    await fixture.call({ kind: 'status', taskId: fixture.taskId });
    await fixture.call({ kind: 'message-read', taskId: fixture.taskId, messageId: nextId });
    await fixture.call(
      { kind: 'message-ack', id: randomUUID(), taskId: fixture.taskId, messageId: nextId },
      { kind: 'agent', agentId: fixture.agentIds[0]! },
    );
    expect((await readRequest(fixture, nextId)).dispatchCount).toBe(0);
    const task = await fixture.call({ kind: 'task-read', taskId: fixture.taskId });
    expect(task.kind === 'task' && task.task.automaticTurnCount).toBe(1);
    await writeFixtureControl(fixture.native.root, 'control.json', {
      structuredOutput: {
        requestId: nextId,
        outcome: 'completed',
        report: 'Explicit manual dispatch.',
        childRequestIds: [],
        requiredAuthority: null,
      },
    });
    await dispatch(fixture, nextId);
    await expect.poll(async () => (await readRequest(fixture, nextId)).state).toBe('resolved');
  }));

test('task capacity is retained until terminal collection and cancellation interrupts only its exact turn', async () =>
  withCollaboration(async (fixture) => {
    await fixture.call({
      kind: 'task-policy-set',
      id: randomUUID(),
      taskId: fixture.taskId,
      expectedRevision: 1,
      policy: { ...fixture.policy, automaticDispatch: true, concurrencyLimit: 1 },
    });
    const firstId = randomUUID();
    await writeFixtureControl(fixture.native.root, 'control.json', { holdTurn: true });
    await publish(fixture, firstId, fixture.agentIds[0]!);
    await expect
      .poll(async () => (await readRequest(fixture, firstId)).currentActionId)
      .toBe(firstId);
    const secondId = randomUUID();
    await writeFixtureControl(fixture.native.root, 'claude-control.json', {
      structuredOutput: {
        requestId: secondId,
        outcome: 'completed',
        report: 'Capacity was released after collection.',
        childRequestIds: [],
        requiredAuthority: null,
      },
    });
    await publish(fixture, secondId, fixture.agentIds[1]!);
    await expect
      .poll(async () => (await readRequest(fixture, secondId)).dispatchBlockedReason)
      .toBe('capacity');
    expect((await readRequest(fixture, secondId)).dispatchCount).toBe(0);
    await fixture.call({
      kind: 'request-cancel',
      id: randomUUID(),
      taskId: fixture.taskId,
      requestId: firstId,
    });
    await expect.poll(async () => (await readRequest(fixture, secondId)).state).toBe('resolved');
    expect(await readRequest(fixture, firstId)).toMatchObject({
      state: 'canceled',
      outcome: null,
      currentActionId: null,
      lastReportId: null,
      dispatchCount: 1,
    });
    const calls = (await readFile(join(fixture.native.root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => z.object({ method: z.string(), params: z.unknown() }).parse(JSON.parse(line)));
    expect(calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(1);
  }));

test('lost native output stays uncertain and metadata recovery never resends it', async () =>
  withCollaboration(async (fixture) => {
    const requestId = randomUUID();
    await writeFixtureControl(fixture.native.root, 'control.json', { loseOutput: true });
    await publish(fixture, requestId, fixture.agentIds[0]!);
    await dispatch(fixture, requestId);
    await expect
      .poll(async () => {
        const receipt = await fixture.native.request({ kind: 'receipt', actionId: requestId });
        return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
      })
      .toBe('uncertain');
    const before = await readRequest(fixture, requestId);
    expect(before).toMatchObject({
      state: 'claimed',
      currentActionId: requestId,
      outcome: null,
      lastReportId: null,
      dispatchCount: 1,
    });
    const selected = await fixture.call({
      kind: 'request-collect',
      id: randomUUID(),
      taskId: fixture.taskId,
      requestId,
      actionId: requestId,
    });
    expect(selected.kind === 'operation' && selected.operation?.result).toStrictEqual({
      kind: 'collection',
      collection: null,
    });
    await fixture.call({ kind: 'fanout-recover', id: randomUUID(), taskId: fixture.taskId });
    await expectToRejectCode(dispatch(fixture, requestId), 'JG_AGENT_HQ_COLLABORATION_CONFLICT');
    await expectToRejectCode(
      fixture.call({
        kind: 'request-collect',
        id: randomUUID(),
        taskId: fixture.taskId,
        requestId,
        actionId: randomUUID(),
      }),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
    const calls = (await readFile(join(fixture.native.root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => z.object({ method: z.string() }).parse(JSON.parse(line)));
    expect(calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
  }));

test('restart collects saved terminal output once without opening a native controller', async () =>
  withCollaboration(async (fixture) => {
    await fixture.native.runtime.withStorageMaintenance(async ({ databasePath }) => {
      const database = new DatabaseSync(databasePath);
      try {
        database.exec(
          "CREATE TRIGGER fixture_fail_report BEFORE INSERT ON hq_report BEGIN SELECT RAISE(ABORT, 'Injected report failure'); END",
        );
      } finally {
        database.close();
      }
    });
    const requestId = randomUUID();
    await writeFixtureControl(fixture.native.root, 'control.json', {
      structuredOutput: {
        requestId,
        outcome: 'completed',
        report: 'Recovered without native history.',
        childRequestIds: [],
        requiredAuthority: null,
      },
    });
    await publish(fixture, requestId, fixture.agentIds[0]!);
    await dispatch(fixture, requestId);
    await expect
      .poll(async () => {
        const status = await fixture.call({ kind: 'status', taskId: fixture.taskId });
        return status.kind === 'status' ? status.status.dispatchFailure : null;
      })
      .toBe('JG_AGENT_HQ_STORE_FAILED');
    await fixture.native.runtime.withStorageMaintenance(async ({ databasePath }) => {
      const database = new DatabaseSync(databasePath);
      try {
        database.exec('DROP TRIGGER fixture_fail_report');
      } finally {
        database.close();
      }
    });
    await fixture.native.runtime.close();
    const callsBefore = await readFile(join(fixture.native.root, 'calls.jsonl'), 'utf8');
    const runtime = await createAgentHq({
      stateRoot: fixture.native.stateRoot,
      allowedRoots: [fixture.native.workspaceRoot],
    });
    try {
      const read = () =>
        fixture.call(
          { kind: 'request-read', taskId: fixture.taskId, requestId },
          fixture.host,
          runtime,
        );
      await expect
        .poll(async () => {
          const result = await read();
          return result.kind === 'request' ? result.request.state : null;
        })
        .toBe('resolved');
      const result = await read();
      expect(result.kind === 'request' && result.request).toMatchObject({
        dispatchCount: 1,
        lastReportId: requestId,
        currentActionId: null,
        outcome: 'completed',
      });
      const report = await fixture.call(
        { kind: 'report-read', taskId: fixture.taskId, reportId: requestId },
        fixture.host,
        runtime,
      );
      expect(report).toMatchObject({
        kind: 'report',
        result: { text: 'Recovered without native history.' },
      });
      expect(await readFile(join(fixture.native.root, 'calls.jsonl'), 'utf8')).toBe(callsBefore);
    } finally {
      await runtime.close();
    }
  }));

test.each(['hq_invocation_read', 'hq_identity'] as const)(
  'native %s recovers the active scope among multiple task memberships',
  async (tool) =>
    withCollaboration(async (fixture) => {
      const otherTaskId = randomUUID();
      await fixture.call({
        kind: 'task-create',
        id: otherTaskId,
        workspaceRoot: fixture.native.workspaceRoot,
        title: 'Another task membership',
        policy: fixture.policy,
        plan: null,
      });
      await fixture.call({
        kind: 'agent-add',
        id: randomUUID(),
        taskId: otherTaskId,
        agentId: fixture.agentIds[0]!,
        parentAgentId: null,
        role: null,
        permissions: fixture.permissions,
      });
      const requestId = randomUUID();
      await writeFixtureControl(fixture.native.root, 'control.json', {
        toolCall: { tool, arguments: tool === 'hq_identity' ? {} : { taskId: fixture.taskId } },
        structuredOutput: {
          requestId,
          outcome: 'completed',
          report: 'Verified from current HQ authority.',
          childRequestIds: [],
          requiredAuthority: null,
        },
      });
      await publish(fixture, requestId, fixture.agentIds[0]!);
      await dispatch(fixture, requestId);
      await expect.poll(async () => (await readRequest(fixture, requestId)).state).toBe('resolved');
      expect((await readRequest(fixture, requestId)).outcome).toBe('completed');
      const replies = (await readFile(join(fixture.native.root, 'replies.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) =>
          z
            .object({
              id: z.string(),
              result: z
                .object({
                  success: z.boolean(),
                  contentItems: z.array(z.object({ text: z.string() })),
                })
                .optional(),
            })
            .parse(JSON.parse(line)),
        );
      const reply = replies.find((entry) => entry.id.startsWith('tool-call-'))?.result;
      expect(reply?.success).toBe(true);
      const payload = JSON.parse(reply!.contentItems[0]!.text);
      expect(payload).toMatchObject(
        tool === 'hq_identity'
          ? {
              identity: {
                selectedTask: { id: fixture.taskId },
                invocation: { requestId, actionId: requestId, taskId: fixture.taskId },
              },
            }
          : {
              kind: 'invocation',
              invocation: {
                taskId: fixture.taskId,
                actionId: requestId,
                request: { id: requestId, specification: { effects: ['read'] } },
                grant: null,
              },
            },
      );
    }),
);

test('read-only assessment checks the selected plan revision without acquiring execution authority', async () =>
  withCollaboration(async (fixture) => {
    const directory = join(fixture.native.workspaceRoot, 'assessment-plan');
    await mkdir(directory);
    const source =
      '---\nid: assessment-plan\nrevision: 1\n---\n# Plan\nInspect the selected invariant.\n';
    await writeFile(join(directory, 'plan.md'), source);
    const status = await fixture.native.request({
      kind: 'plan',
      command: { kind: 'status', target: { directory } },
    });
    if (status.kind !== 'plan' || status.result.kind !== 'status')
      throw new Error('Missing plan observation');
    const requestId = randomUUID();
    await writeFixtureControl(fixture.native.root, 'control.json', {
      structuredOutput: {
        requestId,
        outcome: 'completed',
        report: 'Read-only plan findings.',
        childRequestIds: [],
        requiredAuthority: null,
      },
    });
    await fixture.call({
      kind: 'message-publish',
      id: requestId,
      taskId: fixture.taskId,
      streamId: fixture.streamId,
      messageKind: 'request',
      summary: 'Inspect the selected revision',
      body: 'Assess without changes or approval.',
      references: [],
      replyToMessageId: null,
      request: {
        targetAgentId: fixture.agentIds[0]!,
        claimable: false,
        skill: null,
        grantId: null,
        grantRevision: null,
        arguments: '',
        effects: ['read'],
        scopes: [{ workspaceRoot: fixture.native.workspaceRoot, pathPrefixes: [''] }],
        plan: {
          planId: 'assessment-plan',
          directory,
          revision: status.result.result.revision,
          milestoneIds: [],
        },
        targetReferences: [],
      },
    });
    await fixture.call({
      kind: 'agent-state-set',
      id: randomUUID(),
      taskId: fixture.taskId,
      agentId: fixture.agentIds[0]!,
      expectedRevision: 1,
      state: 'paused',
    });
    await dispatch(fixture, requestId);
    await expect
      .poll(async () => (await readRequest(fixture, requestId)).dispatchBlockedReason)
      .toBe('agent-paused');
    await writeFile(
      join(directory, 'plan.md'),
      source.replace('selected invariant', 'changed invariant'),
    );
    await fixture.call({
      kind: 'agent-state-set',
      id: randomUUID(),
      taskId: fixture.taskId,
      agentId: fixture.agentIds[0]!,
      expectedRevision: 2,
      state: 'active',
    });
    await expect
      .poll(async () => (await readRequest(fixture, requestId)).dispatchBlockedReason)
      .toBe('plan-authorization-required');
    expect((await readRequest(fixture, requestId)).dispatchCount).toBe(0);
    const changed = await fixture.native.request({
      kind: 'plan',
      command: { kind: 'status', target: { directory } },
    });
    if (changed.kind !== 'plan' || changed.result.kind !== 'status')
      throw new Error('Missing current plan');
    await fixture.call({
      kind: 'request-authorize',
      id: randomUUID(),
      taskId: fixture.taskId,
      requestId,
      expectedActionId: null,
      grantId: null,
      grantRevision: null,
      plan: {
        planId: 'assessment-plan',
        directory,
        revision: changed.result.result.revision,
        milestoneIds: [],
      },
    });
    await expect.poll(async () => (await readRequest(fixture, requestId)).state).toBe('resolved');
    const receipt = await fixture.native.request({ kind: 'receipt', actionId: requestId });
    expect(receipt.kind === 'receipt' && receipt.result?.planContext).toMatchObject({
      directory,
      scope: null,
    });
    const finalStatus = await fixture.native.request({
      kind: 'plan',
      command: { kind: 'status', target: { directory } },
    });
    expect(
      finalStatus.kind === 'plan' &&
        finalStatus.result.kind === 'status' &&
        finalStatus.result.result.coordination,
    ).toMatchObject({ execution: null, planApproval: null });
  }));

test('queued requests reject revoked grants until the owner selects a fresh exact grant', async () =>
  withCollaboration(async (fixture) => {
    const grantId = randomUUID();
    const grantFields = {
      taskId: fixture.taskId,
      eligibleAgentIds: [fixture.agentIds[0]!],
      skills: [{ name: 'explicit-skill', mode: null }],
      effects: ['read' as const],
      scopes: [{ workspaceRoot: fixture.native.workspaceRoot, pathPrefixes: [''] }],
      plan: null,
    };
    await fixture.call({ kind: 'grant-issue', id: grantId, ...grantFields });
    await fixture.call({
      kind: 'agent-state-set',
      id: randomUUID(),
      taskId: fixture.taskId,
      agentId: fixture.agentIds[0]!,
      expectedRevision: 1,
      state: 'paused',
    });
    const requestId = randomUUID();
    await fixture.call({
      kind: 'message-publish',
      id: requestId,
      taskId: fixture.taskId,
      streamId: fixture.streamId,
      messageKind: 'request',
      summary: 'Exact granted work',
      body: 'Use only the selected grant.',
      references: [],
      replyToMessageId: null,
      request: {
        targetAgentId: fixture.agentIds[0]!,
        claimable: false,
        skill: { name: 'explicit-skill', mode: null },
        grantId,
        grantRevision: 1,
        arguments: '',
        effects: grantFields.effects,
        scopes: grantFields.scopes,
        plan: null,
        targetReferences: [],
      },
    });
    await dispatch(fixture, requestId);
    await fixture.call({
      kind: 'grant-revoke',
      id: randomUUID(),
      taskId: fixture.taskId,
      grantId,
      expectedRevision: 1,
    });
    await fixture.call({
      kind: 'agent-state-set',
      id: randomUUID(),
      taskId: fixture.taskId,
      agentId: fixture.agentIds[0]!,
      expectedRevision: 2,
      state: 'active',
    });
    await expect
      .poll(async () => (await readRequest(fixture, requestId)).dispatchBlockedReason)
      .toBe('grant-invalid');
    expect((await readRequest(fixture, requestId)).dispatchCount).toBe(0);
    const freshGrantId = randomUUID();
    await fixture.call({ kind: 'grant-issue', id: freshGrantId, ...grantFields });
    await writeFixtureControl(fixture.native.root, 'control.json', {
      structuredOutput: {
        requestId,
        outcome: 'completed',
        report: 'Fresh grant selected explicitly.',
        childRequestIds: [],
        requiredAuthority: null,
      },
    });
    await fixture.call({
      kind: 'request-authorize',
      id: randomUUID(),
      taskId: fixture.taskId,
      requestId,
      expectedActionId: null,
      grantId: freshGrantId,
      grantRevision: 1,
      plan: null,
    });
    await expect.poll(async () => (await readRequest(fixture, requestId)).state).toBe('resolved');
    expect(await readRequest(fixture, requestId)).toMatchObject({
      dispatchCount: 1,
      outcome: 'completed',
      specification: { grantId: freshGrantId },
    });
  }));

test('only the recorded active requester answers requester input and the failed assignee report remains exact', async () =>
  withCollaboration(async (fixture) => {
    await fixture.call({
      kind: 'task-policy-set',
      id: randomUUID(),
      taskId: fixture.taskId,
      expectedRevision: 1,
      policy: { ...fixture.policy, automaticDispatch: true },
    });
    const requestId = randomUUID();
    await writeFixtureControl(fixture.native.root, 'claude-control.json', {
      structuredOutput: {
        requestId,
        outcome: 'needs-input',
        report: 'Which invariant?',
        childRequestIds: [],
        requiredAuthority: 'requester',
      },
    });
    await publish(fixture, requestId, fixture.agentIds[1]!, ['read'], {
      kind: 'agent',
      agentId: fixture.agentIds[0]!,
    });
    await expect
      .poll(async () => (await readRequest(fixture, requestId)).state)
      .toBe('waiting-input');
    const waiting = await readRequest(fixture, requestId);
    const answer = {
      kind: 'request-input' as const,
      id: randomUUID(),
      taskId: fixture.taskId,
      requestId,
      expectedActionId: waiting.lastActionId!,
      body: 'The exact parser invariant.',
    };
    await expectToRejectCode(
      fixture.call(answer, { kind: 'agent', agentId: fixture.agentIds[1]! }),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
    const report = '# Findings\nUnable to establish the invariant.\n';
    await writeFixtureControl(fixture.native.root, 'claude-control.json', {
      structuredOutput: {
        requestId,
        outcome: 'failed',
        report,
        childRequestIds: [],
        requiredAuthority: null,
      },
    });
    await fixture.call(answer, { kind: 'agent', agentId: fixture.agentIds[0]! });
    await expect.poll(async () => (await readRequest(fixture, requestId)).state).toBe('resolved');
    const completed = await readRequest(fixture, requestId);
    expect(completed).toMatchObject({ outcome: 'failed', failureReason: null, dispatchCount: 2 });
    const stored = await fixture.call({
      kind: 'report-read',
      taskId: fixture.taskId,
      reportId: completed.lastReportId!,
    });
    expect(stored).toMatchObject({
      kind: 'report',
      result: { text: report, report: { outcome: 'failed', authorAgentId: fixture.agentIds[1] } },
    });
    const input = await fixture.call({
      kind: 'message-read',
      taskId: fixture.taskId,
      messageId: answer.id,
    });
    expect(input).toMatchObject({
      kind: 'message',
      result: {
        message: { author: { kind: 'agent', agentId: fixture.agentIds[0] } },
        body: answer.body,
      },
    });
  }));

test('explicit idle ownership recovery closes canceled uncertain work without claiming native success', async () =>
  withCollaboration(async (fixture) => {
    const requestId = randomUUID();
    await writeFixtureControl(fixture.native.root, 'control.json', { loseOutput: true });
    await publish(fixture, requestId, fixture.agentIds[0]!);
    await dispatch(fixture, requestId);
    await expect
      .poll(async () => {
        const receipt = await fixture.native.request({ kind: 'receipt', actionId: requestId });
        return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
      })
      .toBe('uncertain');
    await fixture.call({
      kind: 'request-cancel',
      id: randomUUID(),
      taskId: fixture.taskId,
      requestId,
    });
    await fixture.native.runtime.close();
    await writeFixtureControl(fixture.native.root, 'control.json', {});
    const runtime = await createAgentHq({
      stateRoot: fixture.native.stateRoot,
      allowedRoots: [fixture.native.workspaceRoot],
    });
    try {
      const status = await runtime.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing recovered epoch');
      const recoveryActionId = randomUUID();
      await runtime.request({
        kind: 'action',
        action: {
          id: recoveryActionId,
          runtimeEpoch: status.result.runtimeEpoch,
          command: {
            kind: 'thread-resume',
            threadId: fixture.agentIds[0]!,
            operatorConfirmation: 'The prior controller stopped; verify native idle ownership.',
          },
        },
      });
      await expect
        .poll(async () => {
          const receipt = await runtime.request({ kind: 'receipt', actionId: recoveryActionId });
          return receipt.kind === 'receipt'
            ? { delivery: receipt.result?.delivery, failure: receipt.result?.failure }
            : null;
        })
        .toStrictEqual({ delivery: 'acknowledged', failure: null });
      await expect
        .poll(async () => {
          const request = await fixture.call(
            { kind: 'request-read', taskId: fixture.taskId, requestId },
            fixture.host,
            runtime,
          );
          return request.kind === 'request' ? request.request.currentActionId : 'missing';
        })
        .toBeNull();
      const collected = await fixture.call(
        {
          kind: 'request-collect',
          id: randomUUID(),
          taskId: fixture.taskId,
          requestId,
          actionId: requestId,
        },
        fixture.host,
        runtime,
      );
      expect(collected.kind === 'operation' && collected.operation?.result).toMatchObject({
        kind: 'collection',
        collection: {
          recoveryActionId,
          state: 'canceled',
          report: null,
          reply: { author: { kind: 'runtime' } },
        },
      });
      const original = await runtime.request({ kind: 'receipt', actionId: requestId });
      expect(original.kind === 'receipt' && original.result).toMatchObject({
        delivery: 'uncertain',
        completion: null,
      });
      const calls = (await readFile(join(fixture.native.root, 'calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => z.object({ method: z.string() }).parse(JSON.parse(line)));
      expect(calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  }));

test('maximum escaped request content remains dispatchable within the native command budget', async () =>
  withCollaboration(async (fixture) => {
    const requestId = randomUUID();
    await writeFixtureControl(fixture.native.root, 'control.json', {
      structuredOutput: {
        requestId,
        outcome: 'completed',
        report: 'Bounded request references were retained.',
        childRequestIds: [],
        requiredAuthority: null,
      },
    });
    await fixture.call({
      kind: 'message-publish',
      id: requestId,
      taskId: fixture.taskId,
      streamId: fixture.streamId,
      messageKind: 'request',
      summary: '\u0000'.repeat(1024),
      body: '\u0000'.repeat(8192),
      references: [],
      replyToMessageId: null,
      request: {
        targetAgentId: fixture.agentIds[0]!,
        claimable: false,
        skill: null,
        grantId: null,
        grantRevision: null,
        arguments: 'x'.repeat(4096),
        effects: ['read'],
        scopes: [{ workspaceRoot: fixture.native.workspaceRoot, pathPrefixes: [''] }],
        plan: null,
        targetReferences: [],
      },
    });
    await dispatch(fixture, requestId);
    await expect.poll(async () => (await readRequest(fixture, requestId)).state).toBe('resolved');
    expect(await readRequest(fixture, requestId)).toMatchObject({
      outcome: 'completed',
      dispatchCount: 1,
      failureReason: null,
    });
    const selected = await fixture.call({
      kind: 'message-read',
      taskId: fixture.taskId,
      messageId: requestId,
    });
    if (selected.kind !== 'message') throw new Error('Missing exact message');
    expect(selected.result.body.length).toBe(8192);
    expect([...new Set(selected.result.body)]).toStrictEqual(['\u0000']);
    expect(selected.result.message.summary.length).toBe(1024);
    expect([...new Set(selected.result.message.summary)]).toStrictEqual(['\u0000']);
  }));

test('operator identity and grant provenance remain exact across embedded NUL bytes', async () =>
  withCollaboration(async (fixture) => {
    const taskId = randomUUID();
    const host = { kind: 'host' as const, operatorRef: 'operator\u0000selected' };
    const created = await fixture.call(
      {
        kind: 'task-create',
        id: taskId,
        workspaceRoot: fixture.native.workspaceRoot,
        title: 'Exact operator authority',
        policy: fixture.policy,
        plan: null,
      },
      host,
    );
    expect(created.kind === 'operation' && created.operation?.result).toMatchObject({
      kind: 'task',
      task: { ownerOperatorRef: host.operatorRef },
    });
    await expectToRejectCode(
      fixture.call({ kind: 'task-read', taskId }, { kind: 'host', operatorRef: 'operator' }),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
    const granted = await fixture.call(
      {
        kind: 'grant-issue',
        id: randomUUID(),
        taskId,
        eligibleAgentIds: null,
        skills: [{ name: 'explicit-skill', mode: null }],
        effects: ['read'],
        scopes: [{ workspaceRoot: fixture.native.workspaceRoot, pathPrefixes: [''] }],
        plan: null,
      },
      host,
    );
    expect(granted.kind === 'operation' && granted.operation?.result).toMatchObject({
      kind: 'grant',
      grant: { issuerOperatorRef: host.operatorRef },
    });
  }));

test.each([
  ['codex', 'claude', false],
  ['claude', 'codex', false],
  ['codex', 'codex', false],
  ['codex', 'claude', true],
  ['claude', 'codex', true],
  ['codex', 'codex', true],
] as const)(
  'parent %s delegates to %s, early child = %s, then resumes and completes',
  async (parentProvider, childProvider, isEarly) =>
    withCollaboration(async (fixture) => {
      const parentId = randomUUID(),
        childId = randomUUID();
      const parentAgent = fixture.agentIds[parentProvider === 'codex' ? 0 : 1]!;
      let childAgent = fixture.agentIds[childProvider === 'codex' ? 0 : 1]!;
      if (parentProvider === childProvider) {
        const status = await fixture.native.request({ kind: 'status' });
        if (status.kind !== 'status') throw new Error('Missing epoch');
        const created = await fixture.native.request({
          kind: 'action',
          action: {
            id: randomUUID(),
            runtimeEpoch: status.result.runtimeEpoch,
            command: {
              kind: 'thread-create',
              provider: childProvider,
              workspaceRoot: fixture.native.workspaceRoot,
              name: 'same-vendor-reviewer',
            },
          },
        });
        if (created.kind !== 'action' || !created.result.threadId) throw new Error('Missing child');
        childAgent = created.result.threadId;
        await expect
          .poll(async () => {
            const receipt = await fixture.native.request({
              kind: 'receipt',
              actionId: created.result.id,
            });
            return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
          })
          .toBe('acknowledged');
        await fixture.call({
          kind: 'agent-add',
          id: randomUUID(),
          taskId: fixture.taskId,
          agentId: childAgent,
          parentAgentId: null,
          role: null,
          permissions: fixture.permissions,
        });
      }
      await startParent(fixture, parentId, parentAgent);
      await publishChild(fixture, parentId, childId, parentAgent, childAgent);
      await expect
        .poll(async () => {
          const receipt = await fixture.native.request({ kind: 'receipt', actionId: childId });
          return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
        })
        .toBe('acknowledged');
      expect(await readRequest(fixture, childId)).toMatchObject({
        parentRequestId: parentId,
        parentActionId: parentId,
        requester: { kind: 'agent', agentId: parentAgent },
      });
      if (isEarly) {
        await finishNative(fixture, childAgent, parentOutcome(childId, 'completed'));
        await expect.poll(async () => (await readRequest(fixture, childId)).state).toBe('resolved');
      }
      await finishNative(
        fixture,
        parentAgent,
        parentOutcome(parentId, 'waiting-children', [childId]),
      );
      if (!isEarly) {
        await expect
          .poll(async () => (await readRequest(fixture, parentId)).state)
          .toBe('waiting-children');
        expect(await readRequest(fixture, parentId)).toMatchObject({
          assigneeAgentId: parentAgent,
          outcome: null,
          currentActionId: null,
          pendingActionId: null,
          childRequestIds: [childId],
          waitGeneration: 1,
        });
        await finishNative(fixture, childAgent, parentOutcome(childId, 'completed'));
      }
      await expect.poll(async () => (await readRequest(fixture, parentId)).dispatchCount).toBe(2);
      const parent = await readRequest(fixture, parentId);
      await expect
        .poll(async () => {
          const receipt = await fixture.native.request({
            kind: 'receipt',
            actionId: parent.currentActionId!,
          });
          return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
        })
        .toBe('acknowledged');
      expect(await readRequest(fixture, childId)).toMatchObject({
        state: 'resolved',
        dispatchCount: 1,
      });
      const verified = await fixture.call(
        { kind: 'invocation-read', taskId: fixture.taskId },
        { kind: 'agent', agentId: parentAgent },
      );
      expect(verified).toMatchObject({
        kind: 'invocation',
        invocation: {
          actionId: parent.continuationActionId,
          continuation: {
            generation: 1,
            kind: 'terminal-results',
            children: [
              {
                requestId: childId,
                state: 'resolved',
                outcome: 'completed',
                actionId: childId,
                report: { id: childId },
                isClarification: false,
              },
            ],
          },
        },
      });
      const deliveries = await fixture.call({
        kind: 'deliveries-list',
        taskId: fixture.taskId,
        recipientAgentId: parentAgent,
        state: 'all',
      });
      const childReport = await fixture.call({
        kind: 'report-read',
        taskId: fixture.taskId,
        reportId: childId,
      });
      if (childReport.kind !== 'report') throw new Error('Missing child report');
      expect(
        deliveries.kind === 'deliveries' &&
          deliveries.data.find(
            (entry) => entry.messageId === childReport.result.report.replyMessageId,
          ),
      ).toMatchObject({
        nativeActionId: parent.continuationActionId,
        deliveredAt: expect.any(Number),
        acknowledgedAt: null,
      });
      await finishNative(fixture, parentAgent, parentOutcome(parentId, 'completed'));
      await expect.poll(async () => (await readRequest(fixture, parentId)).state).toBe('resolved');
      const duplicate = await fixture.call({
        kind: 'request-collect',
        id: randomUUID(),
        taskId: fixture.taskId,
        requestId: childId,
        actionId: childId,
      });
      expect(duplicate.kind === 'operation' && duplicate.operation?.result).toMatchObject({
        kind: 'collection',
        collection: { state: 'resolved', actionId: childId },
      });
      expect(await readRequest(fixture, parentId)).toMatchObject({
        outcome: 'completed',
        dispatchCount: 2,
        waitGeneration: 1,
        currentActionId: null,
        pendingActionId: null,
        continuationActionId: parent.continuationActionId,
      });
    }),
);

test('requester clarification continues the parent once, retains its wait, and later returns the terminal result', async () =>
  withCollaboration(async (fixture) => {
    const parentId = randomUUID(),
      childId = randomUUID();
    const parentAgent = fixture.agentIds[0]!,
      childAgent = fixture.agentIds[1]!;
    await startParent(fixture, parentId, parentAgent);
    await publishChild(fixture, parentId, childId, parentAgent, childAgent);
    await expect
      .poll(async () => {
        const receipt = await fixture.native.request({ kind: 'receipt', actionId: childId });
        return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
      })
      .toBe('acknowledged');
    await finishNative(
      fixture,
      parentAgent,
      parentOutcome(parentId, 'waiting-children', [childId]),
    );
    await expect
      .poll(async () => (await readRequest(fixture, parentId)).state)
      .toBe('waiting-children');
    await finishNative(fixture, childAgent, parentOutcome(childId, 'needs-input', [], 'requester'));
    await expect.poll(async () => (await readRequest(fixture, parentId)).dispatchCount).toBe(2);
    await expect
      .poll(async () => (await readRequest(fixture, childId)).clarificationConsumedActionId)
      .toBe(childId);
    const invocation = await fixture.call(
      { kind: 'invocation-read', taskId: fixture.taskId },
      { kind: 'agent', agentId: parentAgent },
    );
    expect(invocation).toMatchObject({
      kind: 'invocation',
      invocation: {
        continuation: {
          kind: 'clarification',
          generation: 1,
          children: [
            {
              requestId: childId,
              state: 'waiting-input',
              isClarification: true,
              report: { id: childId },
            },
          ],
        },
      },
    });
    const answerId = randomUUID();
    await fixture.call(
      {
        kind: 'request-input',
        id: answerId,
        taskId: fixture.taskId,
        requestId: childId,
        expectedActionId: childId,
        body: 'Use the stated invariant; no extra permissions are granted.',
      },
      { kind: 'agent', agentId: parentAgent },
    );
    await expect
      .poll(async () => {
        const receipt = await fixture.native.request({ kind: 'receipt', actionId: answerId });
        return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
      })
      .toBe('acknowledged');
    await finishNative(
      fixture,
      parentAgent,
      parentOutcome(parentId, 'waiting-children', [childId]),
    );
    await expect
      .poll(async () => (await readRequest(fixture, parentId)).state)
      .toBe('waiting-children');
    expect(await readRequest(fixture, parentId)).toMatchObject({
      waitGeneration: 2,
      continuationActionId: null,
      dispatchCount: 2,
    });
    await finishNative(fixture, childAgent, parentOutcome(childId, 'completed'));
    await expect.poll(async () => (await readRequest(fixture, parentId)).dispatchCount).toBe(3);
    const parent = await readRequest(fixture, parentId);
    await expect
      .poll(async () => {
        const receipt = await fixture.native.request({
          kind: 'receipt',
          actionId: parent.currentActionId!,
        });
        return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
      })
      .toBe('acknowledged');
    expect(parent.continuationActionId).not.toBe(
      invocation.kind === 'invocation' ? invocation.invocation?.actionId : null,
    );
    await finishNative(fixture, parentAgent, parentOutcome(parentId, 'completed'));
    await expect.poll(async () => (await readRequest(fixture, parentId)).outcome).toBe('completed');
  }));

test('operator-only child input never wakes its parent or permits requester substitution', async () =>
  withCollaboration(async (fixture) => {
    const parentId = randomUUID(),
      childId = randomUUID();
    await startParent(fixture, parentId, fixture.agentIds[0]!);
    await publishChild(fixture, parentId, childId, fixture.agentIds[0]!, fixture.agentIds[1]!);
    await expect
      .poll(async () => {
        const receipt = await fixture.native.request({ kind: 'receipt', actionId: childId });
        return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
      })
      .toBe('acknowledged');
    await finishNative(
      fixture,
      fixture.agentIds[0]!,
      parentOutcome(parentId, 'waiting-children', [childId]),
    );
    await expect
      .poll(async () => (await readRequest(fixture, parentId)).state)
      .toBe('waiting-children');
    await finishNative(
      fixture,
      fixture.agentIds[1]!,
      parentOutcome(childId, 'needs-input', [], 'operator'),
    );
    await expect
      .poll(async () => (await readRequest(fixture, childId)).state)
      .toBe('waiting-input');
    await expectToRejectCode(
      fixture.call(
        {
          kind: 'request-input',
          id: randomUUID(),
          taskId: fixture.taskId,
          requestId: childId,
          expectedActionId: childId,
          body: 'A requester cannot approve this.',
        },
        { kind: 'agent', agentId: fixture.agentIds[0]! },
      ),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
    expect(await readRequest(fixture, parentId)).toMatchObject({
      state: 'waiting-children',
      dispatchCount: 1,
      continuationActionId: null,
    });
    await fixture.call({
      kind: 'request-collect',
      id: randomUUID(),
      taskId: fixture.taskId,
      requestId: childId,
      actionId: childId,
    });
    expect((await readRequest(fixture, parentId)).dispatchCount).toBe(1);
  }));

test.each(['unknown', 'self', 'root', 'duplicate', 'oversize'] as const)(
  'parent rejects a %s child wait',
  async (kind) =>
    withCollaboration(async (fixture) => {
      const parentId = randomUUID(),
        childId = randomUUID();
      await startParent(fixture, parentId, fixture.agentIds[0]!);
      if (kind === 'root') await publish(fixture, childId, fixture.agentIds[1]!);
      const ids =
        kind === 'self'
          ? [parentId]
          : kind === 'duplicate'
            ? [childId, childId]
            : kind === 'oversize'
              ? Array.from({ length: 33 }, () => randomUUID())
              : [childId];
      await finishNative(
        fixture,
        fixture.agentIds[0]!,
        parentOutcome(parentId, 'waiting-children', ids),
      );
      await expect.poll(async () => (await readRequest(fixture, parentId)).state).toBe('resolved');
      expect(await readRequest(fixture, parentId)).toMatchObject({
        outcome: 'failed',
        failureReason: ['duplicate', 'oversize'].includes(kind)
          ? 'invalid-response'
          : 'invalid-child-wait',
        waitGeneration: 0,
        continuationActionId: null,
      });
    }),
);

test('active parent publication cannot forge a relationship or expand its selected effects', async () =>
  withCollaboration(async (fixture) => {
    const parentId = randomUUID();
    await startParent(fixture, parentId, fixture.agentIds[0]!);
    await expectToRejectCode(
      publishChild(fixture, randomUUID(), randomUUID(), fixture.agentIds[0]!, fixture.agentIds[1]!),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
    await expectToRejectCode(
      publish(fixture, randomUUID(), fixture.agentIds[1]!, ['read'], {
        kind: 'agent',
        agentId: fixture.agentIds[0]!,
      }),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
    await expectToRejectCode(
      fixture.call(
        {
          kind: 'message-publish',
          id: randomUUID(),
          taskId: fixture.taskId,
          streamId: fixture.streamId,
          messageKind: 'request',
          summary: 'Forged writable child',
          body: 'No authority.',
          references: [],
          replyToMessageId: null,
          parentRequestId: parentId,
          request: {
            targetAgentId: fixture.agentIds[1]!,
            claimable: false,
            skill: null,
            grantId: null,
            grantRevision: null,
            arguments: '',
            effects: ['workspace-write'],
            scopes: [{ workspaceRoot: fixture.native.workspaceRoot, pathPrefixes: [''] }],
            plan: null,
            targetReferences: [],
          },
        },
        { kind: 'agent', agentId: fixture.agentIds[0]! },
      ),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
    expect((await readRequest(fixture, parentId)).dispatchCount).toBe(1);
  }));

test('delegation cannot be reported as completed while a direct child remains unfinished', async () =>
  withCollaboration(async (fixture) => {
    const parentId = randomUUID(),
      childId = randomUUID();
    await startParent(fixture, parentId, fixture.agentIds[0]!);
    await publishChild(fixture, parentId, childId, fixture.agentIds[0]!, fixture.agentIds[1]!);
    await finishNative(fixture, fixture.agentIds[0]!, parentOutcome(parentId, 'completed'));
    await expect.poll(async () => (await readRequest(fixture, parentId)).state).toBe('resolved');
    expect(await readRequest(fixture, parentId)).toMatchObject({
      outcome: 'failed',
      failureReason: 'children-pending',
      dispatchCount: 1,
    });
    expect((await readRequest(fixture, childId)).state).not.toBe('canceled');
  }));

test('a child result cannot restart a paused parent; current-revision host resumption preserves the reservation', async () =>
  withCollaboration(async (fixture) => {
    const parentId = randomUUID(),
      childId = randomUUID();
    const parentAgent = fixture.agentIds[0]!,
      childAgent = fixture.agentIds[1]!;
    await startParent(fixture, parentId, parentAgent);
    await publishChild(fixture, parentId, childId, parentAgent, childAgent);
    await expect
      .poll(async () => {
        const receipt = await fixture.native.request({ kind: 'receipt', actionId: childId });
        return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
      })
      .toBe('acknowledged');
    await finishNative(
      fixture,
      parentAgent,
      parentOutcome(parentId, 'waiting-children', [childId]),
    );
    await expect
      .poll(async () => (await readRequest(fixture, parentId)).state)
      .toBe('waiting-children');
    await fixture.call({
      kind: 'agent-state-set',
      id: randomUUID(),
      taskId: fixture.taskId,
      agentId: parentAgent,
      expectedRevision: 1,
      state: 'paused',
    });
    await finishNative(fixture, childAgent, parentOutcome(childId, 'completed'));
    await expect
      .poll(async () => (await readRequest(fixture, parentId)).dispatchBlockedReason)
      .toBe('agent-paused');
    const reservation = (await readRequest(fixture, parentId)).continuationActionId;
    expect(reservation).not.toBeNull();
    await expectToRejectCode(
      fixture.call({
        kind: 'request-resume',
        id: randomUUID(),
        taskId: fixture.taskId,
        requestId: parentId,
        expectedActionId: parentId,
        expectedAgentRevision: 1,
        expectedTaskRevision: 1,
        body: 'Stale pause selection.',
      }),
      'JG_AGENT_HQ_COLLABORATION_CONFLICT',
    );
    expect((await readRequest(fixture, parentId)).dispatchCount).toBe(1);
    await fixture.call({
      kind: 'request-resume',
      id: randomUUID(),
      taskId: fixture.taskId,
      requestId: parentId,
      expectedActionId: parentId,
      expectedAgentRevision: 2,
      expectedTaskRevision: 1,
      body: 'Resume this exact parent wait with its current permissions.',
    });
    await expect.poll(async () => (await readRequest(fixture, parentId)).dispatchCount).toBe(2);
    expect(await readRequest(fixture, parentId)).toMatchObject({
      continuationActionId: reservation,
      currentActionId: reservation,
      waitGeneration: 1,
    });
  }));

test('a canceled parent retains late child evidence without a continuation or cascading cancellation', async () =>
  withCollaboration(async (fixture) => {
    const parentId = randomUUID(),
      childId = randomUUID();
    await startParent(fixture, parentId, fixture.agentIds[0]!);
    await publishChild(fixture, parentId, childId, fixture.agentIds[0]!, fixture.agentIds[1]!);
    await expect
      .poll(async () => {
        const receipt = await fixture.native.request({ kind: 'receipt', actionId: childId });
        return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
      })
      .toBe('acknowledged');
    await finishNative(
      fixture,
      fixture.agentIds[0]!,
      parentOutcome(parentId, 'waiting-children', [childId]),
    );
    await expect
      .poll(async () => (await readRequest(fixture, parentId)).state)
      .toBe('waiting-children');
    await fixture.call({
      kind: 'request-cancel',
      id: randomUUID(),
      taskId: fixture.taskId,
      requestId: parentId,
    });
    expect((await readRequest(fixture, childId)).state).toBe('claimed');
    await finishNative(fixture, fixture.agentIds[1]!, parentOutcome(childId, 'completed'));
    await expect.poll(async () => (await readRequest(fixture, childId)).outcome).toBe('completed');
    expect(await readRequest(fixture, parentId)).toMatchObject({
      state: 'canceled',
      dispatchCount: 1,
      continuationActionId: null,
      pendingActionId: null,
    });
    const report = await fixture.call({
      kind: 'report-read',
      taskId: fixture.taskId,
      reportId: childId,
    });
    expect(report.kind === 'report' && report.result.text).toBe(
      parentOutcome(childId, 'completed').report,
    );
  }));

test('32 early child cancellations reserve one bounded continuation, and parent links are immutable', async () =>
  withCollaboration(async (fixture) => {
    const parentId = randomUUID(),
      children = Array.from({ length: 32 }, () => randomUUID());
    const parentAgent = fixture.agentIds[0]!,
      childAgent = fixture.agentIds[1]!;
    await writeFixtureControl(fixture.native.root, 'control.json', { holdTurn: true });
    await publish(fixture, parentId, parentAgent);
    await dispatch(fixture, parentId);
    await expect
      .poll(async () => {
        const receipt = await fixture.native.request({ kind: 'receipt', actionId: parentId });
        return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
      })
      .toBe('acknowledged');
    for (const childId of children) {
      await publishChild(fixture, parentId, childId, parentAgent, childAgent);
      await fixture.call({
        kind: 'request-cancel',
        id: randomUUID(),
        taskId: fixture.taskId,
        requestId: childId,
      });
    }
    const database = new DatabaseSync(fixture.native.runtime.storage.databasePath);
    try {
      expect(() =>
        database
          .prepare('UPDATE hq_request SET parent_request_id = NULL WHERE id = ?')
          .run(children[0]!),
      ).toThrow('HQ request parent links are immutable');
      const queryPlan = database
        .prepare(
          "EXPLAIN QUERY PLAN SELECT 1 FROM hq_request WHERE parent_request_id = ? AND state IN ('open','claimed','waiting-children','waiting-input','interrupted') LIMIT 1",
        )
        .all(parentId);
      expect(queryPlan.some((row) => String(row.detail).includes('hq_idx_r__parent_state'))).toBe(
        true,
      );
    } finally {
      database.close();
    }
    await fixture.call({
      kind: 'task-policy-set',
      id: randomUUID(),
      taskId: fixture.taskId,
      expectedRevision: 1,
      policy: { ...fixture.policy, automaticDispatch: true },
    });
    await finishNative(fixture, parentAgent, parentOutcome(parentId, 'waiting-children', children));
    await expect.poll(async () => (await readRequest(fixture, parentId)).dispatchCount).toBe(2);
    const request = await readRequest(fixture, parentId);
    await expect
      .poll(async () => {
        const receipt = await fixture.native.request({
          kind: 'receipt',
          actionId: request.currentActionId!,
        });
        return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
      })
      .toBe('acknowledged');
    const invocation = await fixture.call(
      { kind: 'invocation-read', taskId: fixture.taskId },
      { kind: 'agent', agentId: parentAgent },
    );
    expect(
      invocation.kind === 'invocation' && invocation.invocation?.continuation?.children,
    ).toHaveLength(32);
    expect(
      invocation.kind === 'invocation' &&
        invocation.invocation?.continuation?.children.every((child) => child.state === 'canceled'),
    ).toBe(true);
    expect(request).toMatchObject({
      waitGeneration: 1,
      continuationActionId: request.currentActionId,
    });
  }));

test('a busy parent queues exactly one continuation until its unrelated native turn reaches a safe boundary', async () =>
  withCollaboration(async (fixture) => {
    const parentId = randomUUID(),
      childId = randomUUID(),
      ordinaryId = randomUUID();
    const parentAgent = fixture.agentIds[0]!,
      childAgent = fixture.agentIds[1]!;
    await startParent(fixture, parentId, parentAgent);
    await publishChild(fixture, parentId, childId, parentAgent, childAgent);
    await expect
      .poll(async () => {
        const receipt = await fixture.native.request({ kind: 'receipt', actionId: childId });
        return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
      })
      .toBe('acknowledged');
    await finishNative(
      fixture,
      parentAgent,
      parentOutcome(parentId, 'waiting-children', [childId]),
    );
    await expect
      .poll(async () => (await readRequest(fixture, parentId)).state)
      .toBe('waiting-children');
    const status = await fixture.native.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('Missing epoch');
    await fixture.native.request({
      kind: 'action',
      action: {
        id: ordinaryId,
        runtimeEpoch: status.result.runtimeEpoch,
        command: {
          kind: 'message',
          threadId: parentAgent,
          input: { kind: 'text', text: 'Unrelated host-selected work.' },
        },
      },
    });
    await expect
      .poll(async () => {
        const receipt = await fixture.native.request({ kind: 'receipt', actionId: ordinaryId });
        return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
      })
      .toBe('acknowledged');
    await finishNative(fixture, childAgent, parentOutcome(childId, 'failed'));
    await expect
      .poll(async () => (await readRequest(fixture, parentId)).dispatchBlockedReason)
      .toBe('busy');
    const reservation = (await readRequest(fixture, parentId)).continuationActionId;
    await fixture.call({
      kind: 'request-collect',
      id: randomUUID(),
      taskId: fixture.taskId,
      requestId: childId,
      actionId: childId,
    });
    expect(await readRequest(fixture, parentId)).toMatchObject({
      dispatchCount: 1,
      continuationActionId: reservation,
    });
    await finishNative(fixture, parentAgent, {
      requestId: null,
      outcome: 'completed',
      report: 'Ordinary host work finished.',
      requiredAuthority: null,
      childRequestIds: [],
    });
    await expect.poll(async () => (await readRequest(fixture, parentId)).dispatchCount).toBe(2);
    const verified = await fixture.call(
      { kind: 'invocation-read', taskId: fixture.taskId },
      { kind: 'agent', agentId: parentAgent },
    );
    expect(verified).toMatchObject({
      kind: 'invocation',
      invocation: {
        actionId: reservation,
        continuation: {
          kind: 'terminal-results',
          children: [{ requestId: childId, outcome: 'failed' }],
        },
      },
    });
  }));

test('a pending continuation survives restart with the same identity and requires explicit native reattachment', async () =>
  withCollaboration(async (fixture) => {
    const parentId = randomUUID(),
      childId = randomUUID();
    const parentAgent = fixture.agentIds[0]!,
      childAgent = fixture.agentIds[1]!;
    await startParent(fixture, parentId, parentAgent);
    await publishChild(fixture, parentId, childId, parentAgent, childAgent);
    await expect
      .poll(async () => {
        const receipt = await fixture.native.request({ kind: 'receipt', actionId: childId });
        return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
      })
      .toBe('acknowledged');
    await finishNative(
      fixture,
      parentAgent,
      parentOutcome(parentId, 'waiting-children', [childId]),
    );
    await expect
      .poll(async () => (await readRequest(fixture, parentId)).state)
      .toBe('waiting-children');
    await fixture.call({
      kind: 'agent-state-set',
      id: randomUUID(),
      taskId: fixture.taskId,
      agentId: parentAgent,
      expectedRevision: 1,
      state: 'paused',
    });
    await finishNative(fixture, childAgent, parentOutcome(childId, 'completed'));
    await expect
      .poll(async () => (await readRequest(fixture, parentId)).dispatchBlockedReason)
      .toBe('agent-paused');
    const reservation = (await readRequest(fixture, parentId)).continuationActionId;
    await fixture.native.runtime.close();
    // A restarted native process must not reuse the fixture's first process-local turn ID.
    await writeFixtureControl(fixture.native.root, 'control.json', {
      holdTurn: true,
      turnPrefix: 'reattached-',
    });
    const runtime = await createAgentHq({
      stateRoot: fixture.native.stateRoot,
      allowedRoots: [fixture.native.workspaceRoot],
    });
    try {
      const call = (command: Parameters<ICollaborationFixture['call']>[0]) =>
        fixture.call(command, fixture.host, runtime);
      const before = await call({
        kind: 'request-read',
        taskId: fixture.taskId,
        requestId: parentId,
      });
      expect(before).toMatchObject({
        kind: 'request',
        request: { state: 'waiting-children', dispatchCount: 1, continuationActionId: reservation },
      });
      await call({
        kind: 'request-resume',
        id: randomUUID(),
        taskId: fixture.taskId,
        requestId: parentId,
        expectedActionId: parentId,
        expectedAgentRevision: 2,
        expectedTaskRevision: 1,
        body: 'Resume the same recorded wait.',
      });
      await expect
        .poll(async () => {
          const response = await call({
            kind: 'request-read',
            taskId: fixture.taskId,
            requestId: parentId,
          });
          return response.kind === 'request' ? response.request.dispatchBlockedReason : null;
        })
        .toBe('ownership-uncertain');
      const status = await runtime.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing epoch');
      const actionId = randomUUID();
      await runtime.request({
        kind: 'action',
        action: {
          id: actionId,
          runtimeEpoch: status.result.runtimeEpoch,
          command: {
            kind: 'thread-resume',
            threadId: parentAgent,
            operatorConfirmation:
              'The prior HQ controller is closed; reattach this exact idle session.',
          },
        },
      });
      await expect
        .poll(async () => {
          const response = await call({
            kind: 'request-read',
            taskId: fixture.taskId,
            requestId: parentId,
          });
          return response.kind === 'request' ? response.request.dispatchCount : null;
        })
        .toBe(2);
      // the dispatch is counted when the action is reserved; native acceptance acknowledges it later
      await expect
        .poll(async () => {
          const receipt = await runtime.request({ kind: 'receipt', actionId: reservation! });
          return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
        })
        .toBe('acknowledged');
      const restoredReceipt = await runtime.request({ kind: 'receipt', actionId: reservation! });
      expect(restoredReceipt).toMatchObject({
        kind: 'receipt',
        result: { delivery: 'acknowledged', completion: null, failure: null },
      });
      expect(
        await call({ kind: 'request-read', taskId: fixture.taskId, requestId: parentId }),
      ).toMatchObject({
        kind: 'request',
        request: {
          currentActionId: reservation,
          continuationActionId: reservation,
          waitGeneration: 1,
        },
      });
      expect(
        await call({ kind: 'report-read', taskId: fixture.taskId, reportId: childId }),
      ).toMatchObject({
        kind: 'report',
        result: { text: parentOutcome(childId, 'completed').report },
      });
    } finally {
      await runtime.close();
    }
  }));

test('an uncertain continuation remains bound through duplicate child collection and runtime restart', async () =>
  withCollaboration(async (fixture) => {
    const parentId = randomUUID(),
      childId = randomUUID();
    const parentAgent = fixture.agentIds[0]!,
      childAgent = fixture.agentIds[1]!;
    await startParent(fixture, parentId, parentAgent);
    await publishChild(fixture, parentId, childId, parentAgent, childAgent);
    await expect
      .poll(async () => {
        const receipt = await fixture.native.request({ kind: 'receipt', actionId: childId });
        return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
      })
      .toBe('acknowledged');
    await finishNative(
      fixture,
      parentAgent,
      parentOutcome(parentId, 'waiting-children', [childId]),
    );
    await expect
      .poll(async () => (await readRequest(fixture, parentId)).state)
      .toBe('waiting-children');
    await writeFixtureControl(fixture.native.root, 'control.json', { loseOutput: true });
    await finishNative(fixture, childAgent, parentOutcome(childId, 'completed'));
    await expect.poll(async () => (await readRequest(fixture, parentId)).dispatchCount).toBe(2);
    const reservation = (await readRequest(fixture, parentId)).continuationActionId!;
    await expect
      .poll(async () => {
        const receipt = await fixture.native.request({ kind: 'receipt', actionId: reservation });
        return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
      })
      .toBe('uncertain');
    await fixture.call({
      kind: 'request-collect',
      id: randomUUID(),
      taskId: fixture.taskId,
      requestId: childId,
      actionId: childId,
    });
    expect(await readRequest(fixture, parentId)).toMatchObject({
      state: 'claimed',
      currentActionId: reservation,
      dispatchCount: 2,
    });
    await fixture.native.runtime.close();
    const runtime = await createAgentHq({
      stateRoot: fixture.native.stateRoot,
      allowedRoots: [fixture.native.workspaceRoot],
    });
    try {
      const response = await fixture.call(
        { kind: 'request-read', taskId: fixture.taskId, requestId: parentId },
        fixture.host,
        runtime,
      );
      expect(response).toMatchObject({
        kind: 'request',
        request: {
          state: 'claimed',
          currentActionId: reservation,
          continuationActionId: reservation,
          dispatchCount: 2,
        },
      });
      const collected = await fixture.call(
        {
          kind: 'request-collect',
          id: randomUUID(),
          taskId: fixture.taskId,
          requestId: parentId,
          actionId: reservation,
        },
        fixture.host,
        runtime,
      );
      expect(collected.kind === 'operation' && collected.operation?.result).toMatchObject({
        kind: 'collection',
        collection: null,
      });
      const calls = (await readFile(join(fixture.native.root, 'calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => z.object({ method: z.string() }).parse(JSON.parse(line)));
      expect(calls.filter((call) => call.method === 'turn/start')).toHaveLength(2);
    } finally {
      await runtime.close();
    }
  }));

test.each([false, true])(
  'late child clarification remains pending across generations; dropping a dependency = %s',
  async (dropsDependency) =>
    withCollaboration(async (fixture) => {
      const parentId = randomUUID(),
        firstChild = randomUUID(),
        laterChild = randomUUID();
      const parentAgent = fixture.agentIds[0]!,
        childAgent = fixture.agentIds[1]!;
      await startParent(fixture, parentId, parentAgent);
      await publishChild(fixture, parentId, firstChild, parentAgent, childAgent);
      await publishChild(fixture, parentId, laterChild, parentAgent, childAgent);
      await expect
        .poll(async () => {
          const receipt = await fixture.native.request({ kind: 'receipt', actionId: firstChild });
          return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
        })
        .toBe('acknowledged');
      await finishNative(
        fixture,
        parentAgent,
        parentOutcome(parentId, 'waiting-children', [firstChild, laterChild]),
      );
      await expect
        .poll(async () => (await readRequest(fixture, parentId)).state)
        .toBe('waiting-children');
      await finishNative(
        fixture,
        childAgent,
        parentOutcome(firstChild, 'needs-input', [], 'requester'),
      );
      await expect
        .poll(async () => (await readRequest(fixture, firstChild)).clarificationConsumedActionId)
        .toBe(firstChild);
      await expect
        .poll(async () => {
          const receipt = await fixture.native.request({ kind: 'receipt', actionId: laterChild });
          return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
        })
        .toBe('acknowledged');
      const firstContinuation = (await readRequest(fixture, parentId)).currentActionId;
      await finishNative(
        fixture,
        childAgent,
        parentOutcome(laterChild, 'needs-input', [], 'requester'),
      );
      await expect
        .poll(async () => (await readRequest(fixture, laterChild)).state)
        .toBe('waiting-input');
      expect((await readRequest(fixture, laterChild)).clarificationConsumedActionId).toBeNull();
      expect(await readRequest(fixture, parentId)).toMatchObject({
        dispatchCount: 2,
        currentActionId: firstContinuation,
      });
      await finishNative(
        fixture,
        parentAgent,
        parentOutcome(
          parentId,
          'waiting-children',
          dropsDependency ? [laterChild] : [firstChild, laterChild],
        ),
      );
      if (dropsDependency) {
        await expect
          .poll(async () => (await readRequest(fixture, parentId)).state)
          .toBe('resolved');
        expect(await readRequest(fixture, parentId)).toMatchObject({
          outcome: 'failed',
          failureReason: 'invalid-child-wait',
          dispatchCount: 2,
        });
        return;
      }
      await expect
        .poll(async () => (await readRequest(fixture, laterChild)).clarificationConsumedActionId)
        .toBe(laterChild);
      const next = await fixture.call(
        { kind: 'invocation-read', taskId: fixture.taskId },
        { kind: 'agent', agentId: parentAgent },
      );
      expect(next).toMatchObject({
        kind: 'invocation',
        invocation: {
          continuation: {
            generation: 2,
            kind: 'clarification',
            children: [
              { requestId: firstChild, isClarification: false },
              { requestId: laterChild, isClarification: true },
            ],
          },
        },
      });
      await finishNative(
        fixture,
        parentAgent,
        parentOutcome(parentId, 'waiting-children', [firstChild, laterChild]),
      );
      await expect
        .poll(async () => (await readRequest(fixture, parentId)).state)
        .toBe('waiting-children');
      expect(await readRequest(fixture, parentId)).toMatchObject({
        dispatchCount: 3,
        waitGeneration: 3,
        continuationActionId: null,
        pendingActionId: null,
      });
    }),
);

test('an interrupted child cannot satisfy the wait until explicitly resumed and completed', async () =>
  withCollaboration(async (fixture) => {
    const parentId = randomUUID(),
      childId = randomUUID();
    const parentAgent = fixture.agentIds[0]!,
      childAgent = fixture.agentIds[1]!;
    await startParent(fixture, parentId, parentAgent);
    await publishChild(fixture, parentId, childId, parentAgent, childAgent);
    await expect
      .poll(async () => {
        const receipt = await fixture.native.request({ kind: 'receipt', actionId: childId });
        return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
      })
      .toBe('acknowledged');
    await finishNative(
      fixture,
      parentAgent,
      parentOutcome(parentId, 'waiting-children', [childId]),
    );
    await expect
      .poll(async () => (await readRequest(fixture, parentId)).state)
      .toBe('waiting-children');
    const status = await fixture.native.request({ kind: 'status' });
    const thread = await fixture.native.request({ kind: 'managed-thread', threadId: childAgent });
    if (
      status.kind !== 'status' ||
      thread.kind !== 'managed-thread' ||
      !thread.result?.activeTurnId
    )
      throw new Error('Missing exact native turn');
    await fixture.native.request({
      kind: 'action',
      action: {
        id: randomUUID(),
        runtimeEpoch: status.result.runtimeEpoch,
        command: {
          kind: 'interrupt',
          threadId: childAgent,
          expectedTurnId: thread.result.activeTurnId,
        },
      },
    });
    await expect.poll(async () => (await readRequest(fixture, childId)).state).toBe('interrupted');
    expect(await readRequest(fixture, parentId)).toMatchObject({
      state: 'waiting-children',
      continuationActionId: null,
      dispatchCount: 1,
    });
    const resumeId = randomUUID();
    await fixture.call({
      kind: 'request-resume',
      id: resumeId,
      taskId: fixture.taskId,
      requestId: childId,
      expectedActionId: childId,
      expectedAgentRevision: 1,
      expectedTaskRevision: 1,
      body: 'Explicitly resume the interrupted child review.',
    });
    await expect
      .poll(async () => {
        const receipt = await fixture.native.request({ kind: 'receipt', actionId: resumeId });
        return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
      })
      .toBe('acknowledged');
    await finishNative(fixture, childAgent, parentOutcome(childId, 'completed'));
    await expect.poll(async () => (await readRequest(fixture, parentId)).dispatchCount).toBe(2);
    expect(await readRequest(fixture, childId)).toMatchObject({
      state: 'resolved',
      outcome: 'completed',
      dispatchCount: 2,
      lastReportId: resumeId,
    });
  }));

test('a reserved parent continuation rejects revoked authority until an exact fresh grant is selected', async () =>
  withCollaboration(async (fixture) => {
    const parentId = randomUUID(),
      childId = randomUUID(),
      grantId = randomUUID();
    const parentAgent = fixture.agentIds[0]!,
      childAgent = fixture.agentIds[1]!;
    const issue = (id: string) =>
      fixture.call({
        kind: 'grant-issue',
        id,
        taskId: fixture.taskId,
        eligibleAgentIds: [parentAgent],
        skills: [{ name: 'jg-review', mode: null }],
        effects: ['read'],
        scopes: [{ workspaceRoot: fixture.native.workspaceRoot, pathPrefixes: [''] }],
        plan: null,
      });
    await issue(grantId);
    await writeFixtureControl(fixture.native.root, 'control.json', {
      holdTurn: true,
      skillNames: ['jg-review'],
    });
    await writeFixtureControl(fixture.native.root, 'claude-control.json', { holdTurn: true });
    await fixture.call({
      kind: 'task-policy-set',
      id: randomUUID(),
      taskId: fixture.taskId,
      expectedRevision: 1,
      policy: { ...fixture.policy, automaticDispatch: true },
    });
    await publish(fixture, parentId, parentAgent, ['read'], fixture.host, {
      skill: { name: 'jg-review', mode: null },
      grantId,
      grantRevision: 1,
    });
    await expect
      .poll(async () => {
        const receipt = await fixture.native.request({ kind: 'receipt', actionId: parentId });
        return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
      })
      .toBe('acknowledged');
    await publishChild(fixture, parentId, childId, parentAgent, childAgent);
    await expect
      .poll(async () => {
        const receipt = await fixture.native.request({ kind: 'receipt', actionId: childId });
        return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
      })
      .toBe('acknowledged');
    await finishNative(
      fixture,
      parentAgent,
      parentOutcome(parentId, 'waiting-children', [childId]),
    );
    await expect
      .poll(async () => (await readRequest(fixture, parentId)).state)
      .toBe('waiting-children');
    await fixture.call({
      kind: 'grant-revoke',
      id: randomUUID(),
      taskId: fixture.taskId,
      grantId,
      expectedRevision: 1,
    });
    await finishNative(fixture, childAgent, parentOutcome(childId, 'completed'));
    await expect
      .poll(async () => (await readRequest(fixture, parentId)).dispatchBlockedReason)
      .toBe('grant-invalid');
    const reservation = (await readRequest(fixture, parentId)).continuationActionId;
    expect((await readRequest(fixture, parentId)).dispatchCount).toBe(1);
    const fresh = randomUUID();
    await issue(fresh);
    await expectToRejectCode(
      fixture.call({
        kind: 'request-authorize',
        id: randomUUID(),
        taskId: fixture.taskId,
        requestId: parentId,
        expectedActionId: randomUUID(),
        grantId: fresh,
        grantRevision: 1,
        plan: null,
      }),
      'JG_AGENT_HQ_COLLABORATION_CONFLICT',
    );
    await fixture.call({
      kind: 'request-authorize',
      id: randomUUID(),
      taskId: fixture.taskId,
      requestId: parentId,
      expectedActionId: parentId,
      grantId: fresh,
      grantRevision: 1,
      plan: null,
    });
    await expect.poll(async () => (await readRequest(fixture, parentId)).dispatchCount).toBe(2);
    expect(await readRequest(fixture, parentId)).toMatchObject({
      currentActionId: reservation,
      continuationActionId: reservation,
      specification: { grantId: fresh, grantRevision: 1 },
    });
  }));

test('cross-task publication and wait references cannot substitute another authorized task', async () =>
  withCollaboration(async (fixture) => {
    const parentId = randomUUID(),
      foreignTask = randomUUID(),
      foreignStream = randomUUID(),
      foreignRequest = randomUUID();
    const parentAgent = fixture.agentIds[0]!;
    await startParent(fixture, parentId, parentAgent);
    await fixture.call({
      kind: 'task-create',
      id: foreignTask,
      workspaceRoot: fixture.native.workspaceRoot,
      title: 'A different authorized task',
      policy: fixture.policy,
      plan: null,
    });
    await fixture.call({
      kind: 'agent-add',
      id: randomUUID(),
      taskId: foreignTask,
      agentId: parentAgent,
      parentAgentId: null,
      role: null,
      permissions: fixture.permissions,
    });
    await fixture.call({
      kind: 'stream-create',
      id: foreignStream,
      taskId: foreignTask,
      title: 'Other work',
      purpose: 'Task isolation',
    });
    const publication = {
      kind: 'message-publish' as const,
      id: foreignRequest,
      taskId: foreignTask,
      streamId: foreignStream,
      messageKind: 'request' as const,
      summary: 'Other task request',
      body: 'Stay in this task.',
      references: [],
      replyToMessageId: null,
      request: {
        targetAgentId: parentAgent,
        claimable: false,
        skill: null,
        grantId: null,
        grantRevision: null,
        arguments: '',
        effects: ['read' as const],
        scopes: [{ workspaceRoot: fixture.native.workspaceRoot, pathPrefixes: [''] }],
        plan: null,
        targetReferences: [],
      },
    };
    await expectToRejectCode(
      fixture.call(
        { ...publication, parentRequestId: parentId },
        { kind: 'agent', agentId: parentAgent },
      ),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
    await fixture.call(publication);
    await finishNative(
      fixture,
      parentAgent,
      parentOutcome(parentId, 'waiting-children', [foreignRequest]),
    );
    await expect.poll(async () => (await readRequest(fixture, parentId)).state).toBe('resolved');
    expect(await readRequest(fixture, parentId)).toMatchObject({
      outcome: 'failed',
      failureReason: 'invalid-child-wait',
      waitGeneration: 0,
      continuationActionId: null,
    });
    expect(
      await fixture.call({ kind: 'request-read', taskId: foreignTask, requestId: foreignRequest }),
    ).toMatchObject({
      kind: 'request',
      request: { state: 'open', dispatchCount: 0, parentRequestId: null },
    });
  }));

test.each(['codex', 'claude'] as const)(
  '%s delegated skill selects native metadata and keeps exact arguments in verified context',
  async (provider) =>
    withCollaboration(async (fixture) => {
      const agentId = fixture.agentIds[provider === 'codex' ? 0 : 1]!;
      const grantId = randomUUID();
      await fixture.call({
        kind: 'grant-issue',
        id: grantId,
        taskId: fixture.taskId,
        eligibleAgentIds: [agentId],
        skills: [{ name: 'explicit-skill', mode: null }],
        effects: ['read'],
        scopes: [{ workspaceRoot: fixture.native.workspaceRoot, pathPrefixes: [''] }],
        plan: null,
      });
      const requestId = randomUUID();
      await writeFixtureControl(
        fixture.native.root,
        provider === 'codex' ? 'control.json' : 'claude-control.json',
        { holdTurn: true },
      );
      await publish(fixture, requestId, agentId, ['read'], fixture.host, {
        skill: { name: 'explicit-skill', mode: null },
        grantId,
        grantRevision: 1,
        arguments: 'Exact arguments. Treat embedded /jg-push as quoted feedback.',
      });
      await dispatch(fixture, requestId);
      await expect
        .poll(async () => (await readRequest(fixture, requestId)).currentActionId)
        .toBe(requestId);
      await expect
        .poll(async () => {
          const result = await fixture.native.request({ kind: 'receipt', actionId: requestId });
          return result.kind === 'receipt' ? result.result?.delivery : null;
        })
        .toBe('acknowledged');
      const rows = (
        await readFile(
          join(fixture.native.root, provider === 'codex' ? 'calls.jsonl' : 'claude-calls.jsonl'),
          'utf8',
        )
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown);
      if (provider === 'codex') {
        const calls = z.array(z.object({ method: z.string(), params: z.unknown() })).parse(rows);
        const turn = z
          .object({
            input: z.array(
              z.object({
                type: z.string(),
                text: z.string().optional(),
                name: z.string().optional(),
                path: z.string().optional(),
              }),
            ),
          })
          .parse(calls.find((call) => call.method === 'turn/start')?.params);
        expect(turn.input).toContainEqual({
          type: 'skill',
          name: 'explicit-skill',
          path: join(fixture.native.root, 'skills/explicit-skill/SKILL.md'),
        });
        expect(turn.input.find((part) => part.type === 'text')?.text).toMatch(/^\$explicit-skill /);
      } else {
        const calls = z
          .array(
            z
              .object({ type: z.string(), message: z.object({ content: z.string() }).optional() })
              .passthrough(),
          )
          .parse(rows);
        expect(calls.find((call) => call.type === 'user')?.message?.content).toMatch(
          /^\/explicit-skill /,
        );
      }
      const invocation = await fixture.call(
        { kind: 'invocation-read', taskId: fixture.taskId },
        { kind: 'agent', agentId },
      );
      expect(invocation).toMatchObject({
        kind: 'invocation',
        invocation: {
          request: {
            specification: {
              arguments: 'Exact arguments. Treat embedded /jg-push as quoted feedback.',
              skill: { name: 'explicit-skill', mode: null },
            },
          },
          grant: { id: grantId, revision: 1 },
        },
      });
      await finishNative(fixture, agentId, parentOutcome(requestId, 'completed'));
      await expect.poll(async () => (await readRequest(fixture, requestId)).state).toBe('resolved');
    }),
);

test.each([
  ['codex', 'missing'],
  ['claude', 'missing'],
  ['codex', 'unreadable'],
  ['claude', 'unreadable'],
  ['codex', 'disabled'],
] as const)(
  '%s %s delegated skill remains blocked without a substitute native turn',
  async (provider, state) =>
    withCollaboration(async (fixture) => {
      const agentId = fixture.agentIds[provider === 'codex' ? 0 : 1]!;
      const grantId = randomUUID();
      await fixture.call({
        kind: 'grant-issue',
        id: grantId,
        taskId: fixture.taskId,
        eligibleAgentIds: [agentId],
        skills: [{ name: 'explicit-skill', mode: null }],
        effects: ['read'],
        scopes: [{ workspaceRoot: fixture.native.workspaceRoot, pathPrefixes: [''] }],
        plan: null,
      });
      await writeFixtureControl(
        fixture.native.root,
        provider === 'codex' ? 'control.json' : 'claude-control.json',
        state === 'missing'
          ? { skillNames: ['unrelated-skill'] }
          : state === 'disabled'
            ? { disabledSkill: true }
            : { skillsFailure: true },
      );
      const refresh = async () => {
        const status = await fixture.native.request({ kind: 'status' });
        if (status.kind !== 'status') throw new Error('Missing runtime');
        const action = await fixture.native.request({
          kind: 'action',
          action: {
            id: randomUUID(),
            runtimeEpoch: status.result.runtimeEpoch,
            command: { kind: 'skills-reload', threadId: agentId },
          },
        });
        if (action.kind !== 'action') throw new Error('Missing reload action');
        await expect
          .poll(async () => {
            const receipt = await fixture.native.request({
              kind: 'receipt',
              actionId: action.result.id,
            });
            return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
          })
          .toBe('acknowledged');
      };
      if (provider === 'claude') await refresh();
      const requestId = randomUUID();
      await publish(fixture, requestId, agentId, ['read'], fixture.host, {
        skill: { name: 'explicit-skill', mode: null },
        grantId,
        grantRevision: 1,
      });
      await dispatch(fixture, requestId);
      await expect
        .poll(async () => (await readRequest(fixture, requestId)).dispatchBlockedReason)
        .toBe('skill-unavailable');
      expect(await readRequest(fixture, requestId)).toMatchObject({
        dispatchCount: 0,
        pendingActionId: requestId,
        currentActionId: null,
      });
      expect(await fixture.native.request({ kind: 'receipt', actionId: requestId })).toStrictEqual({
        kind: 'receipt',
        result: null,
      });
      await writeFixtureControl(
        fixture.native.root,
        provider === 'codex' ? 'control.json' : 'claude-control.json',
        { autoComplete: true, structuredOutput: parentOutcome(requestId, 'completed') },
      );
      if (provider === 'claude') await refresh();
      else await dispatch(fixture, requestId);
      await expect.poll(async () => (await readRequest(fixture, requestId)).state).toBe('resolved');
      if (provider === 'claude')
        await expectToRejectCode(
          dispatch(fixture, requestId),
          'JG_AGENT_HQ_COLLABORATION_CONFLICT',
        );
      expect(await readRequest(fixture, requestId)).toMatchObject({
        dispatchCount: 1,
        outcome: 'completed',
      });
    }),
);
