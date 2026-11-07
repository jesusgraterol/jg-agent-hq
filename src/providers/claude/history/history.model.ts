import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, opendirSync, readSync, statSync, type Dir } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { hashValue } from 'jg-crypto';
import { Exception, extractMessage, hasErrorCode, isException } from 'jg-exception';
import { z } from 'zod';

import {
  type IHqRequest,
  type IItemDetail,
  type IItemImage,
  type IThreadSummary,
  type IEvidenceRequest,
  type IEvidencePage,
} from '../../../contracts/index.js';
import {
  createRequestCursors,
  decodeBase64Image,
  imageUnavailable,
  type IHistoryRequest,
} from '../../../sessions/index.js';
import {
  evidencePosition,
  buildEvidencePage,
  EVIDENCE_SOURCE_PAGE_SIZE,
} from '../../../sessions/evidence/index.js';
import { HQ_ERRORS } from '../../../errors/index.js';
import type { IStatements } from '../../../store/index.js';
import type { IThreadList, IThreadListRequest } from '../../types.js';

import {
  EntrySeekSchema,
  RecordSchema,
  ApiRequestMetadataSchema,
  SeekSchema,
  type IEntryRow,
  type IFileRow,
  type IClaudeHistoryRead,
  type IIndexingBudget,
  type IRecord,
} from './types.js';
import {
  isClaudeAnswer,
  isClaudeCallFor,
  isClaudeRecordCwd,
  isClaudeWorkspaceCwd,
  openTranscript,
  projectDirectory,
  readClaudeParentUuid,
  readClaudeQueuedInput,
  readContinuedIn,
  toClaudeDetail,
  toClaudeImageData,
  toClaudeItem,
} from './utilities.js';

// an item page continues before its oldest record
const itemCursors = createRequestCursors(EntrySeekSchema);
// a thread page's continuation: the activity time and session ID of the last transcript listed
const THREAD_CURSOR = /^(\d{1,16}):(.+)$/;

// identifies the path and record interpretation used by persisted projection entries
const HISTORY_PROJECTION_VERSION = 11;
// the transcripts whose continuing session is remembered, oldest dropped first
const MAX_CONTINUED_ANSWERS = 1_024;
// one record, such as a tool result holding images
const MAX_RECORD_BYTES = 33_554_432;
/*
 * The new transcript bytes one worker call indexes, half of what a second indexes at the slowest
 * measured rate, so a call stays well under a second; docs/architecture.md records the measurement.
 * A call whose first record is larger reads that record whole.
 */
const INDEXING_BUDGET_BYTES = 8_388_608;
// the ancestor record bytes an item detail reads in one call while it looks for a result's call,
// which stays well under a second; docs/architecture.md records the measurement
const MAX_CALL_SEARCH_BYTES = 67_108_864;
// the record bytes and serialized items of one page, which stays well inside the IPC frame
const MAX_PAGE_BYTES = 4_194_304;
// hidden records awaiting a parent later in the file; Claude Code writes them a few lines early
const MAX_HELD_BACK_RECORDS = 64;
// the ancestors a result's call is looked for in, enough for 16 parallel calls and their results
const MAX_CALL_DISTANCE = 32;
// the statements indexing runs for every record, which the worker's statement cache prepares once
const PARENT_TURN = `SELECT turn_id, turn_start_offset, anchor_id, is_current FROM agent_hq_claude_entry
WHERE workspace_root = ? AND native_id = ? AND uuid = ?`;
const RECORDED_PARENT =
  'SELECT parent_uuid FROM agent_hq_claude_entry WHERE workspace_root = ? AND native_id = ? AND uuid = ?';
const UPSERT_ENTRY = `INSERT INTO agent_hq_claude_entry (workspace_root, native_id, uuid, parent_uuid, turn_id, byte_offset,
  byte_length, created_at, is_visible, is_current, turn_start_offset, anchor_id, item_kind)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_root, native_id, uuid) DO UPDATE SET parent_uuid = excluded.parent_uuid,
turn_id = excluded.turn_id, byte_offset = excluded.byte_offset, byte_length = excluded.byte_length,
created_at = excluded.created_at, is_visible = excluded.is_visible, is_current = excluded.is_current,
turn_start_offset = excluded.turn_start_offset, anchor_id = excluded.anchor_id, item_kind = excluded.item_kind`;
const HAS_ENTRY =
  'SELECT 1 FROM agent_hq_claude_entry WHERE workspace_root = ? AND native_id = ? AND uuid = ?';
// the current chain runs from a leaf back through its parents
const CHAIN = `WITH RECURSIVE current_chain AS (
  SELECT workspace_root, native_id, uuid, parent_uuid, turn_id, byte_offset, byte_length, created_at, is_visible
  FROM agent_hq_claude_entry WHERE workspace_root = ? AND native_id = ? AND uuid = ?
  UNION SELECT agent_hq_claude_entry.workspace_root, agent_hq_claude_entry.native_id, agent_hq_claude_entry.uuid, agent_hq_claude_entry.parent_uuid,
  agent_hq_claude_entry.turn_id, agent_hq_claude_entry.byte_offset, agent_hq_claude_entry.byte_length, agent_hq_claude_entry.created_at, agent_hq_claude_entry.is_visible
  FROM agent_hq_claude_entry JOIN current_chain
  ON agent_hq_claude_entry.workspace_root = current_chain.workspace_root AND agent_hq_claude_entry.native_id = current_chain.native_id
  AND agent_hq_claude_entry.uuid = current_chain.parent_uuid
)`;
const CURRENT_CHAIN = `${CHAIN} UPDATE agent_hq_claude_entry
SET is_current = CASE WHEN uuid IN (SELECT uuid FROM current_chain) THEN 1 ELSE 0 END
WHERE workspace_root = ? AND native_id = ?`;
// the turn, start and anchor an indexed entry gives the records that follow it
type IParentTurnRow = {
  turn_id: string;
  turn_start_offset: number | null;
  anchor_id: string | null;
  is_current: number;
};

/**
 * Owns a replaceable metadata/byte-location projection, never conversation bodies.
 * All synchronous work runs in the existing SQLite worker, one file at a time.
 */
export class ClaudeHistoryModel {
  private readonly __database: DatabaseSync;
  // the session each indexed transcript's chat continues in, by the file size and time it was read at
  private readonly __continued = new Map<
    string,
    { fileSize: number; modifiedAt: number | null; continuedIn: string | null }
  >();
  /*
   * Each workspace's open directory scan, with the transcripts it has inspected so far and the
   * directory's modification time when it opened, which an added or removed transcript changes.
   */
  private readonly __scans = new Map<
    string,
    { entries: Dir; seen: Set<string>; pending: string | null; changedAt: number }
  >();
  private readonly __statements: IStatements;

  public constructor(database: DatabaseSync, statements: IStatements) {
    this.__database = database;
    this.__statements = statements;
  }

  /**
   * Incrementally refreshes the exact workspace and returns one seek page.
   * @returns A validated result or a private marker requesting another bounded indexing batch.
   * @throws
   * - JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE: The Claude history is unavailable
   * - JG_AGENT_HQ_IMAGE_UNAVAILABLE: The HQ image is unavailable
   * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
   * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
   */
  public read(command: IHqRequest): IClaudeHistoryRead {
    if (
      (command.kind !== 'thread' &&
        command.kind !== 'items' &&
        command.kind !== 'item-detail' &&
        command.kind !== 'item-image' &&
        command.kind !== 'session-evidence') ||
      command.provider !== 'claude'
    )
      throw HQ_ERRORS.create('claudeHistoryUnavailable', {
        data: { kind: 'agent-unavailable' },
      });
    return this.__guard(() => this.__read(command));
  }

  /**
   * Lists one page of a workspace's transcripts, last activity first, then session ID descending.
   * A first page refreshes the index first; a continuation seeks the index without a refresh.
   * @param workspaceRoot The canonical workspace.
   * @param page The name search, page size and continuation.
   * @returns The page, or `indexing` while the first page's refresh has more to index.
   * @throws
   * - JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE: The Claude history is unavailable
   * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
   */
  public list(workspaceRoot: string, page: IThreadListRequest): IThreadList | 'indexing' {
    // a continuation that isn't this reader's fails before any transcript is read
    const seek = page.cursor === null ? undefined : this.__threadSeek(page.cursor);
    return this.__guard(() => {
      let directory: string;
      try {
        directory = projectDirectory(workspaceRoot);
      } catch (cause) {
        if (hasErrorCode(cause, 'ENOENT')) return { data: [], nextCursor: null };
        throw cause;
      }
      if (!seek && !this.__refresh(directory, workspaceRoot)) return 'indexing';
      // a row-value seek, so a continuation starts in the index rather than scanning earlier pages
      const after = seek ? 'AND (updated_at, native_id) < (?, ?)' : '';
      const rows = this.__statements.all<IFileRow>(
        `SELECT native_id, workspace_root, identity, file_size, modified_at, byte_offset, revision,
        leaf_id, name, created_at, updated_at, supported, workspace_state FROM agent_hq_claude_file
        WHERE workspace_root = ? AND workspace_state = 'matching' ${after}
        AND (? IS NULL OR instr(lower(coalesce(name, '')), lower(?)) > 0)
        ORDER BY updated_at DESC, native_id DESC LIMIT ?`,
        workspaceRoot,
        ...(seek ? [seek.updatedAt, seek.nativeId] : []),
        page.search ?? null,
        page.search ?? null,
        page.limit + 1,
      );
      const listed = rows.slice(0, page.limit);
      const last = listed.at(-1);
      return {
        data: listed.map((row) => this.__summary(row, directory)),
        nextCursor:
          rows.length > page.limit && last ? `${last.updated_at}:${last.native_id}` : null,
      };
    });
  }

  /**
   * Lists the workspaces the index holds transcripts of, by their latest activity, newest first.
   * @param limit The most workspaces to list.
   * @returns Their roots.
   */
  public indexedRoots(limit: number): string[] {
    return this.__statements
      .all<{
        workspace_root: string;
      }>(
        'SELECT workspace_root FROM agent_hq_claude_file GROUP BY workspace_root ORDER BY max(updated_at) DESC LIMIT ?',
        limit,
      )
      .map((row) => row.workspace_root);
  }

  /**
   * Forgets a deleted session's transcript: its rows leave the index, and directory scans in
   * progress start over, so none reads the transcript that is gone.
   * @param nativeId The session's ID.
   */
  public forget(nativeId: string): void {
    this.close();
    this.__statements.run('DELETE FROM agent_hq_claude_file WHERE native_id = ?', nativeId);
  }

  /** Releases incomplete discovery iterators before the worker closes SQLite. */
  public close(): void {
    for (const scan of this.__scans.values()) scan.entries.closeSync();
    this.__scans.clear();
  }

  // classifies a failure that isn't one of HQ's own exceptions as unavailable history
  private __guard<T>(read: () => T): T {
    try {
      return read();
    } catch (cause) {
      if (isException(cause)) throw cause;
      throw new Exception(`The Claude history is unavailable: ${extractMessage(cause)}`, {
        code: 'JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE',
        data: { kind: 'agent-unavailable' },
        cause,
      });
    }
  }

  private __read(command: IHistoryRequest): IClaudeHistoryRead {
    const root = command.workspaceRoot;
    const { cursor, ...filters } =
      command.kind === 'thread' || command.kind === 'item-detail' || command.kind === 'item-image'
        ? { ...command, cursor: undefined }
        : command;
    // a cursor that doesn't continue this request fails before any transcript is read
    const itemSeek = command.kind === 'items' ? itemCursors.decode(cursor, filters) : undefined;
    if (command.kind === 'session-evidence') evidencePosition(command);
    const directory = projectDirectory(root);
    let isIndexed: boolean;
    try {
      isIndexed = this.__inspect(directory, root, command.nativeId, {
        bytes: INDEXING_BUDGET_BYTES,
        hasIndexed: false,
      });
    } catch (cause) {
      // as a scan does, a summary keeps a transcript the index marked unsupported
      if (command.kind !== 'thread' || this.__file(root, command.nativeId)?.supported !== -1)
        throw cause;
      isIndexed = true;
    }
    // a scan still running counts this transcript as seen, so its completion keeps it
    this.__scans.get(root)?.seen.add(command.nativeId);
    if (!isIndexed) return { kind: 'indexing' };
    const row = this.__file(root, command.nativeId);
    // a transcript whose records aren't supported still has a summary, its history unavailable
    if (command.kind === 'thread') {
      if (row?.workspace_state !== 'matching') this.__unavailable();
      return { kind: 'thread', result: this.__summary(row, directory) };
    }
    if (!row || row.supported !== 1 || row.workspace_state !== 'matching') this.__unavailable();
    if (command.kind === 'session-evidence')
      return { kind: 'session-evidence', result: this.__evidence(command, row, directory) };
    if (command.kind === 'item-detail')
      return {
        kind: 'item-detail',
        result: this.__itemDetail(command, row, directory),
      };
    if (command.kind === 'item-image')
      return {
        kind: 'item-image',
        result: this.__itemImage(command, row, directory),
      };
    const seek = itemSeek;
    if (seek && seek.revision !== row.revision)
      throw HQ_ERRORS.create('cursorInvalid', {
        data: { kind: 'invalid-request' },
      });
    // items read newest first, the cursor holding the oldest offset read; one item is read by its UUID
    const before = seek?.offset ?? Number.MAX_SAFE_INTEGER;
    const entries =
      command.nativeItemId === undefined
        ? this.__statements.all<IEntryRow>(
            `SELECT uuid, parent_uuid, turn_id, byte_offset, byte_length, created_at, is_visible FROM agent_hq_claude_entry
      WHERE workspace_root = ? AND native_id = ? AND is_current = 1 AND is_visible = 1 AND byte_offset < ?
      ${command.turnId === undefined ? '' : 'AND turn_id = ?'}
      ORDER BY byte_offset DESC LIMIT ?`,
            root,
            command.nativeId,
            before,
            ...(command.turnId === undefined ? [] : [command.turnId]),
            command.limit + 1,
          )
        : this.__statements.all<IEntryRow>(
            `SELECT uuid, parent_uuid, turn_id, byte_offset, byte_length, created_at, is_visible FROM agent_hq_claude_entry
      WHERE workspace_root = ? AND native_id = ? AND is_current = 1 AND is_visible = 1 AND uuid = ? AND turn_id = ?
      LIMIT 1`,
            root,
            command.nativeId,
            command.nativeItemId,
            command.turnId ?? null,
          );
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
        if (record.uuid !== entry.uuid || !isClaudeRecordCwd(record.cwd, root))
          this.__unavailable();
        // the index stores only records the CLI shows, so a dropped one means it no longer matches
        const item = toClaudeItem(record, entry.turn_id) ?? this.__unavailable();
        const itemSize = Buffer.byteLength(JSON.stringify(item));
        if (size + itemSize > MAX_PAGE_BYTES) break;
        size += itemSize;
        lastOffset = entry.byte_offset;
        items.push(item);
      }
      return {
        kind: 'items',
        result: {
          data: items,
          history: 'persisted',
          source: 'native',
          nextCursor: itemCursors.encode(
            entries.length > items.length ? { revision: row.revision, offset: lastOffset } : null,
            filters,
          ),
        },
      };
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
        let budget = MAX_CALL_SEARCH_BYTES;
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

  /**
   * Reads one image a visible item of a turn holds in its record.
   * @returns The image.
   * @throws
   * - JG_AGENT_HQ_IMAGE_UNAVAILABLE: The HQ image is unavailable
   * - JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE: The Claude history is unavailable
   */
  private __itemImage(
    command: Extract<IHistoryRequest, { kind: 'item-image' }>,
    row: IFileRow,
    directory: string,
  ): IItemImage {
    const root = command.workspaceRoot;
    const entry = this.__entry(root, command.nativeId, command.nativeItemId);
    if (!entry || entry.is_visible !== 1 || entry.turn_id !== command.turnId)
      return imageUnavailable();
    const fd = openTranscript(directory, command.nativeId);
    try {
      if (this.__identity(fd) !== row.identity || fstatSync(fd).size < row.file_size)
        this.__unavailable();
      const data = toClaudeImageData(this.__readEntry(fd, entry, root))[command.index];
      return data ? decodeBase64Image(data) : imageUnavailable();
    } finally {
      closeSync(fd);
    }
  }

  // one current entry of a session's index, visible or not
  private __entry(root: string, nativeId: string, uuid: string): IEntryRow | null {
    const entry = this.__statements.get<IEntryRow>(
      `SELECT uuid, parent_uuid, turn_id, byte_offset, byte_length, created_at, is_visible FROM agent_hq_claude_entry
      WHERE workspace_root = ? AND native_id = ? AND uuid = ? AND is_current = 1`,
      root,
      nativeId,
      uuid,
    );
    return entry ?? null;
  }

  // reads an entry's record, which must still be the one the index found there
  private __readEntry(fd: number, entry: IEntryRow, root: string): IRecord {
    const bytes = Buffer.alloc(entry.byte_length);
    if (readSync(fd, bytes, 0, bytes.length, entry.byte_offset) !== bytes.length)
      this.__unavailable();
    const record = RecordSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    if (record.uuid !== entry.uuid || !isClaudeRecordCwd(record.cwd, root)) this.__unavailable();
    return record;
  }

  /**
   * Summarizes one indexed transcript. Which session its chat continues in comes from its end, read
   * once per file size and modification time.
   */
  private __summary(row: IFileRow, directory: string): IThreadSummary {
    const key = JSON.stringify([row.workspace_root, row.native_id]);
    let continued = this.__continued.get(key);
    if (continued?.fileSize !== row.file_size || continued.modifiedAt !== row.modified_at) {
      continued = {
        fileSize: row.file_size,
        modifiedAt: row.modified_at,
        continuedIn: readContinuedIn(directory, row.native_id),
      };
      this.__continued.delete(key);
      this.__continued.set(key, continued);
      if (this.__continued.size > MAX_CONTINUED_ANSWERS)
        this.__continued.delete(this.__continued.keys().next().value!);
    }
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
      backgroundCommands: 0,
      continuedIn: continued.continuedIn,
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
      throw HQ_ERRORS.create('cursorInvalid', { data: { kind: 'invalid-request' } });
    const kinds = command.kinds === undefined ? [undefined] : [...new Set(command.kinds)];
    const entries = kinds
      .flatMap((kind) =>
        this.__statements.all<IEntryRow>(
          `SELECT uuid, parent_uuid, turn_id, byte_offset, byte_length, created_at, is_visible FROM agent_hq_claude_entry
      WHERE workspace_root = ? AND native_id = ? AND is_current = 1 AND is_visible = 1 AND byte_offset < ?
      ${command.turnId === undefined ? '' : 'AND turn_id = ?'}
      ${command.nativeItemId === undefined ? '' : 'AND uuid = ?'}
      ${kind === undefined ? '' : 'AND item_kind = ?'}
      ORDER BY byte_offset DESC LIMIT ?`,
          command.workspaceRoot,
          command.nativeId,
          seek?.offset ?? Number.MAX_SAFE_INTEGER,
          ...(command.turnId === undefined ? [] : [command.turnId]),
          ...(command.nativeItemId === undefined ? [] : [command.nativeItemId]),
          ...(kind === undefined ? [] : [kind]),
          EVIDENCE_SOURCE_PAGE_SIZE + 1,
        ),
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
          readClaudeParentUuid(record) !== entry.parent_uuid ||
          record.sessionId !== command.nativeId ||
          !isClaudeRecordCwd(record.cwd, command.workspaceRoot)
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

  /**
   * Reads a thread page's continuation, `<updatedAt>:<nativeId>` of the last transcript listed.
   * @throws
   * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
   */
  private __threadSeek(cursor: string): z.infer<typeof SeekSchema> {
    const [, updatedAt, nativeId] = THREAD_CURSOR.exec(cursor) ?? [];
    const seek = SeekSchema.safeParse({ updatedAt: Number(updatedAt), nativeId });
    if (!seek.success)
      throw HQ_ERRORS.create('cursorInvalid', { data: { kind: 'invalid-request' } });
    return seek.data;
  }

  private __parseCursor<T>(schema: z.ZodType<T>, text: string): T {
    try {
      return schema.parse(JSON.parse(text));
    } catch (cause) {
      throw HQ_ERRORS.create('cursorInvalid', { data: { kind: 'invalid-request' }, cause });
    }
  }

  private __file(root: string, nativeId: string): IFileRow | undefined {
    const row = this.__statements.get<IFileRow>(
      `SELECT native_id, workspace_root, identity, file_size, modified_at, byte_offset, revision,
      leaf_id, name, created_at, updated_at, supported, workspace_state FROM agent_hq_claude_file WHERE workspace_root = ? AND native_id = ?`,
      root,
      nativeId,
    );
    return row;
  }

  private __identity(fd: number): string {
    const stat = fstatSync(fd);
    if (!stat.isFile()) this.__unavailable();
    const bytes = Buffer.alloc(Math.min(stat.size, 256));
    readSync(fd, bytes, 0, bytes.length, 0);
    return `${HISTORY_PROJECTION_VERSION}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${hashValue(bytes)}`;
  }

  /**
   * Indexes one budgeted piece of a workspace's directory scan, continuing the scan a call before
   * it left open. A directory whose transcripts were added or removed since its scan opened is
   * scanned again from its start, since a directory iterator may skip entries added after it
   * opened, so a scan that completes saw every transcript the directory held as it did.
   * @returns Whether the scan completed.
   * @throws
   * - JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE: The Claude history is unavailable
   */
  private __refresh(directory: string, root: string): boolean {
    const changedAt = statSync(directory).mtimeMs;
    let scan = this.__scans.get(root);
    if (scan && scan.changedAt !== changedAt) {
      scan.entries.closeSync();
      this.__scans.delete(root);
      scan = undefined;
    }
    if (!scan) {
      if (this.__scans.size >= 4) {
        const oldest = this.__scans.entries().next().value!;
        oldest[1].entries.closeSync();
        this.__scans.delete(oldest[0]);
      }
      scan = { entries: opendirSync(directory), seen: new Set(), pending: null, changedAt };
      this.__scans.set(root, scan);
    }
    const { seen } = scan;
    const budget: IIndexingBudget = { bytes: INDEXING_BUDGET_BYTES, hasIndexed: false };
    let isComplete = false;
    try {
      // a spent budget leaves the next transcript to the next call
      for (let inspected = 0; inspected < 128 && budget.bytes > 0; inspected += 1) {
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
        // an inspected transcript stays in the index, even one whose records are unsupported
        seen.add(nativeId);
        try {
          if (!this.__inspect(directory, root, nativeId, budget)) {
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
      // transcripts the scan didn't see were removed, so they leave the index with their entries;
      // finding them with a read first keeps a scan of unchanged transcripts from writing
      const removed = this.__statements
        .all<{ native_id: string }>(
          'SELECT native_id FROM agent_hq_claude_file WHERE workspace_root = ?',
          root,
        )
        .map((row) => row.native_id)
        .filter((nativeId) => !seen.has(nativeId));
      if (removed.length) {
        this.__database.exec('BEGIN IMMEDIATE');
        try {
          for (const nativeId of removed)
            this.__statements.run(
              'DELETE FROM agent_hq_claude_file WHERE workspace_root = ? AND native_id = ?',
              root,
              nativeId,
            );
          this.__database.exec('COMMIT');
        } catch (cause) {
          this.__database.exec('ROLLBACK');
          throw cause;
        }
      }
      if (
        this.__statements.get(
          "SELECT native_id FROM agent_hq_claude_file WHERE workspace_root = ? AND workspace_state = 'unknown' LIMIT 1",
          root,
        )
      )
        this.__unavailable();
    }
    return isComplete;
  }

  /**
   * Indexes a transcript's records past the position the index reached, within the call's budget,
   * which it spends; the call's first record is read whole, whatever its size. A transcript whose
   * identity, size and modification time match an index that reached its end is left as it is,
   * without a write.
   * @returns Whether the index reached the transcript's end.
   * @throws
   * - JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE: The Claude history is unavailable
   */
  private __inspect(
    directory: string,
    root: string,
    nativeId: string,
    budget: IIndexingBudget,
  ): boolean {
    const fd = openTranscript(directory, nativeId);
    try {
      const stat = fstatSync(fd);
      const identity = this.__identity(fd);
      let row = this.__file(root, nativeId);
      if (
        row?.identity === identity &&
        row.file_size === stat.size &&
        row.modified_at === stat.mtimeMs
      )
        return true;
      if (!row || row.identity !== identity || stat.size < row.file_size) {
        const revision = randomUUID();
        this.__statements.run(
          'DELETE FROM agent_hq_claude_file WHERE workspace_root = ? AND native_id = ?',
          root,
          nativeId,
        );
        this.__statements.run(
          `INSERT INTO agent_hq_claude_file (workspace_root, native_id, identity, file_size, modified_at, byte_offset,
            revision, leaf_id, name, created_at, updated_at, supported, workspace_state)
            VALUES (?, ?, ?, ?, NULL, 0, ?, NULL, NULL, ?, ?, 0, 'unknown')`,
          root,
          nativeId,
          identity,
          stat.size,
          revision,
          Math.trunc(stat.birthtimeMs),
          Math.trunc(stat.mtimeMs),
        );
        row = this.__file(root, nativeId)!;
      }
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
      // where this call started in the transcript, and whether it had the call's whole budget
      const start = position;
      const hasWholeBudget = !budget.hasIndexed;
      /*
       * The location of the first record held back now and the index's fields before it, with a
       * savepoint there: a budgeted stop returns to it, so the next call indexes the hidden
       * record together with the parent that follows it.
       */
      let beforeHeld = null as { offset: number; row: IFileRow } | null;
      const indexRecord = (bytes: Buffer, offset: number): void => {
        const workspaceState = row.workspace_state;
        const parentUuid = this.__record(root, nativeId, row, bytes, offset, false);
        if (parentUuid !== null) {
          if (heldBack.length >= MAX_HELD_BACK_RECORDS) this.__unavailable();
          if (!heldBack.length) {
            this.__database.exec('SAVEPOINT agent_hq_held_back');
            beforeHeld = { offset, row: { ...row, workspace_state: workspaceState } };
          }
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
        if (beforeHeld && !heldBack.length) {
          this.__database.exec('RELEASE agent_hq_held_back');
          beforeHeld = null;
        }
      };
      this.__database.exec('BEGIN IMMEDIATE');
      try {
        // a call that hasn't indexed a record yet reads on past its budget to the first record's end
        while (position < stat.size && (budget.bytes > 0 || !budget.hasIndexed)) {
          const count = readSync(
            fd,
            chunk,
            0,
            Math.min(
              chunk.length,
              stat.size - position,
              budget.bytes > 0 ? budget.bytes : Infinity,
            ),
            position,
          );
          if (count === 0) break;
          const chunkStart = position;
          position += count;
          budget.bytes -= count;
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
            budget.hasIndexed = true;
          }
          if (position - lineStart > MAX_RECORD_BYTES) this.__unavailable();
        }
        /*
         * A budgeted stop returns to before the records held back, unless this call held them
         * from where it started through its whole budget, so their parent isn't coming soon.
         */
        if (position < stat.size && beforeHeld && (beforeHeld.offset > start || !hasWholeBudget)) {
          this.__database.exec('ROLLBACK TO agent_hq_held_back');
          Object.assign(row, beforeHeld.row);
          lineStart = beforeHeld.offset;
          heldBack.length = 0;
        }
        /*
         * Otherwise a parent this read didn't reach is indexed as the root of its own turn: the
         * projection keeps no position before byte_offset to retry from, and a hidden record only
         * groups the records that follow it. At the transcript's end the parent may never come,
         * and returning there would hide the records after the hidden one from this read.
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
        this.__statements.run(
          `UPDATE agent_hq_claude_file SET byte_offset = ?, file_size = ?, modified_at = ?, leaf_id = ?, name = ?,
          created_at = ?, updated_at = ?, supported = ?, revision = ?, workspace_state = ? WHERE workspace_root = ? AND native_id = ?`,
          lineStart,
          stat.size,
          // an index the budget stopped short of the end has more to read
          position < stat.size ? null : stat.mtimeMs,
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
        this.__statements.run(
          'UPDATE agent_hq_claude_file SET supported = -1, workspace_state = ? WHERE workspace_root = ? AND native_id = ?',
          row.workspace_state,
          root,
          nativeId,
        );
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
        (metadata.data.cwd !== undefined && !isClaudeRecordCwd(metadata.data.cwd, root))
      )
        this.__unavailable();
      return null;
    }
    const record = RecordSchema.parse(input);
    if (record.cwd !== undefined) {
      if (!isClaudeRecordCwd(record.cwd, root) || record.sessionId !== nativeId) {
        row.workspace_state = 'foreign';
        this.__unavailable();
      }
      /*
       * Punctuation replacement can give two workspaces one native directory, so the transcript
       * belongs to this workspace once one of its records ran inside it. Until then it stays
       * foreign, which leaves it out without making it unreadable for good.
       */
      if (row.workspace_state !== 'matching')
        row.workspace_state = isClaudeWorkspaceCwd(record.cwd, root) ? 'matching' : 'foreign';
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
      !isClaudeRecordCwd(record.cwd, root) ||
      record.timestamp === undefined ||
      !Number.isFinite(Date.parse(record.timestamp))
    )
      this.__unavailable();
    const createdAt = Date.parse(record.timestamp);
    const nativeParentUuid = readClaudeParentUuid(record);
    const nativeParent = nativeParentUuid
      ? this.__statements.get<IParentTurnRow>(PARENT_TURN, root, nativeId, nativeParentUuid)
      : undefined;
    // a message sent while a turn ran is an attachment that shows, though it starts no turn
    const isQueuedInput = readClaudeQueuedInput(record) !== null;
    // the CLI's presentation decides what is shown, the kind evidence filters on and where turns start
    const item =
      (record.message !== undefined || isQueuedInput) && !record.isMeta
        ? toClaudeItem(record, record.uuid)
        : null;
    const visible = item !== null;
    if (nativeParentUuid === record.uuid) this.__unavailable();
    if (nativeParentUuid && !nativeParent) {
      // an attachment may come a few lines before its parent, so a queued message waits like one
      if (visible && !isQueuedInput) this.__unavailable();
      /*
       * A compaction's boundary has no parent and names the record before it, which is indexed
       * by then when this transcript holds it. Otherwise it is the old session's, in the
       * transcript a moved chat continues from, or one Claude Code wrote after the boundary, so
       * the boundary starts its chain at once rather than holding back the summary that follows.
       */
      if (!isOrphanAllowed && record.parentUuid != null) return nativeParentUuid;
    }
    const previous = this.__statements.get<{ parent_uuid: string | null }>(
      RECORDED_PARENT,
      root,
      nativeId,
      record.uuid,
    );
    const isCallResult =
      item?.nativeType === 'tool-result' &&
      nativeParentUuid !== null &&
      record.sourceToolAssistantUUID === nativeParentUuid;
    // a result indexed again keeps the record it was made to follow
    const parentUuid =
      isCallResult && typeof previous?.parent_uuid === 'string'
        ? previous.parent_uuid
        : isCallResult && !previous
          ? this.__resultParent(root, nativeId, row, nativeParentUuid, nativeParent)
          : nativeParentUuid;
    const parent =
      parentUuid === nativeParentUuid
        ? nativeParent
        : this.__statements.get<IParentTurnRow>(PARENT_TURN, root, nativeId, parentUuid!);
    const textPrompt = item?.kind === 'user-message' && !isQueuedInput;
    const turnId = textPrompt
      ? record.uuid
      : typeof parent?.turn_id === 'string'
        ? parent.turn_id
        : record.uuid;
    if (previous && previous.parent_uuid !== parentUuid) this.__unavailable();
    const isAppend = row.leaf_id === null || parent?.anchor_id === row.leaf_id;
    const isSameLeaf = record.uuid === row.leaf_id && previous?.parent_uuid === parentUuid;
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
    this.__statements.run(
      UPSERT_ENTRY,
      root,
      nativeId,
      record.uuid,
      parentUuid,
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
        this.__statements.run(CURRENT_CHAIN, root, nativeId, record.uuid, root, nativeId);
      row.leaf_id = record.uuid;
      row.supported = 1;
    }
    row.created_at = Math.min(row.created_at, createdAt);
    row.updated_at = Math.max(row.updated_at, createdAt);
    return null;
  }

  /**
   * Claude Code links a tool result to its own call. When parallel calls finish out of order, an
   * earlier call is no longer the leaf, so its result would start a side branch that the current
   * chain leaves out, with the calls and results written after that call. Such a result follows
   * the leaf of its call's turn instead, which keeps one response's calls and all their results
   * on the chain; the record after them follows the last result written, the leaf by then.
   * @returns The record the result follows in the projection: the leaf, or its own call.
   */
  private __resultParent(
    root: string,
    nativeId: string,
    row: IFileRow,
    callUuid: string,
    call: IParentTurnRow | undefined,
  ): string {
    if (
      row.leaf_id === null ||
      call?.is_current !== 1 ||
      call.anchor_id !== callUuid ||
      call.anchor_id === row.leaf_id
    )
      return callUuid;
    const leaf = this.__statements.get<IParentTurnRow>(PARENT_TURN, root, nativeId, row.leaf_id);
    return leaf?.is_current === 1 && leaf.turn_id === call.turn_id ? row.leaf_id : callUuid;
  }

  private __hasEntry(root: string, nativeId: string, uuid: string): boolean {
    return this.__statements.get(HAS_ENTRY, root, nativeId, uuid) !== undefined;
  }

  private __unavailable(): never {
    throw HQ_ERRORS.create('claudeHistoryUnavailable', {
      data: { kind: 'agent-unavailable' },
    });
  }
}
