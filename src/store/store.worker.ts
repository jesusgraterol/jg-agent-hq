import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { extractMessage, isException } from 'jg-exception';

import { HQ_ERRORS, getErrorKind } from '../errors/index.js';
import { STORAGE_CONNECTION_SETTINGS, type IStorageDescriptor } from '../storage/index.js';
import { ClaudeHistoryModel } from '../providers/claude/history/index.js';

import { BrowserModel } from './browser/index.js';
import {
  ControlAdmission,
  ControlLifecycle,
  ControlObservations,
  ControlOutcomes,
  ControlReads,
} from './control/index.js';
import { SessionsModel } from './sessions/index.js';
import type {
  IStoreError,
  IStoreModels,
  IStoreRequest,
  IStoreResponse,
  IStoreWorkerData,
} from './types.js';
import { openDatabase } from './schema.js';
import { SnapshotModel } from './snapshot.js';
import { createStatements } from './utilities.js';
import { WorkspacesModel } from './workspaces/index.js';

// the main thread built these options
const options = workerData as IStoreWorkerData;
if (!parentPort) throw HQ_ERRORS.create('storeFailed');
const port = parentPort;
const post = (response: IStoreResponse): void => port.postMessage(response);
/** Describes a failure by its code, message and kind, as the main thread rethrows it. */
const toStoreError = (error: unknown): IStoreError => ({
  code: isException(error) ? error.code : 'JG_AGENT_HQ_STORE_FAILED',
  message: isException(error)
    ? extractMessage(error)
    : `The HQ store failed: ${extractMessage(error)}`,
  kind: getErrorKind(error),
});

/** Starts the owned worker and reports typed startup failures before closing it. */
const startWorker = async (): Promise<void> => {
  const { database, schemaHash } = openDatabase(
    options.databasePath,
    await readFile(new URL('./schema.sql', import.meta.url), 'utf8'),
    options.actionKey,
  );
  try {
    const storage: IStorageDescriptor = {
      databasePath: options.databasePath,
      schemaHash,
      reservedPrefix: 'agent_hq_',
      connectionSettings: STORAGE_CONNECTION_SETTINGS,
    };
    const statements = createStatements(database);
    const { runtimeEpoch, actionKey } = options;
    // AUTOINCREMENT keeps the highest transition sequence issued, read after every call
    const readTransitionSequence = (): number =>
      statements.get<{ seq: number }>(
        "SELECT seq FROM sqlite_sequence WHERE name = 'agent_hq_session_transition'",
      )?.seq ?? 0;
    // the lifecycle quarantines what another runtime left unsettled before anything is admitted
    const claudeHistory = new ClaudeHistoryModel(database, statements);
    const outcomes = new ControlOutcomes(
      database,
      statements,
      runtimeEpoch,
      actionKey,
      (nativeId) => claudeHistory.forget(nativeId),
    );
    outcomes.finishConfirmedDeletions();
    const models: IStoreModels = {
      browser: new BrowserModel(statements, runtimeEpoch, actionKey),
      sessions: new SessionsModel(database, statements),
      lifecycle: new ControlLifecycle(database, statements, runtimeEpoch, actionKey),
      reads: new ControlReads(database, statements, runtimeEpoch, actionKey),
      admission: new ControlAdmission(database, statements, runtimeEpoch, actionKey),
      outcomes,
      observations: new ControlObservations(database, statements, runtimeEpoch, actionKey),
      claudeHistory,
      snapshot: new SnapshotModel(database),
      workspaces: new WorkspacesModel(statements),
    };
    port.on('message', async (request: IStoreRequest) => {
      const { id } = request;
      try {
        if (request.kind === 'close') {
          const transitionSequence = readTransitionSequence();
          models.claudeHistory.close();
          database.close();
          post({ kind: 'result', id, result: null, error: null, transitionSequence });
          port.close();
          return;
        }
        const model: object = models[request.model];
        const operation: unknown = Reflect.get(model, request.method);
        if (typeof operation !== 'function') throw HQ_ERRORS.create('storeFailed');
        const result: unknown = await operation.apply(model, request.args);
        post({
          kind: 'result',
          id,
          result,
          error: null,
          transitionSequence: readTransitionSequence(),
        });
      } catch (error) {
        post({
          kind: 'result',
          id,
          result: null,
          error: toStoreError(error),
          transitionSequence: readTransitionSequence(),
        });
      }
    });
    post({ kind: 'ready', storage, transitionSequence: readTransitionSequence() });
  } catch (error) {
    database.close();
    throw error;
  }
};
try {
  await startWorker();
} catch (error) {
  post({ kind: 'startup-error', error: toStoreError(error) });
  port.close();
}
