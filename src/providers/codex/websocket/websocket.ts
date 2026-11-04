import { createHash, randomBytes } from 'node:crypto';
import { Exception } from 'jg-exception';

import { MAX_FRAME_BYTES } from '../../../ipc/index.js';
import type { IProviderFraming } from '../../index.js';
import { HQ_ERRORS } from '../../../errors/index.js';

import {
  KEEPALIVE_INTERVAL_MS,
  MAX_HANDSHAKE_BYTES,
  MAX_OUTGOING_FRAGMENT_BYTES,
  WEBSOCKET_GUID,
  WEBSOCKET_OPCODES,
} from './constants.js';

/**
 * Rejects bytes that break the WebSocket contract.
 * @throws
 * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
 */
const invalid = (cause?: unknown): never => {
  throw HQ_ERRORS.create('transportFailed', { data: { kind: 'invalid-request' }, cause });
};

/**
 * Builds one client frame, masked as RFC 6455 requires of clients.
 * @param isFinal Whether the frame ends its message; a fragment before the last one is not.
 * @returns The complete frame bytes.
 */
const encodeFrame = (opcode: number, payload: Buffer, isFinal = true): Buffer => {
  const lengthBytes = payload.length < 126 ? 0 : payload.length < 65_536 ? 2 : 8;
  const header = Buffer.alloc(2 + lengthBytes + 4);
  header[0] = (isFinal ? 0x80 : 0) | opcode;
  if (lengthBytes === 0) header[1] = 0x80 | payload.length;
  else if (lengthBytes === 2) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const mask = randomBytes(4);
  mask.copy(header, 2 + lengthBytes);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index += 1)
    masked[index] = payload[index]! ^ mask[index & 3]!;
  return Buffer.concat([header, masked]);
};

/**
 * Builds one text message: a single final frame of at most MAX_OUTGOING_FRAGMENT_BYTES, or else a
 * non-final text frame followed by continuation frames of at most that size, the last one final.
 * @returns The frames' bytes, in order.
 */
const encodeTextMessage = (payload: Buffer): Buffer => {
  if (payload.length <= MAX_OUTGOING_FRAGMENT_BYTES)
    return encodeFrame(WEBSOCKET_OPCODES.text, payload);
  const frames: Buffer[] = [];
  for (let start = 0; start < payload.length; start += MAX_OUTGOING_FRAGMENT_BYTES) {
    const end = Math.min(start + MAX_OUTGOING_FRAGMENT_BYTES, payload.length);
    const opcode = start === 0 ? WEBSOCKET_OPCODES.text : WEBSOCKET_OPCODES.continuation;
    frames.push(encodeFrame(opcode, payload.subarray(start, end), end === payload.length));
  }
  return Buffer.concat(frames);
};

/**
 * Speaks WebSocket over a byte stream, such as the Codex daemon's stdio proxy: an HTTP upgrade
 * with a verified accept key, masked text frames out, and bounded server frames in.
 * @returns Framing for one connection; each call uses a fresh handshake key.
 */
export const createWebSocketFraming = (): IProviderFraming => {
  const key = randomBytes(16).toString('base64');
  const accept = createHash('sha1')
    .update(key + WEBSOCKET_GUID)
    .digest('base64');
  return {
    preamble: Buffer.from(
      `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      'latin1',
    ),
    encode: (message) => encodeTextMessage(Buffer.from(JSON.stringify(message), 'utf8')),
    createDecoder({ receive, reply, open, fail, discard }) {
      const chunks: Buffer[] = [];
      let buffered = 0;
      let state: 'handshake' | 'frames' | 'closed' = 'handshake';
      let fragments: Buffer[] | null = null;
      let fragmentBytes = 0;
      // a message over the size limit is skipped through its final fragment, then reported
      let isDiscarding = false;
      let skipping = 0;
      let isDiscardComplete = false;
      let keepalive: ReturnType<typeof setInterval> | undefined;
      let isAwaitingPong = false;
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const stop = (): void => {
        clearInterval(keepalive);
        keepalive = undefined;
      };
      // each ping must be answered before the next one is due
      const probe = (): void => {
        if (isAwaitingPong) {
          stop();
          fail(
            new Exception('The HQ transport failed: the native connection stopped answering', {
              code: 'JG_AGENT_HQ_TRANSPORT_FAILED',
              data: { kind: 'agent-unavailable' },
            }),
          );
          return;
        }
        isAwaitingPong = true;
        reply(encodeFrame(WEBSOCKET_OPCODES.ping, Buffer.from('jg-agent-hq')));
      };
      // joins only the leading chunks a step needs, so large frames are copied once
      const read = (length: number, consume: boolean): Buffer => {
        if (!length) return Buffer.alloc(0);
        if (chunks[0]!.length < length) {
          let count = 0;
          let total = 0;
          while (total < length) total += chunks[count++]!.length;
          chunks.splice(0, count, Buffer.concat(chunks.slice(0, count), total));
        }
        const first = chunks[0]!;
        const result = first.subarray(0, length);
        if (consume) {
          if (first.length === length) chunks.shift();
          else chunks[0] = first.subarray(length);
          buffered -= length;
        }
        return result;
      };
      // drops bytes that are being skipped without joining them first
      const drop = (length: number): void => {
        let remaining = length;
        while (remaining > 0) {
          const first = chunks[0]!;
          if (first.length <= remaining) {
            chunks.shift();
            remaining -= first.length;
          } else {
            chunks[0] = first.subarray(remaining);
            remaining = 0;
          }
        }
        buffered -= length;
      };
      // reports a discarded message once its final fragment has been skipped
      const settleDiscard = (): void => {
        if (skipping > 0 || !isDiscardComplete) return;
        isDiscardComplete = false;
        discard();
      };
      const handshake = (): boolean => {
        const head = read(Math.min(buffered, MAX_HANDSHAKE_BYTES), false);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) {
          if (buffered >= MAX_HANDSHAKE_BYTES) invalid();
          return false;
        }
        const response = read(end + 4, true).toString('latin1');
        const accepted = /^sec-websocket-accept:[ \t]*(\S+)[ \t]*$/im.exec(response)?.[1];
        if (!/^HTTP\/1\.1 101 /.test(response) || accepted !== accept) invalid();
        state = 'frames';
        keepalive = setInterval(probe, KEEPALIVE_INTERVAL_MS);
        keepalive.unref();
        open();
        return true;
      };
      const deliver = (payload: Buffer): void => {
        let message: unknown;
        try {
          message = JSON.parse(decoder.decode(payload));
        } catch (cause) {
          invalid(cause);
        }
        receive(message);
      };
      // returns false until a complete frame is buffered
      const frame = (): boolean => {
        if (skipping > 0) {
          const dropped = Math.min(skipping, buffered);
          drop(dropped);
          skipping -= dropped;
          settleDiscard();
          return skipping === 0;
        }
        if (buffered < 2) return false;
        const start = read(Math.min(buffered, 10), false);
        const isFinal = (start[0]! & 0x80) !== 0;
        const opcode = start[0]! & 0x0f;
        if (start[0]! & 0x70 || start[1]! & 0x80) invalid();
        let length = start[1]! & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (start.length < 4) return false;
          length = start.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (start.length < 10) return false;
          const extended = start.readBigUInt64BE(2);
          if (extended > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
          length = Number(extended);
          offset = 10;
        }
        const isControl = opcode >= WEBSOCKET_OPCODES.close;
        if (isControl && (!isFinal || length > 125)) invalid();
        const isData =
          opcode === WEBSOCKET_OPCODES.text || opcode === WEBSOCKET_OPCODES.continuation;
        if (!isControl && !isData) invalid();
        // a text frame starts a message, and a continuation frame continues one
        if (isData && (opcode === WEBSOCKET_OPCODES.text) === (fragments !== null || isDiscarding))
          invalid();
        if (isData && (isDiscarding || fragmentBytes + length > MAX_FRAME_BYTES)) {
          // the message is too large: drop what it gathered and skip it through its final fragment
          if (buffered < offset) return false;
          read(offset, true);
          fragments = null;
          fragmentBytes = 0;
          isDiscarding = !isFinal;
          isDiscardComplete = isFinal;
          skipping = length;
          settleDiscard();
          return true;
        }
        if (buffered < offset + length) return false;
        read(offset, true);
        const payload = Buffer.from(read(length, true));
        if (opcode === WEBSOCKET_OPCODES.ping) reply(encodeFrame(WEBSOCKET_OPCODES.pong, payload));
        else if (opcode === WEBSOCKET_OPCODES.pong) isAwaitingPong = false;
        else if (opcode === WEBSOCKET_OPCODES.close) {
          // the daemon ended the connection; nothing further will arrive
          state = 'closed';
          stop();
          fail(
            new Exception('The HQ transport failed: the native connection closed', {
              code: 'JG_AGENT_HQ_TRANSPORT_FAILED',
              data: { kind: 'agent-unavailable' },
            }),
          );
        } else {
          if (isFinal && !fragments) deliver(payload);
          else {
            (fragments ??= []).push(payload);
            fragmentBytes += payload.length;
            if (isFinal) {
              const message = Buffer.concat(fragments, fragmentBytes);
              fragments = null;
              fragmentBytes = 0;
              deliver(message);
            }
          }
        }
        return true;
      };
      return {
        push(chunk) {
          if (state === 'closed') return;
          chunks.push(chunk);
          buffered += chunk.length;
          if (state === 'handshake' && !handshake()) return;
          while (state === 'frames' && frame());
        },
        end() {
          stop();
          if (
            state === 'handshake' ||
            (state === 'frames' && (buffered || fragments || isDiscarding || skipping))
          )
            invalid();
        },
        stop,
      };
    },
  };
};
