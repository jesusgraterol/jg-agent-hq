import { Exception } from 'jg-exception';

import { SITE_CONFIG } from '../site.config.ts';

export const CONTROL_EXAMPLE = {
  id: 'control-session',
  number: '01',
  title: 'Start and follow a native session',
  goal: 'Open a named Codex session, send a task and read what the native CLI reports back.',
  sourcePath: 'examples/control-session.ts',
  install: `npm install jg-agent-hq@${SITE_CONFIG.version} jg-utilities@1.7.0`,
  prerequisites: [
    'Node.js 24.15+ on Linux or macOS, in an ES module project.',
    'Codex installed and signed in through its native CLI.',
    'The local controller running in this workspace.',
    'Caller action IDs retained before submission for reconnect reads.',
  ],
  steps: [
    { title: 'Create', text: 'Open a named native session in the selected workspace.' },
    { title: 'Send', text: 'Submit explicit input and follow its durable receipt.' },
    { title: 'Observe', text: 'Read live items, native permissions and actual account usage.' },
  ],
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
  resultNote:
    'The receipt confirms delivery. Read native turn completion and handle tool permissions separately.',
  returns: [
    { name: 'thread', text: 'The managed native session identity.' },
    { name: 'receipt', text: 'The submitted action and its delivery state.' },
    { name: 'liveItems', text: 'Output items reported by the native connection.' },
    { name: 'approvals', text: 'Native questions or permissions waiting for the host.' },
    { name: 'usage', text: 'The provider’s actual account observation, including availability.' },
  ],
} as const;

/**
 * Combines the exact build-loaded helper with its visitor-facing walkthrough.
 * @throws
 * - JG_AGENT_HQ_WEBSITE_SOURCE_INVALID: The HQ website source is invalid
 */
export const createControlExample = (source: string | undefined) => {
  if (!source)
    throw new Exception('The HQ website source is invalid', {
      code: 'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
    });
  return { ...CONTROL_EXAMPLE, source };
};

/** The walkthrough and its Markdown counterpart share the same copy and complete source. */
export const examplesMarkdown = (source: string): string => {
  const example = createControlExample(source);
  return (
    [
      '# Worked examples',
      'A complete local workflow, from a public API call to an observable result.',
      `## ${example.title}`,
      example.goal,
      '### Before you start',
      example.prerequisites.map((text) => `- ${text}`).join('\n'),
      `\`\`\`sh\n${example.install}\n\`\`\``,
      'Save the complete helper below as control-session.ts. Save the caller as run-session.ts, then run node run-session.ts while your controller is running.',
      ...example.steps.map((step) => `### ${step.title}\n\n${step.text}`),
      '### Call the helper',
      `\`\`\`ts\n${example.call}\n\`\`\``,
      '### What you get back',
      `Expected delivery output after native acknowledgement:\n\n\`\`\`text\n${example.result}\n\`\`\``,
      example.resultNote,
      ...example.returns.map((field) => `- \`${field.name}\`: ${field.text}`),
      '### Complete source',
      `Source: ${example.sourcePath}. This is the same helper exercised by the public-client integration tests.`,
      `\`\`\`ts\n${example.source}\`\`\``,
      '[API reference](/docs/api/) · [Getting started](/docs/)',
    ].join('\n\n') + '\n'
  );
};
