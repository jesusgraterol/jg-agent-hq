# Error contracts

Application failures use `Exception` from `jg-exception` and explicit string codes. Diagnostic owner details or the extracted cause may follow the stable message. Arbitrary operation failures in `withHqLock` propagate unchanged.

| Code                                      | Stable message                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| JG_AGENT_HQ_LOCK_INVALID_ARGUMENTS        | The HQ lock acquisition arguments are invalid                                                        |
| JG_AGENT_HQ_LOCK_UNSUPPORTED_PLATFORM     | The HQ lock requires Linux or macOS                                                                  |
| JG_AGENT_HQ_RUNTIME_DIRECTORY_INVALID     | The HQ runtime directory must be a real directory                                                    |
| JG_AGENT_HQ_RUNTIME_DIRECTORY_PERMISSIONS | The HQ runtime directory must be private and owned by the current user                               |
| JG_AGENT_HQ_LOCK_FILE_INVALID             | The HQ lock must be a regular file                                                                   |
| JG_AGENT_HQ_LOCK_FILE_PERMISSIONS         | The HQ lock must be private and owned by the current user                                            |
| JG_AGENT_HQ_LOCK_OWNER_OVERSIZED          | The HQ lock owner exceeds the supported size                                                         |
| JG_AGENT_HQ_LOCK_OWNER_UNREADABLE         | The HQ lock owner could not be read. Inspect .runtime/hq.lock                                        |
| JG_AGENT_HQ_LOCK_OWNER_INCOMPLETE         | The HQ lock owner is incomplete. Inspect .runtime/hq.lock and remove it only after its owner stopped |
| JG_AGENT_HQ_LOCK_OWNER_INACTIVE           | The HQ lock has an inactive owner                                                                    |
| JG_AGENT_HQ_LOCK_OWNER_UNVERIFIABLE       | The HQ lock owner could not be verified                                                              |
| JG_AGENT_HQ_LOCK_TIMEOUT                  | Timed out waiting for the HQ lock                                                                    |
| JG_AGENT_HQ_LOCK_OWNERSHIP_CHANGED        | HQ lock ownership changed before release                                                             |
| JG_AGENT_HQ_LOCK_NOT_HELD                 | The HQ lock is not held                                                                              |
| JG_AGENT_HQ_LOCK_NONCE_MISMATCH           | The HQ lock nonce does not match                                                                     |

Recovery never automatically deletes an inactive, unreadable, incomplete or unverifiable lock. Operator recovery checks the inspected nonce after the operator has established that the owner and its children stopped.

## Runtime and transport

These contracts use the named codes below. An Exception's `data.kind` classifies its safe wire mapping. Native codes, when present in diagnostic metadata, belong to the native protocol and are not HQ error codes. Claude control error responses carry `nativeRejection: true` internally because that protocol supplies no numeric error code. Internal diagnostic causes are never copied into IPC error responses.

| Code                                   | Stable message                                  |
| -------------------------------------- | ----------------------------------------------- |
| JG_AGENT_HQ_STATE_DIRECTORY_UNSAFE     | The HQ state directory is unsafe                |
| JG_AGENT_HQ_STATE_FILE_UNSAFE          | The HQ state file is unsafe                     |
| JG_AGENT_HQ_RUNTIME_ALREADY_OWNED      | The HQ runtime is already owned                 |
| JG_AGENT_HQ_RUNTIME_OWNER_UNVERIFIABLE | The HQ runtime owner is unverifiable            |
| JG_AGENT_HQ_REQUEST_INVALID            | The HQ request is invalid                       |
| JG_AGENT_HQ_TARGET_FORBIDDEN           | The HQ target is outside the allowed workspaces |
| JG_AGENT_HQ_CURSOR_INVALID             | The HQ cursor does not match this request       |
| JG_AGENT_HQ_CODEX_FAILED               | The Codex integration failed                    |
| JG_AGENT_HQ_CLAUDE_FAILED              | The Claude integration failed                   |
| JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE | The Claude history is unavailable               |
| JG_AGENT_HQ_TRANSPORT_FAILED           | The HQ transport failed                         |
| JG_AGENT_HQ_STORE_FAILED               | The HQ store failed                             |
| JG_AGENT_HQ_STORAGE_INVALID            | The HQ storage is invalid                       |
| JG_AGENT_HQ_SNAPSHOT_INVALID           | The HQ snapshot is invalid                      |
| JG_AGENT_HQ_SNAPSHOT_FAILED            | The HQ snapshot operation failed                |
| JG_AGENT_HQ_PROVIDER_FAILED            | The HQ provider integration failed              |
| JG_AGENT_HQ_CAPABILITY_UNAVAILABLE     | The HQ capability is unavailable                |
| JG_AGENT_HQ_RUNTIME_NOT_RUNNING        | The HQ runtime is not running                   |
| JG_AGENT_HQ_ACTION_CONFLICT            | The HQ action conflicts with its recorded state |
| JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE     | The HQ action key is unavailable                |
| JG_AGENT_HQ_SKILL_UNAVAILABLE          | The HQ skill is unavailable                     |
| JG_AGENT_HQ_IMAGE_UNAVAILABLE          | The HQ image is unavailable                     |

State safety rejects non-private ownership, symlinks and non-regular files. ACTION_KEY_UNAVAILABLE also rejects a valid-length key whose fingerprint differs from the database stamp, before opening a writer. Runtime ownership is never reclaimed automatically. Transport failure includes malformed, oversized or incomplete frames and bounded-request/lifecycle failures. Native history and subscription failures remain unavailable, never successful empty results. Claude control rejects missing or non-idle initialization, invalid native session identities and malformed lifecycle evidence. Failed delivery remains uncertain when no exact native rejection or acknowledgement establishes its outcome.

A nonempty SQLite schema requires exactly one matching `hq_schema` stamp. Missing, malformed or mismatched stamps use STORAGE_INVALID with the safe state-conflict classification before HQ changes the database. Its message names the package version that wrote storage from another schema, or another jg-agent-hq version when the stamp records none; the CLI presents only that writer message. Read-only validation preserves uncheckpointed WAL state on rejection. Initialization failures roll back the complete HQ schema. Storage maintenance uses ACTION_CONFLICT for concurrent maintenance, calls from admitted work or active native execution. Host callback errors propagate unchanged after admission is released.

Snapshot capture continues through native work, but uses ACTION_CONFLICT for concurrent maintenance and an expired wait for the HQ lock in the state root. Inspection and restore use STORAGE_INVALID for a snapshot from another schema. SNAPSHOT_INVALID classifies invalid selections or incomplete, corrupt, unsafe or occupied snapshot, archive or recovery paths as invalid-request, including an archive key that is not 32 bytes and an archive that fails authentication or lists entries its manifest does not. SNAPSHOT_FAILED classifies operational backup, copy, worker, lock and cleanup failures as operation-failed, including a lock held by a dead owner. Its stable message may carry a private extracted diagnostic suffix. These contracts belong only to trusted Node snapshot exports.

A native or worker startup failure whose cleanup could not be confirmed carries internal `cleanupUnconfirmed: true`. The runtime retains its owner record in that case rather than allowing a new host to assume its resources have stopped.

Third-party provider failures use PROVIDER_FAILED with the agent-unavailable classification; canonical request/access/state and capability errors retain their meaning. CAPABILITY_UNAVAILABLE denotes an operation that cannot be invoked, not uncertain native consumption. Capability and quota observations can instead report unavailable data. Version labels are diagnostic and do not gate admission. Malformed control identity/state or a lifecycle backlog overflow quarantines the affected provider. Other providers remain usable; an unconfirmed cleanup still prevents runtime owner release.

Conflicting confirmed native lineage uses PROVIDER_FAILED. Native model/configuration parsing failures use their provider contract without disabling unrelated controls. Invalid or changed model/configuration catalog continuation uses CURSOR_INVALID. Unsupported startup settings and Codex startup overrides on an already loaded thread use CAPABILITY_UNAVAILABLE; no ignored change is acknowledged. Native archive, compaction and revert retain the existing action conflict and uncertain-delivery contracts.

Account and extension controls reuse ACTION_CONFLICT for live sessions, permission waits, stale login identities and provider-wide changes in progress. Unsupported native controls use CAPABILITY_UNAVAILABLE before dispatch. Invalid or changed MCP continuation uses CURSOR_INVALID. Optional account/catalog observations can be unavailable without disabling unrelated control. Native authentication/reload rejection and uncertain delivery retain their provider/action contracts; sensitive URLs and provider diagnostics are not copied into public errors.

Session discovery and evidence reuse TARGET_FORBIDDEN for workspace denials and CURSOR_INVALID for mismatched queries, changed partial-page content or changed Claude chain revisions. An item whose identities cannot fit the evidence budget uses PROVIDER_FAILED rather than returning a non-progressing page. Missing or unverifiable native history retains its provider's unavailable contract; no raw-file retry bypasses authorization.

An `action-wait` reuses TARGET_FORBIDDEN as `receipt` does, and RUNTIME_NOT_RUNNING for a wait still running when the runtime starts closing. The `locks` read passes jg-locks' `LOCK_ROOT_INVALID` (The locks folder must be an absolute path.) through unchanged when `JG_LOCKS_ROOT` isn't an absolute path; it carries no safe classification, so IPC and browser boundaries report it as `operation-failed`.

Input-file admission reuses REQUEST_INVALID for invalid media, malformed UTF-8 and byte/count limits, and TARGET_FORBIDDEN for root or symlink escapes. A changed or missing content-bound file uses ACTION_CONFLICT before native submission; no input is replayed. Unsupported provider media or live output-schema changes use CAPABILITY_UNAVAILABLE. Schema mismatch, missing final output and result overflow are explicit receipt-result classifications rather than new exception codes. Native rejection and transport uncertainty retain the existing provider/action contracts.

Native form replies reuse REQUEST_INVALID for content outside the exact requested schema or response kind. Stale, expired, cross-thread or already answered request identities use ACTION_CONFLICT. Native writes without matching consumption evidence remain submitted or uncertain; expiry never proves a response was rejected. Unsupported native request variants are denied on their own native channel without granting permission.

## Public error messages

The local client translates a remote failure into an Exception with the named client code below and its safe `data.kind`. The CLI uses the same kind/message mapping in JSON. Diagnostic causes are retained only inside the trusted host.

| Kind                      | Code                                       | Stable message                            |
| ------------------------- | ------------------------------------------ | ----------------------------------------- |
| `invalid-request`         | JG_AGENT_HQ_CLIENT_INVALID_REQUEST         | Request is invalid.                       |
| `authentication-required` | JG_AGENT_HQ_CLIENT_AUTHENTICATION_REQUIRED | Sign in to continue.                      |
| `access-denied`           | JG_AGENT_HQ_CLIENT_ACCESS_DENIED           | Access is denied.                         |
| `not-found`               | JG_AGENT_HQ_CLIENT_NOT_FOUND               | Requested resource was not found.         |
| `state-conflict`          | JG_AGENT_HQ_CLIENT_STATE_CONFLICT          | State changed. Refresh before continuing. |
| `agent-unavailable`       | JG_AGENT_HQ_CLIENT_AGENT_UNAVAILABLE       | Coding agent is unavailable.              |
| `operation-failed`        | JG_AGENT_HQ_CLIENT_OPERATION_FAILED        | Operation could not be completed.         |
| `image-unavailable`       | JG_AGENT_HQ_CLIENT_IMAGE_UNAVAILABLE       | Image is unavailable.                     |

## Website tooling

| Code                                   | Stable message                               |
| -------------------------------------- | -------------------------------------------- |
| JG_AGENT_HQ_WEBSITE_SOURCE_INVALID     | The HQ website source is invalid             |
| JG_AGENT_HQ_WEBSITE_BUILD_INVALID      | The HQ website build is invalid              |
| JG_AGENT_HQ_WEBSITE_ASSETS_FAILED      | The HQ website assets could not be generated |
| JG_AGENT_HQ_WEBSITE_DESTINATION_FAILED | The HQ website destination check failed      |

These build-time failures retain operation diagnostics and their original causes locally.

## Release tooling

| Code                             | Stable message                      |
| -------------------------------- | ----------------------------------- |
| JG_AGENT_HQ_RELEASE_CHECK_FAILED | The HQ package release check failed |

Release checks reject invalid registry metadata, oversized responses, changed contents under an existing version and versions that do not exceed the latest release. Diagnostic suffixes explain the required correction. Failed registry reads never authorize a publish.

Browser host admission reuses the existing invalid-request, action-state conflict and store-failure contracts. Nonce payload/operator changes, stale new epochs, admission capacity and admission after close conflict. A dispatcher error propagates within the trusted host after marking its receipt uncertain; HTTP hosts must map it to the existing seven safe public messages. Startup quarantines submitted host receipts without invoking their handlers.

Native skill dispatch reuses SKILL_UNAVAILABLE when the exact catalog selection is missing, disabled, ambiguous or unreadable, and sends no replacement text.
