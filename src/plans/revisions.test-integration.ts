// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm, writeFile, link, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { createAgentHq, acquireHqLock, type IAgentHq } from 'jg-agent-hq';
import {
  PlanCoordinationSchema,
  type IPlanCommandInput,
  type IPlanOperatorAction,
  type IPlanStatus,
  type IActionCommand,
  type IActionEnvelope,
  type IManagedThread,
  type IPlanCheckout,
} from 'jg-agent-hq/contracts';
import { fingerprintPlan, preparePlanUpdate, writePlanDocument } from 'jg-plans';
import { expect, test } from 'vitest';

import {
  withClaudeRuntime,
  type IClaudeFixture,
} from '../../scripts/test-support/claude-runtime.js';
import { writeFixtureControl } from '../../scripts/test-support/index.js';

const run = promisify(execFile);

/**
 * Creates a fixture-owned Git identity and signing key without changing user configuration.
 * @returns Completion after the fixture-local signing configuration is written.
 */
const initializeGit = async (fixture: IClaudeFixture): Promise<void> => {
  const signingKey = join(fixture.root, 'signing-key');
  const allowedSigners = join(fixture.root, 'allowed-signers');
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', signingKey], {
    timeout: 5000,
  });
  await writeFile(
    allowedSigners,
    `fixture@example.com ${await readFile(`${signingKey}.pub`, 'utf8')}`,
  );
  const git = (...args: string[]) =>
    run('git', args, { cwd: fixture.workspaceRoot, timeout: 5000 });
  await git('init', '-b', 'development');
  for (const [name, setting] of [
    ['user.name', 'HQ fixture'],
    ['user.email', 'fixture@example.com'],
    ['gpg.format', 'ssh'],
    ['gpg.ssh.program', 'ssh-keygen'],
    ['gpg.ssh.allowedSignersFile', allowedSigners],
    ['user.signingkey', signingKey],
  ] as const) {
    await git('config', '--local', name, setting);
  }
};

const operator = (): IPlanOperatorAction => ({
  id: randomUUID(),
  operatorId: 'fixture-operator',
  source: { kind: 'user-message', reference: `fixture-invocation:${randomUUID()}` },
});

// a null id writes a milestone without the ID that jg-breakdown would assign
const milestone = (
  ordinal: number,
  title: string,
  objective: string,
  status = 'pending',
  id: string | null = randomUUID(),
) =>
  `## Milestone ${ordinal}: ${title}\n**Status:** ${status}\n${id ? `**Milestone ID:** ${id}\n` : ''}\n**Objective:** ${objective}\n**Dependencies:** None.\n**Scope:** ${title} module.\n**Implementation:** Deliver the stated objective.\n**Verification:** Run the module checks.\n**Acceptance:** The objective holds.\n**Review checkpoint:** Review the module.\n\n`;
const sequence = (blocks: string[]) =>
  `# Milestones\n\n## Overview\n\n| Milestone | Name | Status |\n| --- | --- | --- |\n${blocks.map((_, index) => `| ${index + 1} | Feature ${index + 1} | pending |`).join('\n')}\n\n${blocks.join('')}## Approval required\nApprove this sequence.\n`;

const setup = async (
  fixture: IClaudeFixture,
  content?: string | null,
  planBody = '# Plan\nDeliver greeting, report and export commands.\n',
) => {
  const directory = join(fixture.workspaceRoot, 'revision-plan');
  await mkdir(directory);
  await writeFile(join(directory, 'plan.md'), planBody);
  // jg-breakdown assigns the milestone IDs that finalization requires
  if (content !== null)
    await writePlanDocument(directory, {
      document: 'milestones',
      expectedSha256: null,
      source:
        content ??
        sequence([
          milestone(1, 'Greeting', 'Return the requested greeting.'),
          milestone(2, 'Report', 'Format the report.', 'in progress'),
          milestone(3, 'Export', 'Export JSON.'),
        ]),
      assignMissingIds: true,
    });
  await writeFile(
    join(fixture.workspaceRoot, 'greeting.mjs'),
    'export const greet = (name) => `Hello, ${name}`;\n',
  );
  await writeFile(
    join(fixture.workspaceRoot, 'verify-greeting.mjs'),
    'import assert from "node:assert/strict";\nimport { greet } from "./greeting.mjs";\nassert.equal(greet("Reader"), "Hello, Reader");\nprocess.stdout.write("greeting-ok\\n");\n',
  );
  const target = { directory };
  const send = async (command: IPlanCommandInput, runtime: IAgentHq = fixture.runtime) => {
    const response = await runtime.request({ kind: 'plan', command });
    if (response.kind !== 'plan') throw new Error('Missing plan result');
    return response.result;
  };
  const status = async (runtime?: IAgentHq): Promise<IPlanStatus> => {
    const response = await send({ kind: 'status', target }, runtime);
    if (response.kind !== 'status') throw new Error('Missing status');
    return response.result;
  };
  const mutate = async (
    command:
      | Omit<Extract<IPlanCommandInput, { kind: 'approve' }>, 'target' | 'expected' | 'action'>
      | Omit<Extract<IPlanCommandInput, { kind: 'authorize' }>, 'target' | 'expected' | 'action'>,
  ) => {
    const state = await status();
    return send({ ...command, target, expected: state.revision, action: operator() });
  };
  const finalize = async () => {
    const current = await status();
    return send({ kind: 'finalize', target, expected: current.revision, action: operator() });
  };
  const approve = async (scope: 'plan' | 'sequence') => {
    const current = await status();
    return mutate({
      kind: 'approve',
      scope,
      presentationHash: (scope === 'plan'
        ? current.inspection.plan
        : current.inspection.milestones)!,
    });
  };
  const entries = async () => {
    const response = await send({ kind: 'milestones', target });
    if (response.kind !== 'milestones') throw new Error('Missing milestone page');
    return response.result.data;
  };
  const stored = async () =>
    PlanCoordinationSchema.parse(
      JSON.parse(await readFile(join(directory, 'coordination.json'), 'utf8')),
    );
  const until = async (predicate: (status: IPlanStatus) => boolean) => {
    const deadline = Date.now() + 5000;
    let current = await status();
    while (!predicate(current) && Date.now() < deadline) {
      await wait(16);
      current = await status();
    }
    expect(predicate(current), JSON.stringify(current)).toBe(true);
    return current;
  };
  await finalize();
  await approve('plan');
  if (content !== null) await approve('sequence');
  return {
    directory,
    target,
    send,
    status,
    mutate,
    finalize,
    approve,
    entries,
    stored,
    until,
  };
};

const completeGreeting = async (
  fixture: IClaudeFixture,
  plan: Awaited<ReturnType<typeof setup>>,
  checkouts: IPlanCheckout[] = [],
) => {
  const result = await run(process.execPath, ['verify-greeting.mjs'], {
    cwd: fixture.workspaceRoot,
    timeout: 5000,
  });
  expect(result.stdout).toBe('greeting-ok\n');
  const first = (await plan.entries())[0]!;
  const current = await plan.status();
  await plan.send({
    kind: 'complete',
    target: plan.target,
    action: operator(),
    expected: current.revision,
    milestoneId: first.id!,
    checks: [
      {
        command: 'node verify-greeting.mjs',
        outcome: 'passed',
        reference: 'file:verify-greeting.mjs',
      },
    ],
    checkouts,
  });
  return first.id!;
};

const begin = async (
  plan: Awaited<ReturnType<typeof setup>>,
  checkouts: IPlanCheckout[] = [],
  threadIds: string[] = [],
) => {
  const current = await plan.status();
  const action = operator();
  await plan.send({
    kind: 'begin-revision',
    target: plan.target,
    expected: current.revision,
    action,
    intent: 'plan',
    checkouts,
    threadIds,
  });
  await plan.until((status) => status.coordination.revision?.phase === 'editing');
  return action;
};

test('an undivided plan retains real completion evidence and cannot execute its finished contract again', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture, null);
    const verification = await run(process.execPath, ['verify-greeting.mjs'], {
      cwd: fixture.workspaceRoot,
    });
    expect(verification.stdout).toBe('greeting-ok\n');
    const current = await plan.status();
    const authorization = operator();
    await plan.send({
      kind: 'authorize',
      target: plan.target,
      action: authorization,
      expected: current.revision,
      mode: 'auto',
      milestoneIds: [],
    });
    const completion = {
      kind: 'complete' as const,
      target: plan.target,
      action: operator(),
      expected: current.revision,
      milestoneId: null,
      checkouts: [],
      checks: [
        {
          command: 'node verify-greeting.mjs',
          outcome: 'passed' as const,
          reference: 'file:verify-greeting.mjs',
        },
      ],
    };
    await plan.send(completion);
    await plan.send(completion);
    expect((await plan.status()).state).toBe('completed');
    const stored = await plan.stored();
    expect(stored.completions).toHaveLength(1);
    expect(stored.completions[0]).toMatchObject({
      milestoneId: null,
      contractDigest: current.revision.planDigest,
      sharedDigest: null,
      checks: completion.checks,
    });
    await expect(
      plan.send({
        kind: 'authorize',
        target: plan.target,
        action: operator(),
        expected: current.revision,
        mode: 'auto',
        milestoneIds: [],
      }),
    ).rejects.toThrow('conflicts');
    await expect(
      plan.send({
        kind: 'check-execution',
        target: plan.target,
        expected: current.revision,
        authorizationId: authorization.id,
        milestoneId: null,
        mode: 'auto',
      }),
    ).rejects.toThrow('conflicts');
    await fixture.runtime.close();
    const restarted = await createAgentHq({
      stateRoot: fixture.stateRoot,
      allowedRoots: [fixture.workspaceRoot],
    });
    try {
      const retained = await plan.status(restarted);
      expect(retained.state).toBe('completed');
      expect(retained.coordination.completionCount).toBe(1);
    } finally {
      await restarted.close();
    }
  });
});

test('an undivided plan checkpoints and revises without requiring a milestone file', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture, null);
    const before = await plan.status();
    await initializeGit(fixture);
    await run('git', ['add', '--', 'greeting.mjs'], { cwd: fixture.workspaceRoot });
    await run('git', ['commit', '-m', 'test: preserve partial work', '-s', '-S'], {
      cwd: fixture.workspaceRoot,
    });
    const partial = 'export const greet = (name) => `Welcome, ${name}`;\n';
    await writeFile(join(fixture.workspaceRoot, 'greeting.mjs'), partial);
    await begin(plan, [
      {
        repository: 'fixture',
        directory: fixture.workspaceRoot,
        claimReference: 'claim:whole-plan',
        paths: ['greeting.mjs'],
      },
    ]);
    const checkpoint = (await plan.stored()).revision?.checkpoint;
    expect(checkpoint).toMatchObject({ milestones: null, entries: [], isQuiescent: true });
    expect(checkpoint?.checkouts[0]).toMatchObject({
      branch: 'development',
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      paths: ['greeting.mjs'],
    });
    expect((await plan.status()).state).toBe('revising');
    await writeFile(
      join(plan.directory, 'plan.md'),
      '# Plan\nDeliver the greeting and its verification.\n',
    );
    const finalized = await plan.finalize();
    expect(finalized.kind).toBe('finalized');
    if (finalized.kind !== 'finalized') throw new Error('Expected finalization');
    expect(finalized.content).toBeNull();
    expect(finalized.result.revision.planDigest).not.toBe(before.revision.planDigest);
    expect(finalized.result.isPlanApproved).toBe(false);
    await plan.approve('plan');
    expect((await plan.status()).state).toBe('ready');
    expect((await plan.status()).coordination.execution).toBeNull();
    expect(await readFile(join(fixture.workspaceRoot, 'greeting.mjs'), 'utf8')).toBe(partial);
    expect(
      (await run('git', ['diff', '--name-only'], { cwd: fixture.workspaceRoot })).stdout,
    ).toContain('greeting.mjs');
  });
});

test('dropping a sequence keeps its completion evidence visible as unmatched', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const completed = await completeGreeting(fixture, plan);
    const before = await plan.stored();
    await begin(plan);
    await writeFile(
      join(plan.directory, 'plan.md'),
      '# Plan\nFinish only the report after the verified greeting.\n',
    );
    await rm(join(plan.directory, 'milestones.md'));
    const finalized = await plan.finalize();
    if (finalized.kind !== 'finalized') throw new Error('Expected finalization');
    expect(finalized.content).toBeNull();
    expect(finalized.result.coordination.unmatchedEvidence).toStrictEqual([
      {
        id: before.completions[0]!.id,
        milestoneId: completed,
        title: 'Greeting',
        completedAt: before.completions[0]!.completedAt,
      },
    ]);
    expect((await plan.stored()).completions).toStrictEqual(before.completions);
    await plan.approve('plan');
    expect((await plan.status()).state).toBe('ready');
    await plan.mutate({ kind: 'authorize', mode: 'auto', milestoneIds: [] });
    expect((await plan.status()).coordination.execution?.milestoneIds).toStrictEqual([]);
  });
});

test('a regenerated sequence that keeps milestone IDs carries reworded completed and partial work', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const completed = await completeGreeting(fixture, plan);
    const before = await plan.stored();
    const sources = (await plan.entries()).map((entry) => entry.id!);
    const state = await plan.status();
    const authorization = operator();
    await plan.send({
      kind: 'authorize',
      target: plan.target,
      action: authorization,
      expected: state.revision,
      mode: 'auto',
      milestoneIds: [sources[1]!, sources[2]!],
    });
    await begin(plan);
    const checkpoint = (await plan.stored()).revision!.checkpoint!;
    expect(checkpoint.isQuiescent).toBe(true);
    expect(checkpoint.entries[0]!.status).toBe('done');
    expect(checkpoint.entries[1]!.status).toBe('in progress');
    await rm(join(plan.directory, 'milestones.md'));
    await writeFile(
      join(plan.directory, 'plan.md'),
      '# Plan\nKeep the greeting and report requirements; export JSON with a checksum.\n',
    );
    await writeFile(
      join(plan.directory, 'milestones.md'),
      sequence([
        milestone(
          1,
          'Greeting result',
          'Return the requested greeting using equivalent wording.',
          'done',
          sources[0],
        ),
        milestone(2, 'Report', 'Format the report.', 'in progress', sources[1]),
        milestone(3, 'Export', 'Export JSON with a checksum.'),
      ]),
    );
    await plan.approve('plan');
    expect((await plan.finalize()).kind).toBe('finalized');
    const current = await plan.entries();
    expect(current.map((entry) => entry.status)).toStrictEqual(['done', 'in progress', 'pending']);
    expect(current[0]!.id).toBe(completed);
    expect(current[1]!.id).toBe(sources[1]);
    expect(current[2]!.id).not.toBe(sources[2]);
    expect((await plan.stored()).completions).toStrictEqual(before.completions);
    await plan.approve('sequence');
    const ready = await plan.status();
    expect(ready.isSequenceApproved).toBe(true);
    expect(ready.state).toBe('in-progress');
    expect(ready.coordination.unmatchedEvidence).toStrictEqual([]);
    expect(ready.coordination.execution!.revokedBy).not.toBeNull();
    await expect(
      plan.send({
        kind: 'check-execution',
        target: plan.target,
        expected: ready.revision,
        authorizationId: authorization.id,
        milestoneId: sources[1]!,
        mode: 'auto',
      }),
    ).rejects.toThrow('conflicts');
    const fresh = operator();
    await plan.send({
      kind: 'authorize',
      target: plan.target,
      expected: ready.revision,
      action: fresh,
      mode: 'supervised',
      milestoneIds: [sources[1]!],
    });
    expect(
      (
        await plan.send({
          kind: 'check-execution',
          target: plan.target,
          expected: ready.revision,
          authorizationId: fresh.id,
          milestoneId: sources[1]!,
          mode: 'supervised',
        })
      ).kind,
    ).toBe('execution-check');
  });
});

test('finalization refuses a milestone without an ID and changes nothing', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const sources = (await plan.entries()).map((entry) => entry.id!);
    await begin(plan);
    const regenerated = (exportId: string | null) =>
      sequence([
        milestone(1, 'Greeting', 'Return the requested greeting.', 'pending', sources[0]),
        milestone(2, 'Report', 'Format the report.', 'in progress', sources[1]),
        milestone(3, 'Export', 'Export JSON with a checksum.', 'pending', exportId),
      ]);
    await writeFile(join(plan.directory, 'milestones.md'), regenerated(null));
    const before = await plan.stored();
    await expect(plan.finalize()).rejects.toMatchObject({ code: 'JG_AGENT_HQ_PLAN_INVALID' });
    expect(await readFile(join(plan.directory, 'milestones.md'), 'utf8')).toBe(regenerated(null));
    expect(await plan.stored()).toStrictEqual(before);
    expect((await plan.status()).isFinalized).toBe(false);
    await writeFile(join(plan.directory, 'milestones.md'), regenerated(randomUUID()));
    expect((await plan.finalize()).kind).toBe('finalized');
  });
});

test('a done marker without evidence for its milestone ID blocks the plan until the sequence reopens it', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const sources = (await plan.entries()).map((entry) => entry.id!);
    const raw = await readFile(join(plan.directory, 'milestones.md'), 'utf8');
    await writeFile(
      join(plan.directory, 'milestones.md'),
      raw.replace('**Status:** pending', '**Status:** done'),
    );
    expect((await plan.status()).state).toBe('blocked');
    await begin(plan);
    const regenerated = (status: string) =>
      sequence([
        milestone(1, 'Greeting result', 'Equivalent greeting text.', status, sources[0]),
        milestone(2, 'Report', 'Format the report.', 'in progress', sources[1]),
        milestone(3, 'Export', 'Export JSON.', 'pending', sources[2]),
      ]);
    await writeFile(join(plan.directory, 'milestones.md'), regenerated('done'));
    expect((await plan.finalize()).kind).toBe('finalized');
    expect((await plan.status()).state).toBe('blocked');
    await writeFile(join(plan.directory, 'milestones.md'), regenerated('pending'));
    expect((await plan.finalize()).kind).toBe('finalized');
    expect((await plan.status()).state).toBe('sequence-approval-required');
    expect((await plan.entries())[0]).toMatchObject({ id: sources[0], status: 'pending' });
  });
});

const native = async (fixture: IClaudeFixture) => {
  const status = await fixture.runtime.request({ kind: 'status' });
  if (status.kind !== 'status') throw new Error('Missing runtime status');
  const until = async <T>(read: () => Promise<T>, predicate: (result: T) => boolean) => {
    const end = Date.now() + 5000;
    let result = await read();
    while (!predicate(result) && Date.now() < end) {
      await wait(16);
      result = await read();
    }
    expect(predicate(result), JSON.stringify(result)).toBe(true);
    return result;
  };
  const receipt = async (id: string) => {
    const result = await fixture.runtime.request({ kind: 'receipt', actionId: id });
    if (result.kind !== 'receipt' || !result.result) throw new Error('Missing receipt');
    return result.result;
  };
  const submit = async (command: IActionCommand, plan?: IActionEnvelope['plan']) => {
    const action = { id: randomUUID(), runtimeEpoch: status.result.runtimeEpoch, command, plan };
    const result = await fixture.runtime.request({ kind: 'action', action });
    if (result.kind !== 'action') throw new Error('Missing admission');
    return result.result;
  };
  const thread = async (id: string): Promise<IManagedThread> => {
    const result = await fixture.runtime.request({ kind: 'managed-thread', threadId: id });
    if (result.kind !== 'managed-thread' || !result.result) throw new Error('Missing thread');
    return result.result;
  };
  const create = async (provider: 'codex' | 'claude', name: string) => {
    const created = await submit({
      kind: 'thread-create',
      provider,
      name,
      workspaceRoot: fixture.workspaceRoot,
    });
    await until(
      () => receipt(created.id),
      (entry) => entry.delivery !== 'submitted',
    );
    return until(
      () => thread(created.threadId!),
      (entry) => entry.state === 'idle',
    );
  };
  return { submit, receipt, thread, create, until };
};

test.each(['codex', 'claude'] as const)(
  'forking a plan-bound %s session does not copy execution authority',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const plan = await setup(fixture, null);
      const session = await native(fixture);
      const source = await session.create(provider, 'bound-fork-source');
      const current = await plan.status();
      const authorization = operator();
      await plan.send({
        kind: 'authorize',
        target: plan.target,
        expected: current.revision,
        action: authorization,
        mode: 'auto',
        milestoneIds: [],
      });
      const scope = {
        kind: 'execution' as const,
        authorizationId: authorization.id,
        milestoneId: null,
        mode: 'auto' as const,
        revision: current.revision,
      };
      const message = await session.submit(
        {
          kind: 'message',
          threadId: source.id,
          input: { kind: 'text', text: 'Assess the authorized work.' },
        },
        scope,
      );
      await expect
        .poll(() => session.receipt(message.id))
        .toMatchObject({ delivery: 'acknowledged', completion: 'completed' });
      expect(
        await fixture.runtime.request({ kind: 'thread-plan', threadId: source.id }),
      ).toMatchObject({ kind: 'thread-plan', result: { scope } });
      const fork = await session.submit({
        kind: 'thread-fork',
        threadId: source.id,
        name: 'unbound-fork',
      });
      await expect.poll(() => session.receipt(fork.id)).toMatchObject({ delivery: 'acknowledged' });
      expect(
        await fixture.runtime.request({ kind: 'thread-plan', threadId: fork.threadId! }),
      ).toStrictEqual({ kind: 'thread-plan', result: null });
      expect(
        await fixture.runtime.request({ kind: 'thread-plan', threadId: source.id }),
      ).toMatchObject({ kind: 'thread-plan', result: { scope } });
    });
  },
);

test.each(['codex', 'claude'] as const)(
  'whole-plan %s input keeps one owner and preserves authority on ordinary follow-ups',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const plan = await setup(fixture, null);
      const session = await native(fixture);
      const first = await session.create(provider, 'whole-plan');
      const second = await session.create(provider, 'other-owner');
      await fixture.control({ holdTurn: true });
      await writeFixtureControl(fixture.root, 'control.json', { holdTurn: true });
      const current = await plan.status();
      const authorization = operator();
      await plan.send({
        kind: 'authorize',
        target: plan.target,
        expected: current.revision,
        action: authorization,
        mode: 'auto',
        milestoneIds: [],
      });
      const scope = {
        kind: 'execution' as const,
        authorizationId: authorization.id,
        milestoneId: null,
        mode: 'auto' as const,
        revision: current.revision,
      };
      const submitted = await session.submit(
        {
          kind: 'message',
          threadId: first.id,
          input: { kind: 'text', text: 'Implement the whole approved plan.' },
        },
        scope,
      );
      const delivered = await session.until(
        () => session.receipt(submitted.id),
        (receipt) => receipt.delivery !== 'submitted',
      );
      expect(delivered.delivery).toBe('acknowledged');
      const running = await session.until(
        () => session.thread(first.id),
        (thread) => thread.state === 'running',
      );
      expect(
        await session.submit(
          {
            kind: 'message',
            threadId: second.id,
            input: { kind: 'text', text: 'Competing implementation.' },
          },
          scope,
        ),
      ).toMatchObject({ delivery: 'failed', failure: 'state-conflict', nativeTurnId: null });
      expect(
        await session.submit({
          kind: 'queue',
          threadId: first.id,
          expectedTurnId: running.activeTurnId!,
          input: { kind: 'text', text: 'Verify the same plan next.' },
        }),
      ).toMatchObject({ delivery: 'queued', planContext: { scope } });
      await plan.send({
        kind: 'revoke',
        target: plan.target,
        expected: current.revision,
        action: operator(),
        scope: 'execution',
      });
      await expect(
        session.submit({
          kind: 'queue',
          threadId: first.id,
          expectedTurnId: running.activeTurnId!,
          input: { kind: 'text', text: 'Unapproved follow-up.' },
        }),
      ).rejects.toThrow('conflicts');
      await session.submit({
        kind: 'interrupt',
        threadId: first.id,
        expectedTurnId: running.activeTurnId!,
      });
      await session.until(
        () => session.thread(first.id),
        (thread) => thread.activeTurnId === null,
      );
      await expect(
        session.submit({
          kind: 'message',
          threadId: first.id,
          input: { kind: 'text', text: 'Unapproved idle follow-up.' },
        }),
      ).rejects.toThrow('conflicts');
      expect((await session.thread(second.id)).state).toBe('idle');
    });
  },
);

test.each(['codex', 'claude'] as const)(
  'revision stops bound %s input and background control while leaving another thread running',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const plan = await setup(fixture);
      const session = await native(fixture);
      const target = await session.create(provider, 'revise-target');
      const other = await session.create(provider, 'other-task');
      await fixture.control({ holdTurn: true });
      await writeFixtureControl(fixture.root, 'control.json', { holdTurn: true });
      const milestoneId = (await plan.entries())[1]!.id!;
      const state = await plan.status();
      const authorization = operator();
      await plan.send({
        kind: 'authorize',
        target: plan.target,
        action: authorization,
        expected: state.revision,
        mode: 'auto',
        milestoneIds: [milestoneId],
      });
      const scope = {
        kind: 'execution' as const,
        authorizationId: authorization.id,
        milestoneId,
        mode: 'auto' as const,
        revision: state.revision,
      };
      await session.submit(
        {
          kind: 'message',
          threadId: target.id,
          input: { kind: 'text', text: 'Implement selected milestone' },
        },
        scope,
      );
      await session.submit({
        kind: 'message',
        threadId: other.id,
        input: { kind: 'text', text: 'Continue unrelated work' },
      });
      await session.until(
        () => session.thread(target.id),
        (thread) => thread.state === 'running',
      );
      const queued = await session.submit(
        {
          kind: 'queue',
          threadId: target.id,
          expectedTurnId: (await session.thread(target.id)).activeTurnId!,
          input: { kind: 'text', text: 'Then verify selected milestone' },
        },
        scope,
      );
      await begin(plan);
      const stopped = await session.thread(target.id);
      expect(stopped.state).toBe('inactive');
      expect(stopped.runtimeEpoch).toBeNull();
      expect((await session.thread(other.id)).state).toBe('running');
      expect((await session.receipt(queued.id)).delivery).toBe('queued');
      await expect(
        session.submit({ kind: 'queue-send', queuedActionId: queued.id }),
      ).rejects.toThrow('conflicts');
      const calls = (
        await readFile(
          join(fixture.root, provider === 'codex' ? 'calls.jsonl' : 'claude-calls.jsonl'),
          'utf8',
        )
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      if (provider === 'codex') {
        const methods = calls.map((call) => call.method);
        expect(methods.indexOf('turn/interrupt')).toBeLessThan(
          methods.indexOf('thread/backgroundTerminals/clean'),
        );
        expect(methods.indexOf('thread/backgroundTerminals/clean')).toBeLessThan(
          methods.indexOf('thread/unsubscribe'),
        );
        expect(
          calls.filter(
            (call) => call.method === 'turn/start' && call.params.threadId === target.nativeId,
          ),
        ).toHaveLength(1);
      } else {
        expect(calls.some((call) => call.request?.subtype === 'interrupt')).toBe(true);
      }
    });
  },
);

test('observed external deletion closes admission and stops only bound execution before revision', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const session = await native(fixture);
    const target = await session.create('codex', 'external-change');
    await writeFixtureControl(fixture.root, 'control.json', { holdTurn: true });
    const milestoneId = (await plan.entries())[1]!.id!;
    const state = await plan.status();
    const authorization = operator();
    await plan.send({
      kind: 'authorize',
      target: plan.target,
      action: authorization,
      expected: state.revision,
      mode: 'auto',
      milestoneIds: [milestoneId],
    });
    const scope = {
      kind: 'execution' as const,
      authorizationId: authorization.id,
      milestoneId,
      mode: 'auto' as const,
      revision: state.revision,
    };
    await session.submit(
      {
        kind: 'message',
        threadId: target.id,
        input: { kind: 'text', text: 'Implement milestone' },
      },
      scope,
    );
    await session.until(
      () => session.thread(target.id),
      (thread) => thread.state === 'running',
    );
    await rm(join(plan.directory, 'milestones.md'));
    expect((await plan.status()).state).toBe('blocked');
    await session.until(
      () => session.thread(target.id),
      (thread) => thread.state === 'inactive',
    );
    const observed = await plan.until(
      (state) => state.coordination.observedConflict?.phase === 'quiescent',
    );
    expect(observed.coordination.observedConflict!.revision!.breakdownDigest).toBeNull();
    await expect(
      session.submit(
        {
          kind: 'thread-resume',
          threadId: target.id,
          operatorConfirmation: 'Other native controllers are closed',
        },
        scope,
      ),
    ).rejects.toThrow('conflicts');
    await begin(plan);
    const saved = await plan.stored();
    expect(saved.revision!.hasUncertainEffects).toBe(true);
    expect(saved.revision!.checkpoint!.entries.map((entry) => entry.id)).toStrictEqual(
      (state.coordination.finalized ? saved.baseline!.entries : []).map((entry) => entry.id),
    );
  });
});

test('checkpoint fingerprints exact partial checkout paths without staging, resetting or reading unrelated files', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const git = (...args: string[]) =>
      run('git', args, { cwd: fixture.workspaceRoot, timeout: 5000 });
    await initializeGit(fixture);
    await git('add', '--', 'greeting.mjs', 'verify-greeting.mjs');
    await git('commit', '-m', 'test: establish revision checkpoint', '-s', '-S');
    await git('verify-commit', 'HEAD');
    await writeFile(
      join(fixture.workspaceRoot, 'partial.txt'),
      'unfinished catalog work\n'.repeat(262144),
    );
    await writeFile(join(fixture.workspaceRoot, 'unrelated.txt'), 'Other task work\n');
    const checkout = {
      repository: 'fixture',
      directory: fixture.workspaceRoot,
      claimReference: 'claim:catalog',
      paths: ['greeting.mjs', 'partial.txt', 'deleted.txt'],
    };
    const completed = await completeGreeting(fixture, plan, [checkout]);
    const before = (await git('status', '--porcelain=v1')).stdout;
    await begin(plan, [checkout]);
    const checkpoint = (await plan.stored()).revision!.checkpoint!;
    expect(checkpoint.checkouts[0]!.branch).toBe('development');
    expect(checkpoint.checkouts[0]!.head).toBe((await git('rev-parse', 'HEAD')).stdout.trim());
    expect(checkpoint.checkouts[0]!.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(checkpoint.checkouts[0]!.paths).toStrictEqual(checkout.paths);
    expect((await plan.stored()).completions[0]!.milestoneId).toBe(completed);
    expect((await git('status', '--porcelain=v1')).stdout).toBe(before);
    expect((await git('diff', '--cached', '--name-only')).stdout).toBe('');
    expect(await readFile(join(fixture.workspaceRoot, 'unrelated.txt'), 'utf8')).toBe(
      'Other task work\n',
    );
    await writeFile(join(fixture.workspaceRoot, 'partial.txt'), 'Further partial changes\n');
    // A later completion captures the new content; the checkpoint stays immutable.
    await completeGreeting(fixture, plan, [checkout]);
    expect((await plan.stored()).completions.at(-1)!.checkouts[0]!.fingerprint).not.toBe(
      checkpoint.checkouts[0]!.fingerprint,
    );
    expect((await plan.stored()).revision!.checkpoint!.checkouts).toStrictEqual(
      checkpoint.checkouts,
    );
  });
});

test.each([
  '../escape.txt',
  '.git/config',
  '_archive/never-read.txt',
  'C:escape.txt',
  'nested/../../escape.txt',
])('checkout selection rejects %s before reading or changing it', async (path) => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    await initializeGit(fixture);
    await run('git', ['add', '--', 'greeting.mjs'], { cwd: fixture.workspaceRoot, timeout: 5000 });
    await run('git', ['commit', '-m', 'test: establish path boundary', '-s', '-S'], {
      cwd: fixture.workspaceRoot,
      timeout: 5000,
    });
    await expect(
      completeGreeting(fixture, plan, [
        {
          repository: 'fixture',
          directory: fixture.workspaceRoot,
          claimReference: 'claim:test',
          paths: [path],
        },
      ]),
    ).rejects.toThrow('plan is invalid');
    expect((await plan.stored()).completions).toStrictEqual([]);
  });
});

test('restart invalidates execution authorization and retains a blocked editing lease until an explicit new invocation', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const state = await plan.status();
    const milestoneId = (await plan.entries())[1]!.id!;
    const authorization = operator();
    await plan.send({
      kind: 'authorize',
      target: plan.target,
      action: authorization,
      expected: state.revision,
      mode: 'auto',
      milestoneIds: [milestoneId],
    });
    await fixture.runtime.close();
    const replacement = await createAgentHq({
      stateRoot: fixture.stateRoot,
      allowedRoots: [fixture.workspaceRoot],
    });
    try {
      await expect(
        plan.send(
          {
            kind: 'check-execution',
            target: plan.target,
            expected: state.revision,
            authorizationId: authorization.id,
            milestoneId,
            mode: 'auto',
          },
          replacement,
        ),
      ).rejects.toThrow('conflicts');
      const action = operator();
      await plan.send(
        {
          kind: 'begin-revision',
          target: plan.target,
          expected: state.revision,
          action,
          intent: 'plan',
          threadIds: [],
          checkouts: [],
        },
        replacement,
      );
      await nativeWait(
        async () => plan.status(replacement),
        (state) => state.coordination.revision?.phase === 'editing',
      );
    } finally {
      await replacement.close();
    }
    const recovered = await createAgentHq({
      stateRoot: fixture.stateRoot,
      allowedRoots: [fixture.workspaceRoot],
    });
    try {
      const blocked = await plan.status(recovered);
      expect(blocked.state).toBe('blocked');
      expect(blocked.coordination.revision!.reason).toBe('revision-owner-unavailable');
      const current = await plan.stored();
      await plan.send(
        {
          kind: 'revision-invoke',
          target: plan.target,
          expected: blocked.revision,
          action: operator(),
          revisionId: current.revision!.id,
          skill: 'jg-plan',
        },
        recovered,
      );
      await nativeWait(
        async () => plan.status(recovered),
        (state) => state.coordination.revision?.phase === 'editing' && state.state === 'revising',
      );
      expect((await plan.stored()).execution!.revokedBy).not.toBeNull();
    } finally {
      await recovered.close();
    }
  });
});

const nativeWait = async <T>(read: () => Promise<T>, ready: (result: T) => boolean) => {
  const deadline = Date.now() + 5000;
  let result = await read();
  while (!ready(result) && Date.now() < deadline) {
    await wait(16);
    result = await read();
  }
  expect(ready(result), JSON.stringify(result)).toBe(true);
  return result;
};

test('unproven native background cleanup retains the checkpoint and blocks editing', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const session = await native(fixture);
    const target = await session.create('codex', 'cleanup-failure');
    const current = await plan.status();
    const milestoneId = (await plan.entries())[1]!.id!;
    const authorization = operator();
    await plan.send({
      kind: 'authorize',
      target: plan.target,
      expected: current.revision,
      action: authorization,
      mode: 'auto',
      milestoneIds: [milestoneId],
    });
    const scope = {
      kind: 'execution' as const,
      authorizationId: authorization.id,
      milestoneId,
      revision: current.revision,
      mode: 'auto' as const,
    };
    await writeFixtureControl(fixture.root, 'control.json', { holdTurn: true });
    await session.submit(
      { kind: 'message', threadId: target.id, input: { kind: 'text', text: 'Work on catalog' } },
      scope,
    );
    await session.until(
      () => session.thread(target.id),
      (thread) => thread.state === 'running',
    );
    await writeFixtureControl(fixture.root, 'control.json', {
      holdTurn: true,
      backgroundRemaining: true,
    });
    try {
      await plan.send({
        kind: 'begin-revision',
        target: plan.target,
        expected: current.revision,
        action: operator(),
        intent: 'plan',
        threadIds: [],
        checkouts: [],
      });
      const blocked = await plan.until((state) => state.coordination.revision?.phase === 'blocked');
      expect(blocked.state).toBe('blocked');
      expect(blocked.coordination.revision!.reason).toBe('native-quiescence-unavailable');
      expect((await plan.stored()).revision!.checkpoint!.isQuiescent).toBe(false);
      expect((await plan.stored()).revision!.invocation).toBeNull();
      const calls = (await readFile(join(fixture.root, 'calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(calls.some((call) => call.method === 'thread/backgroundTerminals/list')).toBe(true);
      expect(calls.some((call) => call.method === 'thread/unsubscribe')).toBe(false);
    } finally {
      await writeFixtureControl(fixture.root, 'control.json', {});
    }
  });
});

test('a finalization write retry after restart replays the same finalization and evidence', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    await completeGreeting(fixture, plan);
    const sources = (await plan.entries()).map((entry) => entry.id!);
    await begin(plan);
    await writeFile(
      join(plan.directory, 'milestones.md'),
      sequence([
        milestone(1, 'Greeting result', 'Equivalent greeting wording.', 'done', sources[0]),
        milestone(2, 'Report', 'Format the report.', 'in progress', sources[1]),
        milestone(3, 'Export', 'Export JSON with a checksum.'),
      ]),
    );
    const canonical = await readFile(join(plan.directory, 'milestones.md'), 'utf8');
    const before = await plan.status();
    const command: IPlanCommandInput = {
      kind: 'finalize',
      target: plan.target,
      expected: before.revision,
      action: operator(),
    };
    const database = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'));
    try {
      database.exec(
        "CREATE TRIGGER stop_plan_completion BEFORE UPDATE ON hq_plan_operation WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ABORT, 'checkpoint replay test'); END;",
      );
      await expect(plan.send(command)).rejects.toThrow('store failed');
    } finally {
      database.exec('DROP TRIGGER stop_plan_completion');
      database.close();
    }
    const persisted = await plan.stored();
    expect(persisted.finalized!.action.id).toBe(command.action.id);
    await fixture.runtime.close();
    const replacement = await createAgentHq({
      stateRoot: fixture.stateRoot,
      allowedRoots: [fixture.workspaceRoot],
    });
    try {
      expect((await plan.send(command, replacement)).kind).toBe('finalized');
      expect(await readFile(join(plan.directory, 'milestones.md'), 'utf8')).toBe(canonical);
      expect((await plan.stored()).finalized).toStrictEqual(persisted.finalized);
      expect((await plan.stored()).completions).toStrictEqual(persisted.completions);
      expect((await plan.status(replacement)).pendingActionId).toBeNull();
    } finally {
      await replacement.close();
    }
  });
});

test('real jg-breakdown output that keeps milestone IDs carries reworded completed and partial work', async () => {
  await withClaudeRuntime(async (fixture) => {
    const revised = await readFile(
      new URL('./fixtures/revised-milestones.txt', import.meta.url),
      'utf8',
    );
    const planBody = await readFile(new URL('./fixtures/plan.md', import.meta.url), 'utf8');
    const baseline =
      '# Milestones\n\n## Milestone 1: Manifest checks\n**Status:** done\n\n**Objective:** Keep loadManifest reading UTF-8 JSON, requiring an object with a nonempty array of nonempty string paths, and returning sorted unique paths.\n**Scope:** source.mjs, verify-manifest.mjs, README.md.\n**Verification:** node verify-manifest.mjs.\n**Acceptance:** Valid, malformed, empty and duplicate input are covered.\n\n## Milestone 2: SQLite catalog\n**Status:** in progress\n\n**Objective:** Finish SQLite indexing, atomic idempotent refresh and bounded keyset search.\n**Scope:** source.mjs, catalog.mjs, verify-catalog.mjs, README.md.\n**Verification:** Use real temporary SQLite storage, repeated refresh and page boundaries.\n**Acceptance:** Sorted paths use an exclusive cursor and limit 32, maximum 128.\n\n## Milestone 3: JSON report\n**Status:** pending\n\n**Objective:** Export sorted entries to JSON atomically.\n**Scope:** report.mjs, verify-report.mjs, README.md.\n**Verification:** Stable ordering and failure cleanup.\n**Acceptance:** Existing report is preserved on failure.\n\n## Approval required\nApprove all three milestones.\n';
    const plan = await setup(
      fixture,
      baseline,
      planBody
        .replace(' and a SHA-256 checksum of the canonical entries JSON', '')
        .replace('This checksum is an added requirement. ', ''),
    );
    await writeFile(
      join(fixture.workspaceRoot, 'source.mjs'),
      await readFile(new URL('./fixtures/source.mjs', import.meta.url)),
    );
    await writeFile(
      join(fixture.workspaceRoot, 'verify-manifest.mjs'),
      "import assert from 'node:assert/strict';\nimport { mkdtemp, writeFile, rm } from 'node:fs/promises';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nimport { loadManifest } from './source.mjs';\nconst root = await mkdtemp(join(tmpdir(), 'manifest-check-'));\ntry {\n  const path = join(root, 'manifest.json');\n  await writeFile(path, JSON.stringify({files:['b.txt','a.txt','b.txt']}));\n  assert.deepEqual(await loadManifest(path), ['a.txt','b.txt']);\n  for (const text of ['{', '{}', '{\"files\":[]}', '{\"files\":[1]}']) {\n    await writeFile(path, text);\n    await assert.rejects(loadManifest(path));\n  }\n} finally { await rm(root,{recursive:true,force:true}); }\n",
    );
    await run(process.execPath, ['verify-manifest.mjs'], {
      cwd: fixture.workspaceRoot,
      timeout: 5000,
    });
    const original = await plan.entries();
    const current = await plan.status();
    await plan.send({
      kind: 'complete',
      target: plan.target,
      expected: current.revision,
      action: operator(),
      milestoneId: original[0]!.id!,
      checks: [
        {
          command: 'node verify-manifest.mjs',
          outcome: 'passed',
          reference: 'file:verify-manifest.mjs',
        },
      ],
      checkouts: [],
    });
    const receipt = (await plan.stored()).completions[0]!;
    await begin(plan);
    await rm(join(plan.directory, 'milestones.md'));
    await writeFile(join(plan.directory, 'plan.md'), planBody);
    expect((await plan.status()).state).toBe('plan-approval-required');
    await plan.approve('plan');
    // jg-breakdown keeps the two carried milestones' IDs and assigns one to the changed export
    await writePlanDocument(plan.directory, {
      document: 'milestones',
      expectedSha256: null,
      source: preparePlanUpdate(revised, {
        document: 'milestones',
        changes: [1, 2].map((ordinal) => ({
          select: { ordinal },
          set: { id: original[ordinal - 1]!.id! },
        })),
      }).source,
      assignMissingIds: true,
    });
    const canonical = await plan.finalize();
    if (canonical.kind !== 'finalized') throw new Error('Missing canonical presentation');
    expect(canonical.content).toBe(await readFile(join(plan.directory, 'milestones.md'), 'utf8'));
    expect(canonical.result.state).toBe('sequence-approval-required');
    const entries = await plan.entries();
    expect(entries.map((entry) => entry.status)).toStrictEqual(['done', 'in progress', 'pending']);
    expect(entries.slice(0, 2).map((entry) => entry.id)).toStrictEqual(
      original.slice(0, 2).map((entry) => entry.id),
    );
    expect(entries[2]!.id).not.toBe(original[2]!.id);
    expect((await plan.stored()).completions[0]).toStrictEqual(receipt);
    await plan.approve('sequence');
    expect((await plan.status()).coordination.execution).toBeNull();
  });
});

test('malformed external milestone text requests interruption and retains a closed gate after repair', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const session = await native(fixture);
    const target = await session.create('codex', 'malformed-revision');
    const state = await plan.status();
    const milestoneId = (await plan.entries())[1]!.id!;
    const authorization = operator();
    await plan.send({
      kind: 'authorize',
      target: plan.target,
      expected: state.revision,
      action: authorization,
      mode: 'auto',
      milestoneIds: [milestoneId],
    });
    const scope = {
      kind: 'execution' as const,
      authorizationId: authorization.id,
      milestoneId,
      mode: 'auto' as const,
      revision: state.revision,
    };
    await writeFixtureControl(fixture.root, 'control.json', { holdTurn: true });
    await session.submit(
      {
        kind: 'message',
        threadId: target.id,
        input: { kind: 'text', text: 'Implement selected work' },
      },
      scope,
    );
    await session.until(
      () => session.thread(target.id),
      (thread) => thread.state === 'running',
    );
    const canonical = await readFile(join(plan.directory, 'milestones.md'), 'utf8');
    await writeFile(join(plan.directory, 'milestones.md'), '# Incomplete external write\n');
    await expect(plan.status()).rejects.toThrow('plan is invalid');
    await session.until(
      () => session.thread(target.id),
      (thread) => thread.state === 'inactive',
    );
    await nativeWait(
      () => plan.stored(),
      (state) => state.observedConflict?.phase === 'quiescent',
    );
    await writeFile(join(plan.directory, 'milestones.md'), canonical);
    expect((await plan.status()).state).toBe('blocked');
    await expect(
      session.submit(
        {
          kind: 'thread-resume',
          threadId: target.id,
          operatorConfirmation: 'Other controllers are closed',
        },
        scope,
      ),
    ).rejects.toThrow('conflicts');
    await begin(plan);
    expect((await plan.stored()).revision!.hasUncertainEffects).toBe(true);
  });
});

test('planning permits only the selected native skill and canonical finalization waits for its controller to close', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const session = await native(fixture);
    const target = await session.create('codex', 'planning-controller');
    await begin(plan, [], [target.id]);
    const revision = (await plan.stored()).revision!;
    const scope = {
      kind: 'planning' as const,
      revisionId: revision.id,
      invocationId: revision.invocation!.action.id,
    };
    await session.submit(
      {
        kind: 'thread-resume',
        threadId: target.id,
        operatorConfirmation: 'Other controllers are closed',
      },
      scope,
    );
    await session.until(
      () => session.thread(target.id),
      (thread) => thread.state === 'idle',
    );
    const catalog = await fixture.runtime.request({ kind: 'skills', threadId: target.id });
    if (catalog.kind !== 'skills' || catalog.result.state === 'unavailable')
      throw new Error('Missing native skills');
    await expect(
      session.submit(
        {
          kind: 'message',
          threadId: target.id,
          input: { kind: 'skill', skillId: catalog.result.data[0]!.id, arguments: '' },
        },
        scope,
      ),
    ).rejects.toThrow('conflicts');
    await writeFixtureControl(fixture.root, 'control.json', {
      planSkill: 'jg-plan',
      holdTurn: true,
      prompt: {
        method: 'item/fileChange/requestApproval',
        params: {
          startedAtMs: Date.now(),
          grantRoot: fixture.workspaceRoot,
          reason: 'Update the selected plan',
        },
      },
    });
    const selected = await fixture.runtime.request({ kind: 'skills', threadId: target.id });
    if (selected.kind !== 'skills' || selected.result.state === 'unavailable')
      throw new Error('Missing planning skill');
    await session.submit(
      {
        kind: 'message',
        threadId: target.id,
        input: {
          kind: 'skill',
          skillId: selected.result.data.find((skill) => skill.name === 'jg-plan')!.id,
          arguments: 'exact selected plan',
        },
      },
      scope,
    );
    await session.until(
      () => session.thread(target.id),
      (thread) => thread.state === 'waiting-approval',
    );
    const prompts = await fixture.runtime.request({ kind: 'approvals', threadId: target.id });
    if (prompts.kind !== 'approvals') throw new Error('Missing native permission');
    expect(prompts.result.data).toHaveLength(1);
    const activeTurn = (await session.thread(target.id)).activeTurnId!;
    const reply = await session.submit({
      kind: 'native-reply',
      threadId: target.id,
      expectedTurnId: activeTurn,
      approvalId: prompts.result.data[0]!.id,
      response: { kind: 'decision', decision: 'accept' },
    });
    await session.until(
      () => session.receipt(reply.id),
      (entry) => entry.delivery === 'acknowledged',
    );
    await expect(plan.finalize()).rejects.toThrow('conflicts');
    const active = await session.thread(target.id);
    await session.submit({
      kind: 'interrupt',
      threadId: target.id,
      expectedTurnId: active.activeTurnId!,
    });
    await session.until(
      () => session.thread(target.id),
      (thread) => thread.activeTurnId === null,
    );
    await session.submit({ kind: 'thread-close', threadId: target.id });
    await session.until(
      () => session.thread(target.id),
      (thread) => thread.state === 'inactive',
    );
    expect((await plan.finalize()).kind).toBe('finalized');
  });
});

test('a milestone that leaves the sequence keeps its evidence unmatched until it returns with its ID', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const completed = await completeGreeting(fixture, plan);
    const sources = (await plan.entries()).map((entry) => entry.id!);
    const original = (await plan.stored()).completions[0]!;
    await begin(plan);
    await writeFile(
      join(plan.directory, 'milestones.md'),
      sequence([
        milestone(1, 'Report', 'Format the report.', 'in progress', sources[1]),
        milestone(2, 'Export', 'Export JSON.', 'pending', sources[2]),
      ]),
    );
    const removed = await plan.finalize();
    if (removed.kind !== 'finalized') throw new Error('Expected finalization');
    expect(
      removed.result.coordination.unmatchedEvidence.map((entry) => entry.milestoneId),
    ).toStrictEqual([completed]);
    expect((await plan.stored()).completions).toStrictEqual([original]);
    await begin(plan);
    await writeFile(
      join(plan.directory, 'milestones.md'),
      sequence([
        milestone(1, 'Greeting', 'Return the requested greeting.', 'done', completed),
        milestone(2, 'Report', 'Format the report.', 'in progress', sources[1]),
        milestone(3, 'Export', 'Export JSON.', 'pending', sources[2]),
      ]),
    );
    const restored = await plan.finalize();
    if (restored.kind !== 'finalized') throw new Error('Expected finalization');
    expect(restored.result.coordination.unmatchedEvidence).toStrictEqual([]);
    // the sequence is back to its approved revision, and the done milestone counts again
    expect(restored.result.state).toBe('in-progress');
    expect((await plan.stored()).completions).toStrictEqual([original]);
  });
});

test.each(['hard-link', 'parent-link'] as const)(
  'checkout fingerprint rejects %s escape without changing selected work',
  async (kind) => {
    await withClaudeRuntime(async (fixture) => {
      const plan = await setup(fixture);
      const git = (...args: string[]) =>
        run('git', args, { cwd: fixture.workspaceRoot, timeout: 5000 });
      await initializeGit(fixture);
      await git('add', '--', 'greeting.mjs');
      await git('commit', '-m', 'test: establish link boundary', '-s', '-S');
      const outside = join(fixture.root, 'outside.txt');
      await writeFile(outside, 'Boundary fixture\n');
      const selected = join(fixture.workspaceRoot, 'linked');
      if (kind === 'hard-link') await link(outside, selected);
      else await symlink(fixture.root, selected, 'dir');
      const paths = [kind === 'hard-link' ? 'linked' : 'linked/outside.txt'];
      await expect(
        completeGreeting(fixture, plan, [
          {
            repository: 'fixture',
            directory: fixture.workspaceRoot,
            claimReference: 'claim:links',
            paths,
          },
        ]),
      ).rejects.toThrow(
        kind === 'hard-link' ? 'plan is invalid' : 'outside the allowed workspaces',
      );
      expect((await plan.stored()).completions).toStrictEqual([]);
      expect((await git('diff', '--cached', '--name-only')).stdout).toBe('');
    });
  },
);

test('reopening a completed milestone requires a new completion before done credit returns', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const id = await completeGreeting(fixture, plan);
    const sources = (await plan.entries()).map((entry) => entry.id!);
    const original = (await plan.stored()).completions[0]!;
    await begin(plan);
    await writeFile(
      join(plan.directory, 'milestones.md'),
      sequence([
        milestone(1, 'Greeting reopened', 'Review the greeting again.', 'pending', id),
        milestone(2, 'Report', 'Format the report.', 'in progress', sources[1]),
        milestone(3, 'Export', 'Export JSON.', 'pending', sources[2]),
      ]),
    );
    await plan.finalize();
    const reopened = await plan.stored();
    expect(reopened.completions).toStrictEqual([
      { ...original, reopenedBy: reopened.finalized!.action.id },
    ]);
    const current = await readFile(join(plan.directory, 'milestones.md'), 'utf8');
    await writeFile(
      join(plan.directory, 'milestones.md'),
      current.replace('**Status:** pending', '**Status:** done'),
    );
    expect((await plan.status()).state).toBe('blocked');
    await completeGreeting(fixture, plan);
    const stored = await plan.stored();
    expect(stored.completions).toHaveLength(2);
    expect(stored.completions[1]!.reopenedBy).toBeNull();
    expect((await plan.status()).state).toBe('sequence-approval-required');
  });
});

test('an explicit new planning invocation recovers an edit observed while interruption was finishing', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const session = await native(fixture);
    const target = await session.create('codex', 'in-flight-edit');
    const before = await plan.status();
    const ids = (await plan.entries()).map((entry) => entry.id!);
    const authorization = operator();
    await plan.send({
      kind: 'authorize',
      target: plan.target,
      expected: before.revision,
      action: authorization,
      mode: 'auto',
      milestoneIds: [ids[1]!],
    });
    await writeFixtureControl(fixture.root, 'control.json', {
      holdTurn: true,
      interruptDelay: 500,
    });
    await session.submit(
      {
        kind: 'message',
        threadId: target.id,
        input: { kind: 'text', text: 'Finish selected work' },
      },
      {
        kind: 'execution',
        authorizationId: authorization.id,
        milestoneId: ids[1]!,
        mode: 'auto',
        revision: before.revision,
      },
    );
    await session.until(
      () => session.thread(target.id),
      (thread) => thread.state === 'running',
    );
    const action = operator();
    await plan.send({
      kind: 'begin-revision',
      target: plan.target,
      expected: before.revision,
      action,
      intent: 'plan',
      threadIds: [],
      checkouts: [],
    });
    await writeFile(
      join(plan.directory, 'plan.md'),
      '# Plan\nAn external edit arrived during interruption.\n',
    );
    const blocked = await plan.until((state) => state.coordination.revision?.phase === 'blocked');
    expect(blocked.coordination.revision!.reason).toBe('checkpoint-unavailable');
    expect((await plan.stored()).revision!.checkpoint!.isQuiescent).toBe(false);
    await plan.send({
      kind: 'revision-invoke',
      target: plan.target,
      expected: blocked.revision,
      action: operator(),
      revisionId: action.id,
      skill: 'jg-plan',
    });
    const recovered = await plan.until((state) => state.coordination.revision?.phase === 'editing');
    expect(recovered.coordination.revision!.hasUncertainEffects).toBe(true);
    expect(
      (await plan.stored()).revision!.checkpoint!.entries.map((entry) => entry.id),
    ).toStrictEqual(ids);
    expect((await plan.stored()).revision!.checkpoint!.isQuiescent).toBe(true);
    expect((await plan.stored()).execution!.revokedBy).not.toBeNull();
  });
});

test('finalizing again after a further edit records the newer revision without its approval', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const sources = (await plan.entries()).map((entry) => entry.id!);
    await begin(plan);
    const regenerated = (title: string) =>
      sequence([
        milestone(1, title, 'Equivalent greeting requirements.', 'pending', sources[0]),
        milestone(2, 'Report', 'Format the report.', 'in progress', sources[1]),
        milestone(3, 'Export', 'Export JSON.', 'pending', sources[2]),
      ]);
    await writeFile(join(plan.directory, 'milestones.md'), regenerated('Greeting revised'));
    const first = await plan.finalize();
    if (first.kind !== 'finalized') throw new Error('Expected finalization');
    await writeFile(join(plan.directory, 'milestones.md'), regenerated('Greeting final wording'));
    const stale = await plan.status();
    expect(stale.isFinalized).toBe(false);
    expect(stale.revision.breakdownDigest).not.toBe(first.result.revision.breakdownDigest);
    const second = await plan.finalize();
    if (second.kind !== 'finalized') throw new Error('Expected finalization');
    expect(second.result.revision).toStrictEqual(stale.revision);
    expect(second.result).toMatchObject({ isFinalized: true, isSequenceApproved: false });
    expect((await plan.entries())[0]!.id).toBe(sources[0]);
  });
});

test('queued ordinary input cannot inherit a plan scope attached after its admission', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const session = await native(fixture);
    const target = await session.create('codex', 'queue-scope-boundary');
    await writeFixtureControl(fixture.root, 'control.json', { holdTurn: true });
    await session.submit({
      kind: 'message',
      threadId: target.id,
      input: { kind: 'text', text: 'Discuss ordinary work' },
    });
    const active = await session.until(
      () => session.thread(target.id),
      (thread) => thread.state === 'running',
    );
    const queued = await session.submit({
      kind: 'queue',
      threadId: target.id,
      expectedTurnId: active.activeTurnId!,
      input: { kind: 'text', text: 'Ordinary follow-up admitted without a plan' },
    });
    expect(queued.planContext).toBeNull();
    const current = await plan.status();
    const milestoneId = (await plan.entries())[1]!.id!;
    const authorization = operator();
    await plan.send({
      kind: 'authorize',
      target: plan.target,
      expected: current.revision,
      action: authorization,
      mode: 'auto',
      milestoneIds: [milestoneId],
    });
    const scoped = await session.submit(
      {
        kind: 'steer',
        threadId: target.id,
        expectedTurnId: active.activeTurnId!,
        text: 'Continue with this explicitly selected plan scope',
      },
      {
        kind: 'execution',
        authorizationId: authorization.id,
        milestoneId,
        mode: 'auto',
        revision: current.revision,
      },
    );
    await session.until(
      () => session.receipt(scoped.id),
      (entry) => entry.delivery === 'acknowledged',
    );
    await writeFixtureControl(fixture.root, 'control.json', {
      holdTurn: true,
      releaseThreadId: target.nativeId,
    });
    await fixture.runtime.request({ kind: 'skills', threadId: target.id });
    await session.until(
      () => session.thread(target.id),
      (thread) => thread.state === 'completed',
    );
    await writeFixtureControl(fixture.root, 'control.json', { holdTurn: true });
    await wait(100);
    expect((await session.receipt(queued.id)).delivery).toBe('queued');
    const before = (await readFile(join(fixture.root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(before.filter((call) => call.method === 'turn/start')).toHaveLength(1);
    await session.submit({ kind: 'queue-send', queuedActionId: queued.id });
    await session.until(
      () => session.thread(target.id),
      (thread) => thread.state === 'running',
    );
    expect((await session.receipt(queued.id)).delivery).toBe('acknowledged');
  });
});

test('trusted coordinationRoot serializes plan operations independently of private runtime storage', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    await fixture.runtime.close();
    const coordinationRoot = join(fixture.workspaceRoot, 'shared-coordination');
    await mkdir(coordinationRoot);
    const replacement = await createAgentHq({
      stateRoot: fixture.stateRoot,
      coordinationRoot,
      allowedRoots: [fixture.workspaceRoot],
    });
    try {
      const release = await acquireHqLock(coordinationRoot, 'held-shared-coordination');
      let settled = false;
      const pending = plan.status(replacement).finally(() => {
        settled = true;
      });
      try {
        await wait(64);
        expect(settled).toBe(false);
      } finally {
        await release();
      }
      expect((await pending).isSequenceApproved).toBe(true);
      expect(await readFile(join(plan.directory, 'plan.md'), 'utf8')).toContain('Deliver greeting');
    } finally {
      await replacement.close();
    }
  });
});

test.each(['record-count', 'written-bytes', 'written-bytes-malformed'] as const)(
  'coordination %s overflow fails before preparing or replacing files',
  async (boundary) => {
    await withClaudeRuntime(async (fixture) => {
      const plan = await setup(fixture);
      await completeGreeting(fixture, plan);
      let bound:
        | { session: Awaited<ReturnType<typeof native>>; thread: IManagedThread }
        | undefined;
      if (boundary !== 'record-count') {
        const session = await native(fixture);
        const thread = await session.create('codex', 'full-coordination');
        const current = await plan.status();
        const milestoneId = (await plan.entries())[1]!.id!;
        const authorization = operator();
        await plan.send({
          kind: 'authorize',
          target: plan.target,
          expected: current.revision,
          action: authorization,
          mode: 'auto',
          milestoneIds: [milestoneId],
        });
        await writeFixtureControl(fixture.root, 'control.json', { holdTurn: true });
        await session.submit(
          {
            kind: 'message',
            threadId: thread.id,
            input: { kind: 'text', text: 'Implement selected report work' },
          },
          {
            kind: 'execution',
            authorizationId: authorization.id,
            milestoneId,
            mode: 'auto',
            revision: current.revision,
          },
        );
        await session.until(
          () => session.thread(thread.id),
          (thread) => thread.state === 'running',
        );
        bound = { session, thread };
      }
      const coordination = await plan.stored();
      const receipt = coordination.completions[0]!;
      const count = boundary === 'record-count' ? 1024 : 1023;
      coordination.completions = Array.from({ length: count }, () => ({
        ...structuredClone(receipt),
        id: randomUUID(),
      }));
      if (boundary !== 'record-count') {
        const base = Buffer.byteLength(JSON.stringify(coordination, null, 2) + '\n');
        const padding = Math.ceil((8_388_608 - base) / (count - 1)) + 1;
        for (const entry of coordination.completions.slice(1))
          entry.contract += 'x'.repeat(padding);
        expect(Buffer.byteLength(JSON.stringify(coordination, null, 2) + '\n')).toBeGreaterThan(
          8_388_608,
        );
      }
      PlanCoordinationSchema.parse(coordination);
      const content = JSON.stringify(coordination);
      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(8_388_608);
      await writeFile(join(plan.directory, 'coordination.json'), content);
      const milestones = await readFile(join(plan.directory, 'milestones.md'), 'utf8');
      await expect(completeGreeting(fixture, plan)).rejects.toThrow('plan is invalid');
      expect(await readFile(join(plan.directory, 'coordination.json'), 'utf8')).toBe(content);
      expect(await readFile(join(plan.directory, 'milestones.md'), 'utf8')).toBe(milestones);
      expect((await plan.status()).pendingActionId).toBeNull();
      if (bound) {
        if (boundary === 'written-bytes-malformed')
          await writeFile(join(plan.directory, 'milestones.md'), '# Incomplete external write\n');
        else
          await writeFile(
            join(plan.directory, 'plan.md'),
            '# Plan\nAn external requirement changed.\n',
          );
        await expect(plan.status()).rejects.toThrow('plan is invalid');
        await bound.session.until(
          () => bound!.session.thread(bound!.thread.id),
          (thread) => thread.state === 'inactive',
        );
        expect(await readFile(join(plan.directory, 'coordination.json'), 'utf8')).toBe(content);
      }
    });
  },
);

test('a retained stale skills binding permits plan approval and breakdown revision without reopening execution', async () => {
  await withClaudeRuntime(async (fixture) => {
    const source =
      '---\nid: revision-example\nrevision: 1\nstatus: pending\n---\n# Plan\nDeliver greeting, report and export commands.\n';
    const fingerprint = (plan: string) =>
      fingerprintPlan(plan, {
        excludeMetadataKeys: ['created_at', 'updated_at', 'revision', 'status'],
      }).sha256!;
    const binding = `---\njg_skills:\n  plan_id: revision-example\n  plan_revision: 1\n  plan_content_sha256: ${fingerprint(source)}\n---\n`;
    const plan = await setup(
      fixture,
      binding +
        sequence([
          milestone(1, 'Greeting', 'Return the requested greeting.'),
          milestone(2, 'Report', 'Format the report.', 'in progress'),
        ]),
      source,
    );
    const before = await plan.entries();
    const revisionAction = await begin(plan);
    const originalSequence = await readFile(join(plan.directory, 'milestones.md'), 'utf8');
    const revised = source
      .replace('revision: 1', 'revision: 2')
      .replace('export commands.', 'export commands with strict validation.');
    await writeFile(join(plan.directory, 'plan.md'), revised);
    const stale = await plan.status();
    expect(stale).toMatchObject({
      skillsBinding: 'stale',
      state: 'plan-approval-required',
      isPlanApproved: false,
      isFinalized: false,
    });
    expect(await readFile(join(plan.directory, 'milestones.md'), 'utf8')).toBe(originalSequence);
    await plan.approve('plan');
    expect(await plan.status()).toMatchObject({
      skillsBinding: 'stale',
      state: 'breakdown-required',
      isPlanApproved: true,
      isSequenceApproved: false,
    });
    await expect(plan.finalize()).rejects.toMatchObject({ code: 'JG_AGENT_HQ_ACTION_CONFLICT' });
    const approved = await plan.status();
    await plan.send({
      kind: 'revision-invoke',
      target: plan.target,
      action: operator(),
      expected: approved.revision,
      revisionId: revisionAction.id,
      skill: 'jg-breakdown',
    });
    await plan.until((status) => status.coordination.revision?.phase === 'editing');
    await writeFile(
      join(plan.directory, 'milestones.md'),
      originalSequence
        .replace('plan_revision: 1', 'plan_revision: 2')
        .replace(fingerprint(source), fingerprint(revised)),
    );
    const result = await plan.finalize();
    expect(result.kind).toBe('finalized');
    expect(await plan.status()).toMatchObject({
      skillsBinding: 'current',
      isFinalized: true,
      isPlanApproved: true,
      isSequenceApproved: false,
    });
    expect((await plan.entries()).map((entry) => entry.id)).toStrictEqual(
      before.map((entry) => entry.id),
    );
    await plan.approve('sequence');
    await plan.mutate({ kind: 'authorize', mode: 'supervised', milestoneIds: [before[0]!.id!] });
    const current = await plan.status();
    const execution = current.coordination.execution!;
    const checked = await plan.send({
      kind: 'check-execution',
      target: plan.target,
      expected: current.revision,
      authorizationId: execution.action.id,
      milestoneId: before[0]!.id!,
      mode: 'supervised',
    });
    expect(checked.kind).toBe('execution-check');
  });
});
