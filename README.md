# jg-agent-hq

Workspace primitives for native coding agents. The current public API provides owner-aware filesystem locks for a single execution host.

Requires Node.js 24.15.0 or later on Linux or macOS. The lock protocol uses POSIX ownership, private directories and process-liveness probes. Windows is outside the supported host contract.

## Development

Use pnpm 12.4.0. Run `pnpm install`, then `pnpm check:package` to build, exercise the built API and packed consumer, typecheck and check formatting. `pnpm test:unit` and `pnpm test:integration` select their own categories after a build.

Work on `development`; reviewed changes reach `main` through a pull request. npm releases are manual and use the exact tested tarball.

## Lock ownership

Callers supply a trusted state root. Locks live in its private `.runtime/hq.lock`. A holder records its process ID, nonce, safe operation label and creation time. Live holders are awaited. Dead, incomplete or unverifiable owners require inspection and are never automatically reclaimed, because child processes may remain alive.

Short metadata operations use `withHqLock`. Long-lived runtime ownership must use a separate owner record; never hold a metadata lock for an agent turn's lifetime. The lock coordinates cooperating processes and does not isolate hostile code running as the same OS user.

See the [API reference](api/README.md) and [error contracts](errors/README.md).

## Project blueprint

- `src/index.ts`: the explicit public package boundary.
- `src/locks/`: lock ownership, acquisition, status and deliberate recovery.
- `scripts/package/`: build-output cleanup and packed-consumer checks.
- `vitest/`: separate unit and integration selection.
- `api/README.md`: canonical public API reference.
- `errors/README.md`: stable application errors.

`/docs` is reserved for concise, quickly scannable documentation of essential durable concepts and processes. API references remain outside `/docs`.

## Testing

Tests consume built public exports. Unit tests cover application-owned decisions; integration tests use real temporary files, child processes and an isolated tarball consumer. Every fixture removes its own resources. Production output excludes all test categories. `pnpm test` builds, then runs unit and integration suites. `pnpm check:package` is the task-completion check.

Current local checks establish the tested host only. Release qualification must include the Node engines floor and current LTS; macOS operation requires its own runtime evidence.
