# Snapshot recovery

HQ supplies local capture, inspection and offline restore primitives. The Node signatures and inventory contract live in [the API reference](../api/README.md#snapshot-and-restore).

## Capture

Capture runs while agents keep working. HQ-mediated plan writes wait for its coordination metadata lock, and each registered plan is copied under its own document locks. Keep the host's own connections from writing host tables until capture resolves. Capture includes committed WAL data, application tables, stored reports, action.key and registered plan companions. Prepared document writes and source mismatches stay as evidence. A plan edited outside HQ during capture is still copied consistently; when its copied revision differs from one its thread bindings recorded, the snapshot marks it plan-changed.

A successful snapshot has exact file hashes and a final completion marker. The header records the package version that captured it, and the database stamp binds its schema, action-key fingerprint and writing package version; inspection and runtime startup reject a mismatched key or another schema. Keep it private. It excludes repositories, native transcripts/authentication, external references and transient runtime credentials. Missing source plans and registered references outside the current allowed roots remain explicit diagnostics, without widening access. Inspection establishes complete local file/database evidence; hashes provide integrity rather than sender authentication.

## Restore

Stop all connections to the proposed destination and choose a new recovery workspace. Restore validates source and staged copies and refuses every existing target. It creates separate state and plan recovery directories, a streamed recovery.jsonl inventory and recovered.json completion record. Never use output left incomplete by a crash. Caught failures clean only the output that operation created.

Start HQ with the returned stateRoot and explicit allowedRoots. Source root permissions are not imported. The runtime gets a new epoch; automation stays paused, dispatch is disabled, skill grants are revoked, approvals expire and native ownership is uncertain. Thread bindings of plans marked plan-changed lose their execution scope. Read stored reports without native histories. Inspect wait sets, continuation reservations and uncertain receipts without replaying input.

Recover repositories and native files separately. Source paths and plan bindings are retained as evidence. Compare the selected plan companions against current files before copying them into an explicitly chosen location; never blindly replace repository files. Rebind plan references and obtain fresh authority where needed. Reconcile a pending document intent only using its original ID and unchanged/desired byte guards. Reconcile native ownership and make current-revision host lifecycle decisions before enabling execution. The snapshot does not promise path translation or restore authentication.

## Rollback

Roll back by restoring an earlier snapshot into a new recovery workspace; never overwrite the current state root. A snapshot from another schema is refused with an error naming the package version that wrote it, so restore it with that version. Rollback accepts losing every change made after that snapshot, including host changes and later HQ receipts. Reconcile native ownership and obtain fresh authority before enabling work.

## Off-machine durability

The development helper examples/shared-storage.ts demonstrates a host-owned application table, maintenance, capture and offline restore using public exports. Capture already returns verified metadata, so the helper avoids an immediate extra full-database inspection. Its application transaction commits independently of capture. Inspect the restored values before starting a recovered runtime with explicitly chosen roots.

For off-machine copies, `packHqSnapshot` encrypts a snapshot into one AES-256-GCM archive with a 32-byte key the host supplies, and `unpackHqSnapshot` verifies the archive before writing a fresh snapshot directory to restore from. The archive carries action.key with the database. A lost key makes every archive packed with it unrecoverable, so keep the key outside the backups it protects. The host owns the key, scheduling, uploads, retention and the last successful backup status. Losing the disk can lose all changes after the last successful off-machine backup. Producing a local snapshot alone does not protect against disk failure.
