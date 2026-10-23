# Snapshot recovery

HQ supplies local capture, inspection and offline restore primitives. The Node signatures and inventory contract live in [the API reference](../api/README.md#snapshot-and-restore).

## Capture

Pause every application writer, independent document editor and native background job that can change captured files. Request capture at a quiescent checkpoint; a busy result leaves native work running and requires a later host retry. Capture includes committed WAL data, application tables, stored reports, action.key and registered plan companions under shared locks. Prepared document writes and source mismatches stay as evidence.

A successful snapshot has exact file hashes and a final completion marker. The database stamp binds its action-key fingerprint; inspection and runtime startup reject a mismatched key. Keep it private. It excludes repositories, native transcripts/authentication, external references and transient runtime credentials. Missing source plans and registered references outside the current allowed roots remain explicit diagnostics, without widening access. Inspection establishes complete local file/database evidence; hashes provide integrity rather than sender authentication.

## Restore

Stop all connections to the proposed destination and choose a new recovery workspace. Restore validates source and staged copies and refuses every existing target. It creates separate state and plan recovery directories, a streamed recovery.jsonl inventory and recovered.json completion record. Never use output left incomplete by a crash. Caught failures clean only the output that operation created.

Start HQ with the returned stateRoot and explicit allowedRoots. Source root permissions are not imported. The runtime gets a new epoch; automation stays paused, dispatch is disabled, skill grants are revoked, approvals expire and native ownership is uncertain. Read stored reports without native histories. Inspect wait sets, continuation reservations and uncertain receipts without replaying input.

Recover repositories and native files separately. Source paths and plan bindings are retained as evidence. Compare the selected plan companions against current files before copying them into an explicitly chosen location; never blindly replace repository files. Rebind plan references and obtain fresh authority where needed. Reconcile a pending document intent only using its original ID and unchanged/desired byte guards. Reconcile native ownership and make current-revision host lifecycle decisions before enabling execution. The snapshot does not promise path translation or restore authentication.

## Off-machine durability

The host application owns encryption and key recovery, scheduling, uploads, retention and the last successful backup status. Plaintext action.key must accompany the database inside the protected backup. Losing the disk can lose all changes after the last successful off-machine backup. Producing a local snapshot alone does not protect against disk failure.
