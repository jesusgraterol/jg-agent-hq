# Changelog

## 4.0.2

- Read Claude sessions whose transcript holds a hidden record written before the record it follows, such as an instructions attachment or a scheduled-task event. The reader rejected the whole session, so HQ couldn't name or show it; it now holds the record back until its parent is indexed.
- Accept Claude transcript records up to 8 MiB, such as tool results holding images, instead of 1 MiB. Indexing reads up to 16 MiB per batch so the largest record fits, and a page always reads its first record.
- Re-index every Claude transcript once after the upgrade, so sessions the previous version rejected become readable.

## 4.0.1

- Report an interactive Claude session that waits on a question or permission prompt as waiting. Claude Code lists it as `waiting`, which was recorded as an unknown state and reported as a disappearance.
- Never observe an ephemeral Codex session, which Codex doesn't save, such as a helper session Codex starts itself. It no longer appears in session states.

## 4.0.0

- Run Codex sessions on Codex's shared app-server daemon, which also hosts terminal sessions, through `codex app-server proxy`. A keepalive notices a stopped daemon: affected sessions become uncertain, nothing is resent, and the next Codex read reconnects. Extra skill roots now travel with the threads HQ starts instead of changing every session on the daemon.
- Show sessions started in a terminal. Codex sessions on the daemon and Claude sessions from `claude agents --json` report a live state with external ownership, and take input only after they are closed there and adopted. Every state change of a managed or observed session is recorded in order and read with `session-states`; transitions are kept for seven days.
- Capture snapshots while agents keep working, and mark a plan edited during capture so restore withholds its execution authority. Add `packHqSnapshot` and `unpackHqSnapshot` for AES-256-GCM archives of a snapshot, for off-machine copies.
- Keep one storage schema. Its stamp records the package version that wrote it, and any other schema is refused with an error naming that version. Remove the offline storage upgrade, the `upgrade-storage` command and version-1 snapshot support.
- Finalize plans on the milestone IDs jg-breakdown assigns. Completion evidence follows its milestone ID, and evidence whose ID left the sequence is listed as unmatched. Add the `register` plan command so snapshots capture a plan's files. Remove HQ's own milestone matching, the `reconciliation` command and the correspondence contracts.
- Remove host-only contracts: the `priority`, `error-reservation` and `publication-retry` browser commands, the host read models, the `scope`, `repositories` and `errorReservations` plan metadata, plan comparisons and the `parsePlanContract` option. A plan's execution identity is its body, its milestones and its frontmatter extensions. The single Codex quota bucket is named `single`.

## 3.0.0

- Check protocol 0.2 plans with jg-plans 0.3.0 at each stage that grants authority: plan approval requires plan.md to conform, and finalization, sequence approval, authorization and execution require plan.md and milestones.md to conform together. Reading, status and revision workflows are unaffected, and plans without the 0.2 marker keep their current behavior.

- Version HQ storage independently of host user_version. Add explicit offline Node/CLI upgrades with a verified pre-upgrade backup, transactional rollback and uncertainty handling, retaining published 2.0.0 snapshots and version-specific restore fences.

- Expose native Codex credit balances and available earned resets without consuming them. Preserve valid single-bucket quota responses when the multi-bucket view is absent.
- Identify Claude five-hour and seven-day usage meters with explicit model/surface scopes, preserving independent windows, reset times and account-bound freshness. Keep older provider observations compatible.

## 2.0.0

- Add provider-neutral session capabilities, native lifecycle/configuration, file inputs, structured results, permissions, account observations and extension controls. Detect usable native contracts instead of restricting CLI version labels; isolate unavailable providers.
- Add task-scoped agent identities, streams, subscriptions, requests, verified skill grants and bounded report storage/search. Agents can delegate, yield for named children and continue from their exact results across vendors or within one vendor. Replace the fixed-provider handoff API with this flow.
- Support optional verified jg-skills delegation without changing native explicit-only loading, later approval checkpoints or standalone workflows. Keep execution grants, native tool permissions, outcomes and operator approval separate.
- Expose trusted shared SQLite metadata and coordinated host maintenance. Capture WAL data, host tables, reports and registered plan companions; validate offline recovery with the matching private key and paused automation. Hosts own off-machine backup operations.
- Ship the current schema and API directly. Start with a fresh development state root when changing the schema; no data conversion is provided. Add public host examples and packed-consumer coverage for storage and recovery.

## 1.1.0

- Rebuild the homepage around a native-session visual, local setup and three complete source-backed walkthroughs. Show cross-provider reviews and retained revision evidence with explicit host decisions.
- Queue local metadata-lock acquisitions in order, preventing frequent status reads from starving a revision checkpoint. Preserve exact owner checks, wait deadlines and explicit recovery.
- Coordinate journaled private writes with public document locks, explicit keep/write/remove intents and durable completion acknowledgement recovery. Prepare aggregate and milestone progress before native admission; preserve exact replay output and completion evidence.

- Use jg-plans for document observations, guarded edit preparation and explicit milestone identity assignment. Preserve complete shared requirements and JSON-safe contract metadata; report skills binding freshness without blocking the revision approval flow; require current bindings for finalization and execution.
- Keep exact body and requirement bytes in execution digests, with deterministic metadata serialization. Stop regenerating derived Overview tables.
- Add three complete public-client source examples, packed-consumer contract qualification and fixture-backed native flows. Expose the exact pending correspondence proposal ID for explicit client confirmation.

## 1.0.0

- Use `jg-exception` with named string codes for runtime, lock, plan, provider, client and tooling failures. Preserve codes through SQLite-worker responses and publish browser-safe client codes alongside their safe messages. This changes the Node error contract; callers should handle the documented named codes.
- Use the shared Astro UI 0.4.0, `jg-site` metadata helpers and `jg-playwright` browser checks. Remove `error-message-utils` from the runtime and website.
- Redesign the public website around Claude Code and Codex collaboration, a copyable API example, the available runtime capabilities and section navigation for the documentation.

## 0.5.2

- Resume inactive managed Codex sessions retained as loaded by native unsubscribe, preserving explicit handoff and active/uncertain ownership guards.
- Qualify Claude transcript formats 2.1.296 and 2.1.299, preserve in-workspace working-directory changes, and refresh reader projections when their interpretation changes. Keep executable qualification separate and reject workspace/symlink escapes.
- Await native-fixture cleanup after test timeouts and give the full 1,024-milestone revision workflow a focused CI budget. Add a real child-runner timeout/isolation regression.

## 0.5.1

- Qualify Claude Code 2.1.306 history alongside 2.1.304, including transcripts spanning both versions. Continue to reject unqualified CLI and transcript versions.

## 0.5.0

- Add safe publication observations for the host's System view, with separate pending, blocked, failed and uncertain states, timestamps and exact commit identity.
- Bind publication retries to a receipt UUID and nullable expected commit, including failures that happened before a commit existed. The host continues to own scheduling, Git operations and storage.

## 0.4.0

- Add closed browser host commands and bounded session/repository/plan read contracts, without exposing private handlers through standalone IPC.
- Persist operator-bound host action receipts before effects, reject changed replays, retain uncertainty across restart and join exact server-owned native child receipts.
- Add conditional live-window reads so unchanged SSE polling does not repeatedly copy or serialize conversation bodies.

## 0.3.0

- Publish the consumer-tested package through the configured GitHub Actions trusted publisher before deploying the website. Verify release ordering and archive integrity, and safely skip identical published versions.
- Support whole-plan approval, execution, completion and revision when no milestone breakdown is needed. Preserve an absent milestone file and require explicit reconciliation when removing a sequence.
- Keep native thread execution scope on ordinary follow-ups, enforcing revocation and the single implementation owner for whole-plan execution. Preserve explicitly requested, revision-guarded feedback assessment without restoring execution authority. Keep existing-turn permission replies and session renaming separate from new execution admission.

## 0.2.0

- Preserve coordinator-owned, revision-bound plan comparison evidence through plan operations. Expose its bounded count in status without copying review bodies into responses.
- Require the comparison collection in the coordination contract. The private coordinator owns semantic review, relevance selection and execution gates.

## 0.1.0

- Add the shared lock API, owner-aware recovery and built-package verification.
- Add the standalone local controller, owner-only IPC and CLI, worker-owned SQLite discovery metadata, browser-safe contracts, native Codex history and actual subscription observations.
- Add exclusive Codex thread control, receipt-backed actions, live steering, explicit next-turn queues, native permissions/questions, uncertain-delivery reconciliation and bounded reconnect/live-history reads.
- Add native Claude subscription windows and a version-checked incremental history reader, with explicit unknown execution states and unavailable unsupported formats.
- Add persistent Claude session control, native question/permission replies, receipt-backed queued input and interruption, scoped provider failures and shared live presentation. Report unsupported Claude steering explicitly.
- Add short session-name suggestions, atomic creation suffixes and authorized case-insensitive name lookup in the local API and CLI.
- Add native skill catalogs, honest unavailable metadata, exact invocation previews and explicit text/skill input through the existing durable message and queue actions. Add trusted native skill-loading roots without global installation.
- Add execution and inspection digests, initial milestone UUID finalization, separate operator-bound plan/sequence approvals and scoped execution authority, recoverable file writes and bounded SQLite milestone projections.
- Add runtime-owned plan quiescence/checkpoints, operator-confirmed progress reconciliation, retained verification and partial checkout fingerprints, paused scoped input, external-edit interruption and paged revision evidence. Require fresh execution authority after revision or runtime restart.
- Add explicit cross-provider challenges, native finding collection and author feedback with replay-safe delivery and revision/identity guards.
- Add the private public-site workspace, canonical documentation pages, shared JG theme/components, generated social assets and offline build/browser verification. Keep website dependencies and assets outside the runtime package.
