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
| JG_AGENT_HQ_PROVIDER_FAILED            | The HQ provider integration failed              |
| JG_AGENT_HQ_CAPABILITY_UNAVAILABLE     | The HQ capability is unavailable                |
| JG_AGENT_HQ_RUNTIME_NOT_RUNNING        | The HQ runtime is not running                   |
| JG_AGENT_HQ_ACTION_CONFLICT            | The HQ action conflicts with its recorded state |
| JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE     | The HQ action key is unavailable                |
| JG_AGENT_HQ_SKILL_UNAVAILABLE          | The HQ skill is unavailable                     |
| JG_AGENT_HQ_PLAN_INVALID               | The HQ plan is invalid                          |
| JG_AGENT_HQ_PLAN_FAILED                | The HQ plan operation failed                    |
| JG_AGENT_HQ_HANDOFF_UNAVAILABLE        | The HQ handoff is unavailable                   |
| JG_AGENT_HQ_HANDOFF_FAILED             | The HQ handoff operation failed                 |

State safety rejects non-private ownership, symlinks and non-regular files. Runtime ownership is never reclaimed automatically. Transport failure includes malformed, oversized or incomplete frames and bounded-request/lifecycle failures. Native history and subscription failures remain unavailable, never successful empty results. Claude control rejects missing or non-idle initialization, invalid native session identities and malformed lifecycle evidence. Failed delivery remains uncertain when no exact native rejection or acknowledgement establishes its outcome.

A nonempty SQLite schema requires exactly one matching `hq_schema` stamp. Missing, malformed or mismatched stamps use STORAGE_INVALID with the safe state-conflict classification before HQ changes the database. Read-only validation preserves uncheckpointed WAL state on rejection. Initialization failures roll back the complete HQ schema. Storage maintenance uses ACTION_CONFLICT for concurrent maintenance, calls from admitted work, active native execution or an unresolved plan write. Host callback errors propagate unchanged after admission is released.

A native or worker startup failure whose cleanup could not be confirmed carries internal `cleanupUnconfirmed: true`. The runtime retains its owner record in that case rather than allowing a new host to assume its resources have stopped.

Third-party provider failures use PROVIDER_FAILED with the agent-unavailable classification; canonical request/access/state and capability errors retain their meaning. CAPABILITY_UNAVAILABLE denotes an operation that cannot be invoked, not uncertain native consumption. Capability and quota observations can instead report unavailable data. Version labels are diagnostic and do not gate admission. Malformed control identity/state or a lifecycle backlog overflow quarantines the affected provider. Other providers remain usable; an unconfirmed cleanup still prevents runtime owner release.

Conflicting confirmed native lineage uses PROVIDER_FAILED. Native model/configuration parsing failures use their provider contract without disabling unrelated controls. Invalid or changed model/configuration catalog continuation uses CURSOR_INVALID. Unsupported startup settings and Codex startup overrides on an already loaded thread use CAPABILITY_UNAVAILABLE; no ignored change is acknowledged. Native archive, compaction and revert retain the existing action conflict and uncertain-delivery contracts.

Input-file admission reuses REQUEST_INVALID for invalid media, malformed UTF-8 and byte/count limits, and TARGET_FORBIDDEN for root or symlink escapes. A changed or missing content-bound file uses ACTION_CONFLICT before native submission; no input is replayed. Unsupported provider media or live output-schema changes use CAPABILITY_UNAVAILABLE. Schema mismatch, missing final output and result overflow are explicit receipt-result classifications rather than new exception codes. Native rejection and transport uncertainty retain the existing provider/action contracts.

Plan validation rejects unsupported framing, duplicate or misplaced milestone IDs, invalid frontmatter boundaries, non-regular artifacts and oversized inputs. Plan operation failures retain safe operation diagnostics inside the trusted host. Document-lock contention uses ACTION_CONFLICT with reason document-locked. Document lock failures use PLAN_FAILED with the observed phase and a truthful not-applied or uncertain outcome. An applied write whose lock release fails keeps its prepared journal payload. A failed ledger acknowledgement is reconciled from durable state; an unavailable observation uses STORE_FAILED and keeps admission closed. Stale revisions, presentation hashes, replay payload conflicts, revoked authority and unresolved writes use the existing action-state conflict contract. Unresolved correspondence, unverified done evidence, live scope changes, stale runtime authority and unproven quiescence also use the action-state conflict contract. Failed native cleanup retains the checkpoint and closes the editing gate. Neither validation nor write recovery can grant native permissions. Whole-plan selection conflicts with a real breakdown, duplicate live implementation ownership, completed contracts and revoked implementation follow-up authority use the same action-state conflict contract. A valid sequence approval request for a plan without a sequence also conflicts.

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

Handoff lookup uses the unavailable contract for an unknown identity. Git attribution failures use the handoff operation contract with private diagnostic causes. Stale previews, changed source contracts, wrong native targets, mismatched replay identities and invalid or overwritten finding references use the existing action-state conflict contract. Delivery outcomes come from the action ledger and do not imply feedback acceptance.

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
