// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expectToRejectCode } from 'jg-exception/testing';
import { expect, test } from 'vitest';

import { withClaudeRuntime } from '../scripts/test-support/index.js';
import { controlSession } from './control-session.ts';
import { shareStorage } from './shared-storage.ts';

test('the shared-storage source preserves host schema ownership and verifies an offline restore', async () => {
  await withClaudeRuntime(async (fixture) => {
    const host = new DatabaseSync(fixture.runtime.storage.databasePath);
    try {
      host.exec('PRAGMA user_version = 37');
    } finally {
      host.close();
    }
    const schemaHash = fixture.runtime.storage.schemaHash;
    for (const [index, label] of ['Host preference. 🙂', 'Changed host preference.'].entries()) {
      const result = await shareStorage({
        hq: fixture.runtime,
        label,
        snapshotDirectory: join(fixture.root, `snapshot-${index}`),
        recoveryDirectory: join(fixture.root, `recovery-${index}`),
      });
      expect(result.label).toBe(label);
      expect(result.snapshot.header.schemaHash).toBe(schemaHash);
      const recovered = new DatabaseSync(join(result.restored.stateRoot, 'hq.sqlite'), {
        readOnly: true,
      });
      try {
        expect(recovered.prepare('SELECT count(*) AS count FROM app_preference').get()?.count).toBe(
          1,
        );
        expect(recovered.prepare('PRAGMA user_version').get()?.user_version).toBe(37);
      } finally {
        recovered.close();
      }
    }
    expect(await fixture.request({ kind: 'status' })).toMatchObject({
      kind: 'status',
      result: { providers: [{ state: 'idle' }, { state: 'idle' }] },
    });
  });
});

test('the shared-storage source preserves an occupied target and its already committed preference', async () => {
  await withClaudeRuntime(async (fixture) => {
    const snapshotDirectory = join(fixture.root, 'occupied');
    await mkdir(snapshotDirectory);
    await writeFile(join(snapshotDirectory, 'marker.txt'), 'Keep this directory.');
    await expectToRejectCode(
      shareStorage({
        hq: fixture.runtime,
        label: 'Committed before capture.',
        snapshotDirectory,
        recoveryDirectory: join(fixture.root, 'recovery'),
      }),
      'JG_AGENT_HQ_SNAPSHOT_INVALID',
    );
    expect(await readFile(join(snapshotDirectory, 'marker.txt'), 'utf8')).toBe(
      'Keep this directory.',
    );
    await fixture.runtime.withStorageMaintenance(async (storage) => {
      const host = new DatabaseSync(storage.databasePath);
      try {
        expect(host.prepare('SELECT label FROM app_preference WHERE id = 1').get()?.label).toBe(
          'Committed before capture.',
        );
      } finally {
        host.close();
      }
    });
  });
});

test.each(['codex', 'claude'] as const)(
  'the control-session source operates the real %s controller and IPC',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const ids = { create: randomUUID(), message: randomUUID() };
      const result = await controlSession({
        stateRoot: fixture.stateRoot,
        workspaceRoot: fixture.workspaceRoot,
        provider,
        name: 'example-session',
        text: 'Discuss the selected task without changing files.',
        actionIds: ids,
      });
      expect(result.thread.provider).toBe(provider);
      expect(result.receipt.id).toBe(ids.message);
      expect(result.receipt.threadId).toBe(result.thread.id);
      expect(result.receipt.delivery).toBe('acknowledged');
      const latest = await fixture.request({ kind: 'receipt', actionId: ids.message });
      expect(latest).toMatchObject({
        kind: 'receipt',
        result: {
          id: result.receipt.id,
          digest: result.receipt.digest,
          threadId: result.thread.id,
          delivery: 'acknowledged',
        },
      });
      if (latest.kind !== 'receipt' || !latest.result) throw new Error('Missing current receipt');
      expect(latest.result.updatedAt).toBeGreaterThanOrEqual(result.receipt.updatedAt);
      if (result.receipt.completion === 'completed')
        expect(latest.result.completion).toBe('completed');
      expect(result.usage).toMatchObject({ provider, source: 'native' });
      expect(result.approvals).toStrictEqual([]);
    });
  },
);
