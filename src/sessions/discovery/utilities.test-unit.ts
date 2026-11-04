import { expectToThrowCode } from 'jg-exception/testing';
import { expect, test } from 'vitest';

import type { IDiscoveryPosition, IListKey } from './types.js';
import { compareListKeys, decodeDiscoveryCursor, encodeDiscoveryCursor } from './utilities.js';

const filters = {
  workspaceRoots: ['/workspace/a', '/workspace/b'],
  providers: ['claude', 'codex'],
  search: null,
  excludeContinued: false,
};
const last: IListKey = {
  updatedAt: 1_761_040_800_000,
  provider: 'codex',
  nativeId: '0199a0b2-5c1d-7e3f-8a9b-0c1d2e3f4a5b',
};

/*
 * A position whose every source has unlisted sessions, Claude's continuation in its reader's
 * `<updatedAt>:<UUID>` form and Codex's in the 56-character `<timestamp>|<UUID>` form Codex's
 * rollout listing uses.
 */
const fullPosition = (sources: number): IDiscoveryPosition => ({
  last,
  sources: Array.from({ length: sources }, (_, index) => [
    1_761_040_800_000 - index,
    index % 2
      ? `2025-10-21T09-00-00|0199a0b2-5c1d-7e3f-8a9b-${String(index).padStart(12, '0')}`
      : `1761040800000:5f0e8c1a-2b3d-4e5f-8a9b-${String(index).padStart(12, '0')}`,
  ]),
});

// flips one character of a cursor's encoded JSON, keeping it valid base64url
const tamper = (cursor: string): string =>
  `${cursor.slice(0, 8)}${cursor[8] === 'A' ? 'B' : 'A'}${cursor.slice(9)}`;

// a session's place, last active at a time, for a provider and with an ID
const key = (updatedAt: number, provider: 'claude' | 'codex', nativeId: string): IListKey => ({
  updatedAt,
  provider,
  nativeId,
});

test.each([
  ['a newer session', key(2, 'claude', 'a'), key(1, 'codex', 'b'), -1],
  ['Codex at the same time as Claude', key(1, 'codex', 'a'), key(1, 'claude', 'b'), -1],
  ['a greater native ID at the same time', key(1, 'claude', 'b'), key(1, 'claude', 'a'), -1],
  // U+1F600 is above U+FFFD by code point, as SQLite compares UTF-8, though not by UTF-16 unit
  ['an astral native ID', key(1, 'claude', '😀'), key(1, 'claude', '\uFFFD'), -1],
  ['the same session', key(1, 'claude', 'a'), key(1, 'claude', 'a'), 0],
])('compareListKeys(%s) -> %d', (_case, left, right, expected) => {
  expect(Math.sign(compareListKeys(left, right))).toBe(expected);
  expect(Math.sign(compareListKeys(right, left))).toBe(-expected || 0);
});

test.each([1, 32, 128])(
  'a cursor for %d sources whose continuations are all kept fits a request and continues the same filters',
  (sources) => {
    const position = fullPosition(sources);
    const cursor = encodeDiscoveryCursor(position, filters);
    expect(cursor.length).toBeLessThanOrEqual(16_384);
    expect(decodeDiscoveryCursor(cursor, { ...filters }, sources)).toStrictEqual(position);
    expect(decodeDiscoveryCursor(undefined, filters, sources)).toBeUndefined();
  },
);

test.each([
  [
    'other folders',
    (cursor: string) =>
      decodeDiscoveryCursor(cursor, { ...filters, workspaceRoots: ['/workspace/a'] }, 4),
  ],
  [
    'another search',
    (cursor: string) => decodeDiscoveryCursor(cursor, { ...filters, search: 'x' }, 4),
  ],
  [
    'the continued filter',
    (cursor: string) => decodeDiscoveryCursor(cursor, { ...filters, excludeContinued: true }, 4),
  ],
  ['another source count', (cursor: string) => decodeDiscoveryCursor(cursor, filters, 2)],
  ['a tampered copy', (cursor: string) => decodeDiscoveryCursor(tamper(cursor), filters, 4)],
  ['a malformed cursor', () => decodeDiscoveryCursor('not a cursor', filters, 4)],
])('a threads cursor used with %s fails with CURSOR_INVALID', (_case, decode) => {
  const cursor = encodeDiscoveryCursor(fullPosition(4), filters);
  expectToThrowCode(
    () => decode(cursor),
    'JG_AGENT_HQ_CURSOR_INVALID',
    'The HQ cursor does not match this request',
  );
});

test('continuations too long for one cursor fail the page as a provider failure', () => {
  const position: IDiscoveryPosition = {
    last,
    sources: Array.from({ length: 4 }, () => [last.updatedAt, 'x'.repeat(8_192)]),
  };
  expectToThrowCode(
    () => encodeDiscoveryCursor(position, filters),
    'JG_AGENT_HQ_PROVIDER_FAILED',
    'The HQ provider integration failed',
  );
});
