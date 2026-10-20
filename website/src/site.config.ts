import { Exception } from 'error-message-utils';
import { z } from 'zod';

import manifest from '../../package.json' with { type: 'json' };

const version = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/u)
  .safeParse(manifest.version);
if (!version.success) throw new Exception('The HQ website source is invalid');

// the bounded public surface; the package manifest owns the displayed version
export const SITE_CONFIG = {
  name: 'jg-agent-hq',
  url: 'https://jg-agent-hq.jesusgraterol.dev',
  repositoryUrl: 'https://github.com/jesusgraterol/jg-agent-hq',
  npmUrl: 'https://www.npmjs.com/package/jg-agent-hq',
  skillsUrl: 'https://jg-skills.jesusgraterol.dev',
  packagesUrl: 'https://jg-packages.jesusgraterol.dev',
  version: version.data,
  themeKey: 'jg-agent-hq.theme',
  themeColors: { dark: '#1e2939', light: '#fefdfb' },
  author: { name: 'Jesus Graterol', url: 'https://jesusgraterol.dev' },
  navigation: [
    { href: '/docs/', label: 'Docs' },
    { href: '/docs/api/', label: 'API' },
  ],
} as const;

// HTML and Markdown discovery share these three records
export const PAGE_RECORDS = [
  {
    id: 'home',
    path: '/',
    markdown: '/index.md',
    title: 'jg-agent-hq | Native coding-agent workspace primitives',
    description:
      'Coordinate Claude Code and Codex sessions, live input, plans and cross-provider feedback through one local controller.',
  },
  {
    id: 'getting-started',
    path: '/docs/',
    markdown: '/docs/index.md',
    title: 'Getting started | jg-agent-hq',
    description:
      'Install the local controller and understand native sessions, skill previews, account observations and revision-bound plan authority.',
  },
  {
    id: 'api',
    path: '/docs/api/',
    markdown: '/docs/api/index.md',
    title: 'API reference | jg-agent-hq',
    description:
      'The canonical Node API, browser-safe contracts and local CLI reference for jg-agent-hq.',
  },
] as const;

// the homepage's visible narrative and its Markdown counterpart use the same copy
export const HOME_CONTENT = {
  eyebrow: 'Native agents. One workspace.',
  title: 'Keep your agents in sync.',
  description:
    'Build on Claude Code and Codex with a local controller for sessions, plans and feedback. Your CLIs keep their tools, permissions and conversation histories.',
  capabilities: [
    {
      title: 'Sessions with context',
      text: 'Create short-named threads, browse native history and send input through explicit, durable actions.',
    },
    {
      title: 'Plans that remember',
      text: 'Keep approvals and completed work tied to the right revision, even when milestones change.',
    },
    {
      title: 'Feedback across agents',
      text: 'Open a reviewer with the other provider, select its findings and send them back for assessment.',
    },
  ],
  workflow: [
    {
      label: '01',
      title: 'Choose a session',
      text: 'Start or adopt a native thread. HQ tracks its identity while the CLI owns execution.',
    },
    {
      label: '02',
      title: 'Preview the next action',
      text: 'Browse the native skill catalog and inspect the exact invocation before sending it.',
    },
    {
      label: '03',
      title: 'Keep authority explicit',
      text: 'Plan approval, execution scope and native tool permission remain separate decisions.',
    },
  ],
} as const;

/** Returns the homepage counterpart from the same copy and install version as the HTML. */
export const homeMarkdown = (): string =>
  `# ${HOME_CONTENT.title}\n\n${HOME_CONTENT.description}\n\n## Install\n\n\`npm install jg-agent-hq@${SITE_CONFIG.version}\`\n\nRequires Node.js 24.15.0 or later on Linux or macOS, plus the native CLIs you use.\n\n${HOME_CONTENT.capabilities.map((item) => `## ${item.title}\n\n${item.text}`).join('\n\n')}\n\n## A deliberate workflow\n\n${HOME_CONTENT.workflow.map((item) => `### ${item.title}\n\n${item.text}`).join('\n\n')}\n\nAccount usage comes from native observations, with explicit stale and unavailable states. Immediate steering is provider-dependent; Claude currently supports queued input rather than immediate steering.\n\nThis is a standalone TypeScript package and CLI. Applications supply their own UI, authentication and deployment.\n\n[Getting started](${SITE_CONFIG.url}/docs/)\n\n[API reference](${SITE_CONFIG.url}/docs/api/)\n\n[Source](${SITE_CONFIG.repositoryUrl})\n`;
