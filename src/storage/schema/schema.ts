import type { DatabaseSync } from 'node:sqlite';
import { Exception, isException, extractMessage } from 'jg-exception';

import { CURRENT_SCHEMA_HASH } from './constants.js';
import { StorageStampSchema } from './types.js';

/**
 * Rejects storage written by another schema, naming the package version that wrote it.
 * @throws
 * - JG_AGENT_HQ_STORAGE_INVALID: The HQ storage is invalid
 */
export const rejectStorage = (packageVersion: string | null, cause?: unknown): never => {
  throw new Exception(
    `The HQ storage is invalid: written by ${packageVersion ? `jg-agent-hq ${packageVersion}` : 'another jg-agent-hq version'}`,
    { code: 'JG_AGENT_HQ_STORAGE_INVALID', data: { kind: 'state-conflict' }, cause },
  );
};

/**
 * Recognizes the current schema's stamp without writing or adopting an arbitrary database.
 * @returns The stamped action key hash and package version, or null for a completely empty database.
 * @throws
 * - JG_AGENT_HQ_STORAGE_INVALID: The HQ storage is invalid
 * - JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE: The HQ action key is unavailable
 */
export const readStorageStamp = (
  database: DatabaseSync,
  actionKeyHash?: string,
): { actionKeyHash: string; packageVersion: string } | null => {
  try {
    if (!database.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()) return null;
    const columns = database
      .prepare('PRAGMA table_xinfo(hq_schema)')
      .all()
      .map((column) => column.name);
    // a stamp without the package version comes from an earlier package
    if (columns.length && !columns.includes('package_version')) rejectStorage(null);
    const rows = database
      .prepare('SELECT id, schema_hash, action_key_hash, package_version FROM hq_schema LIMIT 2')
      .all();
    const parsed = StorageStampSchema.safeParse(rows.length === 1 ? rows[0] : null);
    if (!parsed.success)
      throw new Exception('The HQ storage is invalid', {
        code: 'JG_AGENT_HQ_STORAGE_INVALID',
        data: { kind: 'state-conflict' },
        cause: parsed.error,
      });
    const stamp = parsed.data;
    if (stamp.schema_hash !== CURRENT_SCHEMA_HASH) rejectStorage(stamp.package_version);
    if (actionKeyHash !== undefined && stamp.action_key_hash !== actionKeyHash)
      throw new Exception('The HQ action key is unavailable', {
        code: 'JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE',
        data: { kind: 'state-conflict' },
      });
    return { actionKeyHash: stamp.action_key_hash, packageVersion: stamp.package_version };
  } catch (cause) {
    if (isException(cause)) throw cause;
    throw new Exception(`The HQ storage is invalid: ${extractMessage(cause)}`, {
      code: 'JG_AGENT_HQ_STORAGE_INVALID',
      data: { kind: 'state-conflict' },
      cause,
    });
  }
};
