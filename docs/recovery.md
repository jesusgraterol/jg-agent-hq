# Snapshot recovery

HQ supplies local capture, inspection and offline restore primitives. The Node signatures and inventory contract live in [the API reference](../api/README.md#snapshot-and-restore).

## Capture

Capture runs while agents keep working, under the HQ lock in the state root. Keep the host's own connections from writing host tables until capture resolves. Capture includes committed WAL data, application tables and action.key.

A successful snapshot has exact file hashes and a final completion marker. The header records the package version that captured it, and the database stamp binds its schema, action-key fingerprint and writing package version; inspection and runtime startup reject a mismatched key or another schema. Keep it private. It excludes repositories and other workspace files, native transcripts/authentication, external references and transient runtime credentials. Inspection establishes complete local file/database evidence; hashes provide integrity rather than sender authentication.

## Restore

Stop all connections to the proposed destination and choose a new recovery workspace. Restore validates source and staged copies and refuses every existing target. It creates the recovered state directory, a recovery.jsonl copy of the source manifest and a recovered.json completion record. Never use output left incomplete by a crash. Caught failures clean only the output that operation created.

Start HQ with the returned stateRoot and explicit allowedRoots. Source root permissions are not imported. The runtime gets a new epoch; approvals expire, queued input waits and native ownership is uncertain. Inspect uncertain receipts without replaying input.

Recover repositories and native files separately. Source paths are retained as evidence; never blindly replace repository files. Reconcile native ownership before enabling execution. The snapshot does not promise path translation or restore authentication.

## Rollback

Roll back by restoring an earlier snapshot into a new recovery workspace; never overwrite the current state root. A snapshot from another schema is refused with an error naming the package version that wrote it, so restore it with that version. Rollback accepts losing every change made after that snapshot, including host changes and later HQ receipts. Reconcile native ownership before enabling work.

## Off-machine durability

The development helper examples/shared-storage.ts demonstrates a host-owned application table, maintenance, capture and offline restore using public exports. Capture already returns verified metadata, so the helper avoids an immediate extra full-database inspection. Its application transaction commits independently of capture. Inspect the restored values before starting a recovered runtime with explicitly chosen roots.

For off-machine copies, `packHqSnapshot` encrypts a snapshot into one AES-256-GCM archive with a 32-byte key the host supplies, and `unpackHqSnapshot` verifies the archive before writing a fresh snapshot directory to restore from. The archive carries action.key with the database. A lost key makes every archive packed with it unrecoverable, so keep the key outside the backups it protects. The host owns the key, scheduling, uploads, retention and the last successful backup status. Losing the disk can lose all changes after the last successful off-machine backup. Producing a local snapshot alone does not protect against disk failure.
