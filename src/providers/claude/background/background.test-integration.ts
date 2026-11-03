// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { createClaudeBackgroundTasks } from './index.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hq-background-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const STARTED_AT = Date.parse('2026-11-03T10:00:00.000Z');
const AT = '2026-11-03T10:05:00.000Z';
const BUDGET = 67_108_864;

// one transcript line each, shaped as Claude Code 2.1.317 writes them
const started = (taskId: string) =>
  `${JSON.stringify({
    type: 'user',
    timestamp: AT,
    message: {
      role: 'user',
      content: [
        {
          tool_use_id: `toolu_${taskId}`,
          type: 'tool_result',
          content: 'Command running in background',
        },
      ],
    },
    toolUseResult: { stdout: '', stderr: '', backgroundTaskId: taskId },
  })}\n`;
const notified = (taskId: string) =>
  `${JSON.stringify({
    type: 'user',
    timestamp: AT,
    message: {
      role: 'user',
      content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n</task-notification>`,
    },
  })}\n`;
const stopCall = (toolUseId: string, taskId: string) =>
  `${JSON.stringify({
    type: 'assistant',
    timestamp: AT,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name: 'TaskStop', input: { task_id: taskId } }],
    },
  })}\n`;
const stopResult = (toolUseId: string, isError = false) =>
  `${JSON.stringify({
    type: 'user',
    timestamp: AT,
    message: {
      role: 'user',
      content: [
        {
          tool_use_id: toolUseId,
          type: 'tool_result',
          content: 'stopped',
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
  })}\n`;
const message = (text: string) =>
  `${JSON.stringify({ type: 'assistant', timestamp: AT, message: { role: 'assistant', content: [{ type: 'text', text }] } })}\n`;

const budget = (remaining = BUDGET) => ({ remaining });

test('counts the tasks a transcript starts and ends as it grows, reading only what was added', async () => {
  const tasks = createClaudeBackgroundTasks();
  const nativeId = randomUUID();
  const path = join(directory, `${nativeId}.jsonl`);
  await writeFile(path, message('working') + started('bone0001') + started('btwo0002'));
  const first = budget();
  expect(await tasks.update(nativeId, directory, STARTED_AT, first)).toBe(2);
  const firstRead = BUDGET - first.remaining;
  // a line still being written counts once it ends
  const ending = notified('bone0001');
  await appendFile(path, ending.slice(0, 20));
  expect(await tasks.update(nativeId, directory, STARTED_AT, budget())).toBe(2);
  await appendFile(path, ending.slice(20));
  const second = budget();
  expect(await tasks.update(nativeId, directory, STARTED_AT, second)).toBe(1);
  // the second read starts at the partial line, not at the transcript's start
  expect(BUDGET - second.remaining).toBeLessThan(firstRead);
  await appendFile(path, notified('btwo0002'));
  expect(await tasks.update(nativeId, directory, STARTED_AT, budget())).toBe(0);
});

test('a stop ends its task when its result follows the call or comes before it, and a failed stop does not', async () => {
  const tasks = createClaudeBackgroundTasks();
  const nativeId = randomUUID();
  const path = join(directory, `${nativeId}.jsonl`);
  await writeFile(
    path,
    started('bfirst01') +
      started('bsecond2') +
      started('bthird03') +
      stopCall('toolu_a', 'bfirst01') +
      stopResult('toolu_a') +
      // Claude Code can write a result before the assistant record that holds its call
      stopResult('toolu_b') +
      stopCall('toolu_b', 'bsecond2') +
      stopCall('toolu_c', 'bthird03') +
      stopResult('toolu_c', true),
  );
  expect(await tasks.update(nativeId, directory, STARTED_AT, budget())).toBe(1);
});

test('a replaced, shortened or restarted transcript is read again from its start', async () => {
  const tasks = createClaudeBackgroundTasks();
  const nativeId = randomUUID();
  const path = join(directory, `${nativeId}.jsonl`);
  await writeFile(path, started('bone0001') + started('btwo0002'));
  expect(await tasks.update(nativeId, directory, STARTED_AT, budget())).toBe(2);
  // a shorter file under the same name holds only what it says now
  await writeFile(path, started('bnew0001'));
  expect(await tasks.update(nativeId, directory, STARTED_AT, budget())).toBe(1);
  await rm(path);
  await writeFile(path, started('bnew0001') + started('bnew0002') + started('bnew0003'));
  expect(await tasks.update(nativeId, directory, STARTED_AT, budget())).toBe(3);
  // a new Claude process for the session leaves the earlier process's tasks out
  expect(await tasks.update(nativeId, directory, STARTED_AT + 3_600_000, budget())).toBe(0);
});

test('a read the budget stops short of the end reports 0 until a later read finishes it', async () => {
  const tasks = createClaudeBackgroundTasks();
  const nativeId = randomUUID();
  const path = join(directory, `${nativeId}.jsonl`);
  // a long message first, so the start sits past the first budget
  await writeFile(path, message('x'.repeat(200_000)) + started('blate001'));
  const shared = budget(131_072);
  expect(await tasks.update(nativeId, directory, STARTED_AT, shared)).toBe(0);
  expect(shared.remaining).toBe(0);
  // another session sharing the spent budget reads nothing
  const other = randomUUID();
  await writeFile(join(directory, `${other}.jsonl`), started('bother01'));
  expect(await tasks.update(other, directory, STARTED_AT, shared)).toBe(0);
  expect(await tasks.update(nativeId, directory, STARTED_AT, budget())).toBe(1);
  expect(await tasks.update(other, directory, STARTED_AT, budget())).toBe(1);
});

test('two updates of one session run one after the other and agree', async () => {
  const tasks = createClaudeBackgroundTasks();
  const nativeId = randomUUID();
  await writeFile(
    join(directory, `${nativeId}.jsonl`),
    Array.from({ length: 40 }, (_, index) =>
      started(`btask${String(index).padStart(3, '0')}`),
    ).join(''),
  );
  const counts = await Promise.all([
    tasks.update(nativeId, directory, STARTED_AT, budget()),
    tasks.update(nativeId, directory, STARTED_AT, budget()),
  ]);
  expect(counts).toStrictEqual([40, 40]);
});

test('at most 256 tasks are tracked per session', async () => {
  const tasks = createClaudeBackgroundTasks();
  const nativeId = randomUUID();
  await writeFile(
    join(directory, `${nativeId}.jsonl`),
    Array.from({ length: 300 }, (_, index) =>
      started(`btask${String(index).padStart(3, '0')}`),
    ).join(''),
  );
  expect(await tasks.update(nativeId, directory, STARTED_AT, budget())).toBe(256);
});

test('a missing or unreadable transcript counts 0, and a forgotten session is read again', async () => {
  const tasks = createClaudeBackgroundTasks();
  const nativeId = randomUUID();
  expect(await tasks.update(nativeId, directory, STARTED_AT, budget())).toBe(0);
  // a session ID that isn't a UUID never becomes a path
  expect(await tasks.update('../outside', directory, STARTED_AT, budget())).toBe(0);
  const path = join(directory, `${nativeId}.jsonl`);
  await writeFile(path, started('bone0001') + '{not json\n');
  expect(await tasks.update(nativeId, directory, STARTED_AT, budget())).toBe(1);
  tasks.forget(nativeId);
  const again = budget();
  expect(await tasks.update(nativeId, directory, STARTED_AT, again)).toBe(1);
  expect(again.remaining).toBeLessThan(BUDGET);
});
