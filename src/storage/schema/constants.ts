import { readFileSync } from 'node:fs';
import { hashValue } from 'jg-crypto';
import { z } from 'zod';

// the version stamped into databases and snapshots this package writes
export const PACKAGE_VERSION = z
  .object({ version: z.string().min(1).max(64) })
  .parse(
    JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')),
  ).version;

// the one schema this package reads; package-owned SQL is immutable during a process lifetime
export const CURRENT_SCHEMA_HASH = hashValue(
  readFileSync(new URL('../../store/schema.sql', import.meta.url)),
);
