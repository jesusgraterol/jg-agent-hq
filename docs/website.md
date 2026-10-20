# Public website

`website/` is a private Astro workspace, built independently from the Node runtime. `src/site.config.ts` owns the fixed three-page catalog and reads the package version from root `package.json`. The production origin is `https://jg-agent-hq.jesusgraterol.dev`. No browser request fetches native sessions, account usage or npm metadata.

The exact two-document content loader reads root `README.md` and `api/README.md`, outside the website root, once each per content sync. It accepts regular files up to 1 MiB, rejects raw HTML/unsafe links, and renders each document's own heading. Canonical HTML links resolve to the site; the error registry links to public GitHub source. Markdown counterparts retain their canonical source text. The homepage HTML/Markdown share one copy record. Navigation, metadata, sitemap and agent discovery describe the same bounded page set. There is no content cache or recursive repository crawl.

The shared `jg-personal-astro-ui@0.3.1` public components, theme/prose CSS, Markdown plugins and syntax theme own reusable controls, navigation, code windows, typography, light/dark palettes and reduced motion. Local Astro components compose product content. Documentation routes remain thin. `/404.html` has no canonical and is excluded from discovery; the deployment check requires an actual HTTP 404 for a missing address.

## Verification

Install the workspace from the root and install its pinned Playwright Chromium. `pnpm check:package` checks only the runtime, including a real tarball consumer. `pnpm --dir website check` checks the site. `pnpm check` composes both. Root build/type/test/format inputs exclude the website; the publishable package's explicit file list excludes all website files and dependencies.

Website `check` builds once, then reuses that artifact for real DOM validation, deliberate damaged-artifact cases and production browser journeys. Unit, integration and E2E scripts select separate categories; no tests live under Astro's route directory. Run changed integration files three consecutive times without retries. Browser checks include 320px, tablet and desktop, both system themes, keyboard/focus/menu/theme persistence, clipboard success/failure and external-link notices. Network destination checks do not run during local builds.

Artifact verification uses one Chromium instance with scripts and resource loading disabled, closes it in `finally`, and checks local references/anchors, metadata, canonical Markdown, discovery, image dimensions and forbidden build output. Production browser tests exercise actual scripts and fonts. These checks establish Chromium on the tested host; other browser engines and macOS need their own runtime evidence.

## Generated assets and attribution

Run `pnpm --dir website assets:generate`. One Chromium renderer uses device scale 1, bundled local fonts and the committed HTML template at `website/scripts/assets/open-graph.html`. It verifies font loading and text fit before writing `public/og/jg-agent-hq.png` (1200×630), PNG favicons (32×32 and 192×192) and an ICO containing 16/32/48px PNG images. Regenerate outputs instead of editing them. The asset integration test reproduces their exact bytes on the tested host.

The unmodified jg mark and slash favicon come from the public `jg-personal-astro-ui/jg-mark.svg` and `jg-personal-astro-ui/jg-favicon.svg` exports. That package and its source are MIT licensed in [jg-packages](https://github.com/jesusgraterol/jg-packages/tree/main/packages/jg-personal-astro-ui). Ubuntu Sans and Ubuntu Sans Mono use the bundled Fontsource variable-font packages at 5.3.0, under the Ubuntu Font Licence 1.0; each package includes its license. The jg mark contains outlined type from Ubuntu Sans Mono. Lucide icons are ISC licensed. No Moldea assets, private screenshots or system/network fonts are used.

## Delivery boundary

The build emits only static files in `website/dist/`. Public destination checks require the exact root version on npm, plus the expected GitHub/npm/jg-skills/jg-packages content. The deployment verifier then checks canonical pages, Markdown, discovery, image availability and real missing-page behavior at the fixed HTTPS origin.

CI, manual npm release, Pages/domain setup and deployment/rollback operations belong to the next delivery milestone. This milestone establishes a locally verified artifact and does not claim a live deployment.
