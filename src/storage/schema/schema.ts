import type { DatabaseSync } from 'node:sqlite';
import { Exception, isException, extractMessage } from 'jg-exception';

import { HQ_ERRORS } from '../../errors/index.js';
import { CURRENT_SCHEMA_HASH, KNOWN_PREVIOUS_SCHEMA_HASH } from './constants.js';
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
 * Recognizes the current stamp without writes; only exclusive startup may accept the known
 * predecessor for its finite upgrade. Snapshot readers keep the strict default.
 * @returns The stamped action key hash and package version, or null for a completely empty database.
 * @throws
 * - JG_AGENT_HQ_STORAGE_INVALID: The HQ storage is invalid
 * - JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE: The HQ action key is unavailable
 */
export const readStorageStamp = (
  database: DatabaseSync,
  actionKeyHash?: string,
  allowKnownUpgrade = false,
): { actionKeyHash: string; packageVersion: string } | null => {
  try {
    if (!database.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()) return null;
    const columns = database
      .prepare('PRAGMA table_xinfo(agent_hq_schema)')
      .all()
      .map((column) => column.name);
    // a stamp without the package version comes from an earlier package
    if (columns.length && !columns.includes('package_version')) rejectStorage(null);
    const rows = database
      .prepare(
        'SELECT id, schema_hash, action_key_hash, package_version FROM agent_hq_schema LIMIT 2',
      )
      .all();
    const parsed = StorageStampSchema.safeParse(rows.length === 1 ? rows[0] : null);
    if (!parsed.success)
      throw HQ_ERRORS.create('storageInvalid', {
        data: { kind: 'state-conflict' },
        cause: parsed.error,
      });
    const stamp = parsed.data;
    if (
      stamp.schema_hash !== CURRENT_SCHEMA_HASH &&
      !(allowKnownUpgrade && stamp.schema_hash === KNOWN_PREVIOUS_SCHEMA_HASH)
    )
      rejectStorage(stamp.package_version);
    if (actionKeyHash !== undefined && stamp.action_key_hash !== actionKeyHash)
      throw HQ_ERRORS.create('actionKeyUnavailable', { data: { kind: 'state-conflict' } });
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
