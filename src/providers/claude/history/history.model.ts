import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, opendirSync, readSync, type Dir } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { Exception, extractMessage, hasErrorCode } from 'error-message-utils';
import { z } from 'zod';

import {
  HqResponseSchema,
  type IHqRequest,
  type IThreadSummary,
} from '../../../contracts/index.js';
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  type IHistoryRequest,
} from '../../../sessions/index.js';

import { ClaudeHistoryVersionSchema } from '../types.js';

import {
  EntryRowSchema,
  EntrySeekSchema,
  FileRowSchema,
  RecordSchema,
  SeekSchema,
  type IFileRow,
  type IClaudeHistoryRead,
} from './types.js';
import { openTranscript, projectDirectory, toClaudeItem } from './utilities.js';

const MAX_RECORD_BYTES = 1_048_576;
const MAX_REFRESH_BYTES = 4_194_304;
const CHAIN = `WITH RECURSIVE current_chain AS (
  SELECT workspace_root, native_id, uuid, parent_uuid, turn_id, byte_offset, byte_length, created_at, is_visible
  FROM claude_entry WHERE workspace_root = ? AND native_id = ? AND uuid = ?
  UNION SELECT claude_entry.workspace_root, claude_entry.native_id, claude_entry.uuid, claude_entry.parent_uuid,
  claude_entry.turn_id, claude_entry.byte_offset, claude_entry.byte_length, claude_entry.created_at, claude_entry.is_visible
  FROM claude_entry JOIN current_chain
  ON claude_entry.workspace_root = current_chain.workspace_root AND claude_entry.native_id = current_chain.native_id
  AND claude_entry.uuid = current_chain.parent_uuid
)`;

/**
 * Owns a replaceable metadata/byte-location projection, never conversation bodies.
 * All synchronous work runs in the existing SQLite worker, one file at a time.
 */
export class ClaudeHistoryModel {
  private readonly __database: DatabaseSync;
  private readonly __scans = new Map<
    string,
    { entries: Dir; seen: string; pending: string | null }
  >();

  public constructor(database: DatabaseSync) {
    this.__database = database;
    database.exec(`CREATE TABLE IF NOT EXISTS claude_file (
      workspace_root TEXT NOT NULL, native_id TEXT NOT NULL, identity TEXT NOT NULL,
      file_size INTEGER NOT NULL, byte_offset INTEGER NOT NULL, revision TEXT NOT NULL,
      leaf_id TEXT, name TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      supported INTEGER NOT NULL, seen TEXT NOT NULL, workspace_state TEXT NOT NULL,
      CONSTRAINT pk_cf__workspace_root_native_id PRIMARY KEY (workspace_root, native_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_cf__workspace_root_created_at_native_id_desc
    ON claude_file(workspace_root, created_at DESC, native_id DESC);
    CREATE TABLE IF NOT EXISTS claude_entry (
      workspace_root TEXT NOT NULL, native_id TEXT NOT NULL, uuid TEXT NOT NULL,
      parent_uuid TEXT, turn_id TEXT NOT NULL, byte_offset INTEGER NOT NULL, byte_length INTEGER NOT NULL,
      created_at INTEGER NOT NULL, is_visible INTEGER NOT NULL,
      is_current INTEGER NOT NULL, turn_start_offset INTEGER, anchor_id TEXT,
      CONSTRAINT pk_ce__workspace_root_native_id_uuid PRIMARY KEY (workspace_root, native_id, uuid),
      CONSTRAINT fk_ce__workspace_root_native_id FOREIGN KEY (workspace_root, native_id)
      REFERENCES claude_file(workspace_root, native_id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_ce__workspace_native_offset_current
    ON claude_entry(workspace_root, native_id, byte_offset) WHERE is_current = 1 AND is_visible = 1;
    CREATE INDEX IF NOT EXISTS idx_ce__workspace_native_turn_offset_current
    ON claude_entry(workspace_root, native_id, turn_id, byte_offset) WHERE is_current = 1 AND is_visible = 1;
    CREATE INDEX IF NOT EXISTS idx_ce__workspace_native_turn_start_current
    ON claude_entry(workspace_root, native_id, byte_offset)
    WHERE is_current = 1 AND is_visible = 1 AND byte_offset = turn_start_offset;`);
  }

  /**
   * Incrementally refreshes the exact workspace and returns one seek page.
   * @returns A validated result or a private marker requesting another bounded indexing batch.
   * @throws
   * - -1: The Claude history is unavailable
   * - -1: The HQ cursor does not match this request
   */
  public read(command: IHqRequest): IClaudeHistoryRead {
    if (
      (command.kind !== 'threads' &&
        command.kind !== 'thread' &&
        command.kind !== 'turns' &&
        command.kind !== 'items') ||
      command.provider !== 'claude'
    )
      throw new Exception('The Claude history is unavailable', undefined, {
        kind: 'agent-unavailable',
      });
    try {
      return this.__read(command);
    } catch (cause) {
      if (cause instanceof Exception) throw cause;
      throw new Exception(
        `The Claude history is unavailable: ${extractMessage(cause)}`,
        undefined,
        { kind: 'agent-unavailable' },
        { cause },
      );
    }
  }

  /** Releases incomplete discovery iterators before the worker closes SQLite. */
  public close(): void {
    for (const scan of this.__scans.values()) scan.entries.closeSync();
    this.__scans.clear();
  }

  private __read(command: IHistoryRequest): IClaudeHistoryRead {
    const root = command.workspaceRoot;
    const { cursor, ...filters } =
      command.kind === 'thread' ? { ...command, cursor: undefined } : command;
    const continuation = decodeHistoryCursor(cursor, filters);
    let directory: string;
    try {
      directory = projectDirectory(root);
    } catch (cause) {
      if (hasErrorCode(cause, 'ENOENT') && command.kind === 'threads')
        return { kind: 'threads', result: { data: [], nextCursor: null, source: 'native' } };
      throw cause;
    }
    if (command.kind === 'threads') {
      const seek = continuation ? this.__parseCursor(SeekSchema, continuation) : undefined;
      if (!seek && !this.__refresh(directory, root)) return { kind: 'indexing' };
      const rows = this.__database
        .prepare(
          `SELECT native_id, workspace_root, identity, file_size, byte_offset, revision,
        leaf_id, name, created_at, updated_at, supported, workspace_state FROM claude_file
        WHERE workspace_root = ? AND workspace_state = 'matching' AND (? IS NULL OR created_at < ? OR (created_at = ? AND native_id < ?))
        AND (? IS NULL OR instr(lower(coalesce(name, '')), lower(?)) > 0)
        ORDER BY created_at DESC, native_id DESC LIMIT ?`,
        )
        .all(
          root,
          seek?.createdAt ?? null,
          seek?.createdAt ?? null,
          seek?.createdAt ?? null,
          seek?.nativeId ?? null,
          command.search ?? null,
          command.search ?? null,
          command.limit + 1,
        )
        .map((row) => FileRowSchema.parse(row));
      const page = rows.slice(0, command.limit);
      const last = page.at(-1);
      return HqResponseSchema.parse({
        kind: 'threads',
        result: {
          data: page.map((row) => this.__summary(row)),
          source: 'native',
          nextCursor: encodeHistoryCursor(
            rows.length > command.limit && last
              ? JSON.stringify({ createdAt: last.created_at, nativeId: last.native_id })
              : null,
            filters,
          ),
        },
      });
    }
    let budget = MAX_REFRESH_BYTES;
    if (
      !this.__inspect(
        directory,
        root,
        command.nativeId,
        this.__scans.get(root)?.seen ?? 'selected',
        () => budget,
        (used) => {
          budget -= used;
        },
      )
    )
      return { kind: 'indexing' };
    const row = this.__file(root, command.nativeId);
    if (!row || row.supported !== 1 || row.workspace_state !== 'matching') this.__unavailable();
    if (command.kind === 'thread') return { kind: 'thread', result: this.__summary(row) };
    const seek = continuation ? this.__parseCursor(EntrySeekSchema, continuation) : undefined;
    if (seek && seek.revision !== row.revision)
      throw new Exception('The HQ cursor does not match this request', undefined, {
        kind: 'invalid-request',
      });
    const offset = seek?.offset ?? -1;
    if (command.kind === 'turns') {
      const turns = this.__database
        .prepare(
          `SELECT turn_id, byte_offset, created_at FROM claude_entry
        WHERE workspace_root = ? AND native_id = ? AND is_current = 1 AND is_visible = 1
        AND byte_offset = turn_start_offset AND byte_offset > ? ORDER BY byte_offset LIMIT ?`,
        )
        .all(root, command.nativeId, offset, command.limit + 1)
        .map((entry) =>
          z
            .object({ turn_id: z.string(), byte_offset: z.number(), created_at: z.number() })
            .parse(entry),
        );
      const page = turns.slice(0, command.limit);
      return HqResponseSchema.parse({
        kind: 'turns',
        result: {
          source: 'native',
          data: page.map((turn) => ({
            nativeId: turn.turn_id,
            state: 'unknown',
            startedAt: turn.created_at,
            completedAt: null,
          })),
          nextCursor: encodeHistoryCursor(
            turns.length > command.limit
              ? JSON.stringify({ revision: row.revision, offset: page.at(-1)!.byte_offset })
              : null,
            filters,
          ),
        },
      });
    }
    const entries = this.__database
      .prepare(
        `SELECT uuid, parent_uuid, turn_id, byte_offset, byte_length, created_at, is_visible FROM claude_entry
      WHERE workspace_root = ? AND native_id = ? AND is_current = 1 AND is_visible = 1 AND byte_offset > ?
      ${command.turnId === undefined ? '' : 'AND turn_id = ?'}
      ORDER BY byte_offset LIMIT ?`,
      )
      .all(
        root,
        command.nativeId,
        offset,
        ...(command.turnId === undefined ? [] : [command.turnId]),
        command.limit + 1,
      )
      .map((entry) => EntryRowSchema.parse(entry));
    const page = entries.slice(0, command.limit);
    const fd = openTranscript(directory, command.nativeId);
    try {
      if (this.__identity(fd) !== row.identity || fstatSync(fd).size < row.file_size)
        this.__unavailable();
      const items = [];
      let size = 0;
      let readBytes = 0;
      let lastOffset = offset;
      for (const entry of page) {
        if (readBytes + entry.byte_length > MAX_REFRESH_BYTES) break;
        readBytes += entry.byte_length;
        const bytes = Buffer.alloc(entry.byte_length);
        if (readSync(fd, bytes, 0, bytes.length, entry.byte_offset) !== bytes.length)
          this.__unavailable();
        const record = RecordSchema.parse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        );
        if (
          record.uuid !== entry.uuid ||
          !ClaudeHistoryVersionSchema.safeParse(record.version).success ||
          record.cwd !== root
        )
          this.__unavailable();
        const item = toClaudeItem(record, entry.turn_id);
        const itemSize = Buffer.byteLength(JSON.stringify(item));
        if (size + itemSize > MAX_REFRESH_BYTES) break;
        size += itemSize;
        lastOffset = entry.byte_offset;
        items.push(item);
      }
      return HqResponseSchema.parse({
        kind: 'items',
        result: {
          data: items,
          history: 'persisted',
          source: 'native',
          nextCursor: encodeHistoryCursor(
            entries.length > items.length
              ? JSON.stringify({ revision: row.revision, offset: lastOffset })
              : null,
            filters,
          ),
        },
      });
    } finally {
      closeSync(fd);
    }
  }

  private __summary(row: IFileRow): IThreadSummary {
    return {
      provider: 'claude',
      nativeId: row.native_id,
      workspaceRoot: row.workspace_root,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nativeState: 'unknown',
      ownership: 'external',
      managedId: null,
      historyState: row.supported === 1 ? 'available' : 'unavailable',
    };
  }

  private __parseCursor<T>(schema: z.ZodType<T>, text: string): T {
    try {
      return schema.parse(JSON.parse(text));
    } catch (cause) {
      throw new Exception(
        'The HQ cursor does not match this request',
        undefined,
        { kind: 'invalid-request' },
        { cause },
      );
    }
  }

  private __file(root: string, nativeId: string): IFileRow | undefined {
    const row = this.__database
      .prepare(
        `SELECT native_id, workspace_root, identity, file_size, byte_offset, revision,
      leaf_id, name, created_at, updated_at, supported, workspace_state FROM claude_file WHERE workspace_root = ? AND native_id = ?`,
      )
      .get(root, nativeId);
    return row ? FileRowSchema.parse(row) : undefined;
  }

  private __identity(fd: number): string {
    const stat = fstatSync(fd);
    if (!stat.isFile()) this.__unavailable();
    const bytes = Buffer.alloc(Math.min(stat.size, 256));
    readSync(fd, bytes, 0, bytes.length, 0);
    return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${createHash('sha256').update(bytes).digest('hex')}`;
  }

  private __refresh(directory: string, root: string): boolean {
    let scan = this.__scans.get(root);
    if (!scan) {
      if (this.__scans.size >= 4) {
        const oldest = this.__scans.entries().next().value!;
        oldest[1].entries.closeSync();
        this.__scans.delete(oldest[0]);
      }
      scan = { entries: opendirSync(directory), seen: randomUUID(), pending: null };
      this.__scans.set(root, scan);
    }
    const { seen } = scan;
    let budget = MAX_REFRESH_BYTES;
    let isComplete = false;
    try {
      for (let inspected = 0; inspected < 128; inspected += 1) {
        let nativeId = scan.pending;
        if (!nativeId) {
          const entry = scan.entries.readSync();
          if (!entry) {
            isComplete = true;
            break;
          }
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
          nativeId = entry.name.slice(0, -6);
          if (!z.uuid().safeParse(nativeId).success) continue;
        }
        try {
          if (
            !this.__inspect(
              directory,
              root,
              nativeId,
              seen,
              () => budget,
              (used) => {
                budget -= used;
              },
            )
          ) {
            scan.pending = nativeId;
            break;
          }
          scan.pending = null;
        } catch (cause) {
          if (this.__file(root, nativeId)?.supported !== -1) throw cause;
          scan.pending = null;
        }
      }
    } catch (cause) {
      scan.entries.closeSync();
      this.__scans.delete(root);
      throw cause;
    }
    if (isComplete) {
      scan.entries.closeSync();
      this.__scans.delete(root);
      this.__database
        .prepare('DELETE FROM claude_file WHERE workspace_root = ? AND seen != ?')
        .run(root, seen);
      if (
        this.__database
          .prepare(
            "SELECT native_id FROM claude_file WHERE workspace_root = ? AND workspace_state = 'unknown' LIMIT 1",
          )
          .get(root)
      )
        this.__unavailable();
    }
    return isComplete;
  }

  private __inspect(
    directory: string,
    root: string,
    nativeId: string,
    seen: string,
    remaining: () => number,
    consume: (used: number) => void,
  ): boolean {
    const fd = openTranscript(directory, nativeId);
    try {
      const stat = fstatSync(fd);
      const identity = this.__identity(fd);
      let row = this.__file(root, nativeId);
      if (!row || row.identity !== identity || stat.size < row.file_size) {
        const revision = randomUUID();
        this.__database
          .prepare('DELETE FROM claude_file WHERE workspace_root = ? AND native_id = ?')
          .run(root, nativeId);
        this.__database
          .prepare(
            `INSERT INTO claude_file (workspace_root, native_id, identity, file_size, byte_offset, revision,
            leaf_id, name, created_at, updated_at, supported, seen, workspace_state)
            VALUES (?, ?, ?, ?, 0, ?, NULL, NULL, ?, ?, 0, ?, 'unknown')`,
          )
          .run(
            root,
            nativeId,
            identity,
            stat.size,
            revision,
            Math.trunc(stat.birthtimeMs),
            Math.trunc(stat.mtimeMs),
            seen,
          );
        row = this.__file(root, nativeId)!;
      }
      this.__database
        .prepare('UPDATE claude_file SET seen = ? WHERE workspace_root = ? AND native_id = ?')
        .run(seen, root, nativeId);
      if (row.supported === -1) return true;
      row.updated_at = Math.max(row.updated_at, Math.trunc(stat.mtimeMs));
      let position = row.byte_offset;
      let lineStart = position;
      let tail = Buffer.alloc(0);
      const chunk = Buffer.alloc(65_536);
      this.__database.exec('BEGIN IMMEDIATE');
      try {
        while (position < stat.size && remaining() > 0) {
          const count = readSync(
            fd,
            chunk,
            0,
            Math.min(chunk.length, stat.size - position, remaining()),
            position,
          );
          if (count === 0) break;
          position += count;
          consume(count);
          tail = Buffer.concat([tail, chunk.subarray(0, count)]);
          for (let end = tail.indexOf(10); end !== -1; end = tail.indexOf(10)) {
            if (end > MAX_RECORD_BYTES) this.__unavailable();
            if (end > 0) this.__record(root, nativeId, row, tail.subarray(0, end), lineStart);
            lineStart += end + 1;
            tail = tail.subarray(end + 1);
          }
          if (tail.length > MAX_RECORD_BYTES) this.__unavailable();
        }
        row.byte_offset = lineStart;
        this.__database
          .prepare(
            `UPDATE claude_file SET byte_offset = ?, file_size = ?, leaf_id = ?, name = ?,
          created_at = ?, updated_at = ?, supported = ?, revision = ?, workspace_state = ? WHERE workspace_root = ? AND native_id = ?`,
          )
          .run(
            lineStart,
            stat.size,
            row.leaf_id,
            row.name,
            row.created_at,
            row.updated_at,
            row.supported,
            row.revision,
            row.workspace_state,
            root,
            nativeId,
          );
        this.__database.exec('COMMIT');
      } catch (cause) {
        this.__database.exec('ROLLBACK');
        this.__database
          .prepare(
            'UPDATE claude_file SET supported = -1, workspace_state = ? WHERE workspace_root = ? AND native_id = ?',
          )
          .run(row.workspace_state, root, nativeId);
        if (cause instanceof Exception) throw cause;
        this.__unavailable();
      }
      if (position < stat.size) return false;
      return true;
    } finally {
      closeSync(fd);
    }
  }

  private __record(
    root: string,
    nativeId: string,
    row: IFileRow,
    bytes: Buffer,
    offset: number,
  ): void {
    const record = RecordSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    if (record.cwd !== undefined) {
      if (record.cwd !== root || record.sessionId !== nativeId) {
        row.workspace_state = 'foreign';
        this.__unavailable();
      }
      row.workspace_state = 'matching';
    }
    if (record.type === 'custom-title') {
      if (record.sessionId !== nativeId || record.customTitle === undefined) this.__unavailable();
      row.name = record.customTitle;
      return;
    }
    if (
      record.version !== undefined &&
      !ClaudeHistoryVersionSchema.safeParse(record.version).success
    )
      this.__unavailable();
    if (record.isSidechain || !record.uuid) return;
    if (
      (record.type === 'user' || record.type === 'assistant') &&
      record.message?.role !== record.type
    )
      this.__unavailable();
    if (
      !ClaudeHistoryVersionSchema.safeParse(record.version).success ||
      record.sessionId !== nativeId ||
      record.cwd !== root ||
      record.timestamp === undefined ||
      !Number.isFinite(Date.parse(record.timestamp))
    )
      this.__unavailable();
    const createdAt = Date.parse(record.timestamp);
    const parent = record.parentUuid
      ? this.__database
          .prepare(
            `SELECT turn_id, turn_start_offset, anchor_id FROM claude_entry
      WHERE workspace_root = ? AND native_id = ? AND uuid = ?`,
          )
          .get(root, nativeId, record.parentUuid)
      : undefined;
    const textPrompt =
      record.type === 'user' &&
      !record.isMeta &&
      (typeof record.message?.content === 'string' ||
        (Array.isArray(record.message?.content) &&
          record.message.content.some(
            (block: unknown) => z.object({ type: z.literal('text') }).safeParse(block).success,
          )));
    const turnId = textPrompt
      ? record.uuid
      : typeof parent?.turn_id === 'string'
        ? parent.turn_id
        : record.uuid;
    const visible =
      (record.type === 'user' || record.type === 'assistant') &&
      record.message !== undefined &&
      !record.isMeta;
    if (record.parentUuid === record.uuid) this.__unavailable();
    if (record.parentUuid && !parent) this.__unavailable();
    const previous = this.__database
      .prepare(
        'SELECT parent_uuid FROM claude_entry WHERE workspace_root = ? AND native_id = ? AND uuid = ?',
      )
      .get(root, nativeId, record.uuid);
    if (previous && previous.parent_uuid !== (record.parentUuid ?? null)) this.__unavailable();
    const isAppend = row.leaf_id === null || parent?.anchor_id === row.leaf_id;
    const isSameLeaf =
      record.uuid === row.leaf_id && previous?.parent_uuid === (record.parentUuid ?? null);
    if (visible && !isAppend) row.revision = randomUUID();
    const turnStart = textPrompt
      ? offset
      : typeof parent?.turn_start_offset === 'number'
        ? parent.turn_start_offset
        : visible
          ? offset
          : null;
    const anchorId = visible
      ? record.uuid
      : typeof parent?.anchor_id === 'string'
        ? parent.anchor_id
        : null;
    this.__database
      .prepare(
        `INSERT INTO claude_entry (workspace_root, native_id, uuid, parent_uuid, turn_id, byte_offset,
          byte_length, created_at, is_visible, is_current, turn_start_offset, anchor_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_root, native_id, uuid) DO UPDATE SET parent_uuid = excluded.parent_uuid,
      turn_id = excluded.turn_id, byte_offset = excluded.byte_offset, byte_length = excluded.byte_length,
      created_at = excluded.created_at, is_visible = excluded.is_visible, is_current = excluded.is_current,
      turn_start_offset = excluded.turn_start_offset, anchor_id = excluded.anchor_id`,
      )
      .run(
        root,
        nativeId,
        record.uuid,
        record.parentUuid ?? null,
        turnId,
        offset,
        bytes.length,
        createdAt,
        visible ? 1 : 0,
        visible ? 1 : 0,
        turnStart,
        anchorId,
      );
    if (visible) {
      if (!isAppend && !isSameLeaf)
        this.__database
          .prepare(
            `${CHAIN} UPDATE claude_entry
        SET is_current = CASE WHEN uuid IN (SELECT uuid FROM current_chain) THEN 1 ELSE 0 END
        WHERE workspace_root = ? AND native_id = ?`,
          )
          .run(root, nativeId, record.uuid, root, nativeId);
      row.leaf_id = record.uuid;
      row.supported = 1;
    }
    row.created_at = Math.min(row.created_at, createdAt);
    row.updated_at = Math.max(row.updated_at, createdAt);
  }

  private __unavailable(): never {
    throw new Exception('The Claude history is unavailable', undefined, {
      kind: 'agent-unavailable',
    });
  }
}
