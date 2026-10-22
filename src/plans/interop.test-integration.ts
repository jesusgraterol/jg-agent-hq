// @vitest-environment node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { IPlanCommandInput, IPlanOperatorAction, IPlanStatus } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';
import { z } from 'zod';

import { withClaudeRuntime } from '../../scripts/test-support/index.js';

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
