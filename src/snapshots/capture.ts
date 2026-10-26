import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashValue } from 'jg-crypto';
import { hasErrorCode } from 'jg-exception';
import { writePrivateFile } from 'jg-fs';
import { withPlanDocumentLocks } from 'jg-plans';
import { z } from 'zod';

import { isWithinWorkspace } from '../runtime/state/index.js';
import { PACKAGE_VERSION } from '../storage/schema/index.js';

import { observeSnapshotPlan, readRecordedRevisions } from './artifacts.js';
import {
  SNAPSHOT_COMPLETE,
  SNAPSHOT_COMPANIONS,
  SNAPSHOT_LINE_BYTES,
  SNAPSHOT_MANIFEST,
} from './constants.js';
import {
  copySnapshotFile,
  invalidSnapshot,
  reserveSnapshotDirectory,
  syncSnapshotDirectory,
} from './files.js';
import {
  SnapshotHeaderSchema,
  SnapshotRecordSchema,
  type ISnapshotPlan,
  type ISnapshotRecord,
  type ISnapshotSource,
  type IHqSnapshotInspection,
} from './types.js';

/**
 * Copies one plan under its shared document locks; corrupt or missing source evidence stays explicit.
 * @returns One fixed-size inventory record, with no repaired or invented authority.
 * @throws
 * - JG_PLANS_LOCK_BUSY: The plan document is locked
 * - JG_PLANS_LOCK_FAILED: The plan document lock operation failed
 * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
 * - JG_AGENT_HQ_SNAPSHOT_FAILED: The HQ snapshot operation failed
 */
const capturePlan = async (
  context: ISnapshotSource,
  directory: string,
  snapshot: string,
  database: DatabaseSync,
): Promise<ISnapshotPlan> => {
  const record: ISnapshotPlan = {
    kind: 'plan',
    key: hashValue(directory),
    sourceDirectory: directory,
    planId: null,
    revision: null,
    recordedRevisions: [],
    plan: null,
    milestones: null,
    coordination: null,
    diagnostics: [],
  };
  if (!context.allowedRoots.some((root) => isWithinWorkspace(root, directory))) {
    record.diagnostics.push('plan-unavailable');
    return record;
  }
  let exists = true;
  try {
    if ((await realpath(directory)) !== directory || !(await lstat(directory)).isDirectory())
      invalidSnapshot();
  } catch (cause) {
    if (hasErrorCode(cause, 'ENOENT')) exists = false;
    else throw cause;
  }
  const output = join(snapshot, 'plans', record.key);
  await mkdir(output, { mode: 0o700 });
  if (exists)
    await withPlanDocumentLocks(directory, ['plan', 'milestones'], async () => {
      for (const [field, filename, maximumBytes] of SNAPSHOT_COMPANIONS)
        record[field] = await copySnapshotFile(
          join(directory, filename),
          join(output, filename),
          maximumBytes,
          false,
          true,
        );
    });
  Object.assign(
    record,
    await observeSnapshotPlan(output, record, readRecordedRevisions(database, directory)),
  );
  await syncSnapshotDirectory(output);
  return record;
};

/**
 * Streams the shared format-1 capture and verifies it before transferring destination ownership.
 * The caller holds the coordination metadata lock; native work continues during the database
 * backup, and each plan is copied under its own document locks. No full inventory is retained.
 * @returns The fully verified snapshot, retained by the caller after this resolves.
 * @throws
 * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
 * - JG_PLANS_LOCK_BUSY: The plan document is locked
 * - JG_PLANS_LOCK_FAILED: The plan document lock operation failed
 * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
 * - JG_AGENT_HQ_SNAPSHOT_FAILED: The HQ snapshot operation failed
 * - JG_AGENT_HQ_STORAGE_INVALID: The HQ storage is invalid
 */
export const captureSnapshot = async (
  context: ISnapshotSource,
  destination: string,
): Promise<IHqSnapshotInspection> => {
  let owned: string | undefined;
  try {
    owned = await reserveSnapshotDirectory(destination);
    await mkdir(join(owned, 'plans'), { mode: 0o700 });
    const manifest = await open(join(owned, SNAPSHOT_MANIFEST), 'wx', 0o600);
    const hash = createHash('sha256');
    let records = 0;
    const append = async (record: ISnapshotRecord) => {
      const bytes = Buffer.from(JSON.stringify(SnapshotRecordSchema.parse(record)) + '\n');
      if (bytes.length > SNAPSHOT_LINE_BYTES) invalidSnapshot();
      await manifest.writeFile(bytes);
      hash.update(bytes);
      records++;
    };
    try {
      await append(
        SnapshotHeaderSchema.parse({
          kind: 'header',
          format: 1,
          createdAt: new Date().toISOString(),
          schemaHash: context.schemaHash,
          packageVersion: PACKAGE_VERSION,
          sourceStateRoot: context.stateRoot,
          sourceCoordinationRoot: context.coordinationRoot,
          sourceAllowedRoots: context.allowedRoots,
        }),
      );
      const database = await open(join(owned, 'hq.sqlite'), 'wx', 0o600);
      await database.close();
      await context.backupDatabase(join(owned, 'hq.sqlite'));
      const capturedDatabase = await copySnapshotFile(join(owned, 'hq.sqlite'), null);
      if (!capturedDatabase) invalidSnapshot();
      await append({ kind: 'database', file: capturedDatabase });
      const key = await copySnapshotFile(
        join(context.stateRoot, 'action.key'),
        join(owned, 'action.key'),
        32,
      );
      if (key?.bytes !== 32 || key.sha256 !== context.actionKeyHash) invalidSnapshot();
      await append({ kind: 'action-key', file: key });
      // plans registered after the backup belong to the next capture, so page the captured copy
      const captured = new DatabaseSync(join(owned, 'hq.sqlite'), { readOnly: true });
      try {
        let after = '';
        for (;;) {
          const page = captured
            .prepare(
              'SELECT directory FROM hq_plan_registration WHERE directory > ? ORDER BY directory LIMIT 128',
            )
            .all(after)
            .map((row) => z.string().parse(row.directory));
          for (const directory of page) {
            await append(await capturePlan(context, directory, owned, captured));
            after = directory;
          }
          if (page.length < 128) break;
        }
      } finally {
        captured.close();
      }
      await manifest.sync();
      await syncSnapshotDirectory(join(owned, 'plans'));
      await writePrivateFile(
        join(owned, SNAPSHOT_COMPLETE),
        JSON.stringify({ manifestSha256: hash.digest('hex'), records }) + '\n',
        { rootPath: owned, isExclusive: true },
      );
      await syncSnapshotDirectory(owned);
      await syncSnapshotDirectory(dirname(owned));
    } finally {
      await manifest.close();
    }
    return await context.verify(owned);
  } catch (cause) {
    if (owned) {
      try {
        await rm(owned, { recursive: true });
        await syncSnapshotDirectory(dirname(owned));
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], 'Snapshot cleanup failed');
      }
    }
    throw cause;
  }
};
