import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

// build output is owned by this package, independently of the caller's directory
await rm(resolve(import.meta.dirname, '../../dist'), { recursive: true, force: true });
