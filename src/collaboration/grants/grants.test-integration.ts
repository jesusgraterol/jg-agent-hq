import { randomUUID } from 'node:crypto';
import type { ICollaborationPlan, IRequestSpecification } from 'jg-agent-hq/contracts';
import { expectToRejectCode } from 'jg-exception/testing';
import { expect, test } from 'vitest';

import { withCollaboration } from '../../../scripts/test-support/index.js';

test.each([
  'scope',
  'sibling-path',
  'skill',
  'mode',
  'revision',
  'eligible-agent',
  'plan',
  'auto-effects',
] as const)('grant publication rejects %s outside its exact host authority', async (caseName) =>
  withCollaboration(async (fixture) => {
    const { taskId, streamId, call, agentIds, native } = fixture;
    const plan: ICollaborationPlan = {
      planId: 'selected-plan',
      directory: native.workspaceRoot,
      revision: { planDigest: 'a'.repeat(64), breakdownDigest: null },
      milestoneIds: [randomUUID()],
    };
    const grantId = randomUUID();
    await call({
      kind: 'grant-issue',
      id: grantId,
      taskId,
      eligibleAgentIds: [agentIds[0]!],
      skills: [
        {
          name: caseName === 'auto-effects' ? 'jg-execute' : 'jg-review',
          mode: caseName === 'auto-effects' ? 'auto' : null,
        },
      ],
      effects: ['read'],
      scopes: [{ workspaceRoot: native.workspaceRoot, pathPrefixes: ['src'] }],
      plan,
    });
    const request: IRequestSpecification = {
      targetAgentId: agentIds[0]!,
      claimable: false,
      skill: {
        name: caseName === 'auto-effects' ? 'jg-execute' : 'jg-review',
        mode: caseName === 'auto-effects' ? 'auto' : null,
      },
      grantId,
      grantRevision: 1,
      arguments: 'Selected exact work',
      effects: ['read'],
      scopes: [{ workspaceRoot: native.workspaceRoot, pathPrefixes: ['src/parser'] }],
      plan,
      targetReferences: [],
    };
    switch (caseName) {
      case 'scope':
        request.scopes[0]!.pathPrefixes = [''];
        break;
      case 'sibling-path':
        request.scopes[0]!.pathPrefixes = ['src-other'];
        break;
      case 'skill':
        request.skill = { name: 'jg-plan', mode: null };
        break;
      case 'mode':
        request.skill = { name: 'jg-review', mode: 'auto' };
        break;
      case 'revision':
        request.grantRevision = 2;
        break;
      case 'eligible-agent':
        request.targetAgentId = agentIds[1]!;
        break;
      case 'plan':
        request.plan = { ...plan, revision: { planDigest: 'b'.repeat(64), breakdownDigest: null } };
        break;
      case 'auto-effects':
        break;
    }
    await expectToRejectCode(
      call({
        kind: 'message-publish',
        id: randomUUID(),
        taskId,
        streamId,
        messageKind: 'request',
        summary: 'Review',
        body: 'Selected context',
        references: [],
        replyToMessageId: null,
        request,
      }),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
    const messages = await call({ kind: 'messages-list', taskId });
    expect(messages.kind === 'messages' && messages.data).toStrictEqual([]);
  }),
);

test('a valid skill request is rechecked after grant revocation and task-policy narrowing', async () =>
  withCollaboration(async (fixture) => {
    const { taskId, streamId, call, agentIds, native, policy } = fixture;
    const grantId = randomUUID();
    const grantCommand = {
      kind: 'grant-issue' as const,
      id: grantId,
      taskId,
      eligibleAgentIds: [agentIds[0]!],
      skills: [{ name: 'jg-review', mode: null }],
      effects: ['read' as const],
      scopes: [{ workspaceRoot: native.workspaceRoot, pathPrefixes: ['src'] }],
      plan: null,
    };
    const receipt = await call(grantCommand);
    expect(await call(grantCommand)).toStrictEqual(receipt);
    const request: IRequestSpecification = {
      targetAgentId: agentIds[0]!,
      claimable: false,
      skill: { name: 'jg-review', mode: null },
      grantId,
      grantRevision: 1,
      arguments: 'Review',
      effects: ['read'],
      scopes: [{ workspaceRoot: native.workspaceRoot, pathPrefixes: ['src/parser'] }],
      plan: null,
      targetReferences: [],
    };
    const requestId = randomUUID();
    await call({
      kind: 'message-publish',
      id: requestId,
      taskId,
      streamId,
      messageKind: 'request',
      summary: 'Review',
      body: 'Review exact target',
      references: [],
      replyToMessageId: null,
      request,
    });
    const revoke = {
      kind: 'grant-revoke' as const,
      id: randomUUID(),
      taskId,
      grantId,
      expectedRevision: 1,
    };
    const revoked = await call(revoke);
    expect(await call(revoke)).toStrictEqual(revoked);
    await expectToRejectCode(
      call(
        { kind: 'request-claim', id: randomUUID(), taskId, requestId },
        { kind: 'agent', agentId: agentIds[0]! },
      ),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
    const grant = await call({ kind: 'grant-read', taskId, grantId });
    expect(grant.kind === 'grant' && grant.grant.revision).toBe(2);
    expect(grant.kind === 'grant' && grant.grant.revokedAt).not.toBeNull();
    const taskOther = randomUUID();
    await call({
      kind: 'task-create',
      id: taskOther,
      workspaceRoot: native.workspaceRoot,
      title: 'Separate task',
      policy,
      plan: null,
    });
    await expectToRejectCode(
      call({ kind: 'grant-read', taskId: taskOther, grantId }),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
    const plainId = randomUUID();
    await call({
      kind: 'message-publish',
      id: plainId,
      taskId,
      streamId,
      messageKind: 'request',
      summary: 'Read',
      body: 'No skill requirement',
      references: [],
      replyToMessageId: null,
      request: { ...request, skill: null, grantId: null, grantRevision: null },
    });
    await call({
      kind: 'task-policy-set',
      id: randomUUID(),
      taskId,
      expectedRevision: 1,
      policy: { ...policy, canExecuteRequests: false },
    });
    await expectToRejectCode(
      call(
        { kind: 'request-claim', id: randomUUID(), taskId, requestId: plainId },
        { kind: 'agent', agentId: agentIds[0]! },
      ),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
    const pending = await call({ kind: 'request-read', taskId, requestId: plainId });
    expect(pending.kind === 'request' && pending.request.state).toBe('open');
  }));

test('claimable skill work checks each claimant eligibility and peer subscriptions need current permission', async () =>
  withCollaboration(async (fixture) => {
    const { taskId, streamId, call, agentIds, native, permissions } = fixture;
    const grantId = randomUUID();
    await call({
      kind: 'grant-issue',
      id: grantId,
      taskId,
      eligibleAgentIds: [agentIds[0]!],
      skills: [{ name: 'jg-review', mode: null }],
      effects: ['read'],
      scopes: [{ workspaceRoot: native.workspaceRoot, pathPrefixes: [''] }],
      plan: null,
    });
    for (const agentId of agentIds)
      await call(
        {
          kind: 'subscription-set',
          id: randomUUID(),
          taskId,
          streamId,
          agentId,
          isActive: true,
          notify: false,
        },
        { kind: 'agent', agentId },
      );
    const requestId = randomUUID();
    await call({
      kind: 'message-publish',
      id: requestId,
      taskId,
      streamId,
      messageKind: 'request',
      summary: 'Review',
      body: 'Claimable',
      references: [],
      replyToMessageId: null,
      request: {
        targetAgentId: null,
        claimable: true,
        skill: { name: 'jg-review', mode: null },
        grantId,
        grantRevision: 1,
        arguments: 'Review',
        effects: ['read'],
        scopes: [{ workspaceRoot: native.workspaceRoot, pathPrefixes: ['src'] }],
        plan: null,
        targetReferences: [],
      },
    });
    await expectToRejectCode(
      call(
        { kind: 'request-claim', id: randomUUID(), taskId, requestId },
        { kind: 'agent', agentId: agentIds[1]! },
      ),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
    await call(
      { kind: 'request-claim', id: randomUUID(), taskId, requestId },
      { kind: 'agent', agentId: agentIds[0]! },
    );
    await call({
      kind: 'agent-policy-set',
      id: randomUUID(),
      taskId,
      agentId: agentIds[0]!,
      expectedRevision: 1,
      permissions: { ...permissions, canManagePeerSubscriptions: false },
    });
    await expectToRejectCode(
      call(
        {
          kind: 'subscription-set',
          id: randomUUID(),
          taskId,
          streamId,
          agentId: agentIds[1]!,
          isActive: false,
          notify: false,
        },
        { kind: 'agent', agentId: agentIds[0]! },
      ),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
    await call({
      kind: 'agent-revoke',
      id: randomUUID(),
      taskId,
      agentId: agentIds[0]!,
      expectedRevision: 2,
    });
    await expectToRejectCode(
      call({ kind: 'messages-list', taskId }, { kind: 'agent', agentId: agentIds[0]! }),
      'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    );
  }));
