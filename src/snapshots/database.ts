import { createHash } from 'node:crypto';
import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Exception, hasErrorCode, isException, extractMessage } from 'jg-exception';
import { readPrivateFile, writePrivateFile } from 'jg-fs';

import { isWithinWorkspace } from '../runtime/state/index.js';
import { readStorageStamp } from '../storage/schema/index.js';

import { applyRestoreFences } from './fences.js';
import { SNAPSHOT_COMPLETE, SNAPSHOT_MANIFEST } from './constants.js';
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
 * @returns Validated metadata.
 * @throws
 * - JG_AGENT_HQ_STORAGE_INVALID: The HQ storage is invalid
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
    const hash = createHash('sha256');
    let records = 0;
    let header: ISnapshotHeader | undefined;
    let actionKeyHash: string | undefined;
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
        if (record.kind !== 'header') invalidSnapshot();
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
        const recognized = readStorageStamp(database);
        if (!recognized) invalidSnapshot();
        actionKeyHash = recognized.actionKeyHash;
        const integrity = database.prepare('PRAGMA integrity_check').all();
        if (
          integrity.length !== 1 ||
          integrity[0].integrity_check !== 'ok' ||
          database.prepare('PRAGMA foreign_key_check').get()
        )
          invalidSnapshot();
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
      invalidSnapshot();
    }
    if (
      !header ||
      !database ||
      records !== 3 ||
      records !== completion.records ||
      hash.digest('hex') !== completion.manifestSha256
    )
      invalidSnapshot();
    return { directory, manifestSha256: completion.manifestSha256, header };
  } catch (cause) {
    if (
      isException(cause) &&
      ['JG_AGENT_HQ_SNAPSHOT_INVALID', 'JG_AGENT_HQ_STORAGE_INVALID'].includes(cause.code)
    )
      throw cause;
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
 * Validates before reserving a new recovery workspace, then validates the staged copy again.
 * Only this operation's exclusively created destination is removed on a caught failure.
 * @returns The source inspection; the caller derives the fixed state output path.
 * @throws
 * - JG_AGENT_HQ_STORAGE_INVALID: The HQ storage is invalid
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
    for await (const { record } of readSnapshotRecords(directory)) {
      if (record.kind === 'database' || record.kind === 'action-key') {
        const name = record.kind === 'database' ? 'hq.sqlite' : 'action.key';
        const actual = await copySnapshotFile(join(directory, name), join(staging, name));
        if (actual?.sha256 !== record.file.sha256 || actual.bytes !== record.file.bytes)
          invalidSnapshot();
      }
    }
    for (const name of [SNAPSHOT_MANIFEST, SNAPSHOT_COMPLETE])
      await copySnapshotFile(join(directory, name), join(staging, name));
    const staged = await verifySnapshot(staging);
    if (staged.manifestSha256 !== inspection.manifestSha256) invalidSnapshot();
    // the copied manifest remains source evidence; the recovered database deliberately has new fences
    applyRestoreFences(join(staging, 'hq.sqlite'));
    await mkdir(join(owned, 'state'), { mode: 0o700 });
    for (const name of ['hq.sqlite', 'action.key'])
      await rename(join(staging, name), join(owned, 'state', name));
    await rename(join(staging, SNAPSHOT_MANIFEST), join(owned, 'recovery.jsonl'));
    await rm(staging, { recursive: true });
    await syncSnapshotDirectory(join(owned, 'state'));
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
      hasErrorCode(cause, 'JG_AGENT_HQ_SNAPSHOT_FAILED') ||
      hasErrorCode(cause, 'JG_AGENT_HQ_STORAGE_INVALID')
    )
      throw cause;
    throw new Exception(`The HQ snapshot operation failed: ${extractMessage(cause)}`, {
      code: 'JG_AGENT_HQ_SNAPSHOT_FAILED',
      data: { kind: 'operation-failed' },
      cause,
    });
  }
};
