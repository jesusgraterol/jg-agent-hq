import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashValue } from 'jg-crypto';
import { expectToRejectCode } from 'jg-exception/testing';
import { createAgentHq } from 'jg-agent-hq';
import { expect, test } from 'vitest';

import { withClaudeRuntime, type IClaudeFixture } from '../../../scripts/test-support/index.js';

const KNOWN_HASH = 'dd49fcd16db9c8f5431b24f63e7f1e0163dbc32e21a763246d249c6387622be1';

// immutable predecessor SQL establishes the migration input independently of the new generator
const makeLegacy = async (fixture: IClaudeFixture, version = '13.0.0') => {
  await fixture.runtime.close();
  const sql = await readFile(new URL('./upgrade.fixture.sql', import.meta.url), 'utf8');
  expect(hashValue(sql)).toBe(KNOWN_HASH);
  const key = await readFile(join(fixture.stateRoot, 'action.key'));
  const filename = fixture.runtime.storage.databasePath;
  await rm(filename);
  await writeFile(filename, '', { flag: 'wx', mode: 0o600 });
  const database = new DatabaseSync(filename, { enableForeignKeyConstraints: true });
  const actionId = randomUUID();
  const threadId = randomUUID();
  try {
    database.exec(sql);
    database
      .prepare('INSERT INTO agent_hq_schema VALUES (1, ?, ?, ?)')
      .run(KNOWN_HASH, hashValue(key), version);
    database.exec('BEGIN; PRAGMA defer_foreign_keys = ON');
    database
      .prepare(
        "INSERT INTO agent_hq_action (id, digest, requested_runtime_epoch, runtime_epoch, kind, provider, thread_id, phase, delivery, created_at, updated_at) VALUES (?, ?, ?, ?, 'thread-create', 'codex', ?, 'name', 'acknowledged', 1, 1)",
      )
      .run(
        actionId,
        '0'.repeat(64),
        fixture.runtime.runtimeEpoch,
        fixture.runtime.runtimeEpoch,
        threadId,
      );
    database
      .prepare(
        "INSERT INTO agent_hq_thread (id, provider, native_id, name, workspace_root, ownership, state, registration_action_id, created_at, updated_at) VALUES (?, 'codex', 'legacy-native', 'legacy-chat', ?, 'managed', 'inactive', ?, 1, 1)",
      )
      .run(threadId, fixture.workspaceRoot, actionId);
    database.exec(
      'COMMIT; PRAGMA user_version = 3; CREATE TABLE hq_note(id INTEGER PRIMARY KEY, snapshot TEXT NOT NULL) STRICT',
    );
    database
      .prepare('INSERT INTO hq_note VALUES (1, ?)')
      .run('{"naming":{"state":"attempted"},"claim":"keep"}');
    database.exec('CREATE INDEX host_action_index ON agent_hq_action(updated_at, id)');
  } finally {
    database.close();
  }
  return { filename, key, actionId, threadId };
};

test.each(['12.0.1', '13.0.0'])(
  'populated %s storage upgrades once without changing host state, keys, or identities',
  async (version) => {
    await withClaudeRuntime(async (fixture) => {
      const legacy = await makeLegacy(fixture, version);
      let runtime = await createAgentHq({
        stateRoot: fixture.stateRoot,
        allowedRoots: [fixture.workspaceRoot],
      });
      try {
        const thread = (
          await runtime.request({ kind: 'managed-thread', threadId: legacy.threadId })
        ).result;
        expect(thread).toMatchObject({
          id: legacy.threadId,
          nativeId: 'legacy-native',
          name: 'legacy-chat',
          workspaceRoot: fixture.workspaceRoot,
        });
        expect(
          (await runtime.request({ kind: 'receipt', actionId: legacy.actionId })).result,
        ).toMatchObject({ id: legacy.actionId, delivery: 'acknowledged' });
        const database = new DatabaseSync(legacy.filename, { enableForeignKeyConstraints: true });
        try {
          expect(database.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
          expect(database.prepare('SELECT snapshot FROM hq_note').get()?.snapshot).toBe(
            '{"naming":{"state":"attempted"},"claim":"keep"}',
          );
          expect(
            database.prepare('SELECT schema_hash FROM agent_hq_schema').get()?.schema_hash,
          ).toBe(runtime.storage.schemaHash);
          expect(
            database.prepare('SELECT count(*) AS count FROM agent_hq_workspace_transition').get()
              ?.count,
          ).toBe(0);
          expect(
            database
              .prepare("SELECT 1 AS found FROM sqlite_schema WHERE name = 'host_action_index'")
              .get()?.found,
          ).toBe(1);
          expect(database.prepare('PRAGMA foreign_key_check').all()).toStrictEqual([]);
          expect(database.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
        } finally {
          database.close();
        }
        expect(await readFile(join(fixture.stateRoot, 'action.key'))).toStrictEqual(legacy.key);
        const schemaHash = runtime.storage.schemaHash;
        await runtime.close();
        runtime = await createAgentHq({
          stateRoot: fixture.stateRoot,
          allowedRoots: [fixture.workspaceRoot],
        });
        expect(runtime.storage.schemaHash).toBe(schemaHash);
        const away = join(fixture.workspaceRoot, 'part-b');
        await mkdir(away);
        const created = await runtime.request({
          kind: 'action',
          action: {
            id: randomUUID(),
            runtimeEpoch: runtime.runtimeEpoch,
            command: {
              kind: 'thread-create',
              provider: 'codex',
              workspaceRoot: fixture.workspaceRoot,
              name: 'upgraded-workspace',
            },
          },
        });
        await expect
          .poll(
            async () =>
              (await runtime.request({ kind: 'receipt', actionId: created.result.id })).result
                ?.delivery,
          )
          .toBe('acknowledged');
        const moved = await runtime.request({
          kind: 'action',
          action: {
            id: randomUUID(),
            runtimeEpoch: runtime.runtimeEpoch,
            command: {
              kind: 'message',
              threadId: created.result.threadId!,
              input: { kind: 'text', text: 'Continue through the upgraded schema' },
              workspaceChange: {
                expectedWorkspaceRoot: fixture.workspaceRoot,
                workspaceRoot: away,
              },
            },
          },
        });
        await expect
          .poll(
            async () =>
              (await runtime.request({ kind: 'receipt', actionId: moved.result.id })).result
                ?.workspaceTransition?.state,
          )
          .toBe('confirmed');
        await expect
          .poll(
            async () =>
              (await runtime.request({ kind: 'receipt', actionId: moved.result.id })).result
                ?.completion,
          )
          .toBe('completed');
        await runtime.createSnapshot(join(fixture.root, 'upgraded-snapshot'));
      } finally {
        await runtime.close();
      }
    });
  },
);

test.each([
  [
    'stamp',
    "CREATE TRIGGER refuse_stamp BEFORE UPDATE ON agent_hq_schema BEGIN SELECT RAISE(ABORT, 'stamp failure'); END",
  ],
  ['journal', 'CREATE TABLE agent_hq_workspace_transition(conflict TEXT)'],
  [
    'foreign-key',
    "PRAGMA foreign_keys = OFF; CREATE TABLE host_reference(id TEXT REFERENCES agent_hq_action(id)); INSERT INTO host_reference VALUES ('missing')",
  ],
])(
  'a %s failure rolls every upgrade effect back and leaves the old schema usable',
  async (_failure, setup) => {
    await withClaudeRuntime(async (fixture) => {
      const legacy = await makeLegacy(fixture);
      const before = new DatabaseSync(legacy.filename);
      let tables;
      try {
        before.exec(setup);
        tables = before
          .prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY type, name')
          .all();
      } finally {
        before.close();
      }
      await expectToRejectCode(
        createAgentHq({ stateRoot: fixture.stateRoot, allowedRoots: [fixture.workspaceRoot] }),
        'JG_AGENT_HQ_STORAGE_INVALID',
      );
      const after = new DatabaseSync(legacy.filename);
      try {
        expect(
          after.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY type, name').all(),
        ).toStrictEqual(tables);
        expect(after.prepare('SELECT schema_hash FROM agent_hq_schema').get()?.schema_hash).toBe(
          KNOWN_HASH,
        );
        expect(
          after.prepare('SELECT native_id FROM agent_hq_thread WHERE id = ?').get(legacy.threadId)
            ?.native_id,
        ).toBe('legacy-native');
        expect(after.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
      } finally {
        after.close();
      }
      expect(await readFile(join(fixture.stateRoot, 'action.key'))).toStrictEqual(legacy.key);
    });
  },
);

test.each(['unknown-schema', 'wrong-key'])(
  '%s refuses before adopting or upgrading storage',
  async (failure) => {
    await withClaudeRuntime(async (fixture) => {
      const legacy = await makeLegacy(fixture);
      const database = new DatabaseSync(legacy.filename);
      try {
        database
          .prepare(
            failure === 'unknown-schema'
              ? 'UPDATE agent_hq_schema SET schema_hash = ?'
              : 'UPDATE agent_hq_schema SET action_key_hash = ?',
          )
          .run('f'.repeat(64));
      } finally {
        database.close();
      }
      await expectToRejectCode(
        createAgentHq({ stateRoot: fixture.stateRoot, allowedRoots: [fixture.workspaceRoot] }),
        failure === 'wrong-key'
          ? 'JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE'
          : 'JG_AGENT_HQ_STORAGE_INVALID',
      );
      const after = new DatabaseSync(legacy.filename);
      try {
        expect(
          after
            .prepare('PRAGMA table_xinfo(agent_hq_action)')
            .all()
            .some((column) => column.name === 'deleted_native_id'),
        ).toBe(false);
        expect(
          after
            .prepare("SELECT 1 FROM sqlite_schema WHERE name = 'agent_hq_workspace_transition'")
            .get(),
        ).toBeUndefined();
      } finally {
        after.close();
      }
    });
  },
);
