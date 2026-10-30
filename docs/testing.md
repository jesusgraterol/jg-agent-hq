# Testing

Package tests consume built public exports. Run `pnpm build` before focused tests; `pnpm check:package` builds once, runs the unit and integration categories, typechecks, and checks formatting. `pnpm test:unit` and `pnpm test:integration` keep their complete categories. The website has its own README and verification boundary.

## Essential and full selections

Essential protects consequential guarantees, including expensive ones. All unassessed cases remain selected until their family is reviewed. Granular and focused commands stay complete by default; native `full` tags exclude secondary coverage only when an essential filter is explicitly applied.

| Assessed boundary                              | Essential guarantee                                                                                                                                                                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actions, accounts, and extensions              | Exact action/request correlation, admission deduplication, permission scope, private prompt/login data, authentication isolation, no replay, and required recovery. Real 30-second late acknowledgements stay essential.                 |
| Runtime, browser-host admission, and contracts | Private IPC/process ownership, SQLite integrity, schema/key preservation, operator isolation, drain-before-shutdown, exact credits, bounded observations, and account-specific freshness. Browser-host tests protect backend authority.  |
| Claude/Codex control and provider registry     | External-session ownership, native lifecycle confirmation, fail-closed capabilities, cross-session/provider isolation, raw-frame bounds, websocket protocol/keepalive, confirmed child-process teardown, and native pagination ordering. |
| Inputs and results                             | Authorized regular files, traversal/link/content-hash refusal, queued delivery integrity, complete bounded results, output-schema validation, and worst-case admitted frame sizes.                                                       |
| Action waits and live state                    | Notification/read races, bounded revision/gap state, completion/flush reconciliation, and shutdown cancellation.                                                                                                                         |

Full-only scenarios currently cover native item timestamp projections and extra read-only history kind/text examples. Those projected fields do not drive admission, permission decisions, receipt deadlines, or cursor identity. The native thread-list sort-parameter check stays essential because it verifies the requested ordering for native pagination. Reasoning omission, bounded output, full file-change evidence, state/outcome mapping, and capability-root scope remain essential in the same mixed files.

Use the native essential selections after building:

```sh
pnpm build
pnpm test:unit --tagsFilter='!full'
pnpm test:integration --tagsFilter='!full'
```

No suite environment variable leaks into a later invocation. Omit the filter for complete granular/focused coverage. Empty required selections fail. Entirely full-only files must be excluded before imports when one is introduced; the current assessed files all contain essential coverage.

Full is reserved for explicit local requests, with complete focused coverage still required for affected behavior. No full CI input, schedule, or recurring manual routine is added. The published root manifest still composes complete categories, and its shortcut changes wait for the next normal release. Current CI also uses those complete categories until its native essential routing is adopted; classification alone does not change that invocation.

## Integration isolation

Integration files run on two isolated fork workers, with tests within a file remaining sequential. Keep each test's SQLite database, Unix socket, workspace, native configuration, fixture control files, and lock state under its own temporary root. Process environment and module mocks stay within the owning worker. Do not introduce fixed shared paths or ports, process-wide working-directory changes, or state that depends on another file's execution order.

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

Determine release impact from the actual packed payload, including npm's always-packed `package.json` and `README.md`. Test, configuration, and repository-only documentation changes that leave that payload unchanged require no package version. Verify that a consumer-tested archive remains identical to the published version with the nonpublishing release comparison. Never use publication as a verification command. Tests must not enter production output or the tarball.

## Measured integration cost

On Linux with Node.js 24.15.0 and Vitest 5.0.3 (2026-10-30), the same 482 cases across 27 files ran with retries disabled and no membership exclusions:

| Selection                                        | Workers | Test time                          |
| ------------------------------------------------ | ------- | ---------------------------------- |
| Original intervals and serial files              | 1       | 543.13 seconds                     |
| Controlled observer intervals and parallel files | 2       | 274.65, 229.46, and 236.47 seconds |

The median is 236.47 seconds, about 56% below baseline. The agents file fell from 92.19 seconds to roughly 23 seconds while keeping its real native timeout checks. All 482 cases were selected in this comparison; this gain comes from test-owned wait controls and independent files. The clean package build took 3.92 seconds separately. These measurements exclude dependency installation and website work, and remain local evidence until observed in Actions.
