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
  type IPlanCorrespondence,
  type IPlanCheckout,
} from 'jg-agent-hq/contracts';
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

const milestone = (ordinal: number, title: string, objective: string, status = 'pending') =>
  `## Milestone ${ordinal}: ${title}\n**Status:** ${status}\n\n**Objective:** ${objective}\n**Dependencies:** None.\n**Scope:** ${title} module.\n**Implementation:** Deliver the stated objective.\n**Verification:** Run the module checks.\n**Acceptance:** The objective holds.\n**Review checkpoint:** Review the module.\n\n`;
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
  if (content !== null)
    await writeFile(
      join(directory, 'milestones.md'),
      content ??
        sequence([
          milestone(1, 'Greeting', 'Return the requested greeting.'),
          milestone(2, 'Report', 'Format the report.', 'in progress'),
          milestone(3, 'Export', 'Export JSON.'),
        ]),
    );
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
  const finalize = async (confirmation?: {
    proposalId: string;
    decisions: IPlanCorrespondence[];
  }) => {
    const current = await status();
    return send({
      kind: 'finalize',
      target,
      expected: current.revision,
      action: operator(),
      confirmation,
    });
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
  const collection = async (
    kind: 'sources' | 'drafts' | 'evidence' | 'correspondences',
    limit = 32,
    cursor?: string,
  ) => {
    const response = await send({
      kind: 'reconciliation',
      target,
      collection: kind,
      limit,
      cursor,
    });
    if (response.kind !== 'reconciliation') throw new Error('Missing reconciliation page');
    return response.result;
  };
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
    collection,
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

const decisionsFor = async (plan: Awaited<ReturnType<typeof setup>>, sources: string[]) => {
  const page = await plan.collection('drafts');
  const drafts = page.data.filter((row) => row.kind === 'draft').map((row) => row.entry);
  const greeting = drafts.find((draft) => draft.title === 'Greeting result')!;
  const changed = drafts.find((draft) => draft.title === 'Export')!;
  const state = await plan.stored();
  return {
    proposalId: state.revision!.proposal!.id,
    decisions: [
      {
        sourceIds: [sources[0]!],
        targetIds: [greeting.id],
        relation: 'equivalent' as const,
        retainedPairs: [{ sourceId: sources[0]!, targetId: greeting.id }],
      },
      {
        sourceIds: [sources[2]!],
        targetIds: [changed.id],
        relation: 'requirements-changed' as const,
        retainedPairs: [],
      },
    ],
  };
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
    const evidence = await plan.collection('evidence');
    expect(evidence.data).toHaveLength(1);
    expect(evidence.data[0].kind === 'evidence' && evidence.data[0].entry.milestoneId).toBeNull();
    await fixture.runtime.close();
    const restarted = await createAgentHq({
      stateRoot: fixture.stateRoot,
      allowedRoots: [fixture.workspaceRoot],
    });
    try {
      expect((await plan.status(restarted)).state).toBe('completed');
      const retained = await plan.send(
        { kind: 'reconciliation', target: plan.target, collection: 'evidence' },
        restarted,
      );
      expect(retained.kind === 'reconciliation' && retained.result.data).toHaveLength(1);
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

test('dropping a sequence requires one explicit omission confirmation before whole-plan execution', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const completed = await completeGreeting(fixture, plan);
    await begin(plan);
    await writeFile(
      join(plan.directory, 'plan.md'),
      '# Plan\nFinish only the report after the verified greeting.\n',
    );
    await rm(join(plan.directory, 'milestones.md'));
    const proposed = await plan.finalize();
    expect(proposed.kind).toBe('reconciliation-required');
    const stored = await plan.stored();
    const proposal = stored.revision?.proposal;
    if (!proposal) throw new Error('Expected saved reconciliation');
    expect(proposal.unmatchedSourceIds).toContain(completed);
    expect(proposal.drafts).toStrictEqual([]);
    await plan.approve('plan');
    const current = await plan.status();
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
    const finalized = await plan.finalize({
      proposalId: proposal.id,
      decisions: [
        {
          sourceIds: proposal.unmatchedSourceIds,
          targetIds: [],
          relation: 'omitted',
          retainedPairs: [],
        },
      ],
    });
    expect(finalized.kind).toBe('finalized');
    expect((await plan.stored()).completions).toStrictEqual(stored.completions);
    expect((await plan.status()).state).toBe('ready');
    expect(
      (await plan.collection('sources')).data.some(
        (row) => row.kind === 'source' && row.entry.id === completed,
      ),
    ).toBe(true);
  });
});

test('checkpoint, deletion, regeneration and one confirmation preserve reworded completed and partial work', async () => {
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
        milestone(1, 'Greeting result', 'Return the requested greeting using equivalent wording.'),
        milestone(2, 'Report', 'Format the report.'),
        milestone(3, 'Export', 'Export JSON with a checksum.'),
      ]),
    );
    await plan.approve('plan');
    expect((await plan.finalize()).kind).toBe('reconciliation-required');
    const mapping = await decisionsFor(plan, sources);
    const result = await plan.finalize(mapping);
    expect(result.kind).toBe('finalized');
    const current = await plan.entries();
    expect(current.map((entry) => entry.status)).toStrictEqual(['done', 'in progress', 'pending']);
    expect(current[0]!.id).toBe(completed);
    expect(current[1]!.id).toBe(sources[1]);
    expect(current[2]!.id).not.toBe(sources[2]);
    const after = await plan.stored();
    expect(after.completions).toStrictEqual(before.completions);
    expect(after.correspondences[0]!.sources[0]!.contractDigest).toBe(
      before.completions[0]!.contractDigest,
    );
    await plan.approve('sequence');
    const ready = await plan.status();
    expect(ready.isSequenceApproved).toBe(true);
    expect(ready.state).toBe('in-progress');
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

test('one mapping must resolve every unmatched source and cannot silently reset completed work', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    await completeGreeting(fixture, plan);
    const sources = (await plan.entries()).map((entry) => entry.id!);
    await begin(plan);
    await rm(join(plan.directory, 'milestones.md'));
    await writeFile(
      join(plan.directory, 'milestones.md'),
      sequence([
        milestone(1, 'Greeting result', 'Return the requested greeting using equivalent wording.'),
        milestone(2, 'Report', 'Format the report.'),
        milestone(3, 'Export', 'Export JSON with a checksum.'),
      ]),
    );
    await plan.finalize();
    const mapping = await decisionsFor(plan, sources);
    const canonical = await readFile(join(plan.directory, 'milestones.md'), 'utf8');
    await expect(
      plan.finalize({ ...mapping, decisions: mapping.decisions.slice(0, 1) }),
    ).rejects.toThrow('conflicts');
    await expect(
      plan.finalize({ ...mapping, decisions: [...mapping.decisions, mapping.decisions[0]!] }),
    ).rejects.toThrow('conflicts');
    expect(await readFile(join(plan.directory, 'milestones.md'), 'utf8')).toBe(canonical);
    expect((await plan.status()).state).toBe('blocked');
    await plan.finalize(mapping);
    expect((await plan.entries())[0]!.status).toBe('done');
  });
});

test('unverified done evidence blocks equivalent carryover until explicitly reopened', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const sources = await plan.entries();
    const raw = await readFile(join(plan.directory, 'milestones.md'), 'utf8');
    await writeFile(
      join(plan.directory, 'milestones.md'),
      raw.replace('**Status:** pending', '**Status:** done'),
    );
    await begin(plan);
    await writeFile(
      join(plan.directory, 'milestones.md'),
      sequence([
        milestone(1, 'Greeting result', 'Equivalent greeting text.'),
        milestone(2, 'Report', 'Format the report.'),
        milestone(3, 'Export', 'Export JSON.'),
      ]),
    );
    await plan.finalize();
    const drafts = (await plan.collection('drafts')).data
      .filter((row) => row.kind === 'draft')
      .map((row) => row.entry);
    const greeting = drafts.find((draft) => draft.title === 'Greeting result')!;
    const proposalId = (await plan.stored()).revision!.proposal!.id;
    const equivalent: IPlanCorrespondence = {
      sourceIds: [sources[0]!.id!],
      targetIds: [greeting.id],
      relation: 'equivalent',
      retainedPairs: [{ sourceId: sources[0]!.id!, targetId: greeting.id }],
    };
    await expect(plan.finalize({ proposalId, decisions: [equivalent] })).rejects.toThrow(
      'conflicts',
    );
    await plan.finalize({ proposalId, decisions: [{ ...equivalent, relation: 'reopened' }] });
    const current = await plan.entries();
    expect(current[0]!.id).toBe(sources[0]!.id);
    expect(current[0]!.status).toBe('pending');
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

test('observed external deletion closes admission and stops only bound execution before reconciliation', async () => {
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

test('retained checkpoint and proposed drafts use bounded stable seek pages over 1024 milestones', async () => {
  await withClaudeRuntime(async (fixture) => {
    const content = sequence(
      Array.from({ length: 1024 }, (_, index) =>
        milestone(index + 1, `Feature ${index + 1}`, `Deliver requirement ${index + 1}.`),
      ),
    );
    const plan = await setup(fixture, content);
    await begin(plan);
    await writeFile(
      join(plan.directory, 'milestones.md'),
      content.replaceAll('Deliver requirement', 'Implement requirement'),
    );
    await plan.finalize();
    for (const collection of ['sources', 'drafts'] as const) {
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await plan.collection(collection, 128, cursor);
        expect(page.data).toHaveLength(128);
        ids.push(
          ...page.data.map((row) =>
            row.kind === 'source' || row.kind === 'draft' ? row.entry.id : 'invalid',
          ),
        );
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(ids).toHaveLength(1024);
      expect(new Set(ids).size).toBe(1024);
    }
    expect((await plan.collection('evidence')).data).toStrictEqual([]);
    expect((await plan.collection('correspondences')).nextCursor).toBeNull();
    const first = await plan.collection('sources');
    expect(first.data).toHaveLength(32);
    await expect(plan.collection('sources', 64, first.nextCursor!)).rejects.toThrow('cursor');
    await expect(plan.collection('drafts', 32, first.nextCursor!)).rejects.toThrow('cursor');
    await expect(plan.collection('sources', 32, 'invalid')).rejects.toThrow('cursor');
    await plan.approve('plan');
    await expect(plan.collection('sources', 32, first.nextCursor!)).rejects.toThrow('cursor');
  });
});

test('a finalization write retry after restart reuses the saved mapping, assigned IDs and original evidence', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    await completeGreeting(fixture, plan);
    const sources = (await plan.entries()).map((entry) => entry.id!);
    await begin(plan);
    await writeFile(
      join(plan.directory, 'milestones.md'),
      sequence([
        milestone(1, 'Greeting result', 'Equivalent greeting wording.'),
        milestone(2, 'Report', 'Format the report.'),
        milestone(3, 'Export', 'Export JSON with a checksum.'),
      ]),
    );
    await plan.finalize();
    const mapping = await decisionsFor(plan, sources);
    const before = await plan.status();
    const command: IPlanCommandInput = {
      kind: 'finalize',
      target: plan.target,
      expected: before.revision,
      action: operator(),
      confirmation: mapping,
    };
    const database = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'));
    try {
      database.exec(
        "CREATE TRIGGER stop_plan_completion BEFORE UPDATE ON plan_operation WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ABORT, 'checkpoint replay test'); END;",
      );
      await expect(plan.send(command)).rejects.toThrow('store failed');
    } finally {
      database.exec('DROP TRIGGER stop_plan_completion');
      database.close();
    }
    const persisted = await plan.stored();
    const canonical = await readFile(join(plan.directory, 'milestones.md'), 'utf8');
    expect(persisted.revision!.proposal!.confirmation!.action.id).toBe(command.action.id);
    await fixture.runtime.close();
    const replacement = await createAgentHq({
      stateRoot: fixture.stateRoot,
      allowedRoots: [fixture.workspaceRoot],
    });
    try {
      expect((await plan.send(command, replacement)).kind).toBe('finalized');
      expect(await readFile(join(plan.directory, 'milestones.md'), 'utf8')).toBe(canonical);
      expect((await plan.stored()).correspondences).toStrictEqual(persisted.correspondences);
      expect((await plan.stored()).completions).toStrictEqual(persisted.completions);
      expect((await plan.status(replacement)).pendingActionId).toBeNull();
    } finally {
      await replacement.close();
    }
  });
});

test('real installed jg-breakdown output carries reworded completed and partial work through canonical presentation', async () => {
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
    await writeFile(join(plan.directory, 'milestones.md'), revised);
    expect((await plan.finalize()).kind).toBe('reconciliation-required');
    const proposal = (await plan.stored()).revision!.proposal!;
    expect(proposal.unmatchedSourceIds).toHaveLength(3);
    expect(proposal.drafts.map((entry) => entry.status)).toStrictEqual([
      'done',
      'in progress',
      'pending',
    ]);
    const decisions: IPlanCorrespondence[] = proposal.drafts.map((draft, index) => ({
      sourceIds: [original[index]!.id!],
      targetIds: [draft.id],
      relation: index === 2 ? 'requirements-changed' : 'equivalent',
      retainedPairs: index === 2 ? [] : [{ sourceId: original[index]!.id!, targetId: draft.id }],
    }));
    const canonical = await plan.finalize({ proposalId: proposal.id, decisions });
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
    expect(prompts.result).toHaveLength(1);
    const activeTurn = (await session.thread(target.id)).activeTurnId!;
    const reply = await session.submit({
      kind: 'native-reply',
      threadId: target.id,
      expectedTurnId: activeTurn,
      approvalId: prompts.result[0]!.id,
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

test('split, merged and omitted correspondence retain every original receipt and partial contract', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    await completeGreeting(fixture, plan);
    const sources = await plan.entries();
    const original = (await plan.stored()).completions[0]!;
    await begin(plan);
    await writeFile(
      join(plan.directory, 'milestones.md'),
      sequence([
        milestone(1, 'Greeting text', 'Return the greeting text.'),
        milestone(2, 'Greeting output', 'Expose the greeting output.'),
        milestone(3, 'Report composition', 'Combine the partial report and export requirement.'),
      ]),
    );
    await plan.finalize();
    const proposal = (await plan.stored()).revision!.proposal!;
    const drafts = proposal.drafts;
    await plan.finalize({
      proposalId: proposal.id,
      decisions: [
        {
          sourceIds: [sources[0]!.id!],
          targetIds: [drafts[0]!.id, drafts[1]!.id],
          relation: 'equivalent',
          retainedPairs: [{ sourceId: sources[0]!.id!, targetId: drafts[0]!.id }],
        },
        {
          sourceIds: [sources[1]!.id!, sources[2]!.id!],
          targetIds: [drafts[2]!.id],
          relation: 'equivalent',
          retainedPairs: [],
        },
      ],
    });
    expect((await plan.entries()).map((entry) => entry.status)).toStrictEqual([
      'done',
      'done',
      'in progress',
    ]);
    expect((await plan.stored()).completions).toStrictEqual([original]);
    await plan.approve('sequence');
    const state = await plan.status();
    await plan.send({
      kind: 'authorize',
      target: plan.target,
      expected: state.revision,
      action: operator(),
      mode: 'supervised',
      milestoneIds: [(await plan.entries())[2]!.id!],
    });
    const before = await plan.entries();
    await begin(plan);
    await writeFile(
      join(plan.directory, 'milestones.md'),
      sequence([
        milestone(1, 'Report composition revised', 'Keep the partial combined report requirement.'),
      ]),
    );
    await plan.finalize();
    const next = (await plan.stored()).revision!.proposal!;
    await plan.finalize({
      proposalId: next.id,
      decisions: [
        {
          sourceIds: [before[0]!.id!, before[1]!.id!],
          targetIds: [],
          relation: 'omitted',
          retainedPairs: [],
        },
        {
          sourceIds: [before[2]!.id!],
          targetIds: [next.drafts[0]!.id],
          relation: 'equivalent',
          retainedPairs: [{ sourceId: before[2]!.id!, targetId: next.drafts[0]!.id }],
        },
      ],
    });
    expect((await plan.entries())[0]!.status).toBe('in progress');
    expect((await plan.stored()).completions).toStrictEqual([original]);
    const records = (await plan.collection('correspondences')).data;
    expect(
      records.filter((row) => row.kind === 'correspondence' && row.entry.relation === 'omitted'),
    ).toHaveLength(1);
    expect((await plan.collection('sources')).data.length).toBeGreaterThanOrEqual(5);
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

test('explicit reopening retains original verified evidence but requires a new completion before done credit returns', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const id = await completeGreeting(fixture, plan);
    const original = (await plan.stored()).completions[0]!;
    await begin(plan);
    await writeFile(
      join(plan.directory, 'milestones.md'),
      sequence([
        milestone(1, 'Greeting reopened', 'Review the greeting again.'),
        milestone(2, 'Report', 'Format the report.'),
        milestone(3, 'Export', 'Export JSON.'),
      ]),
    );
    await plan.finalize();
    const proposal = (await plan.stored()).revision!.proposal!;
    const draft = proposal.drafts[0]!;
    await plan.finalize({
      proposalId: proposal.id,
      decisions: [
        {
          sourceIds: [id],
          targetIds: [draft.id],
          relation: 'reopened',
          retainedPairs: [{ sourceId: id, targetId: draft.id }],
        },
      ],
    });
    expect((await plan.entries())[0]!.status).toBe('pending');
    const current = await readFile(join(plan.directory, 'milestones.md'), 'utf8');
    await writeFile(
      join(plan.directory, 'milestones.md'),
      current.replace('**Status:** pending', '**Status:** done'),
    );
    expect((await plan.status()).state).toBe('blocked');
    await completeGreeting(fixture, plan);
    const stored = await plan.stored();
    expect(stored.completions[0]).toStrictEqual(original);
    expect(stored.completions).toHaveLength(2);
    expect(stored.completions[1]!.reopenActionId).toBe(stored.correspondences[0]!.action.id);
    expect((await plan.status()).state).toBe('sequence-approval-required');
  });
});

test('an explicit new planning invocation reconciles an edit observed while interruption was finishing', async () => {
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

test('a fresh explicit breakdown invocation replaces a stale unconfirmed proposal without accepting stale confirmation', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const sources = await plan.entries();
    await begin(plan);
    const regenerated = sequence([
      milestone(1, 'Greeting revised', 'Equivalent greeting requirements.'),
      milestone(2, 'Report', 'Format the report.'),
      milestone(3, 'Export', 'Export JSON.'),
    ]);
    await writeFile(join(plan.directory, 'milestones.md'), regenerated);
    await plan.finalize();
    const first = (await plan.stored()).revision!.proposal!;
    await writeFile(
      join(plan.directory, 'milestones.md'),
      regenerated.replace('Greeting revised', 'Greeting final wording'),
    );
    await expect(plan.finalize()).rejects.toThrow('conflicts');
    const current = await plan.status();
    await plan.send({
      kind: 'revision-invoke',
      target: plan.target,
      expected: current.revision,
      action: operator(),
      revisionId: current.coordination.revision!.id,
      skill: 'jg-breakdown',
    });
    await plan.until((state) => state.coordination.revision?.phase === 'editing');
    expect((await plan.stored()).revision!.proposal).toBeNull();
    await plan.finalize();
    const next = (await plan.stored()).revision!.proposal!;
    expect(next.id).not.toBe(first.id);
    const draft = next.drafts[0]!;
    const decisions: IPlanCorrespondence[] = [
      {
        sourceIds: [sources[0]!.id!],
        targetIds: [draft.id],
        relation: 'equivalent',
        retainedPairs: [{ sourceId: sources[0]!.id!, targetId: draft.id }],
      },
    ];
    await expect(plan.finalize({ proposalId: first.id, decisions })).rejects.toThrow('conflicts');
    await plan.finalize({ proposalId: next.id, decisions });
    expect((await plan.entries())[0]!.id).toBe(sources[0]!.id);
    expect((await plan.status()).isSequenceApproved).toBe(false);
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
