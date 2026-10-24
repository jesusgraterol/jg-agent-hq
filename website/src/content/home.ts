import { SITE_CONFIG } from '../site.config.ts';

export const HOME_CONTENT = {
  eyebrow: 'TypeScript SDK for Claude Code + Codex',
  title: 'Run coding agents from your app.',
  headline: ['Run coding agents', 'from your app.'],
  description:
    'Start sessions, send work, answer permission prompts and let agents hand work to each other. One local API, built on the CLIs you already sign in to.',
  map: {
    caption: 'How it fits · everything runs on your machine',
    app: { title: 'Your app', detail: 'Dashboard, editor or automation' },
    hq: {
      title: 'jg-agent-hq',
      detail: 'Local controller',
      parts: ['Sessions', 'Prompts', 'Streams', 'Plans'],
    },
    agents: ['Claude Code', 'Codex'],
    agentDetail: 'Native sign-in, tools and skills',
    // the app-to-HQ link, then the HQ-to-agents link
    links: [
      {
        down: { label: 'Commands', items: ['thread-create', 'message', 'native-reply'] },
        up: { label: 'Results', items: ['live-items', 'approvals', 'usage'] },
      },
      {
        down: { label: 'Native control', items: [] },
        up: { label: 'Agent tools', items: ['hq_message_publish', 'hq_agent_spawn'] },
      },
    ],
  },
  capabilitiesTitle: 'Everything your agent UI needs.',
  capabilities: [
    {
      id: 'sessions',
      title: 'Drive native sessions',
      text: 'Create, resume, fork or close sessions. Send a task, steer the running turn, queue the next one or interrupt.',
      commands: ['thread-create', 'message', 'steer', 'queue', 'interrupt', 'thread-fork'],
      link: { href: '/examples/#control-session', label: 'Session walkthrough' },
    },
    {
      id: 'prompts',
      title: 'Answer prompts from your UI',
      text: 'Permission requests and agent questions wait in one inbox, across reconnects and restarts. Unknown kinds are denied.',
      commands: ['approvals', 'native-reply'],
      link: null,
    },
    {
      id: 'observe',
      title: 'See output, history and usage',
      text: 'Follow live output, browse past sessions without resuming them and read each account’s real quota.',
      commands: ['live-items', 'sessions', 'session-evidence', 'usage', 'models'],
      link: null,
    },
    {
      id: 'collaboration',
      title: 'Let agents work together',
      text: 'Let Codex build a feature, ask Claude Code to review it and continue with the findings, with HQ carrying the request and report between them.',
      commands: [
        'task-create',
        'hq_message_publish',
        'hq_invocation_read',
        'hq_report_read',
        'hq_agent_spawn',
      ],
      link: { href: '/examples/#review-handoff', label: 'Review walkthrough' },
    },
    {
      id: 'plans',
      title: 'Change the plan, keep the work',
      text: 'Approve a plan, authorize its milestones and revise it mid-flight. Verified milestones carry over; changed ones start again.',
      commands: ['approve', 'authorize', 'begin-revision', 'finalize'],
      link: { href: '/examples/#revise-plan', label: 'Revision walkthrough' },
    },
    {
      id: 'storage',
      title: 'Local, private and recoverable',
      text: 'Conversations stay in each CLI’s own storage. HQ keeps its records in one private SQLite file your app can share, snapshot and restore.',
      commands: ['hq.storage', 'createHqSnapshot', 'restoreHqSnapshot'],
      link: null,
    },
  ],
  collaborationExample: {
    caption: 'Illustrative · build a CSV export, then review it',
    setup: 'Your app has allowed Codex to build and Claude Code to review this task.',
    label: 'CSV export review conversation',
    messages: [
      {
        speaker: 'You',
        provider: null,
        recipient: 'Codex',
        recipientProvider: 'codex',
        kind: 'task',
        text: 'Add CSV export to reports. Ask Claude to review it before you finish.',
        command: null,
        note: 'You give the task once. The agents handle the handoff.',
      },
      {
        speaker: 'Codex',
        provider: 'codex',
        recipient: 'Claude Code',
        recipientProvider: 'claude',
        kind: 'request',
        text: 'The exporter is ready. Check quoted fields and empty exports in src/reports/csv.ts.',
        command: 'hq_message_publish',
        note: 'HQ delivers the request. Codex waits for the review.',
      },
      {
        speaker: 'Claude Code',
        provider: 'claude',
        recipient: 'Codex',
        recipientProvider: 'codex',
        kind: 'report',
        text: 'Quoted fields work. An empty export loses its column headers.',
        command: null,
        note: 'HQ saves the full report and resumes Codex.',
      },
      {
        speaker: 'Codex',
        provider: 'codex',
        recipient: 'You',
        recipientProvider: null,
        kind: 'result',
        text: 'Empty exports now keep their headers. I added a regression test, and it passes.',
        command: 'hq_report_read',
        note: 'Codex reads the report, makes the fix and finishes your original task.',
      },
    ],
  },
  startTitle: 'Running in three commands.',
  requirements: ['Node.js 24.15 or later', 'Linux or macOS', 'Claude Code or Codex, signed in'],
  setup: [
    { title: 'Install', command: `npm install jg-agent-hq@${SITE_CONFIG.version}` },
    {
      title: 'Start the controller',
      command: './node_modules/.bin/jg-agent-hq serve --state-root .runtime --workspace-root .',
    },
    {
      title: 'Check it’s running',
      command: './node_modules/.bin/jg-agent-hq status --state-root .runtime',
    },
  ],
  startLink: { href: '/examples/#control-session', label: 'Send your first task' },
} as const;

/** Generates the homepage counterpart from the same visitor-facing content as its HTML. */
export const homeMarkdown = (): string =>
  [
    `# ${HOME_CONTENT.title}`,
    HOME_CONTENT.eyebrow,
    HOME_CONTENT.description,
    HOME_CONTENT.map.caption,
    `${HOME_CONTENT.map.app.title} → ${HOME_CONTENT.map.hq.title} → ${HOME_CONTENT.map.agents.join(' + ')}`,
    `## ${HOME_CONTENT.capabilitiesTitle}`,
    ...HOME_CONTENT.capabilities.map((item) =>
      [
        `### ${item.title}`,
        item.text,
        ...(item.id === 'collaboration'
          ? [
              HOME_CONTENT.collaborationExample.caption,
              HOME_CONTENT.collaborationExample.setup,
              ...HOME_CONTENT.collaborationExample.messages.map((message) =>
                [
                  `**${message.speaker} to ${message.recipient} (${message.kind})**`,
                  message.text,
                  `${message.command ? `\`${message.command}\` · ` : ''}${message.note}`,
                ].join('\n\n'),
              ),
            ]
          : []),
        item.commands.map((command) => `\`${command}\``).join(' · '),
        ...(item.link ? [`[${item.link.label}](${SITE_CONFIG.url}${item.link.href})`] : []),
      ].join('\n\n'),
    ),
    `## ${HOME_CONTENT.startTitle}`,
    HOME_CONTENT.requirements.map((item) => `- ${item}`).join('\n'),
    ...HOME_CONTENT.setup.map((item) => `### ${item.title}\n\n\`\`\`sh\n${item.command}\n\`\`\``),
    `[${HOME_CONTENT.startLink.label}](${SITE_CONFIG.url}${HOME_CONTENT.startLink.href}) · [API reference](${SITE_CONFIG.url}/docs/api/) · [Source](${SITE_CONFIG.repositoryUrl})`,
  ].join('\n\n') + '\n';
