import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { Exception, extractMessage } from 'error-message-utils';

import { StoreRequestSchema, StoreWorkerSchema } from './types.js';

const options = StoreWorkerSchema.parse(workerData);
if (!parentPort) throw new Exception('The HQ store failed');
const port = parentPort;
const database = new DatabaseSync(options.databasePath, {
  timeout: 5000,
  enableForeignKeyConstraints: true,
});
database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
database.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
const remember = database.prepare(`INSERT INTO native_history_index
  (provider, native_id, workspace_root, name, created_at, updated_at, native_state, observed_at, runtime_epoch, continuation_cursor)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(provider, native_id) DO UPDATE SET
  workspace_root = excluded.workspace_root, name = excluded.name, created_at = excluded.created_at, updated_at = excluded.updated_at,
  native_state = excluded.native_state, observed_at = excluded.observed_at,
  runtime_epoch = excluded.runtime_epoch, continuation_cursor = excluded.continuation_cursor`);
port.on('message', (message: unknown) => {
  const parsed = StoreRequestSchema.safeParse(message);
  if (!parsed.success)
    throw new Exception('The HQ store failed', undefined, undefined, { cause: parsed.error });
  const { id, command } = parsed.data;
  try {
    if (command.kind === 'close') {
      database.close();
      port.postMessage({ kind: 'result', id, error: null });
      port.close();
      return;
    }
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const thread of command.threads)
        remember.run(
          thread.provider,
          thread.nativeId,
          thread.workspaceRoot,
          thread.name,
          thread.createdAt,
          thread.updatedAt,
          thread.nativeState,
          command.observedAt,
          options.runtimeEpoch,
          command.nextCursor,
        );
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    port.postMessage({ kind: 'result', id, error: null });
  } catch (error) {
    port.postMessage({ kind: 'result', id, error: extractMessage(error) });
  }
});
port.postMessage({ kind: 'ready' });
