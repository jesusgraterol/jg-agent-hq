import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { backup, DatabaseSync } from 'node:sqlite';
import { Exception, extractMessage, isException } from 'jg-exception';

import { getErrorKind } from '../errors/index.js';
import { STORAGE_CONNECTION_SETTINGS } from '../storage/index.js';
import { ClaudeHistoryModel } from '../providers/claude/history/index.js';

import { BrowserModel } from './browser/index.js';
import { ControlModel } from './control/index.js';
import { SessionsModel } from './sessions/index.js';
import { StoreRequestSchema, StoreWorkerSchema } from './types.js';
import { openDatabase } from './schema.js';

const options = StoreWorkerSchema.parse(workerData);
if (!parentPort) throw new Exception('The HQ store failed', { code: 'JG_AGENT_HQ_STORE_FAILED' });
const port = parentPort;
/** Starts the owned worker and reports typed startup failures before closing it. */
const startWorker = async (): Promise<void> => {
  const { database, schemaHash } = openDatabase(
    options.databasePath,
    await readFile(new URL('./schema.sql', import.meta.url), 'utf8'),
    options.actionKey,
  );
  try {
    const storage = {
      databasePath: options.databasePath,
      schemaHash,
      reservedPrefix: 'hq_',
      connectionSettings: STORAGE_CONNECTION_SETTINGS,
    };
    const browser = new BrowserModel(database, options.runtimeEpoch, options.actionKey);
    const sessions = new SessionsModel(database);
    const controls = new ControlModel(database, options.runtimeEpoch, options.actionKey);
    const claudeHistory = new ClaudeHistoryModel(database);
    const remember = database.prepare(`INSERT INTO hq_native_history_index
  (provider, native_id, workspace_root, name, created_at, updated_at, native_state, observed_at, runtime_epoch, continuation_cursor)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(provider, native_id) DO UPDATE SET
  workspace_root = excluded.workspace_root, name = excluded.name, created_at = excluded.created_at, updated_at = excluded.updated_at,
  native_state = excluded.native_state, observed_at = excluded.observed_at,
  runtime_epoch = excluded.runtime_epoch, continuation_cursor = excluded.continuation_cursor`);
    port.on('message', async (message: unknown) => {
      const parsed = StoreRequestSchema.safeParse(message);
      if (!parsed.success)
        throw new Exception('The HQ store failed', {
          code: 'JG_AGENT_HQ_STORE_FAILED',
          cause: parsed.error,
        });
      const { id, command } = parsed.data;
      try {
        if (command.kind === 'close') {
          claudeHistory.close();
          database.close();
          port.postMessage({ kind: 'result', id, result: null, error: null });
          port.close();
          return;
        }
        let result: unknown = null;
        switch (command.kind) {
          case 'snapshot-backup': {
            await backup(database, command.destination);
            const copy = new DatabaseSync(command.destination);
            try {
              copy.exec('PRAGMA journal_mode = DELETE');
            } finally {
              copy.close();
            }
            break;
          }
          case 'evidence-origins':
            result = controls.getEvidenceOrigins(command.request);
            break;
          case 'storage-maintenance': {
            const activeThread = database
              .prepare(
                "SELECT 1 FROM hq_thread WHERE runtime_epoch IS NOT NULL AND (active_turn_id IS NOT NULL OR pending_action_id IS NOT NULL OR state NOT IN ('inactive', 'idle', 'completed', 'failed', 'interrupted')) LIMIT 1",
              )
              .get();
            const activeAction = database
              .prepare(
                "SELECT 1 FROM hq_action WHERE runtime_epoch = ? AND delivery = 'submitted' LIMIT 1",
              )
              .get(options.runtimeEpoch);
            result = !activeThread && !activeAction;
            break;
          }
          case 'browser-read':
            result = browser.get(command.id, command.operatorId);
            break;
          case 'browser-admit':
            result = browser.admit(command.action, command.operatorId);
            break;
          case 'browser-settle':
            result = browser.settle(command.id, command.operatorId, command.state);
            break;
          case 'sessions-observe':
            sessions.observe(command.provider, command.sessions, command.isComplete);
            break;
          case 'sessions-unknown':
            sessions.markUnknown(command.provider);
            break;
          case 'sessions-states':
            result = sessions.states(command.provider, command.nativeIds);
            break;
          case 'session-transitions':
            result = sessions.transitions(command.afterSequence, command.limit);
            break;
          case 'sessions-active':
            result = sessions.active(command.limit);
            break;
          case 'claude-history':
            result = claudeHistory.read(command.request);
            break;
          case 'action-read':
            result = controls.getAction(command.id);
            break;
          case 'thread-read':
            result = controls.getThread(command.id);
            break;
          case 'thread-name-read':
            result = controls.getThreadByName(command.name);
            break;
          case 'thread-name-suggest':
            result = controls.suggestName(command.name);
            break;
          case 'native-thread-read':
            result = controls.getThreadByNativeId(command.provider, command.nativeId);
            break;
          case 'native-threads':
            result = controls.getNativeThreads(command.provider, command.nativeIds);
            break;
          case 'threads':
            result = controls.listThreads(command.workspaceRoot, command.page);
            break;
          case 'thread-unstarted':
            result = controls.getUnstartedThread(command.provider, command.nativeId);
            break;
          case 'threads-unstarted':
            result = controls.listUnstartedThreads(
              command.provider,
              command.workspaceRoot,
              command.limit,
            );
            break;
          case 'actions':
          case 'provider-actions':
            result = controls.listActions(
              command.kind === 'actions'
                ? { threadId: command.threadId }
                : { provider: command.provider },
              command.page,
            );
            break;
          case 'events':
            result = controls.listEvents(command.page);
            break;
          case 'approvals':
            result = controls.listApprovals(command.threadId, command.page);
            break;
          case 'admit':
            result = controls.admit(command.input);
            break;
          case 'outcome':
            result = controls.applyOutcome(command.input);
            break;
          case 'observe':
            result = controls.observe(command.input);
            break;
          case 'claim-queue':
            result = controls.claimQueued(command.threadId);
            break;
          case 'approval':
            result = controls.openApproval(command.input);
            break;
          case 'release':
            controls.releaseControls();
            break;
          case 'remember': {
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
            break;
          }
        }
        port.postMessage({ kind: 'result', id, result, error: null });
      } catch (error) {
        port.postMessage({
          kind: 'result',
          id,
          result: null,
          error: {
            code: isException(error) ? error.code : 'JG_AGENT_HQ_STORE_FAILED',
            message: isException(error)
              ? extractMessage(error)
              : `The HQ store failed: ${extractMessage(error)}`,
            kind: getErrorKind(error),
          },
        });
      }
    });
    port.postMessage({ kind: 'ready', storage });
  } catch (error) {
    database.close();
    throw error;
  }
};
try {
  await startWorker();
} catch (error) {
  port.postMessage({
    kind: 'startup-error',
    error: {
      code: isException(error) ? error.code : 'JG_AGENT_HQ_STORE_FAILED',
      message: isException(error)
        ? extractMessage(error)
        : `The HQ store failed: ${extractMessage(error)}`,
      kind: getErrorKind(error),
    },
  });
  port.close();
}
