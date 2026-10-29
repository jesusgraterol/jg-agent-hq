import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { Exception, extractMessage } from 'jg-exception';

import {
  HqRequestSchema,
  IpcResponseSchema,
  PUBLIC_ERROR_CODES,
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
 * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
 * - JG_AGENT_HQ_STATE_DIRECTORY_UNSAFE: The HQ state directory is unsafe
 * - JG_AGENT_HQ_STATE_FILE_UNSAFE: The HQ state file is unsafe
 * - JG_AGENT_HQ_RUNTIME_OWNER_UNVERIFIABLE: The HQ runtime owner is unverifiable
 * - JG_AGENT_HQ_RUNTIME_NOT_RUNNING: The HQ runtime is not running
 * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
 * - JG_AGENT_HQ_CLIENT_INVALID_REQUEST: Request is invalid.
 * - JG_AGENT_HQ_CLIENT_AUTHENTICATION_REQUIRED: Sign in to continue.
 * - JG_AGENT_HQ_CLIENT_ACCESS_DENIED: Access is denied.
 * - JG_AGENT_HQ_CLIENT_NOT_FOUND: Requested resource was not found.
 * - JG_AGENT_HQ_CLIENT_STATE_CONFLICT: State changed. Refresh before continuing.
 * - JG_AGENT_HQ_CLIENT_AGENT_UNAVAILABLE: Coding agent is unavailable.
 * - JG_AGENT_HQ_CLIENT_OPERATION_FAILED: Operation could not be completed.
 * - JG_AGENT_HQ_CLIENT_IMAGE_UNAVAILABLE: Image is unavailable.
 */
export const requestAgentHq = async (
  stateRoot: string,
  command: IHqRequestInput,
  signal?: AbortSignal,
): Promise<IHqResponse> => {
  const input = HqRequestSchema.safeParse(command);
  if (!input.success || !isAbsolute(stateRoot))
    throw new Exception('The HQ request is invalid', {
      code: 'JG_AGENT_HQ_REQUEST_INVALID',
      data: { kind: 'invalid-request' },
    });
  const { owner } = await readRuntimeOwner(stateRoot);
  const path = join(stateRoot, CONTROL_SOCKET);
  const socketDetails = await lstat(path);
  if (!socketDetails.isSocket() || socketDetails.isSymbolicLink() || !isPrivateOwner(socketDetails))
    throw new Exception('The HQ state file is unsafe', {
      code: 'JG_AGENT_HQ_STATE_FILE_UNSAFE',
      data: { kind: 'state-conflict' },
    });
  const id = randomUUID();
  const content = `${JSON.stringify({ schemaVersion: 1, id, runtimeEpoch: owner.nonce, command: input.data })}\n`;
  if (Buffer.byteLength(content) > MAX_REQUEST_BYTES)
    throw new Exception('The HQ request is invalid', {
      code: 'JG_AGENT_HQ_REQUEST_INVALID',
      data: { kind: 'invalid-request' },
    });
  const socket = createConnection(path);
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<IHqResponse>((resolve, reject) => {
      onAbort = () => {
        socket.destroy();
        reject(
          new Exception('The HQ transport failed', {
            code: 'JG_AGENT_HQ_TRANSPORT_FAILED',
            data: { kind: 'agent-unavailable' },
          }),
        );
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      socket.setTimeout(IPC_TIMEOUT_MS, () =>
        reject(
          new Exception('The HQ transport failed', {
            code: 'JG_AGENT_HQ_TRANSPORT_FAILED',
            data: { kind: 'agent-unavailable' },
          }),
        ),
      );
      socket.once('error', (cause) =>
        reject(
          new Exception(`The HQ transport failed: ${extractMessage(cause)}`, {
            code: 'JG_AGENT_HQ_TRANSPORT_FAILED',
            data: { kind: 'agent-unavailable' },
            cause,
          }),
        ),
      );
      let received = false;
      const decoder = createLineDecoder(MAX_FRAME_BYTES, (message) => {
        const parsed = IpcResponseSchema.safeParse(message);
        if (!parsed.success || parsed.data.id !== id)
          throw new Exception('The HQ transport failed', {
            code: 'JG_AGENT_HQ_TRANSPORT_FAILED',
            data: { kind: 'agent-unavailable' },
          });
        received = true;
        const response = parsed.data;
        if (!response.success) {
          reject(
            new Exception(PUBLIC_ERROR_MESSAGES[response.error.kind], {
              code: PUBLIC_ERROR_CODES[response.error.kind],
              data: {
                kind: response.error.kind,
              },
            }),
          );
          return;
        }
        if (response.response.kind !== input.data.kind)
          throw new Exception('The HQ transport failed', {
            code: 'JG_AGENT_HQ_TRANSPORT_FAILED',
            data: { kind: 'agent-unavailable' },
          });
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
              new Exception('The HQ transport failed', {
                code: 'JG_AGENT_HQ_TRANSPORT_FAILED',
                data: { kind: 'agent-unavailable' },
              }),
            );
        } catch (error) {
          reject(error);
        }
      });
      socket.once('connect', () => socket.write(content));
    });
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    socket.destroy();
  }
};
