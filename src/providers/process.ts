import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Exception, extractMessage } from 'jg-exception';

import { createLineDecoder, MAX_FRAME_BYTES } from '../ipc/index.js';

import type { IProviderProcess } from './types.js';
import { createProcessOwnership } from './process/index.js';

/**
 * Owns one POSIX process group and bounded structured transport, without a shell.
 * @returns A transport whose close waits for owned process termination.
 * @throws
 * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
 */
export const createProviderProcess = (
  executable: string,
  args: string[],
  receive: (message: unknown) => void,
  stopped: (failure: unknown) => void,
  cwd?: string,
): IProviderProcess => {
  const child = spawn(executable, args, { detached: true, stdio: ['pipe', 'pipe', 'pipe'], cwd });
  let isRunning = true;
  const { close } = createProcessOwnership(child);
  child.once('close', () => {
    isRunning = false;
  });
  const fail = (cause: unknown): void => {
    if (!isRunning) return;
    isRunning = false;
    stopped(
      new Exception(`The HQ transport failed: ${extractMessage(cause)}`, {
        code: 'JG_AGENT_HQ_TRANSPORT_FAILED',
        data: { kind: 'agent-unavailable' },
        cause,
      }),
    );
    void close().catch(stopped);
  };
  const decoder = createLineDecoder(MAX_FRAME_BYTES, receive);
  child.stdout.on('data', (chunk: Buffer) => {
    try {
      decoder.push(chunk);
    } catch (cause) {
      fail(cause);
    }
  });
  child.stdout.once('end', () => {
    try {
      decoder.end();
      fail(
        new Exception('The HQ transport failed: native output ended', {
          code: 'JG_AGENT_HQ_TRANSPORT_FAILED',
        }),
      );
    } catch (cause) {
      fail(cause);
    }
  });
  child.stderr.resume();
  child.stdin.on('error', fail);
  child.stdout.once('error', fail);
  child.stderr.once('error', fail);
  child.once('error', fail);
  child.once('close', (code, signal) => {
    stopped(
      new Exception(
        `The HQ transport failed: native process exited (${code ?? signal ?? 'unknown'})`,
        { code: 'JG_AGENT_HQ_TRANSPORT_FAILED', data: { kind: 'agent-unavailable' } },
      ),
    );
    void close().catch(stopped);
  });

  return {
    get isRunning() {
      return isRunning;
    },
    async write(message): Promise<void> {
      const content = `${JSON.stringify(message)}\n`;
      if (!isRunning || Buffer.byteLength(content) > MAX_FRAME_BYTES)
        throw new Exception('The HQ transport failed', {
          code: 'JG_AGENT_HQ_TRANSPORT_FAILED',
          data: { kind: 'agent-unavailable' },
        });
      if (!child.stdin.write(content))
        await once(child.stdin, 'drain', { signal: AbortSignal.timeout(30_000) });
    },
    close,
  };
};
