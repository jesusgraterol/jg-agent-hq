import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createAgentHq, requestAgentHq } from 'jg-agent-hq';
import {
  CollaborationRequestSchema,
  type ICollaborationActor,
  type IRequestSpecification,
  type ICollaborationResponse,
} from 'jg-agent-hq/contracts';
import { expectToRejectCode } from 'jg-exception/testing';
import { expect, test } from 'vitest';

import { withCollaboration, type ICollaborationFixture } from '../../scripts/test-support/index.js';

const agent = (agentId: string): ICollaborationActor => ({ kind: 'agent', agentId });
const evidence = [
  { kind: 'repository' as const, workspaceRoot: '', path: 'src/result.ts', sha256: 'a'.repeat(64) },
];
const result = (response: ICollaborationResponse) => {
  if (response.kind !== 'operation' || response.operation === null)
    throw new Error('Missing metadata receipt');
  return response.operation.result;
};
const publish = (
  fixture: ICollaborationFixture,
  request: IRequestSpecification | null = null,
  actor = fixture.host,
) =>
  fixture.call(
    {
      kind: 'message-publish',
      id: randomUUID(),
      taskId: fixture.taskId,
      streamId: fixture.streamId,
      messageKind: request ? 'request' : 'information',
      summary: 'Review the parser',
      body: 'Exact bounded payload: parser invariant',
      references: [],
      replyToMessageId: null,
      request,
    },
    actor,
  );
const specification = (
  fixture: ICollaborationFixture,
  targetAgentId: string | null,
): IRequestSpecification => ({
  targetAgentId,
  claimable: targetAgentId === null,
  skill: null,
  grantId: null,
  grantRevision: null,
  arguments: 'Review without changes',
  effects: ['read'],
  scopes: [{ workspaceRoot: fixture.native.workspaceRoot, pathPrefixes: ['src'] }],
  plan: null,
  targetReferences: [],
});

test('a failed metadata receipt rolls back its message, request and direct delivery together', async () =>
  withCollaboration(async (fixture) => {
    const { call, taskId, streamId, native, agentIds } = fixture;
    const command = {
      kind: 'message-publish' as const,
      id: randomUUID(),
      taskId,
      streamId,
      messageKind: 'request' as const,
      summary: 'Atomic review',
      body: 'Exact selected context',
      references: [],
      replyToMessageId: null,
      request: specification(fixture, agentIds[0]!),
    };
    await native.runtime.withStorageMaintenance(async ({ databasePath }) => {
      const database = new DatabaseSync(databasePath);
      try {
        database.exec(
          "CREATE TRIGGER fixture_fail_operation BEFORE INSERT ON hq_collaboration_operation BEGIN SELECT RAISE(ABORT, 'Injected receipt failure'); END",
        );
      } finally {
        database.close();
      }
    });
    await expectToRejectCode(call(command), 'JG_AGENT_HQ_STORE_FAILED');
    expect(await call({ kind: 'operation-read', taskId, operationId: command.id })).toStrictEqual({
      kind: 'operation',
      operation: null,
    });
    await expectToRejectCode(
      call({ kind: 'message-read', taskId, messageId: command.id }),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
    await expectToRejectCode(
      call({ kind: 'request-read', taskId, requestId: command.id }),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
    const deliveries = await call({ kind: 'deliveries-list', taskId });
    expect(deliveries.kind === 'deliveries' && deliveries.data).toStrictEqual([]);
    await native.runtime.withStorageMaintenance(async ({ databasePath }) => {
      const database = new DatabaseSync(databasePath);
      try {
        database.exec('DROP TRIGGER fixture_fail_operation');
      } finally {
        database.close();
      }
    });
    const accepted = await call(command);
    expect(await call(command)).toStrictEqual(accepted);
    const requests = await call({
      kind: 'requests-list',
      taskId,
      agentId: agentIds[0]!,
      state: 'open',
      limit: 1,
    });
    expect(
      requests.kind === 'requests' && requests.data.map((request) => request.id),
    ).toStrictEqual([command.id]);
    expect(requests.kind === 'requests' && requests.nextCursor).toBeNull();
  }));

test('publication derives its author, persists exact replay, and enforces owner/task boundaries', async () =>
  withCollaboration(async (fixture) => {
    const { taskId, streamId, call, agentIds } = fixture;
    const actor = agent(agentIds[0]!);
    const command = {
      kind: 'message-publish' as const,
      id: randomUUID(),
      taskId,
      streamId,
      messageKind: 'information' as const,
      summary: 'Review parser',
      body: 'Precise evidence',
      references: [],
      replyToMessageId: null,
      request: null,
    };
    const first = await call(command, actor);
    expect(await call({ ...command }, actor)).toStrictEqual(first);
    const publication = result(first);
    expect(publication.kind).toBe('publication');
    if (publication.kind !== 'publication') throw new Error('Missing publication');
    expect(publication.message.author).toStrictEqual(actor);
    expect(publication.request).toBeNull();
    await expectToRejectCode(
      call({ ...command, body: 'Changed' }, actor),
      'JG_AGENT_HQ_COLLABORATION_CONFLICT',
    );
    await expectToRejectCode(
      call({ kind: 'task-read', taskId }, { kind: 'host', operatorRef: 'another-owner' }),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
    await expectToRejectCode(
      call({ kind: 'task-read', taskId: randomUUID() }, actor),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
    await expectToRejectCode(
      call(
        {
          kind: 'grant-issue',
          id: randomUUID(),
          taskId,
          eligibleAgentIds: null,
          skills: [{ name: 'jg-review', mode: null }],
          effects: ['read'],
          scopes: [{ workspaceRoot: fixture.native.workspaceRoot, pathPrefixes: [''] }],
          plan: null,
        },
        actor,
      ),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
    expect(
      CollaborationRequestSchema.safeParse({
        kind: 'collaboration',
        actor,
        command: { ...command, senderAgentId: agentIds[1] },
      }).success,
    ).toBe(false);
    const wire = await requestAgentHq(fixture.native.stateRoot, {
      kind: 'collaboration',
      actor,
      command: { kind: 'message-read', taskId, messageId: command.id },
    });
    expect(wire.kind).toBe('collaboration');
    if (wire.kind !== 'collaboration' || wire.result.kind !== 'message')
      throw new Error('Missing selected body');
    expect(wire.result.result.body).toBe('Precise evidence');
    await expectToRejectCode(
      requestAgentHq(fixture.native.stateRoot, {
        kind: 'collaboration',
        actor: { kind: 'host', operatorRef: 'another-owner' },
        command: { kind: 'task-read', taskId },
      }),
      'JG_AGENT_HQ_CLIENT_ACCESS_DENIED',
    );
  }));

test('broadcast notifications do not assign work; claims, reads, acknowledgements and resolutions remain distinct', async () =>
  withCollaboration(async (fixture) => {
    const { call, taskId, streamId, agentIds } = fixture;
    for (const id of agentIds)
      await call(
        {
          kind: 'subscription-set',
          id: randomUUID(),
          taskId,
          streamId,
          agentId: id,
          isActive: true,
          notify: true,
        },
        agent(id),
      );
    const information = result(await publish(fixture));
    const request = result(await publish(fixture, specification(fixture, null)));
    if (information.kind !== 'publication' || request.kind !== 'publication')
      throw new Error('Missing publications');
    expect(information.request).toBeNull();
    const requestId = request.message.id;
    const claims = await Promise.allSettled(
      agentIds.map((id) =>
        call({ kind: 'request-claim', id: randomUUID(), taskId, requestId }, agent(id)),
      ),
    );
    expect(claims.filter((claim) => claim.status === 'fulfilled')).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === 'rejected')).toHaveLength(1);
    const current = await call({ kind: 'request-read', taskId, requestId });
    if (current.kind !== 'request' || current.request.assigneeAgentId === null)
      throw new Error('Missing assignee');
    const assignee = current.request.assigneeAgentId;
    await call({ kind: 'message-read', taskId, messageId: requestId }, agent(assignee));
    await call(
      {
        kind: 'subscription-advance',
        id: randomUUID(),
        taskId,
        streamId,
        throughSequence: request.message.sequence,
      },
      agent(assignee),
    );
    const acknowledged = result(
      await call(
        { kind: 'message-ack', id: randomUUID(), taskId, messageId: requestId },
        agent(assignee),
      ),
    );
    if (acknowledged.kind !== 'delivery') throw new Error('Missing acknowledgement');
    expect(acknowledged.delivery.acknowledgedAt).not.toBeNull();
    expect(acknowledged.delivery.deliveredAt).toBeNull();
    expect(acknowledged.delivery.nativeActionId).toBeNull();
    const stillClaimed = await call({ kind: 'request-read', taskId, requestId });
    expect(stillClaimed.kind === 'request' && stillClaimed.request.state).toBe('claimed');
    await call(
      {
        kind: 'subscription-set',
        id: randomUUID(),
        taskId,
        streamId,
        agentId: assignee,
        isActive: false,
        notify: false,
      },
      agent(assignee),
    );
    await call({ kind: 'stream-archive', id: randomUUID(), taskId, streamId, isArchived: true });
    await expectToRejectCode(publish(fixture), 'JG_AGENT_HQ_COLLABORATION_CONFLICT');
    await call(
      {
        kind: 'message-publish',
        id: randomUUID(),
        taskId,
        streamId,
        messageKind: 'reply',
        summary: 'Review findings',
        body: 'No issue found',
        references: [],
        replyToMessageId: requestId,
        request: null,
      },
      agent(assignee),
    );
    const completed = result(
      await call(
        {
          kind: 'request-resolve',
          id: randomUUID(),
          taskId,
          requestId,
          outcome: 'completed',
          references: evidence.map((reference) => ({
            ...reference,
            workspaceRoot: fixture.native.workspaceRoot,
          })),
        },
        agent(assignee),
      ),
    );
    expect(completed.kind === 'request' && completed.request.state).toBe('resolved');
    await expectToRejectCode(
      call({ kind: 'request-claim', id: randomUUID(), taskId, requestId }, agent(assignee)),
      'JG_AGENT_HQ_COLLABORATION_CONFLICT',
    );
  }));

test('directed requests survive unsubscribe, pause, cancellation and deliberate reassignment', async () =>
  withCollaboration(async (fixture) => {
    const { call, taskId, streamId, agentIds } = fixture;
    const first = agentIds[0]!;
    const second = agentIds[1]!;
    const publication = result(await publish(fixture, specification(fixture, first)));
    if (publication.kind !== 'publication') throw new Error('Missing request');
    const requestId = publication.message.id;
    await expectToRejectCode(
      call({ kind: 'request-claim', id: randomUUID(), taskId, requestId }, agent(second)),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
    await call({
      kind: 'agent-state-set',
      id: randomUUID(),
      taskId,
      agentId: first,
      expectedRevision: 1,
      state: 'paused',
    });
    await expectToRejectCode(
      call({ kind: 'request-claim', id: randomUUID(), taskId, requestId }, agent(first)),
      'JG_AGENT_HQ_COLLABORATION_CONFLICT',
    );
    const retained = await call({ kind: 'deliveries-list', taskId }, agent(first));
    expect(
      retained.kind === 'deliveries' && retained.data.map((delivery) => delivery.messageId),
    ).toStrictEqual([requestId]);
    await call(
      {
        kind: 'subscription-set',
        id: randomUUID(),
        taskId,
        streamId,
        agentId: first,
        isActive: false,
        notify: false,
      },
      agent(first),
    );
    await call({
      kind: 'request-reassign',
      id: randomUUID(),
      taskId,
      requestId,
      expectedAssigneeAgentId: null,
      targetAgentId: second,
    });
    await call({ kind: 'request-claim', id: randomUUID(), taskId, requestId }, agent(second));
    const canceled = result(
      await call({ kind: 'request-cancel', id: randomUUID(), taskId, requestId }, agent(second)),
    );
    expect(canceled.kind === 'request' && canceled.request.state).toBe('canceled');
    const stream = await call({ kind: 'messages-list', taskId, streamId }, agent(first));
    expect(stream.kind === 'messages' && stream.data.map((message) => message.id)).toStrictEqual([
      requestId,
    ]);
  }));

test('indexed search and summary pages preserve exact scope and high-water continuation', async () =>
  withCollaboration(async (fixture) => {
    const { call, taskId, streamId, agentIds, native, policy } = fixture;
    const ids: string[] = [];
    for (let index = 0; index < 65; index += 1) {
      const publication = result(await publish(fixture));
      if (publication.kind !== 'publication') throw new Error('Missing publication');
      ids.push(publication.message.id);
    }
    const first = await call(
      { kind: 'messages-list', taskId, streamId, limit: 32 },
      agent(agentIds[0]!),
    );
    if (first.kind !== 'messages' || !first.nextCursor)
      throw new Error('Missing first continuation');
    expect(first.data.map((message) => message.id)).toStrictEqual(ids.slice(-32).reverse());
    expect(first.data.every((message) => !('body' in message))).toBe(true);
    await publish(fixture);
    const second = await call(
      { kind: 'messages-list', taskId, streamId, limit: 32, cursor: first.nextCursor },
      agent(agentIds[0]!),
    );
    if (second.kind !== 'messages' || !second.nextCursor)
      throw new Error('Missing second continuation');
    const final = await call(
      { kind: 'messages-list', taskId, streamId, limit: 32, cursor: second.nextCursor },
      agent(agentIds[0]!),
    );
    expect(final.kind === 'messages' && final.data.map((message) => message.id)).toStrictEqual([
      ids[0],
    ]);
    expect(final.kind === 'messages' && final.nextCursor).toBeNull();
    await expectToRejectCode(
      call(
        { kind: 'messages-list', taskId, limit: 32, cursor: first.nextCursor },
        agent(agentIds[0]!),
      ),
      'JG_AGENT_HQ_CURSOR_INVALID',
    );
    await expectToRejectCode(
      call(
        { kind: 'messages-list', taskId, streamId, limit: 32, cursor: first.nextCursor },
        agent(agentIds[1]!),
      ),
      'JG_AGENT_HQ_CURSOR_INVALID',
    );
    await expectToRejectCode(
      call({ kind: 'messages-list', taskId, cursor: 'malformed' }),
      'JG_AGENT_HQ_CURSOR_INVALID',
    );
    const otherTaskId = randomUUID();
    const otherStreamId = randomUUID();
    await call({
      kind: 'task-create',
      id: otherTaskId,
      workspaceRoot: native.workspaceRoot,
      title: 'Private separate task',
      policy,
      plan: null,
    });
    await call({
      kind: 'stream-create',
      id: otherStreamId,
      taskId: otherTaskId,
      title: 'Private',
      purpose: 'Isolated',
    });
    await call({
      kind: 'message-publish',
      id: randomUUID(),
      taskId: otherTaskId,
      streamId: otherStreamId,
      messageKind: 'information',
      summary: 'parser invariant',
      body: 'Another task only',
      references: [],
      replyToMessageId: null,
      request: null,
    });
    const search = await call({
      kind: 'messages-search',
      taskId,
      streamId,
      query: 'parser invariant',
      limit: 32,
    });
    expect(search.kind === 'messages' && search.data).toHaveLength(32);
    expect(
      search.kind === 'messages' &&
        search.data.every((message) => message.taskId === taskId && message.streamId === streamId),
    ).toBe(true);
    expect(search.kind === 'messages' && search.nextCursor).not.toBeNull();
    const injected = await call({
      kind: 'messages-search',
      taskId,
      query: '" OR task_token : "' + otherTaskId.replaceAll('-', '') + '"',
    });
    expect(injected.kind === 'messages' && injected.data).toStrictEqual([]);
    await expectToRejectCode(
      call({ kind: 'messages-search', taskId, streamId: otherStreamId, query: 'parser' }),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
    const database = new DatabaseSync(native.runtime.storage.databasePath, { readOnly: true });
    try {
      const plan = database
        .prepare(
          `EXPLAIN QUERY PLAN SELECT m.id FROM hq_message_search CROSS JOIN hq_message m WHERE m.sequence = hq_message_search.rowid AND hq_message_search MATCH ? AND m.task_id = ? AND hq_message_search.rowid <= ? AND hq_message_search.rowid < ? ORDER BY hq_message_search.rowid DESC LIMIT 33`,
        )
        .all(
          `task_token : "${taskId.replaceAll('-', '')}" AND {summary body} : "parser"`,
          taskId,
          Number.MAX_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER,
        );
      expect(plan.map((row) => row.detail).join('\n')).not.toContain('USE TEMP B-TREE');
      expect(database.prepare('SELECT count(*) AS count FROM hq_action').get()?.count).toBe(2);
    } finally {
      database.close();
    }
  }));

test('UTF-8 message limits and JSON response budgets preserve exact selected evidence', async () =>
  withCollaboration(async (fixture) => {
    const { call, taskId, streamId } = fixture;
    const id = randomUUID();
    const command = {
      kind: 'message-publish' as const,
      id,
      taskId,
      streamId,
      messageKind: 'information' as const,
      summary: '😀'.repeat(256),
      body: '\u0001'.repeat(8192),
      references: [],
      replyToMessageId: null,
      request: null,
    };
    await call(command);
    const selected = await requestAgentHq(fixture.native.stateRoot, {
      kind: 'collaboration',
      actor: fixture.host,
      command: { kind: 'message-read', taskId, messageId: id },
    });
    expect(Buffer.byteLength(JSON.stringify(selected))).toBeLessThanOrEqual(65_536);
    if (selected.kind !== 'collaboration' || selected.result.kind !== 'message')
      throw new Error('Missing bounded evidence');
    expect(selected.result.result.body).toBe(command.body);
    expect(selected.result.result.message.bodyBytes).toBe(8192);
    expect(selected.result.result.bodyComplete).toBe(true);
    await expectToRejectCode(
      call({ ...command, id: randomUUID(), body: '😀'.repeat(2049) }),
      'JG_AGENT_HQ_REQUEST_INVALID',
    );
    await expectToRejectCode(
      call({ ...command, id: randomUUID(), summary: '😀'.repeat(257) }),
      'JG_AGENT_HQ_REQUEST_INVALID',
    );
    await expectToRejectCode(
      call({ ...command, id: randomUUID(), body: '\ud800' }),
      'JG_AGENT_HQ_REQUEST_INVALID',
    );
    await expectToRejectCode(
      call({
        ...command,
        id: randomUUID(),
        references: [
          {
            kind: 'repository',
            workspaceRoot: fixture.native.workspaceRoot,
            path: '../secret',
            sha256: 'a'.repeat(64),
          },
        ],
      }),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
    const empty = await call({ kind: 'requests-list', taskId });
    expect(empty.kind === 'requests' && empty.data).toStrictEqual([]);
  }));

test('new subscriptions start at current traffic and explicit bounded history is independent of work', async () =>
  withCollaboration(async (fixture) => {
    const { call, taskId, streamId, agentIds, native } = fixture;
    const publications = [];
    for (let index = 0; index < 4; index += 1) publications.push(result(await publish(fixture)));
    await expect
      .poll(async () => {
        const status = await call({ kind: 'status', taskId });
        return status.kind === 'status' ? status.status.pendingFanout.count : -1;
      })
      .toBe(0);
    await call(
      {
        kind: 'subscription-set',
        id: randomUUID(),
        taskId,
        streamId,
        agentId: agentIds[0]!,
        isActive: true,
        notify: true,
      },
      agent(agentIds[0]!),
    );
    const fresh = await call({ kind: 'deliveries-list', taskId }, agent(agentIds[0]!));
    expect(fresh.kind === 'deliveries' && fresh.data).toStrictEqual([]);
    await call(
      {
        kind: 'subscription-set',
        id: randomUUID(),
        taskId,
        streamId,
        agentId: agentIds[1]!,
        isActive: true,
        notify: true,
        historyLimit: 2,
      },
      agent(agentIds[1]!),
    );
    const historical = await call({ kind: 'deliveries-list', taskId }, agent(agentIds[1]!));
    expect(
      historical.kind === 'deliveries' && historical.data.map((delivery) => delivery.messageId),
    ).toStrictEqual(
      publications
        .slice(-2)
        .reverse()
        .map((publication) => (publication.kind === 'publication' ? publication.message.id : null)),
    );
    const subscribed = await call(
      { kind: 'streams-list', taskId, subscribed: true, limit: 1 },
      agent(agentIds[1]!),
    );
    expect(
      subscribed.kind === 'streams' && subscribed.data.map((stream) => stream.id),
    ).toStrictEqual([streamId]);
    const actor = agent(agentIds[0]!);
    const streamOther = randomUUID();
    await call(
      {
        kind: 'stream-create',
        id: streamOther,
        taskId,
        title: 'Agent-owned stream',
        purpose: 'Interest',
      },
      actor,
    );
    await expectToRejectCode(
      call(
        {
          kind: 'stream-archive',
          id: randomUUID(),
          taskId,
          streamId: streamOther,
          isArchived: true,
        },
        agent(agentIds[1]!),
      ),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
    await call(
      { kind: 'stream-archive', id: randomUUID(), taskId, streamId: streamOther, isArchived: true },
      actor,
    );
    const archived = await call({ kind: 'streams-list', taskId, isArchived: true });
    expect(archived.kind === 'streams' && archived.data.map((stream) => stream.id)).toStrictEqual([
      streamOther,
    ]);
    const tasks = await call({ kind: 'tasks-list', workspaceRoot: native.workspaceRoot, limit: 1 });
    expect(tasks.kind === 'tasks' && tasks.data.map((task) => task.id)).toStrictEqual([taskId]);
    const members = await call({ kind: 'agents-list', taskId, limit: 1 });
    if (members.kind !== 'agents' || !members.nextCursor) throw new Error('Missing member page');
    const memberFinal = await call({
      kind: 'agents-list',
      taskId,
      limit: 1,
      cursor: members.nextCursor,
    });
    expect(memberFinal.kind === 'agents' && memberFinal.data).toHaveLength(1);
    expect(memberFinal.kind === 'agents' && memberFinal.nextCursor).toBeNull();
    expect(await call({ kind: 'operation-read', taskId, operationId: randomUUID() })).toStrictEqual(
      { kind: 'operation', operation: null },
    );
  }));

test('lifecycle revisions, narrowed member policy and reinstatement retain explicit authority', async () =>
  withCollaboration(async (fixture) => {
    const { call, taskId, agentIds, policy, permissions } = fixture;
    const agentId = agentIds[0]!;
    await call({
      kind: 'task-state-set',
      id: randomUUID(),
      taskId,
      expectedRevision: 1,
      state: 'paused',
    });
    await expectToRejectCode(
      publish(fixture, null, agent(agentId)),
      'JG_AGENT_HQ_COLLABORATION_CONFLICT',
    );
    await expectToRejectCode(
      call({
        kind: 'task-state-set',
        id: randomUUID(),
        taskId,
        expectedRevision: 1,
        state: 'active',
      }),
      'JG_AGENT_HQ_COLLABORATION_CONFLICT',
    );
    await call({
      kind: 'task-state-set',
      id: randomUUID(),
      taskId,
      expectedRevision: 2,
      state: 'active',
    });
    await call({
      kind: 'agent-policy-set',
      id: randomUUID(),
      taskId,
      agentId,
      expectedRevision: 1,
      permissions: { ...permissions, effects: ['read'] },
    });
    await expectToRejectCode(
      publish(
        fixture,
        { ...specification(fixture, agentIds[1]!), effects: ['workspace-write'] },
        agent(agentId),
      ),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
    await call({ kind: 'agent-revoke', id: randomUUID(), taskId, agentId, expectedRevision: 2 });
    await expectToRejectCode(
      call({
        kind: 'agent-add',
        id: randomUUID(),
        taskId,
        agentId,
        parentAgentId: null,
        role: null,
        permissions,
      }),
      'JG_AGENT_HQ_COLLABORATION_CONFLICT',
    );
    await call({
      kind: 'agent-add',
      id: randomUUID(),
      taskId,
      agentId,
      parentAgentId: null,
      role: null,
      permissions,
      expectedRevision: 3,
    });
    const restored = await call({ kind: 'agent-read', taskId, agentId });
    expect(restored.kind === 'agent' && restored.agent.revision).toBe(4);
    expect(restored.kind === 'agent' && restored.agent.isRevoked).toBe(false);
    await call({
      kind: 'task-policy-set',
      id: randomUUID(),
      taskId,
      expectedRevision: 1,
      policy: { ...policy, providers: ['claude'] },
    });
    await expectToRejectCode(
      publish(fixture, null, agent(agentId)),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
  }));

// The scenario creates 130 real membership/subscription transactions and a second worker lifetime.
test(
  'bounded fan-out retains committed progress through failure and restart without inference',
  { timeout: 20_000 },
  async () =>
    withCollaboration(async (fixture) => {
      const { call, taskId, streamId, native, seedAgents } = fixture;
      const ids = await seedAgents(130);
      for (const agentId of ids)
        await call({
          kind: 'subscription-set',
          id: randomUUID(),
          taskId,
          streamId,
          agentId,
          isActive: true,
          notify: true,
        });
      await native.runtime.withStorageMaintenance(async ({ databasePath }) => {
        const database = new DatabaseSync(databasePath);
        try {
          database.exec(
            `CREATE TRIGGER fixture_fail_delivery BEFORE INSERT ON hq_delivery WHEN (SELECT count(*) FROM hq_delivery) >= 32 BEGIN SELECT RAISE(ABORT, 'Injected fan-out failure'); END`,
          );
        } finally {
          database.close();
        }
      });
      const publication = result(await publish(fixture));
      if (publication.kind !== 'publication') throw new Error('Missing durable publication');
      await expect
        .poll(async () => {
          const response = await call({ kind: 'status', taskId });
          return response.kind === 'status' ? response.status.fanoutFailure : null;
        })
        .toBe('JG_AGENT_HQ_STORE_FAILED');
      const before = new DatabaseSync(native.runtime.storage.databasePath, { readOnly: true });
      try {
        expect(before.prepare('SELECT count(*) AS count FROM hq_delivery').get()?.count).toBe(32);
        expect(
          before
            .prepare('SELECT fanout_complete FROM hq_message WHERE id = ?')
            .get(publication.message.id)?.fanout_complete,
        ).toBe(0);
      } finally {
        before.close();
      }
      await native.runtime.withStorageMaintenance(async ({ databasePath }) => {
        const database = new DatabaseSync(databasePath);
        try {
          database.exec('DROP TRIGGER fixture_fail_delivery');
        } finally {
          database.close();
        }
      });
      await native.runtime.close();
      const restored = await createAgentHq({
        stateRoot: native.stateRoot,
        allowedRoots: [native.workspaceRoot],
      });
      try {
        await expect
          .poll(async () => {
            const response = await call({ kind: 'status', taskId }, fixture.host, restored);
            return response.kind === 'status' ? response.status.pendingFanout.count : -1;
          })
          .toBe(0);
        const status = await call({ kind: 'status', taskId }, fixture.host, restored);
        expect(status.kind === 'status' && status.status.pendingDeliveries).toStrictEqual({
          count: 128,
          hasMore: true,
        });
        const first = await call(
          { kind: 'deliveries-list', taskId, limit: 128 },
          fixture.host,
          restored,
        );
        if (first.kind !== 'deliveries' || !first.nextCursor)
          throw new Error('Missing inbox continuation');
        const last = await call(
          { kind: 'deliveries-list', taskId, limit: 128, cursor: first.nextCursor },
          fixture.host,
          restored,
        );
        expect(last.kind === 'deliveries' && last.data).toHaveLength(2);
        expect(
          first.data.every(
            (delivery) => delivery.deliveredAt === null && delivery.nativeActionId === null,
          ),
        ).toBe(true);
        const database = new DatabaseSync(restored.storage.databasePath, { readOnly: true });
        try {
          expect(database.prepare('SELECT count(*) AS count FROM hq_delivery').get()?.count).toBe(
            130,
          );
          expect(database.prepare('SELECT count(*) AS count FROM hq_action').get()?.count).toBe(2);
        } finally {
          database.close();
        }
        const replay = await call(
          { kind: 'operation-read', taskId, operationId: publication.message.id },
          fixture.host,
          restored,
        );
        expect(replay.kind === 'operation' && replay.operation?.result).toStrictEqual(publication);
      } finally {
        await restored.close();
      }
    }),
);
