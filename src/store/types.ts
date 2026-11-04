import type { IErrorKind } from '../contracts/index.js';
import type { ClaudeHistoryModel } from '../providers/claude/history/index.js';
import type { IStorageDescriptor } from '../storage/index.js';

import type { BrowserModel } from './browser/index.js';
import type {
  ControlAdmission,
  ControlLifecycle,
  ControlObservations,
  ControlOutcomes,
  ControlReads,
} from './control/index.js';
import type { SessionsModel } from './sessions/index.js';
import type { SnapshotModel } from './snapshot.js';

// the worker's models; each operation is declared once, as a public method of its model
export type IStoreModels = {
  browser: BrowserModel;
  sessions: SessionsModel;
  claudeHistory: ClaudeHistoryModel;
  reads: ControlReads;
  admission: ControlAdmission;
  outcomes: ControlOutcomes;
  observations: ControlObservations;
  lifecycle: ControlLifecycle;
  snapshot: SnapshotModel;
};
export type IStoreModelName = keyof IStoreModels;
// a model's public methods, which the main thread may call
export type IStoreMethodName<TModel extends IStoreModelName> = {
  [TMethod in keyof IStoreModels[TModel]]: IStoreModels[TModel][TMethod] extends (
    ...args: never[]
  ) => unknown
    ? TMethod
    : never;
}[keyof IStoreModels[TModel]];
export type IStoreArguments<
  TModel extends IStoreModelName,
  TMethod extends IStoreMethodName<TModel>,
> = IStoreModels[TModel][TMethod] extends (...args: infer TArguments) => unknown
  ? TArguments
  : never;
export type IStoreResult<
  TModel extends IStoreModelName,
  TMethod extends IStoreMethodName<TModel>,
> = IStoreModels[TModel][TMethod] extends (...args: never[]) => infer TResult
  ? Awaited<TResult>
  : never;

// the worker's options, built by the main thread
export type IStoreWorkerData = {
  databasePath: string;
  runtimeEpoch: string;
  actionKey: Uint8Array;
};
// worker messages are closed model operations rather than arbitrary SQL
export type IStoreRequest =
  | { kind: 'call'; id: number; model: IStoreModelName; method: string; args: unknown[] }
  | { kind: 'close'; id: number };
export type IStoreError = { code: string; message: string; kind: IErrorKind };
// each response carries the highest session transition sequence issued, which long-polls wait on
export type IStoreResponse =
  | { kind: 'ready'; storage: IStorageDescriptor; transitionSequence: number }
  | { kind: 'startup-error'; error: IStoreError }
  | {
      kind: 'result';
      id: number;
      result: unknown;
      error: IStoreError | null;
      transitionSequence: number;
    };

// the worker owns persistence; callers cannot submit arbitrary statements
export type IStore = {
  readonly isAvailable: boolean;
  storage: IStorageDescriptor;
  /**
   * Runs one model operation in the worker, in the order calls are made, and rejects with the
   * code, message and kind of the error the operation throws. A snapshot backup has no deadline;
   * every other call fails after 5 seconds.
   * @returns The operation's result.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   * - JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE: The Claude history is unavailable
   * - JG_AGENT_HQ_IMAGE_UNAVAILABLE: The HQ image is unavailable
   * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
   * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
   */
  call<TModel extends IStoreModelName, TMethod extends IStoreMethodName<TModel>>(
    model: TModel,
    method: TMethod,
    ...args: IStoreArguments<TModel, TMethod>
  ): Promise<IStoreResult<TModel, TMethod>>;
  /** Calls the listener after each worker call that recorded a new session transition. */
  onTransition(listener: () => void): void;
  /**
   * Closes SQLite and waits for the worker to exit.
   * @returns A promise resolved after SQLite closes and the worker exits.
   * @throws
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  close(): Promise<void>;
};
