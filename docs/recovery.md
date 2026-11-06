# Snapshot recovery

The runtime supplies local capture, encrypted packing and offline restore primitives, each of which inspects the complete snapshot. The Node signatures and inventory contract live in [the API reference](../api/README.md#snapshot-and-restore).

## Capture

Capture runs while agents keep working, under the state root's `snapshot` lock. Keep the host's own connections from writing host tables until capture resolves. Capture includes committed WAL data, application tables and action.key.

Capture leaves out the index the runtime keeps of Claude transcripts, the `agent_hq_claude_file` and `agent_hq_claude_entry` rows, which make up most of a database that has read Claude sessions, and compacts the copy with `VACUUM INTO`, which keeps the rowids of every table, including application tables. The snapshot of such a database is a small fraction of its size.

A successful snapshot has exact file hashes and a final completion marker. The header records the package version that captured it, and the database stamp binds its schema, action-key fingerprint and writing package version; restore and runtime startup reject a mismatched key or another schema. Keep it private. It excludes repositories and other workspace files, native transcripts/authentication, external references and transient runtime credentials. Inspection establishes complete local file/database evidence; hashes provide integrity rather than sender authentication.

## Restore

Stop all connections to the proposed destination and choose a new recovery workspace. Restore validates source and staged copies and refuses every existing target. It creates the recovered state directory, a recovery.jsonl copy of the source manifest and a recovered.json completion record. Never use output left incomplete by a crash. Caught failures clean only the output that operation created.

Start the runtime with the returned stateRoot and explicit allowedRoots. Source root permissions are not imported. The runtime gets a new epoch; approvals expire, queued input waits and native ownership is uncertain. Inspect uncertain receipts without replaying input.

The recovered runtime rebuilds the Claude history index from the transcripts on its first Claude history read, as a fresh state root does. With many transcripts, that indexing can outlast one read's 30-second budget; such a read reports the history unavailable and later reads continue it. A Claude session is listed again only once its transcript is back in Claude's own folder.

Recover repositories and native files separately. Source paths are retained as evidence; never blindly replace repository files. Reconcile native ownership before enabling execution. The snapshot does not promise path translation or restore authentication.

## Rollback

Roll back by restoring an earlier snapshot into a new recovery workspace; never overwrite the current state root. A snapshot from another schema is refused with an error naming the package version that wrote it, so restore it with that version. Rollback accepts losing every change made after that snapshot, including host changes and later runtime receipts. Reconcile native ownership before enabling work.

## Package downgrade

Version 13.0.0 uses the same storage schema as 12.0.1, including the existing action key and host `user_version`; startup accepts that schema without migration or reset. The writing package version is diagnostic. Snapshot capture and restore retain longer managed names under the same schema.

The expanded name contract is still a breaking change for older consumers: 12.x strict schemas reject managed names longer than 32 characters. Before installing 12.x, pause new session creation and naming actions, inventory every managed session using bounded `managed-threads` pages for each workspace, and use 13.x supported `thread-rename` actions to shorten each longer name. Resolve occupied or pending-name conflicts and verify the complete inventory contains no name longer than 32 before switching runtime and consumers together. Renaming retains the managed and native identities. Do not edit the database or stamp, reset storage, or replay session creation to make a downgrade work. Keep the existing database and `action.key` together.

## Codex connection recovery

A shared Codex daemon restart can interrupt every managed Codex session's live connection while HQ stays running. The runtime rechecks only its previously controlled sessions with no action in flight and rejoins matching native turns without changing settings or repeating input. Confirmed completions advance their waiting queues; unacknowledged actions and changed turns remain uncertain. Native command handles may have been lost, so rejoining establishes session control rather than successful command execution. See [runtime lifecycle](../api/README.md#runtime-lifecycle).

## Off-machine durability

The development helper examples/shared-storage.ts demonstrates a host-owned application table, maintenance, capture and offline restore using public exports. Capture already returns verified metadata, so the helper avoids an immediate extra full-database inspection. Its application transaction commits independently of capture. Inspect the restored values before starting a recovered runtime with explicitly chosen roots.

For off-machine copies, `packHqSnapshot` encrypts a snapshot into one AES-256-GCM archive with a 32-byte key the host supplies, and `unpackHqSnapshot` verifies the archive before writing a fresh snapshot directory to restore from. The archive carries action.key with the database. A lost key makes every archive packed with it unrecoverable, so keep the key outside the backups it protects. The host owns the key, scheduling, uploads, retention and the last successful backup status. Losing the disk can lose all changes after the last successful off-machine backup. Producing a local snapshot alone does not protect against disk failure.
