# Public API

Import the named exports from `jg-agent-hq`. Internal module paths are private.

## Lock lifecycle

- `acquireHqLock(root, command, options?)` acquires `.runtime/hq.lock` and returns an asynchronous release function. The caller owns the trusted state root and supplies a non-empty, single-line operation label. Surrounding whitespace is trimmed. The returned release function is idempotent and refuses a replaced owner.
- `withHqLock(root, command, operation, options?)` runs an asynchronous operation under the lock. It releases on success or failure; operation failures propagate unchanged. If cleanup also fails, the original operation error stays primary and cleanup failure is reported on stderr.
- `readHqLockState(root, now?)` reports free, held or unreadable without acquiring or reclaiming the lock. Held state includes the owner, liveness and age.
- `getOwnerLiveness(pid)` reports alive, dead or unknown. An unverifiable owner is not evidence that recovery is safe.
- `releaseHqLock(root, nonce)` is deliberate operator recovery. Confirm first that the inspected owner and its children have stopped. It checks the inspected nonce rather than liveness, because a reused PID must not prevent recovery.

`IHqLockOptions` retains the wait timeout, setup window and poll interval. Defaults are 120 seconds, 16 seconds and 200 milliseconds. Durations must be finite and non-negative; the poll interval must be positive. Invalid acquisition arguments fail before filesystem writes. An empty freshly created file is tolerated only within the setup window. Owner records are bounded to 16,384 UTF-8 bytes. The private directory and lock must belong to the current user and have no group/other access.

`IHqLockOwner`, `IOwnerLiveness`, `IHqLockOptions` and `IHqLockState` describe the contracts. `RUNTIME_DIRECTORY` and `HQ_LOCK_FILE` expose the established names.

All operations may expose the relevant intentional contracts in [errors](../errors/README.md). Filesystem failures outside those classifications propagate to the trusted Node caller. The returned acquisition release function can expose the ownership-changed contract.

## Runtime lifecycle

`createAgentHq({ stateRoot, allowedRoots })` starts one controller and returns `IAgentHq`: its canonical `stateRoot`, a `closed` lifetime promise, `request(command)` and idempotent `close()`. Paths must be absolute. Allowed roots must exist and are canonicalized at startup. A client-selected workspace must resolve inside an allowed root. State is a real directory owned by the current OS user with no group/other access. The controller creates it privately when absent.

The controller exclusively creates `hq-owner.json`. A live, inactive, incomplete or unverifiable existing owner prevents another controller from starting. There is no automatic takeover. Before deliberate recovery, establish that the inspected host, its worker and native process group have stopped. Runtime shutdown sends interruption requests across the bounded session cohort concurrently, then closes IPC connections, SQLite and owned native processes before removing the exact owner. Failed cleanup preserves ownership evidence. A new runtime receives a new epoch.

`requestAgentHq(stateRoot, command)` is a one-command IPC client. It verifies the private owner and socket, binds the command to the runtime epoch and checks the matching response. Closing a client does not close the host. `stop` accepts a shutdown request; the SDK caller must await `runtime.closed` when it owns the runtime. The CLI confirms owner removal before reporting `state: stopped`.

The socket accepts at most 32 simultaneous connections. Requests are bounded to 65,536 UTF-8 bytes; native and IPC response frames to 8,388,608 bytes. Structured transports reject malformed UTF-8/JSON, oversized frames and incomplete tails. Each native connection has at most 32 pending calls with a 30-second response deadline. IPC connections have a 35-second deadline. The SQLite worker bounds its queue to 128 commands, accommodating client reads, native lifecycle observations and action dispatch; collection operations remain limited to one page. Database work runs off the host event loop. The state directory is a same-user trust boundary, not a sandbox against other code running as that user.

## Read commands

Import `HqRequestSchema`, `HqResponseSchema` and their inferred types from `jg-agent-hq/contracts`. Requests are closed contracts. Responses tolerate additive fields. The current provider is `codex`.

| Command   | Required fields                         | Result                                                                                     |
| --------- | --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `status`  | None                                    | Runtime epoch, host PID, start time, worker availability and native transport availability |
| `stop`    | None                                    | Accepted shutdown and runtime epoch                                                        |
| `threads` | `provider`, `workspaceRoot`             | Paged native discovery; optional `search`                                                  |
| `thread`  | `provider`, `workspaceRoot`, `nativeId` | One native thread's metadata                                                               |
| `turns`   | Same target fields                      | Paged native turn metadata without hydrating items                                         |
| `items`   | Same target fields                      | Paged persisted native items; optional `turnId`                                            |
| `usage`   | `provider`                              | Actual subscription observations                                                           |

Paged commands accept `limit` (default 32, maximum 128) and an opaque `cursor`. Continue with exactly the same command, target, filters and limit. The cursor binds those fields to the native continuation. Ordering and cursor semantics belong to the native API; thread discovery requests descending creation order, turns descending order and items ascending order. No complete-history scan or client-side pagination occurs. Workspace authorization is rechecked for each request, independently of cursor validation, before selected-thread items are fetched.

Threads expose native state, ownership (`external`, `managed` or `uncertain`) and nullable `managedId`. A managed thread uses its HQ name; an external thread retains its nullable native name. Timestamps use Unix milliseconds. Discovery metadata, its observation time, runtime epoch and continuation are upserted into SQLite. This projection is not authoritative transcript history and never caches a conversation body. Repeated history reads go to Codex so a completed turn whose items have not flushed can be read again later. There is no resume-to-read behavior or Codex transcript-file parser.

## Thread control and live input

Send `{ kind: 'action', action: { id, runtimeEpoch, command } }`. Generate one UUID per user intent, take the epoch from `status`, and retain the complete envelope until its receipt can be read. The validated envelope is limited to 32,768 UTF-8 bytes. It is recorded before native writes. Reusing the UUID with the identical envelope returns the saved receipt without dispatch; a changed envelope conflicts. This check also works for an original request read after restart. A new UUID with an expired epoch cannot execute.

| Action           | Fields and behavior                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread-create`  | `provider: 'codex'`, `workspaceRoot`, `name`. Creates an empty native thread and sets its readable name before reporting acknowledgement.                                                                                                                                                                                                                                                                  |
| `thread-adopt`   | The same fields plus `nativeId`, `operatorConfirmation`. Explicitly transfers an unloaded external thread into HQ control.                                                                                                                                                                                                                                                                                 |
| `thread-resume`  | `threadId`, `operatorConfirmation`. Loads an inactive managed thread without full-history hydration.                                                                                                                                                                                                                                                                                                       |
| `thread-recover` | `threadId`, `operatorConfirmation`, `recovery`. The recovery is `{ kind: 'resume' }` for a known native identity, `{ kind: 'attach', nativeId }` for an inspected identity after uncertain creation, or `{ kind: 'create' }` to explicitly create a fresh empty thread when no native identity was recorded. The latter can leave an empty orphan from the uncertain creation; it never repeats a message. |
| `thread-rename`  | `threadId`, `name`. Changes the name only after the matching native acknowledgement.                                                                                                                                                                                                                                                                                                                       |
| `thread-close`   | `threadId`. Requires an idle thread, pauses its queue, cleans native background terminals, verifies the terminal list is empty, then unsubscribes before releasing control.                                                                                                                                                                                                                                |
| `message`        | `threadId`, `text`. Starts a turn only while idle.                                                                                                                                                                                                                                                                                                                                                         |
| `steer`          | `threadId`, `expectedTurnId`, `text`. Uses native `turn/steer`. A finished or changed turn cannot become a new turn.                                                                                                                                                                                                                                                                                       |
| `queue`          | The same target/text fields as steering. Saves an explicit next-turn message, never a permission or question answer.                                                                                                                                                                                                                                                                                       |
| `queue-send`     | `queuedActionId`. Explicitly authorizes a still-undelivered queue entry, including a queue paused by restart or interruption.                                                                                                                                                                                                                                                                              |
| `queue-cancel`   | `queuedActionId`. Cancels only an undelivered queue entry and clears its saved body.                                                                                                                                                                                                                                                                                                                       |
| `interrupt`      | `threadId`, `expectedTurnId`. A native request acknowledgement leaves the thread stopping until native completion evidence arrives.                                                                                                                                                                                                                                                                        |
| `native-reply`   | `threadId`, `expectedTurnId`, `approvalId`, `response`. Answers one exact current native request; cannot consume queue text.                                                                                                                                                                                                                                                                               |

Names use lowercase ASCII letters, digits and hyphens, start with a letter or digit, and have at most 32 characters. Names and provider/native-session pairs are unique in one state directory. At most 32 native sessions are controlled concurrently; close idle sessions to release capacity. Native discovery remains independent of that limit. Confirm that other native CLI controllers are closed before adoption, resume or recovery. An unloaded native status cannot prove another CLI has stopped. HQ provides exclusive coordination within one canonical state directory; it does not impose a global lock on independent CLIs. Recovery is permitted only after the producing runtime has stopped and its ownership evidence has been inspected.

Receipts separate `delivery` (`queued`, `submitted`, `acknowledged`, `uncertain`, `failed`, `canceled`) from nullable native turn `completion` (`completed`, `failed`, `interrupted`). Acknowledgement means the exact native request was accepted, not that the turn or tool completed. Permission replies remain submitted after a pipe write and become acknowledged only when Codex resolves the exact native request. Resolution does not prove a tool ran. The receipt includes HQ/native identity, request phase, digest, timestamps, safe failure classification and optional related action. Only selected receipts expose undelivered `queuedText`; collection reads omit it.

A missing acknowledgement never triggers an automatic resend. Exact late responses reconcile delivery, including completion that arrived first. Native output loss marks controls and submitted work uncertain. Restart quarantines controls from an interrupted runtime; explicit recovery preserves the HQ identity and name. Successful shutdown proves native process-group exit before marking controls inactive. Unknown creation without a native identity remains uncertain.

Normal native turn completion may advance ready queued entries once, in creation/UUID order. Failure, interruption, explicit interrupt admission or restart pauses the queue. Permission prompts do not advance it. An unacknowledged start or metadata change blocks dependent starts until its outcome is reconciled or the stopped runtime is recovered explicitly. A turn's completion does not settle an unresolved steering receipt.

Native replies use one of these closed response forms:

- `{ kind: 'decision', decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel' }` for command/file approval, restricted to the choices Codex offers.
- `{ kind: 'permission', decision: 'accept' | 'decline', scope: 'turn' | 'session' }` for additional permissions. Acceptance copies only the complete displayed native scope. Unknown permission fields cannot be approved.
- `{ kind: 'answers', answers: { [questionId]: [answer] } }` for native questions. Every requested question must have one answer; predefined choices are enforced when free text is unavailable.

Prompts expose `replyActionId` as soon as a reply is admitted, so reconnecting clients can read its receipt and avoid offering another answer while native resolution is pending. Prompts and answers remain in memory. SQLite retains only native request identities, scope fingerprints and reply receipts. Fingerprints use a per-store HMAC key in the private 32-byte `action.key`. Keep that file with the database; a missing or invalid key on a nonempty store fails closed. Ordinary message bodies are not saved by HQ. Undelivered queued messages are saved until dispatch or cancellation.

## Control reads and reconnect

| Command           | Fields                                            | Result                                                                            |
| ----------------- | ------------------------------------------------- | --------------------------------------------------------------------------------- |
| `managed-threads` | `workspaceRoot`, optional `limit`, `cursor`       | Creation/UUID seek page of HQ records, including inactive and uncertain states.   |
| `managed-thread`  | `threadId`                                        | One HQ record or null.                                                            |
| `receipt`         | `actionId`                                        | One receipt or null.                                                              |
| `actions`         | `threadId`, optional `limit`, `cursor`            | Creation/UUID seek page of action metadata without queued bodies.                 |
| `events`          | `threadId`, optional `after` (default 0), `limit` | Ascending durable sequence page and `hasMore`; continue after the final sequence. |
| `approvals`       | `threadId`                                        | Current in-memory native prompts, including exact scope and question metadata.    |
| `live-items`      | `threadId`                                        | Active/awaiting-flush item window and `hasGap`.                                   |

Control pages default to 32 and cap at 128. Seek cursors are bound to their complete query and ordering. Reads recheck allowed workspaces. Rejected controls retain their known thread association, and native availability failures appear in each affected thread's replay. Lifecycle replay contains metadata, not token or tool output. The native lifecycle backlog is bounded to 128 operations; an overflow stops native control and marks its state uncertain rather than losing events silently.

Live item presentation is bounded to 128 items per cached thread, 32 windows and 4 MiB of serialized presentation across the runtime, including escaped text and identifiers. This leaves room inside the IPC response limit. Display text uses the same truncation contract as native history. Eviction, an unavailable window or missing chunks sets `hasGap`. Completed items remain `awaiting-flush` after thread closure until a native history page contains exactly matching normalized content or the bounded cache evicts them. Read persisted history and the live window together after reconnect; a process restart cannot reconstruct unflushed in-memory content.

Items expose only normalized presentation fields. User/agent text, commands and file changes have explicit kinds. Unknown native kinds report `unsupported` without copying arbitrary payloads. Display text is bounded to 65,536 UTF-16 code units without splitting a surrogate pair; `isTruncated` reports omissions. An unsupported or oversized native transport frame fails explicitly.

## Subscription observations

Usage retains actual bucket/window identities, optional native labels, reported used percentage, remaining percentage, window duration and reset time. Percentages are never estimated from token counts or summed across sessions. Reported usage above 100 is preserved; remaining percentage floors at zero. `ordinaryUsageAllowed` is nullable when the native response does not report permission.

`available` means a usable observation exists. `exhausted` requires the native permission/reached signal. Neither label authorizes a model operation. `unavailable` covers missing windows or an observation that could not be obtained. Failed refreshes preserve a measured snapshot as `stale`, with its original `observedAt`. Observations older than 60 seconds or past a reported reset are stale. Native account/rate-limit notifications trigger a coalesced refresh; account changes discard the account's measurements, including late responses from an earlier account.

Every usage read requests current native observations; the last successful snapshot is retained only to explain freshness after a failure. There is no TTL cache that suppresses a native refresh. Multiple simultaneous reads share one pending refresh.

## CLI

`jg-agent-hq serve --state-root <directory> --workspace-root <directory>` starts the host. Repeat `--workspace-root` to authorize several roots. Client commands use `--state-root`; history commands also use one `--workspace-root` and, where required, `--native-id`. Paged commands support `--limit` and `--cursor`; items support `--turn-id`; thread discovery supports `--search`. CLI paths resolve from the caller's working directory. There are no shell commands or raw native RPC passthroughs.

Output is one JSON line with `schemaVersion: 1`. Read output includes the command `kind` and `result`. Startup reports `kind: ready`. Confirmed shutdown reports `kind: stop` with `result.state: stopped`. Failure output goes to stderr with a safe error kind/message and exit status 1. The CLI never prints diagnostic causes or native payloads in an error response.

`jg-agent-hq request --state-root <directory>` reads one complete HQ request from stdin, validates it, and prints the usual response. It accepts no extra target flags. This exposes action and reconnect operations without putting message text or question answers in command-line arguments. Its `stop` response acknowledges admission; use the dedicated `stop` command for confirmed shutdown.
