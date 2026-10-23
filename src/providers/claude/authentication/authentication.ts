import { spawn } from 'node:child_process';
import { Exception } from 'jg-exception';
import { abortable } from 'jg-utilities';

import type { INativeControlResult } from '../../../contracts/index.js';
import { createProcessOwnership } from '../../process/index.js';
import { capabilityUnavailable } from '../../registry/index.js';

/**
 * Keeps native logout ownership until process-group shutdown has been confirmed.
 * @returns Account controls whose failed cleanup remains visible to provider shutdown.
 */
export const createClaudeAuthentication = () => {
  let owned: ReturnType<typeof createProcessOwnership> | undefined;
  let isClosing = false;
  return {
    /**
     * Signs out through the installed CLI, discarding human-oriented output.
     * @returns Native exit acknowledgement after all owned processes have stopped.
     * @throws
     * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
     * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async logout(signal: AbortSignal): Promise<INativeControlResult> {
      if (owned || isClosing) capabilityUnavailable();
      signal.throwIfAborted();
      const child = spawn('claude', ['auth', 'logout'], {
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const owner = createProcessOwnership(child);
      owned = owner;
      const exit = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.stdin.once('error', reject);
        child.stdout.once('error', reject);
        child.stderr.once('error', reject);
        child.once('close', (code) => resolve(code));
      });
      child.stdout.resume();
      child.stderr.resume();
      child.stdin.end();
      try {
        const code = await abortable(exit, { signal });
        if (code !== 0)
          throw new Exception('The Claude integration failed', {
            code: 'JG_AGENT_HQ_CLAUDE_FAILED',
            data: { kind: 'agent-unavailable' },
          });
        return { state: 'applied', completion: 'completed' };
      } finally {
        await owner.close();
        owned = undefined;
      }
    },
    /**
     * Confirms shutdown, retaining a failed owner rather than releasing runtime authority.
     * @returns Confirmation that no native logout process remains owned.
     * @throws
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async close(): Promise<void> {
      isClosing = true;
      await owned?.close();
    },
  };
};
