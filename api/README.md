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

The controller exclusively creates `hq-owner.json`. A live, inactive, incomplete or unverifiable existing owner prevents another controller from starting. There is no automatic takeover. Before deliberate recovery, establish that the inspected host, its worker and native process group have stopped. Runtime shutdown closes IPC connections, SQLite and owned native processes before removing the exact owner. Failed cleanup preserves ownership evidence. A new runtime receives a new epoch.

`requestAgentHq(stateRoot, command)` is a one-command IPC client. It verifies the private owner and socket, binds the command to the runtime epoch and checks the matching response. Closing a client does not close the host. `stop` accepts a shutdown request; the SDK caller must await `runtime.closed` when it owns the runtime. The CLI confirms owner removal before reporting `state: stopped`.

The socket accepts at most 32 simultaneous connections. Requests are bounded to 65,536 UTF-8 bytes; native and IPC response frames to 8,388,608 bytes. Structured transports reject malformed UTF-8/JSON, oversized frames and incomplete tails. Each native connection has at most 32 pending calls with a 30-second response deadline. IPC connections have a 35-second deadline. The SQLite worker bounds its queue to 32 commands and its commands to one page. Database work runs off the host event loop. The state directory is a same-user trust boundary, not a sandbox against other code running as that user.

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

Threads have `ownership: external`, native state and nullable native name. Timestamps use Unix milliseconds. Discovery metadata, its observation time, runtime epoch and continuation are upserted into SQLite. This projection is not authoritative transcript history and never caches a conversation body. Repeated history reads go to Codex so a completed turn whose items have not flushed can be read again later. There is no resume-to-read behavior or Codex transcript-file parser.

Items expose only normalized presentation fields. User/agent text, commands and file changes have explicit kinds. Unknown native kinds report `unsupported` without copying arbitrary payloads. Display text is bounded to 65,536 UTF-16 code units without splitting a surrogate pair; `isTruncated` reports omissions. An unsupported or oversized native transport frame fails explicitly.

## Subscription observations

Usage retains actual bucket/window identities, optional native labels, reported used percentage, remaining percentage, window duration and reset time. Percentages are never estimated from token counts or summed across sessions. Reported usage above 100 is preserved; remaining percentage floors at zero. `ordinaryUsageAllowed` is nullable when the native response does not report permission.

`available` means a usable observation exists. `exhausted` requires the native permission/reached signal. Neither label authorizes a model operation. `unavailable` covers missing windows or an observation that could not be obtained. Failed refreshes preserve a measured snapshot as `stale`, with its original `observedAt`. Observations older than 60 seconds or past a reported reset are stale. Native account/rate-limit notifications trigger a coalesced refresh; account changes discard the account's measurements, including late responses from an earlier account.

Every usage read requests current native observations; the last successful snapshot is retained only to explain freshness after a failure. There is no TTL cache that suppresses a native refresh. Multiple simultaneous reads share one pending refresh.

## CLI

`jg-agent-hq serve --state-root <directory> --workspace-root <directory>` starts the host. Repeat `--workspace-root` to authorize several roots. Client commands use `--state-root`; history commands also use one `--workspace-root` and, where required, `--native-id`. Paged commands support `--limit` and `--cursor`; items support `--turn-id`; thread discovery supports `--search`. CLI paths resolve from the caller's working directory. There are no shell commands or raw native RPC passthroughs.

Output is one JSON line with `schemaVersion: 1`. Read output includes the command `kind` and `result`. Startup reports `kind: ready`. Confirmed shutdown reports `kind: stop` with `result.state: stopped`. Failure output goes to stderr with a safe error kind/message and exit status 1. The CLI never prints diagnostic causes or native payloads in an error response.
