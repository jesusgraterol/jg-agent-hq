import { createHash } from 'node:crypto';
import { Exception } from 'jg-exception';

import type {
  IEvidencePage,
  IEvidenceRequest,
  IHistoryItem,
  IHistoryProvenance,
} from '../../contracts/index.js';
import { decodeHistoryCursor, encodeHistoryCursor } from '../utilities.js';

import { EvidencePositionSchema, type IEvidencePosition } from './types.js';

// the budget leaves room for the complete IPC/CLI envelope and host provenance enrichment
export const EVIDENCE_RESPONSE_BYTES = 65_536;
export const EVIDENCE_SOURCE_PAGE_SIZE = 8;
const PAYLOAD_BYTES = EVIDENCE_RESPONSE_BYTES - 4096 - 16_384;

/** Returns native evidence of a kind, without inferring operator identity from a user role. */
export const nativeProvenance = (
  kind: IHistoryItem['kind'],
  nativeInputId: string | null = null,
): IHistoryProvenance => ({
  origin:
    kind === 'agent-message'
      ? 'agent'
      : kind === 'tool' || kind === 'command' || kind === 'file-change'
        ? 'tool'
        : 'unknown',
  source: kind === 'unsupported' || kind === 'user-message' ? 'unknown' : 'native-kind',
  nativeInputId,
  actionId: null,
  contentBoundary: 'untrusted',
  grantsAuthority: false,
});

/** Hashes exactly the normalized UTF-8 evidence content. */
export const evidenceHash = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

/**
 * Rejects a continuation outside its exact query before any native read.
 * @throws
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 */
export const evidencePosition = (command: { cursor?: string }): IEvidencePosition => {
  const { cursor, ...filters } = command;
  const decoded = decodeHistoryCursor(cursor, filters);
  if (!decoded) return { index: 0, offset: 0, digest: null };
  try {
    return EvidencePositionSchema.parse(JSON.parse(decoded));
  } catch (cause) {
    throw new Exception('The HQ cursor does not match this request', {
      code: 'JG_AGENT_HQ_CURSOR_INVALID',
      data: { kind: 'invalid-request' },
      cause,
    });
  }
};

/**
 * Binds a bounded source page to its continuation; changing content requires a fresh read.
 * @throws
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 */
export const verifyEvidencePage = (position: IEvidencePosition, items: unknown[]): string => {
  const digest = evidenceHash(JSON.stringify(items));
  if (position.digest !== null && position.digest !== digest)
    throw new Exception('The HQ cursor does not match this request', {
      code: 'JG_AGENT_HQ_CURSOR_INVALID',
      data: { kind: 'invalid-request' },
    });
  if (position.index > items.length || (position.index === items.length && position.offset !== 0))
    throw new Exception('The HQ cursor does not match this request', {
      code: 'JG_AGENT_HQ_CURSOR_INVALID',
      data: { kind: 'invalid-request' },
    });
  return digest;
};

/**
 * Encodes a content-bound page position using the selected query.
 * @throws
 * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
 */
export const evidenceCursor = (
  command: { cursor?: string },
  position: IEvidencePosition | null,
): string | null => {
  const { cursor: _cursor, ...filters } = command;
  try {
    return encodeHistoryCursor(position === null ? null : JSON.stringify(position), filters);
  } catch (cause) {
    throw new Exception('The HQ provider integration failed', {
      code: 'JG_AGENT_HQ_PROVIDER_FAILED',
      data: { kind: 'agent-unavailable' },
      cause,
    });
  }
};

/** Returns an exact UTF-8 prefix, leaving an incomplete code point for the next chunk. */
export const utf8Chunk = (bytes: Buffer, offset: number, limit: number): string => {
  let end = Math.min(bytes.length, offset + limit);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, end));
};

/**
 * Selects newest-first evidence from one native page, returning complete bodies through continuation.
 * Source I/O stays bounded independently of a transcript's total size. No transcript cache is kept.
 * @returns One page within the total response budget, including a cursor for any remaining body.
 * @throws
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
 */
export const buildEvidencePage = (
  command: IEvidenceRequest,
  position: IEvidencePosition,
  items: IHistoryItem[],
  nextSourceCursor: string | null,
): IEvidencePage => {
  const digest = verifyEvidencePage(position, items);
  const result: IEvidencePage = {
    data: [],
    nextCursor: null,
    source: 'native',
    history: 'persisted',
    order: 'newest-first',
    scanned: items.length,
  };
  let index = position.index;
  let offset = position.offset;
  for (; index < items.length && result.data.length < command.limit; index += 1) {
    const item = items[index]!;
    if (
      (command.nativeItemId !== undefined && item.nativeId !== command.nativeItemId) ||
      (command.turnId !== undefined && item.turnId !== command.turnId) ||
      (command.kinds !== undefined && !command.kinds.includes(item.kind))
    ) {
      offset = 0;
      continue;
    }
    const bytes = Buffer.from(item.text);
    if (offset > bytes.length || (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80))
      throw new Exception('The HQ cursor does not match this request', {
        code: 'JG_AGENT_HQ_CURSOR_INVALID',
        data: { kind: 'invalid-request' },
      });
    let chunkBytes = 32_768;
    let text = utf8Chunk(bytes, offset, chunkBytes);
    let nextOffset = offset + Buffer.byteLength(text);
    const fragment = {
      reference: {
        provider: command.provider,
        nativeId: command.nativeId,
        turnId: item.turnId,
        itemId: item.nativeId,
        sha256: evidenceHash(item.text),
      },
      kind: item.kind,
      nativeType: item.nativeType,
      provenance: item.provenance,
      text,
      offsetBytes: offset,
      totalBytes: bytes.length,
      isComplete: nextOffset === bytes.length && !item.isTruncated && item.kind !== 'unsupported',
      contentState:
        item.kind === 'unsupported'
          ? ('unsupported' as const)
          : item.isTruncated
            ? ('native-preview' as const)
            : ('available' as const),
    };
    const candidateSize = (): number =>
      Buffer.byteLength(
        JSON.stringify({
          ...result,
          data: [...result.data, fragment],
          nextCursor: evidenceCursor(command, { ...position, digest, index, offset: nextOffset }),
        }),
      );
    while (candidateSize() > PAYLOAD_BYTES && chunkBytes > 4) {
      chunkBytes = Math.floor(chunkBytes / 2);
      text = utf8Chunk(bytes, offset, chunkBytes);
      nextOffset = offset + Buffer.byteLength(text);
      fragment.text = text;
      fragment.isComplete =
        nextOffset === bytes.length && !item.isTruncated && item.kind !== 'unsupported';
    }
    if (candidateSize() > PAYLOAD_BYTES) {
      if (result.data.length === 0)
        throw new Exception('The HQ provider integration failed', {
          code: 'JG_AGENT_HQ_PROVIDER_FAILED',
          data: { kind: 'agent-unavailable' },
        });
      break;
    }
    result.data.push(fragment);
    if (nextOffset < bytes.length) {
      offset = nextOffset;
      break;
    }
    offset = 0;
  }
  result.nextCursor = evidenceCursor(
    command,
    index < items.length
      ? { ...position, digest, index, offset }
      : nextSourceCursor === null
        ? null
        : { sourceCursor: nextSourceCursor, digest: null, index: 0, offset: 0 },
  );
  return result;
};
