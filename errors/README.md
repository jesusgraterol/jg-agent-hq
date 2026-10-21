# Error contracts

Application failures use `Exception` from `error-message-utils` and its default code `-1`. Diagnostic owner details or the extracted cause may follow the stable message. Arbitrary operation failures in `withHqLock` propagate unchanged.

| Code | Stable message                                                                                       |
| ---- | ---------------------------------------------------------------------------------------------------- |
| -1   | The HQ lock acquisition arguments are invalid                                                        |
| -1   | The HQ lock requires Linux or macOS                                                                  |
| -1   | The HQ runtime directory must be a real directory                                                    |
| -1   | The HQ runtime directory must be private and owned by the current user                               |
| -1   | The HQ lock must be a regular file                                                                   |
| -1   | The HQ lock must be private and owned by the current user                                            |
| -1   | The HQ lock owner exceeds the supported size                                                         |
| -1   | The HQ lock owner could not be read. Inspect .runtime/hq.lock                                        |
| -1   | The HQ lock owner is incomplete. Inspect .runtime/hq.lock and remove it only after its owner stopped |
| -1   | The HQ lock has an inactive owner                                                                    |
| -1   | The HQ lock owner could not be verified                                                              |
| -1   | Timed out waiting for the HQ lock                                                                    |
| -1   | HQ lock ownership changed before release                                                             |
| -1   | The HQ lock is not held                                                                              |
| -1   | The HQ lock nonce does not match                                                                     |

Recovery never automatically deletes an inactive, unreadable, incomplete or unverifiable lock. Operator recovery checks the inspected nonce after the operator has established that the owner and its children stopped.

## Runtime and transport

These contracts use the default code `-1`. An Exception's `data.kind` classifies its safe wire mapping. Native codes, when present in diagnostic metadata, belong to the native protocol and are not HQ error codes. Claude control error responses carry `nativeRejection: true` internally because that protocol supplies no numeric error code. Internal diagnostic causes are never copied into IPC error responses.

| Code | Stable message                                  |
| ---- | ----------------------------------------------- |
| -1   | The HQ state directory is unsafe                |
| -1   | The HQ state file is unsafe                     |
| -1   | The HQ runtime is already owned                 |
| -1   | The HQ runtime owner is unverifiable            |
| -1   | The HQ request is invalid                       |
| -1   | The HQ target is outside the allowed workspaces |
| -1   | The HQ cursor does not match this request       |
| -1   | The Codex integration failed                    |
| -1   | The Claude integration failed                   |
| -1   | The Claude history is unavailable               |
| -1   | The HQ transport failed                         |
| -1   | The HQ store failed                             |
| -1   | The HQ runtime is not running                   |
| -1   | The HQ action conflicts with its recorded state |
| -1   | The HQ action key is unavailable                |
| -1   | The HQ skill is unavailable                     |
| -1   | The HQ plan is invalid                          |
| -1   | The HQ plan operation failed                    |
| -1   | The HQ handoff is unavailable                   |
| -1   | The HQ handoff operation failed                 |

State safety rejects non-private ownership, symlinks and non-regular files. Runtime ownership is never reclaimed automatically. Transport failure includes malformed, oversized or incomplete frames and bounded-request/lifecycle failures. Native history and subscription failures remain unavailable, never successful empty results. Claude control rejects missing or non-idle initialization, invalid native session identities and malformed lifecycle evidence. Failed delivery remains uncertain when no exact native rejection or acknowledgement establishes its outcome.

A native or worker startup failure whose cleanup could not be confirmed carries internal `cleanupUnconfirmed: true`. The runtime retains its owner record in that case rather than allowing a new host to assume its resources have stopped.

Plan validation rejects unsupported framing, duplicate or misplaced milestone IDs, invalid frontmatter boundaries, non-regular artifacts and oversized inputs. Plan operation failures retain safe operation diagnostics inside the trusted host. Stale revisions, presentation hashes, replay payload conflicts, revoked authority and unresolved writes use the existing action-state conflict contract. Unresolved correspondence, unverified done evidence, live scope changes, stale runtime authority and unproven quiescence also use the action-state conflict contract. Failed native cleanup retains the checkpoint and closes the editing gate. Neither validation nor write recovery can grant native permissions. Whole-plan selection conflicts with a real breakdown, duplicate live implementation ownership, completed contracts and revoked implementation follow-up authority use the same action-state conflict contract. A valid sequence approval request for a plan without a sequence also conflicts.

## Public error messages

The local client translates a remote failure into an Exception with the default code `-1` and its safe `data.kind`. The CLI uses the same kind/message mapping in JSON. Diagnostic causes are retained only inside the trusted host.

| Kind                      | Stable message                            |
| ------------------------- | ----------------------------------------- |
| `invalid-request`         | Request is invalid.                       |
| `authentication-required` | Sign in to continue.                      |
| `access-denied`           | Access is denied.                         |
| `not-found`               | Requested resource was not found.         |
| `state-conflict`          | State changed. Refresh before continuing. |
| `agent-unavailable`       | Coding agent is unavailable.              |
| `operation-failed`        | Operation could not be completed.         |

Handoff lookup uses the unavailable contract for an unknown identity. Git attribution failures use the handoff operation contract with private diagnostic causes. Stale previews, changed source contracts, wrong native targets, mismatched replay identities and invalid or overwritten finding references use the existing action-state conflict contract. Delivery outcomes come from the action ledger and do not imply feedback acceptance.

## Website tooling

| Code | Stable message                               |
| ---- | -------------------------------------------- |
| -1   | The HQ website source is invalid             |
| -1   | The HQ website build is invalid              |
| -1   | The HQ website assets could not be generated |
| -1   | The HQ website destination check failed      |

These build-time failures retain operation diagnostics and their original causes locally.
