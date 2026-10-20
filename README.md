# jg-agent-hq

Workspace primitives for native coding agents. The public API provides owner-aware filesystem locks and a local controller for browsing Codex history and actual account usage.

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

The controller owns its SQLite worker and Codex app-server independently of client connections. Private state contains the lifetime owner, Unix socket and SQLite discovery metadata. Conversation bodies remain with Codex and are fetched through its paged native APIs. Browsing never resumes an external session or starts inference. Quota windows come from native account observations, with explicit stale and unavailable states.

The current Codex read contract was exercised against CLI 0.163.0 on Linux. Unsupported native responses fail explicitly. `jg-agent-hq/contracts` contains browser-safe schemas and types; importing it does not import the host runtime.

## Project blueprint

- `src/index.ts`: the explicit public package boundary.
- `src/locks/`: lock ownership, acquisition, status and deliberate recovery.
- `src/runtime/`: trusted configuration and lifetime ownership.
- `src/ipc/` and `src/cli/`: private local commands and the installed executable.
- `src/providers/codex/`: native history and account protocol.
- `src/sessions/`: authorized, cursor-bound history reads.
- `src/store/`: SQLite discovery projection in a dedicated worker.
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
