import { close, fstat, read } from 'node:fs';
import { promisify } from 'node:util';

import { openTranscript } from '../history/index.js';

import {
  CHUNK_BYTES,
  MAX_ENDED_TASKS,
  MAX_PENDING_STOPS,
  MAX_RECORD_BYTES,
  MAX_RESULT_LINE_BYTES,
  MAX_TRACKED_TASKS,
  RESULT_MARKER,
  TASK_MARKERS,
} from './constants.js';
import type { IBackgroundEvents, IClaudeBackgroundTasks, IReadBudget } from './types.js';
import { readBackgroundEvents } from './utilities.js';

const fstatAsync = promisify(fstat);
const readAsync = promisify(read);
const closeAsync = promisify(close);

// how far one session's transcript has been read, and the tasks it still runs
type IScan = {
  identity: string;
  startedAt: number | null;
  // the first byte of the first line not yet read whole
  offset: number;
  open: Set<string>;
  ended: Set<string>;
  stopCalls: Map<string, string>;
  results: Map<string, boolean>;
};

// keeps a bounded insertion-ordered collection under its size by dropping the oldest entries
const remember = <T>(entries: Map<string, T>, key: string, value: T): void => {
  entries.delete(key);
  entries.set(key, value);
  if (entries.size > MAX_PENDING_STOPS) entries.delete(entries.keys().next().value!);
};

// ends a task, keeping it among the recently ended so a start written after its end stays ended
const end = (scan: IScan, taskId: string): void => {
  scan.open.delete(taskId);
  scan.ended.delete(taskId);
  scan.ended.add(taskId);
  if (scan.ended.size > MAX_ENDED_TASKS) scan.ended.delete(scan.ended.values().next().value!);
};

// applies what one record says, pairing each stop call with its result in either order
const apply = (scan: IScan, events: IBackgroundEvents): void => {
  for (const taskId of events.ends) end(scan, taskId);
  for (const { toolUseId, taskId } of events.stopCalls) {
    const isSuccess = scan.results.get(toolUseId);
    if (isSuccess === undefined) remember(scan.stopCalls, toolUseId, taskId);
    else {
      scan.results.delete(toolUseId);
      if (isSuccess) end(scan, taskId);
    }
  }
  for (const { toolUseId, isSuccess } of events.results) {
    const taskId = scan.stopCalls.get(toolUseId);
    if (taskId === undefined) remember(scan.results, toolUseId, isSuccess);
    else {
      scan.stopCalls.delete(toolUseId);
      if (isSuccess) end(scan, taskId);
    }
  }
  for (const taskId of events.starts)
    if (!scan.ended.has(taskId) && scan.open.size < MAX_TRACKED_TASKS) scan.open.add(taskId);
};

// reads one complete line when a marker says it may start or end a task
const readLine = (scan: IScan, line: Buffer): void => {
  const isMarked = TASK_MARKERS.some((marker) => line.includes(marker));
  if (!isMarked && !(line.length <= MAX_RESULT_LINE_BYTES && line.includes(RESULT_MARKER))) return;
  // a request copy repeats records already read, and names its type before its content
  if (line.subarray(0, 256).includes('"api-request-blob"')) return;
  let input: unknown;
  try {
    input = JSON.parse(line.toString('utf8'));
  } catch {
    return;
  }
  apply(scan, readBackgroundEvents(input, scan.startedAt));
};

/**
 * Counts each Claude session's background tasks from its transcript, reading only what was written
 * since the last read, in chunks, within the byte budget the caller shares across reads. A
 * replaced or shortened transcript, or a new Claude process, is read again from its start. A
 * line longer than the history reader's record limit is skipped.
 * @returns The counter: `update` resolves to the session's running tasks, or 0 while its read
 * hasn't reached the transcript's end or the transcript can't be read; updates of one session run
 * one at a time, and `forget` drops a session's state.
 */
export const createClaudeBackgroundTasks = (): IClaudeBackgroundTasks => {
  const scans = new Map<string, IScan>();
  const queues = new Map<string, Promise<number>>();

  const scanTranscript = async (
    nativeId: string,
    directory: string,
    startedAt: number | null,
    budget: IReadBudget,
  ): Promise<number> => {
    let fd: number;
    try {
      fd = openTranscript(directory, nativeId);
    } catch {
      scans.delete(nativeId);
      return 0;
    }
    try {
      const stat = await fstatAsync(fd);
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      let scan = scans.get(nativeId);
      if (
        !scan ||
        scan.identity !== identity ||
        scan.startedAt !== startedAt ||
        stat.size < scan.offset
      ) {
        scan = {
          identity,
          startedAt,
          offset: 0,
          open: new Set(),
          ended: new Set(),
          stopCalls: new Map(),
          results: new Map(),
        };
        scans.set(nativeId, scan);
      }
      const chunk = Buffer.alloc(CHUNK_BYTES);
      let position = scan.offset;
      let lineStart = position;
      // the start of a line that spans chunks, unless it outgrew the record limit
      let parts: Buffer[] = [];
      let partBytes = 0;
      let isOversized = false;
      while (position < stat.size && budget.remaining > 0) {
        const length = Math.min(CHUNK_BYTES, stat.size - position, budget.remaining);
        const { bytesRead } = await readAsync(fd, chunk, 0, length, position);
        if (bytesRead === 0) break;
        budget.remaining -= bytesRead;
        const view = chunk.subarray(0, bytesRead);
        let from = 0;
        for (let newline = view.indexOf(10); newline !== -1; newline = view.indexOf(10, from)) {
          const piece = view.subarray(from, newline);
          if (!isOversized && partBytes + piece.length <= MAX_RECORD_BYTES)
            readLine(scan, parts.length ? Buffer.concat([...parts, piece]) : piece);
          parts = [];
          partBytes = 0;
          isOversized = false;
          from = newline + 1;
          lineStart = position + from;
        }
        const rest = view.subarray(from);
        if (rest.length && !isOversized) {
          if (partBytes + rest.length > MAX_RECORD_BYTES) {
            isOversized = true;
            parts = [];
            partBytes = 0;
          } else {
            // the chunk is reused by the next read, so the line's start is kept as a copy
            parts.push(Buffer.from(rest));
            partBytes += rest.length;
          }
        }
        position += bytesRead;
      }
      // a line still being written is read again, whole, by the next update
      scan.offset = lineStart;
      return position >= stat.size ? scan.open.size : 0;
    } catch {
      scans.delete(nativeId);
      return 0;
    } finally {
      await closeAsync(fd).catch(() => undefined);
    }
  };

  return {
    update(nativeId, directory, startedAt, budget) {
      const next = (queues.get(nativeId) ?? Promise.resolve(0)).then(() =>
        scanTranscript(nativeId, directory, startedAt, budget),
      );
      queues.set(nativeId, next);
      void next.finally(() => {
        if (queues.get(nativeId) === next) queues.delete(nativeId);
      });
      return next;
    },
    forget(nativeId) {
      scans.delete(nativeId);
    },
  };
};
