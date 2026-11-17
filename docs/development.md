# Development

Use pnpm 12.4.0. Run `pnpm install --frozen-lockfile`, then `pnpm check:package` to build, exercise the built API and packed consumer, typecheck and check formatting. `pnpm test:unit` and `pnpm test:integration` select their own categories after a build. The private website workspace has separate checks; install Chromium with `pnpm --dir website exec playwright install chromium`, then run `pnpm --dir website check`. `pnpm check` runs both boundaries.

Work on `development`; reviewed changes reach `main` through a pull request. After both Node checks pass on `main`, `check.yml` publishes the exact consumer-tested tarball through npm's configured trusted publisher, then deploys the website. No local npm login or token is needed. An identical published version is skipped; changed contents require a new version.

## Testing commands

`pnpm test`, `pnpm check:package`, and `pnpm check` run essential coverage. Their `:full` counterparts retain complete package or package/website checks. Granular and focused commands remain complete by default. Full runs locally only on explicit request; see the [testing policy](https://github.com/jesusgraterol/jg-agent-hq/blob/main/docs/testing.md) for classification and affected-consumer checks.

CI qualifies the package on both supported Node versions through `pnpm check:package`. Website verification and deployment run separately through Pages after successful main publication; a website failure does not block npm publication.

Testing maintenance can reuse an existing version when only these six aggregate scripts and this marked testing-command block differ. All runtime files, dependencies, exports, installation scripts, other documentation, and file permissions remain protected by the release check. This narrow exception to the general version rule above skips publication; it does not change the installed package.

The root README is now an overview/index and has no marked testing-command block. The release guard retains its bounded compatibility rule; without a block, its README exception does not apply. [Testing](testing.md) owns current suite policy.

## Project blueprint

- `src/index.ts`: the explicit public package boundary.
- `examples/`: public source helpers for sessions and shared host storage.
- `src/runtime/`: trusted configuration, lifetime ownership through the state root's jg-locks `runtime` lock and the start-time warm-up of both CLIs.
- `src/ipc/` and `src/cli/`: private local commands and the installed executable.
- `src/providers/codex/`: the shared app-server daemon connection, native history, usage protocol and session deletion through the daemon.
- `src/providers/claude/`: native structured control and usage, the identity-validated, worker-owned local history reader and transcript deletion, the active-session poll and the background-task counter it reads transcripts with.
- `src/providers/registry/`: lazy creation of the built-in adapters, bounded operations and lifecycle, and source isolation.
- `src/providers/inputs/` and `src/providers/results/`: checked file delivery and complete native result validation.
- `src/providers/configuration/` and `src/providers/lineage/`: bounded native choices and confirmed immutable session relationships.
- `src/sessions/`: authorized discovery that merges folders' and providers' native pages with live session states, the active-session list, bounded evidence and provenance, cursor-bound history reads and short label suggestions.
- `src/skills/`: bounded native catalogs and explicit input preparation.
- `src/actions/`: durable action admission, phased native dispatch, ordered native events, rejoining kept sessions at startup and after a Codex connection loss, bounded live presentation, and receipt waits and long-polls its own changes wake.
- `src/store/`: SQLite discovery metadata, observed sessions and state transitions, the action/control ledger and the snapshot's database copy in one worker, whose model methods the main thread calls with one typed `call`; `src/store/control/` splits the ledger into reads, rule-driven admission, native outcomes, native observations and runtime lifecycle.
- `src/pending/`: the request bookkeeping, deadlines and late-response detection shared by the store worker and native connections.
- `src/errors/`: the catalog of jg-agent-hq's coded errors and their safe boundary classifications.
- `src/storage/`: trusted host metadata and connections, exclusive maintenance and the current schema stamp.
- `src/snapshots/`: capture while agents work, manifest validation and offline recovery that releases native ownership.
- `src/contracts/`: browser-safe command and response contracts, including the jg-locks lock list.
- `scripts/package/`: build-output cleanup and packed-consumer checks.
- `scripts/release/`: registry version/integrity checks and trusted publication of the tested archive.
- `scripts/test-support/`: disposable external CLI fixtures.
- `vitest/`: separate unit and integration selection.
- `api/README.md`: canonical public API reference.
- `errors/README.md`: stable application errors.
- `website/`: private public-site workspace with its own README and test/check commands; canonical documentation bodies live in `docs/getting-started.md` and `api/README.md`.
- `docs/website.md`: durable website architecture, verification and generated-asset sources.
- `docs/architecture.md`: provider and database ownership, schema initialization and host maintenance.
- `docs/recovery.md`: local snapshot coverage, offline recovery and the host's remote durability responsibilities.
- [`docs/delivery.md`](https://github.com/jesusgraterol/jg-agent-hq/blob/main/docs/delivery.md): ordered development, main and npm publication stops, operators and release verification.

`/docs` is reserved for concise, quickly scannable documentation of essential durable concepts and processes. API references remain outside `/docs`.
