# Error contracts

Application failures use `Exception` from `jg-exception` and explicit string codes. The extracted cause may follow the stable message as a diagnostic suffix.

## Runtime and transport

These contracts use the named codes below. An Exception's `data.kind` classifies its safe wire mapping. Native codes, when present in diagnostic metadata, belong to the native protocol and are not jg-agent-hq error codes. Claude control error responses carry `nativeRejection: true` internally because that protocol supplies no numeric error code. Internal diagnostic causes are never copied into IPC error responses.

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

State safety rejects non-private ownership, symlinks and non-regular files, and STATE_DIRECTORY_UNSAFE covers a state root that can't be created as a private directory. ACTION_KEY_UNAVAILABLE also rejects a valid-length key whose fingerprint differs from the database stamp, before opening a writer. Startup uses RUNTIME_ALREADY_OWNED while another holder keeps the state root's `runtime` lock, and takes a dead holder's lock over only after the host's `isPreviousRuntimeStopped` check proves its runtime stopped. Other failures of jg-locks' locks folder pass through unchanged from `createAgentHq`: jg-fs' LOCK_BUSY (The lock '<path>' is busy.) for a snapshot lock still being recovered, LOCK_ACQUISITION_FAILED (The lock '<path>' could not be acquired.), NOT_A_DIRECTORY (The path '<path>' is not a directory.), DIRECTORY_NOT_PRIVATE (The directory '<path>' can be accessed by other users.) and PATH_NOT_CANONICAL (The path '<path>' goes through a symbolic link.), and, when the stopped runtime's snapshot lock is released, LOCK_NOT_OWNED (The lock '<path>' is no longer owned by this process.) and LOCK_RELEASE_FAILED (The lock '<path>' could not be released.). Closing the runtime reports a failed release of its lock as RUNTIME_OWNER_UNVERIFIABLE. Transport failure includes malformed, oversized or incomplete frames and bounded-request/lifecycle failures. Native history and subscription failures remain unavailable, never successful empty results: `threads` names each folder and provider it couldn't read in `unavailable`, and `thread` answers with `historyState: 'unavailable'` from the runtime's records only for a session the runtime knows in that folder. Claude control rejects missing or non-idle initialization, invalid native session identities and malformed lifecycle evidence. Failed delivery remains uncertain when no exact native rejection or acknowledgement establishes its outcome.

A nonempty SQLite schema requires exactly one matching `agent_hq_schema` stamp. Missing, malformed or mismatched stamps use STORAGE_INVALID with the safe state-conflict classification before the runtime changes the database. Its message names the package version that wrote storage from another schema, or another jg-agent-hq version when the stamp records none; the CLI presents only that writer message. Read-only validation preserves uncheckpointed WAL state on rejection. Initialization failures roll back the runtime's complete schema. Storage maintenance uses ACTION_CONFLICT for concurrent maintenance, calls from admitted work or active native execution. Host callback errors propagate unchanged after admission is released.

Snapshot capture continues through native work, but uses ACTION_CONFLICT for concurrent maintenance and when a live holder keeps the state root's `snapshot` lock through the 120-second wait. Restore, packing and unpacking use STORAGE_INVALID for a snapshot from another schema. SNAPSHOT_INVALID classifies invalid selections or incomplete, corrupt, unsafe or occupied snapshot, archive or recovery paths as invalid-request, including an archive key that is not 32 bytes and an archive that fails authentication or lists entries its manifest does not. SNAPSHOT_FAILED classifies operational backup, copy, worker, lock and cleanup failures as operation-failed, including a `snapshot` lock whose holder is gone, which its message reports as jg-fs' busy lock. Its stable message may carry a private extracted diagnostic suffix. These contracts belong only to trusted Node snapshot exports.

A native or worker startup failure whose cleanup could not be confirmed carries internal `cleanupUnconfirmed: true`. The runtime keeps its `runtime` lock in that case rather than allowing a new host to assume its resources have stopped.

A Claude connection failure marks control uncertain before native cleanup completes. Only proof of exact owned process-group shutdown and controller release can settle its matching conversation to inactive. An unconfirmed cleanup retains uncertainty and its controller without disabling other Claude controls; it still prevents runtime owner release. Settlement never changes uncertain input into a rejection or acknowledgement.

A provider failure that is not one of the adapters' own exceptions uses PROVIDER_FAILED with the agent-unavailable classification; canonical request/access/state and capability errors retain their meaning. Action admission records only a coded failure of a known kind, such as a conflicting ownership check, as a failed action; any other error during admission, such as a SQLite failure, rolls the admission back without recording the action and propagates as STORE_FAILED, its message carrying the cause. CAPABILITY_UNAVAILABLE denotes an operation that cannot be invoked, not uncertain native consumption. Capability and quota observations can instead report unavailable data. Version labels are diagnostic and do not gate admission. A control response the adapter cannot parse or a lifecycle backlog overflow quarantines the affected provider. The other provider remains usable; an unconfirmed cleanup still prevents runtime owner release.

Conflicting confirmed native lineage uses PROVIDER_FAILED. Native model/configuration parsing failures use their provider contract without disabling unrelated controls. Invalid or changed model/configuration catalog continuation uses CURSOR_INVALID, as does any cursor that is malformed, tampered with, longer than 16,384 characters or issued for another request. Unsupported startup settings and Codex startup overrides on an already loaded thread use CAPABILITY_UNAVAILABLE; no ignored change is acknowledged.

`threads` uses REQUEST_INVALID for two folders that resolve to one, CURSOR_INVALID for a cursor from other folders, providers, search or continued filter, or one tampered with or malformed, and PROVIDER_FAILED when native continuations too long for one cursor would continue the list.

Session evidence reuses TARGET_FORBIDDEN for workspace denials and CURSOR_INVALID for mismatched queries, changed partial-page content or changed Claude chain revisions. An item whose identities cannot fit the evidence budget uses PROVIDER_FAILED rather than returning a non-progressing page. Missing or unverifiable native history retains its provider's unavailable contract; no raw-file retry bypasses authorization.

An `action-wait` reuses TARGET_FORBIDDEN as `receipt` does, and RUNTIME_NOT_RUNNING for a wait still running when the runtime starts closing, as do `session-states` and `live-items` long-polls, which use ACTION_CONFLICT for one beyond the 32 that may wait at once. The `locks` read passes jg-locks' `LOCK_ROOT_INVALID` (The locks folder must be an absolute path.) through unchanged when `JG_LOCKS_ROOT` isn't an absolute path; it carries no safe classification, so IPC and browser boundaries report it as `operation-failed`.

`thread-delete` reuses TARGET_FORBIDDEN for a folder outside the allowed workspaces, or a Codex session the runtime doesn't manage that ran in another folder, and REQUEST_INVALID, before recording anything, for a session a process may run or the runtime recorded in another folder, and a Claude session ID that isn't a UUID. A deletion whose delete step fails uses PROVIDER_FAILED, its message carrying the cause, after recording the action failed; a failure while it closes a session the runtime runs keeps that step's own contract. A Codex session the daemon answers with `no rollout found` counts as deleted.

`openHostDatabase` uses STORE_FAILED when the database can't be opened. A host statement that writes or defines an object under the reserved prefix fails with SQLite's own `not authorized` error, not a jg-agent-hq code.

Input-file admission reuses REQUEST_INVALID for invalid media, malformed UTF-8 and byte/count limits, and TARGET_FORBIDDEN for root or symlink escapes. A changed or missing content-bound file uses ACTION_CONFLICT before native submission; no input is replayed. Unsupported provider media or live output-schema changes use CAPABILITY_UNAVAILABLE. Schema mismatch, missing final output and result overflow are explicit receipt-result classifications rather than new exception codes. Native rejection and transport uncertainty retain the existing provider/action contracts.

Steer files use the same admission, content-binding and pre-send checks. Types outside the provider's `inputSchema.steerMediaTypes`, including Claude PDFs, use CAPABILITY_UNAVAILABLE before any native write, rejecting the complete input. An invalid internal Claude `<action UUID>:steer` request identity uses ACTION_CONFLICT before writing. A recognized malformed visible Claude queued prompt, including an unverifiable graph/source UUID or original first text block, uses CLAUDE_HISTORY_UNAVAILABLE; unsupported non-prompt attachment kinds remain hidden.

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

Browser host admission reuses the existing invalid-request, action-state conflict and store-failure contracts. Nonce payload/operator changes, stale new epochs, admission capacity and admission after close conflict. A dispatcher error propagates within the trusted host after marking its receipt uncertain; HTTP hosts must map it to the existing eight safe public messages. Startup quarantines submitted host receipts without invoking their handlers.

Native skill dispatch reuses SKILL_UNAVAILABLE when the exact catalog selection is missing, disabled, ambiguous or unreadable, and sends no replacement text.
