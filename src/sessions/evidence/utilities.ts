import { hashValue } from 'jg-crypto';

import type {
  IEvidencePage,
  IEvidenceRequest,
  IHistoryItem,
  IHistoryProvenance,
} from '../../contracts/index.js';
import { createRequestCursors } from '../utilities.js';
import { HQ_ERRORS } from '../../errors/index.js';

import { EvidencePositionSchema, type IEvidencePosition } from './types.js';

// the budget leaves room for the complete IPC/CLI envelope and host provenance enrichment
export const EVIDENCE_RESPONSE_BYTES = 65_536;
export const EVIDENCE_SOURCE_PAGE_SIZE = 8;
const PAYLOAD_BYTES = EVIDENCE_RESPONSE_BYTES - 4096 - 16_384;

// an evidence page continues within one bounded native source page, or at the next one
const positions = createRequestCursors(EvidencePositionSchema);

/**
 * Returns native evidence of a kind, without inferring operator identity from a user role.
 * @param kind The item's kind.
 * @param nativeInputId The native input a user message came from, when the provider names one.
 * @param nativeInputText The text that input sent, before attachments or a cut, which is hashed.
 * @returns The provenance, which links to no action until the store matches one.
 */
export const nativeProvenance = (
  kind: IHistoryItem['kind'],
  nativeInputId: string | null = null,
  nativeInputText: string | null = null,
): IHistoryProvenance => ({
  origin:
    kind === 'agent-message'
      ? 'agent'
      : kind === 'tool' || kind === 'command' || kind === 'file-change'
        ? 'tool'
        : kind === 'notice'
          ? 'system'
          : 'unknown',
  source: kind === 'unsupported' || kind === 'user-message' ? 'unknown' : 'native-kind',
  nativeInputId,
  nativeInputSha256:
    nativeInputId === null || nativeInputText === null ? null : evidenceHash(nativeInputText),
  actionId: null,
  contentBoundary: 'untrusted',
  grantsAuthority: false,
});

/**
 * Keeps only the native input link a provider's item names, so provider assertions alone never
 * establish an operator or an HQ action link.
 * @param kind The item's kind.
 * @param provenance The provenance the provider gave the item.
 * @returns The provenance, with its native input ID and text hash and no action.
 */
export const resetProvenance = (
  kind: IHistoryItem['kind'],
  { nativeInputId, nativeInputSha256 }: IHistoryProvenance,
): IHistoryProvenance => ({
  ...nativeProvenance(kind, nativeInputId),
  nativeInputSha256: nativeInputId === null ? null : nativeInputSha256,
});

/** Hashes exactly the normalized UTF-8 evidence content. */
export const evidenceHash = (text: string): string => hashValue(text);

/**
 * Rejects a continuation outside its exact query before any native read.
 * @throws
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 */
export const evidencePosition = (command: { cursor?: string }): IEvidencePosition => {
  const { cursor, ...filters } = command;
  return (
    positions.decode(cursor, filters) ?? { sourceCursor: null, index: 0, offset: 0, digest: null }
  );
};

/**
 * Binds a bounded source page to its continuation; changing content requires a fresh read.
 * @throws
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 */
const verifyEvidencePage = (position: IEvidencePosition, items: unknown[]): string => {
  const digest = evidenceHash(JSON.stringify(items));
  if (position.digest !== null && position.digest !== digest)
    throw HQ_ERRORS.create('cursorInvalid', { data: { kind: 'invalid-request' } });
  if (position.index > items.length || (position.index === items.length && position.offset !== 0))
    throw HQ_ERRORS.create('cursorInvalid', { data: { kind: 'invalid-request' } });
  return digest;
};

/**
 * Encodes a content-bound page position using the selected query.
 * @throws
 * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
 */
const evidenceCursor = (
  command: { cursor?: string },
  position: IEvidencePosition | null,
): string | null => {
  const { cursor: _cursor, ...filters } = command;
  try {
    return positions.encode(position, filters);
  } catch (cause) {
    throw HQ_ERRORS.create('providerFailed', { data: { kind: 'agent-unavailable' }, cause });
  }
};

/** Returns an exact UTF-8 prefix, leaving an incomplete code point for the next chunk. */
const utf8Chunk = (bytes: Buffer, offset: number, limit: number): string => {
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
      throw HQ_ERRORS.create('cursorInvalid', { data: { kind: 'invalid-request' } });
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
      ...(item.asyncInput ? { asyncInput: item.asyncInput } : {}),
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
        throw HQ_ERRORS.create('providerFailed', { data: { kind: 'agent-unavailable' } });
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
