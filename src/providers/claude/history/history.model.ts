import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, opendirSync, readSync, type Dir } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { Exception, extractMessage, hasErrorCode, isException } from 'jg-exception';
import { z } from 'zod';

import {
  HqResponseSchema,
  type IHqRequest,
  type IItemDetail,
  type IThreadSummary,
  type IEvidenceRequest,
  type IEvidencePage,
} from '../../../contracts/index.js';
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  type IHistoryRequest,
} from '../../../sessions/index.js';
import {
  evidencePosition,
  buildEvidencePage,
  EVIDENCE_SOURCE_PAGE_SIZE,
} from '../../../sessions/evidence/index.js';

import {
  EntryRowSchema,
  EntrySeekSchema,
  FileRowSchema,
  RecordSchema,
  ApiRequestMetadataSchema,
  SeekSchema,
  type IFileRow,
  type IClaudeHistoryRead,
  type IRecord,
} from './types.js';
import {
  isClaudeAnswer,
  isClaudeCallFor,
  isClaudeWorkspaceCwd,
  openTranscript,
  projectDirectory,
  toClaudeDetail,
  toClaudeItem,
} from './utilities.js';

// identifies the path and record interpretation used by persisted projection entries
const HISTORY_PROJECTION_VERSION = 5;
// one record, such as a tool result holding images, and an indexing read, which fits the largest
const MAX_RECORD_BYTES = 8_388_608;
const MAX_REFRESH_BYTES = 16_777_216;
// the record bytes and serialized items of one page, which stays inside the 8 MiB IPC frame
const MAX_PAGE_BYTES = 4_194_304;
// hidden records awaiting a parent later in the file; Claude Code writes them a few lines early
const MAX_HELD_BACK_RECORDS = 64;
// the ancestors a result's call is looked for in, enough for 16 parallel calls and their results
const MAX_CALL_DISTANCE = 32;
const CHAIN = `WITH RECURSIVE current_chain AS (
  SELECT workspace_root, native_id, uuid, parent_uuid, turn_id, byte_offset, byte_length, created_at, is_visible
  FROM hq_claude_entry WHERE workspace_root = ? AND native_id = ? AND uuid = ?
  UNION SELECT hq_claude_entry.workspace_root, hq_claude_entry.native_id, hq_claude_entry.uuid, hq_claude_entry.parent_uuid,
  hq_claude_entry.turn_id, hq_claude_entry.byte_offset, hq_claude_entry.byte_length, hq_claude_entry.created_at, hq_claude_entry.is_visible
  FROM hq_claude_entry JOIN current_chain
  ON hq_claude_entry.workspace_root = current_chain.workspace_root AND hq_claude_entry.native_id = current_chain.native_id
  AND hq_claude_entry.uuid = current_chain.parent_uuid
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
  }

  /**
   * Incrementally refreshes the exact workspace and returns one seek page.
   * @returns A validated result or a private marker requesting another bounded indexing batch.
   * @throws
   * - JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE: The Claude history is unavailable
   * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
   * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
   */
  public read(command: IHqRequest): IClaudeHistoryRead {
    if (
      (command.kind !== 'threads' &&
        command.kind !== 'thread' &&
        command.kind !== 'turns' &&
        command.kind !== 'items' &&
        command.kind !== 'item-detail' &&
        command.kind !== 'session-evidence') ||
      command.provider !== 'claude'
    )
      throw new Exception('The Claude history is unavailable', {
        code: 'JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE',
        data: {
          kind: 'agent-unavailable',
        },
      });
    try {
      return this.__read(command);
    } catch (cause) {
      if (isException(cause)) throw cause;
      throw new Exception(`The Claude history is unavailable: ${extractMessage(cause)}`, {
        code: 'JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE',
        data: { kind: 'agent-unavailable' },
        cause,
      });
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
      command.kind === 'thread' || command.kind === 'item-detail'
        ? { ...command, cursor: undefined }
        : command;
    const continuation =
      command.kind === 'session-evidence' ? undefined : decodeHistoryCursor(cursor, filters);
    if (command.kind === 'session-evidence') evidencePosition(command);
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
        leaf_id, name, created_at, updated_at, supported, workspace_state FROM hq_claude_file
        WHERE workspace_root = ? AND workspace_state = 'matching' AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND native_id < ?))
        AND (? IS NULL OR instr(lower(coalesce(name, '')), lower(?)) > 0)
        ORDER BY updated_at DESC, native_id DESC LIMIT ?`,
        )
        .all(
          root,
          seek?.updatedAt ?? null,
          seek?.updatedAt ?? null,
          seek?.updatedAt ?? null,
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
              ? JSON.stringify({ updatedAt: last.updated_at, nativeId: last.native_id })
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
    if (command.kind === 'session-evidence')
      return { kind: 'session-evidence', result: this.__evidence(command, row, directory) };
    if (command.kind === 'item-detail')
      return HqResponseSchema.parse({
        kind: 'item-detail',
        result: this.__itemDetail(command, row, directory),
      });
    const seek = continuation ? this.__parseCursor(EntrySeekSchema, continuation) : undefined;
    if (seek && seek.revision !== row.revision)
      throw new Exception('The HQ cursor does not match this request', {
        code: 'JG_AGENT_HQ_CURSOR_INVALID',
        data: {
          kind: 'invalid-request',
        },
      });
    const offset = seek?.offset ?? -1;
    if (command.kind === 'turns') {
      const turns = this.__database
        .prepare(
          `SELECT turn_id, byte_offset, created_at FROM hq_claude_entry
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
    // items read newest first, the cursor holding the oldest offset read; one item is read by its UUID
    const before = seek?.offset ?? Number.MAX_SAFE_INTEGER;
    const entries = (
      command.nativeItemId === undefined
        ? this.__database
            .prepare(
              `SELECT uuid, parent_uuid, turn_id, byte_offset, byte_length, created_at, is_visible FROM hq_claude_entry
      WHERE workspace_root = ? AND native_id = ? AND is_current = 1 AND is_visible = 1 AND byte_offset < ?
      ${command.turnId === undefined ? '' : 'AND turn_id = ?'}
      ORDER BY byte_offset DESC LIMIT ?`,
            )
            .all(
              root,
              command.nativeId,
              before,
              ...(command.turnId === undefined ? [] : [command.turnId]),
              command.limit + 1,
            )
        : this.__database
            .prepare(
              `SELECT uuid, parent_uuid, turn_id, byte_offset, byte_length, created_at, is_visible FROM hq_claude_entry
      WHERE workspace_root = ? AND native_id = ? AND is_current = 1 AND is_visible = 1 AND uuid = ? AND turn_id = ?
      LIMIT 1`,
            )
            .all(root, command.nativeId, command.nativeItemId, command.turnId ?? null)
    ).map((entry) => EntryRowSchema.parse(entry));
    const page = entries.slice(0, command.limit);
    const fd = openTranscript(directory, command.nativeId);
    try {
      if (this.__identity(fd) !== row.identity || fstatSync(fd).size < row.file_size)
        this.__unavailable();
      const items = [];
      let size = 0;
      let readBytes = 0;
      let lastOffset = before;
      for (const entry of page) {
        // a page always reads its first record, which can be larger than the page budget
        if (readBytes > 0 && readBytes + entry.byte_length > MAX_PAGE_BYTES) break;
        readBytes += entry.byte_length;
        const bytes = Buffer.alloc(entry.byte_length);
        if (readSync(fd, bytes, 0, bytes.length, entry.byte_offset) !== bytes.length)
          this.__unavailable();
        const record = RecordSchema.parse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        );
        if (record.uuid !== entry.uuid || !isClaudeWorkspaceCwd(record.cwd, root))
          this.__unavailable();
        // the index stores only records the CLI shows, so a dropped one means it no longer matches
        const item = toClaudeItem(record, entry.turn_id) ?? this.__unavailable();
        const itemSize = Buffer.byteLength(JSON.stringify(item));
        if (size + itemSize > MAX_PAGE_BYTES) break;
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

  /**
   * Reads one visible item of a turn with its detail. A tool result, or a `!` shell output, is
   * paired with the call it answers among its nearest ancestors in the turn.
   * @returns The detail, or null when the turn holds no such visible item.
   */
  private __itemDetail(
    command: Extract<IHistoryRequest, { kind: 'item-detail' }>,
    row: IFileRow,
    directory: string,
  ): IItemDetail | null {
    const root = command.workspaceRoot;
    const entry = this.__entry(root, command.nativeId, command.nativeItemId);
    if (!entry || entry.is_visible !== 1 || entry.turn_id !== command.turnId) return null;
    const fd = openTranscript(directory, command.nativeId);
    try {
      if (this.__identity(fd) !== row.identity || fstatSync(fd).size < row.file_size)
        this.__unavailable();
      const record = this.__readEntry(fd, entry, root);
      const item = toClaudeItem(record, entry.turn_id) ?? this.__unavailable();
      let call: IRecord | null = null;
      if (isClaudeAnswer(record, item)) {
        let parent = entry.parent_uuid;
        let budget = MAX_REFRESH_BYTES;
        for (let step = 0; parent !== null && step < MAX_CALL_DISTANCE; step += 1) {
          const ancestor = this.__entry(root, command.nativeId, parent);
          if (!ancestor || ancestor.turn_id !== entry.turn_id || ancestor.byte_length > budget)
            break;
          budget -= ancestor.byte_length;
          const candidate = this.__readEntry(fd, ancestor, root);
          if (isClaudeCallFor(candidate, item)) {
            call = candidate;
            break;
          }
          parent = ancestor.parent_uuid;
        }
      }
      return { item, ...toClaudeDetail(record, call) };
    } finally {
      closeSync(fd);
    }
  }

  // one current entry of a session's index, visible or not
  private __entry(
    root: string,
    nativeId: string,
    uuid: string,
  ): z.infer<typeof EntryRowSchema> | null {
    const entry = this.__database
      .prepare(
        `SELECT uuid, parent_uuid, turn_id, byte_offset, byte_length, created_at, is_visible FROM hq_claude_entry
      WHERE workspace_root = ? AND native_id = ? AND uuid = ? AND is_current = 1`,
      )
      .get(root, nativeId, uuid);
    return entry === undefined ? null : EntryRowSchema.parse(entry);
  }

  // reads an entry's record, which must still be the one the index found there
  private __readEntry(fd: number, entry: z.infer<typeof EntryRowSchema>, root: string): IRecord {
    const bytes = Buffer.alloc(entry.byte_length);
    if (readSync(fd, bytes, 0, bytes.length, entry.byte_offset) !== bytes.length)
      this.__unavailable();
    const record = RecordSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    if (record.uuid !== entry.uuid || !isClaudeWorkspaceCwd(record.cwd, root)) this.__unavailable();
    return record;
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
      nativeLineage: { sessionId: row.native_id, parentThreadId: null, forkedFromId: null },
      // claude agents observations supply the live state and the terminal that runs it
      state: 'unknown',
      terminal: null,
      ownership: 'external',
      managedId: null,
      historyState: row.supported === 1 ? 'available' : 'unavailable',
    };
  }

  private __evidence(command: IEvidenceRequest, row: IFileRow, directory: string): IEvidencePage {
    const position = evidencePosition(command);
    const seek = position.sourceCursor
      ? this.__parseCursor(EntrySeekSchema, position.sourceCursor)
      : undefined;
    if (seek && seek.revision !== row.revision)
      throw new Exception('The HQ cursor does not match this request', {
        code: 'JG_AGENT_HQ_CURSOR_INVALID',
        data: { kind: 'invalid-request' },
      });
    const kinds = command.kinds === undefined ? [undefined] : [...new Set(command.kinds)];
    const entries = kinds
      .flatMap((kind) =>
        this.__database
          .prepare(
            `SELECT uuid, parent_uuid, turn_id, byte_offset, byte_length, created_at, is_visible FROM hq_claude_entry
      WHERE workspace_root = ? AND native_id = ? AND is_current = 1 AND is_visible = 1 AND byte_offset < ?
      ${command.turnId === undefined ? '' : 'AND turn_id = ?'}
      ${command.nativeItemId === undefined ? '' : 'AND uuid = ?'}
      ${kind === undefined ? '' : 'AND item_kind = ?'}
      ORDER BY byte_offset DESC LIMIT ?`,
          )
          .all(
            command.workspaceRoot,
            command.nativeId,
            seek?.offset ?? Number.MAX_SAFE_INTEGER,
            ...(command.turnId === undefined ? [] : [command.turnId]),
            ...(command.nativeItemId === undefined ? [] : [command.nativeItemId]),
            ...(kind === undefined ? [] : [kind]),
            EVIDENCE_SOURCE_PAGE_SIZE + 1,
          )
          .map((entry) => EntryRowSchema.parse(entry)),
      )
      .sort((left, right) => right.byte_offset - left.byte_offset)
      .slice(0, EVIDENCE_SOURCE_PAGE_SIZE + 1);
    const fd = openTranscript(directory, command.nativeId);
    const items = [];
    let readBytes = 0;
    let lastOffset = 0;
    try {
      if (this.__identity(fd) !== row.identity || fstatSync(fd).size < row.file_size)
        this.__unavailable();
      for (const entry of entries.slice(0, EVIDENCE_SOURCE_PAGE_SIZE)) {
        if (readBytes > 0 && readBytes + entry.byte_length > MAX_PAGE_BYTES) break;
        const bytes = Buffer.alloc(entry.byte_length);
        if (readSync(fd, bytes, 0, bytes.length, entry.byte_offset) !== bytes.length)
          this.__unavailable();
        const record = RecordSchema.parse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        );
        if (
          record.uuid !== entry.uuid ||
          (record.parentUuid ?? null) !== entry.parent_uuid ||
          record.sessionId !== command.nativeId ||
          !isClaudeWorkspaceCwd(record.cwd, command.workspaceRoot)
        )
          this.__unavailable();
        items.push(toClaudeItem(record, entry.turn_id, true) ?? this.__unavailable());
        lastOffset = entry.byte_offset;
        readBytes += entry.byte_length;
      }
      return buildEvidencePage(
        command,
        position,
        items,
        entries.length > items.length
          ? JSON.stringify({ revision: row.revision, offset: lastOffset })
          : null,
      );
    } finally {
      closeSync(fd);
    }
  }

  private __parseCursor<T>(schema: z.ZodType<T>, text: string): T {
    try {
      return schema.parse(JSON.parse(text));
    } catch (cause) {
      throw new Exception('The HQ cursor does not match this request', {
        code: 'JG_AGENT_HQ_CURSOR_INVALID',
        data: { kind: 'invalid-request' },
        cause,
      });
    }
  }

  private __file(root: string, nativeId: string): IFileRow | undefined {
    const row = this.__database
      .prepare(
        `SELECT native_id, workspace_root, identity, file_size, byte_offset, revision,
      leaf_id, name, created_at, updated_at, supported, workspace_state FROM hq_claude_file WHERE workspace_root = ? AND native_id = ?`,
      )
      .get(root, nativeId);
    return row ? FileRowSchema.parse(row) : undefined;
  }

  private __identity(fd: number): string {
    const stat = fstatSync(fd);
    if (!stat.isFile()) this.__unavailable();
    const bytes = Buffer.alloc(Math.min(stat.size, 256));
    readSync(fd, bytes, 0, bytes.length, 0);
    return `${HISTORY_PROJECTION_VERSION}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${createHash('sha256').update(bytes).digest('hex')}`;
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
        .prepare('DELETE FROM hq_claude_file WHERE workspace_root = ? AND seen != ?')
        .run(root, seen);
      if (
        this.__database
          .prepare(
            "SELECT native_id FROM hq_claude_file WHERE workspace_root = ? AND workspace_state = 'unknown' LIMIT 1",
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
          .prepare('DELETE FROM hq_claude_file WHERE workspace_root = ? AND native_id = ?')
          .run(root, nativeId);
        this.__database
          .prepare(
            `INSERT INTO hq_claude_file (workspace_root, native_id, identity, file_size, byte_offset, revision,
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
        .prepare('UPDATE hq_claude_file SET seen = ? WHERE workspace_root = ? AND native_id = ?')
        .run(seen, root, nativeId);
      if (row.supported === -1) return true;
      row.updated_at = Math.max(row.updated_at, Math.trunc(stat.mtimeMs));
      let position = row.byte_offset;
      let lineStart = position;
      const chunk = Buffer.alloc(65_536);
      // hidden records whose parent comes later in the file, by location and awaited parent
      const heldBack: { offset: number; length: number; parentUuid: string }[] = [];
      /*
       * A record read again, because it spans chunks or was held back, lands in one buffer that
       * grows to the longest such record. Each read replaces the last one's bytes, which
       * `__record` has decoded by then.
       */
      let spill = Buffer.alloc(0);
      const reread = (offset: number, length: number): Buffer => {
        if (spill.length < length) spill = Buffer.allocUnsafe(length);
        const bytes = spill.subarray(0, length);
        if (readSync(fd, bytes, 0, length, offset) !== length) this.__unavailable();
        return bytes;
      };
      const isReleasable = ({ parentUuid }: { parentUuid: string }): boolean =>
        this.__hasEntry(root, nativeId, parentUuid);
      const indexRecord = (bytes: Buffer, offset: number): void => {
        const parentUuid = this.__record(root, nativeId, row, bytes, offset, false);
        if (parentUuid !== null) {
          if (heldBack.length >= MAX_HELD_BACK_RECORDS) this.__unavailable();
          heldBack.push({ offset, length: bytes.length, parentUuid });
          return;
        }
        // a released record can be the parent of another held-back one
        for (let held = heldBack.findIndex(isReleasable); held !== -1; ) {
          const [record] = heldBack.splice(held, 1);
          if (record)
            this.__record(
              root,
              nativeId,
              row,
              reread(record.offset, record.length),
              record.offset,
              false,
            );
          held = heldBack.findIndex(isReleasable);
        }
      };
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
          const chunkStart = position;
          position += count;
          consume(count);
          // a record that started in an earlier chunk is read again whole, not joined from chunks
          const read = chunk.subarray(0, count);
          for (let end = read.indexOf(10); end !== -1; end = read.indexOf(10, end + 1)) {
            const length = chunkStart + end - lineStart;
            if (length > MAX_RECORD_BYTES) this.__unavailable();
            if (length > 0)
              indexRecord(
                lineStart >= chunkStart
                  ? read.subarray(lineStart - chunkStart, end)
                  : reread(lineStart, length),
                lineStart,
              );
            lineStart = chunkStart + end + 1;
          }
          if (position - lineStart > MAX_RECORD_BYTES) this.__unavailable();
        }
        /*
         * A parent this read didn't reach is indexed as the root of its own turn: the projection
         * keeps no position before byte_offset to retry from, and a hidden record only groups
         * the records that follow it.
         */
        for (const record of heldBack)
          this.__record(
            root,
            nativeId,
            row,
            reread(record.offset, record.length),
            record.offset,
            true,
          );
        row.byte_offset = lineStart;
        this.__database
          .prepare(
            `UPDATE hq_claude_file SET byte_offset = ?, file_size = ?, leaf_id = ?, name = ?,
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
            'UPDATE hq_claude_file SET supported = -1, workspace_state = ? WHERE workspace_root = ? AND native_id = ?',
          )
          .run(row.workspace_state, root, nativeId);
        if (isException(cause)) throw cause;
        this.__unavailable();
      }
      if (position < stat.size) return false;
      return true;
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Indexes one transcript record. Claude Code can write a hidden record, such as an attachment
   * or a scheduled-task event, a few lines before the record it follows; such a record is held
   * back unless `isOrphanAllowed`, and the caller retries it once its parent is indexed.
   * @returns Null once the record is indexed, or the UUID of the parent a held-back record awaits.
   * @throws
   * - JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE: The Claude history is unavailable
   */
  private __record(
    root: string,
    nativeId: string,
    row: IFileRow,
    bytes: Buffer,
    offset: number,
    isOrphanAllowed: boolean,
  ): string | null {
    const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const metadata = ApiRequestMetadataSchema.safeParse(input);
    if (metadata.success) {
      if (
        metadata.data.sessionId !== nativeId ||
        (metadata.data.cwd !== undefined && !isClaudeWorkspaceCwd(metadata.data.cwd, root))
      )
        this.__unavailable();
      return null;
    }
    const record = RecordSchema.parse(input);
    if (record.cwd !== undefined) {
      if (!isClaudeWorkspaceCwd(record.cwd, root) || record.sessionId !== nativeId) {
        row.workspace_state = 'foreign';
        this.__unavailable();
      }
      row.workspace_state = 'matching';
    }
    if (record.type === 'custom-title') {
      if (record.sessionId !== nativeId || record.customTitle === undefined) this.__unavailable();
      row.name = record.customTitle;
      return null;
    }
    if (record.isSidechain) return null;
    if (!record.uuid) {
      if (record.message !== undefined || record.type === 'user' || record.type === 'assistant')
        this.__unavailable();
      return null;
    }
    if (
      (record.type === 'user' || record.type === 'assistant') &&
      record.message?.role !== record.type
    )
      this.__unavailable();
    if (
      record.sessionId !== nativeId ||
      !isClaudeWorkspaceCwd(record.cwd, root) ||
      record.timestamp === undefined ||
      !Number.isFinite(Date.parse(record.timestamp))
    )
      this.__unavailable();
    const createdAt = Date.parse(record.timestamp);
    const parent = record.parentUuid
      ? this.__database
          .prepare(
            `SELECT turn_id, turn_start_offset, anchor_id FROM hq_claude_entry
      WHERE workspace_root = ? AND native_id = ? AND uuid = ?`,
          )
          .get(root, nativeId, record.parentUuid)
      : undefined;
    // the CLI's presentation decides what is shown, the kind evidence filters on and where turns start
    const item =
      record.message !== undefined && !record.isMeta ? toClaudeItem(record, record.uuid) : null;
    const visible = item !== null;
    if (record.parentUuid === record.uuid) this.__unavailable();
    if (record.parentUuid && !parent) {
      if (visible) this.__unavailable();
      if (!isOrphanAllowed) return record.parentUuid;
    }
    const textPrompt = item?.kind === 'user-message';
    const turnId = textPrompt
      ? record.uuid
      : typeof parent?.turn_id === 'string'
        ? parent.turn_id
        : record.uuid;
    const previous = this.__database
      .prepare(
        'SELECT parent_uuid FROM hq_claude_entry WHERE workspace_root = ? AND native_id = ? AND uuid = ?',
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
        `INSERT INTO hq_claude_entry (workspace_root, native_id, uuid, parent_uuid, turn_id, byte_offset,
          byte_length, created_at, is_visible, is_current, turn_start_offset, anchor_id, item_kind)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_root, native_id, uuid) DO UPDATE SET parent_uuid = excluded.parent_uuid,
      turn_id = excluded.turn_id, byte_offset = excluded.byte_offset, byte_length = excluded.byte_length,
      created_at = excluded.created_at, is_visible = excluded.is_visible, is_current = excluded.is_current,
      turn_start_offset = excluded.turn_start_offset, anchor_id = excluded.anchor_id, item_kind = excluded.item_kind`,
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
        item?.kind ?? 'unsupported',
      );
    if (visible) {
      if (!isAppend && !isSameLeaf)
        this.__database
          .prepare(
            `${CHAIN} UPDATE hq_claude_entry
        SET is_current = CASE WHEN uuid IN (SELECT uuid FROM current_chain) THEN 1 ELSE 0 END
        WHERE workspace_root = ? AND native_id = ?`,
          )
          .run(root, nativeId, record.uuid, root, nativeId);
      row.leaf_id = record.uuid;
      row.supported = 1;
    }
    row.created_at = Math.min(row.created_at, createdAt);
    row.updated_at = Math.max(row.updated_at, createdAt);
    return null;
  }

  private __hasEntry(root: string, nativeId: string, uuid: string): boolean {
    return (
      this.__database
        .prepare(
          'SELECT 1 FROM hq_claude_entry WHERE workspace_root = ? AND native_id = ? AND uuid = ?',
        )
        .get(root, nativeId, uuid) !== undefined
    );
  }

  private __unavailable(): never {
    throw new Exception('The Claude history is unavailable', {
      code: 'JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE',
      data: {
        kind: 'agent-unavailable',
      },
    });
  }
}
