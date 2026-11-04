import { abortable } from 'jg-utilities';

import type { createProviderRegistry } from '../../providers/registry/index.js';
import type { createStorage } from '../../storage/index.js';
import type { IStore } from '../../store/index.js';

import { MAX_WARM_FOLDERS } from './constants.js';

/**
 * Starts both native integrations in the background as the runtime starts, so the first requests
 * find them ready: it connects to Codex, which also starts observing the sessions Codex runs, and
 * brings Claude's history index up to date for the allowed roots and the folders the index already
 * holds, most recent first, one at a time. A CLI that is missing or fails leaves its provider
 * unavailable, as its first request would have, and stops that provider's part. Indexing waits
 * while host maintenance holds the store.
 * @param registry The providers.
 * @param store The store the index lives in.
 * @param allowedRoots The canonical allowed roots.
 * @param background Runs store work the host's maintenance waits for.
 * @returns A handle whose close stops the warm-up and resolves once it stopped waiting.
 */
export const startWarmUp = (
  registry: ReturnType<typeof createProviderRegistry>,
  store: IStore,
  allowedRoots: string[],
  background: ReturnType<typeof createStorage>['background'],
): { close(): Promise<void> } => {
  const lifetime = new AbortController();
  // waits for a step without stopping it, which the providers' own shutdown ends
  const settle = async (step: Promise<unknown>): Promise<boolean> => {
    step.catch(() => undefined);
    try {
      await abortable(step, { signal: lifetime.signal });
      return true;
    } catch {
      return false;
    }
  };
  const indexClaude = async (): Promise<void> => {
    const claude = await registry.get('claude');
    const folders = new Set([
      ...allowedRoots,
      ...(await store.call('claudeHistory', 'indexedRoots', MAX_WARM_FOLDERS)),
    ]);
    for (const workspaceRoot of folders) {
      if (lifetime.signal.aborted) return;
      const page = { search: undefined, limit: 1, cursor: null };
      // a failure in one folder is that folder's; a CLI that doesn't start fails them all
      if (
        !(await settle(background(() => claude.listThreads(workspaceRoot, page)))) &&
        claude.state === 'unavailable'
      )
        return;
    }
  };
  const running = Promise.all([settle(registry.get('codex')), settle(indexClaude())]);
  return {
    close: async () => {
      lifetime.abort();
      await running;
    },
  };
};
