import { Exception } from 'jg-exception';

import type { IActionReceipt, IActionWait, IHqRequest } from '../../contracts/index.js';

type IActionWaitUntil = Extract<IHqRequest, { kind: 'action-wait' }>['until'];

// deliveries a receipt keeps until late native evidence or an operator's recovery changes them
const SETTLED_DELIVERIES: ReadonlySet<IActionReceipt['delivery']> = new Set([
  'acknowledged',
  'uncertain',
  'failed',
  'canceled',
]);

type IWaiter = {
  actionId: string;
  // the receipt's thread, once a read returned it; an action never changes its thread
  threadId: string | null;
  // set while a read is in flight, so a change that read may have missed is read again
  isReading: boolean;
  isWoken: boolean;
  wake: () => void;
};

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
  private readonly __waiters = new Set<IWaiter>();
  private __isClosed = false;

  /** Reads receipts through the store the actions module writes them with. */
  public constructor(read: (actionId: string) => Promise<IActionReceipt | null>) {
    this.__read = read;
  }

  /** Wakes the waits on one action. */
  public notifyAction(actionId: string): void {
    for (const waiter of this.__waiters)
      if (waiter.isReading || waiter.actionId === actionId) waiter.wake();
  }

  /** Wakes the waits on the actions of one thread. */
  public notifyThread(threadId: string): void {
    for (const waiter of this.__waiters)
      if (waiter.isReading || waiter.threadId === threadId) waiter.wake();
  }

  /** Wakes every wait, after a change that can touch any receipt. */
  public notifyAll(): void {
    for (const waiter of this.__waiters) waiter.wake();
  }

  /** Ends every wait and refuses new ones, once the runtime starts closing. */
  public close(): void {
    this.__isClosed = true;
    this.notifyAll();
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
    let resume: () => void = () => undefined;
    let isTimedOut = false;
    const waiter: IWaiter = {
      actionId,
      threadId: null,
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
          throw new Exception('The HQ runtime is not running', {
            code: 'JG_AGENT_HQ_RUNTIME_NOT_RUNNING',
            data: { kind: 'state-conflict' },
          });
        waiter.isWoken = false;
        waiter.isReading = true;
        const receipt = await this.__read(actionId);
        waiter.isReading = false;
        if (!receipt || isReached(receipt, until)) return { receipt, isTimedOut: false };
        if (isTimedOut) return { receipt, isTimedOut: true };
        waiter.threadId = receipt.threadId;
      }
    } finally {
      clearTimeout(timer);
      this.__waiters.delete(waiter);
    }
  }
}
