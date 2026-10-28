// waits of chosen lengths, such as idle periods, which a test releases instead of waiting them out
const held = new Map<number, Set<() => void>>();
const holding = new Set<number>();

type IDelay = (seconds: number, options?: { signal?: AbortSignal }) => Promise<void>;

/**
 * Wraps a delay so waits of the lengths being held resolve only when a test releases them; an
 * abort still rejects them at once. Other waits pass through.
 * @param delay The real delay.
 * @returns The delay to install with `vi.mock`.
 */
export const holdDelays =
  (delay: IDelay): IDelay =>
  (seconds, options) => {
    if (!holding.has(seconds)) return delay(seconds, options);
    const signal = options?.signal;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const waiting = held.get(seconds) ?? new Set();
      held.set(seconds, waiting);
      const release = (): void => {
        signal?.removeEventListener('abort', abort);
        waiting.delete(release);
        resolve();
      };
      const abort = (): void => {
        waiting.delete(release);
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
      waiting.add(release);
    });
  };

/**
 * Holds every later wait of the given lengths until a test releases it.
 * @param lengths The wait lengths, in seconds.
 */
export const startHoldingDelays = (...lengths: number[]): void => {
  for (const seconds of lengths) holding.add(seconds);
};

/** Lets later waits of every length pass through again. */
export const stopHoldingDelays = (): void => {
  holding.clear();
};

/**
 * Counts the held waits of one length that are still pending.
 * @param seconds The wait length.
 * @returns The number of pending waits.
 */
export const countHeldDelays = (seconds: number): number => held.get(seconds)?.size ?? 0;

/**
 * Resolves every pending held wait of one length, as if that much time had passed.
 * @param seconds The wait length.
 * @returns The number of waits released.
 */
export const releaseHeldDelays = (seconds: number): number => {
  const waiting = [...(held.get(seconds) ?? [])];
  for (const release of waiting) release();
  return waiting.length;
};
