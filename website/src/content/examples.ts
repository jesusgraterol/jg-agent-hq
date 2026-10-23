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
  category: 'Agent review',
  title: 'Get another agent’s perspective',
  goal: 'Choose a reviewer, receive its exact report, then ask the author to assess it within a separate read-only request.',
  install: `npm install jg-agent-hq@${SITE_CONFIG.version} jg-utilities@1.7.0`,
  prerequisites: [
    'The local controller and chosen managed sessions, signed in through their native providers.',
    'An existing task, stream and agent memberships with automatic dispatch disabled.',
    'Current host-issued grants and native catalogs when selecting skills; null skills need neither.',
    'Retained request/dispatch IDs and an operator control to confirm each exact specification.',
  ],
  steps: [
    {
      title: 'Choose and confirm',
      text: 'The host selects both agents and confirms the review specification. Either may use any provider.',
    },
    {
      title: 'Receive the report',
      text: 'HQ retains the reviewer’s complete structured report and exact ID/hash, without a copying or publishing turn.',
    },
    {
      title: 'Confirm assessment',
      text: 'The host confirms a separate read-only author request containing that report reference. Findings grant no implementation authority.',
    },
  ],
  setup:
    'Save the helper as review-handoff.ts. Connect confirmRequest to actual operator decisions. Select read-only specifications and current grants for optional jg-review-session/jg-feedback skills. Handle native permissions separately.',
  call: null,
  hostFields: [
    {
      name: 'stateRoot, operatorRef',
      text: 'The trusted local controller and authenticated operator attribution supplied by your host.',
    },
    {
      name: 'taskId, streamId',
      text: 'An existing authorized task and stream; no fixed provider relationship is created.',
    },
    {
      name: 'requestIds, dispatchIds',
      text: 'Retain four distinct UUIDs for exact publication and dispatch replay, including after reconnect.',
    },
    {
      name: 'review, feedback',
      text: 'Exact target agent, arguments, read effects, paths, plan and optional selected native skill/grant. Feedback receives the review report reference.',
    },
    {
      name: 'confirmRequest',
      text: 'Present each complete selected specification and return the operator’s decision. A grant cannot replace a later approval.',
    },
  ],
  visual: {
    caption: 'Illustrative selection · providers are chosen by the host',
    groups: [
      {
        label: 'Request',
        items: [{ title: 'Codex', detail: 'Confirmed review scope', state: null }],
      },
      {
        label: 'Report',
        items: [{ title: 'Claude Code', detail: 'Exact retained findings', state: null }],
      },
      {
        label: 'Assessment',
        items: [{ title: 'Codex', detail: 'Separate read-only request', state: null }],
      },
    ],
  },
  result: 'Review retained; assessment requested',
  resultLabel: 'After both requests are confirmed',
  resultNote:
    'Feedback may still be queued or in flight. A checkpoint returns without assessment. Inspect blocked requests through their retained IDs. The helper waits up to 30 seconds; inspect retained IDs after a timeout. No finding, delivery or completion approves implementation.',
  returns: [
    {
      name: 'review',
      text: 'The retained request, outcome and exact report ID, or null when declined.',
    },
    {
      name: 'feedback',
      text: 'The separately confirmed author request with report ID/hash, or null when no assessment was sent.',
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
