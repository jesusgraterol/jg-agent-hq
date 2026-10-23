import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { Exception, hasErrorCode } from 'jg-exception';

/**
 * Owns termination of one detached POSIX process group, including children left by its parent.
 * @returns Parent closure and idempotent, verified group shutdown.
 * @throws
 * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
 */
export const createProcessOwnership = (child: ChildProcessWithoutNullStreams) => {
  let closing: Promise<void> | undefined;
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!hasErrorCode(error, 'ESRCH')) throw error;
    }
  };
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      child.stdin.end();
      const controller = new AbortController();
      try {
        let exited = await Promise.race([
          closed.then(() => true),
          wait(5000, false, { signal: controller.signal }),
        ]);
        if (!exited) {
          signalGroup('SIGTERM');
          exited = await Promise.race([
            closed.then(() => true),
            wait(5000, false, { signal: controller.signal }),
          ]);
        }
        if (!exited) signalGroup('SIGKILL');
        await closed;
        // an exited parent may leave other members of this owned group running
        signalGroup('SIGKILL');
        const deadline = Date.now() + 5000;
        while (child.pid) {
          try {
            process.kill(-child.pid, 0);
          } catch (error) {
            if (hasErrorCode(error, 'ESRCH')) return;
            throw error;
          }
          if (Date.now() >= deadline)
            throw new Exception(
              'The HQ transport failed: native process group termination is unconfirmed',
              { code: 'JG_AGENT_HQ_TRANSPORT_FAILED', data: { kind: 'operation-failed' } },
            );
          await wait(25);
        }
      } finally {
        controller.abort();
      }
    })());
  return { closed, close };
};
