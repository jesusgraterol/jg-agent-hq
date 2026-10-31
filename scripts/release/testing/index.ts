import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

// independent USTAR fixtures for protected-payload and registry-boundary tests
export type IArchiveFile = { name: string; content: string; mode?: number; type?: string };

/** Creates a fixed-time regular npm archive, allowing explicit invalid paths/types for refusal tests. */
export const buildArchive = (files: IArchiveFile[]): Buffer => {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const body = Buffer.from(file.content);
    const header = Buffer.alloc(512);
    header.write(file.name, 0, 100);
    header.write(`${(file.mode ?? 0o644).toString(8).padStart(7, '0')}\0`, 100, 8);
    header.write('0000000\0', 108, 8);
    header.write('0000000\0', 116, 8);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    header.write('00000000000\0', 136, 12);
    header.fill(32, 148, 156);
    header.write(file.type ?? '0', 156, 1);
    header.write('ustar\0', 257, 6);
    header.write('00', 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
};

/** Computes the exact archive identity used by the existing release receipt. */
export const archiveIntegrity = (bytes: Uint8Array): string =>
  `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
