import { DatabaseSync } from 'node:sqlite';

import { readStorageStamp } from '../storage/schema/index.js';

import { invalidSnapshot } from './files.js';

/**
 * Invalidates current execution authority while retaining immutable receipts, IDs and write intents.
 * Plans that changed during capture also lose their thread bindings' execution scope, so their
 * work resumes only under fresh authority. Source paths remain evidence and require explicit host
 * root selection on startup.
 * @throws
 * - JG_AGENT_HQ_STORAGE_INVALID: The HQ storage is invalid
 * - JG_AGENT_HQ_SNAPSHOT_INVALID: The HQ snapshot is invalid
 */
export const applyRestoreFences = (filename: string, changedDirectories: string[]): void => {
  const database = new DatabaseSync(filename, { enableForeignKeyConstraints: true });
  try {
    if (!readStorageStamp(database)) invalidSnapshot();
    database.exec('PRAGMA synchronous = FULL; BEGIN IMMEDIATE');
    try {
      const now = Date.now();
      database
        .prepare(
          "UPDATE hq_collaboration_task SET state = CASE WHEN state = 'stopped' THEN state ELSE 'paused' END, lifecycle_revision = lifecycle_revision + 1, policy_revision = policy_revision + 1, policy = json_set(policy, '$.automaticDispatch', json('false'))",
        )
        .run();
      database
        .prepare(
          "UPDATE hq_task_agent SET state = CASE WHEN state = 'stopped' THEN state ELSE 'paused' END, revision = revision + 1",
        )
        .run();
      database.prepare('UPDATE hq_skill_grant SET revoked_at = COALESCE(revoked_at, ?)').run(now);
      database
        .prepare("UPDATE hq_thread SET ownership = 'uncertain', state = 'unknown', updated_at = ?")
        .run(now);
      database
        .prepare(
          "UPDATE hq_action SET delivery = 'uncertain', updated_at = ? WHERE delivery = 'submitted'",
        )
        .run(now);
      database.exec('UPDATE hq_action SET queue_ready = 0');
      database
        .prepare(
          "UPDATE hq_native_approval SET state = 'expired', updated_at = ? WHERE state = 'pending'",
        )
        .run(now);
      const strip = database.prepare(
        "UPDATE hq_thread_plan SET authorization_id = NULL, milestone_id = NULL, context = json_set(context, '$.scope', json('null')) WHERE directory = ?",
      );
      for (const directory of changedDirectories) strip.run(directory);
      database.exec('COMMIT');
    } catch (cause) {
      database.exec('ROLLBACK');
      throw cause;
    }
  } finally {
    database.close();
  }
};
