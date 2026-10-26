// RFC 6455 handshake suffix hashed with the client key to prove the server upgraded
export const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// the bounded HTTP upgrade response read before frames begin
export const MAX_HANDSHAKE_BYTES = 16_384;

/*
 * The stdio proxy notices a stopped daemon only when it next writes, so HQ pings this often. A
 * dead daemon fails that write at once; a hung one misses the pong until the next ping.
 */
export const KEEPALIVE_INTERVAL_MS = 10_000;

// RFC 6455 frame opcodes used by the daemon connection
export const WEBSOCKET_OPCODES = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;
