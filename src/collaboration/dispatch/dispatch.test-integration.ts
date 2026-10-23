import { randomUUID, createHash } from 'node:crypto';
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expectToRejectCode } from 'jg-exception/testing';
import { createAgentHq } from 'jg-agent-hq';
import { expect, test } from 'vitest';
import { z } from 'zod';

import {
  withCollaboration,
  writeFixtureControl,
  type ICollaborationFixture,
} from '../../../scripts/test-support/index.js';

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
      },
    },
    actor,
  );
};

const dispatch = (fixture: ICollaborationFixture, requestId: string) =>
  fixture.call({ kind: 'request-dispatch', id: randomUUID(), taskId: fixture.taskId, requestId });

test.each(['codex', 'claude'] as const)(
  'directed %s completion stores an exact report without a publishing turn',
  async (provider) =>
    withCollaboration(async (fixture) => {
      const requestId = randomUUID();
      const report = '# Findings\n\nNo mutation was needed.\n';
      const response = { requestId, outcome: 'completed', report, requiredAuthority: null };
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
      requiredAuthority: null,
    }),
  ],
  [
    'invalid-response',
    (requestId: string) => ({
      requestId,
      outcome: 'completed',
      report: 'Wrong authority',
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
      requiredAuthority: null,
    }),
  ],
  [
    'report-invalid-utf8',
    (requestId: string) => ({
      requestId,
      outcome: 'completed',
      report: '\ud800',
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
      structuredOutput: { requestId, outcome: 'completed', report, requiredAuthority: null },
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
      structuredOutput: { requestId, outcome: 'failed', report, requiredAuthority: null },
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
