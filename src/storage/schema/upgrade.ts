import type { DatabaseSync } from 'node:sqlite';
import { Exception, extractMessage, isException } from 'jg-exception';
import { z } from 'zod';

import { HQ_ERRORS } from '../../errors/index.js';

import { CURRENT_SCHEMA_HASH, KNOWN_PREVIOUS_SCHEMA_HASH, PACKAGE_VERSION } from './constants.js';
import { readStorageStamp } from './schema.js';

const SqlSchema = z.object({ sql: z.string().min(1) });
const ColumnSchema = z.object({ name: z.string().min(1), hidden: z.literal(0) });

/**
 * Upgrades the sole known predecessor under the runtime's exclusive ownership, before readers
 * or prepared statements exist. All native and host state stays in the same transaction.
 * @returns Whether this connection performed the finite upgrade.
 * @throws
 * - JG_AGENT_HQ_STORAGE_INVALID: The HQ storage is invalid
 * - JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE: The HQ action key is unavailable
 */
export const upgradeWorkspaceSchema = (
  database: DatabaseSync,
  source: string,
  actionKeyHash: string,
): boolean => {
  if (!readStorageStamp(database, actionKeyHash, true)) return false;
  const stamp = database.prepare('SELECT schema_hash FROM agent_hq_schema WHERE id = 1').get();
  if (stamp?.schema_hash !== KNOWN_PREVIOUS_SCHEMA_HASH) return false;
  const foreignKeys = database.prepare('PRAGMA foreign_keys').get()?.foreign_keys;
  if (foreignKeys !== 0 && foreignKeys !== 1) throw HQ_ERRORS.create('storageInvalid');
  database.exec('PRAGMA foreign_keys = OFF');
  try {
    database.exec('BEGIN IMMEDIATE');
    try {
      readStorageStamp(database, actionKeyHash, true);
      const previous = SqlSchema.parse(
        database
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'agent_hq_action'",
          )
          .get(),
      ).sql;
      const phase = "'close', 'delete', 'reply'";
      const inputKinds = "kind IN ('queue', 'thread-create')";
      if (
        !previous.startsWith('CREATE TABLE agent_hq_action (') ||
        previous.split(phase).length !== 2 ||
        previous.split(inputKinds).length !== 2 ||
        !previous.includes('CONSTRAINT agent_hq_pk_a__id') ||
        previous.includes('deleted_native_id')
      )
        throw HQ_ERRORS.create('storageInvalid', { data: { kind: 'state-conflict' } });
      const columns = z
        .array(ColumnSchema)
        .parse(database.prepare('PRAGMA table_xinfo(agent_hq_action)').all());
      const indices = z
        .array(SqlSchema)
        .parse(
          database
            .prepare(
              "SELECT sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'agent_hq_action' AND sql IS NOT NULL ORDER BY name",
            )
            .all(),
        );
      const replacement = previous
        .replace('CREATE TABLE agent_hq_action (', 'CREATE TABLE agent_hq_action_upgrade (')
        .replace(phase, `${phase}, 'workspace'`)
        .replace(inputKinds, "kind IN ('queue', 'thread-create', 'message')")
        .replace(
          'CONSTRAINT agent_hq_pk_a__id',
          'deleted_native_id TEXT,\n  CONSTRAINT agent_hq_pk_a__id',
        );
      database.exec(replacement);
      const names = columns.map(({ name }) => `"${name.replaceAll('"', '""')}"`).join(', ');
      database.exec(
        `INSERT INTO agent_hq_action_upgrade (${names}) SELECT ${names} FROM agent_hq_action`,
      );
      database.exec(
        'DROP TABLE agent_hq_action; ALTER TABLE agent_hq_action_upgrade RENAME TO agent_hq_action',
      );
      for (const { sql } of indices) database.exec(sql);
      const start = source.indexOf('-- workspace transitions\n');
      const end = source.indexOf('-- end workspace transitions\n');
      if (start < 0 || end <= start) throw HQ_ERRORS.create('storageInvalid');
      database.exec(source.slice(start, end));
      if (
        database.prepare('PRAGMA foreign_key_check').get() ||
        database.prepare('PRAGMA integrity_check(1)').get()?.integrity_check !== 'ok'
      )
        throw HQ_ERRORS.create('storageInvalid', { data: { kind: 'state-conflict' } });
      database
        .prepare('UPDATE agent_hq_schema SET schema_hash = ?, package_version = ? WHERE id = 1')
        .run(CURRENT_SCHEMA_HASH, PACKAGE_VERSION);
      database.exec('COMMIT');
      return true;
    } catch (cause) {
      database.exec('ROLLBACK');
      throw cause;
    }
  } catch (cause) {
    if (isException(cause)) throw cause;
    throw new Exception(`The HQ storage is invalid: ${extractMessage(cause)}`, {
      code: 'JG_AGENT_HQ_STORAGE_INVALID',
      data: { kind: 'state-conflict' },
      cause,
    });
  } finally {
    database.exec(`PRAGMA foreign_keys = ${foreignKeys === 1 ? 'ON' : 'OFF'}`);
  }
};
