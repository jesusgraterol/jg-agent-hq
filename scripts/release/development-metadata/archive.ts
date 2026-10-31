import { gunzipSync } from 'node:zlib';
import { Exception } from 'jg-exception';

import { sameDevelopmentMetadata } from './metadata.ts';

// the existing consumer caps compressed archives at 16 MiB; inspection also bounds expansion.
const COMPRESSED_LIMIT = 16 * 1024 * 1024;
const EXPANDED_LIMIT = 64 * 1024 * 1024;
const ENTRY_LIMIT = 4096;
const BLOCK_SIZE = 512;

const invalidArchive = (): never => {
  throw new Exception(
    'The HQ package release check failed: invalid or unsupported package archive',
    {
      code: 'JG_AGENT_HQ_RELEASE_CHECK_FAILED',
    },
  );
};

/** Reads the ordinary octal fields emitted by npm; unsupported encodings fail closed. */
const octal = (field: Buffer): number => {
  const text = field.toString('utf8').replace(/[\0 ]+$/u, '');
  if (!/^[0-7]+$/u.test(text)) return invalidArchive();
  const value = Number.parseInt(text, 8);
  return Number.isSafeInteger(value) ? value : invalidArchive();
};

/** Reads a NUL-padded portable tar header field without hiding suffix bytes or invalid encoding. */
const headerText = (field: Buffer): string => {
  const end = field.indexOf(0);
  if (end !== -1 && field.subarray(end).some((byte) => byte !== 0)) return invalidArchive();
  const bytes = end === -1 ? field : field.subarray(0, end);
  const text = bytes.toString('utf8');
  return Buffer.from(text).equals(bytes) ? text : invalidArchive();
};

/**
 * Inspects npm's regular-file USTAR payload without extracting it. Links, extension records,
 * unsafe/duplicate paths, invalid checksums, truncation and nonzero trailing data fail closed.
 * @returns Bounded file bytes and permission modes keyed by their package-relative paths.
 * @throws
 * - JG_AGENT_HQ_RELEASE_CHECK_FAILED: The HQ package release check failed
 */
const readArchive = (bytes: Uint8Array): Map<string, { bytes: Buffer; mode: number }> => {
  if (bytes.byteLength > COMPRESSED_LIMIT) return invalidArchive();
  let tar: Buffer;
  try {
    tar = gunzipSync(bytes, { maxOutputLength: EXPANDED_LIMIT });
  } catch {
    return invalidArchive();
  }
  const files = new Map<string, { bytes: Buffer; mode: number }>();
  let offset = 0;
  while (offset + BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      if (tar.length - offset < 2 * BLOCK_SIZE || tar.subarray(offset).some((byte) => byte !== 0))
        return invalidArchive();
      return files.has('package.json') && files.has('README.md') ? files : invalidArchive();
    }
    let checksum = 0;
    for (let index = 0; index < BLOCK_SIZE; index++)
      checksum += index >= 148 && index < 156 ? 32 : header[index]!;
    if (
      checksum !== octal(header.subarray(148, 156)) ||
      headerText(header.subarray(257, 263)) !== 'ustar' ||
      header.subarray(263, 265).toString('utf8') !== '00' ||
      header[156] !== 48 ||
      headerText(header.subarray(157, 257)) !== ''
    )
      return invalidArchive();
    const name = headerText(header.subarray(0, 100));
    const prefix = headerText(header.subarray(345, 500));
    const path = prefix ? `${prefix}/${name}` : name;
    if (
      !/^package\/[a-zA-Z0-9._/-]+$/u.test(path) ||
      path.split('/').some((part) => part === '' || part === '.' || part === '..')
    )
      return invalidArchive();
    const relative = path.slice('package/'.length);
    const size = octal(header.subarray(124, 136));
    const mode = octal(header.subarray(100, 108));
    const end = offset + BLOCK_SIZE + size;
    const next = offset + BLOCK_SIZE + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    if (
      size > COMPRESSED_LIMIT ||
      end > tar.length ||
      next > tar.length ||
      mode > 0o7777 ||
      files.has(relative) ||
      files.size >= ENTRY_LIMIT ||
      tar.subarray(end, next).some((byte) => byte !== 0)
    )
      return invalidArchive();
    files.set(relative, { bytes: tar.subarray(offset + BLOCK_SIZE, end), mode });
    offset = next;
  }
  return invalidArchive();
};

/**
 * Compares protected file inventories, permissions and bytes, allowing only testing metadata.
 * @returns Whether a candidate can reuse the already published package without publication.
 * @throws
 * - JG_AGENT_HQ_RELEASE_CHECK_FAILED: The HQ package release check failed
 */
export const samePublishedArchive = (
  publishedBytes: Uint8Array,
  candidateBytes: Uint8Array,
): boolean => {
  const published = readArchive(publishedBytes);
  const candidate = readArchive(candidateBytes);
  if (published.size !== candidate.size) return false;
  for (const [path, next] of candidate) {
    const previous = published.get(path);
    if (!previous || previous.mode !== next.mode) return false;
    if (previous.bytes.equals(next.bytes)) continue;
    if (
      (path !== 'package.json' && path !== 'README.md') ||
      !sameDevelopmentMetadata(path, previous.bytes, next.bytes)
    )
      return false;
  }
  return true;
};
