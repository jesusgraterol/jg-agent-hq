import { SITE_CONFIG } from '../site.config.ts';

import type { IExampleDefinition } from './types.ts';

// the examples page lede, shared by its HTML and Markdown
export const EXAMPLES_PAGE_LEDE =
  'Three runnable TypeScript helpers. Each shows its steps, what you get back and the full source.';

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
  hostFields: [],
  visual: null,
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

const REVIEW_EXAMPLE = {
  id: 'review-handoff',
  number: '02',
  category: 'Agent review',
  title: 'Have another agent review the work',
  goal: 'A reviewer checks the work, HQ keeps its exact report and the author assesses it.',
  install: `npm install jg-agent-hq@${SITE_CONFIG.version} jg-utilities@1.7.0`,
  prerequisites: [
    'The controller, with both agents signed in',
    'A task and stream both agents belong to',
    'A host control that confirms each request',
    'Optional: jg-review-session and jg-feedback, with current grants',
  ],
  steps: [
    {
      title: 'Request a review',
      commands: ['message-publish', 'request-dispatch'],
      outcome: 'Sent once you confirm it',
    },
    {
      title: 'Read the report',
      commands: ['request-read', 'report-read'],
      outcome: 'Exact findings, with ID and hash',
    },
    {
      title: 'Ask for an assessment',
      commands: ['message-publish', 'request-dispatch'],
      outcome: 'The author weighs the findings',
    },
  ],
  setup:
    'Save the helper as review-handoff.ts. Connect confirmRequest to a real operator decision and handle native permissions separately.',
  call: null,
  hostFields: [
    { name: 'stateRoot, operatorRef', text: 'Your controller and the signed-in operator.' },
    { name: 'taskId, streamId', text: 'An existing task and stream.' },
    {
      name: 'requestIds, dispatchIds',
      text: 'Four UUIDs saved before sending, so a retry reads the same requests.',
    },
    {
      name: 'review, feedback',
      text: 'Who does each step, what to read and an optional skill. Feedback gets the report reference.',
    },
    {
      name: 'confirmRequest',
      text: 'Shows each request to the operator and returns their decision.',
    },
  ],
  visual: {
    caption: 'Illustrative · either agent can use either provider',
    groups: [
      {
        label: 'Review',
        items: [{ title: 'Claude Code', detail: 'Reviews the selected work', state: null }],
      },
      {
        label: 'Report',
        items: [{ title: 'report 7f3a', detail: 'Exact findings, kept by HQ', state: 'done' }],
      },
      {
        label: 'Assessment',
        items: [{ title: 'Codex', detail: 'Reads the report and responds', state: 'pending' }],
      },
    ],
  },
  result: 'Report kept. Assessment requested.',
  resultLabel: 'After you confirm both requests',
  resultNote:
    'The assessment may still be running when the helper returns; it waits up to 30 seconds. Findings never approve implementation.',
  returns: [
    { name: 'review', text: 'The review request, its outcome and report ID, or null if declined.' },
    { name: 'feedback', text: 'The assessment request with the report reference, or null.' },
  ],
} as const satisfies IExampleDefinition;

const REVISION_EXAMPLE = {
  id: 'revise-plan',
  number: '03',
  category: 'Plan revision',
  title: 'Change the plan. Keep verified work.',
  goal: 'Add a requirement mid-plan without losing finished milestones.',
  install: `npm install jg-agent-hq@${SITE_CONFIG.version} jg-plans@0.3.0 jg-utilities@1.7.0`,
  prerequisites: [
    'A finalized plan with verified milestones',
    'A free planning session in the same workspace',
    'jg-plan, jg-breakdown and the project’s jg-plans CLI',
    'Host controls for each approval',
  ],
  steps: [
    {
      title: 'Pause',
      commands: ['begin-revision'],
      outcome: 'Execution stops and running work is checked',
    },
    {
      title: 'Revise',
      commands: ['message', 'approve', 'revision-invoke'],
      outcome: 'jg-plan and jg-breakdown rewrite the plan',
    },
    {
      title: 'Approve',
      commands: ['finalize', 'approve', 'authorize'],
      outcome: 'Verified work kept, new scope authorized',
    },
  ],
  setup:
    'Save the helper as revise-plan.ts and connect its callbacks to real user decisions. It stops at authorization and starts no implementation.',
  call: null,
  hostFields: [
    {
      name: 'approvePlan',
      text: 'Shows the revised plan and returns an approval only if the user approves.',
    },
    { name: 'requestBreakdown', text: 'Records the request to run jg-breakdown.' },
    { name: 'approveSequence', text: 'Shows the final milestones before approving them.' },
    { name: 'authorize', text: 'Picks the milestones to run, in supervised or auto mode.' },
  ],
  visual: {
    caption: 'Illustrative revision · one requirement added',
    groups: [
      {
        label: 'Before',
        items: [{ title: 'Greeting', detail: 'Verified', state: 'done' }],
      },
      {
        label: 'After',
        items: [
          { title: 'Greeting result', detail: 'Verified · same ID and evidence', state: 'done' },
          { title: 'Report', detail: 'Pending · new milestone', state: 'pending' },
        ],
      },
    ],
  },
  result: 'Verified work kept. New scope authorized.',
  resultLabel: 'Illustrative · every decision accepted',
  resultNote:
    'A milestone keeps its evidence when jg-breakdown keeps its ID. Work the new breakdown reopens needs a new completion. Editing a status in the file never counts as verified.',
  returns: [
    { name: 'skillsBinding', text: 'Current again after the breakdown refresh.' },
    { name: 'coordination.completionCount', text: 'Verified milestones still counted.' },
    { name: 'coordination.execution', text: 'The new authorization: milestones and mode.' },
    { name: 'coordination.revision.phase', text: 'Finished. No implementation has started.' },
  ],
} as const satisfies IExampleDefinition;

export const EXAMPLE_DEFINITIONS: readonly IExampleDefinition[] = [
  CONTROL_EXAMPLE,
  REVIEW_EXAMPLE,
  REVISION_EXAMPLE,
];
