import { SITE_CONFIG } from '../site.config.ts';

import type { IExampleDefinition } from './types.ts';

export const CONTROL_EXAMPLE = {
  id: 'control-session',
  number: '01',
  category: 'Native session control',
  title: 'Start and follow a native session',
  goal: 'Open a named Codex session, send a task and read what the native CLI reports back.',
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
  setup:
    'Save the complete helper as control-session.ts and the caller as run-session.ts. Run node run-session.ts while your controller is running.',
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
  resultLabel: 'Expected delivery output',
  resultNote:
    'The receipt confirms delivery. Read native turn completion and handle tool permissions separately.',
  returns: [
    { name: 'thread', text: 'The managed native session identity.' },
    { name: 'receipt', text: 'The submitted action and its delivery state.' },
    { name: 'liveItems', text: 'Output items reported by the native connection.' },
    { name: 'approvals', text: 'Native questions or permissions waiting for the host.' },
    { name: 'usage', text: 'The provider’s actual account observation, including availability.' },
  ],
} as const satisfies IExampleDefinition;

const REVIEW_EXAMPLE = {
  id: 'review-handoff',
  number: '02',
  category: 'Cross-provider review',
  title: 'Get another agent’s perspective',
  goal: 'Ask the other provider to review the author’s work, then return only the findings you select.',
  install: `npm install jg-agent-hq@${SITE_CONFIG.version} jg-utilities@1.7.0`,
  prerequisites: [
    'The local controller running, with Claude Code and Codex both signed in.',
    'An existing managed author session in the selected workspace.',
    'jg-review-session and jg-feedback available in the native skill catalogs.',
    'A retained handoff ID and real host controls for preview confirmation and findings selection.',
  ],
  steps: [
    {
      title: 'Preview the review',
      text: 'HQ selects the other provider. Show its exact review request before the user confirms it.',
    },
    {
      title: 'Choose findings',
      text: 'Wait for a completed native review, then let the user select one reviewer message by its turn and item IDs.',
    },
    {
      title: 'Return selected feedback',
      text: 'Show and confirm the feedback preview. HQ retains the request for the original author, including when that author is busy.',
    },
  ],
  setup:
    'Save the complete helper as review-handoff.ts and connect its callbacks to your host’s actual preview and findings-selection UI. Native permissions remain a separate host flow.',
  call: null,
  hostFields: [
    {
      name: 'handoffId',
      text: 'Retain this UUID before calling; use it to inspect the same handoff after reconnecting.',
    },
    {
      name: 'sourceThreadId',
      text: 'The managed author session. The target is the other provider.',
    },
    {
      name: 'commit',
      text: 'An exact commit for a commit review, or null for the current session’s work.',
    },
    {
      name: 'confirmPreview',
      text: 'Present each exact IHandoffPreview and return the user’s decision. A changed source requires a new preview.',
    },
    {
      name: 'selectFindings',
      text: 'Present the completed reviewer’s actual messages and return the selected native turnId and itemId.',
    },
  ],
  visual: {
    caption: 'Illustrative direction · Codex author',
    groups: [
      {
        label: 'Author',
        items: [{ title: 'Codex', detail: 'Explicit review preview', state: null }],
      },
      {
        label: 'Reviewer',
        items: [{ title: 'Claude Code', detail: 'Completed native findings', state: null }],
      },
      {
        label: 'Back to author',
        items: [{ title: 'Codex', detail: 'Confirmed selected feedback', state: null }],
      },
    ],
  },
  result: 'Selected feedback requested',
  resultLabel: 'After both previews are confirmed',
  resultNote:
    'The helper returns the retained handoff after requesting feedback. Feedback may still be queued or in flight. Observe its delivery and completion separately; it grants no implementation or tool permission.',
  returns: [
    { name: 'targetProvider', text: 'Claude for a Codex author; Codex for a Claude author.' },
    { name: 'review', text: 'The reviewer’s native delivery and completion observations.' },
    {
      name: 'findings',
      text: 'The selected completed reviewer message, with its source reference.',
    },
    {
      name: 'feedback',
      text: 'The retained feedback request, its action identity and current delivery state.',
    },
  ],
} as const satisfies IExampleDefinition;

const REVISION_EXAMPLE = {
  id: 'revise-plan',
  number: '03',
  category: 'Plan revision',
  title: 'Change the plan. Keep verified work.',
  goal: 'Add a requirement without throwing away completed work. Checkpoint the current scope, revise through native skills and approve the new execution scope.',
  install: `npm install jg-agent-hq@${SITE_CONFIG.version} jg-plans@0.2.0 jg-utilities@1.7.0`,
  prerequisites: [
    'A selected plan and finalized sequence, with actual completion evidence to retain.',
    'An available unbound planning thread in the same workspace, plus the affected managed thread and checkout identities.',
    'Native jg-plan and jg-breakdown skills with the supported project-local jg-plans CLI.',
    'Retained action IDs, actual approval and correspondence controls, and separate handling of native permissions.',
  ],
  steps: [
    {
      title: 'Checkpoint',
      text: 'Close execution admission and prove the affected native work has stopped before granting an editing lease.',
    },
    {
      title: 'Revise and reconcile',
      text: 'Run jg-plan, present the changed plan for approval, explicitly request jg-breakdown and confirm unmatched requirement correspondence.',
    },
    {
      title: 'Approve the new scope',
      text: 'Present the finalized sequence, retain valid evidence and obtain fresh sequence approval and execution authorization.',
    },
  ],
  setup:
    'Save the complete helper as revise-plan.ts. Connect its typed callbacks to real user decisions in your host. The example finishes at authorization; it does not submit an implementation task.',
  call: null,
  hostFields: [
    {
      name: 'approvePlan',
      text: 'Present the exact current plan source and return a new operator action only after approval.',
    },
    {
      name: 'requestBreakdown',
      text: 'Record the explicit request to invoke jg-breakdown for this revision.',
    },
    {
      name: 'confirmCorrespondence',
      text: 'Read the paged source/draft/evidence records and confirm equivalent, changed, omitted or reopened requirements against the saved proposal.',
    },
    {
      name: 'approveSequence',
      text: 'Present the finalized canonical source before issuing sequence approval.',
    },
    {
      name: 'authorize',
      text: 'Choose the current milestone IDs and supervised or auto mode. Approval alone does not resume execution.',
    },
  ],
  visual: {
    caption: 'Illustrative revision · confirmed equivalent wording',
    groups: [
      {
        label: 'Before',
        items: [{ title: 'Greeting', detail: 'Verified done · original ID', state: 'done' }],
      },
      {
        label: 'After',
        items: [
          {
            title: 'Greeting result',
            detail: 'Verified done · same ID and evidence',
            state: 'done',
          },
          { title: 'Report', detail: 'Pending · new ID', state: 'pending' },
        ],
      },
    ],
  },
  result: 'Verified work retained. New scope authorized.',
  resultLabel: 'Illustrative revision · all explicit decisions accepted',
  resultNote:
    'Equivalent wording retains the original milestone ID and its evidence only through confirmed correspondence. Changed requirements receive fresh pending identities. Status markers alone never create verified completion. On interruption, inspect retained actions and revision state before continuing.',
  returns: [
    { name: 'skillsBinding', text: 'Current after the explicit breakdown refresh.' },
    {
      name: 'coordination.completionCount',
      text: 'Existing verified completion remains available.',
    },
    {
      name: 'coordination.execution',
      text: 'A fresh authorization for the selected current milestone IDs and mode.',
    },
    {
      name: 'coordination.revision.phase',
      text: 'Finished after finalization and the accepted approval flow. No implementation has been started by this helper.',
    },
  ],
} as const satisfies IExampleDefinition;

export const EXAMPLE_DEFINITIONS: readonly IExampleDefinition[] = [
  CONTROL_EXAMPLE,
  REVIEW_EXAMPLE,
  REVISION_EXAMPLE,
];
