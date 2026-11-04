import { parentPort, workerData } from 'node:worker_threads';
import { Exception, extractMessage, isException } from 'jg-exception';

import { HQ_ERRORS } from '../errors/index.js';
import { verifySnapshot, restoreSnapshot } from './database.js';
import { SnapshotWorkerInputSchema } from './types.js';

const port = parentPort;
if (!port) throw HQ_ERRORS.create('snapshotFailed');
try {
  const input = SnapshotWorkerInputSchema.parse(workerData);
  const result =
    input.kind === 'inspect'
      ? await verifySnapshot(input.directory)
      : await restoreSnapshot(input.directory, input.destination);
  port.postMessage({ kind: 'result', result });
} catch (cause) {
  const error =
    isException(cause) &&
    [
      'JG_AGENT_HQ_SNAPSHOT_INVALID',
      'JG_AGENT_HQ_SNAPSHOT_FAILED',
      'JG_AGENT_HQ_STORAGE_INVALID',
    ].includes(cause.code)
      ? cause
      : new Exception(`The HQ snapshot operation failed: ${extractMessage(cause)}`, {
          code: 'JG_AGENT_HQ_SNAPSHOT_FAILED',
          data: { kind: 'operation-failed' },
          cause,
        });
  port.postMessage({
    kind: 'error',
    ...error.toJSON(),
  });
} finally {
  port.close();
}
