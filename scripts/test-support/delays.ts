// waits of chosen lengths, such as idle periods, which a test releases instead of waiting them out
const held = new Map<number, Set<() => void>>();

type IDelay = (seconds: number, options?: { signal?: AbortSignal }) => Promise<void>;

/**
 * Wraps a delay so waits of the given lengths resolve only when a test releases them; an abort
 * still rejects them at once. Other waits pass through.
 * @param delay The real delay.
 * @param lengths The wait lengths, in seconds, to hold.
 * @returns The delay to install with `vi.mock`.
 */
export const holdDelays =
  (delay: IDelay, lengths: number[]): IDelay =>
  (seconds, options) => {
    if (!lengths.includes(seconds)) return delay(seconds, options);
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
