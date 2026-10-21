# Changelog

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
