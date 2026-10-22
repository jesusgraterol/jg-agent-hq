import { Exception } from 'jg-exception';
import { z } from 'zod';

import manifest from '../../package.json' with { type: 'json' };

const version = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/u)
  .safeParse(manifest.version);
if (!version.success)
  throw new Exception('The HQ website source is invalid', {
    code: 'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
  });

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
    { href: '/examples/', label: 'Examples' },
    { href: '/docs/', label: 'Docs' },
    { href: '/docs/api/', label: 'API' },
  ],
} as const;

// HTML and Markdown discovery share these bounded page records
export const PAGE_RECORDS = [
  {
    id: 'home',
    path: '/',
    markdown: '/index.md',
    title: 'jg-agent-hq | Build your coding-agent control room',
    description:
      'Build your own interface for Claude Code and Codex. Control native sessions, follow results, coordinate reviews and retain verified plan progress locally.',
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
  {
    id: 'examples',
    path: '/examples/',
    markdown: '/examples/index.md',
    title: 'Worked examples | jg-agent-hq',
    description:
      'Three complete TypeScript walkthroughs: native session control, cross-provider review and plan revision with retained verification, explicit approvals and real source.',
  },
] as const;
