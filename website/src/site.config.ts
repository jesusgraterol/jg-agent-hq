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
    title: 'jg-agent-hq | One runtime for Claude Code and Codex',
    description:
      'Build on Claude Code and Codex with local session control, native skills, plan progress, cross-agent feedback and subscription usage.',
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

// the headline's two visual lines also form the plain-text page title
const HOME_TITLE = ['Claude Code and Codex,', 'working together.'] as const;

// the homepage's visible narrative and its Markdown counterpart use the same copy
export const HOME_CONTENT = {
  eyebrow: 'Open-source runtime for native coding agents',
  title: HOME_TITLE.join(' '),
  headline: HOME_TITLE,
  description:
    'Bring sessions, skills, plans and feedback into one local workspace. Build the interface you want around the coding agents you already use.',
  collaboration:
    'HQ connects the sessions and carries selected feedback between them. Each agent keeps its own tools, permissions and conversation.',
  capabilities: [
    {
      title: 'Sessions you can follow',
      text: 'Create short, readable thread names and browse native conversation history from either provider.',
    },
    {
      title: 'Plans that can change',
      text: 'Revise the plan, regenerate milestones and reconcile finished work before continuing on the new revision.',
    },
    {
      title: 'A second perspective',
      text: 'Ask the other provider to challenge a plan or review a session. Preview its findings and return the ones you select.',
    },
    {
      title: 'Skills from your CLI',
      text: 'Browse the native catalog and preview the exact skill invocation. Your CLI loads the skill and applies its rules.',
    },
    {
      title: 'Actual account usage',
      text: 'Read the subscription windows and reset times each provider exposes, with explicit stale and unavailable states.',
    },
    {
      title: 'Input with a clear outcome',
      text: 'Send messages, queue follow-ups, interrupt work and answer native prompts. Track delivery separately from completion.',
    },
  ],
  workflow: [
    {
      label: '01',
      title: 'Start on your machine',
      text: 'Install the package and run the local controller in a trusted workspace. Sign in with your existing native CLIs.',
    },
    {
      label: '02',
      title: 'Connect your interface',
      text: 'Use the Node API or local IPC. Browser-safe contracts give your application the same validated commands and observations.',
    },
    {
      label: '03',
      title: 'Build your workflow',
      text: 'Connect sessions, plan revisions and cross-agent reviews. Keep approval and native tool permissions explicit.',
    },
  ],
  nativeBehavior:
    'Live input follows each provider’s capabilities. Codex supports steering during a turn; Claude supports queued follow-ups and interruption.',
  integration:
    'jg-agent-hq is a TypeScript package and local CLI. Your application supplies the interface, authentication and hosting.',
} as const;

// an existing local controller owns the native connections; this client only reads an observation
export const USAGE_EXAMPLE = `import { resolve } from 'node:path';
import { requestAgentHq } from 'jg-agent-hq';

const observation = await requestAgentHq(
  resolve('.runtime'),
  { kind: 'usage', provider: 'codex' },
);

if (observation.kind === 'usage' &&
    observation.result.state === 'available') {
  console.log(observation.result.windows);
}`;

/** Returns the homepage counterpart from the same copy and install version as the HTML. */
export const homeMarkdown = (): string =>
  `# ${HOME_CONTENT.title}\n\n${HOME_CONTENT.description}\n\n${HOME_CONTENT.collaboration}\n\n## Install\n\n\`npm install jg-agent-hq@${SITE_CONFIG.version}\`\n\nRequires Node.js 24.15.0 or later on Linux or macOS, plus the native CLIs you use.\n\n${HOME_CONTENT.capabilities.map((item) => `## ${item.title}\n\n${item.text}`).join('\n\n')}\n\n## Start small\n\n${HOME_CONTENT.workflow.map((item) => `### ${item.title}\n\n${item.text}`).join('\n\n')}\n\n\`\`\`ts\n${USAGE_EXAMPLE}\n\`\`\`\n\n${HOME_CONTENT.nativeBehavior}\n\n${HOME_CONTENT.integration}\n\n[Getting started](${SITE_CONFIG.url}/docs/)\n\n[API reference](${SITE_CONFIG.url}/docs/api/)\n\n[Source](${SITE_CONFIG.repositoryUrl})\n`;
