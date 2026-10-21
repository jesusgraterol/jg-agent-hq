import { Exception } from 'jg-exception';

/**
 * Decodes bounded JSON lines with amortized linear copying across fragmented input.
 * @param maxBytes Maximum bytes in one JSON frame.
 * @param receive The owner of each decoded message.
 * @returns A decoder whose end operation rejects incomplete tails.
 * @throws
 * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
 */
export const createLineDecoder = (maxBytes: number, receive: (message: unknown) => void) => {
  let buffer = Buffer.alloc(Math.min(1024, maxBytes));
  let used = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return {
    push(chunk: Buffer): void {
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const length = end - offset;
        if (used + length > maxBytes)
          throw new Exception('The HQ transport failed', {
            code: 'JG_AGENT_HQ_TRANSPORT_FAILED',
            data: { kind: 'invalid-request' },
          });
        if (used + length > buffer.length) {
          const expanded = Buffer.alloc(
            Math.min(maxBytes, Math.max(buffer.length * 2, used + length)),
          );
          buffer.copy(expanded, 0, 0, used);
          buffer = expanded;
        }
        chunk.copy(buffer, used, offset, end);
        used += length;
        if (newline >= 0) {
          let message: unknown;
          try {
            message = JSON.parse(decoder.decode(buffer.subarray(0, used)));
          } catch (cause) {
            throw new Exception('The HQ transport failed', {
              code: 'JG_AGENT_HQ_TRANSPORT_FAILED',
              data: { kind: 'invalid-request' },
              cause,
            });
          }
          used = 0;
          receive(message);
        }
        offset = newline < 0 ? chunk.length : newline + 1;
      }
    },
    end(): void {
      if (used)
        throw new Exception('The HQ transport failed', {
          code: 'JG_AGENT_HQ_TRANSPORT_FAILED',
          data: { kind: 'invalid-request' },
        });
    },
  };
};
