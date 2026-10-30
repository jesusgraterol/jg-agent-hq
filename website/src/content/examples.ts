import { SITE_CONFIG } from '../site.config.ts';

import type { IExampleDefinition } from './types.ts';

// the examples page lede, shared by its HTML and Markdown
export const EXAMPLES_PAGE_LEDE =
  'A runnable TypeScript helper, with its steps, what you get back and the full source.';

export const CONTROL_EXAMPLE = {
  id: 'control-session',
  number: '01',
  category: 'Session control',
  title: 'Start and follow a native session',
  goal: 'Open a Codex session, send it a task and read what comes back.',
  install: `npm install jg-agent-hq@${SITE_CONFIG.version} jg-utilities@1.7.0`,
  prerequisites: [
    'Node.js 24.15+ on Linux or macOS',
    'Codex installed and signed in',
    'The controller running in this workspace',
  ],
  steps: [
    { title: 'Create', commands: ['thread-create'], outcome: 'A named session, idle and ready' },
    { title: 'Send', commands: ['message', 'receipt'], outcome: 'The task is delivered' },
    {
      title: 'Read',
      commands: ['live-items', 'approvals', 'usage'],
      outcome: 'Output, open prompts and quota',
    },
  ],
  setup:
    'Save the helper as control-session.ts and the caller as run-session.ts, then run node run-session.ts.',
  call: `import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { controlSession } from './control-session.ts';

const actionIds = {
  create: randomUUID(),
  message: randomUUID(),
};
// Retain these IDs in your host before submitting.
console.log(actionIds);

const session = await controlSession({
  stateRoot: resolve('.runtime'),
  workspaceRoot: process.cwd(),
  provider: 'codex',
  name: 'build-reports',
  text: 'Explain how this repository generates reports.',
  actionIds,
});

console.log(session.receipt.delivery);`,
  result: 'acknowledged',
  resultLabel: 'Printed delivery state',
  resultNote:
    'Acknowledged means delivered. Turn completion and tool permissions are reported separately.',
  returns: [
    { name: 'thread', text: 'The managed session.' },
    { name: 'receipt', text: 'The message action and its delivery state.' },
    { name: 'liveItems', text: 'Output the session has produced so far.' },
    { name: 'approvals', text: 'Prompts waiting for your reply.' },
    { name: 'usage', text: 'The account’s quota windows and availability.' },
  ],
} as const satisfies IExampleDefinition;

export const EXAMPLE_DEFINITIONS: readonly IExampleDefinition[] = [CONTROL_EXAMPLE];
