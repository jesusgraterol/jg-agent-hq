import { lstat, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Worker } from 'node:worker_threads';
import { hashValue } from 'jg-crypto';
import { Exception, extractMessage, hasErrorCode } from 'jg-exception';
import { assertPrivateDirectory } from 'jg-fs';

import { isPrivateOwner } from '../../locks/index.js';

import {
  claimRuntimeOwner,
  isWithinWorkspace,
  readExistingState,
  resolveAllowedRoots,
} from '../../runtime/state/index.js';

import {
  UpgradeOptionsSchema,
  UpgradeWorkerResponseSchema,
  type IHqStorageUpgradeOptions,
  type IHqStorageUpgradeResult,
} from './types.js';

/**
 * Waits for actual exit, including when a worker reports an error. There is no size-based deadline.
 * @returns The validated result after confirmed worker shutdown.
 * @throws
 * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
 * - JG_AGENT_HQ_STATE_DIRECTORY_UNSAFE: The HQ state directory is unsafe
 * - JG_AGENT_HQ_STATE_FILE_UNSAFE: The HQ state file is unsafe
 * - JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE: The HQ action key is unavailable
 * - JG_AGENT_HQ_LOCK_UNSUPPORTED_PLATFORM: The HQ lock requires Linux or macOS
 * - JG_AGENT_HQ_RUNTIME_DIRECTORY_INVALID: The HQ runtime directory must be a real directory
 * - JG_AGENT_HQ_RUNTIME_DIRECTORY_PERMISSIONS: The HQ runtime directory must be private and owned by the current user
 * - JG_AGENT_HQ_LOCK_FILE_INVALID: The HQ lock must be a regular file
 * - JG_AGENT_HQ_LOCK_FILE_PERMISSIONS: The HQ lock must be private and owned by the current user
 * - JG_AGENT_HQ_LOCK_OWNER_OVERSIZED: The HQ lock owner exceeds the supported size
 * - JG_AGENT_HQ_LOCK_OWNER_UNREADABLE: The HQ lock owner could not be read. Inspect .runtime/hq.lock
 * - JG_AGENT_HQ_LOCK_OWNER_INCOMPLETE: The HQ lock owner is incomplete. Inspect .runtime/hq.lock and remove it only after its owner stopped
 * - JG_AGENT_HQ_LOCK_OWNER_INACTIVE: The HQ lock has an inactive owner
 * - JG_AGENT_HQ_LOCK_OWNER_UNVERIFIABLE: The HQ lock owner could not be verified
 * - JG_AGENT_HQ_LOCK_TIMEOUT: Timed out waiting for the HQ lock
 * - JG_AGENT_HQ_STORAGE_INVALID: The HQ storage is invalid
 * - JG_AGENT_HQ_STORAGE_VERSION_UNSUPPORTED: The HQ storage version is unsupported
 * - JG_AGENT_HQ_STORAGE_UPGRADE_FAILED: The HQ storage upgrade failed
 * - JG_AGENT_HQ_STORAGE_UPGRADE_UNCERTAIN: The HQ storage upgrade requires reconciliation
 * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
 * - JG_AGENT_HQ_SNAPSHOT_FAILED: The HQ snapshot operation failed
 */
const runUpgradeWorker = async (
  input: IHqStorageUpgradeOptions & { actionKeyHash: string },
): Promise<IHqStorageUpgradeResult> => {
  let worker: Worker;
  try {
    worker = new Worker(new URL('./upgrade.worker.js', import.meta.url), {
      execArgv: process.execArgv.filter(
        (argument, index, args) =>
          argument !== '--input-type' &&
          !argument.startsWith('--input-type=') &&
          args[index - 1] !== '--input-type',
      ),
      workerData: input,
    });
  } catch (cause) {
    throw new Exception(`The HQ storage upgrade failed: ${extractMessage(cause)}`, {
      code: 'JG_AGENT_HQ_STORAGE_UPGRADE_FAILED',
      data: { kind: 'operation-failed', phase: 'worker-start', backupDirectory: null },
      cause,
    });
  }
  return new Promise((resolveResult, rejectResult) => {
    let response: ReturnType<typeof UpgradeWorkerResponseSchema.parse> | undefined;
    let failure: unknown;
    let hasDuplicateResponse = false;
    worker.on('message', (message: unknown) => {
      const parsed = UpgradeWorkerResponseSchema.safeParse(message);
      if (response) hasDuplicateResponse = true;
      else if (!parsed.success) failure = parsed.error;
      else response = parsed.data;
    });
    worker.once('error', (cause) => {
      failure = cause;
    });
    worker.once('exit', (code) => {
      if (failure || hasDuplicateResponse || code !== 0 || !response)
        rejectResult(
          new Exception(
            `The HQ storage upgrade requires reconciliation: ${failure ? extractMessage(failure) : hasDuplicateResponse ? 'Duplicate upgrade worker result' : `Worker exited (${code})`}`,
            {
              code: 'JG_AGENT_HQ_STORAGE_UPGRADE_UNCERTAIN',
              data: {
                kind: 'operation-failed',
                phase: 'worker-exit',
                backupDirectory: input.backupDirectory,
              },
              cause: failure,
            },
          ),
        );
      else if (response.kind === 'error')
        rejectResult(
          new Exception(response.message, {
            code: response.code,
            data: response.data,
            cause: response.cause,
          }),
        );
      else resolveResult(response.result);
    });
  });
};

/**
 * Upgrades existing offline storage only after a fully verified local backup.
 * Stop HQ/native children and all independent database/plan writers first. No owner is reclaimed.
 * An uncertain error requires explicit reinspection; this operation never reverses or replays DDL.
 * @returns The committed upgrade or an untouched current-version observation, after worker exit.
 * @throws
 * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
 * - JG_AGENT_HQ_STATE_DIRECTORY_UNSAFE: The HQ state directory is unsafe
 * - JG_AGENT_HQ_STATE_FILE_UNSAFE: The HQ state file is unsafe
 * - JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE: The HQ action key is unavailable
 * - JG_AGENT_HQ_RUNTIME_ALREADY_OWNED: The HQ runtime is already owned
 * - JG_AGENT_HQ_RUNTIME_OWNER_UNVERIFIABLE: The HQ runtime owner is unverifiable
 * - JG_AGENT_HQ_RUNTIME_NOT_RUNNING: The HQ runtime is not running
 * - JG_AGENT_HQ_LOCK_UNSUPPORTED_PLATFORM: The HQ lock requires Linux or macOS
 * - JG_AGENT_HQ_RUNTIME_DIRECTORY_INVALID: The HQ runtime directory must be a real directory
 * - JG_AGENT_HQ_RUNTIME_DIRECTORY_PERMISSIONS: The HQ runtime directory must be private and owned by the current user
 * - JG_AGENT_HQ_LOCK_FILE_INVALID: The HQ lock must be a regular file
 * - JG_AGENT_HQ_LOCK_FILE_PERMISSIONS: The HQ lock must be private and owned by the current user
 * - JG_AGENT_HQ_LOCK_OWNER_OVERSIZED: The HQ lock owner exceeds the supported size
 * - JG_AGENT_HQ_LOCK_OWNER_UNREADABLE: The HQ lock owner could not be read. Inspect .runtime/hq.lock
 * - JG_AGENT_HQ_LOCK_OWNER_INCOMPLETE: The HQ lock owner is incomplete. Inspect .runtime/hq.lock and remove it only after its owner stopped
 * - JG_AGENT_HQ_LOCK_OWNER_INACTIVE: The HQ lock has an inactive owner
 * - JG_AGENT_HQ_LOCK_OWNER_UNVERIFIABLE: The HQ lock owner could not be verified
 * - JG_AGENT_HQ_LOCK_TIMEOUT: Timed out waiting for the HQ lock
 * - JG_AGENT_HQ_STORAGE_INVALID: The HQ storage is invalid
 * - JG_AGENT_HQ_STORAGE_VERSION_UNSUPPORTED: The HQ storage version is unsupported
 * - JG_AGENT_HQ_STORAGE_UPGRADE_FAILED: The HQ storage upgrade failed
 * - JG_AGENT_HQ_STORAGE_UPGRADE_UNCERTAIN: The HQ storage upgrade requires reconciliation
 * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
 * - JG_AGENT_HQ_SNAPSHOT_FAILED: The HQ snapshot operation failed
 */
export const upgradeHqStorage = async (
  options: IHqStorageUpgradeOptions,
): Promise<IHqStorageUpgradeResult> => {
  const parsed = UpgradeOptionsSchema.safeParse(options);
  if (!parsed.success)
    throw new Exception('The HQ request is invalid', {
      code: 'JG_AGENT_HQ_REQUEST_INVALID',
      data: { kind: 'invalid-request' },
      cause: parsed.error,
    });
  const selected = parsed.data;
  const state = await readExistingState(selected.stateRoot);
  const allowedRoots = await resolveAllowedRoots(selected.allowedRoots);
  const coordinationRoot = selected.coordinationRoot
    ? (await resolveAllowedRoots([selected.coordinationRoot]))[0]!
    : state.stateRoot;
  try {
    await assertPrivateDirectory(dirname(selected.backupDirectory));
    if (
      (await realpath(dirname(selected.backupDirectory))) !== dirname(selected.backupDirectory) ||
      !isPrivateOwner(await lstat(dirname(selected.backupDirectory))) ||
      isWithinWorkspace(state.stateRoot, selected.backupDirectory) ||
      isWithinWorkspace(selected.backupDirectory, state.stateRoot)
    )
      throw new Exception('The HQ snapshot is invalid', {
        code: 'JG_AGENT_HQ_SNAPSHOT_INVALID',
        data: { kind: 'invalid-request' },
      });
  } catch (cause) {
    if (hasErrorCode(cause, 'JG_AGENT_HQ_SNAPSHOT_INVALID')) throw cause;
    throw new Exception(`The HQ snapshot is invalid: ${extractMessage(cause)}`, {
      code: 'JG_AGENT_HQ_SNAPSHOT_INVALID',
      data: { kind: 'invalid-request' },
      cause,
    });
  }
  const ownership = await claimRuntimeOwner(state.stateRoot, 'upgrade-storage');
  let result: IHqStorageUpgradeResult | undefined;
  let failure: unknown;
  try {
    const current = await readExistingState(state.stateRoot);
    if (hashValue(current.actionKey) !== hashValue(state.actionKey))
      throw new Exception('The HQ action key is unavailable', {
        code: 'JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE',
        data: { kind: 'state-conflict' },
      });
    result = await runUpgradeWorker({
      ...selected,
      allowedRoots,
      coordinationRoot,
      actionKeyHash: hashValue(current.actionKey),
    });
  } catch (cause) {
    failure = cause;
  }
  try {
    // runUpgradeWorker settles only after exit; a worker that has not exited keeps this owner
    await ownership.release();
  } catch (cause) {
    throw new Exception(
      `The HQ storage upgrade requires reconciliation: ${extractMessage(cause)}`,
      {
        code: 'JG_AGENT_HQ_STORAGE_UPGRADE_UNCERTAIN',
        data: {
          kind: 'operation-failed',
          phase: 'owner-release',
          backupDirectory: result?.backupDirectory ?? selected.backupDirectory,
        },
        cause: failure
          ? new AggregateError([failure, cause], 'Upgrade owner release failed')
          : cause,
      },
    );
  }
  if (failure) throw failure;
  return result!;
};
