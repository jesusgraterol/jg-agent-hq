import type { IResyncRequest } from './types.js';
import { mergeResync } from './utilities.js';

type IProviderResyncs = {
  // sessions whose re-check waits, in the order they were asked for
  waiting: Map<string, IResyncRequest>;
  running: string | null;
  // what was asked for a session while its re-check ran, which runs once after it
  followUps: Map<string, IResyncRequest>;
  isDraining: boolean;
};

/**
 * Runs live re-checks of controlled sessions outside the shared event lane, one at a time per
 * provider, so they hold at most one of a native connection's request slots. A session has at
 * most one waiting re-check; another request for it merges into that one, or follows the one
 * running.
 */
export class Resyncs {
  private readonly __providers = new Map<string, IProviderResyncs>();
  private readonly __recheck: (
    provider: string,
    nativeId: string,
    request: IResyncRequest,
  ) => Promise<void>;
  private readonly __runOwned: (operation: () => Promise<void>) => void;

  /**
   * @param recheck Reads one session and applies what it finds.
   * @param runOwned Runs a provider's re-checks in the background the runtime owns.
   */
  public constructor(
    recheck: (provider: string, nativeId: string, request: IResyncRequest) => Promise<void>,
    runOwned: (operation: () => Promise<void>) => void,
  ) {
    this.__recheck = recheck;
    this.__runOwned = runOwned;
  }

  /** Asks for a re-check of one session and starts its provider's re-checks when none run. */
  public request(provider: string, nativeId: string, request: IResyncRequest): void {
    let queue = this.__providers.get(provider);
    if (!queue) {
      queue = { waiting: new Map(), running: null, followUps: new Map(), isDraining: false };
      this.__providers.set(provider, queue);
    }
    if (queue.running === nativeId)
      queue.followUps.set(nativeId, mergeResync(queue.followUps.get(nativeId), request));
    else queue.waiting.set(nativeId, mergeResync(queue.waiting.get(nativeId), request));
    if (queue.isDraining) return;
    queue.isDraining = true;
    const draining = queue;
    this.__runOwned(() => this.__drain(provider, draining));
  }

  /**
   * Runs a provider's waiting re-checks in order until none is left.
   * @returns A promise resolved once the provider has no waiting re-check.
   */
  private async __drain(provider: string, queue: IProviderResyncs): Promise<void> {
    try {
      for (const [nativeId, request] of queue.waiting) {
        queue.waiting.delete(nativeId);
        queue.running = nativeId;
        try {
          await this.__recheck(provider, nativeId, request);
        } finally {
          queue.running = null;
          const followUp = queue.followUps.get(nativeId);
          if (followUp) {
            queue.followUps.delete(nativeId);
            queue.waiting.set(nativeId, mergeResync(queue.waiting.get(nativeId), followUp));
          }
        }
      }
    } finally {
      queue.isDraining = false;
    }
  }
}
