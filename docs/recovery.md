# Snapshot recovery

HQ supplies local capture, inspection and offline restore primitives. The Node signatures and inventory contract live in [the API reference](../api/README.md#snapshot-and-restore).

## Capture

Pause every application writer, independent document editor and native background job that can change captured files. Request capture at a quiescent checkpoint; a busy result leaves native work running and requires a later host retry. Capture includes committed WAL data, application tables, stored reports, action.key and registered plan companions under shared locks. Prepared document writes and source mismatches stay as evidence.

A successful snapshot has exact file hashes and a final completion marker. The database stamp binds its action-key fingerprint; inspection and runtime startup reject a mismatched key. Keep it private. It excludes repositories, native transcripts/authentication, external references and transient runtime credentials. Missing source plans and registered references outside the current allowed roots remain explicit diagnostics, without widening access. Inspection establishes complete local file/database evidence; hashes provide integrity rather than sender authentication.

## Restore

Stop all connections to the proposed destination and choose a new recovery workspace. Restore validates source and staged copies and refuses every existing target. It creates separate state and plan recovery directories, a streamed recovery.jsonl inventory and recovered.json completion record. Never use output left incomplete by a crash. Caught failures clean only the output that operation created.

Inspect the snapshot schema version. A restored published 2.0.0 database remains version 1; upgrade it explicitly while offline before starting current HQ. Start HQ with the returned stateRoot and explicit allowedRoots. Source root permissions are not imported. The runtime gets a new epoch; automation stays paused, dispatch is disabled, skill grants are revoked, approvals expire and native ownership is uncertain. Read stored reports without native histories. Inspect wait sets, continuation reservations and uncertain receipts without replaying input.

Recover repositories and native files separately. Source paths and plan bindings are retained as evidence. Compare the selected plan companions against current files before copying them into an explicitly chosen location; never blindly replace repository files. Rebind plan references and obtain fresh authority where needed. Reconcile a pending document intent only using its original ID and unchanged/desired byte guards. Reconcile native ownership and make current-revision host lifecycle decisions before enabling execution. The snapshot does not promise path translation or restore authentication.

## Upgrade and rollback

Stop HQ and its native children, close every independent application database writer and pause independent plan writers. Keep the existing database and 32-byte action.key together. Normal startup never upgrades them. Choose an absent backup destination beneath an existing private canonical parent:

```sh
jg-agent-hq upgrade-storage --state-root /path/to/state --backup-directory /private/backups/before-upgrade --workspace-root /path/to/workspace
```

Repeat --workspace-root for additional trusted roots; pass --coordination-root only when the installation uses a separate existing coordination directory. The Node upgradeHqStorage API performs the same operation. Both produce a fully verified format-1 backup before migration, preserving host tables, exact reports and registered plan companions. The operation does not start a runtime, resume automation or redeem any usage reset.

Retain a verified backup even after a later migration failure. Before commit, a confirmed rollback preserves logical state; WAL files need not remain byte-identical after opening a writer. An uncertain commit, lost result or cleanup error requires explicit reconciliation. Confirm workers and all independent writers have stopped, inspect the retained owner/backup evidence, then explicitly retry against the durable stamp. Current returns without another backup or reconciliation. Never blindly delete an owner or replay a migration. A current-version call leaves the supplied backup destination untouched.

Rollback uses the pre-upgrade snapshot restored into a new recovery workspace with compatible software. Do not overwrite the upgraded state root. Version 1 restores need the old compatible package or the explicit upgrade before current startup. Downgrade accepts losing every change made after that snapshot, including host changes and later HQ receipts. Reconcile native ownership and obtain fresh authority before enabling work. No down-migration or automatic reverse operation exists.

## Off-machine durability

The development helper examples/shared-storage.ts demonstrates a host-owned application table, maintenance, capture and offline restore using public exports. Capture already returns verified metadata, so the helper avoids an immediate extra full-database inspection. Its application transaction commits independently of capture. Inspect the restored values before starting a recovered runtime with explicitly chosen roots.

The host application owns encryption and key recovery, scheduling, uploads, retention and the last successful backup status. Plaintext action.key must accompany the database inside the protected backup. Losing the disk can lose all changes after the last successful off-machine backup. Producing a local snapshot alone does not protect against disk failure.
