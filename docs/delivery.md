# Package delivery

The default stop is `published`. Each stop includes the preceding stops. An authorized repository operator, including an agent authorized to deliver a change, performs the Git and GitHub steps; the configured GitHub Actions trusted publisher performs npm publication.

| Stop          | Required result                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `development` | The reviewed, qualified task commits are integrated into remote `development` with their history preserved.                      |
| `main`        | A pull request from `development` is reviewed, both package Node checks pass, and its merge commit is verified on remote `main`. |
| `published`   | The successful main publication run and registry version identify the qualified source and the exact consumer-tested archive.    |

## Prepare and qualify

1. Inspect current `development`, `main` and npm's latest release. Integrate any already released changes into the candidate, preserving their commits. Review the combined result before publication; conflicts or another operator's unapproved work stop integration.
2. Select an unused stable version greater than npm's latest. Update `package.json` and `CHANGELOG.md`, regenerate the workspace lockfile with the installed pnpm version, and retain no fabricated lockfile change when resolution stays identical. Keep public API, recovery and error documentation aligned.
3. Run `pnpm check:package` on the final candidate. Its packed-consumer test is the archive producer; `JG_HQ_RELEASE_DIRECTORY` can retain that tested archive and SHA-512 receipt in an owned output directory. Inspect the packed file list, public exports, declarations and absence of tests or private artifacts. Required native-provider qualification remains separate from synthetic CLI tests.
4. Run `pnpm --dir website check` when canonical site content or workspace configuration changes, as the root testing policy requires. The pinned Chromium installation is required by its existing production verifier. Website verification and deployment remain separate from npm publication.

## Integrate and publish

1. Review the exact candidate and complete required checks before creating signed, signed-off task or integration commits. Publish the task branch, then fast-forward `development` only when its fresh remote tip is an ancestor of the qualified candidate. Use an ordinary non-forced push; a concurrent update requires inspection instead of overwriting it.
2. Open the `development` to `main` pull request and review its final diff. Both `check.yml` package jobs, on Node 24.15.0 and 24.22.0, must pass for that exact head before merge. Honor repository review/protection requirements. Merge with history preserved; do not bypass checks or push directly to `main`. If the prospective source changes, qualify the changed result before proceeding.
3. Verify that remote `main` contains the task commits and matches the reviewed source tree. Observe the main `Verify and publish` run through completion. Both package checks run again; only the floor-Node job uploads `npm-release`. The publish job downloads that consumer-tested archive and submits it once with provenance through npm's configured trusted publisher.
4. Verify the exact registry version and SHA-512 integrity against that run's tested archive/receipt, and record the main source commit and successful run. A command exit or existing npm version alone is insufficient. Failed or uncertain submission requires inspection of the run and registry before any retry. Never publish as a verification command or substitute a local build for the CI archive.

No local npm token, login or per-release security prompt is required by the configured publisher. Published versions are immutable; correct a package defect with another qualified version. The existing publisher can skip an already published matching artifact under its documented release-integrity rules. See [website and publisher operations](website.md#npm-release) for trusted-publisher configuration, visibility delays and independent Pages delivery.
