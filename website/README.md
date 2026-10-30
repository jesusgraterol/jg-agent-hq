# jg-agent-hq website

The private Astro workspace serves the public package overview, root README and API reference. It has no application backend or provider/account access. Canonical documentation remains in the repository root and `api/README.md`.

Run `pnpm install` from the repository root and `pnpm --dir website exec playwright install chromium`. Run `pnpm --dir website dev --ignore-lock` for foreground development. Restart development after editing canonical documents outside the website directory.

`pnpm --dir website check` runs essential unit tests, Astro/TypeScript checks, lint, formatting, one production build with DOM verification, and essential artifact integration tests. `test` runs essential correctness coverage. `test:full` and `check:full` add ordinary content/asset cases and all production-browser journeys; full runs only on explicit local request. Granular unit, integration, E2E, and `:artifact` commands remain complete. The integration and E2E scripts build first when run independently; their `:artifact` variants reuse an already built artifact. Browser tests own their foreground preview server on port 4173 and refuse to reuse an existing server. Stop any server you own before running them.

Essential protects source-access, unsafe-content, output-privacy and exact-release/deployment gates. The existing build verifier itself requires Chromium, including for essential. Presentation matrices and asset reproduction stay full-only. See [testing policy](../docs/testing.md) for classification, focused verification and the temporary root-command compatibility.

`pnpm --dir website assets:generate` reproduces committed images using bundled fonts and pinned Chromium. `verify:public-destinations` requires the exact root package version on npm and recognizable public links. `verify:deployment` checks the fixed live origin, including the actual 404 response. Network checks are separate from local builds.

See [website operations](../docs/website.md) for architecture, asset sources and delivery boundaries.
