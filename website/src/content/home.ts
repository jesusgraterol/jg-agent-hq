import { SITE_CONFIG } from '../site.config.ts';

import { CONTROL_EXAMPLE } from './examples.ts';

export const HOME_CONTENT = {
  eyebrow: 'TypeScript SDK + local CLI',
  title: 'Build your own control room for coding agents.',
  headline: ['Build your own', 'control room', 'for coding agents.'],
  description:
    'Run Claude Code and Codex from your application. Let agents coordinate through streams and return exact reports while you follow sessions, permissions and results.',
  visual: {
    label: 'Illustrative workspace',
    workspace: 'reports-workspace',
    session: 'build-reports',
    prompt: 'Explain how this repository generates reports.',
    caption:
      'Your interface sends commands. HQ follows native sessions and returns their observations.',
    steps: [
      { title: 'Create a session', detail: 'thread-create → native session' },
      { title: 'Send the task', detail: 'message → durable receipt' },
      { title: 'Follow the result', detail: 'live-items · approvals · usage' },
    ],
  },
  scenariosTitle: 'One foundation. Different workflows.',
  scenariosDescription:
    'Start with a session. Add a second perspective. Keep verified work when the plan changes.',
  scenarios: [
    {
      id: 'control-session',
      number: '01',
      title: 'Run a native session',
      description: 'Create a thread, send input and read actual output, permissions and usage.',
      flow: ['Create', 'Send', 'Observe'],
      result: 'A session and a durable delivery receipt',
      href: '/examples/#control-session',
      linkLabel: 'Read the session walkthrough',
    },
    {
      id: 'review-handoff',
      number: '02',
      title: 'Bring in another agent',
      description:
        'Choose any reviewer, receive its exact report and request a separate author assessment.',
      flow: ['Request', 'Report', 'Assessment'],
      result: 'An exact report and a separate assessment',
      href: '/examples/#review-handoff',
      linkLabel: 'Read the review walkthrough',
    },
    {
      id: 'revise-plan',
      number: '03',
      title: 'Change the plan. Keep the work.',
      description:
        'Pause execution, revise the documents and retain verified completion through explicit correspondence.',
      flow: ['Checkpoint', 'Revise', 'Approve'],
      result: 'Retained evidence and a fresh execution scope',
      href: '/examples/#revise-plan',
      linkLabel: 'Read the revision walkthrough',
    },
  ],
  startTitle: 'Your first local connection.',
  startDescription:
    'Use the CLIs you already sign in to. Start the controller, then connect through the public API.',
  setup: [
    {
      title: 'Install in your project',
      text: 'The SDK and CLI share one local package.',
      command: `npm install jg-agent-hq@${SITE_CONFIG.version}`,
    },
    {
      title: 'Start the controller',
      text: 'Run this in a trusted workspace with your native CLI signed in.',
      command: './node_modules/.bin/jg-agent-hq serve --state-root .runtime --workspace-root .',
    },
    {
      title: 'Read the connection',
      text: 'In a second terminal, inspect the local runtime.',
      command: './node_modules/.bin/jg-agent-hq status --state-root .runtime',
    },
  ],
  integrationTitle: 'From your interface to native agents.',
  integrationDescription: 'You build the experience. HQ supplies the local coordination layer.',
  integration: [
    {
      title: 'Your application',
      label: 'UI + authentication + hosting',
      text: 'Build the dashboard, editor integration or workflow your team needs.',
    },
    {
      title: 'jg-agent-hq',
      label: 'Node API + private local IPC',
      text: 'Control native sessions, connect agents through streams and retain reports and plan authority.',
    },
    {
      title: 'Native CLIs',
      label: 'Claude Code + Codex',
      text: 'Keep native sign-in, instructions, skills, tools and permission decisions.',
    },
  ],
  requirements: 'Node.js 24.15+ · Linux or macOS · Native CLI sign-in',
} as const;

/** Generates the homepage counterpart from the same visitor-facing content as its HTML. */
export const homeMarkdown = (): string =>
  [
    `# ${HOME_CONTENT.title}`,
    HOME_CONTENT.eyebrow,
    HOME_CONTENT.description,
    `## ${HOME_CONTENT.visual.label}`,
    HOME_CONTENT.visual.caption,
    ...HOME_CONTENT.visual.steps.map((step) => `- ${step.title}: ${step.detail}`),
    `## ${HOME_CONTENT.scenariosTitle}`,
    HOME_CONTENT.scenariosDescription,
    ...HOME_CONTENT.scenarios.map(
      (item) =>
        `### ${item.title}\n\n${item.description}\n\n${item.flow.join(' → ')}\n\n${item.result}\n\n[${item.linkLabel}](${SITE_CONFIG.url}${item.href})`,
    ),
    `## ${HOME_CONTENT.startTitle}`,
    HOME_CONTENT.startDescription,
    HOME_CONTENT.requirements,
    ...HOME_CONTENT.setup.map(
      (item) => `### ${item.title}\n\n${item.text}\n\n\`\`\`sh\n${item.command}\n\`\`\``,
    ),
    `## ${HOME_CONTENT.integrationTitle}`,
    HOME_CONTENT.integrationDescription,
    ...HOME_CONTENT.integration.map((item) => `### ${item.title}\n\n${item.label}\n\n${item.text}`),
    `## A session, from code to result`,
    CONTROL_EXAMPLE.goal,
    `\`\`\`ts\n${CONTROL_EXAMPLE.call}\n\`\`\``,
    CONTROL_EXAMPLE.resultNote,
    `[Getting started](${SITE_CONFIG.url}/docs/) · [API reference](${SITE_CONFIG.url}/docs/api/) · [Source](${SITE_CONFIG.repositoryUrl})`,
  ].join('\n\n') + '\n';
