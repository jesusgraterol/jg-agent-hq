import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { Exception, isException } from 'jg-exception';

import {
  MAX_INPUT_FILE_BYTES,
  MAX_TEXT_FILE_BYTES,
  type IInputFile,
  type IBoundInputFile,
} from '../../contracts/index.js';
import { resolveWorkspaceTarget } from '../../runtime/state/index.js';

// only the trusted Node adapter receives bytes; public commands contain references
export type IProviderInputFile = IBoundInputFile & { content: Uint8Array };

/**
 * Reads a bounded file through an authorized, checked descriptor and optionally verifies its binding.
 * @returns The canonical content-bound reference and the exact bytes read.
 * @throws
 * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
 * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
 * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
 */
const readInputFile = async (
  reference: IInputFile | IBoundInputFile,
  workspaceRoot: string,
  roots: string[],
): Promise<IProviderInputFile> => {
  const isBound = 'sha256' in reference;
  const invalid = (cause?: unknown): never => {
    throw new Exception(
      isBound ? 'The HQ action conflicts with its recorded state' : 'The HQ request is invalid',
      {
        code: isBound ? 'JG_AGENT_HQ_ACTION_CONFLICT' : 'JG_AGENT_HQ_REQUEST_INVALID',
        data: { kind: isBound ? 'state-conflict' : 'invalid-request' },
        cause,
      },
    );
  };
  try {
    const candidate = isAbsolute(reference.path)
      ? reference.path
      : resolve(workspaceRoot, reference.path);
    const path = await resolveWorkspaceTarget(candidate, roots);
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      const maximum =
        reference.mediaType === 'text/plain' ? MAX_TEXT_FILE_BYTES : MAX_INPUT_FILE_BYTES;
      if (!before.isFile() || before.size < 1 || before.size > maximum) invalid();
      const content = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < content.length) {
        const { bytesRead } = await handle.read(content, length, content.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await handle.stat();
      const current = await stat(path);
      if (
        length !== before.size ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        before.dev !== current.dev ||
        before.ino !== current.ino ||
        (await realpath(path)) !== path
      )
        invalid();
      const bytes = content.subarray(0, length);
      const signature = bytes.subarray(0, 16);
      const validMedia =
        reference.mediaType === 'text/plain'
          ? !!new TextDecoder('utf-8', { fatal: true }).decode(bytes) && !bytes.includes(0)
          : reference.mediaType === 'image/png'
            ? signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : reference.mediaType === 'image/jpeg'
              ? signature[0] === 255 && signature[1] === 216 && signature[2] === 255
              : reference.mediaType === 'image/gif'
                ? ['GIF87a', 'GIF89a'].includes(signature.toString('ascii', 0, 6))
                : reference.mediaType === 'image/webp'
                  ? signature.toString('ascii', 0, 4) === 'RIFF' &&
                    signature.toString('ascii', 8, 12) === 'WEBP'
                  : signature.toString('ascii', 0, 5) === '%PDF-';
      if (!validMedia) invalid();
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (
        isBound &&
        (sha256 !== reference.sha256 || length !== reference.bytes || path !== reference.path)
      )
        invalid();
      return { path, mediaType: reference.mediaType, sha256, bytes: length, content: bytes };
    } finally {
      await handle.close();
    }
  } catch (cause) {
    if (isException(cause)) throw cause;
    return invalid(cause);
  }
};

/**
 * Resolves inputs sequentially with one aggregate byte budget and no remote retrieval.
 * @returns Exact descriptor-read bytes and immutable references for queue admission or dispatch.
 * @throws
 * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
 * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
 * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
 */
export const readInputFiles = async (
  references: (IInputFile | IBoundInputFile)[],
  workspaceRoot: string,
  roots: string[],
): Promise<IProviderInputFile[]> => {
  const files: IProviderInputFile[] = [];
  let bytes = 0;
  for (const reference of references) {
    const file = await readInputFile(reference, workspaceRoot, roots);
    bytes += file.bytes;
    if (bytes > MAX_INPUT_FILE_BYTES)
      throw new Exception('The HQ request is invalid', {
        code: 'JG_AGENT_HQ_REQUEST_INVALID',
        data: { kind: 'invalid-request' },
      });
    files.push(file);
  }
  return files;
};
