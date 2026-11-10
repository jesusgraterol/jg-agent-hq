import type { IAsyncInputEvent, IAsyncInputListener } from './types.js';

/**
 * Delivers trusted observations without a transcript store or a callback queue. A host listener
 * synchronously enqueues its own work; a failure requests catch-up instead of stopping control.
 * @returns Subscription, publication and shutdown operations owned by one runtime.
 */
export const createAsyncInputs = () => {
  const listeners = new Map<IAsyncInputListener, { needsRecovery: boolean }>();
  let isClosed = false;

  const deliver = (listener: IAsyncInputListener, event: IAsyncInputEvent): void => {
    const subscription = listeners.get(listener);
    if (!subscription) return;
    const recovery: IAsyncInputEvent = {
      kind: 'recovery',
      provider: event.kind === 'item' ? event.source.provider : event.provider,
      source: null,
      reason: 'listener-failed',
    };
    try {
      if (subscription.needsRecovery) {
        listener(structuredClone(recovery));
        subscription.needsRecovery = false;
      }
      if (listeners.has(listener)) listener(structuredClone(event));
    } catch {
      subscription.needsRecovery = true;
      try {
        listener(structuredClone(recovery));
        subscription.needsRecovery = false;
      } catch {
        // retry the recovery signal before the next observation, without buffering bodies
      }
    }
  };

  return {
    /** Requests bounded history catch-up immediately; repeated subscriptions are independent. */
    subscribe(listener: IAsyncInputListener): () => void {
      if (isClosed) return () => undefined;
      // each registration owns its wrapper, so subscribing the same callback twice is safe
      const registered: IAsyncInputListener = (event) => listener(event);
      listeners.set(registered, { needsRecovery: false });
      deliver(registered, {
        kind: 'recovery',
        provider: 'codex',
        source: null,
        reason: 'subscribed',
      });
      return () => {
        listeners.delete(registered);
      };
    },
    /** Reports whether native event handling needs to resolve a controlled source. */
    hasListeners(): boolean {
      return listeners.size > 0;
    },
    /** Delivers independent copies so one host cannot mutate another host's observation. */
    emit(event: IAsyncInputEvent): void {
      if (isClosed) return;
      for (const listener of [...listeners.keys()]) deliver(listener, event);
    },
    /** Releases all callbacks before the runtime closes its providers and storage. */
    close(): void {
      isClosed = true;
      listeners.clear();
    },
  };
};
