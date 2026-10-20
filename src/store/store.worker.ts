import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { Exception, extractMessage } from 'error-message-utils';

import { getErrorKind } from '../errors/index.js';
import { ClaudeHistoryModel } from '../providers/claude/history/index.js';

import { ControlModel } from './control/index.js';
import { PlansModel } from './plans/index.js';
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
const plans = new PlansModel(database);
const controls = new ControlModel(database, options.runtimeEpoch, options.actionKey, plans);
const claudeHistory = new ClaudeHistoryModel(database);
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
      claudeHistory.close();
      database.close();
      port.postMessage({ kind: 'result', id, result: null, error: null });
      port.close();
      return;
    }
    let result: unknown = null;
    switch (command.kind) {
      case 'plan-revision-project':
        plans.projectRevision(command.projection);
        break;
      case 'plan-revision-page':
        result = plans.listRevision(command.page);
        break;
      case 'thread-plan-read':
        result = plans.getThreadPlan(command.threadId);
        break;
      case 'plan-threads':
        result = plans.getPlanThreads(command.directory);
        break;
      case 'queue-peek':
        result = controls.peekQueued(command.threadId);
        break;
      case 'plan-operation':
        result = plans.getIntent(command.id);
        break;
      case 'plan-pending':
        result = plans.getPendingId(command.directory);
        break;
      case 'plan-prepare':
        result = plans.prepare(command.intent);
        break;
      case 'plan-complete':
        plans.complete(command.id);
        break;
      case 'plan-project':
        plans.project(command.projection);
        break;
      case 'plan-milestones':
        result = plans.list(command.page.directory, command.page.limit, command.page.after);
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
      case 'actions':
        result = controls.listActions(command.threadId, command.page);
        break;
      case 'events':
        result = controls.listEvents(command.page);
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
        message:
          error instanceof Exception
            ? extractMessage(error)
            : `The HQ store failed: ${extractMessage(error)}`,
        kind: getErrorKind(error),
      },
    });
  }
});
port.postMessage({ kind: 'ready' });
