# Changelog

## 10.5.2

- Show a Claude tool result made of content blocks, such as a browser tool's caption and screenshot, as its text, with each image as `[Image]`. Such results used to read `[Native tool_result]`.

## 10.5.1

- Read a compacted Claude session to the start of its conversation. A compaction starts a new chain whose boundary has no parent and names the record before it as its logical parent, and history used to stop there. Every indexed transcript is indexed again after the upgrade.
- Drop a live item that was still streaming when its turn ended, such as a message a Codex steer or an interrupt cut, once a native history page holds an item of that turn. Codex never saves a message a steer cut, so it stayed `awaiting-flush` until the window evicted it.

## 10.5.0

- Add per-session fast mode: `fast` in session and turn settings, `effective.fast` and `effective.fastUnavailableReason` in `configuration`, and `supportsFast` in `models`. Codex sends it as the `priority` service tier, or `default` to turn it off, and reads it back from the session's start, resume and settings updates. Claude sends `fastMode` as a flag setting at startup and before input, keeps it when a parked session reopens, and reads it back from `fast_mode_state`, with the reason Claude gives when fast mode can't serve the session.
- Read a Claude session that worked in another folder for part of its life, such as a task worktree it moved into and back out of. A transcript belongs to a workspace once one of its records ran there, and its records from other folders are listed and read with the rest. One record outside the workspace used to make the whole history unavailable for good. A record with another session's ID, or a folder with an excluded segment, still makes it unavailable, and a transcript with no record inside the workspace stays out until one is written. Every indexed transcript is indexed again after the upgrade.

## 10.4.1

- Keep the Codex provider working when a turn's end arrives twice: once read back from Codex after a lost or skipped message, and once as the turn's own `turn/completed`. In either order, the first recorded stands and the other only fills in a result the first lacked. The two used to differ when the notification carried the turn's result, which failed every managed Codex session.
- Keep HQ's own Codex turn going when its `turn/started` fails validation while the input that started it is still in flight. The session is watched instead of marked uncertain, and the turn keeps its result.
- Keep a Codex session's next turn that HQ didn't prepare, such as a compaction, working after a turn's end failed validation. An earlier turn's end no longer drops the result capture of the turn HQ prepared next.
- Read a Codex session whose status is newer than HQ knows as `nativeState: 'unknown'` in lists, reads, resumes and rejoins, instead of failing them. `IProviderThread`'s `nativeState` gains `unknown`.
- Keep a Claude session's process when Claude starts a turn of its own, or a call or background command begins, while HQ parks the session.
- Leave a state-root lock in place when it changes or can't be removed while startup reclaims it, instead of failing startup with an uncoded error.

## 10.4.0

- Accept Claude permission requests that carry fields HQ doesn't list. Claude adds fields between releases, such as `decision_reason_code` and `tool_kind`, and HQ refused every such request before the operator saw it. Known fields keep their validation, the rest are dropped, and the reply still holds only the displayed input.
- Refuse a Claude control request HQ still can't present with the error `HQ couldn't present this request`, which Claude records as the tool call's failed result, instead of `Unsupported request`.
- Report a Claude session's `systemInstructions` and `developerInstructions` as null when its process resumed the conversation, since Claude keeps the instructions it recorded when the conversation began.
- Keep a Claude session available when Claude starts a turn of its own, as it does after a background command finishes. That turn's first frame used to fail the session and end its process group. HQ now records the turn under an ID it generates: the thread reports running, its items stream as live items, its permission prompts can be answered, Stop interrupts it, and its result completes it. Input written just before such a turn waits for Claude's replay after it, and keeps its own turn and result.
- Keep a Claude session's process while a background command it started is still running, instead of parking the session after its idle hour, which ended the command.
- Record a turn's or a compaction's acknowledgement after the lifecycle events its provider reported before it, so a turn the agent started and finished meanwhile can't be taken for it.
- Leave approval requests on a Codex session another client drives for that client to answer. The shared daemon sends a session's requests to every connection that joined it, and HQ declined them at once, which declined the terminal user's approval. HQ now neither answers nor records them.
- Add `unpresentable(nativeId, reject)` to `IAgentProviderEvents`, for a request an adapter can't present. HQ refuses it only on a session it controls.
- Keep the Codex connection every managed Codex session shares open when a notification fails validation. A notification about items, text deltas, token usage or a session's status is dropped, with a gap in a managed session's live window, and a status newer than HQ knows makes the session `unknown`. A lost turn start, turn end or approval resolution makes HQ read the session from the daemon instead: a finished turn completes, a running turn whose start was lost continues, an ambiguous turn is read once more 2 seconds later, an unchanged idle session is left alone, and anything else marks the session uncertain.
- Add `resync(nativeId, lost)` to `IAgentProviderEvents`, `IResyncLoss`, and the optional `isInferred` on `IProviderReattachment`'s latest turn, which the built-in Codex adapter sets when the saved turn is still in progress.
- Skip a Codex message over the 8 MiB frame limit, through its final fragment, instead of failing the shared connection. Every managed Codex session is then read from the daemon: an idle, unchanged session is left alone, and a running one continues, watched until Codex reports it idle, when it is read as if its turn's end had been lost. A request whose response was skipped fails at its 30-second deadline.
- Add the optional `isPreviousRuntimeStopped` to `createAgentHq`, which lets startup recover a state root a runtime left after an unclean exit. When the recorded owner's process no longer exists and the host's check resolves true, startup replaces the owner record, removes a state-root lock whose holder is gone and a leftover `hq.sock`, and starts. The host guarantees that at most one caller reclaims a state root at a time. Add `IPreviousRuntimeCheck` and `IPreviousRuntimeOwner`.

## 10.3.0

- Keep Codex sessions running when the runtime stops. Shutdown no longer interrupts their turns, cleans their background terminals or declines a request still waiting on an answer, and leaves their records bound to the stopped runtime. At startup, the next runtime rejoins each one that had no action in flight: it reads the session's state and latest turn from Codex's daemon, records the turn still running or completes the one that finished meanwhile, delivers the queued input waiting on it, and joins with `thread/resume` without settings, which makes the daemon send a still-waiting request again. A session another client moved past HQ's last turn, or one HQ can't read or join, is marked uncertain instead. Claude sessions still stop with the runtime.
- Add the optional `readReattachment` and `reattachThread` to `IAgentProvider`, and `IProviderReattachment`, which the built-in Codex adapter implements. Registered provider factories don't keep sessions across restarts, so the runtime never calls them on theirs.

## 10.2.0

- `thread-adopt` accepts optional `settings`, as `thread-resume` does, and applies them to the resume it runs, so a host can adopt a session in a chosen permission mode. Codex refuses them for a thread another client still holds, as it does on resume.
- Leave the text Claude adds to a turn itself, such as a loaded skill's, out of live items. Claude streams it as a user message marked `isSynthetic`, so a host showed it as the operator's message while the turn ran, although history, which skips the transcript's matching `isMeta` records, never lists it.

## 10.1.0

- Add `codexDaemonLauncher` to `createAgentHq`: a command and its arguments that run `codex app-server daemon start`, such as `systemd-run --user --scope`. On Linux, Codex's shared daemon stays in the cgroup of whatever started it, so a host running as a systemd service that started it took it down, with the work of every terminal session on it, whenever the service stopped. Without the option, the start runs directly as before.

## 10.0.0

- List Claude threads from an index in last-activity order, replacing the unused index in creation order, so a page no longer sorts every transcript of the workspace, and a continuation seeks into that index instead of scanning the pages before it. Active-session reads find an observed Claude session's transcript through an index on its native ID instead of scanning every indexed transcript.
- Document `JG_AGENT_HQ_TRANSPORT_FAILED` on `request`, which a Claude history read rejects with when it can't start Claude's CLI.
- Breaking: change the storage schema in place. A database or snapshot written by 9.x is refused with `JG_AGENT_HQ_STORAGE_INVALID` naming the version that wrote it; start from a fresh state root.

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
