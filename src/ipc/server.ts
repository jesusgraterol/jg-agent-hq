import { createServer, type Socket } from 'node:net';
import { chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Exception, extractMessage } from 'error-message-utils';

import {
  HqResponseSchema,
  IpcRequestSchema,
  PUBLIC_ERROR_MESSAGES,
  type IHqRequest,
  type IHqResponse,
  type IIpcResponse,
} from '../contracts/index.js';

import {
  IPC_TIMEOUT_MS,
  MAX_CONNECTIONS,
  MAX_FRAME_BYTES,
  MAX_REQUEST_BYTES,
} from './constants.js';
import { createLineDecoder } from './framing.js';
import { toPublicError } from './utilities.js';

/**
 * Serves closed HQ commands over an owner-only Unix socket. Disconnects do not own host lifetime.
 * @returns An owned server with deterministic connection teardown.
 * @throws
 * - -1: The HQ transport failed
 */
export const createIpcServer = async (
  path: string,
  runtimeEpoch: string,
  handle: (command: IHqRequest) => Promise<IHqResponse>,
) => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(IPC_TIMEOUT_MS, () => socket.destroy());
    let admitted = false;
    const send = (reply: IIpcResponse): void => {
      let content = `${JSON.stringify(reply)}\n`;
      if (Buffer.byteLength(content) > MAX_FRAME_BYTES)
        content = `${JSON.stringify({ schemaVersion: 1, id: reply.id, success: false, error: { kind: 'operation-failed', message: PUBLIC_ERROR_MESSAGES['operation-failed'] } })}\n`;
      socket.end(content);
    };
    const receive = async (message: unknown): Promise<void> => {
      if (admitted) {
        socket.destroy();
        return;
      }
      admitted = true;
      const input = IpcRequestSchema.safeParse(message);
      const id = input.success ? input.data.id : randomUUID();
      try {
        if (!input.success)
          throw new Exception(
            'The HQ request is invalid',
            undefined,
            { kind: 'invalid-request' },
            { cause: input.error },
          );
        if (input.data.runtimeEpoch !== runtimeEpoch)
          throw new Exception('The HQ runtime owner is unverifiable', undefined, {
            kind: 'state-conflict',
          });
        const response = HqResponseSchema.safeParse(await handle(input.data.command));
        if (!response.success || response.data.kind !== input.data.command.kind)
          throw new Exception('The HQ transport failed', undefined, { kind: 'operation-failed' });
        send({ schemaVersion: 1, id, success: true, response: response.data });
      } catch (error) {
        send({ schemaVersion: 1, id, success: false, error: toPublicError(error) });
      }
    };
    const decoder = createLineDecoder(MAX_REQUEST_BYTES, (message) => {
      void receive(message).catch(() => socket.destroy());
    });
    socket.on('data', (chunk: Buffer) => {
      try {
        decoder.push(chunk);
      } catch {
        socket.destroy();
      }
    });
    socket.once('end', () => {
      try {
        decoder.end();
      } catch {
        socket.destroy();
      }
    });
  });
  server.maxConnections = MAX_CONNECTIONS;
  let hasFailed = false;
  server.on('error', () => {
    hasFailed = true;
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    await chmod(path, 0o600);
  } catch (cause) {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Exception(
      `The HQ transport failed: ${extractMessage(cause)}`,
      undefined,
      { kind: 'operation-failed' },
      { cause },
    );
  }
  let closing: Promise<void> | undefined;
  return {
    get isAvailable() {
      return server.listening && !hasFailed;
    },
    close: (): Promise<void> =>
      (closing ??= new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) =>
          error
            ? reject(
                new Exception(
                  `The HQ transport failed: ${extractMessage(error)}`,
                  undefined,
                  { kind: 'operation-failed' },
                  { cause: error },
                ),
              )
            : resolve(),
        );
      })),
  };
};
