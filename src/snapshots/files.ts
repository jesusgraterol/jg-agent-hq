import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { assertNoLinksBelow, assertPrivateDirectory } from 'jg-fs';
import { Exception, hasErrorCode } from 'jg-exception';

import { isPrivateOwner } from '../locks/index.js';
import { CURRENT_SCHEMA_HASH, rejectStorage } from '../storage/schema/index.js';

import { SNAPSHOT_COPY_BYTES, SNAPSHOT_LINE_BYTES, SNAPSHOT_MANIFEST } from './constants.js';
import {
  SnapshotRecordSchema,
  SnapshotStampSchema,
  type ISnapshotFile,
  type ISnapshotRecord,
} from './types.js';

/**
 * Rejects invalid snapshot evidence without treating it as an operational success.
 * @throws
 * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
 */
export const invalidSnapshot: () => never = () => {
  throw new Exception('The HQ snapshot is invalid', {
    code: 'JG_AGENT_HQ_SNAPSHOT_INVALID',
    data: { kind: 'invalid-request' },
  });
};

/**
 * Requires an existing canonical parent and exclusively reserves a new private directory.
 * The caller owns cleanup only after this operation resolves.
 * @returns The canonical newly created directory.
 * @throws
 * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
 */
export const reserveSnapshotDirectory = async (selected: string): Promise<string> => {
  if (!isAbsolute(selected) || resolve(selected) !== selected) invalidSnapshot();
  const parent = dirname(selected);
  if ((await realpath(parent)) !== parent) invalidSnapshot();
  await assertNoLinksBelow(parse(selected).root, selected);
  if (!(await lstat(parent)).isDirectory()) invalidSnapshot();
  try {
    await mkdir(selected, { mode: 0o700 });
  } catch (cause) {
    if (hasErrorCode(cause, 'EEXIST')) invalidSnapshot();
    throw cause;
  }
  return selected;
};

/**
 * Opens one regular, singly linked artifact without following symlinks.
 * Public source documents need not be private; snapshot files must be.
 * @returns The checked handle, or null for an explicitly optional missing source.
 * @throws
 * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
 */
export const openSnapshotFile = async (
  filename: string,
  maximumBytes: number,
  isPrivate = true,
  isOptional = false,
): Promise<FileHandle | null> => {
  await assertNoLinksBelow(parse(filename).root, filename);
  let file: FileHandle;
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (cause) {
    if (isOptional && hasErrorCode(cause, 'ENOENT')) return null;
    if (hasErrorCode(cause, 'ENOENT') || hasErrorCode(cause, 'ELOOP')) invalidSnapshot();
    throw cause;
  }
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > maximumBytes ||
      (isPrivate && !isPrivateOwner(info))
    )
      invalidSnapshot();
    return file;
  } catch (cause) {
    await file.close();
    throw cause;
  }
};

/**
 * Copies and hashes incrementally, detecting growth, truncation and replacement during the copy.
 * Exclusive targets stay private from their first byte. No artifact cache is retained.
 * @returns Exact bytes and SHA-256, or null for an optional missing source.
 * @throws
 * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
 * - JG_AGENT_HQ_SNAPSHOT_FAILED: The HQ snapshot operation failed
 */
export const copySnapshotFile = async (
  source: string,
  destination: string | null,
  maximumBytes = Number.MAX_SAFE_INTEGER,
  isPrivate = true,
  isOptional = false,
): Promise<ISnapshotFile | null> => {
  const input = await openSnapshotFile(source, maximumBytes, isPrivate, isOptional);
  if (!input) return null;
  let output: FileHandle | undefined;
  try {
    const before = await input.stat();
    if (destination) output = await open(destination, 'wx', 0o600);
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(SNAPSHOT_COPY_BYTES);
    let bytes = 0;
    for (;;) {
      const read = await input.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > maximumBytes) invalidSnapshot();
      const chunk = buffer.subarray(0, read.bytesRead);
      hash.update(chunk);
      if (output) {
        let written = 0;
        while (written < chunk.length) {
          const result = await output.write(chunk, written, chunk.length - written, null);
          if (!result.bytesWritten)
            throw new Exception('The HQ snapshot operation failed', {
              code: 'JG_AGENT_HQ_SNAPSHOT_FAILED',
              data: { kind: 'operation-failed', reason: 'write-stalled' },
            });
          written += result.bytesWritten;
        }
      }
    }
    const after = await input.stat();
    const current = await lstat(source);
    if (
      bytes !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.isSymbolicLink()
    )
      invalidSnapshot();
    await output?.sync();
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    await output?.close();
    await input.close();
  }
};

/** Flushes fixed-name publication or removal before reporting a durable result. */
export const syncSnapshotDirectory = async (directory: string): Promise<void> => {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/**
 * Streams a bounded-line manifest. The header's schema stamp is checked before its shape, so a
 * snapshot from another schema is refused by the package version that wrote it.
 * @returns Records with exact source bytes, including the required trailing newline.
 * @throws
 * - JG_AGENT_HQ_STORAGE_INVALID: The HQ storage is invalid
 * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
 */
export const readSnapshotRecords = async function* (
  directory: string,
): AsyncGenerator<{ record: ISnapshotRecord; bytes: Buffer }> {
  await assertPrivateDirectory(directory);
  const handle = await openSnapshotFile(
    join(directory, SNAPSHOT_MANIFEST),
    Number.MAX_SAFE_INTEGER,
  );
  if (!handle) invalidSnapshot();
  const buffer = Buffer.alloc(SNAPSHOT_COPY_BYTES);
  let pending = Buffer.alloc(0);
  let isHeader = true;
  try {
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      pending = Buffer.concat([pending, buffer.subarray(0, read.bytesRead)]);
      let end: number;
      while ((end = pending.indexOf(10)) !== -1) {
        if (end >= SNAPSHOT_LINE_BYTES) invalidSnapshot();
        const bytes = pending.subarray(0, end + 1);
        pending = pending.subarray(end + 1);
        let line: unknown;
        try {
          line = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch {
          invalidSnapshot();
        }
        if (isHeader) {
          const stamp = SnapshotStampSchema.safeParse(line);
          if (stamp.success && stamp.data.schemaHash !== CURRENT_SCHEMA_HASH)
            rejectStorage(stamp.data.packageVersion);
          isHeader = false;
        }
        const parsed = SnapshotRecordSchema.safeParse(line);
        if (!parsed.success) invalidSnapshot();
        yield { record: parsed.data, bytes };
      }
      if (pending.length >= SNAPSHOT_LINE_BYTES) invalidSnapshot();
    }
    if (pending.length) invalidSnapshot();
  } finally {
    await handle.close();
  }
};
