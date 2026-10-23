import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, readFile, chmod, writeFile, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createAgentHq, requestAgentHq } from 'jg-agent-hq';
import type { IAgentToolResult } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { expectToRejectCode } from 'jg-exception/testing';

import {
  withAgentBridge,
  withCollaboration,
  claudeRecord,
} from '../../../scripts/test-support/index.js';
import { appendFile } from 'node:fs/promises';

const payload = (result: IAgentToolResult) =>
  z.record(z.string(), z.json()).parse(JSON.parse(result.content[0]!.text));

test('credential cleanup failure still closes native controllers and IPC while retaining ownership', async () =>
  withCollaboration(async (fixture) => {
    const stateRoot = join(fixture.native.root, 'cleanup-state');
    const runtime = await createAgentHq({
      stateRoot,
      allowedRoots: [fixture.native.workspaceRoot],
    });
    let obstruction: string | undefined;
    let credentialDirectory: string | undefined;
    try {
      const status = await runtime.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing epoch');
      const created = await runtime.request({
        kind: 'action',
        action: {
          id: randomUUID(),
          runtimeEpoch: status.result.runtimeEpoch,
          command: {
            kind: 'thread-create',
            provider: 'claude',
            name: 'cleanup-fixture',
            workspaceRoot: fixture.native.workspaceRoot,
          },
        },
      });
      if (created.kind !== 'action' || !created.result.threadId) throw new Error('Missing child');
      await expect
        .poll(async () => {
          const receipt = await runtime.request({ kind: 'receipt', actionId: created.result.id });
          return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
        })
        .toBe('acknowledged');
      const secondary = {
        ...fixture,
        agentIds: [fixture.agentIds[0]!, created.result.threadId],
        native: {
          ...fixture.native,
          stateRoot,
          runtime,
          request: (command: Parameters<typeof requestAgentHq>[1]) =>
            requestAgentHq(stateRoot, command),
        },
      };
      await withAgentBridge(secondary, async (bridge) => {
        credentialDirectory = dirname(bridge.filePath);
        obstruction = join(credentialDirectory, 'obstruction.txt');
        await writeFile(obstruction, 'Task-owned cleanup fault');
        await expectToRejectCode(runtime.close(), 'JG_AGENT_HQ_TRANSPORT_FAILED');
        await expect(lstat(bridge.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(lstat(join(stateRoot, 'hq.sock'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await lstat(join(stateRoot, 'hq-owner.json'))).isFile()).toBe(true);
      });
      const pids = (await readFile(join(fixture.native.root, 'claude-pids.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => z.object({ pid: z.number(), child: z.number() }).parse(JSON.parse(line)));
      const pid = pids.at(-1)!;
      for (const processId of [pid.pid, pid.child])
        expect(() => process.kill(processId, 0)).toThrow();
    } finally {
      await runtime.close().catch(() => undefined);
      if (obstruction) await rm(obstruction, { force: true });
      if (credentialDirectory) await rmdir(credentialDirectory);
      // The secondary state root is disposable fixture state; its retained owner is removed by fixture teardown.
    }
  }));

test('identity pages indexed memberships without selecting an ambiguous task or including later inserts', async () =>
  withCollaboration(async (fixture) =>
    withAgentBridge(fixture, async (bridge) => {
      const ids = [fixture.taskId];
      const addTask = async () => {
        const taskId = randomUUID();
        await fixture.call({
          kind: 'task-create',
          id: taskId,
          workspaceRoot: fixture.native.workspaceRoot,
          title: 'Task discovery',
          policy: fixture.policy,
          plan: null,
        });
        await fixture.call({
          kind: 'agent-add',
          id: randomUUID(),
          taskId,
          agentId: fixture.agentIds[1]!,
          parentAgentId: null,
          role: null,
          permissions: fixture.permissions,
        });
        return taskId;
      };
      for (let index = 0; index < 130; index += 1) ids.push(await addTask());
      const identity = z
        .object({
          identity: z.object({
            selectedTask: z.null(),
            tasks: z.array(z.object({ id: z.string() })),
            nextCursor: z.string(),
          }),
        })
        .parse(payload(await bridge.call('hq_identity', { limit: 128 })));
      expect(identity.identity.tasks).toHaveLength(128);
      const later = await addTask();
      const final = z
        .object({
          identity: z.object({
            tasks: z.array(z.object({ id: z.string() })),
            nextCursor: z.null(),
          }),
        })
        .parse(
          payload(
            await bridge.call('hq_identity', { limit: 128, cursor: identity.identity.nextCursor }),
          ),
        );
      expect(final.identity.tasks).toHaveLength(3);
      const visited = [...identity.identity.tasks, ...final.identity.tasks].map((task) => task.id);
      expect(new Set(visited)).toStrictEqual(new Set(ids));
      expect(visited).not.toContain(later);
      expect(
        (await bridge.call('hq_identity', { limit: 32, cursor: identity.identity.nextCursor }))
          .isError,
      ).toBe(true);
      expect(
        payload(await bridge.call('hq_identity', { taskId: fixture.taskId })).identity,
      ).toMatchObject({ selectedTask: { id: fixture.taskId }, agentId: fixture.agentIds[1] });
      await expectToRejectCode(
        requestAgentHq(fixture.native.stateRoot, { kind: 'status' }, AbortSignal.abort()),
        'JG_AGENT_HQ_TRANSPORT_FAILED',
      );
      expect((await fixture.native.request({ kind: 'status' })).kind).toBe('status');
    }),
  ));

test('the installed SDK serves the closed shared catalog and session-derived Claude identity', async () =>
  withCollaboration(async (fixture) =>
    withAgentBridge(fixture, async (bridge) => {
      const tools = z
        .object({
          tools: z.array(
            z.object({ name: z.string(), inputSchema: z.record(z.string(), z.json()) }),
          ),
        })
        .parse(await bridge.request('tools/list'));
      expect(tools.tools).toHaveLength(21);
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['hq_invocation_read', 'hq_report_read', 'hq_request_input']),
      );
      expect(tools.tools.map((tool) => tool.name)).toContain('hq_agent_spawn');
      for (const tool of tools.tools)
        expect(
          Object.keys(z.record(z.string(), z.json()).parse(tool.inputSchema.properties)),
        ).not.toContain('senderAgentId');
      const identity = await bridge.call('hq_identity', {});
      expect(identity.isError).toBe(false);
      expect(payload(identity).identity).toMatchObject({
        agentId: fixture.agentIds[1],
        provider: 'claude',
        selectedTask: { id: fixture.taskId },
        membership: { role: 'developer' },
      });
      expect((await lstat(bridge.filePath)).mode & 0o777).toBe(0o600);
      expect((await lstat(dirname(bridge.filePath))).mode & 0o777).toBe(0o700);
      const denied = await bridge.call('hq_identity', { taskId: randomUUID() });
      expect(denied.isError).toBe(true);
      expect(payload(denied).error).toMatchObject({ kind: 'access-denied' });
    }),
  ));

test('the bridge derives publication authors and pages an inbox until explicit acknowledgement', async () =>
  withCollaboration(async (fixture) =>
    withAgentBridge(fixture, async (bridge) => {
      const selected = { taskId: fixture.taskId, streamId: fixture.streamId };
      await bridge.call('hq_subscription_set', {
        ...selected,
        id: randomUUID(),
        agentId: fixture.agentIds[1],
        isActive: true,
        notify: true,
      });
      const ownId = randomUUID();
      expect(
        (
          await bridge.call('hq_message_publish', {
            ...selected,
            id: ownId,
            messageKind: 'information',
            summary: 'Own publication',
            body: 'Small exact body',
            references: [],
            replyToMessageId: null,
            request: null,
          })
        ).isError,
      ).toBe(false);
      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const id = randomUUID();
        ids.push(id);
        await fixture.call({
          ...selected,
          kind: 'message-publish',
          id,
          messageKind: 'information',
          summary: `Indexed notice ${index}`,
          body: 'Small exact body',
          references: [],
          replyToMessageId: null,
          request: null,
        });
      }
      const first = payload(
        await bridge.call('hq_deliveries_list', { taskId: fixture.taskId, limit: 2 }),
      );
      const rows = z.array(z.object({ messageId: z.string() })).parse(first.data);
      expect(rows).toHaveLength(2);
      expect(first.nextCursor).toEqual(expect.any(String));
      const last = payload(
        await bridge.call('hq_deliveries_list', {
          taskId: fixture.taskId,
          limit: 2,
          cursor: first.nextCursor,
        }),
      );
      expect(z.array(z.object({ messageId: z.string() })).parse(last.data)).toHaveLength(1);
      expect(last.nextCursor).toBeNull();
      const body = payload(
        await bridge.call('hq_message_read', { taskId: fixture.taskId, messageId: ownId }),
      );
      expect(body.result).toMatchObject({
        message: { author: { kind: 'agent', agentId: fixture.agentIds[1] } },
        body: 'Small exact body',
      });
      const before = payload(await bridge.call('hq_identity', { taskId: fixture.taskId }));
      expect(before.pending).toMatchObject({
        unacknowledgedDeliveries: { count: 3, hasMore: false },
      });
      for (const messageId of ids)
        expect(
          (
            await bridge.call('hq_message_ack', {
              id: randomUUID(),
              taskId: fixture.taskId,
              messageId,
            })
          ).isError,
        ).toBe(false);
      expect(
        payload(await bridge.call('hq_deliveries_list', { taskId: fixture.taskId })),
      ).toMatchObject({ data: [], nextCursor: null });
      expect(
        payload(await bridge.call('hq_identity', { taskId: fixture.taskId })).pending,
      ).toMatchObject({ unacknowledgedDeliveries: { count: 0, hasMore: false } });
    }),
  ));

test('concurrent spawn calls reserve the finite task budget transactionally and deduplicate identities', async () =>
  withCollaboration(async (fixture) =>
    withAgentBridge(fixture, async (bridge) => {
      await fixture.call({
        kind: 'task-policy-set',
        id: randomUUID(),
        taskId: fixture.taskId,
        expectedRevision: 1,
        policy: { ...fixture.policy, spawnLimit: 1 },
      });
      const args = {
        id: randomUUID(),
        taskId: fixture.taskId,
        provider: 'codex',
        workspaceRoot: fixture.native.workspaceRoot,
        purpose: 'Review this task',
      };
      const duplicate = await Promise.all([
        bridge.call('hq_agent_spawn', args),
        bridge.call('hq_agent_spawn', args),
      ]);
      expect(duplicate.map((result) => result.isError)).toStrictEqual([false, false]);
      expect(payload(duplicate[0]!).agentId).toBe(payload(duplicate[1]!).agentId);
      const overLimit = await bridge.call('hq_agent_spawn', { ...args, id: randomUUID() });
      expect(overLimit.isError).toBe(true);
      expect(await fixture.call({ kind: 'task-read', taskId: fixture.taskId })).toMatchObject({
        task: { spawnCount: 1 },
      });
      const agents = await fixture.call({ kind: 'agents-list', taskId: fixture.taskId });
      expect(agents.kind === 'agents' && agents.data).toHaveLength(3);
    }),
  ));

test('native session evidence respects current provider and read permissions on a connected bridge', async () =>
  withCollaboration(async (fixture) =>
    withAgentBridge(fixture, async (bridge) => {
      const scope = {
        taskId: fixture.taskId,
        provider: 'codex',
        workspaceRoot: fixture.native.workspaceRoot,
      };
      const sessions = await bridge.call('hq_sessions_list', { ...scope, limit: 2 });
      expect(sessions.isError).toBe(false);
      expect(payload(sessions)).toMatchObject({
        kind: 'sessions',
        result: { data: expect.any(Array), nextCursor: expect.any(String) },
      });
      const selected = { ...scope, nativeId: 'thread-0001', limit: 1 };
      const history = await bridge.call('hq_session_evidence_read', selected);
      expect(history.isError).toBe(false);
      expect(payload(history)).toMatchObject({
        kind: 'session-evidence',
        result: {
          data: [
            expect.objectContaining({
              reference: expect.objectContaining({ provider: 'codex', nativeId: 'thread-0001' }),
              provenance: expect.objectContaining({ grantsAuthority: false }),
            }),
          ],
        },
      });
      await fixture.call({
        kind: 'agent-policy-set',
        id: randomUUID(),
        taskId: fixture.taskId,
        agentId: fixture.agentIds[1]!,
        expectedRevision: 1,
        permissions: { ...fixture.permissions, providers: ['claude'] },
      });
      expect((await bridge.call('hq_sessions_list', scope)).isError).toBe(true);
      expect((await bridge.call('hq_session_evidence_read', selected)).isError).toBe(true);
      await fixture.call({
        kind: 'agent-policy-set',
        id: randomUUID(),
        taskId: fixture.taskId,
        agentId: fixture.agentIds[1]!,
        expectedRevision: 2,
        permissions: { ...fixture.permissions, effects: ['planning-write'] },
      });
      expect(
        (await bridge.call('hq_sessions_list', { ...scope, provider: 'claude' })).isError,
      ).toBe(true);
    }),
  ));

test('membership revocation takes effect on an already connected bridge without exposing credentials', async () =>
  withCollaboration(async (fixture) =>
    withAgentBridge(fixture, async (bridge) => {
      const credential = z
        .object({ credential: z.string() })
        .parse(JSON.parse(await readFile(bridge.filePath, 'utf8'))).credential;
      await fixture.call({
        kind: 'agent-revoke',
        id: randomUUID(),
        taskId: fixture.taskId,
        agentId: fixture.agentIds[1]!,
        expectedRevision: 1,
      });
      const rejected = await bridge.call('hq_streams_list', { taskId: fixture.taskId });
      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected).includes(credential)).toBe(false);
      const forged = await requestAgentHq(fixture.native.stateRoot, {
        kind: 'agent-tool',
        credential: '0'.repeat(64),
        call: { name: 'hq_identity', arguments: {} },
      });
      expect(forged.kind === 'agent-tool' && forged.result.isError).toBe(true);
    }),
  ));

test('restart rotates bridge credentials while resumed native sessions retain their managed identity', async () =>
  withCollaboration(async (fixture) => {
    let staleCredential = '';
    let stalePath = '';
    const spawn = {
      id: randomUUID(),
      taskId: fixture.taskId,
      provider: 'codex',
      workspaceRoot: fixture.native.workspaceRoot,
      purpose: 'Retain the original child across restart',
    };
    let childId = '';
    await withAgentBridge(fixture, async (bridge) => {
      stalePath = bridge.filePath;
      staleCredential = z
        .object({ credential: z.string() })
        .parse(JSON.parse(await readFile(stalePath, 'utf8'))).credential;
      const identity = payload(await bridge.call('hq_identity', {})).identity;
      expect(identity).toMatchObject({ agentId: fixture.agentIds[1] });
      const nativeId = z.object({ nativeId: z.string() }).parse(identity).nativeId;
      await appendFile(
        fixture.native.transcript(nativeId),
        `${JSON.stringify(claudeRecord(fixture.native.workspaceRoot, nativeId))}\n`,
      );
      const created = await bridge.call('hq_agent_spawn', spawn);
      expect(created.isError).toBe(false);
      childId = z.uuid().parse(payload(created).agentId);
      await expect
        .poll(async () => {
          const receipt = await fixture.native.request({ kind: 'receipt', actionId: spawn.id });
          return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
        })
        .toBe('acknowledged');
    });
    await fixture.native.runtime.close();
    await expect(lstat(stalePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(dirname(stalePath))).rejects.toMatchObject({ code: 'ENOENT' });
    const runtime = await createAgentHq({
      stateRoot: fixture.native.stateRoot,
      allowedRoots: [fixture.native.workspaceRoot],
    });
    try {
      const status = await runtime.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing epoch');
      const recovered = await runtime.request({
        kind: 'action',
        action: {
          id: randomUUID(),
          runtimeEpoch: status.result.runtimeEpoch,
          command: {
            kind: 'thread-resume',
            threadId: fixture.agentIds[1]!,
            operatorConfirmation: 'The fixture owns this native session',
          },
        },
      });
      if (recovered.kind !== 'action') throw new Error('Missing recovery');
      await expect
        .poll(async () => {
          const receipt = await runtime.request({ kind: 'receipt', actionId: recovered.result.id });
          return receipt.kind === 'receipt' ? receipt.result : null;
        })
        .toMatchObject({ delivery: 'acknowledged' });
      const expired = await runtime.request({
        kind: 'agent-tool',
        credential: staleCredential,
        call: { name: 'hq_identity', arguments: {} },
      });
      expect(expired.kind === 'agent-tool' && expired.result.isError).toBe(true);
      const current = { ...fixture, native: { ...fixture.native, runtime } };
      await withAgentBridge(current, async (bridge) => {
        expect(bridge.filePath === stalePath).toBe(false);
        expect(payload(await bridge.call('hq_identity', {})).identity).toMatchObject({
          agentId: fixture.agentIds[1],
          runtimeEpoch: status.result.runtimeEpoch,
        });
        const replay = await bridge.call('hq_agent_spawn', spawn);
        expect(replay.isError).toBe(false);
        expect(payload(replay)).toMatchObject({
          agentId: childId,
          receipt: { id: spawn.id, delivery: 'acknowledged' },
        });
        const observation = await runtime.request({ kind: 'status' });
        expect(
          observation.kind === 'status' &&
            observation.result.providers.find((provider) => provider.provider === 'codex')?.state,
        ).toBe('idle');
      });
    } finally {
      await runtime.close();
    }
  }));

test('an insecure credential file is rejected before the bridge opens a control connection', async () =>
  withCollaboration(async (fixture) => {
    await withAgentBridge(fixture, async (bridge) => {
      await chmod(bridge.filePath, 0o644);
      const child = spawn(process.execPath, ['dist/cli/cli.js', 'agent-bridge'], {
        env: { ...process.env, JG_AGENT_HQ_BRIDGE_FILE: bridge.filePath },
        stdio: 'pipe',
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const closed = once(child, 'close');
      try {
        expect((await closed)[0]).toBe(1);
        expect(stdout).toBe('');
        expect(JSON.parse(stderr)).toMatchObject({
          success: false,
          error: { kind: 'access-denied' },
        });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          await closed;
        }
        await chmod(bridge.filePath, 0o600);
      }
    });
  }));
