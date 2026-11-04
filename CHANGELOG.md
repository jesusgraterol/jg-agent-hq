# Changelog

## 12.0.0

To upgrade from 11.x:

- Start from a fresh state root. Startup refuses an 11.x database, and restore, packing and unpacking refuse an 11.x snapshot, with `JG_AGENT_HQ_STORAGE_INVALID`; jg-agent-hq never migrates storage.
- List sessions with `threads`, which now takes `workspaceRoots` and replaces `sessions`, `unstarted-threads` and the one-folder `threads` request.
- Capture with the runtime's `createSnapshot(destination)` instead of `createHqSnapshot`, and take locks of your own with [jg-locks](https://jg-packages.jesusgraterol.dev/packages/jg-locks/) instead of the removed lock exports.
- Run clients and the runtime on the same major version: the IPC envelope changed, and 11.x cursors are refused. Remove uses of the other exports, reads, actions and fields listed under Removed.

### Removed

- Third-party providers: the `providerFactories` option and the adapter types `IAgentProvider`, `IAgentProviderFactory`, `IAgentProviderContext`, `IAgentProviderEvents`, `IAgentProviderOutcome`, `INativePrompt`, `IProviderCall`, `IProviderThread`, `IProviderInspection`, `IProviderReattachment`, `IResyncLoss`, `IProviderSkills`, `IProviderMcpServerPage`, `IProviderMcpTools`, `IProviderMcpResources` and `IProviderInputFile`. A provider ID is now exactly `claude` or `codex`, `ProviderIdSchema` is an enum and `MAX_PROVIDERS` is gone. The provider registry no longer parses the built-in adapters' output or streamed events a second time.
- Accounts: the `account` and `login` reads, the `account-login`, `account-login-cancel` and `account-logout` actions, the `account` CLI command, the capabilities `account`, `accountLogin`, `accountLoginCancel` and `accountLogout`, and the contracts `AccountRequestSchema`, `AccountObservationSchema`, `AccountControlCommandSchema`, `LoginRequestSchema`, `LoginObservationSchema` and `NativeControlResultSchema`.
- Extensions: the `mcp-servers`, `mcp-tools` and `mcp-resources` reads and CLI commands, the `mcp-reload`, `mcp-reconnect`, `mcp-set-enabled`, `mcp-login`, `plugins-reload` and `skills-reload` actions, the capabilities `mcpServers`, `mcpTools`, `mcpResources`, `mcpReload`, `mcpReconnect`, `mcpSetEnabled`, `mcpLogin`, `pluginsReload` and `skillsReload`, and the contracts `ExtensionControlCommandSchema`, `McpRequestSchema`, `McpServerSchema`, `McpToolSchema`, `McpResourceSchema`, `McpServerPageSchema`, `McpToolPageSchema`, `McpResourcePageSchema`, `MAX_MCP_ITEMS` and `MAX_MCP_CATALOG_BYTES`. Native MCP elicitation replies remain.
- Thread controls: the `thread-fork`, `thread-compact`, `thread-revert`, `thread-archive` and `thread-unarchive` actions, the capabilities `fork`, `compact`, `revert`, `archive` and `unarchive`, and the managed thread fields `forkedFromThreadId` and `isArchived`.
- Reads: `events` with `LifecycleEventSchema`, `provider-actions`, `turns` with `TurnSummarySchema`, `managed-thread-name`, `skill-preview` with `SkillPreviewSchema`, `sessions` with `SessionDiscoveryRequestSchema`, and `unstarted-threads` with `UnstartedThreadsSchema` and `IUnstartedThreads`. The CLI drops the `turns`, `sessions`, `unstarted-threads`, `managed-thread-name` and `skill-preview` commands and the `--name`, `--server-name`, `--skill-id` and `--arguments` flags. A skill input still resolves its exact invocation before it is sent.
- The one-folder `threads` request: its `provider` and `workspaceRoot` fields, the result's `source` field and the CLI's `codex` default. `threads` is now the discovery read described under Changed.
- `inspectHqSnapshot` and `createHqSnapshot(hq, destination)`. Capture is the runtime's `createSnapshot(destination)` method, and capture, `packHqSnapshot`, `unpackHqSnapshot` and `restoreHqSnapshot` still inspect the complete snapshot.
- The state-root lock exports `acquireHqLock`, `withHqLock`, `readHqLockState`, `releaseHqLock`, `getOwnerLiveness`, `RUNTIME_DIRECTORY`, `HQ_LOCK_FILE`, `IHqLockOwner`, `IOwnerLiveness`, `IHqLockOptions` and `IHqLockState`, with the `hq.lock` file they kept in the state root's `.runtime` folder and the runtime owner record `hq-owner.json`. The runtime's own locks are described under Changed.
- The error codes `JG_AGENT_HQ_LOCK_INVALID_ARGUMENTS`, `JG_AGENT_HQ_LOCK_UNSUPPORTED_PLATFORM`, `JG_AGENT_HQ_LOCK_FILE_INVALID`, `JG_AGENT_HQ_LOCK_FILE_PERMISSIONS`, `JG_AGENT_HQ_LOCK_OWNER_OVERSIZED`, `JG_AGENT_HQ_LOCK_OWNER_UNREADABLE`, `JG_AGENT_HQ_LOCK_OWNER_INCOMPLETE`, `JG_AGENT_HQ_LOCK_OWNER_INACTIVE`, `JG_AGENT_HQ_LOCK_OWNER_UNVERIFIABLE`, `JG_AGENT_HQ_LOCK_TIMEOUT`, `JG_AGENT_HQ_LOCK_OWNERSHIP_CHANGED`, `JG_AGENT_HQ_LOCK_NOT_HELD`, `JG_AGENT_HQ_LOCK_NONCE_MISMATCH`, `JG_AGENT_HQ_RUNTIME_DIRECTORY_INVALID` and `JG_AGENT_HQ_RUNTIME_DIRECTORY_PERMISSIONS`. A state root that can't be created as a private directory now fails with `JG_AGENT_HQ_STATE_DIRECTORY_UNSAFE`.
- The provider-wide admission fence, which held new execution while an account change or a Codex MCP reload was pending, and the receipt field `controlState`.
- The receipt and action summary field `nativeRequestId`. `phase` names the native step an action takes; the request ID the runtime sends the native CLI stays internal.
- The IPC envelope's `schemaVersion`: requests carry `id`, `runtimeEpoch` and `command`, and responses `id`, `success` and their `response` or `error`. The CLI's JSON output keeps its `schemaVersion: 1`.
- The `version` field of cursors. Cursors stay opaque, and every cursor an earlier version issued is refused with `JG_AGENT_HQ_CURSOR_INVALID`.
- Storage: the 11.x columns `hq_thread.fork_source_thread_id` and `hq_thread.is_archived`, `hq_action.control_state`, and the `hq_event` columns `thread_id`, `action_id`, `native_turn_id`, `native_item_id`, `kind` and `created_at`, which kept the lifecycle replay, and the indexes `hq_idx_a__provider_created_at_id_desc`, `hq_idx_a__provider_epoch_pending_control`, `hq_idx_e__thread_id_sequence` and `hq_idx_ce__workspace_native_turn_start_current`. The event table keeps only what recognizes a repeated native observation.

### Changed

- `threads` is the discovery read: `{ kind: 'threads', workspaceRoots, providers?, search?, excludeContinued?, limit?, cursor? }` lists 1 to 64 folders' sessions of both providers, or the ones `providers` names, with the managed sessions the runtime created that no turn has started, by last activity, then provider, then native ID, each descending. A page returns `{ data, nextCursor, unavailable }`: `search` and `excludeContinued`, which leaves out sessions whose `continuedIn` names another, apply before the page is counted, `nextCursor` is null once no session is left, and a folder and provider that can't be read are left out of the page and named in `unavailable` instead of failing it. The cursor carries each source's native continuation, so a deep page re-reads at most one native page of each source instead of every page before it. The CLI's `threads` takes repeated `--workspace-root` and `--provider`, `--search`, `--exclude-continued`, `--limit` and `--cursor`, and lists both providers unless `--provider` names one. See [session discovery](api/README.md#session-discovery).
- `thread` returns the summary of a session whose history its provider can't read, with `historyState: 'unavailable'`, instead of failing: from a Claude transcript with unsupported records, or else from the runtime's managed record or `active-sessions` entry for the session in that folder. A session the runtime doesn't know still fails as its provider did. Adopting or resuming a Claude session whose transcript has unsupported records now conflicts with `JG_AGENT_HQ_ACTION_CONFLICT` instead of failing with `JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE`.
- The runtime connects both CLIs as it starts, in the background: it connects to Codex's daemon, which starts observing its sessions, and brings Claude's history index up to date for the allowed roots and the folders it already holds. A missing CLI no longer waits for its first request to report `unavailable`, and `status` reports a Claude read process that is still starting as `idle` instead of `unavailable`.
- The runtime takes its locks through jg-locks under `<stateRoot>/.runtime/locks`: it holds the `runtime` lock for its lifetime, whose owner nonce is the runtime epoch, and capture holds the `snapshot` lock. A runtime that stopped without releasing the state root is taken over with jg-locks' `recoverFrom` only when its process is gone and the host's `isPreviousRuntimeStopped` resolves true, which now receives the `runtime` lock owner's process ID and start time; a `snapshot` lock the same process left is recovered with it. Any other dead holder stays until it is recovered with jg-locks. `createAgentHq` passes jg-locks' and jg-fs' errors for an unusable locks folder through unchanged, as the error reference lists them.
- Live items stay in the runtime's memory: an item's start or finish no longer goes to the store worker, writes an event row or counts toward a provider's lifecycle queue of 128. The event table keeps only the current runtime's lifecycle observations, by which a repeated one is recognized, and startup deletes the rows earlier runtimes left.
- Admitting a `steer` checks the provider's operation support against its fixed support instead of asking the native CLI, which listed models and, for Claude, started its read process. The `capabilities` read still asks the CLI for the model catalog and a Claude session's skills.
- One store worker call indexes at most 8 MiB of new Claude transcript bytes, down from 64 MiB, so it stays well under a second at the slowest measured indexing rate; `docs/architecture.md` records the measurement. A call's first record is still read whole, up to 32 MiB, and a history read continues across calls as before.
- `active-sessions` reads nothing from Codex. An observed Codex session's record keeps the workspace, name and creation time the runtime's first read of it found, and its summary comes from that record: `updatedAt` is its state's change time, `nativeState` is `unknown` and its `nativeLineage` fields are null, and a rename in another client doesn't show.
- The runtime's tables, indexes, unique indexes and named constraints use the `agent_hq_` prefix instead of `hq_`, such as `agent_hq_action`, `agent_hq_idx_a__native_turn_id` and the stamp table `agent_hq_schema`, and `IStorageDescriptor.reservedPrefix` is `agent_hq_`: a host keeps its own tables outside that prefix.
- Storage tables: `agent_hq_action` records an action's native step in a `phase` column, checked against the action phases, instead of a suffix of its `native_request_id` column, which is gone with its unique index, and keeps a create's first input as its `queued_input`; an action's ID, its primary key, keeps each native request unique. `agent_hq_browser_action` keeps a receipt's state, runtime epoch, kind, native action ID and timestamps in columns instead of a JSON `receipt` column, with a unique native action ID; browser receipts are unchanged. `agent_hq_session_transition` gains `workspace_root`, and `agent_hq_observed_session` gains `workspace_root`, `name` and `created_at`. The index `hq_idx_t__runtime_epoch_ownership` becomes `agent_hq_idx_t__runtime_epoch_ownership_bound`, a partial index of the threads a runtime binds, which the managed half of `active-sessions` and the startup quarantine use instead of scanning `agent_hq_thread`.
- The schema stamp changes with these tables. Startup refuses 11.x storage, whose stamp is in `hq_schema`, with `JG_AGENT_HQ_STORAGE_INVALID` as missing an `agent_hq_schema` stamp; a stamp from 12.0.0 on records the version that wrote it, which the error then names. jg-agent-hq never migrates storage.
- The refusals sent to Claude name the library: a control request the runtime can't present is answered with `jg-agent-hq couldn't present this request`, and a permission it can't answer is denied with `jg-agent-hq cannot answer this request`.
- Dependencies use caret ranges, so a consumer's package manager can share one copy of each: `jg-crypto` `^0.3.0`, `jg-exception` `^1.7.1`, `jg-fs` `^1.7.0`, `jg-locks` `^1.0.0`, `jg-utilities` `^1.8.0` and `zod` `^4.6.7`.

### Added

- Receipts and action summaries carry `phase`, the native step the action takes now: `create`, `resume`, `name`, `turn`, `steer`, `interrupt`, `clean`, `close`, `delete` or `reply`, or null for an action that sends nothing native. `ACTION_PHASES` and `IActionPhase` in `jg-agent-hq/contracts` list them.
- `thread-create` takes an optional `input`, the session's first message, which the same action sends in its `turn` phase once the session is named; `thread-close` takes `interrupt: true`, which interrupts a running turn and closes once it ends, in one action.
- `thread-delete`, `{ provider, workspaceRoot, nativeId }`, deletes a session no process runs from its CLI's storage, through Codex's daemon or Claude's project directory, with the runtime's records of it, closing a session the runtime runs first, within its request. It refuses a session a process may run with `JG_AGENT_HQ_REQUEST_INVALID`, a folder outside the allowed roots with `JG_AGENT_HQ_TARGET_FORBIDDEN`, and reports a deletion that fails with `JG_AGENT_HQ_PROVIDER_FAILED`. See [thread deletion](api/README.md#thread-deletion).
- Long-polls: `session-states` and `live-items` take `waitMs`, at most 30,000, and wait for the next transition after `afterSequence`, or the window's next change after `afterRevision`, instead of answering with none; when the time passes they answer with an empty page, or `unchanged`. The runtime's own changes wake them, never a timer, at most 32 wait at once, another conflicting with `JG_AGENT_HQ_ACTION_CONFLICT`, and closing the runtime ends them with `JG_AGENT_HQ_RUNTIME_NOT_RUNNING`. The CLI's `session-states` takes `--wait-ms`. See [long-polls](api/README.md#long-polls).
- Each session transition carries `workspaceRoot`, the session's folder as the runtime knew it then, or null.
- `live-items` and `actions` take `textLimit`, from 1 to 65,536, which cuts item text and queued text as `items` cuts history; each action on an `actions` page carries `queuedText`, the text of its undelivered queued input, or null.
- `request` and `requestAgentHq` resolve to the response of their command's kind, `IHqResponseOf<kind>` in `jg-agent-hq/contracts`, without a cast.
- `getErrorKind(error)`; `openHostDatabase(storage)`, which opens a host connection with the required settings and refuses its writes to the runtime's tables; and the runtime's `runtimeEpoch` property and `createSnapshot(destination)` method.
- `ThreadsPageSchema`, `IThreadsPage`, `MAX_WORKSPACE_ROOTS` (64), `MAX_ACTION_BYTES` (32,768) and `MAX_WAIT_MS` (30,000) in `jg-agent-hq/contracts`.

### Fixed

- A first page of a Claude folder could continue a directory scan an earlier read had left open and miss the transcripts created since, which the start-time indexing made likely; a scan now starts over once the folder's transcripts were added or removed since it opened.
- Closing the runtime no longer waits, up to its 30-second deadline, for Claude's session-less read process to answer an initialization it never answers: closing stops it at once.
- A turn that streamed more than 128 live items faster than they were stored could overflow its provider's lifecycle queue, making that provider's sessions uncertain. Items no longer enter the queue.
- A Claude history read of a large transcript of short messages could hold the store worker for several seconds in one call, near the 5-second store request deadline. Each call now indexes one budgeted piece.
- An indexing batch that ended between a hidden Claude record and the parent written after it indexed the hidden record as a turn of its own, which split the records that follow it into another turn. Such a batch now leaves the hidden record to the next batch.
- Action admission records only a coded failure of a known kind as a failed action. Any other error during admission, such as a SQLite failure, rolls the admission back without recording the action and propagates as `JG_AGENT_HQ_STORE_FAILED`, its message carrying the cause, instead of recording an `operation-failed` action.

## 11.1.1

- Report the argument hint of every listed Codex skill whose `SKILL.md` declares a single-line `argument-hint`, whatever form its other frontmatter fields take. 11.1.0 read a listed skill's hint only when its `name` and `description` were single lines too, so a skill whose description is a YAML block, such as `description: >-`, showed no hint. A skill in the operator's extra roots still needs single-line `name` and `description` fields, which are its identity there.
- Store nothing new: the schema and existing databases are unchanged.

## 11.1.0

- Report each Codex skill's `argumentHint` from the `argument-hint` its `SKILL.md` declares. Codex's native skill list carries no hints, so a catalog read now reads the single-line frontmatter of the file at each listed skill's path, 8 files at a time, and of each skill in the operator's extra roots: a regular file of at most 65,536 bytes, without following a link at that path. A hint that is missing, empty, a block scalar or over 1,024 characters stays null, and a file that can't be read leaves only the hint null, without counting toward `unavailableCount`. Session and folder catalogs give a skill the same hint.
- Store nothing new: the schema and existing databases are unchanged.

## 11.0.1

- Credit an explicit skill the operator sends from a browser to the operator. A browser submission recorded a fingerprint only for text, so a skill's message linked to its action as a programmatic `host-action` with an unknown origin, and a client showed the operator's own skill as sent by its host. The skill's prepared invocation, the `$name args` or `/name args` the session received, now becomes the submission's fingerprint once its action is admitted, so the message reads back as `authenticated-host-action` from the operator. Skills sent before this version keep their recorded provenance.

## 11.0.0

- Read the skill catalog of a folder without a session. `skills` now takes `provider` and `workspaceRoot`, with `threadId` optional: with it, the request reads that controlled session's catalog as before, and refuses a session of another provider or folder with JG_AGENT_HQ_REQUEST_INVALID; without it, the request reads the catalog a session started in the folder would have. Codex lists the folder, and Claude reads the initialization command list of a session-less read process started there, without a user prompt or model turn. A skill has the same ID in both catalogs, so a folder's catalog can pick a skill for a session's first input.
- Breaking: a `skills` request must name `provider` and `workspaceRoot`; one with only `threadId` is invalid. The CLI's `skills` takes `--workspace-root`, with `--provider` defaulting to `codex` and `--thread-id` optional.
- Breaking: `IAgentProvider.readSkills` takes `(workspaceRoot, nativeId, call)`, with `nativeId` undefined for a folder's inventory, in the order `readConfiguration` uses.
- Start every folder-scoped Claude read process, configuration reads included, with the trusted additional directories sessions get, so a folder read sees the commands a session there sees.
- Store nothing new: the schema and existing databases are unchanged.

## 10.9.3

- Clear a finished turn's saved items from the live window without waiting on a client's history read. A saved item used to stay `awaiting-flush` until some `items` read happened to cover it, so a session nobody read while it worked kept its items, and a client that read only its newest pages later showed them after the newest items. When a turn ends, the runtime now reads that turn's history itself, newest first and at most 8 pages of 128, until none of its finished items remain, and once more 2 seconds later when some do, since Codex's saved state can trail its turn's end. A failed read leaves them to the next history read, as before.

## 10.9.2

- Read a Claude transcript whose compaction names a record the transcript doesn't hold before the boundary. Such a transcript was refused whole, its history unavailable and its `thread` read failing: a chat Claude Code moved into a new session, whose boundary names the old session's record, and a transcript whose boundary named a record written after it. The chain now starts at that boundary. Every Claude history is indexed again once, so the transcripts refused before are read.

## 10.9.1

- Forget a terminal Claude session's background-command count when a `thread` read of it finishes after the `claude agents --json` poll stopped listing it. The read used to leave the session's transcript scan in memory, where nothing removed it.

## 10.9.0

- Report on every session summary how many background commands the session runs, as `backgroundCommands`. A session HQ runs reports the count Claude last reported. A Claude session a terminal runs reports the commands and agents its transcript records as started since its Claude process started and not yet ended. The `claude agents --json` poll counts before it records states, within one 67,108,864-byte read budget per run, and a `thread` read reads the transcript again first. Codex sessions report 0.
- List idle sessions that run background commands in `active-sessions`, beside the running and waiting ones.
- Report on a Claude session's summary the session its chat continues in, as `continuedIn`, when Claude Code moved the chat into a new session and left a `continued-in` record at the old transcript's end with no message after it. Other summaries carry null.
- Store nothing new: the counts and answers are kept in memory, so the schema and existing databases are unchanged.

## 10.8.0

- Report how many commands a session runs in the background. The `live-items` window carries `backgroundCommands`, the count Claude last reported for a session HQ controls, 0 once its process stopped or when its provider reports none, and a change of it is a new revision, so a client that follows the window sees a command keep running after the turn that started it ended, until Claude resumes the session. Providers report it through a new `background` event.

## 10.7.0

- Accept up to 16,777,216 bytes of files per input, each text file up to 262,144 bytes, up from 2,097,152 and 65,536. `capabilities.inputSchema` reports the new `maxFileBytes` and `maxTextFileBytes`.
- Carry native and IPC frames and Claude transcript records of up to 33,554,432 bytes, up from 8,388,608, so a Claude session whose transcript holds a large message, such as one with attached files, keeps its history. Claude indexing reads up to 64 MiB per batch. Every Claude history is indexed again once.
- Send a Codex message over 1,048,576 bytes as masked fragments of at most that size, so a large message never meets a WebSocket server's per-frame limit.

## 10.6.0

- Steer a Claude session's active turn. Claude reports `steer` as supported and writes the text as a user message into the exact active turn, without interrupting it, and acknowledges the steer when Claude replays the message: at the turn's next tool boundary, where the turn takes it in and ends with one result, or, for text written while the turn's final answer streams, after the turn's result, where it runs as the session's next turn under the message's UUID. Either replay acknowledges the steer against the turn it named. A steer never replayed fails 30 seconds after that turn ends, and one pending when the process stops fails at once. Claude used to reject `steer` as unavailable.

## 10.5.4

- Keep a Claude response's parallel tool calls in its history when their results finish out of order. Claude Code links each result to its own call, so a result that came back after a later call's result started a side branch, and history left out the later calls and results: they stayed `awaiting-flush` after the session's answer, and an open page's cursor was rejected as changed. Such a result now follows the latest record of its turn. Every Claude history is indexed again once.

## 10.5.3

- Leave a Claude subagent's stream frames, which name the Agent call that started it, out of a session's live items and turns. History leaves the subagent's sidechain out, so its prompt, tool calls and results stayed `awaiting-flush` after the session's answer, its prompt read as the operator's message, and a background subagent's frames after the session's turn started a turn of Claude's own that never ended, which held the next message as starting. A subagent's tool results still settle the approvals it asked for.

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
