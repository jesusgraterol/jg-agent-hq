import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdtemp, open, realpath, rm, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Exception, extractMessage, hasErrorCode, isException } from 'jg-exception';

import { SNAPSHOT_COMPLETE, SNAPSHOT_COPY_BYTES, SNAPSHOT_MANIFEST } from '../constants.js';
import {
  invalidSnapshot,
  openSnapshotFile,
  readSnapshotRecords,
  reserveSnapshotDirectory,
  syncSnapshotDirectory,
} from '../files.js';
import { inspectHqSnapshot } from '../snapshots.js';
import type { IHqSnapshotInspection } from '../types.js';

import {
  ARCHIVE_FORMAT,
  ARCHIVE_IV_BYTES,
  ARCHIVE_KEY_BYTES,
  ARCHIVE_PATH_BYTES,
  ARCHIVE_TAG_BYTES,
} from './constants.js';

/**
 * Requires a 32-byte key and an absolute, normalized path beneath an existing canonical parent.
 * @throws
 * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
 */
const checkInputs = async (path: string, key: Buffer): Promise<void> => {
  if (!Buffer.isBuffer(key) || key.length !== ARCHIVE_KEY_BYTES) invalidSnapshot();
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) invalidSnapshot();
  if ((await realpath(dirname(path))) !== dirname(path)) invalidSnapshot();
};

/**
 * Keeps snapshot classifications and reports any other failure, including a failed cleanup,
 * as an operational one.
 * @returns The original or translated error for the caller to throw.
 */
const classify = (cause: unknown): unknown =>
  isException(cause) &&
  ['JG_AGENT_HQ_SNAPSHOT_INVALID', 'JG_AGENT_HQ_STORAGE_INVALID'].includes(cause.code)
    ? cause
    : new Exception(`The HQ snapshot operation failed: ${extractMessage(cause)}`, {
        code: 'JG_AGENT_HQ_SNAPSHOT_FAILED',
        data: { kind: 'operation-failed' },
        cause,
      });

/** Encodes one entry header: the path length, the UTF-8 path and the content length. */
const encodeHeader = (path: string, bytes: number): Buffer => {
  const name = Buffer.from(path, 'utf8');
  const header = Buffer.alloc(2 + name.length + 8);
  header.writeUInt16BE(name.length, 0);
  name.copy(header, 2);
  header.writeBigUInt64BE(BigInt(bytes), 2 + name.length);
  return header;
};

/**
 * Streams each snapshot file in manifest order behind its header, reading exactly its size.
 * @returns Plaintext chunks for the cipher.
 * @throws
 * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
 */
const readEntries = async function* (directory: string): AsyncGenerator<Buffer> {
  const entry = async function* (path: string, maximumBytes: number): AsyncGenerator<Buffer> {
    const file = await openSnapshotFile(join(directory, path), maximumBytes);
    if (!file) invalidSnapshot();
    try {
      const { size } = await file.stat();
      yield encodeHeader(path, size);
      let remaining = size;
      while (remaining) {
        const chunk = Buffer.alloc(Math.min(SNAPSHOT_COPY_BYTES, remaining));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
        if (!bytesRead) invalidSnapshot();
        remaining -= bytesRead;
        yield chunk.subarray(0, bytesRead);
      }
    } finally {
      await file.close();
    }
  };
  yield* entry(SNAPSHOT_MANIFEST, Number.MAX_SAFE_INTEGER);
  yield* entry(SNAPSHOT_COMPLETE, 4096);
  for await (const { record } of readSnapshotRecords(directory)) {
    if (record.kind === 'database') yield* entry('hq.sqlite', record.file.bytes);
    else if (record.kind === 'action-key') yield* entry('action.key', ARCHIVE_KEY_BYTES);
  }
};

/**
 * Encrypts a verified snapshot into one new private file with AES-256-GCM: a format identifier,
 * a fresh 12-byte IV, the ciphertext of every snapshot file in manifest order with its path and
 * length, and the authentication tag. The caller keeps the 32-byte key.
 * @param snapshotDirectory A snapshot from createHqSnapshot.
 * @param archivePath An absent absolute path beneath an existing canonical parent.
 * @param key The 32-byte encryption key.
 * @returns The inspection of the snapshot that was packed.
 * @throws
 * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
 * - JG_AGENT_HQ_SNAPSHOT_FAILED: The HQ snapshot operation failed
 * - JG_AGENT_HQ_STORAGE_INVALID: The HQ storage is invalid
 */
export const packHqSnapshot = async (
  snapshotDirectory: string,
  archivePath: string,
  key: Buffer,
): Promise<IHqSnapshotInspection> => {
  let isCreated = false;
  try {
    await checkInputs(archivePath, key);
    const inspection = await inspectHqSnapshot(snapshotDirectory);
    let archive: FileHandle;
    try {
      archive = await open(archivePath, 'wx', 0o600);
    } catch (cause) {
      if (hasErrorCode(cause, 'EEXIST')) invalidSnapshot();
      throw cause;
    }
    isCreated = true;
    const iv = randomBytes(ARCHIVE_IV_BYTES);
    const prefix = Buffer.concat([ARCHIVE_FORMAT, iv]);
    try {
      await archive.write(prefix, 0, prefix.length, 0);
    } finally {
      await archive.close();
    }
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    await pipeline(
      readEntries(snapshotDirectory),
      cipher,
      createWriteStream(archivePath, { flags: 'r+', start: prefix.length }),
    );
    const tag = cipher.getAuthTag();
    const completed = await open(archivePath, 'r+');
    try {
      await completed.write(tag, 0, tag.length, (await completed.stat()).size);
      await completed.sync();
    } finally {
      await completed.close();
    }
    await syncSnapshotDirectory(dirname(archivePath));
    return inspection;
  } catch (cause) {
    let failure = cause;
    if (isCreated)
      try {
        await rm(archivePath, { force: true });
      } catch (cleanup) {
        failure = new AggregateError([cause, cleanup], 'Snapshot cleanup failed');
      }
    throw classify(failure);
  }
};

/**
 * Decrypts the whole archive into a private plaintext file and verifies its tag before any of
 * its bytes are trusted.
 * @throws
 * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
 */
const decryptArchive = async (archivePath: string, output: string, key: Buffer): Promise<void> => {
  const archive = await openSnapshotFile(archivePath, Number.MAX_SAFE_INTEGER, false);
  if (!archive) invalidSnapshot();
  const prefixBytes = ARCHIVE_FORMAT.length + ARCHIVE_IV_BYTES;
  const prefix = Buffer.alloc(prefixBytes);
  const tag = Buffer.alloc(ARCHIVE_TAG_BYTES);
  let size: number;
  try {
    size = (await archive.stat()).size;
    if (size < prefixBytes + ARCHIVE_TAG_BYTES) invalidSnapshot();
    await archive.read(prefix, 0, prefixBytes, 0);
    await archive.read(tag, 0, ARCHIVE_TAG_BYTES, size - ARCHIVE_TAG_BYTES);
  } finally {
    await archive.close();
  }
  if (!prefix.subarray(0, ARCHIVE_FORMAT.length).equals(ARCHIVE_FORMAT)) invalidSnapshot();
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    prefix.subarray(ARCHIVE_FORMAT.length),
  ).setAuthTag(tag);
  try {
    await pipeline(
      createReadStream(archivePath, { start: prefixBytes, end: size - ARCHIVE_TAG_BYTES - 1 }),
      decipher,
      createWriteStream(output, { flags: 'wx', mode: 0o600 }),
    );
  } catch (cause) {
    // filesystem failures stay operational; a wrong key, a modified byte or a truncation fail the tag
    if (cause instanceof Error && 'syscall' in cause) throw cause;
    throw new Exception('The HQ snapshot is invalid', {
      code: 'JG_AGENT_HQ_SNAPSHOT_INVALID',
      data: { kind: 'invalid-request' },
      cause,
    });
  }
  const plaintext = await open(output, 'r');
  try {
    await plaintext.sync();
  } finally {
    await plaintext.close();
  }
};

/**
 * Writes the verified plaintext's entries into the new snapshot directory, accepting only
 * the manifest's listed paths at exactly their listed sizes.
 * @throws
 * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
 */
const writeEntries = async (plaintextPath: string, directory: string): Promise<void> => {
  const input = await open(plaintextPath, 'r');
  try {
    const { size } = await input.stat();
    let position = 0;
    const readExact = async (length: number): Promise<Buffer> => {
      if (position + length > size) invalidSnapshot();
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await input.read(buffer, offset, length - offset, position + offset);
        if (!bytesRead) invalidSnapshot();
        offset += bytesRead;
      }
      position += length;
      return buffer;
    };
    const readHeader = async (): Promise<{ path: string; bytes: number }> => {
      const length = (await readExact(2)).readUInt16BE(0);
      if (!length || length > ARCHIVE_PATH_BYTES) invalidSnapshot();
      let path: string;
      try {
        path = new TextDecoder('utf-8', { fatal: true }).decode(await readExact(length));
      } catch {
        invalidSnapshot();
      }
      const bytes = (await readExact(8)).readBigUInt64BE(0);
      if (bytes > BigInt(size - position)) invalidSnapshot();
      return { path, bytes: Number(bytes) };
    };
    const copy = async (path: string, bytes: number): Promise<void> => {
      const output = await open(join(directory, path), 'wx', 0o600);
      try {
        let remaining = bytes;
        while (remaining) {
          const chunk = await readExact(Math.min(SNAPSHOT_COPY_BYTES, remaining));
          await output.write(chunk, 0, chunk.length, null);
          remaining -= chunk.length;
        }
        await output.sync();
      } finally {
        await output.close();
      }
    };
    const manifest = await readHeader();
    if (manifest.path !== SNAPSHOT_MANIFEST) invalidSnapshot();
    await copy(SNAPSHOT_MANIFEST, manifest.bytes);
    const completion = await readHeader();
    if (completion.path !== SNAPSHOT_COMPLETE || completion.bytes > 4096) invalidSnapshot();
    await copy(SNAPSHOT_COMPLETE, completion.bytes);
    const listed = new Map<string, number>();
    for await (const { record } of readSnapshotRecords(directory)) {
      if (record.kind === 'database') listed.set('hq.sqlite', record.file.bytes);
      else if (record.kind === 'action-key') listed.set('action.key', record.file.bytes);
    }
    while (position < size) {
      const entry = await readHeader();
      if (listed.get(entry.path) !== entry.bytes) invalidSnapshot();
      listed.delete(entry.path);
      await copy(entry.path, entry.bytes);
    }
    if (listed.size) invalidSnapshot();
    await syncSnapshotDirectory(directory);
  } finally {
    await input.close();
  }
};

/**
 * Restores an archive from packHqSnapshot into a new snapshot directory. The archive is decrypted
 * into a private temporary file and its tag verified before the destination is created; then
 * only manifest-listed paths are written, at their listed sizes, and the result is inspected.
 * @param archivePath The archive to unpack.
 * @param destination An absent absolute directory beneath an existing canonical parent.
 * @param key The 32-byte key the archive was packed with.
 * @returns The inspection of the unpacked snapshot, ready for restoreHqSnapshot.
 * @throws
 * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
 * - JG_AGENT_HQ_SNAPSHOT_FAILED: The HQ snapshot operation failed
 * - JG_AGENT_HQ_STORAGE_INVALID: The HQ storage is invalid
 */
export const unpackHqSnapshot = async (
  archivePath: string,
  destination: string,
  key: Buffer,
): Promise<IHqSnapshotInspection> => {
  let scratch: string | undefined;
  let owned: string | undefined;
  try {
    await checkInputs(destination, key);
    try {
      await lstat(destination);
      invalidSnapshot();
    } catch (cause) {
      if (!hasErrorCode(cause, 'ENOENT')) throw cause;
    }
    scratch = await mkdtemp(join(dirname(destination), '.hq-unpack-'));
    await decryptArchive(archivePath, join(scratch, 'plaintext'), key);
    owned = await reserveSnapshotDirectory(destination);
    await writeEntries(join(scratch, 'plaintext'), owned);
    const inspection = await inspectHqSnapshot(owned);
    await rm(scratch, { recursive: true });
    return inspection;
  } catch (cause) {
    // attempt both removals so a stuck scratch directory never keeps the destination
    const cleanups = await Promise.allSettled(
      [owned, scratch]
        .filter((path) => path !== undefined)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
    const failures = cleanups.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    throw classify(
      failures.length ? new AggregateError([cause, ...failures], 'Snapshot cleanup failed') : cause,
    );
  }
};
