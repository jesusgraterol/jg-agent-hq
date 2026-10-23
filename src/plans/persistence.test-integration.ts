// @vitest-environment node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createAgentHq } from 'jg-agent-hq';
import { Exception } from 'jg-exception';
import { hashValue } from 'jg-crypto';
import { PlanCommandSchema } from 'jg-agent-hq/contracts';
import { withPlanDocumentLocks, parsePlan, inspectPlan } from 'jg-plans';
import type { IPlanCommandInput, IPlanStatus, IPlanOperatorAction } from 'jg-agent-hq/contracts';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';

import {
  withClaudeRuntime,
  type IClaudeFixture,
} from '../../scripts/test-support/claude-runtime.js';

const faults = vi.hoisted(() => ({
  afterWrite: '',
  release: false,
  moved: [] as string[],
  inside: undefined as undefined | ((directory: string) => Promise<void>),
}));
vi.mock('jg-fs', async (original) => {
  const actual = await original<typeof import('jg-fs')>();
  return {
    ...actual,
    writeFileAtomicIfUnchanged: async (
      ...args: Parameters<typeof actual.writeFileAtomicIfUnchanged>
    ) => {
      await actual.writeFileAtomicIfUnchanged(...args);
      if (faults.afterWrite && args[0].endsWith(`/${faults.afterWrite}`)) {
        faults.afterWrite = '';
        throw new Exception('Injected failure after durable replacement', { code: 'EIO' });
      }
    },
  };
});
vi.mock('jg-plans', async (original) => {
  const actual = await original<typeof import('jg-plans')>();
  return {
    ...actual,
    withPlanDocumentLocks: async (...args: Parameters<typeof actual.withPlanDocumentLocks>) =>
      actual.withPlanDocumentLocks(args[0], args[1], async (directory) => {
        const result = await args[2](directory);
        const inside = faults.inside;
        faults.inside = undefined;
        await inside?.(directory);
        if (faults.release) {
          faults.release = false;
          const moved = join(directory, `.owned-release-fault-${randomUUID()}`);
          await rename(join(directory, '.milestones.md.jg-plans.lock'), moved);
          faults.moved.push(moved);
        }
        return result;
      }),
  };
});
beforeEach(() => {
  faults.afterWrite = '';
  faults.release = false;
  faults.inside = undefined;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of faults.moved.splice(0)) await rm(path, { recursive: true, force: true });
});
const setup = async (
  fixture: IClaudeFixture,
  planSource = '# Plan\nImplement a checked workspace.\n',
) => {
  const directory = join(fixture.workspaceRoot, 'persistence-plan');
  await mkdir(directory);
  await writeFile(join(directory, 'plan.md'), planSource);
  await writeFile(
    join(directory, 'milestones.md'),
    '# Milestones\n\n## Milestone 1: Workspace\n**Status:** pending\n\nVerify every checked write.\n',
  );
  const target = { directory };
  const send = async (command: IPlanCommandInput) => {
    const response = await fixture.runtime.request({ kind: 'plan', command });
    if (response.kind !== 'plan') throw new Error('Missing plan result');
    return response.result;
  };
  const status = async (): Promise<IPlanStatus> => {
    const response = await send({ kind: 'status', target });
    if (response.kind !== 'status') throw new Error('Missing plan status');
    return response.result;
  };
  const action = () => ({
    id: randomUUID(),
    operatorId: 'fixture-owner',
    source: { kind: 'user-action' as const, reference: 'fixture:explicit-finalize' },
  });
  const current = await status();
  await send({
    kind: 'approve',
    target,
    action: action(),
    expected: current.revision,
    scope: 'plan',
    presentationHash: current.inspection.plan!,
  });
  const command = {
    kind: 'finalize' as const,
    target,
    action: action(),
    expected: (await status()).revision,
  };
  return { directory, send, status, command };
};

test('shared document ownership blocks HQ before journal preparation, without waiting or takeover', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    await withPlanDocumentLocks(plan.directory, ['plan', 'milestones'], async () => {
      await expect(plan.send(plan.command)).rejects.toMatchObject({
        code: 'JG_AGENT_HQ_ACTION_CONFLICT',
        data: { reason: 'document-locked' },
      });
    });
    expect((await plan.status()).pendingActionId).toBeNull();
    expect((await plan.send(plan.command)).kind).toBe('finalized');
  });
});

test.each(['milestones.md', 'coordination.json'])(
  'a failure after %s replacement retains exact intent bytes for replay',
  async (name) => {
    await withClaudeRuntime(async (fixture) => {
      const plan = await setup(fixture);
      faults.afterWrite = name;
      await expect(plan.send(plan.command)).rejects.toMatchObject({
        code: 'JG_AGENT_HQ_PLAN_FAILED',
      });
      const canonical = await readFile(join(plan.directory, 'milestones.md'), 'utf8');
      expect(canonical).toMatch(/\*\*Milestone ID:\*\* [a-f0-9-]{36}/);
      expect(await plan.status()).toMatchObject({
        state: 'blocked',
        pendingActionId: plan.command.action.id,
      });
      const maintenance = vi.fn(async () => undefined);
      await expect(fixture.runtime.withStorageMaintenance(maintenance)).rejects.toMatchObject({
        code: 'JG_AGENT_HQ_ACTION_CONFLICT',
      });
      expect(maintenance).not.toHaveBeenCalled();
      await plan.send(plan.command);
      expect(await readFile(join(plan.directory, 'milestones.md'), 'utf8')).toBe(canonical);
      expect((await plan.status()).pendingActionId).toBeNull();
    });
  },
);

test('a real lock-release failure after application leaves the journal prepared', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    faults.release = true;
    await expect(plan.send(plan.command)).rejects.toMatchObject({
      code: 'JG_AGENT_HQ_PLAN_FAILED',
      data: { outcome: 'uncertain' },
    });
    const canonical = await readFile(join(plan.directory, 'milestones.md'), 'utf8');
    const db = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'));
    try {
      expect(
        db.prepare('SELECT state FROM hq_plan_operation WHERE id = ?').get(plan.command.action.id)
          ?.state,
      ).toBe('prepared');
    } finally {
      db.close();
    }
    for (const path of faults.moved.splice(0)) await rm(path, { recursive: true });
    expect((await plan.status()).pendingActionId).toBe(plan.command.action.id);
    await plan.send(plan.command);
    expect(await readFile(join(plan.directory, 'milestones.md'), 'utf8')).toBe(canonical);
    expect((await plan.status()).pendingActionId).toBeNull();
  });
});

test('ledger completion follows physical lock release and recognizes a committed result after a lost acknowledgement', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    let requestId: number | null = null;
    let injected = false;
    const post = Worker.prototype.postMessage;
    const emit = Worker.prototype.emit;
    vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      ...args: Parameters<typeof post>
    ) {
      const request = z
        .object({ id: z.number(), command: z.object({ kind: z.string() }) })
        .safeParse(args[0]);
      if (request.success && request.data.command.kind === 'plan-complete') {
        for (const document of ['plan', 'milestones'])
          expect(existsSync(join(plan.directory, `.${document}.md.jg-plans.lock`))).toBe(false);
        requestId = request.data.id;
      }
      return post.apply(this, args);
    });
    vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (
      this: Worker,
      event: string | symbol,
      ...args: unknown[]
    ) {
      const response = z
        .object({ kind: z.literal('result'), id: z.number(), error: z.null() })
        .safeParse(args[0]);
      if (!injected && event === 'message' && response.success && response.data.id === requestId) {
        injected = true;
        return emit.call(this, event, {
          kind: 'result',
          id: requestId,
          result: null,
          error: {
            code: 'JG_AGENT_HQ_STORE_FAILED',
            message: 'The HQ store failed: injected lost acknowledgement',
            kind: 'operation-failed',
          },
        });
      }
      return emit.call(this, event, ...args);
    });
    expect((await plan.send(plan.command)).kind).toBe('finalized');
    expect(injected).toBe(true);
    expect((await plan.status()).pendingActionId).toBeNull();
  });
});

test('inspection leaves broad modes alone; replacements and exclusive coordination creation are private', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const miles = join(plan.directory, 'milestones.md');
    const coordination = join(plan.directory, 'coordination.json');
    expect((await lstat(coordination)).mode & 0o777).toBe(0o600);
    await chmod(join(plan.directory, 'plan.md'), 0o644);
    await chmod(miles, 0o666);
    await chmod(coordination, 0o644);
    await plan.status();
    expect((await lstat(miles)).mode & 0o777).toBe(0o666);
    await plan.send(plan.command);
    expect((await lstat(miles)).mode & 0o777).toBe(0o600);
    expect((await lstat(coordination)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(plan.directory, 'plan.md'))).mode & 0o777).toBe(0o644);
  });
});

const operator = (): IPlanOperatorAction => ({
  id: randomUUID(),
  operatorId: 'fixture-owner',
  source: { kind: 'user-action', reference: 'fixture:current-approval' },
});
const prepareNative = async (fixture: IClaudeFixture, plan: Awaited<ReturnType<typeof setup>>) => {
  await plan.send(plan.command);
  let current = await plan.status();
  await plan.send({
    kind: 'approve',
    target: { directory: plan.directory },
    action: operator(),
    scope: 'sequence',
    expected: current.revision,
    presentationHash: current.inspection.milestones!,
  });
  const page = await plan.send({ kind: 'milestones', target: { directory: plan.directory } });
  if (page.kind !== 'milestones') throw new Error('Missing milestones');
  const milestoneId = page.result.data[0]!.id!;
  current = await plan.status();
  const authorization = operator();
  await plan.send({
    kind: 'authorize',
    target: { directory: plan.directory },
    action: authorization,
    expected: current.revision,
    mode: 'supervised',
    milestoneIds: [milestoneId],
  });
  const runtime = await fixture.runtime.request({ kind: 'status' });
  if (runtime.kind !== 'status') throw new Error('Missing runtime');
  const runtimeEpoch = runtime.result.runtimeEpoch;
  const created = await fixture.runtime.request({
    kind: 'action',
    action: {
      id: randomUUID(),
      runtimeEpoch,
      command: {
        kind: 'thread-create',
        provider: 'codex',
        name: 'checked-progress',
        workspaceRoot: fixture.workspaceRoot,
      },
    },
  });
  if (created.kind !== 'action' || !created.result.threadId) throw new Error('Missing thread');
  const threadId = created.result.threadId;
  await expect
    .poll(
      async () => {
        const thread = await fixture.runtime.request({ kind: 'managed-thread', threadId });
        return thread.kind === 'managed-thread' ? thread.result?.state : null;
      },
      { timeout: 5000 },
    )
    .toBe('idle');
  return {
    milestoneId,
    action: {
      id: randomUUID(),
      runtimeEpoch,
      command: {
        kind: 'message' as const,
        threadId,
        input: { kind: 'text' as const, text: 'Verify the checked workspace progress.' },
      },
      plan: {
        kind: 'execution' as const,
        authorizationId: authorization.id,
        milestoneId,
        mode: 'supervised' as const,
        revision: current.revision,
      },
    },
  };
};

test.each(['none', 'plan.md', 'milestones.md', 'coordination.json'])(
  'implementation progress is durable before native admission and replays stable timestamps after %s failure',
  async (phase) => {
    await withClaudeRuntime(async (fixture) => {
      const source =
        '---\nid: checked-progress\nrevision: 7\nstatus: pending\nupdated_at: 2026-10-22T10:00:00Z\n---\n# Plan\nVerify the checked workspace progress.\n';
      const plan = await setup(fixture, source);
      const native = await prepareNative(fixture, plan);
      let preparedPlan: string | undefined;
      if (phase !== 'none') {
        faults.afterWrite = phase;
        await expect(
          fixture.runtime.request({ kind: 'action', action: native.action }),
        ).rejects.toMatchObject({ code: 'JG_AGENT_HQ_PLAN_FAILED' });
        preparedPlan = await readFile(join(plan.directory, 'plan.md'), 'utf8');
        const receipt = await fixture.runtime.request({
          kind: 'receipt',
          actionId: native.action.id,
        });
        expect(receipt).toMatchObject({ kind: 'receipt', result: null });
        expect((await plan.status()).pendingActionId).toBe(native.action.id);
      }
      const result = await fixture.runtime.request({ kind: 'action', action: native.action });
      expect(result.kind).toBe('action');
      const actual = await readFile(join(plan.directory, 'plan.md'), 'utf8');
      expect(parsePlan(actual).rawMetadata).toMatchObject({
        id: 'checked-progress',
        revision: 7,
        status: 'in progress',
      });
      if (preparedPlan) expect(actual).toBe(preparedPlan);
      expect(await readFile(join(plan.directory, 'milestones.md'), 'utf8')).toContain(
        '**Status:** in progress',
      );
      expect((await plan.status()).pendingActionId).toBeNull();
      const check = join(fixture.workspaceRoot, 'verify-progress.mjs');
      await writeFile(
        check,
        `import assert from 'node:assert/strict';import {readFile,stat} from 'node:fs/promises';import {join} from 'node:path';const root=process.argv[2];const plan=await readFile(join(root,'plan.md'),'utf8');assert.match(plan,/revision: 7/);assert.match(plan,/status: ["']?in progress/);for(const file of ['plan.md','milestones.md','coordination.json'])assert.equal((await stat(join(root,file))).mode & 0o777,0o600);console.log('checked progress verified');`,
      );
      const proof = await promisify(execFile)(process.execPath, [check, plan.directory], {
        timeout: 5000,
        maxBuffer: 65_536,
      });
      expect(proof.stdout).toBe('checked progress verified\n');
      await plan.send({
        kind: 'complete',
        target: { directory: plan.directory },
        action: operator(),
        expected: (await plan.status()).revision,
        milestoneId: native.milestoneId,
        checks: [
          {
            command: `node ${check} ${plan.directory}`,
            outcome: 'passed',
            reference: 'fixture:checked-progress-proof',
          },
        ],
        checkouts: [],
      });
      expect(
        parsePlan(await readFile(join(plan.directory, 'plan.md'), 'utf8')).rawMetadata,
      ).toMatchObject({ revision: 7, status: 'done' });
      expect((await plan.status()).state).toBe('completed');
    });
  },
);

test('prepared aggregate progress cannot exceed the UTF-8 document limit or leave a partial receipt', async () => {
  await withClaudeRuntime(async (fixture) => {
    const source = '# Plan\n' + 'x'.repeat(1_048_576 - 7);
    const plan = await setup(fixture, source);
    await plan.send(plan.command);
    const current = await plan.status();
    const page = await plan.send({ kind: 'milestones', target: { directory: plan.directory } });
    if (page.kind !== 'milestones') throw new Error('Missing milestones');
    const before = await readFile(join(plan.directory, 'coordination.json'), 'utf8');
    await expect(
      plan.send({
        kind: 'complete',
        target: { directory: plan.directory },
        expected: current.revision,
        action: operator(),
        milestoneId: page.result.data[0]!.id!,
        checks: [
          {
            command: 'fixture:bounded-source-assertion',
            outcome: 'passed',
            reference: 'fixture:source-limit',
          },
        ],
        checkouts: [],
      }),
    ).rejects.toMatchObject({ code: 'JG_AGENT_HQ_PLAN_INVALID' });
    expect(await readFile(join(plan.directory, 'plan.md'), 'utf8')).toBe(source);
    expect(await readFile(join(plan.directory, 'coordination.json'), 'utf8')).toBe(before);
    expect((await plan.status()).pendingActionId).toBeNull();
  });
});

test('document acquisition failure truthfully reports that no mutation was applied', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const mode = (await lstat(plan.directory)).mode & 0o777;
    const before = await readFile(join(plan.directory, 'milestones.md'), 'utf8');
    await chmod(plan.directory, 0o500);
    try {
      await expect(plan.send(plan.command)).rejects.toMatchObject({
        code: 'JG_AGENT_HQ_PLAN_FAILED',
        data: { outcome: 'not-applied', phase: 'acquire', operationCompleted: false },
      });
    } finally {
      await chmod(plan.directory, mode);
    }
    expect(await readFile(join(plan.directory, 'milestones.md'), 'utf8')).toBe(before);
    expect((await plan.status()).pendingActionId).toBeNull();
  });
});

test('the real jg-plans CLI cannot write while HQ applies its prepared intent', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    let checked = false;
    faults.inside = async (directory) => {
      const current = await inspectPlan(directory);
      if (current.plan.state !== 'readable') throw new Error('Missing selected plan');
      const input = join(fixture.root, 'cli-update.json');
      await writeFile(
        input,
        JSON.stringify({
          document: 'plan',
          expectedSha256: current.plan.sha256,
          set: { status: 'cli-owned' },
        }),
      );
      await expect(
        promisify(execFile)(
          join(import.meta.dirname, '../../node_modules/.bin/jg-plans'),
          ['update', '--directory', directory, '--input', input, '--json'],
          { timeout: 5000, maxBuffer: 65_536 },
        ),
      ).rejects.toMatchObject({ code: 2, stdout: expect.stringContaining('JG_PLANS_LOCK_BUSY') });
      checked = true;
    };
    expect((await plan.send(plan.command)).kind).toBe('finalized');
    expect(checked).toBe(true);
    expect(await readFile(join(plan.directory, 'plan.md'), 'utf8')).not.toContain('cli-owned');
    expect((await plan.status()).pendingActionId).toBeNull();
  });
});

test(
  'a host crash after document release retains replayable output until explicit owned recovery',
  { timeout: 20_000 },
  async () => {
    await withClaudeRuntime(async (fixture) => {
      const plan = await setup(fixture);
      await fixture.runtime.close();
      const input = join(fixture.root, 'crash-input.json');
      const script = join(fixture.root, 'crash-before-completion.mjs');
      await writeFile(
        input,
        JSON.stringify({
          stateRoot: fixture.stateRoot,
          allowedRoots: [fixture.workspaceRoot],
          command: plan.command,
        }),
      );
      await writeFile(
        script,
        `import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {createAgentHq} from ${JSON.stringify(import.meta.resolve('jg-agent-hq'))};
const input=JSON.parse(readFileSync(process.argv[2],'utf8'));
const post=Worker.prototype.postMessage;
Worker.prototype.postMessage=function(message,...args){
  if(message.command?.kind==='plan-complete'){
    for(const doc of ['plan','milestones'])if(existsSync(join(input.command.target.directory,'.'+doc+'.md.jg-plans.lock')))process.exit(74);
    process.exit(73);
  }
  return post.call(this,message,...args);
};
const runtime=await createAgentHq({stateRoot:input.stateRoot,allowedRoots:input.allowedRoots});
await runtime.request({kind:'threads',provider:'codex',workspaceRoot:input.allowedRoots[0]});
await runtime.request({kind:'plan',command:input.command});
await runtime.close();
process.exit(75);
`,
      );
      let ownerPid = 0;
      await expect(
        promisify(execFile)(process.execPath, [script, input], {
          timeout: 10_000,
          maxBuffer: 65_536,
        }),
      ).rejects.toMatchObject({ code: 73 });
      const canonical = await readFile(join(plan.directory, 'milestones.md'), 'utf8');
      const coordination = await readFile(join(plan.directory, 'coordination.json'), 'utf8');
      const owner = z
        .object({ pid: z.number().int().positive() })
        .parse(JSON.parse(await readFile(join(fixture.stateRoot, 'hq-owner.json'), 'utf8')));
      ownerPid = owner.pid;
      expect(() => process.kill(ownerPid, 0)).toThrow();
      const pids = z
        .record(z.string(), z.number().int().positive())
        .parse(JSON.parse(await readFile(join(fixture.root, 'pids.json'), 'utf8')));
      await expect
        .poll(
          () =>
            Object.values(pids).every((pid) => {
              try {
                process.kill(pid, 0);
                return false;
              } catch {
                return true;
              }
            }),
          { timeout: 5000 },
        )
        .toBe(true);
      await expect(
        createAgentHq({ stateRoot: fixture.stateRoot, allowedRoots: [fixture.workspaceRoot] }),
      ).rejects.toThrow('already owned');
      // This is explicit recovery of the disposable child's proven-dead ownership, not product takeover.
      const lock = join(fixture.stateRoot, '.runtime/hq.lock');
      expect(
        z.object({ pid: z.number() }).parse(JSON.parse(await readFile(lock, 'utf8'))).pid,
      ).toBe(ownerPid);
      await rm(lock);
      expect((await lstat(join(fixture.stateRoot, 'hq.sock'))).isSocket()).toBe(true);
      await rm(join(fixture.stateRoot, 'hq.sock'));
      await rm(join(fixture.stateRoot, 'hq-owner.json'));
      const recovered = await createAgentHq({
        stateRoot: fixture.stateRoot,
        allowedRoots: [fixture.workspaceRoot],
      });
      try {
        const blocked = await recovered.request({
          kind: 'plan',
          command: { kind: 'status', target: { directory: plan.directory } },
        });
        expect(blocked).toMatchObject({
          kind: 'plan',
          result: {
            kind: 'status',
            result: { pendingActionId: plan.command.action.id, state: 'blocked' },
          },
        });
        const replay = await recovered.request({ kind: 'plan', command: plan.command });
        expect(replay).toMatchObject({ kind: 'plan', result: { kind: 'finalized' } });
        expect(await readFile(join(plan.directory, 'milestones.md'), 'utf8')).toBe(canonical);
        expect(await readFile(join(plan.directory, 'coordination.json'), 'utf8')).toBe(
          coordination,
        );
      } finally {
        await recovered.close();
      }
    });
  },
);

test.each(['present', 'already-removed', 'conflicting', 'coordination-failure'] as const)(
  'an explicit remove intent replays only its selected baseline: %s',
  async (scenario) => {
    await withClaudeRuntime(async (fixture) => {
      const plan = await setup(fixture);
      const current = await plan.status();
      const coordination = await readFile(join(plan.directory, 'coordination.json'), 'utf8');
      const baseline = await readFile(join(plan.directory, 'milestones.md'), 'utf8');
      const command = PlanCommandSchema.parse(plan.command);
      if (command.kind !== 'finalize') throw new Error('Expected finalize replay identity');
      const intent = {
        id: command.action.id,
        digest: hashValue(JSON.stringify({ ...command, target: { directory: plan.directory } })),
        directory: plan.directory,
        before: current.inspection,
        plan: null,
        milestones: { operation: 'remove' },
        coordination,
        state: 'prepared',
      };
      // A prepared crash image tests the closed recovery contract without adding a public removal action.
      const db = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'));
      try {
        db.prepare(
          'INSERT INTO hq_plan_operation (id, directory, state, intent) VALUES (?, ?, ?, ?)',
        ).run(intent.id, plan.directory, 'prepared', JSON.stringify(intent));
      } finally {
        db.close();
      }
      if (scenario === 'already-removed') await rm(join(plan.directory, 'milestones.md'));
      if (scenario === 'conflicting') {
        const changed = baseline + '\nKeep these new requirements.\n';
        await writeFile(join(plan.directory, 'milestones.md'), changed);
        await expect(plan.send(plan.command)).rejects.toMatchObject({
          code: 'JG_AGENT_HQ_ACTION_CONFLICT',
        });
        expect(await readFile(join(plan.directory, 'milestones.md'), 'utf8')).toBe(changed);
        expect((await plan.status()).pendingActionId).toBe(intent.id);
        return;
      }
      if (scenario === 'coordination-failure') {
        faults.afterWrite = 'coordination.json';
        await expect(plan.send(plan.command)).rejects.toMatchObject({
          code: 'JG_AGENT_HQ_PLAN_FAILED',
        });
        expect(existsSync(join(plan.directory, 'milestones.md'))).toBe(false);
        expect((await plan.status()).pendingActionId).toBe(intent.id);
      }
      await plan.send(plan.command);
      expect(existsSync(join(plan.directory, 'milestones.md'))).toBe(false);
      expect(await readFile(join(plan.directory, 'coordination.json'), 'utf8')).toBe(coordination);
      expect(await plan.status()).toMatchObject({
        pendingActionId: null,
        isFinalized: false,
        skillsBinding: 'absent',
      });
      const ledger = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'));
      try {
        const row = ledger
          .prepare('SELECT state, intent FROM hq_plan_operation WHERE id = ?')
          .get(intent.id)!;
        expect(row.state).toBe('completed');
        expect(JSON.parse(String(row.intent))).toMatchObject({
          plan: null,
          milestones: { operation: 'keep' },
          coordination: '',
        });
      } finally {
        ledger.close();
      }
      await plan.send(plan.command);
      expect(existsSync(join(plan.directory, 'milestones.md'))).toBe(false);
    });
  },
);

test('exclusive coordination creation sets private permissions under a restrictive write-time umask', async () => {
  await withClaudeRuntime(async (fixture) => {
    const directory = join(fixture.workspaceRoot, 'private-create');
    await mkdir(directory);
    await writeFile(join(directory, 'plan.md'), '# Plan\nKeep private operator records.\n');
    const target = { directory };
    const before = await fixture.request({ kind: 'plan', command: { kind: 'status', target } });
    if (before.kind !== 'plan' || before.result.kind !== 'status')
      throw new Error('Missing status');
    const previousMode = process.umask();
    const post = Worker.prototype.postMessage;
    let applied = false;
    vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      ...args: Parameters<typeof post>
    ) {
      const message = z.object({ command: z.object({ kind: z.string() }) }).safeParse(args[0]);
      if (message.success && message.data.command.kind === 'plan-prepare') process.umask(0o777);
      if (message.success && message.data.command.kind === 'plan-complete') {
        expect(lstatSync(join(directory, 'coordination.json')).mode & 0o777).toBe(0o600);
        applied = true;
        process.umask(previousMode);
      }
      return post.apply(this, args);
    });
    try {
      await fixture.request({
        kind: 'plan',
        command: {
          kind: 'approve',
          target,
          action: operator(),
          expected: before.result.result.revision,
          scope: 'plan',
          presentationHash: before.result.result.inspection.plan,
        },
      });
      expect(applied).toBe(true);
      expect((await lstat(join(directory, 'coordination.json'))).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousMode);
    }
  });
});

test.each(['prepared', 'unknown'] as const)(
  'an uncommitted completion with %s durable observation retains payload and closes admission',
  async (observation) => {
    await withClaudeRuntime(async (fixture) => {
      const plan = await setup(fixture);
      const post = Worker.prototype.postMessage;
      let blocked = false;
      let observed = false;
      vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
        this: Worker,
        ...args: Parameters<typeof post>
      ) {
        const parsed = z
          .object({ id: z.number(), command: z.object({ kind: z.string() }) })
          .safeParse(args[0]);
        const completion =
          parsed.success && parsed.data.command.kind === 'plan-complete' && !blocked;
        const unavailable =
          parsed.success &&
          parsed.data.command.kind === 'plan-operation' &&
          blocked &&
          !observed &&
          observation === 'unknown';
        if (completion || unavailable) {
          if (completion) {
            blocked = true;
            for (const document of ['plan', 'milestones'])
              expect(existsSync(join(plan.directory, `.${document}.md.jg-plans.lock`))).toBe(false);
          } else observed = true;
          const id = parsed.data.id;
          queueMicrotask(() =>
            this.emit('message', {
              kind: 'result',
              id,
              result: null,
              error: {
                code: 'JG_AGENT_HQ_STORE_FAILED',
                message: 'The HQ store failed: injected uncommitted completion',
                kind: 'operation-failed',
              },
            }),
          );
          return;
        }
        return post.apply(this, args);
      });
      await expect(plan.send(plan.command)).rejects.toMatchObject({
        code: 'JG_AGENT_HQ_STORE_FAILED',
      });
      const source = await readFile(join(plan.directory, 'milestones.md'), 'utf8');
      const coordination = await readFile(join(plan.directory, 'coordination.json'), 'utf8');
      expect(blocked).toBe(true);
      expect(observed).toBe(observation === 'unknown');
      const db = new DatabaseSync(join(fixture.stateRoot, 'hq.sqlite'));
      try {
        const row = db
          .prepare('SELECT state, intent FROM hq_plan_operation WHERE id = ?')
          .get(plan.command.action.id)!;
        expect(row.state).toBe('prepared');
        expect(JSON.parse(String(row.intent))).toMatchObject({
          milestones: { operation: 'write', source },
          coordination,
          state: 'prepared',
        });
      } finally {
        db.close();
      }
      expect(await plan.status()).toMatchObject({
        state: 'blocked',
        pendingActionId: plan.command.action.id,
      });
      const current = await plan.status();
      await expect(
        plan.send({
          kind: 'authorize',
          target: { directory: plan.directory },
          action: operator(),
          expected: current.revision,
          mode: 'supervised',
          milestoneIds: [],
        }),
      ).rejects.toMatchObject({ code: 'JG_AGENT_HQ_ACTION_CONFLICT' });
      await plan.send(plan.command);
      expect((await plan.status()).pendingActionId).toBeNull();
      expect(await readFile(join(plan.directory, 'milestones.md'), 'utf8')).toBe(source);
      expect(await readFile(join(plan.directory, 'coordination.json'), 'utf8')).toBe(coordination);
    });
  },
);

test('coordination-only observation holds shared document locks and releases them before ledger completion', async () => {
  await withClaudeRuntime(async (fixture) => {
    const plan = await setup(fixture);
    const native = await prepareNative(fixture, plan);
    await fixture.runtime.request({ kind: 'action', action: native.action });
    const post = Worker.prototype.postMessage;
    let observationId: string | null = null;
    let lockedDuringPrepare: boolean | null = null;
    let releasedBeforeCompletion: boolean | null = null;
    const locks = () =>
      ['plan', 'milestones'].map((document) =>
        existsSync(join(plan.directory, `.${document}.md.jg-plans.lock`)),
      );
    vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      ...args: Parameters<typeof post>
    ) {
      const prepared = z
        .object({
          command: z.object({
            kind: z.literal('plan-prepare'),
            intent: z.object({ id: z.string(), before: z.object({ plan: z.null() }) }),
          }),
        })
        .safeParse(args[0]);
      if (prepared.success) {
        observationId = prepared.data.command.intent.id;
        lockedDuringPrepare = locks().every(Boolean);
      }
      const completed = z
        .object({ command: z.object({ kind: z.literal('plan-complete'), id: z.string() }) })
        .safeParse(args[0]);
      if (completed.success && completed.data.command.id === observationId)
        releasedBeforeCompletion = locks().every((exists) => !exists);
      return post.apply(this, args);
    });
    await writeFile(
      join(plan.directory, 'plan.md'),
      '# Plan\nImplement a checked workspace and document the new requirement.\n',
    );
    await plan.status();
    await expect.poll(() => releasedBeforeCompletion, { timeout: 5000 }).not.toBeNull();
    expect(lockedDuringPrepare).toBe(true);
    expect(releasedBeforeCompletion).toBe(true);
    expect((await plan.status()).pendingActionId).toBeNull();
  });
});
