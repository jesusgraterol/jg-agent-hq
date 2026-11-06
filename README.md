# jg-agent-hq

A TypeScript library and local controller for applications that run coding agents. Create native Claude Code and Codex sessions, send work, handle permissions and follow results through one API.

Use it to build an agent dashboard, editor integration or automated development workflow. jg-agent-hq owns local session control. Your application owns its interface, authentication and off-machine backups. Native CLIs supply the coding harnesses, tools, skills and sign-in.

Requires Node.js 24.15.0 or later on Linux or macOS. State safety relies on POSIX ownership and private directories. Windows is outside the supported host contract.

## Installation

Install the package locally:

```sh
npm install jg-agent-hq
npx jg-agent-hq serve --state-root .runtime --workspace-root .
```

Install Claude Code and/or Codex separately and sign in through their native CLIs. Run the controller in your trusted workspace. The CLI examples below assume the installed executable is on PATH; prefix them with `npx` for a local npm installation.

This public package provides a local controller and browser-safe contracts. Applications own their UI, authentication and deployment. It does not include a hosted app or a user interface.

## Development

Use pnpm 12.4.0. Run `pnpm install`, then `pnpm check:package` to build, exercise the built API and packed consumer, typecheck and check formatting. `pnpm test:unit` and `pnpm test:integration` select their own categories after a build. The private website workspace has separate checks; install Chromium with `pnpm --dir website exec playwright install chromium`, then run `pnpm --dir website check`. `pnpm check` runs both boundaries.

Work on `development`; reviewed changes reach `main` through a pull request. After both Node checks pass on `main`, `check.yml` publishes the exact consumer-tested tarball through npm's configured trusted publisher, then deploys the website. No local npm login or token is needed. An identical published version is skipped; changed contents require a new version.

[testing-commands:start]: #

## Testing

`pnpm test`, `pnpm check:package`, and `pnpm check` run essential coverage. Their `:full` counterparts retain complete package or package/website checks. Granular and focused commands remain complete by default. Full runs locally only on explicit request; see the [testing policy](https://github.com/jesusgraterol/jg-agent-hq/blob/main/docs/testing.md) for classification and affected-consumer checks.

Testing maintenance can reuse an existing version when only these six aggregate scripts and this marked testing-command block differ. All runtime files, dependencies, exports, installation scripts, other documentation, and file permissions remain protected by the release check. This narrow exception to the general version rule above skips publication; it does not change the installed package.

[testing-commands:end]: #

## Lock ownership

Callers supply a trusted state root. The runtime takes its locks through [jg-locks](https://jg-packages.jesusgraterol.dev/packages/jg-locks/) in the root's private `.runtime/locks` folder: `runtime` for the runtime's lifetime, whose owner nonce is the runtime epoch, and `snapshot` while a capture runs. A live holder of `runtime` refuses another startup, and capture waits up to 120 seconds for a live `snapshot` holder. A holder whose process is gone is never taken over automatically, because its child processes may remain alive. The one exception is a runtime that stopped without releasing the state root: when the host's `isPreviousRuntimeStopped` check proves no process of that runtime remains, the next runtime takes its `runtime` lock over with jg-locks' `recoverFrom`, together with a `snapshot` lock it left and its leftover socket. Recover any other dead holder with jg-locks after inspecting it. The locks coordinate cooperating processes and do not isolate hostile code running as the same OS user.

Machine-wide locks are separate. The `locks` read and `jg-agent-hq locks` list the named locks that scripts, agents and apps on the machine take through [jg-locks](https://jg-packages.jesusgraterol.dev/packages/jg-locks/), each with its holder, so an application built on jg-agent-hq can show them. The runtime only reads them; it never takes, waits for or recovers one. See [machine locks](api/README.md#machine-locks).

See the [API reference](api/README.md) and [error contracts](errors/README.md).

Intentional failures use `Exception` from `jg-exception`, with the named string codes in the error reference. Local clients use `PUBLIC_ERROR_CODES` and `PUBLIC_ERROR_MESSAGES` from `jg-agent-hq/contracts` for errors translated at the IPC boundary. Safe classifications remain separate from private diagnostic causes.

## Local controller

Install the providers you want and sign in through their native CLIs, then start `jg-agent-hq serve --state-root .runtime --workspace-root /path/to/workspace`. Run `jg-agent-hq status --state-root .runtime` in a client. `threads` lists the sessions of several folders and both providers by last activity, with the sessions the runtime created before their first turn, in pages whose cursor resumes each source where it stopped; see [session discovery](api/README.md#session-discovery). `thread`, `items` and `usage` read native information, and each item carries its time as `createdAt`; `thread` answers from the runtime's records, its history unavailable, when its provider can't read it. `item-detail` reads what a developer inspects in one item: its command and output, tool call, file diffs and images, and `item-image` returns one of its images. `stop` waits for confirmed runtime shutdown.

The Node API exposes `createAgentHq({ stateRoot, allowedRoots })` and `requestAgentHq(stateRoot, command)`, whose results, like the runtime's `request`, are typed by their command's kind, and `getErrorKind(error)`, which reads an error's safe classification. The runtime's `runtimeEpoch` is the epoch actions name. Configuration comes from these trusted operator inputs. Coding-instruction files are not runtime configuration.

The controller owns its SQLite worker and native connections independently of client connections. As it starts, it connects to Codex and brings Claude's history index up to date in the background, without waiting for either or failing when a CLI is missing, which status then reports unavailable. Storage and managed-session reads work without an installed coding CLI; an unavailable provider does not disable another provider. Private state contains the runtime's locks, Unix socket and SQLite discovery metadata. Conversation histories remain in native storage; the runtime retains complete bounded final results on their action receipts. Browsing never resumes an external session or starts inference. Quota windows come from native account observations, with explicit stale and unavailable states. Usage reads include Codex credit balances and available earned-reset counts when reported, plus Claude five-hour and seven-day meters with their model/surface scopes and reset times.

Use `session-evidence` for newest-first historical evidence. It fits within 65,536 serialized bytes, retains exact native identities and content hashes, and continues large bodies in UTF-8 chunks. Select an item, turn or item kinds with filters. Provenance distinguishes native evidence from exact host submissions; historical text and quoted feedback never grant approval. See [bounded session evidence](api/README.md#bounded-session-evidence).

Trusted Node hosts can open the database described by `hq.storage` with `openHostDatabase(hq.storage)`, which applies the required connection settings, and keep application tables under their own prefix; the connection can't change the runtime's tables. jg-agent-hq reserves `agent_hq_`, validates its current schema stamp on startup, and leaves application schema ownership and `user_version` with the host. Use `hq.withStorageMaintenance(callback)` for host schema changes; it drains admitted work and rejects active native execution before the callback. The stamp records the package version that wrote the database. Startup supports one transactional upgrade from the exact 12.0.1/13.0.0 native schema, preserving host tables and keys; every other schema is refused with an error naming its writing version. See [recovery](docs/recovery.md) and the [shared storage contract](api/README.md#shared-storage).

`hq.createSnapshot(destination)` captures local state through SQLite's backup API while agents keep working, including host tables and action.key, under the state root's `snapshot` lock; the host keeps its own connections from writing host tables until it resolves. It leaves out the index of Claude transcripts, which a restored runtime rebuilds from the transcripts on its first Claude history read, as a fresh one does. `restoreHqSnapshot({ snapshotDirectory, destination })` verifies the complete snapshot and stages it into a new private recovery workspace. `packHqSnapshot(snapshotDirectory, archivePath, key)` encrypts a snapshot into one AES-256-GCM file for off-machine copies, and `unpackHqSnapshot(archivePath, destination, key)` verifies and writes it back as a snapshot directory. Snapshots from another schema are refused by the package version that wrote them. Restored native ownership needs reconciliation and allowed roots must be selected explicitly. Hosts own the key and remote backups; a failed disk can lose changes since the last successful off-machine backup. See [snapshot and restore](api/README.md#snapshot-and-restore) and [recovery](docs/recovery.md).

Sessions started in a terminal show up too. Codex sessions on the shared daemon and Claude sessions from `claude agents --json` report a live state (`running`, `waiting`, `idle`, `closed`, `failed` or `unknown`) with external ownership. jg-agent-hq builds on what each CLI offers and never stops, wakes or drives a session a terminal runs: it adopts a Codex session the terminal holds between turns, through the shared daemon, and a Claude session only once no terminal runs it, while a Claude session's `terminal` field names the terminal that does. Every state change of a managed or observed session is recorded in order, with the session's folder; read them with `{ kind: 'session-states', afterSequence }` or `session-states`, and add `waitMs` to wait up to 30 seconds for the next one. `live-items` waits the same way for a window's next change, and cuts its text to `textLimit`; both long-polls are woken by the runtime's own changes, never a timer. `active-sessions` lists every running and waiting session with its workspace, and `observation-pace` polls Claude every 5 seconds instead of 30 while a client follows sessions live. See [session states](api/README.md#session-states).

The providers are `codex` and `claude`. Capabilities report current operation support, provider/session scope and unavailable reasons. Native version labels are diagnostic metadata and never determine admission. Unknown essential control data fails explicitly. `jg-agent-hq/contracts` contains browser-safe schemas and types; importing it does not import the host runtime.

Use `--provider claude` for Claude history and usage; the default is `codex`, while `threads` lists both unless `--provider` names one. Claude connects as the runtime starts through its native structured CLI, with normal settings enabled and no user prompt. History reads need that process only for the runtime's first check of the CLI, and a usage result answers reads for 60 seconds. Usage requests explicitly disable the optional transcript-behavior scan. Its local history reader validates required identity, workspace and chain fields, tolerates additive fields and mixed version labels, keeps byte locations rather than conversation bodies in SQLite, and writes nothing for a transcript that hasn't changed. History, live items and evidence present items as the CLI shows them, with `notice` items, tool calls paired with their results, and each file change's files; unknown ordered content is presented as unsupported, and untrustworthy identity or ordering makes the affected read unavailable. File history cannot establish current execution state. See the [reader limits and freshness contract](api/README.md#claude-history).

Explicit actions create, name, adopt, resume, close and delete threads; send idle messages; steer an exact running turn; queue the next message; interrupt; and answer native questions, permissions or MCP elicitation. A create can carry the session's first message and a close can interrupt a running turn first, each as one action. `thread-delete` deletes a session no process runs from its CLI's storage, and the runtime's records of it, within its request. Actions have stable UUIDs and durable receipts, and the `actions` page carries each queued input's text. `action-wait` returns a receipt once it has its native thread ID or settles, woken by the runtime's own changes rather than polling, or as it stands when its timeout of at most 30 seconds passes. Repeating the same request returns its receipt; changing that UUID's payload conflicts. A lost acknowledgement stays uncertain until the exact native response arrives or the operator makes an explicit recovery choice. The runtime never resends uncertain input.

Use `models --provider <id>` for native model and effort choices, and `configuration --provider <id> --workspace-root <path> [--thread-id <id>]` for known effective settings and paged native agent/profile metadata. Creation and explicit resume accept typed startup settings; messages can select a model and effort for the next turn. Startup instructions, native Claude agents and permission settings require an idle session restart. Capability schemas describe supported selections and change modes. Unknown settings remain explicit, and native configuration files stay with each CLI. See the [configuration contract](api/README.md#native-configuration).

Native execution settings, instructions, skills and tool permissions remain with each CLI. Claude uses an owned structured process per controlled session, closes it after 60 idle minutes and reopens it for the next input, and steers its active turn with a structured user message. Close other CLI controllers before confirming adoption, resume or recovery. The runtime coordinates sessions sharing one state directory; it cannot lock independently running native CLIs. Integrating browser hosts can use durable host-action admission and operator-scoped reconciliation through the programmatic API; see the [browser host contract](api/README.md#browser-host-integration). The standalone CLI advertises only commands it implements.

Approval reads return indexed, cursor-paginated pending, answered and expired metadata after reconnect or restart. Sensitive presentation is available only while the exact native request is live. Native permissions require explicit responses; unknown request kinds or scopes are denied. See [native replies and reconnect reads](api/README.md#thread-control-and-live-input).

Durable state includes `action.key`, which must stay private and accompany its SQLite database. Queued undelivered inputs and complete bounded final results are saved; ordinary input bodies and question answers are not.

Text and skill inputs can attach up to 8 workspace files by path and media type, 16 MiB in all and 256 KiB per text file. The runtime verifies their content hashes again before queued delivery. Output schemas use native Codex turn parameters or Claude's structured-session flag; complete validated results and known token usage remain available on selected receipts after reconnect. Live previews stay bounded and explicitly mark truncation. See [file inputs and complete results](api/README.md#file-inputs-and-complete-results).

Use `suggest-thread-name --topic "Build usage" --state-root <directory>` for an editable label of up to 64 characters. Creation adds an ordinal suffix when a name is occupied, keeping the complete label within that limit. `MAX_THREAD_NAME_LENGTH` from `jg-agent-hq/contracts` is the public limit. Actions and relationships retain immutable IDs.

Version 14 adds receipted Codex workspace changes and a finite startup upgrade from the exact 12.0.1/13.0.0 schema. The upgrade retains native identities, host tables, host user_version and action.key. Upgrade runtime and consumers together; older binaries refuse the new schema. Restore an old-schema snapshot with its matching binary before upgrading, and reconcile later native/host effects before recovery. See [package downgrade](docs/recovery.md#package-downgrade).

Use `skills --workspace-root <directory> --state-root <directory>` to browse the native skill catalog a session started in that folder would have, with `--provider` (default `codex`), and add `--thread-id <id>` for a controlled session's own catalog. A skill input resolves its exact invocation from that catalog before it is sent. Missing native metadata is explicitly unavailable. The CLI loads all skill content and retains its permissions and invocation rules.

Use `jg-agent-hq request --state-root <directory>` with one closed request command on stdin for action and control reads. The [API reference](api/README.md) describes action envelopes, receipts and reconnect reads.

## Source examples

Follow the [complete session walkthrough](https://jg-agent-hq.jesusgraterol.dev/examples/), with copyable source and its result.

`examples/control-session.ts` creates a native session and reads its actual delivery, output, permission and usage observations.

These complete TypeScript examples use the public client and contracts. Start the local controller and sign in to the native CLIs first. The host supplies actual user decisions and keeps native permission handling separate. Retain request identities before submission; after an interrupted client call, inspect those receipts instead of rerunning a whole example. Examples are development sources, not package exports or automatic website actions.

`examples/shared-storage.ts` uses a trusted Node runtime to save a singleton application preference under the app\_ prefix through `openHostDatabase`, capture shared SQLite storage with `createSnapshot`, and verify the value after offline restore. It closes its own SQL connections and preserves the host's user_version. Select absent output directories and pause every other writer first. The application write commits before capture; a later backup failure does not roll it back. The recovered state still requires explicit allowed roots before execution.

The [qualification matrix](api/README.md#qualification) records native journeys, host coverage and remaining interface limits.

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
- `src/actions/`: durable action admission, phased native dispatch, ordered native events, rejoining kept sessions, bounded live presentation, and receipt waits and long-polls its own changes wake.
- `src/store/`: SQLite discovery metadata, observed sessions and state transitions, the action/control ledger and the snapshot's database copy in one worker, whose model methods the main thread calls with one typed `call`; `src/store/control/` splits the ledger into reads, rule-driven admission, native outcomes, native observations and runtime lifecycle.
- `src/store/workspaces/`: indexed, action-bound workspace provenance and bounded history-context reads.
- `src/storage/schema/`: strict stamp recognition and the finite transactional startup upgrade.
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
- `website/`: private public-site workspace with its own README and test/check commands; canonical documentation bodies remain in this root README and `api/README.md`.
- `docs/website.md`: durable website architecture, verification and generated-asset sources.
- `docs/architecture.md`: provider and database ownership, schema initialization and host maintenance.
- `docs/recovery.md`: local snapshot coverage, offline recovery and the host's remote durability responsibilities.

`/docs` is reserved for concise, quickly scannable documentation of essential durable concepts and processes. API references remain outside `/docs`.

## Testing

Tests consume built public exports. Unit tests cover application-owned decisions; integration tests use real temporary files, SQLite workers, IPC, child processes and an isolated tarball consumer. Synthetic CLIs replace only the external provider boundary. Every fixture removes its own resources. Production output excludes all test categories. `pnpm test` builds, then runs unit and integration suites. `pnpm check:package` is the task-completion check. Run changed integration files three consecutive times with retries disabled, using Vitest's `--repeats=2 --retry=0`.

The website's README and `docs/website.md` define its build-once check composition, category-specific scripts and owned preview/browser lifecycle. Root and website checks must both pass for task completion when workspace configuration or canonical site content changes.

The runtime fixture teardown is registered with the test runner as well as the callback, so a test timeout cannot restore environment variables during the next test.

Current local checks establish the tested host only. Release qualification must include the Node engines floor and current LTS; macOS operation requires its own runtime evidence.
