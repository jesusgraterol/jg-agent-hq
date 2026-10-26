# jg-agent-hq

A TypeScript library and local controller for applications that run coding agents. Create native Claude Code and Codex sessions, send work, handle permissions and follow results through one API. Agents collaborate through indexed streams, directed requests and exact reports, with explicit authority for delegated work.

Use it to build an agent dashboard, editor integration or automated development workflow. HQ owns local session control, agent identity, collaboration state and plan coordination. Your application owns its interface, authentication and off-machine backups. Native CLIs supply the coding harnesses, tools, skills and sign-in; additional providers can implement the same host contract.

Requires Node.js 24.15.0 or later on Linux or macOS. The lock protocol uses POSIX ownership, private directories and process-liveness probes. Windows is outside the supported host contract.

## Installation

Install the package locally:

```sh
npm install jg-agent-hq
npx jg-agent-hq serve --state-root .runtime --workspace-root .
```

Install Claude Code and/or Codex separately and sign in through their native CLIs. Run the controller in your trusted workspace. The CLI examples below assume the installed executable is on PATH; prefix them with `npx` for a local npm installation.

This public package provides a local controller and browser-safe contracts. Applications own their UI, authentication and deployment. It does not include a hosted app or a Moldea UI download.

## Development

Use pnpm 12.4.0. Run `pnpm install`, then `pnpm check:package` to build, exercise the built API and packed consumer, typecheck and check formatting. `pnpm test:unit` and `pnpm test:integration` select their own categories after a build. The private website workspace has separate checks; install Chromium with `pnpm --dir website exec playwright install chromium`, then run `pnpm --dir website check`. `pnpm check` runs both boundaries.

Work on `development`; reviewed changes reach `main` through a pull request. After both Node checks pass on `main`, `check.yml` publishes the exact consumer-tested tarball through npm's configured trusted publisher, then deploys the website. No local npm login or token is needed. An identical published version is skipped; changed contents require a new version.

## Lock ownership

Callers supply a trusted state root. Locks live in its private `.runtime/hq.lock`. A holder records its process ID, nonce, safe operation label and creation time. Live holders are awaited. Dead, incomplete or unverifiable owners require inspection and are never automatically reclaimed, because child processes may remain alive.

Short metadata operations use `withHqLock`. Long-lived runtime ownership must use a separate owner record; never hold a metadata lock for an agent turn's lifetime. The lock coordinates cooperating processes and does not isolate hostile code running as the same OS user.

See the [API reference](api/README.md) and [error contracts](errors/README.md).

Intentional failures use `Exception` from `jg-exception`, with the named string codes in the error reference. Local clients use `PUBLIC_ERROR_CODES` and `PUBLIC_ERROR_MESSAGES` from `jg-agent-hq/contracts` for errors translated at the IPC boundary. Safe classifications remain separate from private diagnostic causes.

## Local controller

Install the providers you want and sign in through their native CLIs, then start `jg-agent-hq serve --state-root .runtime --workspace-root /path/to/workspace`. Run `jg-agent-hq status --state-root .runtime` in a client. `threads`, `thread`, `turns`, `items` and `usage` read native information; `stop` waits for confirmed runtime shutdown.

The Node API exposes `createAgentHq({ stateRoot, allowedRoots })` and `requestAgentHq(stateRoot, command)`. Configuration comes from these trusted operator inputs. Coding-instruction files are not runtime configuration.

The controller owns its SQLite worker and native connections independently of client connections. Its provider registry starts each native integration only when selected. Storage and managed-session reads work without an installed coding CLI; an unavailable provider does not disable another provider. Private state contains the lifetime owner, Unix socket and SQLite discovery metadata. Conversation histories remain in native storage; HQ retains complete bounded final results on their action receipts. Browsing never resumes an external session or starts inference. Quota windows come from native account observations, with explicit stale and unavailable states. Usage reads include Codex credit balances and available earned-reset counts when reported, plus Claude five-hour and seven-day meters with their model/surface scopes and reset times.

Use `sessions` for discovery and `session-evidence` for newest-first historical evidence. These reads fit within 65,536 serialized bytes, retain exact native identities and content hashes, and continue large bodies in UTF-8 chunks. Select an item, turn or item kinds with filters. Matching names remain separate sessions. Provenance distinguishes native evidence from exact host submissions; historical text and quoted feedback never grant approval. See [bounded session evidence](api/README.md#bounded-session-evidence).

Trusted Node hosts can open the database described by `hq.storage` and keep application tables under their own prefix. HQ reserves `hq_`, validates its current schema stamp on startup, and leaves application schema ownership and `user_version` with the host. Use `hq.withStorageMaintenance(callback)` for host schema changes; it drains admitted work and rejects active native execution before the callback. The stamp records the package version that wrote the database, and startup refuses any other schema with an error naming that version; HQ never migrates storage. See the [shared storage contract](api/README.md#shared-storage).

`createHqSnapshot(hq, destination)` captures local state through SQLite's backup API while agents keep working, including host tables, stored reports, action.key and registered plan companions. HQ-mediated plan writes wait for it; the host keeps its own connections from writing host tables until it resolves. A plan that changed during capture is marked, and restore withholds its execution authority. `inspectHqSnapshot(directory)` verifies the complete snapshot; `restoreHqSnapshot({ snapshotDirectory, destination })` validates and stages it into a new private recovery workspace. Snapshots from another schema are refused by the package version that wrote them. Restored automation is paused, skill grants are revoked, native ownership needs reconciliation and allowed roots must be selected explicitly. Hosts own remote backups; a failed disk can lose changes since the last successful off-machine backup. See [snapshot and restore](api/README.md#snapshot-and-restore) and [recovery](docs/recovery.md).

Provider IDs are bounded lowercase identifiers. Codex and Claude are built in; trusted Node hosts can register additional `IAgentProviderFactory` implementations through `providerFactories`. Capabilities report current operation support, provider/session scope and unavailable reasons. Native version labels are diagnostic metadata and never determine admission. Unknown essential control data fails explicitly. `jg-agent-hq/contracts` contains browser-safe schemas and types; importing it does not import the host runtime.

Use `--provider claude` for Claude history and usage; the default is `codex`. Claude connects lazily through its native structured CLI, with normal settings enabled and no user prompt. Usage requests explicitly disable the optional transcript-behavior scan. Its local history reader validates required identity, workspace and chain fields, tolerates additive fields and mixed version labels, and keeps byte locations rather than conversation bodies in SQLite. Unknown ordered content is presented as unsupported; untrustworthy identity or ordering makes the affected read unavailable. File history cannot establish current execution state. See the [reader limits and freshness contract](api/README.md#claude-history).

Explicit actions create, name, adopt, resume and close threads; send idle messages; steer an exact running turn; queue the next message; interrupt; and answer native questions, permissions or MCP elicitation. Actions have stable UUIDs and durable receipts. Repeating the same request returns its receipt; changing that UUID's payload conflicts. A lost acknowledgement stays uncertain until the exact native response arrives or the operator makes an explicit recovery choice. HQ never resends uncertain input.

Actions also fork native history into a distinct session, compact idle sessions, and use native archive/unarchive and history revert where supported. Forks retain exact native lineage and receive no plan execution authority from their source. Unarchive leaves a session inactive until explicitly resumed. Revert changes conversation history; it does not undo files. Claude exposes compaction and fork, with archive and conversation revert reported as unsupported.

Use `account --provider <id>` for safe native account metadata, and `mcp-servers --thread-id <id>` for configured server status. `mcp-tools` and `mcp-resources` select `--server-name <name>` and support bounded continuation. Native reload and authentication controls use the existing JSON `request` interface and durable action receipts. Login URLs are live presentation and are never saved in SQLite. See [native accounts and extensions](api/README.md#native-accounts-and-extensions).

Use `models --provider <id>` for native model and effort choices, and `configuration --provider <id> --workspace-root <path> [--thread-id <id>]` for known effective settings and paged native agent/profile metadata. Creation and explicit resume accept typed startup settings; messages can select a model and effort for the next turn. Startup instructions, native Claude agents and permission settings require an idle session restart. Capability schemas describe supported selections and change modes. Unknown settings remain explicit, and native configuration files stay with each CLI. See the [configuration contract](api/README.md#native-configuration).

Native execution settings, instructions, skills and tool permissions remain with each CLI. Claude uses an owned structured process per controlled session and reports immediate steering as unavailable. Plan approval grants no native tool permission. Close other CLI controllers before confirming adoption, resume or recovery. HQ coordinates sessions sharing one state directory; it cannot lock independently running native CLIs. Integrating browser hosts can use durable host-action admission and operator-scoped reconciliation through the programmatic API; see the [browser host contract](api/README.md#browser-host-integration). The standalone CLI advertises only commands it implements.

Approval reads return indexed, cursor-paginated pending, answered and expired metadata after reconnect or restart. Sensitive presentation is available only while the exact native request is live. Native permissions require explicit responses; unknown request kinds or scopes are denied. See [native replies and reconnect reads](api/README.md#thread-control-and-live-input).

Durable state includes `action.key`, which must stay private and accompany its SQLite database. Queued undelivered inputs and complete bounded final results are saved; ordinary input bodies and question answers are not.

Text and skill inputs can attach bounded workspace files by path and media type. HQ verifies their content hashes again before queued delivery. Output schemas use native Codex turn parameters or Claude's structured-session flag; complete validated results and known token usage remain available on selected receipts after reconnect. Live previews stay bounded and explicitly mark truncation. See [file inputs and complete results](api/README.md#file-inputs-and-complete-results).

Use `suggest-thread-name --topic "Build usage" --state-root <directory>` for an editable label and `managed-thread-name --name build-usage --state-root <directory>` to resolve it. Creation adds a short ordinal suffix when a name is occupied. Actions and relationships retain immutable IDs.

Use `skills --thread-id <id> --state-root <directory>` to browse the controlled session's native skill catalog. `skill-preview --thread-id <id> --skill-id <id> --arguments "auto exact-plan" --state-root <directory>` shows the exact invocation without sending it. Missing native metadata is explicitly unavailable. The CLI loads all skill content and retains its permissions and invocation rules.

Use `jg-agent-hq request --state-root <directory>` with a closed HQ command on stdin for action and control reads. The [API reference](api/README.md) describes action envelopes, receipts and reconnect reads.

Trusted hosts can create collaboration tasks, add managed agents from any provider, and coordinate them through durable streams. Streams contain small indexed messages and optional directed or claimable requests. Subscription, reading, acknowledgement, assignment and completion are separate records. Metadata operations retain replay receipts and recover notification fan-out after restart. Directed requests can run through the existing native action ledger when the host enables automatic dispatch or explicitly selects a request. An assigned agent can publish direct child requests and yield with a bounded wait set. Exact child outcomes or requester clarifications continue the parent under its current authority; child completion never completes or approves the parent. Information, reads and acknowledgements do not start turns. HQ stores exact bounded outcome reports independently of native histories. Hosts issue exact task-scoped skill grants; role labels and message text grant no authority. See [task collaboration](api/README.md#task-collaboration).

Controlled agents use `hq_identity` to recover their stable managed ID, task memberships, permissions and pending inbox counts. Codex uses experimental native dynamic tools; Claude uses a private session-specific stdio MCP bridge. Both use the same closed operations for streams, verified invocation context, requests, report chunks, session evidence and authorized managed spawning. Children can use either provider and inherit equal or narrower task permissions. The host sets a finite cumulative spawn budget. Native subagents share their owning HQ session identity. See [agent tools](api/README.md#agent-tools).

## Plan coordination

`plan-status --directory <path>` and `plan-milestones --directory <path>` inspect a selected ordinary planning directory. No project registry is required. Mutations use the existing `request` JSON command with `kind: 'plan'`; see the [plan command reference](api/README.md#plan-coordination).

HQ uses jg-plans to observe and prepare ordinary Markdown plans. The default profile retains unknown contractual metadata and all shared requirement sections while excluding only declared administrative fields. Status reports skills bindings as absent, current or stale. A stale binding keeps the plan readable and approvable during revision, but closes finalization and execution until jg-breakdown refreshes coverage; bindings never grant HQ approval. Finalization assigns milestone UUIDs and returns the complete canonical sequence when a breakdown exists. A plan without a breakdown remains one unit: finalization returns null content, plan approval suffices, and whole-plan execution uses an empty milestone selection with a null milestone ID. No milestone file is created merely to make a small plan executable. Plan approval, sequence approval and scoped execution authorization are separate explicit operator actions. None sends native input or answers tool permissions. `coordination.json` holds current records beside the plan. SQLite retains write replay identities and a replaceable, paged milestone projection. Keep both when recovering interrupted writes. Document locks release before the write journal is completed. Checked replacements are private (0600), and progress preserves revision while recording one prepared updated_at. A pending write blocks further mutation until its original action is reconciled.

Coordinators can retain revision-bound compatibility reviews in that same file. Core operations preserve the records without assessing them or granting authority. The integrating coordinator owns review freshness and conflict gates.

Begin a revision before native planning. HQ stops bound implementation threads and their owned background work, captures partial-work evidence, and keeps execution paused while the CLI revises the plan and regenerates milestones. The finalizer carries exact matches automatically and asks for one confirmation covering every unmatched completed or partial milestone. Equivalent rewording preserves the original completion evidence. Changed requirements remain pending. Present and approve the canonical sequence, then explicitly authorize the new execution scope and mode. Neither approval nor restart resumes implementation. Whole-plan checkpoints and completion evidence also work without a milestone file. Removing a sequence requires explicit confirmation covering its retained milestone evidence before whole-plan execution can begin. See the [revision recovery contract](api/README.md#revision-and-progress-recovery).

## Agent review and feedback

Choose any managed reviewer and author, including the same provider, and send task-scoped stream requests. Optional native skills use exact host-issued grants: jg-review-session can read the selected evidence, and jg-feedback can assess an exact report reference. HQ selects the installed native skill and verifies the invocation before dispatch. Missing or unavailable skills remain blocked; no copied workflow is substituted.

Reports return through HQ storage and delivery without manual copying or another reviewer turn. Feedback is untrusted advice and grants no plan approval, execution authority or acceptance of recommendations. Parent work can yield for child results and continue through its existing authority. Busy agents queue; uncertainty never causes automatic resending. See [native skill delegation](api/README.md#native-skill-delegation) and [task collaboration](api/README.md#task-collaboration).

## Source examples

Follow the [three complete walkthroughs](https://jg-agent-hq.jesusgraterol.dev/examples/), with copyable source, visual results and explicit host decisions.

`examples/control-session.ts` creates a native session and reads its actual delivery, output, permission and usage observations. `examples/review-handoff.ts` confirms stream review/assessment requests and returns exact report references, with optional skills and host-selected agents. `examples/revise-plan.ts` runs the planning skills through the revision lease, retains verified work through explicit correspondence, and obtains fresh approvals and execution scope.

These complete TypeScript examples use the public client and contracts. Start the local controller, sign in to the native CLIs, and install the required skills and supported project-local jg-plans CLI first. The host supplies actual user decisions and keeps native permission handling separate. Retain request identities before submission; after an interrupted client call, inspect those receipts instead of rerunning a whole example. Examples are development sources, not package exports or automatic website actions.

`examples/shared-storage.ts` uses a trusted Node runtime to save a singleton application preference under the app\_ prefix, capture and inspect shared SQLite storage, and verify the value after offline restore. It closes its own SQL connections and preserves the host's user_version. Select absent output directories and pause every other writer first. The application write commits before capture; a later backup failure does not roll it back. The recovered state still requires explicit allowed roots and fresh authority before execution.

The [qualification matrix](api/README.md#qualification) records native journeys, host coverage and remaining interface limits.

## Project blueprint

- `src/index.ts`: the explicit public package boundary.
- `examples/`: public source helpers for sessions, stream review, plan revision and shared host storage.
- `src/locks/`: lock ownership, acquisition, status and deliberate recovery.
- `src/runtime/`: trusted configuration and lifetime ownership.
- `src/ipc/` and `src/cli/`: private local commands and the installed executable.
- `src/providers/codex/`: the shared app-server daemon connection, native history and account protocol.
- `src/providers/claude/`: native structured control and usage, plus the identity-validated, worker-owned local history reader.
- `src/providers/registry/`: lazy factories, normalized provider evidence, bounded lifecycle and source isolation.
- `src/providers/inputs/` and `src/providers/results/`: checked file delivery and complete native result validation.
- `src/providers/configuration/` and `src/providers/lineage/`: bounded native choices and confirmed immutable session relationships.
- `src/sessions/`: authorized discovery, bounded evidence and provenance, cursor-bound history reads and short label suggestions.
- `src/plans/`: execution digests, milestone finalization, revision checkpoints, retained verification and explicit plan authority.
- `src/skills/`: bounded native catalogs, invocation previews and explicit input preparation.
- `src/accounts/` and `src/extensions/`: safe account observations and authorized, bounded native MCP inventories.
- `src/collaboration/`: host-owned tasks, streams, scoped skill-grant admission and event-driven directed request dispatch.
- `src/collaboration/identity/` and `src/agent-tools/`: native-bound identity, private bridge credentials, shared agent tools and the stdio MCP entry.
- `src/actions/`: durable action dispatch, native input routing and bounded live presentation.
- `src/store/`: SQLite discovery metadata, collaboration streams and the action/control ledger in one worker.
- `src/storage/`: trusted host metadata, exclusive maintenance and the current schema stamp.
- `src/snapshots/`: capture while agents work, streamed inventory validation and offline recovery with execution paused.
- `src/contracts/`: browser-safe command and response contracts.
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
