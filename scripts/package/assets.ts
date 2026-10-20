import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// tsc emits code; the worker reads this fixed, package-owned schema at startup
await copyFile(
  resolve(import.meta.dirname, '../../src/store/schema.sql'),
  resolve(import.meta.dirname, '../../dist/store/schema.sql'),
);
