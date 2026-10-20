import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { Exception, extractMessage } from 'error-message-utils';

import {
  HqRequestSchema,
  IpcResponseSchema,
  PUBLIC_ERROR_MESSAGES,
  type IHqRequestInput,
  type IHqResponse,
} from '../contracts/index.js';
import { isPrivateOwner } from '../locks/index.js';
import { readRuntimeOwner } from '../runtime/state/index.js';

import { CONTROL_SOCKET, IPC_TIMEOUT_MS, MAX_FRAME_BYTES, MAX_REQUEST_BYTES } from './constants.js';
import { createLineDecoder } from './framing.js';

/**
 * Runs one validated local command and closes only its client connection.
 * @returns The matching normalized response; stopping requires subsequent shutdown confirmation.
 * @throws
 * - -1: The HQ request is invalid
 * - -1: The HQ state directory is unsafe
 * - -1: The HQ state file is unsafe
 * - -1: The HQ runtime owner is unverifiable
 * - -1: The HQ runtime is not running
 * - -1: The HQ transport failed
 * - -1: Request is invalid.
 * - -1: Sign in to continue.
 * - -1: Access is denied.
 * - -1: Requested resource was not found.
 * - -1: State changed. Refresh before continuing.
 * - -1: Coding agent is unavailable.
 * - -1: Operation could not be completed.
 */
export const requestAgentHq = async (
  stateRoot: string,
  command: IHqRequestInput,
): Promise<IHqResponse> => {
  const input = HqRequestSchema.safeParse(command);
  if (!input.success || !isAbsolute(stateRoot))
    throw new Exception('The HQ request is invalid', undefined, { kind: 'invalid-request' });
  const { owner } = await readRuntimeOwner(stateRoot);
  const path = join(stateRoot, CONTROL_SOCKET);
  const socketDetails = await lstat(path);
  if (!socketDetails.isSocket() || socketDetails.isSymbolicLink() || !isPrivateOwner(socketDetails))
    throw new Exception('The HQ state file is unsafe', undefined, { kind: 'state-conflict' });
  const id = randomUUID();
  const content = `${JSON.stringify({ schemaVersion: 1, id, runtimeEpoch: owner.nonce, command: input.data })}\n`;
  if (Buffer.byteLength(content) > MAX_REQUEST_BYTES)
    throw new Exception('The HQ request is invalid', undefined, { kind: 'invalid-request' });
  const socket = createConnection(path);
  try {
    return await new Promise<IHqResponse>((resolve, reject) => {
      socket.setTimeout(IPC_TIMEOUT_MS, () =>
        reject(new Exception('The HQ transport failed', undefined, { kind: 'agent-unavailable' })),
      );
      socket.once('error', (cause) =>
        reject(
          new Exception(
            `The HQ transport failed: ${extractMessage(cause)}`,
            undefined,
            { kind: 'agent-unavailable' },
            { cause },
          ),
        ),
      );
      let received = false;
      const decoder = createLineDecoder(MAX_FRAME_BYTES, (message) => {
        const parsed = IpcResponseSchema.safeParse(message);
        if (!parsed.success || parsed.data.id !== id)
          throw new Exception('The HQ transport failed', undefined, { kind: 'agent-unavailable' });
        received = true;
        const response = parsed.data;
        if (!response.success) {
          reject(
            new Exception(PUBLIC_ERROR_MESSAGES[response.error.kind], undefined, {
              kind: response.error.kind,
            }),
          );
          return;
        }
        if (response.response.kind !== input.data.kind)
          throw new Exception('The HQ transport failed', undefined, { kind: 'agent-unavailable' });
        resolve(response.response);
      });
      socket.on('data', (chunk: Buffer) => {
        try {
          decoder.push(chunk);
        } catch (error) {
          reject(error);
        }
      });
      socket.once('end', () => {
        try {
          decoder.end();
          if (!received)
            reject(
              new Exception('The HQ transport failed', undefined, { kind: 'agent-unavailable' }),
            );
        } catch (error) {
          reject(error);
        }
      });
      socket.once('connect', () => socket.write(content));
    });
  } finally {
    socket.destroy();
  }
};
