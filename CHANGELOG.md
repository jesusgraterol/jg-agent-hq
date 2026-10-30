# Changelog

## 9.0.0

- Breaking: remove plans, collaboration, agent tools and the agent bridge. HQ no longer registers, locks or snapshots plans, runs collaboration tasks, streams or requests, starts agents from other agents, or gives the sessions it starts tools of its own. The `plan`, `thread-plan`, `collaboration` and `agent-tool` requests, the browser `plan` command and `BrowserThreadDetailSchema.plan`, the plan, collaboration and agent-tool contracts with `PlanActionScopeSchema` and `ActionPlanContextSchema`, `computePlanRevision`, `IPlanContract`, `IProviderAgentTools`, `IAgentToolDefinition`, `IAgentMcpLease`, a provider's `agentTools` and its `agentTools` capability, and the `agent-input` provenance source are gone.
- Breaking: the CLI drops `agent-bridge`, `plan-status`, `plan-milestones`, `--coordination-root` and `--directory`, and `createAgentHq` drops `coordinationRoot`. Snapshots take the HQ lock in the state root and hold no plan files: their header loses `sourceCoordinationRoot`, an inspection loses `planCount`, `diagnosticPlanCount`, `changedPlanCount` and `pendingWriteCount`, and a restore result loses `recoveryRoot`.
- Breaking: remove `JG_AGENT_HQ_COLLABORATION_FORBIDDEN`, `JG_AGENT_HQ_COLLABORATION_CONFLICT`, `JG_AGENT_HQ_PLAN_INVALID` and `JG_AGENT_HQ_PLAN_FAILED`, and the `jg-plans` and `@modelcontextprotocol/server` dependencies.
- Start Claude sessions without `--mcp-config` or a bridge process, and register no dynamic tools with Codex, whose `dynamicToolCall` history items still show. Actions admit and claim queued work directly, without a plan lock.
- Add `action-wait`, which returns a receipt once it has its native thread ID or settles, woken by HQ's own changes rather than polling, or as it stands with `isTimedOut` when its timeout of at most 30 seconds passes. Receipts gain `nativeThreadId`, which action collections leave out.
- `session-states` pages gain `latestSequence`, the highest transition sequence ever issued, and `isReset`, which is true when the cursor is past it or its own transition was pruned.
- Breaking: a provider's skill inventory must carry `invocationPrefix`, and skill pages return it: `/` for Claude and `$` for Codex.
- Add the `locks` read and `jg-agent-hq locks`, which list at most 256 of the machine's jg-locks locks with their holders. HQ only reads them and never takes, waits for or recovers one. jg-agent-hq now depends on `jg-locks`.
- Open no `claude` process for Claude history reads after the runtime's first successful check of the CLI. Keep a Claude usage result for 60 seconds, so frequent usage reads ask Claude at most once a minute; an auth notification, a rate-limit event or a closed connection ends it early.
- Write nothing to SQLite when reading unchanged Claude transcripts. A transcript whose identity, size and modification time match an index that reached its end is skipped without a transaction, a directory scan tracks the transcripts it saw in memory, and indexing prepares its per-record statements once. Native discovery pages are no longer copied into SQLite.
- Leave the Claude history index out of snapshots. The store worker deletes its rows from a full copy and writes the snapshot database from it with `VACUUM INTO`, which keeps every table's rowids. A restored runtime rebuilds the index from the transcripts on its first Claude history read, as a fresh one does.
- Add `journalSizeLimitBytes`, 16 MiB, to `connectionSettings`. HQ's connection applies it as `journal_size_limit`, so the WAL file shrinks back after a checkpoint; apply it to host connections that write.
- Breaking: change the storage schema in place. A database or snapshot written by 8.x is refused with `JG_AGENT_HQ_STORAGE_INVALID` naming the version that wrote it; start from a fresh state root.

## 8.0.2

- Clear a finished command, tool call or file change from the live window once history holds it with the same outcome. Codex shortens long command output when it saves it, so the saved text never matched the live text and the item stayed `awaiting-flush` until the window evicted it. An item without an outcome, such as a message, still needs exactly matching content.
- Keep 7.0.0's storage schema, so databases and snapshots written by 5.x through 8.0.1 open as they are.

## 8.0.1

- Link a Claude message that invokes a skill or slash command to the action that sent it. Claude records the `/name args` it received as command markup, so its hash never matched the action's and a Claude reviewer's review request stayed `unknown`. `nativeInputSha256` now hashes the `/name args` the markup holds.
- Keep 7.0.0's storage schema, so databases and snapshots written by 5.x through 8.0.0 open as they are.

## 8.0.0

- Correlate a message HQ sent with a skill or attached files, or one longer than a page keeps, with the action that sent it. Correlation hashed the message's whole presented text, which for Codex holds a `[skill]` line and its attached files after the text, and for Claude a `[Native document]` or image line, and it skipped a message a page cut, so all of them stayed `unknown`. Provenance now matches the SHA-256 of the text the native input sent, before the parts the same input added and before any cut. A Codex reviewer's review request, which always carries its skill, now reads `agent-input`.
- Breaking: `provenance` gains `nativeInputSha256`, the SHA-256 of the text a user message's native input sent, or null, and a provider's items must carry it beside `nativeInputId`. Content a message holds after its sent text, such as an attached file, is no longer kept `unknown` on that account.
- Keep 7.0.0's storage schema, so databases and snapshots written by 5.x through 7.x open as they are.

## 7.0.0

- Return an item's image only when it is at most 4 MiB, instead of 8 MiB, so one read holds less memory in a host that runs the runtime in its own process. An image over 4 MiB fails with `image-unavailable`. Its base64 now fits in one IPC response, so the CLI reads every image `item-image` returns.
- Keep 6.x's storage schema, so databases and snapshots written by 5.x and 6.x open as they are.

## 6.1.0

- Run HQ's own agent tools in Claude sessions without asking. A permission request for a tool of the session's agent bridge, named `mcp__<bridge server>__<tool>`, is allowed with its input unchanged and records no approval; every other tool still asks.
- Add `item-detail`, which returns one item of a turn with what a developer inspects in it: `command` with its output, exit code and duration, `tool` with its server, name, input and result, `files` with each changed file's diff, and `images`, every image it holds or names. Output and results longer than 65,536 UTF-16 code units keep their last 65,536. A Claude tool result takes its command or tool name from the call it answers.
- Add `item-image`, which returns one of an item's images in base64 when its first bytes are PNG, JPEG, GIF or WebP and it is at most 8 MiB: a Claude `base64` image block, or a Codex image view's or attached image's file, which is refused when it is a symbolic link or not a regular file, or its `data:` URL. No URL is fetched. Anything else fails with the new `image-unavailable` kind, `JG_AGENT_HQ_CLIENT_IMAGE_UNAVAILABLE`.
- Both reads are also CLI commands. A provider's `readHistory` receives them, and an answer of another kind fails the read with `JG_AGENT_HQ_PROVIDER_FAILED`; its other reads are unchanged.
- Keep 6.0.0's storage schema, so databases and snapshots written by 5.x and 6.0.0 open as they are.

## 6.0.0

- List `threads` by last activity, newest first, for Claude and Codex, with cursors that continue in that order; they were listed by creation time.
- Add `unstarted-threads`, which returns a workspace's managed sessions that `thread-create` made empty and no turn has started, at most 32 and newest first. `thread` and `items` answer for them from their HQ records, so a new session opens before its provider writes any history.
- Read session states that were already live when the runtime connects. Each Codex connection reads the daemon's loaded threads, leaving out ephemeral ones, so a session already running shows as running. Claude states come from the fields `claude agents --json` reports: an entry without a `pid` isn't running, `status: "waiting"` is waiting, `status: "idle"` is idle and `state: "working"` is running, and the processes the runtime started are left out.
- Name the terminal that runs a Claude session. Thread summaries gain `terminal`: `interactive`, `background` with the `attachId` that `claude attach` takes, or null, and a provider's summaries must carry it. While a terminal runs a Claude session, HQ refuses to adopt or resume it or send it input.
- Adopt a Codex session a terminal holds between turns, resuming it without settings overrides; adoption during a turn is refused. A session HQ closed is observed again like any other, and HQ resumes it when the terminal still has it loaded. A collaboration request to a Codex session HQ adopted is refused, since its agent tools never join it.
- Give history and live items `createdAt`, in Unix milliseconds or null, and a provider's items must carry it. A Claude item takes its record's time, and a live one the time its frame arrived. A Codex item takes its turn's times: an operator message the turn's start, every other item its end, or its start while the turn runs. A Codex history page reads its items' turns newest first, 128 at a time and at most 8 times.
- Keep 5.x's storage schema, so databases and snapshots written by 5.x open as they are.

## 5.0.1

- Index Claude transcripts with less memory. Each record is read once, instead of being copied again for every 64 KiB chunk it spans, and the SQLite worker's young generation is capped at 16 MiB. Indexing a 224 MB transcript held the runtime at about 200 MB instead of about 300 MB. The storage schema is unchanged, so databases and snapshots written by 5.0.0 open as they are.

## 5.0.0

- Read `items` newest first, its only order, with its cursor continuing toward older items; it read oldest first before. `textLimit`, from 1 to 65,536 and 65,536 by default, cuts each item's text on a code-point boundary and marks it `isTruncated`. `nativeItemId` with its `turnId` returns that item alone; Codex finds it by reading that turn's items 128 at a time.
- Present history, live items and `session-evidence` as each CLI shows them, from one mapping per provider. History items gain `callId`, which pairs a tool call with its result, `outcome` and `files`, and the kinds gain `notice`; a provider's items must carry the new fields. Claude leaves out thinking and task notifications, and shows compaction summaries, local command output and interruption markers as notices, slash commands as `/name args`, `!` shell input and output as paired commands, Edit and Write results as file changes with their line counts, and results saved to a file as their size and preview. Codex leaves out reasoning, so a page can hold fewer items than its limit, and shows compaction as a notice and web searches and image views as tools. Outcome and files come from the full record before the text is cut.
- Start a Claude turn only at a message the operator sends, including a slash command; task notifications, compaction summaries, local command output and `!` shell records belong to the turn before them. The Claude index stores each entry's presented kind and visibility, so `session-evidence` kind filters match what `items` shows.
- Stop a managed Claude Code process whose session has been idle for 60 minutes, keeping the session idle with no state transition. Its skills, configuration and interrupt calls answer from what it kept, and input, renames, extension control and MCP reads reopen it with `--resume`, its settings and a new agent bridge. The session-less Claude read process closes after 5 minutes without a read.
- Add `active-sessions`, which returns every running and waiting session, managed and observed, with its workspace, at most 128 and newest state change first, and `observation-pace`, which polls Claude's active sessions every 5 seconds at `live` and every 30 at `background`. The runtime starts at `background`; it polled every 5 seconds before. Providers may implement `readObservedThread` so their observed sessions are listed. Both are also CLI commands.
- Change the storage schema in place. A database or snapshot written by 4.x is refused with `JG_AGENT_HQ_STORAGE_INVALID` naming the version that wrote it; start from a fresh state root.

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
