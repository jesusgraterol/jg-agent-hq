# Testing

Package tests consume built public exports. Run `pnpm build` before focused tests; `pnpm check:package` builds once, runs the unit and integration categories, typechecks, and checks formatting. `pnpm test:unit` and `pnpm test:integration` keep their complete categories. The website has its own README and verification boundary.

## Essential and full selections

Essential protects consequential guarantees, including expensive ones. All unassessed cases remain selected until their family is reviewed. Granular and focused commands stay complete by default; native `full` tags exclude secondary coverage only when an essential filter is explicitly applied.

| Assessed boundary                              | Essential guarantee                                                                                                                                                                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actions                                        | Exact action/request correlation, admission deduplication, permission scope, private prompt data, no replay, and required recovery. Real 30-second late acknowledgements stay essential.                                                 |
| Runtime, browser-host admission, and contracts | Private IPC/process ownership, SQLite integrity, schema/key preservation, operator isolation, drain-before-shutdown, exact credits, bounded observations, and account-specific freshness. Browser-host tests protect backend authority.  |
| Claude/Codex control and provider registry     | External-session ownership, native lifecycle confirmation, fail-closed capabilities, cross-session/provider isolation, raw-frame bounds, websocket protocol/keepalive, confirmed child-process teardown, and native pagination ordering. |
| Inputs and results                             | Authorized regular files, traversal/link/content-hash refusal, queued delivery integrity, complete bounded results, output-schema validation, and worst-case admitted frame sizes.                                                       |
| Action waits and live state                    | Notification/read races, bounded revision/gap state, completion/flush reconciliation, and shutdown cancellation.                                                                                                                         |

The remaining native families stay essential: Claude history qualification and exact session evidence protect ownership, private diagnostics, revision-bound pagination, and complete Unicode-safe results; configuration/models/skills protect allowed native capabilities and process bounds; locks protect exclusive ownership and explicit recovery; storage, transition retention, snapshots and encrypted archives protect durable state, host schema ownership, integrity and no replay. CLI tests exercise the same authority and recovery boundaries through the installed command. Package/release tests protect the actual public consumer and exact-archive publication guards. Large history cases remain essential because they uniquely establish bounded reads and stable continuation under concurrent inserts.

Item timestamp regressions retain exact per-item milliseconds across live notifications, paged history and item details, reject malformed native times, and prevent turn-time substitution and extra turn-history requests. These runtime paths remain essential; the isolated timestamp projection permutations and extra read-only history kind/text examples remain full-only. Those projected fields do not drive admission, permission decisions, receipt deadlines, or cursor identity. The native thread-list sort-parameter check stays essential because it verifies the requested ordering for native pagination. Reasoning omission, bounded output, full file-change evidence, state/outcome mapping, and capability-root scope remain essential in the same mixed files.

Use the native essential selections after building:

```sh
pnpm build
pnpm test:unit --tagsFilter='!full'
pnpm test:integration --tagsFilter='!full'
```

No suite environment variable leaks into a later invocation. Omit the filter for complete granular/focused coverage. Empty required selections fail. Entirely full-only files must be excluded before imports when one is introduced; the current assessed files all contain essential coverage.

Root `test`, `check:package`, and `check` select essential coverage. `test:full`, `check:package:full`, and `check:full` retain complete coverage at the same package or package/website boundary. Granular and focused commands remain complete by default. CI uses `pnpm check`, retaining one package build, the consumer-tested release producer, both Node versions, and the website essential check. Full is reserved for explicit local requests, with complete focused coverage still required for affected behavior. No full CI input, schedule, or recurring manual routine is added.

Live input provenance remains essential. The real runtime, IPC and SQLite ledger correlate native messages without pre-tagged SDK rows, retain the same identity after persistence, and reject mismatched request, turn, content and session evidence. A held native acknowledgement qualifies live-before-acknowledgement ordering and revision-based wake-up without another output token. Identical text sent through another action never acquires the browser action's identity. All rows retain `grantsAuthority: false`.

Claude settings-notice regressions remain essential: the native double emits the local-command user replay before acknowledging applied model settings, as the actual CLI does. Repeated text and skill inputs retain one exact acknowledged live/saved identity without a phantom turn, replay or lost control. Autonomous output still starts a real native turn; idle notices and task notifications do not.

Async question coverage remains essential: exact native identity and ordered choices across live/saved/detail/evidence reads, complete serialized-byte bounds and evidence continuation, controlled-session observation without browser polling, subscriber failure isolation/unsubscribe/shutdown, output-gap/reconnect catch-up, and separation from native approvals and ordinary final results. Final-result cases cover both event orderings, oversized async text, async-only turns and a validated structured ordinary result. Before releasing this contract, qualify the built public API against an actual owned Codex session; synthetic CLI fixtures do not establish real async emission or reconnect behavior.

## Website boundary

`pnpm --dir website test` and `check` select essential; `test:full` and `check:full` include every existing category. Granular unit, integration, E2E, and `:artifact` commands remain complete. Both aggregate checks build once. Full runs locally only when explicitly requested; changed website behavior still requires complete focused coverage.

Essential website tests enforce unsafe URL/Markdown rejection, exact bounded regular-file source access, rejection of adjacent private/test sources, real damaged-output privacy checks, and the exact-release/deployment gate. Ordinary content/link rendering, names, metadata/image permutations, asset reproduction, and all production-browser E2E are full-only. Entirely full-only unit/asset files are excluded by essential commands before imports.

The existing production build always runs its DOM/artifact verifier. It uses Chromium to reject leaked tests, private paths and invalid output, so essential CI retains the required Chromium installation. This is required build preparation, not an additional browser smoke test. Removing it would break the build; the production verifier and its guarantees are unchanged.

## Integration isolation

Integration files run on two isolated fork workers, with tests within a file remaining sequential. Keep each test's SQLite database, Unix socket, workspace, native configuration, fixture control files, and lock state under its own temporary root. Process environment and module mocks stay within the owning worker. Do not introduce fixed shared paths or ports, process-wide working-directory changes, or state that depends on another file's execution order.

A runtime connects both CLIs as it starts, so `installCodexFixture` installs the Claude fixture beside Codex's, and no test starts an installed CLI. A test that counts native processes or calls waits for that warm-up first with `waitForWarmUp`, and one that needs a CLI's controls in place, or the CLI gone, at start sets them up and then starts a runtime of its own. A finished Claude turn's live items leave the window once its saved history holds them, which the warm-up makes immediate, so a test reads that window while the fixture's `holdResult` holds the turn's result.

`withClaudeRuntime` owns temporary provider configuration, real SQLite/IPC/runtime components, and synthetic external native CLIs. Its teardown is registered with the runner as well as the callback; it closes the runtime, verifies recorded native processes have stopped, restores environment variables, and removes only its fixture. Local runtime, lock, browser-host, crash/recovery, and tarball fixtures own their corresponding roots and processes. Additional runtimes and host database connections close in `finally` blocks.

The timeout regression uses a uniquely named disposable child test and removes it after the child runner finishes. The actual packed-consumer test remains the single archive producer; `JG_HQ_RELEASE_DIRECTORY` selects an owned output directory for retaining its verified archive. Parallel files must never rebuild or mutate the shared production output; fault-injection tests modify isolated copies instead.

## Controlled waits

`scripts/test-support/delays.ts` holds selected `jg-utilities` delay lengths until a test releases them. Abort signals still cancel immediately, and other delay lengths stay real. Use this existing control for intended idle or observation intervals rather than sleeping or globally accelerating time.

The Claude agents tests release each five-second observer interval and wait for the real native run and its state writes to finish. Their pace test still verifies the requested 5/30-second lengths and immediate pace changes. Late-output tests retain the real ten-second child-process deadline; ownership, cancellation, SQLite, IPC, and shutdown behavior remain real.

Important guarantees remain required regardless of cost. A timeout, privacy or ownership boundary, durable action acknowledgement, or recovery check does not become secondary because it is slow.

## Verification

Prefer complete focused checks during development. Run a changed integration file three consecutive times with retries disabled:

```sh
pnpm build
pnpm test:integration src/providers/claude/agents/agents.test-integration.ts --repeats=2 --retry=0
```

Vitest 5.0.3 counts two repeats after the initial run. A worker or shared fixture change also requires retry-free combined integration verification so cross-file interactions are exercised. Reuse successful results while relevant source, dependencies, configuration, selection, and environment inputs are unchanged.

For performance comparisons, retain current per-file timings, case counts, worker count, and retry settings. Package builds always clean and rebuild their output; test results are not reused as a substitute for execution. Compare the same package source and report preparation separately. Local timings establish the tested host only, not a promised Actions duration.

Determine release impact from the actual packed payload, including npm's always-packed `package.json` and `README.md`. Reusing a published version permits changes only to `test`, `test:full`, `check`, `check:full`, `check:package`, and `check:package:full` scripts and README text inside one `[testing-commands:start]: #` / `[testing-commands:end]: #` block, including its optional blank separator. All other manifest fields, scripts, README text, shipped paths, file permissions, and contents must match. Malformed markers fail closed. This skips publication and does not change the installed package.

The candidate archive must still match its raw SHA-512 receipt. A differing published archive is downloaded from the fixed registry URL with no redirects, under the existing shared 20-second deadline and a 16 MiB compressed limit, and checked against the registry's own SHA-512 before comparison. Non-extracting inspection accepts npm's regular-file USTAR payload, caps expansion at 64 MiB, individual files at 16 MiB, and entries at 4096, and rejects links, extension records, unsafe/duplicate paths, corrupt checksums, truncation, and trailing data. Newly submitted releases still require the complete tested archive's exact integrity when checking publication visibility. These release-integrity cases stay essential. Never use publication as a verification command. Tests must not enter production output or the tarball.

## Measured integration cost

On 2026-10-30, on Linux with Node.js 24.15.0 and Vitest 5.0.3, the same 482 cases across 27 files ran with retries disabled and no membership exclusions, before and after the test-owned wait controls and parallel files:

| Selection                                        | Workers | Test time                          |
| ------------------------------------------------ | ------- | ---------------------------------- |
| Original intervals and serial files              | 1       | 543.13 seconds                     |
| Controlled observer intervals and parallel files | 2       | 274.65, 229.46, and 236.47 seconds |

The median was 236.47 seconds, about 56% below baseline, and the agents file fell from 92.19 seconds to roughly 23 seconds while keeping its real native timeout checks. The original intervals no longer exist, so that baseline cannot be measured again.

On 2026-11-04, for 12.0.0, the complete integration category, 544 cases across 35 files, ran three times on the same platform and versions with `pnpm test:integration --retry=0` after one clean build, on 2 workers and with no membership exclusions. Vitest reported 235.90, 241.60, and 275.19 seconds, a median of 241.60 seconds; the slowest run shared the host with light editing tools. The agents file alone took 25.04 seconds. The clean package build took 3.44 seconds separately. These measurements exclude dependency installation and website work, and remain local evidence until observed in Actions.

The essential native selection retains 323 of 338 unit cases and 543 of 544 integration cases. The essential integration selection passed in 230.84 seconds, with retries disabled. The 16 full-only native cases cover timestamps and extra history presentation examples; consequential integration families remain selected. Website essential selects 14 unit and 4 integration cases; complete categories retain 42 unit, 16 integration, and 26 browser E2E cases. The mixed output test was split without removing its privacy or image-dimension assertions.
