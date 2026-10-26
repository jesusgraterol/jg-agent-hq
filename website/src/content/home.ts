import { SITE_CONFIG } from '../site.config.ts';

export const HOME_CONTENT = {
  eyebrow: 'TypeScript SDK for Claude Code + Codex',
  title: 'Run coding agents from your app.',
  headline: ['Run coding agents', 'from your app.'],
  description:
    'Drive Claude Code and Codex, answer their prompts and let them hand work to each other through one local API.',
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
      text: 'Create, resume, fork or close sessions, and steer, queue or interrupt the running turn.',
      commands: ['thread-create', 'message', 'steer', 'queue', 'interrupt', 'thread-fork'],
      link: { href: '/examples/#control-session', label: 'Session walkthrough' },
    },
    {
      id: 'prompts',
      title: 'Answer prompts from your UI',
      text: 'Permission requests and agent questions wait in one inbox across restarts, and unknown kinds are denied.',
      commands: ['approvals', 'native-reply'],
      link: null,
    },
    {
      id: 'observe',
      title: 'See output, history and usage',
      text: 'Follow live output, browse past sessions and read each account’s real quota, credits and earned resets.',
      commands: ['live-items', 'sessions', 'session-evidence', 'usage', 'models'],
      link: null,
    },
    {
      id: 'collaboration',
      title: 'Let agents work together',
      text: 'Codex builds, Claude Code reviews with jg-review-session under an HQ grant, and HQ carries the report back.',
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
      text: 'Plans pass jg-plans checks before each approval, and verified milestones carry over when you revise them.',
      commands: ['approve', 'authorize', 'begin-revision', 'finalize'],
      link: { href: '/examples/#revise-plan', label: 'Revision walkthrough' },
    },
    {
      id: 'storage',
      title: 'Local, private and recoverable',
      text: 'HQ keeps its records in one private SQLite file you can share, snapshot while agents work and restore.',
      commands: ['hq.storage', 'createHqSnapshot', 'inspectHqSnapshot', 'restoreHqSnapshot'],
      link: null,
    },
  ],
  // smaller capabilities, each with one real command or API name from the canonical docs
  more: {
    eyebrow: 'Also included',
    title: 'The rest of the toolkit.',
    items: [
      {
        id: 'accounts',
        title: 'Accounts and MCP',
        text: 'Read native accounts, start sign-in and list a session’s MCP servers and tools.',
        name: 'account-login',
      },
      {
        id: 'configuration',
        title: 'Models and settings',
        text: 'List models and effort choices, and read a session’s effective settings.',
        name: 'models',
      },
      {
        id: 'files',
        title: 'Files and structured results',
        text: 'Attach verified workspace files and request results that match your schema.',
        name: 'outputSchema',
      },
      {
        id: 'browser',
        title: 'Browser hosts',
        text: 'Closed contracts let a browser app act through your trusted Node host.',
        name: 'jg-agent-hq/contracts',
      },
      {
        id: 'providers',
        title: 'Custom providers',
        text: 'Register another agent CLI behind the same session interface.',
        name: 'IAgentProvider',
      },
      {
        id: 'session-tools',
        title: 'Session tools',
        text: 'Fork, compact, archive, revert and name sessions, each with a durable receipt.',
        name: 'thread-fork',
      },
    ],
  },
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
        skill: null,
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
        skill: null,
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
        // the native review skill runs under an exact grant HQ issues for this request
        skill: 'jg-review-session',
        note: 'HQ grants the review skill, saves the full report and resumes Codex.',
      },
      {
        speaker: 'Codex',
        provider: 'codex',
        recipient: 'You',
        recipientProvider: null,
        kind: 'result',
        text: 'Empty exports now keep their headers. I added a regression test, and it passes.',
        command: 'hq_report_read',
        skill: null,
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
                  `${message.skill ? `\`${message.skill}\` · ` : ''}${message.command ? `\`${message.command}\` · ` : ''}${message.note}`,
                ].join('\n\n'),
              ),
            ]
          : []),
        item.commands.map((command) => `\`${command}\``).join(' · '),
        ...(item.link ? [`[${item.link.label}](${SITE_CONFIG.url}${item.link.href})`] : []),
      ].join('\n\n'),
    ),
    `## ${HOME_CONTENT.more.title}`,
    ...HOME_CONTENT.more.items.map(
      (item) => `### ${item.title}\n\n${item.text}\n\n\`${item.name}\``,
    ),
    `## ${HOME_CONTENT.startTitle}`,
    HOME_CONTENT.requirements.map((item) => `- ${item}`).join('\n'),
    ...HOME_CONTENT.setup.map((item) => `### ${item.title}\n\n\`\`\`sh\n${item.command}\n\`\`\``),
    `[${HOME_CONTENT.startLink.label}](${SITE_CONFIG.url}${HOME_CONTENT.startLink.href}) · [API reference](${SITE_CONFIG.url}/docs/api/) · [Source](${SITE_CONFIG.repositoryUrl})`,
  ].join('\n\n') + '\n';
