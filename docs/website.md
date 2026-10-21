# Public website

`website/` is a private Astro workspace, built independently from the Node runtime. `src/site.config.ts` owns the fixed three-page catalog and reads the package version from root `package.json`. The production origin is `https://jg-agent-hq.jesusgraterol.dev`. No browser request fetches native sessions, account usage or npm metadata.

The exact two-document content loader reads root `README.md` and `api/README.md`, outside the website root, once each per content sync. It accepts regular files up to 1 MiB, rejects raw HTML/unsafe links, and renders each document's own heading. Canonical HTML links resolve to the site; the error registry links to public GitHub source. Markdown counterparts retain their canonical source text. The homepage HTML/Markdown share one copy record. Navigation, metadata, sitemap and agent discovery describe the same bounded page set. There is no content cache or recursive repository crawl.

The shared `jg-personal-astro-ui@0.4.0` public components, theme/prose CSS, Markdown plugins and syntax theme own reusable controls, navigation, code windows, typography, light/dark palettes and reduced motion. `jg-site` owns structured data and llms.txt generation. The homepage composes an illustrative cross-provider handoff, the capability catalog and a copyable local-client example. Documentation pages provide section navigation from the rendered headings, horizontally scrollable on smaller screens and beside the article on desktop. Documentation routes remain thin. `/404.html` has no canonical and is excluded from discovery; the deployment check requires an actual HTTP 404 for a missing address.

## Verification

Install the workspace from the root and install its pinned Playwright Chromium. `pnpm check:package` checks only the runtime, including a real tarball consumer. `pnpm --dir website check` checks the site. `pnpm check` composes both. Root build/type/test/format inputs exclude the website; the publishable package's explicit file list excludes all website files and dependencies.

Signed Git integration fixtures create their own disposable author/signing metadata. Git and `ssh-keygen` must be available; the tests do not require your Git identity or SSH agent.

Website `check` builds once, then reuses that artifact for real DOM validation, deliberate damaged-artifact cases and production browser journeys. Unit, integration and E2E scripts select separate categories; no tests live under Astro's route directory. Run changed integration files three consecutive times without retries. Browser checks use `jg-playwright` for asset readiness and horizontal overflow, retaining the direct axe scan for its WCAG 2.2 tags. Checks include 320px, tablet and desktop, both system themes, keyboard/focus/menu/theme persistence, clipboard success/failure and external-link notices. Network destination checks do not run during local builds.

Artifact verification uses one Chromium instance with scripts and resource loading disabled, closes it in `finally`, and checks local references/anchors, metadata, canonical Markdown, discovery, image dimensions and forbidden build output. Production browser tests exercise actual scripts and fonts. These checks establish Chromium on the tested host; other browser engines and macOS need their own runtime evidence.

## Generated assets and attribution

Run `pnpm --dir website assets:generate`. One Chromium renderer uses device scale 1, bundled local fonts and the committed HTML template at `website/scripts/assets/open-graph.html`. It verifies font loading and text fit before writing `public/og/jg-agent-hq.png` (1200×630), PNG favicons (32×32 and 192×192) and an ICO containing 16/32/48px PNG images. Regenerate outputs instead of editing them. The asset integration test reproduces their exact bytes on the tested host.

The unmodified jg mark and slash favicon come from the public `jg-personal-astro-ui/jg-mark.svg` and `jg-personal-astro-ui/jg-favicon.svg` exports. That package and its source are MIT licensed in [jg-packages](https://github.com/jesusgraterol/jg-packages/tree/main/packages/jg-personal-astro-ui). Ubuntu Sans and Ubuntu Sans Mono use the bundled Fontsource variable-font packages at 5.3.0, under the Ubuntu Font Licence 1.0; each package includes its license. The jg mark contains outlined type from Ubuntu Sans Mono. Lucide icons are ISC licensed. No Moldea assets, private screenshots or system/network fonts are used.

## CI and delivery

The build emits only static files in `website/dist/`. Public destination checks require the exact root version from npm's registry API, plus the expected GitHub/jg-skills/jg-packages content. npm's browser page can reject automated reads and is not a deployment dependency. The deployment verifier then checks canonical pages, Markdown, discovery, image availability and real missing-page behavior at the fixed HTTPS origin.

`.github/workflows/check.yml` runs `pnpm check` on pull requests to `main`, pushes to `main` and manual dispatches. Both Node 24.15.0 (the engine floor) and 24.22.0 (the qualified LTS) must pass. Installs use the frozen workspace lockfile and its existing narrow dependency-build policy, without dependency caches because this workflow publishes packages. Browser installation includes Chromium's runner OS dependencies. Refresh the qualified LTS deliberately when updating release qualification.

Only the floor-Node job uploads `website/dist` and the consumer-tested npm archive, and only on `main`. A separate job waits for the entire matrix, downloads that exact archive and publishes it with npm provenance through the configured trusted publisher. Only that job receives publishing OIDC permission. Deployment waits for publication, checks the exact npm release/public destinations, then deploys the same Pages artifact without rebuilding. Only the deploy job has Pages write permission and its own Pages OIDC permission. Pull requests have no deployment or production credentials. Superseded pull-request runs can be canceled; an active main publication/deployment is allowed to finish. No release/tag trigger or long-lived npm/provider credential is needed.

The repository's Pages source must be GitHub Actions, with custom domain `jg-agent-hq.jesusgraterol.dev` and working HTTPS DNS/certificate configuration. The `github-pages` environment should permit deployment from `main`. A successful workflow is followed by `verify:deployment`, which checks actual HTTPS content, direct Markdown media types/content, discovery, assets and an actual missing-page 404. A locally passing build does not establish a live deployment.

For Cloudflare-proxied hosting, create a Configuration Rule matching `http.host eq "jg-agent-hq.jesusgraterol.dev"` with Email Obfuscation off. Otherwise Cloudflare interprets the package's `name@version` install argument as an email address and rewrites the verified HTML. Keep this rule restricted to the public hostname; domain configuration belongs to the operator.

## npm release

The package already exists on npm. Its trusted publisher must authorize GitHub user `jesusgraterol`, repository `jg-agent-hq`, workflow `check.yml`, direct `npm publish` and no publishing environment restriction. npm CLI 11.5.1 or later and Node 22.14.0 or later support this flow; the publishing job uses the qualified Node 24.22.0 runtime. No local sign-in, npm token or per-release security prompt is required.

The packed-consumer integration test retains its exact tested archive in `JG_HQ_RELEASE_DIRECTORY` when CI supplies that directory. `scripts/release/` validates a bounded registry response and requires a stable version newer than npm's latest release. An existing version is skipped only when its SHA-512 integrity matches the tested archive; a changed artifact under the same version fails. The publish job submits that archive once, waits up to three minutes for npm processing and confirms its integrity. Failed or uncertain submissions stop the job; inspect the registry and run before retrying. Rerunning on `main` safely skips an identical release and continues deployment.

Inspect the actual completed Actions run and HTTPS result. Public contract corrections require a versioned release before private consumers update their exact pins. Website-only changes need no runtime release when packed contents stay unchanged. Registry reads use deadlines and bounded bodies without caching; there are only two version lookups before a new publication and a bounded visibility check afterward.

## Rollback

For a website regression, revert the responsible source change through `development` and a PR to `main`, then let the same checks and release gate produce/deploy its verified artifact. Keep the fixed production origin. Do not substitute an unverified local build or deploy a pull-request artifact. If deployment fails, inspect that run before retrying; a failed gate publishes no replacement site.

npm versions are immutable. A package defect requires a corrected version and another verified publication through `main`, followed by exact consumer-pin updates. Preserve the failing release evidence; do not overwrite a published version or add a compatibility path to conceal it.
