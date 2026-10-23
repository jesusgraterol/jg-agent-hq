import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashValue } from 'jg-crypto';
import { Exception, hasErrorCode, isException, extractMessage } from 'jg-exception';
import { readPrivateFile, writePrivateFile } from 'jg-fs';
import { z } from 'zod';

import { isWithinWorkspace } from '../runtime/state/index.js';
import { StorageStampSchema } from '../storage/index.js';

import { observeSnapshotPlan } from './artifacts.js';
import { SNAPSHOT_COMPLETE, SNAPSHOT_COMPANIONS, SNAPSHOT_MANIFEST } from './constants.js';
import {
  copySnapshotFile,
  invalidSnapshot,
  readSnapshotRecords,
  reserveSnapshotDirectory,
  syncSnapshotDirectory,
} from './files.js';
import {
  SnapshotCompletionSchema,
  type IHqSnapshotInspection,
  type ISnapshotFile,
  type ISnapshotHeader,
} from './types.js';

/**
 * Checks exact artifacts and the complete database in a dedicated offline worker.
 * Memory stays bounded by one manifest line, one plan page and one report payload.
 * @returns Validated metadata without loading the growing inventory into the caller.
 * @throws
 * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
 */
export const verifySnapshot = async (directory: string): Promise<IHqSnapshotInspection> => {
  let database: DatabaseSync | undefined;
  try {
    const completion = SnapshotCompletionSchema.parse(
      JSON.parse(
        (
          await readPrivateFile(join(directory, SNAPSHOT_COMPLETE), {
            maxBytes: 4096,
            rootPath: directory,
          })
        ).toString('utf8'),
      ),
    );
    const schemaHash = hashValue(
      await readFile(new URL('../store/schema.sql', import.meta.url), 'utf8'),
    );
    const hash = createHash('sha256');
    let records = 0;
    let header: ISnapshotHeader | undefined;
    let actionKeyHash: string | undefined;
    let planCount = 0;
    let diagnosticPlanCount = 0;
    let after = '';
    let page: string[] = [];
    let offset = 0;
    const check = async (
      filename: string,
      expected: ISnapshotFile,
      maximumBytes = Number.MAX_SAFE_INTEGER,
    ) => {
      const observed = await copySnapshotFile(join(directory, filename), null, maximumBytes);
      if (observed?.bytes !== expected.bytes || observed.sha256 !== expected.sha256)
        invalidSnapshot();
    };
    for await (const { record, bytes } of readSnapshotRecords(directory)) {
      hash.update(bytes);
      records++;
      if (records === 1) {
        if (record.kind !== 'header' || record.schemaHash !== schemaHash) invalidSnapshot();
        header = record;
        continue;
      }
      if (records === 2) {
        if (record.kind !== 'database') invalidSnapshot();
        await check('hq.sqlite', record.file);
        for (const suffix of ['-wal', '-shm', '-journal']) {
          try {
            await lstat(join(directory, `hq.sqlite${suffix}`));
            invalidSnapshot();
          } catch (cause) {
            if (!hasErrorCode(cause, 'ENOENT')) throw cause;
          }
        }
        database = new DatabaseSync(join(directory, 'hq.sqlite'), {
          readOnly: true,
          enableForeignKeyConstraints: true,
        });
        const stamps = database
          .prepare('SELECT id, schema_hash, action_key_hash FROM hq_schema LIMIT 2')
          .all();
        const stamp = StorageStampSchema.safeParse(stamps.length === 1 ? stamps[0] : null);
        if (!stamp.success || stamp.data.schema_hash !== schemaHash) invalidSnapshot();
        actionKeyHash = stamp.data.action_key_hash;
        const integrity = database.prepare('PRAGMA integrity_check').all();
        if (
          integrity.length !== 1 ||
          integrity[0].integrity_check !== 'ok' ||
          database.prepare('PRAGMA foreign_key_check').get()
        )
          invalidSnapshot();
        for (const report of database
          .prepare('SELECT payload, byte_count, sha256 FROM hq_report')
          .iterate()) {
          if (
            !(report.payload instanceof Uint8Array) ||
            report.byte_count !== report.payload.length ||
            report.payload.length > 1_048_576 ||
            hashValue(report.payload) !== report.sha256
          )
            invalidSnapshot();
        }
        continue;
      }
      if (records === 3) {
        if (
          record.kind !== 'action-key' ||
          record.file.bytes !== 32 ||
          record.file.sha256 !== actionKeyHash
        )
          invalidSnapshot();
        await check('action.key', record.file, 32);
        continue;
      }
      if (record.kind !== 'plan' || !database || !header) invalidSnapshot();
      if (offset === page.length) {
        page = database
          .prepare(
            'SELECT directory FROM hq_plan_registration WHERE directory > ? ORDER BY directory LIMIT 128',
          )
          .all(after)
          .map((row) => z.string().parse(row.directory));
        offset = 0;
      }
      if (
        page[offset++] !== record.sourceDirectory ||
        record.key !== hashValue(record.sourceDirectory)
      )
        invalidSnapshot();
      after = record.sourceDirectory;
      planCount++;
      if (record.diagnostics.length) diagnosticPlanCount++;
      for (const [field, filename, maximumBytes] of SNAPSHOT_COMPANIONS) {
        const selected = join('plans', record.key, filename);
        const expected = record[field];
        if (expected) await check(selected, expected, maximumBytes);
        else {
          try {
            await lstat(join(directory, selected));
            invalidSnapshot();
          } catch (cause) {
            if (!hasErrorCode(cause, 'ENOENT')) throw cause;
          }
        }
      }
      const isAllowed = header.sourceAllowedRoots.some((root) =>
        isWithinWorkspace(root, record.sourceDirectory),
      );
      if (!isAllowed && (record.plan || record.milestones || record.coordination))
        invalidSnapshot();
      const observation = isAllowed
        ? await observeSnapshotPlan(join(directory, 'plans', record.key), record)
        : { planId: null, revision: null, diagnostics: ['plan-unavailable'] };
      if (
        observation.planId !== record.planId ||
        observation.revision !== record.revision ||
        JSON.stringify(observation.diagnostics) !== JSON.stringify(record.diagnostics)
      )
        invalidSnapshot();
    }
    if (
      !header ||
      !database ||
      records < 3 ||
      records !== completion.records ||
      hash.digest('hex') !== completion.manifestSha256 ||
      offset !== page.length ||
      database
        .prepare('SELECT directory FROM hq_plan_registration WHERE directory > ? LIMIT 1')
        .get(after)
    )
      invalidSnapshot();
    const pendingWriteCount = z
      .number()
      .parse(
        database
          .prepare("SELECT count(*) AS count FROM hq_plan_operation WHERE state = 'prepared'")
          .get()?.count,
      );
    return {
      directory,
      manifestSha256: completion.manifestSha256,
      header,
      planCount,
      diagnosticPlanCount,
      pendingWriteCount,
    };
  } catch (cause) {
    if (isException(cause) && cause.code === 'JG_AGENT_HQ_SNAPSHOT_INVALID') throw cause;
    throw new Exception('The HQ snapshot is invalid', {
      code: 'JG_AGENT_HQ_SNAPSHOT_INVALID',
      data: { kind: 'invalid-request' },
      cause,
    });
  } finally {
    database?.close();
  }
};

/**
 * Invalidates current execution authority while retaining immutable receipts, IDs and write intents.
 * Source paths remain evidence and require explicit host root selection on startup.
 */
const pauseRestoredDatabase = (filename: string): void => {
  const database = new DatabaseSync(filename, { enableForeignKeyConstraints: true });
  try {
    database.exec('PRAGMA synchronous = FULL; BEGIN IMMEDIATE');
    try {
      const now = Date.now();
      database
        .prepare(
          "UPDATE hq_collaboration_task SET state = CASE WHEN state = 'stopped' THEN state ELSE 'paused' END, lifecycle_revision = lifecycle_revision + 1, policy_revision = policy_revision + 1, policy = json_set(policy, '$.automaticDispatch', json('false'))",
        )
        .run();
      database
        .prepare(
          "UPDATE hq_task_agent SET state = CASE WHEN state = 'stopped' THEN state ELSE 'paused' END, revision = revision + 1",
        )
        .run();
      database.prepare('UPDATE hq_skill_grant SET revoked_at = COALESCE(revoked_at, ?)').run(now);
      database
        .prepare("UPDATE hq_thread SET ownership = 'uncertain', state = 'unknown', updated_at = ?")
        .run(now);
      database
        .prepare(
          "UPDATE hq_action SET delivery = 'uncertain', updated_at = ? WHERE delivery = 'submitted'",
        )
        .run(now);
      database.exec('UPDATE hq_action SET queue_ready = 0');
      database
        .prepare(
          "UPDATE hq_native_approval SET state = 'expired', updated_at = ? WHERE state = 'pending'",
        )
        .run(now);
      database.exec('COMMIT');
    } catch (cause) {
      database.exec('ROLLBACK');
      throw cause;
    }
  } finally {
    database.close();
  }
};

/**
 * Validates before reserving a new recovery workspace, then validates the staged copy again.
 * Only this operation's exclusively created destination is removed on a caught failure.
 * @returns The source inspection; the caller derives the fixed state/plans output paths.
 * @throws
 * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
 * - JG_AGENT_HQ_SNAPSHOT_FAILED: The HQ snapshot operation failed
 */
export const restoreSnapshot = async (
  directory: string,
  destination: string,
): Promise<IHqSnapshotInspection> => {
  const inspection = await verifySnapshot(directory);
  if (isWithinWorkspace(directory, destination)) invalidSnapshot();
  let owned: string | undefined;
  try {
    owned = await reserveSnapshotDirectory(destination);
    const staging = join(owned, 'staging');
    await mkdir(staging, { mode: 0o700 });
    await mkdir(join(staging, 'plans'), { mode: 0o700 });
    for await (const { record } of readSnapshotRecords(directory)) {
      if (record.kind === 'database' || record.kind === 'action-key') {
        const name = record.kind === 'database' ? 'hq.sqlite' : 'action.key';
        const actual = await copySnapshotFile(join(directory, name), join(staging, name));
        if (actual?.sha256 !== record.file.sha256 || actual.bytes !== record.file.bytes)
          invalidSnapshot();
      } else if (record.kind === 'plan') {
        await mkdir(join(staging, 'plans', record.key), { mode: 0o700 });
        for (const [field, name, maximumBytes] of SNAPSHOT_COMPANIONS)
          if (record[field]) {
            const actual = await copySnapshotFile(
              join(directory, 'plans', record.key, name),
              join(staging, 'plans', record.key, name),
              maximumBytes,
            );
            if (actual?.sha256 !== record[field].sha256 || actual.bytes !== record[field].bytes)
              invalidSnapshot();
          }
        await syncSnapshotDirectory(join(staging, 'plans', record.key));
      }
    }
    for (const name of [SNAPSHOT_MANIFEST, SNAPSHOT_COMPLETE])
      await copySnapshotFile(join(directory, name), join(staging, name));
    const staged = await verifySnapshot(staging);
    if (staged.manifestSha256 !== inspection.manifestSha256) invalidSnapshot();
    // the copied manifest remains source evidence; the recovered database deliberately has new fences
    pauseRestoredDatabase(join(staging, 'hq.sqlite'));
    await mkdir(join(owned, 'state'), { mode: 0o700 });
    for (const name of ['hq.sqlite', 'action.key'])
      await rename(join(staging, name), join(owned, 'state', name));
    await rename(join(staging, 'plans'), join(owned, 'plans'));
    await rename(join(staging, SNAPSHOT_MANIFEST), join(owned, 'recovery.jsonl'));
    await rm(staging, { recursive: true });
    await syncSnapshotDirectory(join(owned, 'state'));
    await syncSnapshotDirectory(join(owned, 'plans'));
    await writePrivateFile(
      join(owned, 'recovered.json'),
      JSON.stringify({
        manifestSha256: inspection.manifestSha256,
        recoveredAt: new Date().toISOString(),
      }) + '\n',
      { rootPath: owned, isExclusive: true },
    );
    await syncSnapshotDirectory(owned);
    await syncSnapshotDirectory(dirname(owned));
    return inspection;
  } catch (cause) {
    if (owned) {
      try {
        await rm(owned, { recursive: true });
        await syncSnapshotDirectory(dirname(owned));
      } catch (cleanup) {
        cause = new AggregateError([cause, cleanup], 'Recovery workspace cleanup failed');
      }
    }
    if (
      hasErrorCode(cause, 'JG_AGENT_HQ_SNAPSHOT_INVALID') ||
      hasErrorCode(cause, 'JG_AGENT_HQ_SNAPSHOT_FAILED')
    )
      throw cause;
    throw new Exception(`The HQ snapshot operation failed: ${extractMessage(cause)}`, {
      code: 'JG_AGENT_HQ_SNAPSHOT_FAILED',
      data: { kind: 'operation-failed' },
      cause,
    });
  }
};
