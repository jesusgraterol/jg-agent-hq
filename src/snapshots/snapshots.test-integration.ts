import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createAgentHq, createHqSnapshot, inspectHqSnapshot, restoreHqSnapshot } from 'jg-agent-hq';
import { hashValue } from 'jg-crypto';
import { expectToRejectCode } from 'jg-exception/testing';
import { withPlanDocumentLocks } from 'jg-plans';
import type { IDispatchResponse, IRequestSpecification } from 'jg-agent-hq/contracts';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';

import {
  withClaudeRuntime,
  withCollaboration,
  writeFixtureControl,
  type ICollaborationFixture,
} from '../../scripts/test-support/index.js';

const faults = vi.hoisted(() => ({ target: '' }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (args[1] !== 'wx' || !faults.target || !String(args[0]).includes(faults.target))
        return handle;
      faults.target = '';
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'write' || property === 'writeFile')
            return async () => {
              throw Object.assign(new Error('Injected full disk'), { code: 'ENOSPC' });
            };
          const member: unknown = Reflect.get(target, property, target);
          return typeof member === 'function' ? member.bind(target) : member;
        },
      });
    },
  };
});
afterEach(() => {
  faults.target = '';
});

const readManifest = async (directory: string) =>
  (await readFile(join(directory, 'manifest.jsonl'), 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));

const registerPlan = async (runtime: Parameters<typeof createHqSnapshot>[0], directory: string) => {
  await mkdir(directory);
  await writeFile(
    join(directory, 'plan.md'),
    '---\nid: snapshot-plan\ncreated_at: 2026-10-23T00:00:00.000Z\nupdated_at: 2026-10-23T00:00:00.000Z\nrevision: 1\nstatus: pending\n---\n# Snapshot plan\n\nRetain checked evidence.\n',
  );
  await writeFile(
    join(directory, 'milestones.md'),
    '# Milestones\n\n## Milestone 1: Retain evidence\n**Status:** pending\n**Milestone ID:** 10000000-0000-4000-8000-000000000001\n\nVerify exact snapshot companions.\n',
  );
  const status = await runtime.request({
    kind: 'plan',
    command: { kind: 'status', target: { directory } },
  });
  if (status.kind !== 'plan' || status.result.kind !== 'status') throw new Error('Missing plan');
  await runtime.request({
    kind: 'plan',
    command: {
      kind: 'approve',
      target: { directory },
      action: {
        id: randomUUID(),
        operatorId: 'snapshot-owner',
        source: { kind: 'user-action', reference: 'snapshot-test' },
      },
      expected: status.result.result.revision,
      scope: 'plan',
      presentationHash: status.result.result.inspection.plan!,
    },
  });
};

test('WAL-aware capture includes host tables, key and locked plan companions; offline restore requires new roots and starts without providers', async () => {
  await withClaudeRuntime(async ({ runtime, root, workspaceRoot, stateRoot }) => {
    const directory = join(workspaceRoot, 'selected-plan');
    await registerPlan(runtime, directory);
    const host = new DatabaseSync(runtime.storage.databasePath);
    try {
      host.exec(
        'PRAGMA wal_autocheckpoint = 0; CREATE TABLE app_note (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT; PRAGMA user_version = 37',
      );
      host.prepare('INSERT INTO app_note VALUES (?, ?)').run(1, 'Committed in WAL');
      expect((await lstat(runtime.storage.databasePath + '-wal')).size).toBeGreaterThan(0);
      const snapshot = await createHqSnapshot(runtime, join(root, 'snapshot'));
      expect(snapshot).toMatchObject({
        planCount: 1,
        diagnosticPlanCount: 0,
        pendingWriteCount: 0,
        header: { sourceStateRoot: stateRoot, sourceAllowedRoots: [workspaceRoot] },
      });
      expect(await inspectHqSnapshot(snapshot.directory)).toStrictEqual(snapshot);
      expect(await readFile(join(snapshot.directory, 'action.key'))).toStrictEqual(
        await readFile(join(stateRoot, 'action.key')),
      );
      for (const name of ['hq-owner.json', 'control.sock', 'hq.lock'])
        await expect(lstat(join(snapshot.directory, name))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      const restored = await restoreHqSnapshot({
        snapshotDirectory: snapshot.directory,
        destination: join(root, 'recovery'),
      });
      const recoveredPlan = join(restored.recoveryRoot, hashValue(directory));
      for (const filename of ['plan.md', 'milestones.md', 'coordination.json'])
        expect(await readFile(join(recoveredPlan, filename))).toStrictEqual(
          await readFile(join(directory, filename)),
        );
      expect((await lstat(restored.stateRoot)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(restored.stateRoot, 'action.key'))).mode & 0o777).toBe(0o600);
      const reopened = await createAgentHq({
        stateRoot: restored.stateRoot,
        allowedRoots: [restored.recoveryRoot],
      });
      try {
        const status = await reopened.request({ kind: 'status' });
        expect(status).toMatchObject({
          kind: 'status',
          result: {
            providers: [
              { provider: 'codex', state: 'idle' },
              { provider: 'claude', state: 'idle' },
            ],
          },
        });
        const db = new DatabaseSync(reopened.storage.databasePath);
        try {
          expect(db.prepare('SELECT body FROM app_note').get()?.body).toBe('Committed in WAL');
          expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(37);
        } finally {
          db.close();
        }
      } finally {
        await reopened.close();
      }
    } finally {
      host.close();
    }
  });
});

test('capture uses construction roots rather than a mutated public runtime object', async () => {
  await withClaudeRuntime(async ({ runtime, root, stateRoot }) => {
    const other = join(root, 'other-state');
    await mkdir(other, { mode: 0o700 });
    await writeFile(join(other, 'action.key'), Buffer.alloc(32), { mode: 0o600 });
    const expectedKeyHash = hashValue(await readFile(join(stateRoot, 'action.key')));
    runtime.stateRoot = other;
    const snapshot = await createHqSnapshot(runtime, join(root, 'snapshot'));
    expect(snapshot.header.sourceStateRoot).toBe(stateRoot);
    expect(hashValue(await readFile(join(snapshot.directory, 'action.key')))).toBe(expectedKeyHash);
  });
});

test('capture rejects an action key changed after startup and never publishes a mismatched pair', async () => {
  await withClaudeRuntime(async ({ runtime, root, stateRoot }) => {
    const filename = join(stateRoot, 'action.key'),
      original = await readFile(filename);
    try {
      await writeFile(filename, Buffer.alloc(32), { mode: 0o600 });
      await expectToRejectCode(
        createHqSnapshot(runtime, join(root, 'snapshot')),
        'JG_AGENT_HQ_SNAPSHOT_INVALID',
      );
      await expect(lstat(join(root, 'snapshot'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await writeFile(filename, original, { mode: 0o600 });
    }
    expect((await createHqSnapshot(runtime, join(root, 'snapshot'))).header.sourceStateRoot).toBe(
      stateRoot,
    );
  });
});

test('startup rejects a different valid-length action key before changing the database', async () => {
  await withClaudeRuntime(async ({ runtime, root, stateRoot, workspaceRoot }) => {
    await runtime.close();
    const filename = join(stateRoot, 'action.key'),
      original = await readFile(filename);
    const databaseHash = hashValue(await readFile(join(stateRoot, 'hq.sqlite')));
    let unexpected: Awaited<ReturnType<typeof createAgentHq>> | undefined;
    try {
      await writeFile(filename, Buffer.alloc(32), { mode: 0o600 });
      const opening = (async () => {
        unexpected = await createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] });
        return unexpected;
      })();
      await expectToRejectCode(opening, 'JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE');
      expect(hashValue(await readFile(join(stateRoot, 'hq.sqlite')))).toBe(databaseHash);
      await expect(lstat(join(stateRoot, 'hq-owner.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await unexpected?.close();
      await writeFile(filename, original, { mode: 0o600 });
    }
    const reopened = await createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] });
    try {
      expect((await createHqSnapshot(reopened, join(root, 'snapshot'))).pendingWriteCount).toBe(0);
    } finally {
      await reopened.close();
    }
  });
});

test('host maintenance excludes capture, while capture proceeds through a native turn that completes meanwhile', async () => {
  await withClaudeRuntime(async ({ runtime, root, workspaceRoot }) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const admitted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const maintenance = runtime.withStorageMaintenance(async () => {
      started();
      await held;
    });
    await admitted;
    try {
      await expectToRejectCode(
        createHqSnapshot(runtime, join(root, 'snapshot')),
        'JG_AGENT_HQ_ACTION_CONFLICT',
      );
    } finally {
      release();
      await maintenance;
    }
    await expect(lstat(join(root, 'snapshot'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFixtureControl(root, 'control.json', { holdTurn: true, interruptDelay: 50 });
    const status = await runtime.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('Missing status');
    const created = await runtime.request({
      kind: 'action',
      action: {
        id: randomUUID(),
        runtimeEpoch: status.result.runtimeEpoch,
        command: { kind: 'thread-create', provider: 'codex', workspaceRoot, name: 'snapshot-busy' },
      },
    });
    if (created.kind !== 'action' || !created.result.threadId) throw new Error('Missing thread');
    const threadId = created.result.threadId;
    await expect
      .poll(() => runtime.request({ kind: 'managed-thread', threadId }))
      .toMatchObject({ kind: 'managed-thread', result: { state: 'idle' } });
    await runtime.request({
      kind: 'action',
      action: {
        id: randomUUID(),
        runtimeEpoch: status.result.runtimeEpoch,
        command: {
          kind: 'message',
          threadId,
          input: { kind: 'text', text: 'Hold the native turn.' },
        },
      },
    });
    await expect
      .poll(() => runtime.request({ kind: 'managed-thread', threadId }))
      .toMatchObject({ kind: 'managed-thread', result: { state: 'running' } });
    const running = await runtime.request({ kind: 'managed-thread', threadId });
    if (running.kind !== 'managed-thread' || !running.result?.activeTurnId)
      throw new Error('Missing turn');
    // the turn is interrupted and completes while the capture is underway
    const capture = createHqSnapshot(runtime, join(root, 'snapshot'));
    await runtime.request({
      kind: 'action',
      action: {
        id: randomUUID(),
        runtimeEpoch: status.result.runtimeEpoch,
        command: { kind: 'interrupt', threadId, expectedTurnId: running.result.activeTurnId },
      },
    });
    const snapshot = await capture;
    expect(await inspectHqSnapshot(snapshot.directory)).toStrictEqual(snapshot);
    await expect
      .poll(() => runtime.request({ kind: 'managed-thread', threadId }))
      .toMatchObject({ kind: 'managed-thread', result: { state: 'interrupted' } });
    const restored = await restoreHqSnapshot({
      snapshotDirectory: snapshot.directory,
      destination: join(root, 'recovery'),
    });
    const database = new DatabaseSync(join(restored.stateRoot, 'hq.sqlite'), { readOnly: true });
    try {
      expect({
        ...database.prepare('SELECT ownership, state FROM hq_thread WHERE id = ?').get(threadId),
      }).toStrictEqual({ ownership: 'uncertain', state: 'unknown' });
    } finally {
      database.close();
    }
  });
});

test('document contention returns busy and releases admission without repairing source artifacts', async () => {
  await withClaudeRuntime(async ({ runtime, root, workspaceRoot }) => {
    const directory = join(workspaceRoot, 'selected-plan');
    await registerPlan(runtime, directory);
    const before = await readFile(join(directory, 'coordination.json'));
    await withPlanDocumentLocks(directory, ['plan', 'milestones'], async () => {
      await expectToRejectCode(
        createHqSnapshot(runtime, join(root, 'snapshot')),
        'JG_AGENT_HQ_ACTION_CONFLICT',
      );
    });
    expect(await readFile(join(directory, 'coordination.json'))).toStrictEqual(before);
    expect(await runtime.request({ kind: 'status' })).toMatchObject({ kind: 'status' });
    expect((await createHqSnapshot(runtime, join(root, 'snapshot'))).planCount).toBe(1);
  });
});

test('prepared document writes, mismatched source files and exact journal bytes survive without replay', async () => {
  await withClaudeRuntime(async ({ runtime, root, workspaceRoot }) => {
    const directory = join(workspaceRoot, 'selected-plan');
    await registerPlan(runtime, directory);
    await writeFile(join(directory, 'plan.md'), '# Incomplete replacement\n');
    const id = randomUUID();
    const intent = JSON.stringify({
      id,
      digest: 'a'.repeat(64),
      directory,
      before: { plan: 'b'.repeat(64), milestones: null, coordination: null },
      plan: '# Intended plan\n',
      milestones: { operation: 'keep' },
      coordination: '{"pending":"exact bytes"}',
      state: 'prepared',
    });
    await runtime.withStorageMaintenance(async (storage) => {
      const db = new DatabaseSync(storage.databasePath);
      try {
        db.prepare("INSERT INTO hq_plan_operation VALUES (?, ?, 'prepared', ?)").run(
          id,
          directory,
          intent,
        );
      } finally {
        db.close();
      }
    });
    await expectToRejectCode(
      runtime.withStorageMaintenance(async () => undefined),
      'JG_AGENT_HQ_ACTION_CONFLICT',
    );
    const snapshot = await createHqSnapshot(runtime, join(root, 'snapshot'));
    expect(snapshot.pendingWriteCount).toBe(1);
    const restored = await restoreHqSnapshot({
      snapshotDirectory: snapshot.directory,
      destination: join(root, 'recovery'),
    });
    const db = new DatabaseSync(join(restored.stateRoot, 'hq.sqlite'));
    try {
      expect(
        db.prepare('SELECT state, intent FROM hq_plan_operation WHERE id = ?').get(id),
      ).toMatchObject({ state: 'prepared', intent });
    } finally {
      db.close();
    }
    expect(
      await readFile(join(restored.recoveryRoot, hashValue(directory), 'plan.md'), 'utf8'),
    ).toBe('# Incomplete replacement\n');
    expect(await readFile(join(directory, 'plan.md'), 'utf8')).toBe('# Incomplete replacement\n');
  });
});

test.each(['action.key', 'hq.sqlite', 'manifest.jsonl', 'complete.json', 'companion'])(
  'missing or corrupt %s prevents restore without creating a target',
  async (name) => {
    await withClaudeRuntime(async ({ runtime, root, workspaceRoot }) => {
      const directory = join(workspaceRoot, 'selected-plan');
      await registerPlan(runtime, directory);
      const snapshot = await createHqSnapshot(runtime, join(root, 'snapshot'));
      const filename =
        name === 'companion'
          ? join(snapshot.directory, 'plans', hashValue(directory), 'coordination.json')
          : join(snapshot.directory, name);
      if (name === 'hq.sqlite' || name === 'manifest.jsonl')
        await writeFile(filename, 'corrupt', { mode: 0o600 });
      else await rm(filename);
      await expectToRejectCode(
        inspectHqSnapshot(snapshot.directory),
        'JG_AGENT_HQ_SNAPSHOT_INVALID',
      );
      await expectToRejectCode(
        restoreHqSnapshot({
          snapshotDirectory: snapshot.directory,
          destination: join(root, 'recovery'),
        }),
        'JG_AGENT_HQ_SNAPSHOT_INVALID',
      );
      await expect(lstat(join(root, 'recovery'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  },
);

test.each([
  'file-link',
  'parent-link',
  'shared-key',
  'path-traversal',
  'omitted-plan',
  'bad-schema',
  'wrong-key-pair',
])(
  'inspection rejects %s even when the attacker recomputes manifest completion',
  async (attack) => {
    await withClaudeRuntime(async ({ runtime, root, workspaceRoot }) => {
      const directory = join(workspaceRoot, 'selected-plan');
      await registerPlan(runtime, directory);
      const snapshot = await createHqSnapshot(runtime, join(root, 'snapshot'));
      const entries = await readManifest(snapshot.directory);
      if (attack === 'file-link') {
        await rm(join(snapshot.directory, 'action.key'));
        await symlink(
          join(runtime.stateRoot, 'action.key'),
          join(snapshot.directory, 'action.key'),
        );
      }
      if (attack === 'parent-link') {
        await rm(join(snapshot.directory, 'plans', hashValue(directory)), { recursive: true });
        await symlink(directory, join(snapshot.directory, 'plans', hashValue(directory)));
      }
      if (attack === 'shared-key') await chmod(join(snapshot.directory, 'action.key'), 0o644);
      if (attack === 'path-traversal') entries[3].key = '../outside';
      if (attack === 'omitted-plan') entries.pop();
      if (attack === 'bad-schema') entries[0].schemaHash = '0'.repeat(64);
      if (attack === 'wrong-key-pair') {
        const key = Buffer.alloc(32);
        await writeFile(join(snapshot.directory, 'action.key'), key, { mode: 0o600 });
        entries[2].file = { bytes: 32, sha256: hashValue(key) };
      }
      const text = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
      await writeFile(join(snapshot.directory, 'manifest.jsonl'), text, { mode: 0o600 });
      await writeFile(
        join(snapshot.directory, 'complete.json'),
        JSON.stringify({ manifestSha256: hashValue(text), records: entries.length }),
        { mode: 0o600 },
      );
      // a header from another schema names the package version that claims to have written it
      await expectToRejectCode(
        inspectHqSnapshot(snapshot.directory),
        attack === 'bad-schema' ? 'JG_AGENT_HQ_STORAGE_INVALID' : 'JG_AGENT_HQ_SNAPSHOT_INVALID',
      );
    });
  },
);

test('occupied snapshot and restore targets, including a live state root, remain untouched', async () => {
  await withClaudeRuntime(async ({ runtime, root, workspaceRoot }) => {
    const snapshot = await createHqSnapshot(runtime, join(root, 'snapshot'));
    const before = await readFile(join(snapshot.directory, 'complete.json'));
    await expectToRejectCode(
      createHqSnapshot(runtime, snapshot.directory),
      'JG_AGENT_HQ_SNAPSHOT_INVALID',
    );
    expect(await readFile(join(snapshot.directory, 'complete.json'))).toStrictEqual(before);
    const key = await readFile(join(runtime.stateRoot, 'action.key'));
    for (const destination of [runtime.stateRoot, workspaceRoot, snapshot.directory])
      await expectToRejectCode(
        restoreHqSnapshot({ snapshotDirectory: snapshot.directory, destination }),
        'JG_AGENT_HQ_SNAPSHOT_INVALID',
      );
    expect(await readFile(join(runtime.stateRoot, 'action.key'))).toStrictEqual(key);
    expect(await runtime.request({ kind: 'status' })).toMatchObject({ kind: 'status' });
  });
});

test.each(['/snapshot/manifest.jsonl', '/snapshot/plans/'])(
  'full-disk failure at %s removes owned output and releases admission',
  async (target) => {
    await withClaudeRuntime(async ({ runtime, root, workspaceRoot }) => {
      const directory = join(workspaceRoot, 'selected-plan');
      await registerPlan(runtime, directory);
      const before = await readFile(join(directory, 'plan.md'));
      faults.target = target;
      await expectToRejectCode(
        createHqSnapshot(runtime, join(root, 'snapshot')),
        'JG_AGENT_HQ_SNAPSHOT_FAILED',
        'Injected full disk',
      );
      await expect(lstat(join(root, 'snapshot'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(directory, 'plan.md'))).toStrictEqual(before);
      expect((await createHqSnapshot(runtime, join(root, 'snapshot'))).planCount).toBe(1);
    });
  },
);

test('registered plans cross a seek-page boundary and missing source evidence stays diagnostic', async () => {
  await withClaudeRuntime(async ({ runtime, root, workspaceRoot }) => {
    // crash-recovery fixtures exercise the registration trigger without a model or document rewrite
    await runtime.withStorageMaintenance(async (storage) => {
      const db = new DatabaseSync(storage.databasePath);
      try {
        db.exec('BEGIN');
        const insert = db.prepare('INSERT INTO hq_plan_projection VALUES (?, NULL)');
        for (let index = 0; index < 130; index++)
          insert.run(join(workspaceRoot, `missing-${String(index).padStart(4, '0')}`));
        db.exec('COMMIT');
      } finally {
        db.close();
      }
    });
    const snapshot = await createHqSnapshot(runtime, join(root, 'snapshot'));
    expect(snapshot).toMatchObject({ planCount: 130, diagnosticPlanCount: 130 });
    const records = (await readManifest(snapshot.directory)).filter(
      (entry) => entry.kind === 'plan',
    );
    expect(new Set(records.map((entry) => entry.sourceDirectory)).size).toBe(130);
    expect(
      records.every((entry) =>
        z.array(z.string()).parse(entry.diagnostics).includes('plan-missing'),
      ),
    ).toBe(true);
    expect((await inspectHqSnapshot(snapshot.directory)).planCount).toBe(130);
  });
});

test('repeated public task plan binding remains idempotent and registers one snapshot artifact set', async () => {
  await withCollaboration(async (fixture) => {
    const directory = join(fixture.native.workspaceRoot, 'selected-plan');
    await registerPlan(fixture.native.runtime, directory);
    const status = await fixture.native.runtime.request({
      kind: 'plan',
      command: { kind: 'status', target: { directory } },
    });
    if (status.kind !== 'plan' || status.result.kind !== 'status') throw new Error('Missing plan');
    const plan = {
      planId: 'snapshot-plan',
      directory,
      revision: status.result.result.revision,
      milestoneIds: [],
    };
    for (const expectedRevision of [1, 2])
      await fixture.call({
        kind: 'task-plan-set',
        id: randomUUID(),
        taskId: fixture.taskId,
        expectedRevision,
        plan,
      });
    expect(
      (await createHqSnapshot(fixture.native.runtime, join(fixture.native.root, 'snapshot')))
        .planCount,
    ).toBe(1);
  });
});

test('reauthorizing a request registers its newly selected plan for capture', async () => {
  await withCollaboration(async (fixture) => {
    const requestId = randomUUID();
    await publish(fixture, requestId, fixture.agentIds[0]!);
    const directory = join(fixture.native.workspaceRoot, 'reauthorized-plan');
    await mkdir(directory);
    const source = '# Selected request plan\n';
    await writeFile(join(directory, 'plan.md'), source);
    await fixture.call({
      kind: 'request-authorize',
      id: randomUUID(),
      taskId: fixture.taskId,
      requestId,
      expectedActionId: null,
      grantId: null,
      grantRevision: null,
      plan: {
        directory,
        planId: 'request-plan',
        revision: { planDigest: hashValue(source), breakdownDigest: null },
        milestoneIds: [],
      },
    });
    const snapshot = await createHqSnapshot(
      fixture.native.runtime,
      join(fixture.native.root, 'snapshot'),
    );
    expect(snapshot.planCount).toBe(1);
    expect(
      await readFile(join(snapshot.directory, 'plans', hashValue(directory), 'plan.md'), 'utf8'),
    ).toBe(source);
    expect((await inspectHqSnapshot(snapshot.directory)).planCount).toBe(1);
  });
});

test('narrowed workspace roots retain registered references without reading unavailable companions', async () => {
  await withClaudeRuntime(async ({ runtime, root, workspaceRoot, stateRoot }) => {
    const directory = join(workspaceRoot, 'selected-plan');
    await registerPlan(runtime, directory);
    await runtime.close();
    const selectedRoot = join(workspaceRoot, 'selected-root');
    await mkdir(selectedRoot);
    await writeFile(join(root, 'outside-scope.txt'), 'External source evidence.');
    await rm(join(directory, 'plan.md'));
    await symlink(join(root, 'outside-scope.txt'), join(directory, 'plan.md'));
    const narrowed = await createAgentHq({ stateRoot, allowedRoots: [selectedRoot] });
    try {
      const snapshot = await createHqSnapshot(narrowed, join(root, 'snapshot'));
      expect(snapshot).toMatchObject({ planCount: 1, diagnosticPlanCount: 1 });
      expect((await readManifest(snapshot.directory))[3]).toMatchObject({
        sourceDirectory: directory,
        plan: null,
        milestones: null,
        coordination: null,
        diagnostics: ['plan-unavailable'],
      });
      expect((await inspectHqSnapshot(snapshot.directory)).planCount).toBe(1);
    } finally {
      await narrowed.close();
    }
  });
});

test('a restore copy failure removes its private workspace, preserves source evidence and can be retried', async () => {
  await withClaudeRuntime(async ({ runtime, root }) => {
    const snapshot = await createHqSnapshot(runtime, join(root, 'snapshot'));
    const before = await readFile(join(snapshot.directory, 'complete.json'));
    const preload = join(root, 'restore-fault.mjs');
    await writeFile(
      preload,
      `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.promises.open;
fs.promises.open = async (...args) => {
  const handle = await original(...args);
  if (args[1] !== 'wx' || !String(args[0]).includes('/recovery/staging/')) return handle;
  return new Proxy(handle, { get(target, property) {
    if (property === 'write' || property === 'writeFile') return async () => { throw Object.assign(new Error('Injected restore ENOSPC'), { code: 'ENOSPC' }); };
    const member = Reflect.get(target, property, target);
    return typeof member === 'function' ? member.bind(target) : member;
  }});
};
syncBuiltinESMExports();\n`,
    );
    const runner = join(root, 'restore-runner.mjs');
    await writeFile(
      runner,
      `import assert from 'node:assert/strict';
import { restoreHqSnapshot } from ${JSON.stringify(pathToFileURL(resolve('dist/index.js')).href)};
import { hasErrorCode, extractMessage } from ${JSON.stringify(import.meta.resolve('jg-exception'))};
try {
  await restoreHqSnapshot(${JSON.stringify({ snapshotDirectory: snapshot.directory, destination: join(root, 'recovery') })});
  assert.fail('Restore unexpectedly succeeded');
} catch (error) {
  assert.ok(hasErrorCode(error, 'JG_AGENT_HQ_SNAPSHOT_FAILED'));
  assert.equal(extractMessage(error), 'The HQ snapshot operation failed: Injected restore ENOSPC');
}\n`,
    );
    await promisify(execFile)(process.execPath, ['--import', pathToFileURL(preload).href, runner], {
      timeout: 10_000,
      maxBuffer: 65_536,
    });
    await expect(lstat(join(root, 'recovery'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(snapshot.directory, 'complete.json'))).toStrictEqual(before);
    const restored = await restoreHqSnapshot({
      snapshotDirectory: snapshot.directory,
      destination: join(root, 'recovery'),
    });
    expect(await readFile(join(restored.stateRoot, 'action.key'))).toStrictEqual(
      await readFile(join(runtime.stateRoot, 'action.key')),
    );
  });
});

test('restore rejects a source replaced by another valid snapshot after initial inspection', async () => {
  await withClaudeRuntime(async ({ runtime, root }) => {
    const first = await createHqSnapshot(runtime, join(root, 'first'));
    await runtime.withStorageMaintenance(async (storage) => {
      const host = new DatabaseSync(storage.databasePath);
      try {
        host.exec('CREATE TABLE app_marker (id INTEGER PRIMARY KEY) STRICT');
      } finally {
        host.close();
      }
    });
    const second = await createHqSnapshot(runtime, join(root, 'second'));
    expect(second.manifestSha256).not.toBe(first.manifestSha256);
    const destination = join(root, 'recovery');
    const preload = join(root, 'replace-source.mjs');
    await writeFile(
      preload,
      `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.promises.mkdir;
fs.promises.mkdir = async (...args) => {
  const result = await original(...args);
  if (args[0] === ${JSON.stringify(destination)})
    for (const name of ['hq.sqlite', 'action.key', 'manifest.jsonl', 'complete.json'])
      await fs.promises.copyFile(${JSON.stringify(second.directory)} + '/' + name, ${JSON.stringify(first.directory)} + '/' + name);
  return result;
};
syncBuiltinESMExports();\n`,
    );
    const runner = join(root, 'replace-runner.mjs');
    await writeFile(
      runner,
      `import assert from 'node:assert/strict';
import { restoreHqSnapshot } from ${JSON.stringify(pathToFileURL(resolve('dist/index.js')).href)};
import { hasErrorCode } from ${JSON.stringify(import.meta.resolve('jg-exception'))};
let failure;
try { await restoreHqSnapshot(${JSON.stringify({ snapshotDirectory: first.directory, destination })}); }
catch (error) { failure = error; }
assert.ok(hasErrorCode(failure, 'JG_AGENT_HQ_SNAPSHOT_INVALID'), 'Replaced source was accepted');\n`,
    );
    await promisify(execFile)(process.execPath, ['--import', pathToFileURL(preload).href, runner], {
      timeout: 10_000,
      maxBuffer: 65_536,
    });
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await inspectHqSnapshot(first.directory)).manifestSha256).toBe(second.manifestSha256);
  });
});

// a complete capture/restore and fresh-runtime worker lifecycle around a stopped-controller checkpoint
test(
  'submitted receipts, queued input and live approvals are fenced without replay',
  { timeout: 15000 },
  async () => {
    await withCollaboration(async (fixture) => {
      const status = await fixture.native.runtime.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing status');
      const actionId = randomUUID(),
        approvalId = randomUUID(),
        queueId = randomUUID();
      const queuedInput = JSON.stringify({
        text: 'Exact queued input',
        skill: null,
        files: [],
        settings: {},
      });
      // seed a stopped-controller crash checkpoint; capture proceeds while work is submitted
      await fixture.native.runtime.withStorageMaintenance(async (storage) => {
        const db = new DatabaseSync(storage.databasePath);
        try {
          const now = Date.now();
          db.prepare(
            'INSERT INTO hq_action (id,digest,requested_runtime_epoch,runtime_epoch,kind,thread_id,delivery,created_at,updated_at) VALUES (?,?,?,?,?,?,?, ?,?)',
          ).run(
            actionId,
            'a'.repeat(64),
            status.result.runtimeEpoch,
            status.result.runtimeEpoch,
            'message',
            fixture.agentIds[0]!,
            'submitted',
            now,
            now,
          );
          db.prepare(
            "INSERT INTO hq_action (id,digest,requested_runtime_epoch,runtime_epoch,kind,thread_id,delivery,queued_input,queue_ready,created_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,1,?,?)",
          ).run(
            queueId,
            'b'.repeat(64),
            status.result.runtimeEpoch,
            status.result.runtimeEpoch,
            'queue',
            fixture.agentIds[0]!,
            queuedInput,
            now,
            now,
          );
          db.prepare(
            "INSERT INTO hq_native_approval (id,thread_id,native_turn_id,runtime_epoch,native_request_id,digest,kind,is_blocking,state,created_at,updated_at) VALUES (?,?,?,?,?,?,'command',1,'pending',?,?)",
          ).run(
            approvalId,
            fixture.agentIds[0]!,
            'stopped-turn',
            status.result.runtimeEpoch,
            'native-permission',
            'c'.repeat(64),
            now,
            now,
          );
        } finally {
          db.close();
        }
      });
      const snapshot = await createHqSnapshot(
        fixture.native.runtime,
        join(fixture.native.root, 'snapshot'),
      );
      const restored = await restoreHqSnapshot({
        snapshotDirectory: snapshot.directory,
        destination: join(fixture.native.root, 'recovery'),
      });
      const db = new DatabaseSync(join(restored.stateRoot, 'hq.sqlite'));
      try {
        expect(
          db
            .prepare('SELECT delivery, native_request_id FROM hq_action WHERE id = ?')
            .get(actionId),
        ).toMatchObject({ delivery: 'uncertain', native_request_id: null });
        expect(
          db
            .prepare('SELECT delivery, queued_input, queue_ready FROM hq_action WHERE id = ?')
            .get(queueId),
        ).toMatchObject({
          delivery: 'queued',
          queued_input: queuedInput,
          queue_ready: 0,
        });
        expect(
          db.prepare('SELECT state FROM hq_native_approval WHERE id = ?').get(approvalId)?.state,
        ).toBe('expired');
      } finally {
        db.close();
      }
      const reopened = await createAgentHq({
        stateRoot: restored.stateRoot,
        allowedRoots: [fixture.native.workspaceRoot],
      });
      try {
        const current = await reopened.request({ kind: 'status' });
        if (current.kind !== 'status') throw new Error('Missing status');
        expect(current.result.runtimeEpoch).not.toBe(status.result.runtimeEpoch);
        expect(current.result.providers.every((provider) => provider.state === 'idle')).toBe(true);
        expect(await reopened.request({ kind: 'receipt', actionId })).toMatchObject({
          kind: 'receipt',
          result: { delivery: 'uncertain' },
        });
      } finally {
        await reopened.close();
      }
    });
  },
);

const publish = async (
  fixture: ICollaborationFixture,
  requestId: string,
  targetAgentId: string,
  parentRequestId?: string,
) => {
  const request: IRequestSpecification = {
    targetAgentId,
    claimable: false,
    skill: null,
    grantId: null,
    grantRevision: null,
    arguments: 'Return the exact report.',
    effects: ['read'],
    scopes: [{ workspaceRoot: fixture.native.workspaceRoot, pathPrefixes: [''] }],
    plan: null,
    targetReferences: [],
  };
  return fixture.call(
    {
      kind: 'message-publish',
      id: requestId,
      taskId: fixture.taskId,
      streamId: fixture.streamId,
      messageKind: 'request',
      summary: 'Snapshot request',
      body: request.arguments,
      references: [],
      replyToMessageId: null,
      ...(parentRequestId ? { parentRequestId } : {}),
      request,
    },
    parentRequestId ? { kind: 'agent', agentId: fixture.agentIds[0]! } : fixture.host,
  );
};

const finish = async (
  fixture: ICollaborationFixture,
  requestId: string,
  outcome: IDispatchResponse['outcome'],
  children: string[] = [],
) => {
  const result: IDispatchResponse = {
    requestId,
    outcome,
    childRequestIds: children,
    requiredAuthority: null,
    report: `Exact ${outcome}: ${requestId}. 🙂`,
  };
  const thread = await fixture.native.request({
    kind: 'managed-thread',
    threadId: fixture.agentIds[0]!,
  });
  if (thread.kind !== 'managed-thread' || !thread.result?.nativeId || !thread.result.activeTurnId)
    throw new Error('Missing native turn');
  await writeFixtureControl(fixture.native.root, 'control.json', {
    holdTurn: true,
    emitOnce: true,
    emit: [
      {
        method: 'item/completed',
        params: {
          threadId: thread.result.nativeId,
          turnId: thread.result.activeTurnId,
          item: { id: randomUUID(), type: 'agentMessage', text: JSON.stringify(result) },
        },
      },
      {
        method: 'turn/completed',
        params: {
          threadId: thread.result.nativeId,
          turn: { id: thread.result.activeTurnId, status: 'completed' },
        },
      },
    ],
  });
  await fixture.native.request({ kind: 'skills', threadId: fixture.agentIds[0]! });
  await expect
    .poll(() => fixture.call({ kind: 'request-read', taskId: fixture.taskId, requestId }))
    .toMatchObject({
      kind: 'request',
      request: { state: outcome === 'waiting-children' ? 'waiting-children' : 'resolved' },
    });
  return result;
};

test.each(['pending-child', 'returned-child'] as const)(
  '%s reports and parent waits survive restore without native histories; authority stays paused',
  { timeout: 20000 },
  async (phase) => {
    await withCollaboration(async (fixture) => {
      await writeFixtureControl(fixture.native.root, 'control.json', { holdTurn: true });
      await writeFixtureControl(fixture.native.root, 'claude-control.json', { holdTurn: true });
      const parentId = randomUUID(),
        childId = randomUUID();
      await publish(fixture, parentId, fixture.agentIds[0]!);
      await fixture.call({
        kind: 'request-dispatch',
        id: randomUUID(),
        taskId: fixture.taskId,
        requestId: parentId,
      });
      await expect
        .poll(() =>
          fixture.call({ kind: 'request-read', taskId: fixture.taskId, requestId: parentId }),
        )
        .toMatchObject({ kind: 'request', request: { currentActionId: parentId } });
      await publish(fixture, childId, fixture.agentIds[1]!, parentId);
      const waiting = await finish(fixture, parentId, 'waiting-children', [childId]);
      const grantId = randomUUID();
      await fixture.call({
        kind: 'grant-issue',
        id: grantId,
        taskId: fixture.taskId,
        eligibleAgentIds: null,
        skills: [{ name: 'jg-feedback', mode: null }],
        effects: ['read'],
        scopes: [{ workspaceRoot: fixture.native.workspaceRoot, pathPrefixes: [''] }],
        plan: null,
      });
      await fixture.call({
        kind: 'agent-state-set',
        id: randomUUID(),
        taskId: fixture.taskId,
        agentId: fixture.agentIds[phase === 'pending-child' ? 1 : 0]!,
        expectedRevision: 1,
        state: 'paused',
      });
      const childReport = 'Recovered child finding. 🙂\n'.repeat(8192);
      if (phase === 'returned-child')
        await writeFixtureControl(fixture.native.root, 'claude-control.json', {
          structuredOutput: {
            requestId: childId,
            outcome: 'completed',
            childRequestIds: [],
            requiredAuthority: null,
            report: childReport,
          },
        });
      await fixture.call({
        kind: 'task-policy-set',
        id: randomUUID(),
        taskId: fixture.taskId,
        expectedRevision: 1,
        policy: { ...fixture.policy, automaticDispatch: true },
      });
      if (phase === 'returned-child')
        await expect
          .poll(() =>
            fixture.call({ kind: 'request-read', taskId: fixture.taskId, requestId: childId }),
          )
          .toMatchObject({ kind: 'request', request: { state: 'resolved' } });
      const before = await fixture.call({
        kind: 'request-read',
        taskId: fixture.taskId,
        requestId: parentId,
      });
      if (before.kind !== 'request') throw new Error('Missing parent');
      if (phase === 'returned-child') expect(before.request.continuationActionId).not.toBeNull();
      const snapshot = await createHqSnapshot(
        fixture.native.runtime,
        join(fixture.native.root, 'snapshot'),
      );
      await fixture.native.runtime.close();
      await rm(fixture.native.configRoot, { recursive: true });
      const restored = await restoreHqSnapshot({
        snapshotDirectory: snapshot.directory,
        destination: join(fixture.native.root, 'recovery'),
      });
      const reopened = await createAgentHq({
        stateRoot: restored.stateRoot,
        allowedRoots: [fixture.native.workspaceRoot],
      });
      try {
        const task = await fixture.call(
          { kind: 'task-read', taskId: fixture.taskId },
          fixture.host,
          reopened,
        );
        expect(task).toMatchObject({
          kind: 'task',
          task: { state: 'paused', policy: { automaticDispatch: false } },
        });
        expect(
          await fixture.call(
            { kind: 'grant-read', taskId: fixture.taskId, grantId },
            fixture.host,
            reopened,
          ),
        ).toMatchObject({ kind: 'grant', grant: { revokedAt: expect.any(Number) } });
        const recovered = await fixture.call(
          { kind: 'request-read', taskId: fixture.taskId, requestId: parentId },
          fixture.host,
          reopened,
        );
        expect(recovered).toMatchObject({
          kind: 'request',
          request: {
            state: 'waiting-children',
            waitGeneration: 1,
            childRequestIds: [childId],
            dispatchCount: 1,
            continuationActionId: before.request.continuationActionId,
          },
        });
        const report = await fixture.call(
          { kind: 'report-read', taskId: fixture.taskId, reportId: parentId },
          fixture.host,
          reopened,
        );
        expect(report).toMatchObject({
          kind: 'report',
          result: {
            text: waiting.report,
            report: { sha256: hashValue(waiting.report) },
            isComplete: true,
          },
        });
        if (phase === 'returned-child') {
          let cursor: string | undefined;
          let text = '';
          do {
            const chunk = await fixture.call(
              {
                kind: 'report-read',
                taskId: fixture.taskId,
                reportId: childId,
                ...(cursor ? { cursor } : {}),
              },
              fixture.host,
              reopened,
            );
            if (chunk.kind !== 'report') throw new Error('Missing child report');
            expect(Buffer.byteLength(chunk.result.text)).toBeLessThanOrEqual(32_768);
            expect(chunk.result.report.sha256).toBe(hashValue(childReport));
            text += chunk.result.text;
            cursor = chunk.result.nextCursor ?? undefined;
          } while (cursor);
          expect(text).toBe(childReport);
        }
        const status = await reopened.request({ kind: 'status' });
        expect(status).toMatchObject({
          kind: 'status',
          result: {
            providers: [
              { provider: 'codex', state: 'idle' },
              { provider: 'claude', state: 'idle' },
            ],
          },
        });
        expect(
          await reopened.request({ kind: 'managed-thread', threadId: fixture.agentIds[0]! }),
        ).toMatchObject({
          kind: 'managed-thread',
          result: { ownership: 'uncertain', state: 'unknown' },
        });
      } finally {
        await reopened.close();
      }
    });
  },
);

// only fixture-owned complete inventories are rewritten; production capture/verification remains real
const refreshDatabaseInventory = async (
  directory: string,
  header?: { schemaHash: string; packageVersion: string },
) => {
  const entries = await readManifest(directory);
  const database = await readFile(join(directory, 'hq.sqlite'));
  entries[1].file = { bytes: database.length, sha256: hashValue(database) };
  if (header) Object.assign(entries[0], header);
  const text = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  await writeFile(join(directory, 'manifest.jsonl'), text);
  await writeFile(
    join(directory, 'complete.json'),
    JSON.stringify({ manifestSha256: hashValue(text), records: entries.length }),
  );
};

test.each(['header', 'database'])(
  'a snapshot whose %s comes from another schema is refused by name before restore reserves its destination',
  async (source) => {
    await withClaudeRuntime(async ({ runtime, root }) => {
      const snapshot = await createHqSnapshot(runtime, join(root, 'snapshot'));
      if (source === 'database') {
        const database = new DatabaseSync(join(snapshot.directory, 'hq.sqlite'));
        try {
          database
            .prepare('UPDATE hq_schema SET schema_hash = ?, package_version = ?')
            .run('f'.repeat(64), '9.9.9');
        } finally {
          database.close();
        }
        await refreshDatabaseInventory(snapshot.directory);
      } else
        await refreshDatabaseInventory(snapshot.directory, {
          schemaHash: 'f'.repeat(64),
          packageVersion: '9.9.9',
        });
      const before = hashValue(await readFile(join(snapshot.directory, 'hq.sqlite')));
      await expectToRejectCode(
        inspectHqSnapshot(snapshot.directory),
        'JG_AGENT_HQ_STORAGE_INVALID',
        'The HQ storage is invalid: written by jg-agent-hq 9.9.9',
      );
      await expectToRejectCode(
        restoreHqSnapshot({
          snapshotDirectory: snapshot.directory,
          destination: join(root, 'recovery'),
        }),
        'JG_AGENT_HQ_STORAGE_INVALID',
        'written by jg-agent-hq 9.9.9',
      );
      await expect(lstat(join(root, 'recovery'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(hashValue(await readFile(join(snapshot.directory, 'hq.sqlite')))).toBe(before);
    });
  },
);

test('a plan revised after its threads bound is reported changed, and restore strips only its execution scope', async () => {
  await withClaudeRuntime(async ({ runtime, root, workspaceRoot }) => {
    const directory = join(workspaceRoot, 'selected-plan');
    await registerPlan(runtime, directory);
    const status = await runtime.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('Missing status');
    const created = await runtime.request({
      kind: 'action',
      action: {
        id: randomUUID(),
        runtimeEpoch: status.result.runtimeEpoch,
        command: { kind: 'thread-create', provider: 'codex', workspaceRoot, name: 'bound-plan' },
      },
    });
    if (created.kind !== 'action' || !created.result.threadId) throw new Error('Missing thread');
    const threadId = created.result.threadId;
    await expect
      .poll(() => runtime.request({ kind: 'managed-thread', threadId }))
      .toMatchObject({ kind: 'managed-thread', result: { state: 'idle' } });
    const plan = await runtime.request({
      kind: 'plan',
      command: { kind: 'status', target: { directory } },
    });
    if (plan.kind !== 'plan' || plan.result.kind !== 'status') throw new Error('Missing plan');
    const revision = plan.result.result.revision;
    const authorizationId = randomUUID();
    // a thread bound under the plan's current revision, as execution admission records it
    await runtime.withStorageMaintenance(async (storage) => {
      const db = new DatabaseSync(storage.databasePath);
      try {
        db.prepare(
          'INSERT INTO hq_thread_plan (thread_id, directory, context, authorization_id, milestone_id) VALUES (?, ?, ?, ?, NULL)',
        ).run(
          threadId,
          directory,
          JSON.stringify({
            directory,
            scope: {
              kind: 'execution',
              authorizationId,
              milestoneId: null,
              mode: 'supervised',
              revision,
            },
            observedRevision: revision,
          }),
          authorizationId,
        );
      } finally {
        db.close();
      }
    });
    const current = await createHqSnapshot(runtime, join(root, 'current'));
    expect(current.changedPlanCount).toBe(0);
    expect((await readManifest(current.directory))[3]).toMatchObject({
      revision,
      recordedRevisions: [revision],
      diagnostics: [],
    });
    await writeFile(
      join(directory, 'plan.md'),
      (await readFile(join(directory, 'plan.md'), 'utf8')).replace(
        'Retain checked evidence.',
        'Retain checked evidence, revised after binding.',
      ),
    );
    const changed = await createHqSnapshot(runtime, join(root, 'changed'));
    expect(changed).toMatchObject({ planCount: 1, diagnosticPlanCount: 1, changedPlanCount: 1 });
    const record = (await readManifest(changed.directory))[3]!;
    expect(record).toMatchObject({ recordedRevisions: [revision], diagnostics: ['plan-changed'] });
    expect(record.revision).not.toStrictEqual(revision);
    expect(await inspectHqSnapshot(changed.directory)).toStrictEqual(changed);
    // the restored binding, and whether the recovered runtime still reports the plan approved
    const recover = async (snapshotDirectory: string, destination: string) => {
      const restored = await restoreHqSnapshot({ snapshotDirectory, destination });
      const db = new DatabaseSync(join(restored.stateRoot, 'hq.sqlite'), { readOnly: true });
      let binding: { authorizationId: unknown; scope: unknown };
      try {
        const row = db
          .prepare('SELECT authorization_id, context FROM hq_thread_plan WHERE thread_id = ?')
          .get(threadId);
        binding = {
          authorizationId: row?.authorization_id,
          scope: JSON.parse(String(row?.context)).scope,
        };
      } finally {
        db.close();
      }
      const reopened = await createAgentHq({
        stateRoot: restored.stateRoot,
        allowedRoots: [restored.recoveryRoot],
      });
      try {
        const recovered = await reopened.request({
          kind: 'plan',
          command: {
            kind: 'status',
            target: { directory: join(restored.recoveryRoot, hashValue(directory)) },
          },
        });
        if (recovered.kind !== 'plan' || recovered.result.kind !== 'status')
          throw new Error('Missing recovered plan');
        return { ...binding, isPlanApproved: recovered.result.result.isPlanApproved };
      } finally {
        await reopened.close();
      }
    };
    expect(await recover(changed.directory, join(root, 'changed-recovery'))).toStrictEqual({
      authorizationId: null,
      scope: null,
      isPlanApproved: false,
    });
    expect(await recover(current.directory, join(root, 'current-recovery'))).toMatchObject({
      authorizationId,
      scope: { kind: 'execution', authorizationId },
      isPlanApproved: true,
    });
  });
});
