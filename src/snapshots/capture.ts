import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writePrivateFile } from 'jg-fs';

import { PACKAGE_VERSION } from '../storage/schema/index.js';

import { SNAPSHOT_COMPLETE, SNAPSHOT_LINE_BYTES, SNAPSHOT_MANIFEST } from './constants.js';
import {
  copySnapshotFile,
  invalidSnapshot,
  reserveSnapshotDirectory,
  syncSnapshotDirectory,
} from './files.js';
import {
  SnapshotHeaderSchema,
  SnapshotRecordSchema,
  type ISnapshotRecord,
  type ISnapshotSource,
  type IHqSnapshotInspection,
} from './types.js';

/**
 * Writes the format-1 capture and verifies it before transferring destination ownership.
 * The caller holds the state root's HQ lock; native work continues during the database backup.
 * @returns The fully verified snapshot, retained by the caller after this resolves.
 * @throws
 * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
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
      await manifest.sync();
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
