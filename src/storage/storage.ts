import { AsyncLocalStorage } from 'node:async_hooks';
import { Exception } from 'jg-exception';

import type { IStore } from '../store/index.js';

import type { IStorageMaintenanceOperation } from './types.js';

/**
 * Coordinates trusted host maintenance with admitted work and native event persistence.
 * Already admitted nested calls finish under their original admission; new calls conflict.
 * @returns The runtime admission and host maintenance operations.
 */
export const createStorage = (store: IStore) => {
  const context = new AsyncLocalStorage<{ isActive: boolean }>();
  const active = new Set<Promise<unknown>>();
  let maintenance: Promise<void> | undefined;
  let isMaintenanceHeld = false;
  let isDisposed = false;

  const conflict = (): never => {
    throw new Exception('The HQ action conflicts with its recorded state', {
      code: 'JG_AGENT_HQ_ACTION_CONFLICT',
      data: { kind: 'state-conflict' },
    });
  };

  /**
   * Tracks one independent operation and the admission inherited by its nested calls.
   * @returns The operation result after releasing its admission.
   */
  const track = async <T>(operation: () => Promise<T>): Promise<T> => {
    const owner = { isActive: true };
    const task = context.run(owner, async () => operation());
    active.add(task);
    try {
      return await task;
    } finally {
      owner.isActive = false;
      active.delete(task);
    }
  };

  /**
   * Admits a host operation, preserving admission for its awaited nested calls.
   * @returns The operation result.
   * @throws
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   */
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (isDisposed || context.getStore()?.isActive) return operation();
    if (maintenance) conflict();
    return track(operation);
  };

  /**
   * Lets native evidence finish admitted work, then holds it during the host callback.
   * @returns The operation result after admission resumes.
   */
  const background = async <T>(operation: () => Promise<T>): Promise<T> => {
    while (isMaintenanceHeld) await maintenance;
    return context.exit(() => (isDisposed ? operation() : track(operation)));
  };

  /**
   * Closes admission, drains accepted work, and rejects an active native execution checkpoint.
   * @returns The host callback result after exclusive HQ maintenance admission.
   * @throws
   * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  const withStorageMaintenance = async <T>(
    operation: IStorageMaintenanceOperation<T>,
  ): Promise<T> => {
    if (typeof operation !== 'function')
      throw new Exception('The HQ request is invalid', {
        code: 'JG_AGENT_HQ_REQUEST_INVALID',
        data: { kind: 'invalid-request' },
      });
    if (maintenance || context.getStore()?.isActive) conflict();
    let release: () => void = () => undefined;
    maintenance = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      while (active.size > 0) await Promise.allSettled([...active]);
      isMaintenanceHeld = true;
      if (!(await store.prepareStorageMaintenance())) conflict();
      return await operation(structuredClone(store.storage));
    } finally {
      isMaintenanceHeld = false;
      maintenance = undefined;
      release();
    }
  };

  /** Releases Node's context registration once the runtime has confirmed shutdown. */
  const dispose = (): void => {
    isDisposed = true;
    context.disable();
  };

  return { run, background, withStorageMaintenance, dispose };
};
