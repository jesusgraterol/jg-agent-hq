// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { readContinuedIn } from './utilities.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hq-continued-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

// records as Claude Code 2.1.317 writes them at the end of a transcript it moved into a new session
const line = (record: object) => `${JSON.stringify(record)}\n`;
const message = (type: 'user' | 'assistant') =>
  line({
    type,
    uuid: randomUUID(),
    timestamp: '2026-11-03T11:25:00.000Z',
    message: { role: type, content: 'Working' },
  });
const continued = (sessionId: string, continuedInSessionId: string) =>
  line({
    type: 'continued-in',
    timestamp: '2026-11-03T11:25:59.088Z',
    sessionId,
    continuedInSessionId,
  });
const closing = line({ type: 'ephemeral' }) + line({ type: 'cost-state' });

test.each([
  [
    'a move followed by closing records',
    (old: string, next: string) =>
      message('user') + message('assistant') + continued(old, next) + closing,
    true,
  ],
  [
    'a message written after the move',
    (old: string, next: string) => continued(old, next) + message('user'),
    false,
  ],
  [
    'a move that names an ID that isn’t a UUID',
    (old: string) => continued(old, '../outside'),
    false,
  ],
])('readContinuedIn(%s) -> %s', async (_case, transcript, isContinued) => {
  const [old, next] = [randomUUID(), randomUUID()];
  await writeFile(join(directory, `${old}.jsonl`), transcript(old, next));
  await writeFile(join(directory, `${next}.jsonl`), message('user'));
  expect(readContinuedIn(directory, old)).toBe(isContinued ? next : null);
});

test('readContinuedIn(a move to a session whose transcript isn’t beside it) -> null', async () => {
  const [old, next] = [randomUUID(), randomUUID()];
  await writeFile(join(directory, `${old}.jsonl`), continued(old, next) + closing);
  expect(readContinuedIn(directory, old)).toBeNull();
});

test('readContinuedIn reads only the transcript’s last 65,536 bytes', async () => {
  const [old, next] = [randomUUID(), randomUUID()];
  await writeFile(join(directory, `${next}.jsonl`), message('user'));
  // the move, then more than the tail of other records, which name no message type
  const filler = line({ type: 'cost-state', padding: 'x'.repeat(70_000) });
  await writeFile(join(directory, `${old}.jsonl`), continued(old, next) + filler);
  expect(readContinuedIn(directory, old)).toBeNull();
  // a move inside the tail is found even when the tail starts mid-line
  await writeFile(join(directory, `${old}.jsonl`), filler + continued(old, next) + closing);
  expect(readContinuedIn(directory, old)).toBe(next);
});

test('readContinuedIn(a transcript that is missing, or a session ID that isn’t a UUID) -> null', () => {
  expect(readContinuedIn(directory, randomUUID())).toBeNull();
  expect(readContinuedIn(directory, '../outside')).toBeNull();
});
