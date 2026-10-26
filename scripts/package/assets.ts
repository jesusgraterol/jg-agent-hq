import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// fixed package-owned SQL assets; no test or source-tree discovery
for (const asset of ['store/schema.sql']) {
  const destination = resolve(import.meta.dirname, '../../dist', asset);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(resolve(import.meta.dirname, '../../src', asset), destination);
}
