# jg-agent-hq

Workspace primitives for native coding agents. The public API provides owner-aware filesystem locks, Claude and Codex thread control, live input and history, actual account usage, and revision-bound plan authority.

Requires Node.js 24.15.0 or later on Linux or macOS. The lock protocol uses POSIX ownership, private directories and process-liveness probes. Windows is outside the supported host contract.

## Development

Use pnpm 12.4.0. Run `pnpm install`, then `pnpm check:package` to build, exercise the built API and packed consumer, typecheck and check formatting. `pnpm test:unit` and `pnpm test:integration` select their own categories after a build.

Work on `development`; reviewed changes reach `main` through a pull request. npm releases are manual and use the exact tested tarball.

## Lock ownership

Callers supply a trusted state root. Locks live in its private `.runtime/hq.lock`. A holder records its process ID, nonce, safe operation label and creation time. Live holders are awaited. Dead, incomplete or unverifiable owners require inspection and are never automatically reclaimed, because child processes may remain alive.

Short metadata operations use `withHqLock`. Long-lived runtime ownership must use a separate owner record; never hold a metadata lock for an agent turn's lifetime. The lock coordinates cooperating processes and does not isolate hostile code running as the same OS user.

See the [API reference](api/README.md) and [error contracts](errors/README.md).

## Local controller

Install Codex and sign in through its native CLI, then start `jg-agent-hq serve --state-root .runtime --workspace-root /path/to/workspace`. Run `jg-agent-hq status --state-root .runtime` in a client. `threads`, `thread`, `turns`, `items` and `usage` read native information; `stop` waits for confirmed runtime shutdown.

The Node API exposes `createAgentHq({ stateRoot, allowedRoots })` and `requestAgentHq(stateRoot, command)`. Configuration comes from these trusted operator inputs. Coding-instruction files are not runtime configuration.

The controller owns its SQLite worker and native connections independently of client connections. Private state contains the lifetime owner, Unix socket and SQLite discovery metadata. Conversation bodies remain in the native providers' storage. Browsing never resumes an external session or starts inference. Quota windows come from native account observations, with explicit stale and unavailable states.

The current read contracts were exercised against Codex 0.163.0 and Claude Code 2.1.304 on Linux. Unsupported native responses fail explicitly. `jg-agent-hq/contracts` contains browser-safe schemas and types; importing it does not import the host runtime.

Use `--provider claude` for Claude history and usage; the default is `codex`. Claude connects lazily through its native structured CLI, with normal settings enabled and no user prompt. Usage requests explicitly disable the optional transcript-behavior scan. Its local history reader supports the qualified 2.1.304 format only, keeps byte locations rather than conversation bodies in SQLite, and reports unsupported history as unavailable. File history cannot establish current execution state. See the [reader limits and freshness contract](api/README.md#claude-history).

Explicit actions create, name, adopt, resume and close threads; send idle messages; steer an exact running turn; queue the next message; interrupt; and answer native questions or permissions. Actions have stable UUIDs and durable receipts. Repeating the same request returns its receipt; changing that UUID's payload conflicts. A lost acknowledgement stays uncertain until the exact native response arrives or the operator makes an explicit recovery choice. HQ never resends uncertain input.

Native execution settings, instructions, skills and tool permissions remain with each CLI. Claude uses an owned structured process per controlled session and reports immediate steering as unavailable. Plan approval grants no native tool permission. Close other CLI controllers before confirming adoption, resume or recovery. HQ coordinates sessions sharing one state directory; it cannot lock independently running native CLIs. Durable state includes `action.key`, which must stay private and accompany its SQLite database. Queued undelivered text is saved; ordinary message bodies and question answers are not.

Use `suggest-thread-name --topic "Build usage" --state-root <directory>` for an editable label and `managed-thread-name --name build-usage --state-root <directory>` to resolve it. Creation adds a short ordinal suffix when a name is occupied. Actions and relationships retain immutable IDs.

Use `skills --thread-id <id> --state-root <directory>` to browse the controlled session's native skill catalog. `skill-preview --thread-id <id> --skill-id <id> --arguments "auto exact-plan" --state-root <directory>` shows the exact invocation without sending it. Missing native metadata is explicitly unavailable. The CLI loads all skill content and retains its permissions and invocation rules.

Use `jg-agent-hq request --state-root <directory>` with a closed HQ command on stdin for action and control reads. The [API reference](api/README.md) describes action envelopes, receipts and reconnect reads.

## Plan coordination

`plan-status --directory <path>` and `plan-milestones --directory <path>` inspect a selected ordinary planning directory. No project registry is required. Mutations use the existing `request` JSON command with `kind: 'plan'`; see the [plan command reference](api/README.md#plan-coordination).

Finalization assigns milestone UUIDs and returns the complete canonical sequence. Plan approval, sequence approval and scoped execution authorization are separate explicit operator actions. None sends native input or answers tool permissions. `coordination.json` holds current records beside the plan. SQLite retains write replay identities and a replaceable, paged milestone projection. Keep both when recovering interrupted writes. A pending write blocks further mutation until its original action is reconciled.

Begin a revision before native planning. HQ stops bound implementation threads and their owned background work, captures partial-work evidence, and keeps execution paused while the CLI revises the plan and regenerates milestones. The finalizer carries exact matches automatically and asks for one confirmation covering every unmatched completed or partial milestone. Equivalent rewording preserves the original completion evidence. Changed requirements remain pending. Present and approve the canonical sequence, then explicitly authorize the new execution scope and mode. Neither approval nor restart resumes implementation. See the [revision recovery contract](api/README.md#revision-and-progress-recovery).

## Project blueprint

- `src/index.ts`: the explicit public package boundary.
- `src/locks/`: lock ownership, acquisition, status and deliberate recovery.
- `src/runtime/`: trusted configuration and lifetime ownership.
- `src/ipc/` and `src/cli/`: private local commands and the installed executable.
- `src/providers/codex/`: native history and account protocol.
- `src/providers/claude/`: native structured control and usage, plus the version-checked, worker-owned local history reader.
- `src/sessions/`: authorized, cursor-bound history reads and short label suggestions.
- `src/plans/`: execution digests, milestone finalization, revision checkpoints, retained verification and explicit plan authority.
- `src/skills/`: bounded native catalogs, invocation previews and explicit input preparation.
- `src/actions/`: durable action dispatch, native input routing and bounded live presentation.
- `src/store/`: SQLite discovery metadata and the action/control ledger in one worker.
- `src/contracts/`: browser-safe command and response contracts.
- `scripts/package/`: build-output cleanup and packed-consumer checks.
- `scripts/test-support/`: disposable external CLI fixtures.
- `vitest/`: separate unit and integration selection.
- `api/README.md`: canonical public API reference.
- `errors/README.md`: stable application errors.

`/docs` is reserved for concise, quickly scannable documentation of essential durable concepts and processes. API references remain outside `/docs`.

## Testing

Tests consume built public exports. Unit tests cover application-owned decisions; integration tests use real temporary files, SQLite workers, IPC, child processes and an isolated tarball consumer. Synthetic CLIs replace only the external provider boundary. Every fixture removes its own resources. Production output excludes all test categories. `pnpm test` builds, then runs unit and integration suites. `pnpm check:package` is the task-completion check. Run changed integration files three consecutive times with retries disabled, using Vitest's `--repeats=2 --retry=0`.

Current local checks establish the tested host only. Release qualification must include the Node engines floor and current LTS; macOS operation requires its own runtime evidence.
