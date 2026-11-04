import type { IActionReceipt, IActionWait, IHqRequest } from '../../contracts/index.js';
import { HQ_ERRORS } from '../../errors/index.js';

type IActionWaitUntil = Extract<IHqRequest, { kind: 'action-wait' }>['until'];

// the change a receipt wait waits for: one action's, one thread's, or, with neither, any
type IActionTopic = { actionId?: string; threadId?: string };

// deliveries a receipt keeps until late native evidence or an operator's recovery changes them
const SETTLED_DELIVERIES: ReadonlySet<IActionReceipt['delivery']> = new Set([
  'acknowledged',
  'uncertain',
  'failed',
  'canceled',
]);

type IWaiter<TTopic> = {
  matches: (topic: TTopic) => boolean;
  // set while a read is in flight, so a change that read may have missed is read again
  isReading: boolean;
  isWoken: boolean;
  wake: () => void;
};

/**
 * Holds requests that wait for a change the runtime makes. The module that makes a change notifies
 * the waits with its topic, and a wait whose topic matches, or whose read is in flight, reads again;
 * nothing reads on a timer. With a limit, at most that many wait at once.
 */
export class ChangeWaits<TTopic> {
  private readonly __waiters = new Set<IWaiter<TTopic>>();
  private readonly __limit: number;
  private __isClosed = false;

  /** Bounds how many requests wait at once; without a limit, any number may. */
  public constructor(limit = Number.POSITIVE_INFINITY) {
    this.__limit = limit;
  }

  /** Wakes the waits a change with this topic can affect. */
  public notify(topic: TTopic): void {
    for (const waiter of this.__waiters)
      if (waiter.isReading || waiter.matches(topic)) waiter.wake();
  }

  /** Ends every wait and refuses new ones, once the runtime starts closing. */
  public close(): void {
    this.__isClosed = true;
    for (const waiter of this.__waiters) waiter.wake();
  }

  /**
   * Reads a value until it shows the change a wait waits for, reading again only after a change
   * it can affect, or until `timeoutMs` passes.
   * @param read Reads the current value.
   * @param isDone Tells whether a value shows the change.
   * @param matches Tells whether a change with a topic can affect the value.
   * @param timeoutMs The most milliseconds to wait.
   * @returns A promise that resolves to the last value read, and whether the time ran out first.
   * @throws
   * - JG_AGENT_HQ_RUNTIME_NOT_RUNNING: The HQ runtime is not running
   * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
   */
  public async wait<T>(
    read: () => Promise<T>,
    isDone: (value: T) => boolean,
    matches: (topic: TTopic) => boolean,
    timeoutMs: number,
  ): Promise<{ value: T; isTimedOut: boolean }> {
    if (this.__isClosed)
      throw HQ_ERRORS.create('runtimeNotRunning', { data: { kind: 'state-conflict' } });
    if (this.__waiters.size >= this.__limit)
      throw HQ_ERRORS.create('actionConflict', { data: { kind: 'state-conflict' } });
    let resume: () => void = () => undefined;
    let isTimedOut = false;
    const waiter: IWaiter<TTopic> = {
      matches,
      isReading: false,
      isWoken: true,
      wake: () => {
        waiter.isWoken = true;
        resume();
      },
    };
    const timer = setTimeout(() => {
      isTimedOut = true;
      waiter.wake();
    }, timeoutMs);
    // registered before the first read, so no change after that read is missed
    this.__waiters.add(waiter);
    try {
      for (;;) {
        if (!waiter.isWoken)
          await new Promise<void>((resolve) => {
            resume = resolve;
          });
        if (this.__isClosed)
          throw HQ_ERRORS.create('runtimeNotRunning', { data: { kind: 'state-conflict' } });
        waiter.isWoken = false;
        waiter.isReading = true;
        const value = await read();
        waiter.isReading = false;
        if (isDone(value)) return { value, isTimedOut: false };
        if (isTimedOut) return { value, isTimedOut: true };
      }
    } finally {
      clearTimeout(timer);
      this.__waiters.delete(waiter);
    }
  }
}

/**
 * Tells whether a receipt reached what its wait waits for. A native wait also ends once the
 * receipt settles without a native thread ID, which it can't then get by itself.
 */
const isReached = (receipt: IActionReceipt, until: IActionWaitUntil): boolean =>
  SETTLED_DELIVERIES.has(receipt.delivery) ||
  (until === 'native' && receipt.nativeThreadId !== null);

/**
 * Holds waits on action receipts. The actions module notifies it after each change it makes to a
 * receipt, and a wait reads its receipt again only then, never on a timer.
 */
export class ActionWaits {
  private readonly __read: (actionId: string) => Promise<IActionReceipt | null>;
  private readonly __waits = new ChangeWaits<IActionTopic>();

  /** Reads receipts through the store the actions module writes them with. */
  public constructor(read: (actionId: string) => Promise<IActionReceipt | null>) {
    this.__read = read;
  }

  /** Wakes the waits on one action. */
  public notifyAction(actionId: string): void {
    this.__waits.notify({ actionId });
  }

  /** Wakes the waits on the actions of one thread. */
  public notifyThread(threadId: string): void {
    this.__waits.notify({ threadId });
  }

  /** Wakes every wait, after a change that can touch any receipt. */
  public notifyAll(): void {
    this.__waits.notify({});
  }

  /** Ends every wait and refuses new ones, once the runtime starts closing. */
  public close(): void {
    this.__waits.close();
  }

  /**
   * Waits until an action's receipt has a native thread ID (`native`) or a final delivery state
   * (`settled`), or until `timeoutMs` passes.
   * @param actionId The action.
   * @param until What the wait waits for.
   * @param timeoutMs The most milliseconds to wait.
   * @returns A promise that resolves to the receipt, null for an unknown action, and whether the
   * time ran out before the receipt reached it.
   * @throws
   * - JG_AGENT_HQ_RUNTIME_NOT_RUNNING: The HQ runtime is not running
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  public async wait(
    actionId: string,
    until: IActionWaitUntil,
    timeoutMs: number,
  ): Promise<IActionWait> {
    // the receipt's thread, once a read returned it; an action never changes its thread
    let threadId: string | null = null;
    const { value, isTimedOut } = await this.__waits.wait(
      async () => {
        const receipt = await this.__read(actionId);
        threadId = receipt?.threadId ?? threadId;
        return receipt;
      },
      (receipt) => !receipt || isReached(receipt, until),
      (topic) =>
        topic.actionId === actionId ||
        (topic.threadId !== undefined && topic.threadId === threadId) ||
        (topic.actionId === undefined && topic.threadId === undefined),
      timeoutMs,
    );
    return { receipt: value, isTimedOut };
  }
}
