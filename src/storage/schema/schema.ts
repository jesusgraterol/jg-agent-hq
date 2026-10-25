import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { hashValue } from 'jg-crypto';
import { Exception, isException, extractMessage } from 'jg-exception';

import { CURRENT_SCHEMA_VERSION, V1_SCHEMA_HASH } from './constants.js';
import { StorageStampSchema, type IStorageSchema, type IStorageMigration } from './types.js';

// package-owned SQL is small and immutable during a process lifetime
export const STORAGE_SCHEMAS: IStorageSchema[] = [
  { version: 1, hash: V1_SCHEMA_HASH, restoreFenceVersion: 1 },
  {
    version: CURRENT_SCHEMA_VERSION,
    hash: hashValue(readFileSync(new URL('../../store/schema.sql', import.meta.url))),
    restoreFenceVersion: 1,
  },
];
export const STORAGE_MIGRATIONS: IStorageMigration[] = [
  { fromVersion: 1, toVersion: 2, source: new URL('./v1-to-v2.sql', import.meta.url) },
];

/**
 * Recognizes one supported stamp without writing or adopting an arbitrary database.
 * @returns The registered lineage and key hash, or null for a completely empty database.
 * @throws
 * - JG_AGENT_HQ_STORAGE_INVALID: The HQ storage is invalid
 * - JG_AGENT_HQ_STORAGE_VERSION_UNSUPPORTED: The HQ storage version is unsupported
 * - JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE: The HQ action key is unavailable
 */
export const readStorageSchema = (
  database: DatabaseSync,
  actionKeyHash?: string,
): { schema: IStorageSchema; actionKeyHash: string } | null => {
  try {
    if (!database.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()) return null;
    const hasVersion = database
      .prepare('PRAGMA table_xinfo(hq_schema)')
      .all()
      .some((column) => column.name === 'schema_version');
    const rows = database
      .prepare(
        `SELECT id, schema_hash, action_key_hash${hasVersion ? ', schema_version' : ''} FROM hq_schema LIMIT 2`,
      )
      .all();
    const parsed = StorageStampSchema.safeParse(rows.length === 1 ? rows[0] : null);
    if (!parsed.success)
      throw new Exception('The HQ storage is invalid', {
        code: 'JG_AGENT_HQ_STORAGE_INVALID',
        data: { kind: 'state-conflict' },
      });
    const stamp = parsed.data;
    const schema = hasVersion
      ? STORAGE_SCHEMAS.find((entry) => entry.version === stamp.schema_version)
      : STORAGE_SCHEMAS.find((entry) => entry.version === 1 && entry.hash === stamp.schema_hash);
    if (!schema)
      throw new Exception('The HQ storage version is unsupported', {
        code: 'JG_AGENT_HQ_STORAGE_VERSION_UNSUPPORTED',
        data: { kind: 'state-conflict' },
      });
    if (schema.hash !== stamp.schema_hash)
      throw new Exception('The HQ storage is invalid', {
        code: 'JG_AGENT_HQ_STORAGE_INVALID',
        data: { kind: 'state-conflict' },
      });
    if (actionKeyHash !== undefined && stamp.action_key_hash !== actionKeyHash)
      throw new Exception('The HQ action key is unavailable', {
        code: 'JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE',
        data: { kind: 'state-conflict' },
      });
    return { schema, actionKeyHash: stamp.action_key_hash };
  } catch (cause) {
    if (isException(cause)) throw cause;
    throw new Exception(`The HQ storage is invalid: ${extractMessage(cause)}`, {
      code: 'JG_AGENT_HQ_STORAGE_INVALID',
      data: { kind: 'state-conflict' },
      cause,
    });
  }
};
