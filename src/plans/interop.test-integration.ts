// @vitest-environment node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { IPlanCommandInput, IPlanOperatorAction, IPlanStatus } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';
import { z } from 'zod';

import { withClaudeRuntime, type IClaudeFixture } from '../../scripts/test-support/index.js';

const run = promisify(execFile);
const action = (): IPlanOperatorAction => ({
  id: randomUUID(),
  operatorId: 'interop-owner',
  source: { kind: 'user-action', reference: `interop:${randomUUID()}` },
});
const inspection = z.object({
  plan: z.object({
    state: z.literal('readable'),
    sha256: z.string(),
    source: z.string(),
    metadata: z.object({ id: z.string(), revision: z.number() }),
  }),
  milestones: z.object({
    state: z.string(),
    sha256: z.string().optional(),
    source: z.string().optional(),
    body: z.string().optional(),
    milestones: z.array(z.object({ id: z.string().nullable(), status: z.string() })).optional(),
  }),
  fingerprint: z.object({ sha256: z.string() }),
});

// Every document mutation crosses the real published bin; HQ retains its real IPC/SQLite/file path.
test(
  'CLI and HQ retain identities, verification and closed revision gates across a complete round trip',
  { timeout: 20_000 },
  async () => {
    await withClaudeRuntime(async (fixture) => {
      const cli = async (command: string, args: string[], input?: object) => {
        const filename = join(fixture.root, `cli-input-${randomUUID()}.json`);
        if (input) await writeFile(filename, JSON.stringify(input));
        const result = await run(
          join(import.meta.dirname, '../../node_modules/.bin/jg-plans'),
          [command, ...args, ...(input ? ['--input', filename] : []), '--json'],
          { cwd: fixture.workspaceRoot, timeout: 5000, maxBuffer: 1_048_576 },
        );
        expect(result.stderr).toBe('');
        return z
          .object({
            schemaVersion: z.literal(1),
            error: z.null(),
            data: z.record(z.string(), z.unknown()),
          })
          .parse(JSON.parse(result.stdout)).data;
      };
      const created = await cli(
        'create',
        ['--root', fixture.workspaceRoot, '--slug', 'interop-plan'],
        { body: '# Plan\nReturn the requested greeting.\n' },
      );
      const directory = z.string().parse(created.directory);
      const target = { directory };
      const inspect = async () =>
        inspection.parse(
          await cli('inspect', [
            '--directory',
            directory,
            '--include-body',
            '--fingerprint-exclude',
            '["created_at","updated_at","revision","status"]',
          ]),
        );
      const bind = (observed: Awaited<ReturnType<typeof inspect>>) =>
        `---\njg_skills:\n  plan_id: ${observed.plan.metadata.id}\n  plan_revision: ${observed.plan.metadata.revision}\n  plan_content_sha256: ${observed.fingerprint.sha256}\n---\n`;
      let observed = await inspect();
      const initial = await cli('write', ['--directory', directory], {
        document: 'milestones',
        expectedSha256: null,
        source:
          bind(observed) +
          '# Milestones\n\n## Milestone 1: Greeting\n**Status:** pending\n\nReturn the requested greeting.\n',
        assignMissingIds: true,
      });
      expect(initial.assignedMilestoneIds).toHaveLength(1);
      const send = async (command: IPlanCommandInput) => {
        const response = await fixture.request({ kind: 'plan', command });
        if (response.kind !== 'plan') throw new Error('Missing plan response');
        return response.result;
      };
      const status = async (): Promise<IPlanStatus> => {
        const response = await send({ kind: 'status', target });
        if (response.kind !== 'status') throw new Error('Missing status');
        return response.result;
      };
      const approve = async (scope: 'plan' | 'sequence') => {
        const current = await status();
        await send({
          kind: 'approve',
          target,
          action: action(),
          expected: current.revision,
          scope,
          presentationHash: (scope === 'plan'
            ? current.inspection.plan
            : current.inspection.milestones)!,
        });
      };
      await send({
        kind: 'finalize',
        target,
        action: action(),
        expected: (await status()).revision,
      });
      await approve('plan');
      await approve('sequence');
      observed = await inspect();
      const originalId = observed.milestones.milestones![0]!.id!;
      const original = await status();
      const originalAuthorization = action();
      await send({
        kind: 'authorize',
        target,
        action: originalAuthorization,
        expected: original.revision,
        mode: 'supervised',
        milestoneIds: [originalId],
      });
      await cli('update', ['--directory', directory], {
        document: 'plan',
        expectedSha256: observed.plan.sha256,
        set: { status: 'in progress', updated_at: '2026-10-22T17:00:00Z' },
      });
      await cli('update', ['--directory', directory], {
        document: 'milestones',
        expectedSha256: observed.milestones.sha256,
        changes: [{ select: { id: originalId }, set: { status: 'in progress' } }],
      });
      expect(await status()).toMatchObject({
        revision: original.revision,
        skillsBinding: 'current',
        isSequenceApproved: true,
      });
      expect(
        (
          await send({
            kind: 'check-execution',
            target,
            expected: original.revision,
            authorizationId: originalAuthorization.id,
            milestoneId: originalId,
            mode: 'supervised',
          })
        ).kind,
      ).toBe('execution-check');
      await writeFile(
        join(fixture.workspaceRoot, 'greeting.mjs'),
        'export const greet = name => `Hello, ${name}`;\n',
      );
      const proof = await run(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          'import assert from "node:assert/strict";import {greet} from "./greeting.mjs";assert.equal(greet("Reader"), "Hello, Reader");console.log("greeting checked");',
        ],
        { cwd: fixture.workspaceRoot, timeout: 5000 },
      );
      expect(proof.stdout).toBe('greeting checked\n');
      await send({
        kind: 'complete',
        target,
        action: action(),
        expected: original.revision,
        milestoneId: originalId,
        checkouts: [],
        checks: [
          {
            command: 'node:assert greeting check',
            outcome: 'passed',
            reference: 'interop:actual-greeting-verification',
          },
        ],
      });
      expect((await status()).state).toBe('completed');
      observed = await inspect();
      expect(observed.milestones.milestones).toStrictEqual([{ id: originalId, status: 'done' }]);
      const completedSequence = observed.milestones.source!;
      await cli('write', ['--directory', directory], {
        document: 'plan',
        expectedSha256: observed.plan.sha256,
        body: '# Plan\nReturn the requested greeting and a report.\n',
        set: {
          revision: observed.plan.metadata.revision + 1,
          status: 'pending',
          updated_at: '2026-10-22T17:01:00Z',
        },
      });
      const stale = await status();
      expect(stale).toMatchObject({
        skillsBinding: 'stale',
        isPlanApproved: false,
        isFinalized: false,
      });
      expect(await readFile(join(directory, 'milestones.md'), 'utf8')).toBe(completedSequence);
      await expect(
        send({
          kind: 'check-execution',
          target,
          expected: stale.revision,
          authorizationId: originalAuthorization.id,
          milestoneId: originalId,
          mode: 'supervised',
        }),
      ).rejects.toMatchObject({ code: 'JG_AGENT_HQ_CLIENT_STATE_CONFLICT' });
      await approve('plan');
      await send({
        kind: 'begin-revision',
        target,
        action: action(),
        expected: (await status()).revision,
        intent: 'breakdown',
        threadIds: [],
        checkouts: [],
      });
      await expect
        .poll(async () => (await status()).coordination.revision?.phase, { timeout: 5000 })
        .toBe('editing');
      observed = await inspect();
      const written = await cli('write', ['--directory', directory], {
        document: 'milestones',
        expectedSha256: observed.milestones.sha256,
        source:
          bind(observed) +
          observed.milestones.body! +
          '## Milestone 2: Report\n**Status:** pending\n\nFormat the requested report.\n',
        assignMissingIds: true,
      });
      expect(written.assignedMilestoneIds).toHaveLength(1);
      const revised = await inspect();
      expect(revised.milestones.body!.split('## Milestone 2: Report')[0]).toBe(
        observed.milestones.body,
      );
      const finalized = await send({
        kind: 'finalize',
        target,
        action: action(),
        expected: (await status()).revision,
      });
      expect(finalized.kind).toBe('finalized');
      expect(await status()).toMatchObject({
        skillsBinding: 'current',
        isPlanApproved: true,
        isFinalized: true,
        isSequenceApproved: false,
        coordination: { completionCount: 1 },
      });
      observed = await inspect();
      expect(observed.milestones.milestones![0]).toStrictEqual({ id: originalId, status: 'done' });
      const nextId = observed.milestones.milestones![1]!.id!;
      expect(nextId).not.toBe(originalId);
      expect(observed.milestones.milestones![1]!.status).toBe('pending');
      await approve('sequence');
      const current = await status();
      const authorization = action();
      await send({
        kind: 'authorize',
        target,
        action: authorization,
        expected: current.revision,
        mode: 'supervised',
        milestoneIds: [nextId],
      });
      expect(
        (
          await send({
            kind: 'check-execution',
            target,
            expected: current.revision,
            authorizationId: authorization.id,
            milestoneId: nextId,
            mode: 'supervised',
          })
        ).kind,
      ).toBe('execution-check');
      expect((await status()).state).not.toBe('completed');
    });
  },
);

const examples = join(import.meta.dirname, '../../node_modules/jg-plans/examples');
const ExpectedSchema = z.object({ conforms: z.boolean() });

/*
 * Copies one shipped jg-plans example into the workspace and drives HQ's in-process plan API.
 * HQ blocks a sequence whose done milestones it never recorded, so copied milestones start
 * pending; status lines stay within the 0.2 vocabulary and outside the milestone contract.
 */
const exampleRuntime = async (fixture: IClaudeFixture, name: string) => {
  const directory = join(fixture.workspaceRoot, name);
  await mkdir(directory);
  await copyFile(join(examples, name, 'plan.md'), join(directory, 'plan.md'));
  const milestones = await readFile(join(examples, name, 'milestones.md'), 'utf8').catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return null;
    },
  );
  if (milestones !== null)
    await writeFile(
      join(directory, 'milestones.md'),
      milestones.replace(/^\*\*Status:\*\* (?:done|in progress)$/gm, '**Status:** pending'),
    );
  const target = { directory };
  const send = async (command: IPlanCommandInput) => {
    const response = await fixture.runtime.request({ kind: 'plan', command });
    if (response.kind !== 'plan') throw new Error('Missing plan response');
    return response.result;
  };
  const status = async (): Promise<IPlanStatus> => {
    const response = await send({ kind: 'status', target });
    if (response.kind !== 'status') throw new Error('Missing status');
    return response.result;
  };
  const approve = async (scope: 'plan' | 'sequence') => {
    const current = await status();
    return send({
      kind: 'approve',
      target,
      action: action(),
      expected: current.revision,
      scope,
      presentationHash: (scope === 'plan'
        ? current.inspection.plan
        : current.inspection.milestones)!,
    });
  };
  const finalize = async () =>
    send({ kind: 'finalize', target, action: action(), expected: (await status()).revision });
  const authorize = async (milestoneId: string) => {
    const authorization = action();
    await send({
      kind: 'authorize',
      target,
      action: authorization,
      expected: (await status()).revision,
      mode: 'supervised',
      milestoneIds: [milestoneId],
    });
    return authorization.id;
  };
  const checkExecution = async (authorizationId: string, milestoneId: string) =>
    send({
      kind: 'check-execution',
      target,
      expected: (await status()).revision,
      authorizationId,
      milestoneId,
      mode: 'supervised',
    });
  const beginRevision = async () => {
    await send({
      kind: 'begin-revision',
      target,
      action: action(),
      expected: (await status()).revision,
      intent: 'breakdown',
      threadIds: [],
      checkouts: [],
    });
    await expect
      .poll(async () => (await status()).coordination.revision?.phase, { timeout: 5000 })
      .toBe('editing');
  };
  return { directory, status, approve, finalize, authorize, checkExecution, beginRevision };
};

// the in-progress milestone of the shipped criteria example
const ACTIVE_MILESTONE = '8e1d6b2a-4f7c-4a3e-b9d1-6c2e8f4a7b15';

test.each(['criteria', 'criteria-invalid'])(
  'every HQ stage gate passes exactly when the shipped %s example conforms',
  { timeout: 20_000 },
  async (name) => {
    const expected = ExpectedSchema.parse(
      JSON.parse(await readFile(join(examples, name, 'expected.json'), 'utf8')),
    );
    await withClaudeRuntime(async (fixture) => {
      const plan = await exampleRuntime(fixture, name);
      expect((await plan.status()).revision).toBeDefined();
      if (expected.conforms) {
        await plan.approve('plan');
        await plan.finalize();
        await plan.approve('sequence');
        const authorization = await plan.authorize(ACTIVE_MILESTONE);
        expect((await plan.checkExecution(authorization, ACTIVE_MILESTONE)).kind).toBe(
          'execution-check',
        );
        return;
      }
      const invalid = { code: 'JG_AGENT_HQ_PLAN_INVALID' };
      await expect(plan.approve('plan')).rejects.toMatchObject(invalid);
      await expect(plan.finalize()).rejects.toMatchObject(invalid);
      await expect(plan.approve('sequence')).rejects.toMatchObject(invalid);
      await expect(plan.authorize('6f2b9c4d-1e7a-4d3b-8c5f-2a9e7d1b4c63')).rejects.toMatchObject(
        invalid,
      );
    });
  },
);

test(
  'a revision that adds a criterion stays readable and approvable while its sequence waits for coverage',
  { timeout: 20_000 },
  async () => {
    await withClaudeRuntime(async (fixture) => {
      const plan = await exampleRuntime(fixture, 'criteria');
      await plan.approve('plan');
      await plan.finalize();
      await plan.approve('sequence');
      const planPath = join(plan.directory, 'plan.md');
      await writeFile(
        planPath,
        (await readFile(planPath, 'utf8')).replace(
          '\n## Notes for reviewers',
          '- AC-04: Clearing the filters keeps the search text.\n\n## Notes for reviewers',
        ),
      );
      expect((await plan.status()).isPlanApproved).toBe(false);
      await plan.approve('plan');
      await plan.beginRevision();
      const invalid = { code: 'JG_AGENT_HQ_PLAN_INVALID' };
      await expect(plan.finalize()).rejects.toMatchObject(invalid);
      await expect(plan.approve('sequence')).rejects.toMatchObject(invalid);
      // a new milestone covers the new criterion; existing milestone contracts stay unchanged
      const milestonesPath = join(plan.directory, 'milestones.md');
      await writeFile(
        milestonesPath,
        (await readFile(milestonesPath, 'utf8')) +
          '## Milestone 3: Keep the search text\n**Status:** pending\n**Milestone ID:** 2d9f4b7e-6a1c-4e8d-9b3f-7c5a1e2d8f40\n**Acceptance criteria:** AC-04\n\nKeep the search text when the filters are cleared.\n',
      );
      expect((await plan.finalize()).kind).toBe('finalized');
      await plan.approve('sequence');
      expect(await plan.status()).toMatchObject({ isPlanApproved: true, isSequenceApproved: true });
    });
  },
);

test(
  'a hand edit that breaks an authorized protocol 0.2 plan closes execution without a revision change',
  { timeout: 20_000 },
  async () => {
    await withClaudeRuntime(async (fixture) => {
      const plan = await exampleRuntime(fixture, 'criteria');
      await plan.approve('plan');
      await plan.finalize();
      await plan.approve('sequence');
      const authorization = await plan.authorize(ACTIVE_MILESTONE);
      const before = await plan.status();
      expect((await plan.checkExecution(authorization, ACTIVE_MILESTONE)).kind).toBe(
        'execution-check',
      );
      const planPath = join(plan.directory, 'plan.md');
      await writeFile(
        planPath,
        (await readFile(planPath, 'utf8')).replace('status: in progress', 'status: blocked'),
      );
      expect((await plan.status()).revision).toStrictEqual(before.revision);
      await expect(plan.checkExecution(authorization, ACTIVE_MILESTONE)).rejects.toMatchObject({
        code: 'JG_AGENT_HQ_ACTION_CONFLICT',
      });
    });
  },
);

test(
  'protocol 0.1 examples keep their gates, and a 0.2 coverage line is milestone contract',
  { timeout: 20_000 },
  async () => {
    await withClaudeRuntime(async (fixture) => {
      const small = await exampleRuntime(fixture, 'small');
      await small.approve('plan');
      const legacy = await exampleRuntime(fixture, 'with-milestones');
      await legacy.approve('plan');
      await legacy.finalize();
      await legacy.approve('sequence');
      expect(await legacy.status()).toMatchObject({
        isPlanApproved: true,
        isSequenceApproved: true,
      });
      const criteria = await exampleRuntime(fixture, 'criteria');
      const before = (await criteria.status()).revision.breakdownDigest;
      expect(before).not.toBeNull();
      const milestonesPath = join(criteria.directory, 'milestones.md');
      await writeFile(
        milestonesPath,
        (await readFile(milestonesPath, 'utf8')).replace(
          '**Acceptance criteria:** AC-02, AC-03',
          '**Acceptance criteria:** AC-03, AC-02',
        ),
      );
      expect((await criteria.status()).revision.breakdownDigest).not.toBe(before);
    });
  },
);
