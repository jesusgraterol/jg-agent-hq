import { createHash } from 'node:crypto';
import { expectToThrowCode } from 'jg-exception/testing';
import { afterEach, expect, test, vi } from 'vitest';

import { createWebSocketFraming } from './index.js';

// the server side of each exchange, written independently of the client implementation
const serverFrame = (
  payload: Buffer | string,
  options: { opcode?: number; isFinal?: boolean; mask?: boolean; rsv?: number } = {},
): Buffer => {
  const body = Buffer.from(payload);
  const header =
    body.length < 126
      ? Buffer.from([0, body.length])
      : body.length < 65_536
        ? Buffer.from([0, 126, body.length >> 8, body.length & 255])
        : Buffer.concat([Buffer.from([0, 127]), Buffer.alloc(8)]);
  if (body.length >= 65_536) header.writeBigUInt64BE(BigInt(body.length), 2);
  header[0] = ((options.isFinal ?? true) ? 0x80 : 0) | (options.rsv ?? 0) | (options.opcode ?? 1);
  if (options.mask) header[1]! |= 0x80;
  return Buffer.concat([header, options.mask ? Buffer.alloc(4) : Buffer.alloc(0), body]);
};

const unmaskClientFrame = (frame: Buffer) => {
  let length = frame[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    length = frame.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    length = Number(frame.readBigUInt64BE(2));
    offset = 10;
  }
  const mask = frame.subarray(offset, offset + 4);
  const payload = Buffer.from(frame.subarray(offset + 4, offset + 4 + length)).map(
    (byte, index) => byte ^ mask[index & 3]!,
  );
  return {
    isFinal: (frame[0]! & 0x80) !== 0,
    opcode: frame[0]! & 0x0f,
    isMasked: (frame[1]! & 0x80) !== 0,
    length,
    payload: Buffer.from(payload),
  };
};

// opens a connection by answering the client's own handshake key
const open = () => {
  const framing = createWebSocketFraming();
  const key = /Sec-WebSocket-Key: (\S+)/.exec(framing.preamble!.toString('latin1'))![1]!;
  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  const received: unknown[] = [];
  const replies: Buffer[] = [];
  const failures: unknown[] = [];
  let opens = 0;
  const decoder = framing.createDecoder({
    receive: (message) => received.push(message),
    reply: (bytes) => replies.push(bytes),
    open: () => (opens += 1),
    fail: (cause) => failures.push(cause),
  });
  const response = Buffer.from(
    `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nsec-websocket-accept: ${accept}\r\n\r\n`,
    'latin1',
  );
  return {
    framing,
    decoder,
    received,
    replies,
    failures,
    response,
    accept,
    opens: () => opens,
  };
};

afterEach(() => {
  vi.useRealTimers();
});

test('the handshake opens only on a 101 response carrying the accept key for its own request', () => {
  const connection = open();
  expect(connection.framing.preamble!.toString('latin1')).toMatch(
    /^GET \/ HTTP\/1\.1\r\n[\s\S]*Upgrade: websocket\r\n[\s\S]*Sec-WebSocket-Version: 13\r\n\r\n$/,
  );
  connection.decoder.push(connection.response.subarray(0, 20));
  expect(connection.opens()).toBe(0);
  connection.decoder.push(
    Buffer.concat([connection.response.subarray(20), serverFrame('{"id":1,"result":{}}')]),
  );
  expect(connection.opens()).toBe(1);
  expect(connection.received).toStrictEqual([{ id: 1, result: {} }]);

  const wrongKey = open();
  expectToThrowCode(
    () =>
      wrongKey.decoder.push(
        Buffer.from(
          'HTTP/1.1 101 Switching Protocols\r\nsec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n',
        ),
      ),
    'JG_AGENT_HQ_TRANSPORT_FAILED',
  );
  const refused = open();
  expectToThrowCode(
    () =>
      refused.decoder.push(
        Buffer.from(`HTTP/1.1 400 Bad Request\r\nsec-websocket-accept: ${refused.accept}\r\n\r\n`),
      ),
    'JG_AGENT_HQ_TRANSPORT_FAILED',
  );
  expect(wrongKey.opens() + refused.opens()).toBe(0);
});

test('an unbounded handshake response and a stream that ends before opening are rejected', () => {
  const unbounded = open();
  expectToThrowCode(
    () => unbounded.decoder.push(Buffer.alloc(16_384, 'a')),
    'JG_AGENT_HQ_TRANSPORT_FAILED',
  );
  const cut = open();
  cut.decoder.push(cut.response.subarray(0, 10));
  expectToThrowCode(() => cut.decoder.end(), 'JG_AGENT_HQ_TRANSPORT_FAILED');
});

test.each([
  [2, 2],
  [125, 125],
  [126, 126],
  [65_535, 126],
  [65_536, 127],
])('encode(%d payload bytes) -> masked final text frame with length code %d', (size, code) => {
  // a JSON string adds its two quotes to the payload
  const text = 'x'.repeat(size - 2);
  const encoded = open().framing.encode(text);
  const frame = unmaskClientFrame(encoded);
  expect(encoded[1]! & 0x7f).toBe(code);
  expect(frame).toMatchObject({ isFinal: true, opcode: 1, isMasked: true, length: size });
  expect(JSON.parse(frame.payload.toString('utf8'))).toBe(text);
});

test('fragments reassemble across arbitrary chunk boundaries while interleaved pings are answered', () => {
  const connection = open();
  const message = JSON.stringify({ method: 'turn/started', params: { text: '🧪'.repeat(40_000) } });
  const split = Buffer.from(message);
  const bytes = Buffer.concat([
    connection.response,
    serverFrame(split.subarray(0, 7), { isFinal: false }),
    serverFrame('keepalive', { opcode: 9 }),
    serverFrame(split.subarray(7, 70_000), { opcode: 0, isFinal: false }),
    serverFrame(split.subarray(70_000), { opcode: 0 }),
    serverFrame('{"id":2,"result":null}'),
  ]);
  for (let offset = 0; offset < bytes.length; offset += 997)
    connection.decoder.push(bytes.subarray(offset, offset + 997));
  expect(connection.received).toStrictEqual([JSON.parse(message), { id: 2, result: null }]);
  expect(connection.replies).toHaveLength(1);
  expect(unmaskClientFrame(connection.replies[0]!)).toMatchObject({
    isFinal: true,
    opcode: 10,
    isMasked: true,
    payload: Buffer.from('keepalive'),
  });
  connection.decoder.end();
});

test.each([
  ['a masked server frame', serverFrame('{}', { mask: true })],
  ['reserved bits without an extension', serverFrame('{}', { rsv: 0x40 })],
  ['a binary frame', serverFrame('{}', { opcode: 2 })],
  ['an unknown opcode', serverFrame('{}', { opcode: 3 })],
  ['a fragmented control frame', serverFrame('ping', { opcode: 9, isFinal: false })],
  ['an oversized control frame', serverFrame('x'.repeat(126), { opcode: 9 })],
  ['a continuation without a start', serverFrame('{}', { opcode: 0 })],
  [
    'a new message before the last one finished',
    Buffer.concat([serverFrame('{', { isFinal: false }), serverFrame('{}')]),
  ],
  ['invalid UTF-8', serverFrame(Buffer.from([0xc3, 0x28]))],
  ['invalid JSON', serverFrame('{"id":')],
  [
    'a declared length beyond the frame limit',
    Buffer.concat([Buffer.from([0x81, 127]), Buffer.from([0, 0, 0, 0, 0, 0x80, 0, 1])]),
  ],
  [
    'fragments beyond the frame limit',
    Buffer.concat([
      serverFrame(Buffer.alloc(4_194_304, 0x20), { isFinal: false }),
      serverFrame(Buffer.alloc(4_194_305, 0x20), { opcode: 0 }),
    ]),
  ],
])('decode(%s) -> transport failure', (_label, frame) => {
  const connection = open();
  connection.decoder.push(connection.response);
  expectToThrowCode(() => connection.decoder.push(frame), 'JG_AGENT_HQ_TRANSPORT_FAILED');
  expect(connection.received).toStrictEqual([]);
});

test('a close frame ends delivery, and an ending stream mid-frame or mid-message is incomplete', () => {
  const closed = open();
  closed.decoder.push(
    Buffer.concat([closed.response, serverFrame('', { opcode: 8 }), serverFrame('{}')]),
  );
  expect(closed.received).toStrictEqual([]);
  expect(closed.failures).toHaveLength(1);
  expectToThrowCode(() => {
    throw closed.failures[0];
  }, 'JG_AGENT_HQ_TRANSPORT_FAILED');
  closed.decoder.end();

  const midFrame = open();
  midFrame.decoder.push(Buffer.concat([midFrame.response, serverFrame('{"id":1}').subarray(0, 5)]));
  expectToThrowCode(() => midFrame.decoder.end(), 'JG_AGENT_HQ_TRANSPORT_FAILED');

  const midMessage = open();
  midMessage.decoder.push(
    Buffer.concat([midMessage.response, serverFrame('{"id":', { isFinal: false })]),
  );
  expectToThrowCode(() => midMessage.decoder.end(), 'JG_AGENT_HQ_TRANSPORT_FAILED');
});

test('after opening, each 10-second ping must be answered before the next one is due', () => {
  vi.useFakeTimers();
  const connection = open();
  vi.advanceTimersByTime(30_000);
  expect(connection.replies).toStrictEqual([]);
  connection.decoder.push(connection.response);
  vi.advanceTimersByTime(9_999);
  expect(connection.replies).toHaveLength(0);
  vi.advanceTimersByTime(1);
  expect(unmaskClientFrame(connection.replies[0]!)).toMatchObject({
    isFinal: true,
    opcode: 9,
    isMasked: true,
  });
  connection.decoder.push(serverFrame('jg-agent-hq', { opcode: 10 }));
  vi.advanceTimersByTime(10_000);
  expect(connection.replies).toHaveLength(2);
  expect(connection.failures).toStrictEqual([]);
  vi.advanceTimersByTime(10_000);
  expect(connection.failures).toHaveLength(1);
  expectToThrowCode(() => {
    throw connection.failures[0];
  }, 'JG_AGENT_HQ_TRANSPORT_FAILED');
  vi.advanceTimersByTime(60_000);
  expect(connection.replies).toHaveLength(2);
  expect(connection.failures).toHaveLength(1);
});

test('stopping, ending or a close frame ends the pings', () => {
  vi.useFakeTimers();
  for (const [finish, failureCount] of [
    [(connection: ReturnType<typeof open>) => connection.decoder.stop(), 0],
    [(connection: ReturnType<typeof open>) => connection.decoder.end(), 0],
    [
      (connection: ReturnType<typeof open>) =>
        connection.decoder.push(serverFrame('', { opcode: 8 })),
      1,
    ],
  ] as const) {
    const connection = open();
    connection.decoder.push(connection.response);
    finish(connection);
    vi.advanceTimersByTime(60_000);
    expect(connection.replies).toStrictEqual([]);
    expect(connection.failures).toHaveLength(failureCount);
  }
});

test('a 1 MiB message split into 4 KiB chunks reassembles exactly once', () => {
  const connection = open();
  const message = { method: 'item/completed', params: { text: 'é'.repeat(524_000) } };
  const bytes = Buffer.concat([connection.response, serverFrame(JSON.stringify(message))]);
  for (let offset = 0; offset < bytes.length; offset += 4096)
    connection.decoder.push(bytes.subarray(offset, offset + 4096));
  expect(connection.received).toStrictEqual([message]);
  connection.decoder.end();
});
