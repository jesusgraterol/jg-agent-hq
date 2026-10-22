// @vitest-environment node
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, symlink, readdir, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAgentHq, acquireHqLock, type IAgentHq } from 'jg-agent-hq';
import type {
  IPlanComparison,
  IPlanCoordination,
  IPlanCommandInput,
  IPlanOperatorAction,
  IPlanTarget,
  IPlanStatus,
  IPlanMetadata,
} from 'jg-agent-hq/contracts';
import { fingerprintPlan } from 'jg-plans';
import { expect, test } from 'vitest';

import {
  withClaudeRuntime,
  type IClaudeFixture,
} from '../../scripts/test-support/claude-runtime.js';

const milestone = (ordinal: number, id?: string, status = 'pending') =>
  `## Milestone ${ordinal}: Feature ${ordinal}\n**Status:** ${status}\n${id ? `**Milestone ID:** ${id}\n` : ''}\n**Objective:** Complete feature ${ordinal}.\n**Dependencies:** None.\n**Scope:** Feature code.\n**Implementation:** Implement feature ${ordinal}.\n**Verification:** Actual checks.\n**Acceptance:** Correct behavior.\n**Review checkpoint:** Review feature ${ordinal}.\n\n`;
const sequence = (count = 2, ids?: string[]) =>
  `# Milestones\n\n## Overview\n\n| Milestone | Name | Status |\n| --- | --- | --- |\n${Array.from({ length: count }, (_, i) => `| ${i + 1} | Feature ${i + 1} | pending |`).join('\n')}\n\n${Array.from({ length: count }, (_, i) => milestone(i + 1, ids?.[i])).join('')}## Approval required\nApprove the sequence.\n`;
const action = (): IPlanOperatorAction => ({
  id: randomUUID(),
  operatorId: 'workspace-owner',
  source: { kind: 'user-action', reference: `local-click:${randomUUID()}` },
});
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

const setup = async (fixture: IClaudeFixture, content = sequence()) => {
  const directory = join(fixture.workspaceRoot, 'selected-plan');
  await mkdir(directory);
  await writeFile(join(directory, 'plan.md'), '# Plan\nBuild the workspace.\n');
  await writeFile(join(directory, 'milestones.md'), content);
  const target: IPlanTarget = { directory };
  const send = async (command: IPlanCommandInput, runtime?: IAgentHq) => {
    const response = await (runtime
      ? runtime.request({ kind: 'plan', command })
      : fixture.runtime.request({ kind: 'plan', command }));
    if (response.kind !== 'plan') throw new Error('Missing plan response');
    return response.result;
  };
  const status = async (runtime?: IAgentHq): Promise<IPlanStatus> => {
    const response = await send({ kind: 'status', target }, runtime);
    if (response.kind !== 'status') throw new Error('Missing plan status');
    return response.result;
  };
  const finalize = async () => {
    const before = await status();
    const command = {
      kind: 'finalize' as const,
      target,
      action: action(),
      expected: before.revision,
    };
    const response = await send(command);
    if (response.kind !== 'finalized') throw new Error('Missing finalized sequence');
    return { response, command };
  };
  const approve = async (scope: 'plan' | 'sequence') => {
    const current = await status();
    const command = {
      kind: 'approve' as const,
      target,
      scope,
      action: action(),
      expected: current.revision,
      presentationHash: (scope === 'plan'
        ? current.inspection.plan
        : current.inspection.milestones)!,
    };
    await send(command);
    return command;
  };
  const page = async (limit = 32, cursor?: string) => {
    const response = await send({ kind: 'milestones', target, limit, cursor });
    if (response.kind !== 'milestones') throw new Error('Missing milestones');
    return response.result;
  };
  const ready = async () => {
    await finalize();
    await approve('plan');
    await approve('sequence');
    return status();
  };
  return { directory, target, send, status, finalize, approve, page, ready };
};

test('generic plan finalization presents stable IDs without granting approval, execution or native permission', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const before = await plan.status();
    expect(before.state).toBe('plan-approval-required');
    expect(before.revision.breakdownDigest).toBeNull();
    const { response, command } = await plan.finalize();
    const canonical = await readFile(join(plan.directory, 'milestones.md'), 'utf8');
    expect(response.content).toBe(canonical);
    expect(response.result.coordination.finalized).toMatchObject({
      action: command.action,
      revision: response.result.revision,
      fileHash: hash(canonical),
    });
    expect(response.result.pendingActionId).toBeNull();
    expect(canonical.match(/^\*\*Milestone ID:\*\* /gm)).toHaveLength(2);
    expect(response.result.coordination).toMatchObject({
      planApproval: null,
      sequenceApproval: null,
      execution: null,
    });
    const retry = await plan.send(command);
    expect(retry).toStrictEqual(response);
    await plan.approve('plan');
    expect((await plan.status()).state).toBe('sequence-approval-required');
    await plan.approve('sequence');
    expect((await plan.status()).state).toBe('ready');
    expect((await plan.status()).coordination.execution).toBeNull();
    const native = await readFile(join(fixture.root, 'calls.jsonl'), 'utf8');
    expect(native).not.toMatch(/turn\/start|approval|thread\/start|thread\/resume/);
    const ledger = JSON.parse(await readFile(join(plan.directory, 'coordination.json'), 'utf8'));
    expect(ledger.planApproval.action.operatorId).toBe('workspace-owner');
    expect(ledger.planApproval.action.source.kind).toBe('user-action');
    expect((await readdir(plan.directory)).filter((name) => name.endsWith('.tmp'))).toStrictEqual(
      [],
    );
  });
});

test.each(['supervised', 'auto'] as const)(
  'an undivided plan has explicit %s authority without a fabricated milestone sequence',
  async (mode) => {
    await withClaudeRuntime(async (fixture) => {
      const plan = await setup(fixture);
      await rm(join(plan.directory, 'milestones.md'));
      const { response, command } = await plan.finalize();
      expect(response.content).toBeNull();
      expect(response.result.isFinalized).toBe(true);
      expect(response.result.isPlanApproved).toBe(false);
      expect(response.result.skillsBinding).toBe('absent');
      expect(response.result.milestoneCount).toBe(0);
      expect(await plan.send(command)).toStrictEqual(response);
      await plan.approve('plan');
      const current = await plan.status();
      expect(current.state).toBe('ready');
      expect(current.isSequenceApproved).toBe(false);
      expect((await plan.page()).data).toStrictEqual([]);
      await expect(
        plan.send({
          kind: 'approve',
          target: plan.target,
          action: action(),
          expected: current.revision,
          scope: 'sequence',
          presentationHash: current.inspection.plan,
        }),
      ).rejects.toThrow('conflicts');
      const authorize = {
        kind: 'authorize' as const,
        target: plan.target,
        action: action(),
        expected: current.revision,
        mode,
        milestoneIds: [],
      };
      await expect(
        plan.send({ ...authorize, action: action(), milestoneIds: [randomUUID()] }),
      ).rejects.toThrow('conflicts');
      await plan.send(authorize);
      const check = {
        kind: 'check-execution' as const,
        target: plan.target,
        expected: current.revision,
        authorizationId: authorize.action.id,
        milestoneId: null,
        mode,
      };
      expect((await plan.send(check)).kind).toBe('execution-check');
      await expect(plan.send({ ...check, milestoneId: randomUUID() })).rejects.toThrow('conflicts');
      await expect(
        plan.send({ ...check, mode: mode === 'auto' ? 'supervised' : 'auto' }),
      ).rejects.toThrow('conflicts');
      await plan.send({
        kind: 'revoke',
        target: plan.target,
        action: action(),
        expected: current.revision,
        scope: 'execution',
      });
      await expect(plan.send(check)).rejects.toThrow('conflicts');
      await plan.send(authorize);
      await expect(plan.send(check)).rejects.toThrow('conflicts');
      expect((await readdir(plan.directory)).sort()).toStrictEqual([
        'coordination.json',
        'plan.md',
      ]);
      expect(await readFile(join(fixture.root, 'calls.jsonl'), 'utf8')).not.toMatch(
        /turn\/start|thread\/start|thread\/resume/,
      );
    });
  },
);

test.each(['compatible', 'contradiction'] as const)(
  'coordinator %s evidence survives authority writes and restart without changing execution identity',
  async (verdict) => {
    await withClaudeRuntime(async (fixture) => {
      const plan = await setup(fixture);
      await plan.finalize();
      const before = await plan.status();
      const comparison: IPlanComparison = {
        sourceRevision: before.revision,
        targetDirectory: join(fixture.workspaceRoot, 'other-plan'),
        targetRevision: { planDigest: hash('other plan'), breakdownDigest: null },
        verdict,
        reason: 'The coordinator reviewed shared ownership and requirements.',
        reviewer: {
          provider: 'codex',
          cliVersion: '0.163.0',
          model: null,
          reference: 'native-review:comparison-1',
        },
        reviewedAt: Date.now(),
      };
      const path = join(plan.directory, 'coordination.json');
      const release = await acquireHqLock(fixture.stateRoot, 'coordinator comparison');
      try {
        const coordination: IPlanCoordination = JSON.parse(await readFile(path, 'utf8'));
        coordination.comparisons = [comparison];
        const temporary = join(plan.directory, '.comparison.json.tmp');
        await writeFile(temporary, `${JSON.stringify(coordination)}\n`);
        await rename(temporary, path);
      } finally {
        await release();
      }
      const reviewed = await plan.status();
      expect(reviewed.revision).toStrictEqual(before.revision);
      expect(reviewed.inspection.coordination).not.toBe(before.inspection.coordination);
      expect(reviewed.coordination.comparisonCount).toBe(1);
      expect(reviewed.coordination).not.toHaveProperty('comparisons');
      expect(reviewed.isPlanApproved).toBe(false);
      expect(reviewed.isSequenceApproved).toBe(false);
      expect(reviewed.coordination.execution).toBeNull();

      await plan.approve('plan');
      await plan.approve('sequence');
      await plan.send({
        kind: 'revoke',
        target: plan.target,
        action: action(),
        expected: before.revision,
        scope: 'all',
      });
      await fixture.runtime.close();
      const restarted = await createAgentHq({
        stateRoot: fixture.stateRoot,
        allowedRoots: [fixture.workspaceRoot],
      });
      try {
        const current = await plan.status(restarted);
        expect(current.revision).toStrictEqual(before.revision);
        expect(current.coordination.comparisonCount).toBe(1);
        expect(current.isPlanApproved).toBe(false);
        expect(current.isSequenceApproved).toBe(false);
        expect(JSON.parse(await readFile(path, 'utf8')).comparisons).toStrictEqual([comparison]);
      } finally {
        await restarted.close();
      }
    });
  },
);

test('explicit authorization binds current revisions, selected IDs and exact execution mode', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    await plan.ready();
    const page = await plan.page();
    const ids = page.data.map((m) => m.id!);
    const current = await plan.status();
    const authorize = {
      kind: 'authorize' as const,
      target: plan.target,
      action: action(),
      expected: current.revision,
      mode: 'supervised' as const,
      milestoneIds: [ids[0]!],
    };
    await plan.send(authorize);
    const check = {
      kind: 'check-execution' as const,
      target: plan.target,
      expected: current.revision,
      authorizationId: authorize.action.id,
      milestoneId: ids[0]!,
      mode: 'supervised' as const,
    };
    expect((await plan.send(check)).kind).toBe('execution-check');
    await expect(plan.send({ ...check, milestoneId: ids[1]! })).rejects.toThrow('conflicts');
    await expect(plan.send({ ...check, mode: 'auto' })).rejects.toThrow('conflicts');
    await plan.send({
      kind: 'revoke',
      target: plan.target,
      expected: current.revision,
      scope: 'execution',
      action: action(),
    });
    await expect(plan.send(check)).rejects.toThrow('conflicts');
    await plan.send(authorize);
    await expect(plan.send(check)).rejects.toThrow('conflicts');
    const auto = { ...authorize, mode: 'auto' as const, action: action(), milestoneIds: ids };
    await plan.send(auto);
    expect(
      (
        await plan.send({
          ...check,
          mode: 'auto',
          authorizationId: auto.action.id,
          milestoneId: ids[1]!,
        })
      ).kind,
    ).toBe('execution-check');
  });
});

test('approval rejects raw output, stale inspection, stale revision, forged provenance and reused action payloads', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    await plan.approve('plan');
    await expect(plan.approve('sequence')).rejects.toThrow('conflicts');
    const { command } = await plan.finalize();
    await expect(
      plan.send({
        ...command,
        action: { ...command.action, source: { kind: 'agent-assertion', reference: 'I approve' } },
      } as unknown as IPlanCommandInput),
    ).rejects.toThrow('request is invalid');
    await expect(
      plan.send({
        ...command,
        action: { ...command.action, source: { kind: 'imported-feedback', reference: 'Approved' } },
      } as unknown as IPlanCommandInput),
    ).rejects.toThrow('request is invalid');
    await expect(
      plan.send({ ...command, expected: { ...command.expected, planDigest: 'a'.repeat(64) } }),
    ).rejects.toThrow('conflicts');
    const current = await plan.status();
    await expect(
      plan.send({
        kind: 'approve',
        target: plan.target,
        action: action(),
        scope: 'sequence',
        expected: current.revision,
        presentationHash: 'a'.repeat(64),
      }),
    ).rejects.toThrow('conflicts');
    await writeFile(join(plan.directory, 'plan.md'), 'Changed contract.\n');
    await expect(
      plan.send({
        kind: 'approve',
        target: plan.target,
        action: action(),
        scope: 'plan',
        expected: current.revision,
        presentationHash: current.inspection.plan,
      }),
    ).rejects.toThrow('conflicts');
  });
});

test('host profile, status, Overview and unrelated session labels preserve approval; contract changes do not', async () => {
  const metadata: IPlanMetadata = {
    scope: 'local',
    extensions: {},
    repositories: ['workspace'],
    errorReservations: [],
  };
  await withClaudeRuntime(
    async (fixture) => {
      const plan = await setup(fixture);
      const prefix = '---\npriority: P2\npriorityReason: Normal work.\n---\n';
      const body = '# Plan\nBuild the workspace.\n';
      await writeFile(join(plan.directory, 'plan.md'), prefix + body);
      await plan.ready();
      const current = await plan.status();
      await writeFile(join(plan.directory, 'plan.md'), prefix.replace('P2', 'P1') + body);
      const content = await readFile(join(plan.directory, 'milestones.md'), 'utf8');
      await writeFile(
        join(plan.directory, 'milestones.md'),
        content
          .replace('**Status:** pending', '**Status:** in progress')
          .replace('| 1 | Feature 1 | pending |', '| 1 | Feature 1 | in progress |'),
      );
      await writeFile(join(plan.directory, 'sessions.md'), 'codex_better-name\n');
      const changed = await plan.status();
      expect(changed.revision).toStrictEqual(current.revision);
      expect(changed.inspection.plan).not.toBe(current.inspection.plan);
      expect(changed.isSequenceApproved).toBe(true);
      await writeFile(
        join(plan.directory, 'milestones.md'),
        content.replace('**Dependencies:** None.', '**Dependencies:** Requires external approval.'),
      );
      const stale = await plan.status();
      expect(stale.isPlanApproved).toBe(true);
      expect(stale.isSequenceApproved).toBe(false);
      metadata.errorReservations.push({
        repository: 'workspace',
        namespace: 'api',
        start: 200,
        end: 204,
        registryPath: 'errors/index.ts',
        purpose: 'Feature failures',
      });
      expect((await plan.status()).isPlanApproved).toBe(false);
    },
    {
      parsePlanContract: ({ content }) => ({
        body: content.slice(content.indexOf('\n---\n') + 5),
        metadata,
      }),
    },
  );
});

test('revoked plan authority cannot be restored by replaying an earlier approval', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    await plan.finalize();
    const original = await plan.approve('plan');
    await plan.approve('sequence');
    const current = await plan.status();
    await plan.send({
      kind: 'revoke',
      target: plan.target,
      expected: current.revision,
      scope: 'plan',
      action: action(),
    });
    await plan.send(original);
    expect((await plan.status()).isPlanApproved).toBe(false);
    expect((await plan.status()).isSequenceApproved).toBe(false);
  });
});

test('1024 milestones use revision-bound seek pages, including exact boundaries and malformed continuation', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture, sequence(1024));
    await plan.finalize();
    const ids: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await plan.page(128, cursor);
      expect(page.data).toHaveLength(128);
      ids.push(...page.data.map((m) => m.id!));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    expect(pages).toBe(8);
    expect(new Set(ids).size).toBe(1024);
    const first = await plan.page(32);
    expect(first.data).toHaveLength(32);
    await expect(plan.page(64, first.nextCursor!)).rejects.toThrow('cursor');
    await expect(plan.page(32, 'invalid')).rejects.toThrow('cursor');
    const content = await readFile(join(plan.directory, 'milestones.md'), 'utf8');
    await writeFile(
      join(plan.directory, 'milestones.md'),
      content.replace('Actual checks.', 'Different checks.'),
    );
    await expect(plan.page(32, first.nextCursor!)).rejects.toThrow('cursor');
  });
});

test.each(['duplicate', 'malformed', 'misplaced'] as const)(
  'initial finalization rejects %s IDs without altering files',
  async (kind) => {
    await withClaudeRuntime(async (fixture) => {
      const id = randomUUID();
      let content = sequence(2, [id, kind === 'duplicate' ? id : randomUUID()]);
      if (kind === 'malformed') content = content.replace(id, 'not-a-uuid');
      if (kind === 'misplaced')
        content = content.replace(`**Milestone ID:** ${id}\n`, `\n**Milestone ID:** ${id}\n`);
      const plan = await setup(fixture, content);
      await expect(plan.finalize()).rejects.toThrow('plan is invalid');
      expect(await readFile(join(plan.directory, 'milestones.md'), 'utf8')).toBe(content);
    });
  },
);

test('a done marker is visible but cannot replace verified completion evidence', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(
      fixture,
      sequence().replace('**Status:** pending', '**Status:** done'),
    );
    await plan.ready();
    const current = await plan.status();
    expect(current.state).toBe('blocked');
    const page = await plan.page();
    await expect(
      plan.send({
        kind: 'authorize',
        target: plan.target,
        expected: current.revision,
        action: action(),
        mode: 'auto',
        milestoneIds: [page.data[1]!.id!],
      }),
    ).rejects.toThrow('conflicts');
  });
});

test('the shared lock serializes competing finalizers and replay keeps the original UUIDs', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const before = await plan.status();
    const command = {
      kind: 'finalize' as const,
      target: plan.target,
      action: action(),
      expected: before.revision,
    };
    const release = await acquireHqLock(fixture.stateRoot, 'held-for-finalization');
    let settled = false;
    const pending = plan.send(command).finally(() => {
      settled = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 32));
      expect(settled).toBe(false);
    } finally {
      await release();
    }
    const first = await pending;
    const retry = await plan.send(command);
    expect(retry).toStrictEqual(first);
    await expect(plan.send({ ...command, action: action() })).rejects.toThrow('conflicts');
  });
});

test('selected plan reads reject symlink escapes, oversized files and excluded directories', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    await symlink(fixture.root, join(fixture.workspaceRoot, 'escape'));
    await expect(
      plan.send({ kind: 'status', target: { directory: join(fixture.workspaceRoot, 'escape') } }),
    ).rejects.toThrow('outside');
    await writeFile(join(plan.directory, 'plan.md'), 'x'.repeat(1_048_577));
    await expect(plan.status()).rejects.toThrow('plan is invalid');
    await expect(
      plan.send({ kind: 'status', target: { directory: fixture.root } }),
    ).rejects.toThrow('outside');
  });
});

test.each(['complete-files', 'milestones-only', 'external-edit'] as const)(
  'prepared finalization recovers %s without reassigning identity after restart',
  async (phase) => {
    await withClaudeRuntime(async (fixture) => {
      const plan = await setup(fixture);
      const current = await plan.status();
      const command = {
        kind: 'finalize' as const,
        target: plan.target,
        action: action(),
        expected: current.revision,
      };
      const db = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'));
      try {
        db.exec(
          "CREATE TRIGGER prevent_completion BEFORE UPDATE ON plan_operation WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END;",
        );
        await expect(plan.send(command)).rejects.toThrow('store failed');
        const canonical = await readFile(join(plan.directory, 'milestones.md'), 'utf8');
        expect(canonical.match(/^\*\*Milestone ID:\*\* /gm)).toHaveLength(2);
        expect(await plan.status()).toMatchObject({
          state: 'blocked',
          pendingActionId: command.action.id,
        });
        await expect(
          plan.send({ ...command, action: action(), expected: (await plan.status()).revision }),
        ).rejects.toThrow('conflicts');
        db.exec('DROP TRIGGER prevent_completion');
        if (phase === 'milestones-only') await rm(join(plan.directory, 'coordination.json'));
        if (phase === 'external-edit')
          await writeFile(
            join(plan.directory, 'milestones.md'),
            canonical.replace('Actual checks.', 'Operator changed the checks.'),
          );
        await fixture.runtime.close();
        let restarted: IAgentHq | undefined;
        try {
          restarted = await createAgentHq({
            stateRoot: fixture.stateRoot,
            allowedRoots: [fixture.workspaceRoot],
          });
          if (phase === 'external-edit') {
            await expect(plan.send(command, restarted)).rejects.toThrow('conflicts');
            expect(await readFile(join(plan.directory, 'milestones.md'), 'utf8')).toContain(
              'Operator changed the checks.',
            );
          } else {
            const response = await plan.send(command, restarted);
            expect(response.kind).toBe('finalized');
            expect(await readFile(join(plan.directory, 'milestones.md'), 'utf8')).toBe(canonical);
            expect((await plan.status(restarted)).coordination.planApproval).toBeNull();
            const row = db
              .prepare('SELECT intent FROM plan_operation WHERE id = ?')
              .get(command.action.id)!;
            expect(JSON.parse(String(row.intent))).toMatchObject({
              state: 'completed',
              milestones: null,
              coordination: '',
            });
          }
        } finally {
          await restarted?.close();
        }
      } finally {
        db.close();
      }
    });
  },
);

test('empty milestone reads, projection reuse and renumbered continuation remain bounded and truthful', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    await rm(join(plan.directory, 'milestones.md'));
    expect(await plan.page()).toStrictEqual({ data: [], nextCursor: null });
    await writeFile(join(plan.directory, 'milestones.md'), sequence());
    const { command } = await plan.finalize();
    await plan.approve('plan');
    await plan.approve('sequence');
    const db = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'));
    try {
      db.exec(
        "CREATE TRIGGER prevent_projection_delete BEFORE DELETE ON plan_milestone BEGIN SELECT RAISE(ABORT, 'unnecessary projection rewrite'); END;",
      );
      const first = await plan.page(1);
      expect(first.nextCursor).not.toBeNull();
      db.exec('DROP TRIGGER prevent_projection_delete');
      const content = await readFile(join(plan.directory, 'milestones.md'), 'utf8');
      await writeFile(
        join(plan.directory, 'milestones.md'),
        content
          .replace('## Milestone 1:', '## Milestone 11:')
          .replace('## Milestone 2:', '## Milestone 12:'),
      );
      expect((await plan.status()).isSequenceApproved).toBe(true);
      await expect(plan.page(1, first.nextCursor!)).rejects.toThrow('cursor');
      await rm(join(plan.directory, 'milestones.md'));
      const retry = await plan.send(command);
      expect(retry.kind).toBe('status');
    } finally {
      db.close();
    }
  });
});

test('inspection hashes retain exact UTF-8 BOM bytes and bounded reads reject file links', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const content = '\ufeff# Plan\r\nBuild the workspace.\r\n';
    await writeFile(join(plan.directory, 'plan.md'), content);
    expect((await plan.status()).inspection.plan).toBe(hash(content));
    await rm(join(plan.directory, 'plan.md'));
    await symlink(join(plan.directory, 'milestones.md'), join(plan.directory, 'plan.md'));
    await expect(plan.status()).rejects.toThrow('plan operation failed');
  });
});

test('a failed projection refresh rolls back rows and its source guard, then retries from the authoritative file', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    await plan.finalize();
    const before = await plan.page();
    const content = await readFile(join(plan.directory, 'milestones.md'), 'utf8');
    await writeFile(
      join(plan.directory, 'milestones.md'),
      content.replace('**Status:** pending', '**Status:** in progress'),
    );
    const db = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'));
    try {
      db.exec(
        "CREATE TRIGGER prevent_projection_insert BEFORE INSERT ON plan_milestone BEGIN SELECT RAISE(ABORT, 'injected projection failure'); END;",
      );
      await expect(plan.page()).rejects.toThrow('store failed');
      expect(
        db
          .prepare('SELECT source_hash FROM plan_projection WHERE directory = ?')
          .get(plan.directory)?.source_hash,
      ).toBe(hash(content));
      expect(
        db
          .prepare('SELECT ordinal FROM plan_milestone WHERE directory = ? ORDER BY ordinal')
          .all(plan.directory),
      ).toHaveLength(before.data.length);
      db.exec('DROP TRIGGER prevent_projection_insert');
      expect((await plan.page()).data[0]!.status).toBe('in progress');
    } finally {
      db.close();
    }
  });
});

test('finalization leaves both real and fenced Overview text and identity examples unchanged', async () => {
  await withClaudeRuntime(async (fixture) => {
    const sample =
      '```md\n## Overview\n\n| Milestone | Name | Status |\n| --- | --- | --- |\n| 1 | Example | pending |\n\n## Milestone 99: Example only\n**Status:** pending\n**Milestone ID:** invalid-example\n```\n';
    const content = sequence()
      .replace('## Overview\n', sample + '\n## Overview\n')
      .replace(
        '## Milestone 1: Feature 1\n**Status:** pending',
        '## Milestone 1: Feature 1\n**Status:** in progress',
      );
    const plan = await setup(fixture, content);
    await plan.finalize();
    const result = await readFile(join(plan.directory, 'milestones.md'), 'utf8');
    expect(result).toContain(sample);
    expect(result).toContain('| 1 | Feature 1 | pending |');
    expect(
      result.replace(/^\*\*Milestone ID:\*\* [a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\n/gm, ''),
    ).toBe(content);
  });
});

test('the default profile excludes only administrative fields and retains the complete contract', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const source =
      '---\nid: workspace-plan\nrevision: 1\nstatus: pending\ncreated_at: 2026-10-22T10:00:00Z\nupdated_at: 2026-10-22T10:00:00Z\nscope: cross-repo\nrepositories: [workspace]\ncustom: { acceptance: true }\n---\n# Plan\nBuild the workspace.\n';
    await writeFile(join(plan.directory, 'plan.md'), source);
    const before = await plan.ready();
    const administrative = source
      .replace('revision: 1', 'revision: 2')
      .replace('status: pending', 'status: in progress')
      .replaceAll('10:00:00Z', '11:00:00Z');
    await writeFile(join(plan.directory, 'plan.md'), administrative);
    const current = await plan.status();
    expect(current.revision).toStrictEqual(before.revision);
    expect(current.isPlanApproved).toBe(true);
    expect(current.isSequenceApproved).toBe(true);
    expect(current.inspection.plan).not.toBe(before.inspection.plan);
    for (const changed of [
      source.replace('workspace-plan', 'new-plan'),
      source.replace('acceptance: true', 'acceptance: false'),
      source.replace('cross-repo', 'single-repo'),
    ]) {
      await writeFile(join(plan.directory, 'plan.md'), changed);
      expect((await plan.status()).revision.planDigest).not.toBe(before.revision.planDigest);
    }
  });
});

test.each([
  'scope: null',
  'repositories: false',
  'errorReservations: invalid',
  'custom: .nan',
  '- not-a-mapping',
  'custom: [unterminated',
])('the default profile refuses malformed contractual metadata: %s', async (metadata) => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    await writeFile(
      join(plan.directory, 'plan.md'),
      `---\n${metadata}\n---\n# Plan\nBuild the workspace.\n`,
    );
    await expect(plan.status()).rejects.toMatchObject({ code: 'JG_AGENT_HQ_PLAN_INVALID' });
  });
});

test('the host hook must use the exact engine-observed body boundary', async () => {
  await withClaudeRuntime(
    async (fixture) => {
      const plan = await setup(fixture);
      await expect(plan.status()).rejects.toMatchObject({ code: 'JG_AGENT_HQ_PLAN_INVALID' });
    },
    {
      parsePlanContract: () => ({
        body: 'Build the workspace.\n',
        metadata: { scope: 'local', repositories: [], errorReservations: [], extensions: {} },
      }),
    },
  );
});

test('finalization preserves BOM, CRLF, metadata and Overview bytes while assigning replayable identities', async () => {
  await withClaudeRuntime(async (fixture) => {
    const original =
      '\uFEFF---\r\ncontract: retained\r\n---\r\n' + sequence().replaceAll('\n', '\r\n');
    const plan = await setup(fixture, original);
    const finalized = await plan.finalize();
    const source = await readFile(join(plan.directory, 'milestones.md'), 'utf8');
    expect(source.replace(/^\*\*Milestone ID:\*\* [^\r\n]+\r\n/gm, '')).toBe(original);
    expect(await plan.send(finalized.command)).toStrictEqual(finalized.response);
    expect(await readFile(join(plan.directory, 'milestones.md'), 'utf8')).toBe(source);
  });
});

test('stale skills bindings remain observable and close execution authority', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const source =
      '---\nid: selected-plan\nrevision: 1\nstatus: pending\n---\n# Plan\nBuild the workspace.\n';
    const fingerprint = fingerprintPlan(source, {
      excludeMetadataKeys: ['created_at', 'updated_at', 'revision', 'status'],
    }).sha256;
    const binding = `---\njg_skills:\n  plan_id: selected-plan\n  plan_revision: 1\n  plan_content_sha256: ${fingerprint}\n---\n`;
    await writeFile(join(plan.directory, 'plan.md'), source);
    await writeFile(join(plan.directory, 'milestones.md'), binding + sequence());
    const before = await plan.ready();
    expect(before.skillsBinding).toBe('current');
    const entries = (await plan.page()).data;
    const authorization = action();
    await plan.send({
      kind: 'authorize',
      target: plan.target,
      action: authorization,
      expected: before.revision,
      mode: 'supervised',
      milestoneIds: [entries[0]!.id!],
    });
    const milestones = await readFile(join(plan.directory, 'milestones.md'), 'utf8');
    for (const changed of [
      source.replace('selected-plan', 'other-plan'),
      source.replace('revision: 1', 'revision: 2'),
      source.replace('Build the workspace.', 'Build a different workspace.'),
    ]) {
      await writeFile(join(plan.directory, 'plan.md'), changed);
      const stale = await plan.status();
      expect(stale).toMatchObject({
        skillsBinding: 'stale',
        isFinalized: false,
        isSequenceApproved: false,
      });
      await expect(plan.finalize()).rejects.toMatchObject({ code: 'JG_AGENT_HQ_ACTION_CONFLICT' });
      await expect(
        plan.send({
          kind: 'check-execution',
          target: plan.target,
          expected: stale.revision,
          authorizationId: authorization.id,
          mode: 'supervised',
          milestoneId: entries[0]!.id!,
        }),
      ).rejects.toMatchObject({ code: 'JG_AGENT_HQ_ACTION_CONFLICT' });
    }
    await writeFile(join(plan.directory, 'plan.md'), source.replace('revision: 1', 'revision: 2'));
    await writeFile(
      join(plan.directory, 'milestones.md'),
      milestones.replace('plan_revision: 1', 'plan_revision: 2'),
    );
    const current = await plan.status();
    expect(current.revision).toStrictEqual(before.revision);
    expect(current.isPlanApproved).toBe(true);
    expect(current.skillsBinding).toBe('current');
  });
});
