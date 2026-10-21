// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { expectToThrowCode } from 'jg-exception/testing';
import { computePlanRevision, type IPlanContract } from 'jg-agent-hq';
import { expect, test } from 'vitest';

const idA = '34d7bf50-2fa8-40a6-a447-867cb684a5af';
const idB = '26dc12a6-cb80-400d-a7f7-e8d9dbf239e9';
const block = (ordinal: number, title: string, id: string, status = 'pending') =>
  `## Milestone ${ordinal}: ${title}\n**Status:** ${status}\n**Milestone ID:** ${id}\n\n**Objective:** Deliver ${title}.\n**Dependencies:** None.\n**Scope:** Feature files.\n**Implementation:** Implement the contract.\n**Verification:** Run actual checks.\n**Acceptance:** Correct behavior.\n**Review checkpoint:** Review behavior.\n\n`;
const sequence = (first = block(1, 'First', idA), second = block(2, 'Second', idB)) =>
  `# Milestones\n\n## Shared rules\nKeep permissions native.\n\n## Overview\n\n| Milestone | Name | Status |\n| --- | --- | --- |\n| 1 | First | pending |\n| 2 | Second | pending |\n\n${first}${second}## Approval required\nApprove the sequence.\n`;
const input = (): IPlanContract => ({
  body: '# Plan\nImplement a native workspace.\n',
  metadata: {
    scope: 'cross-repo',
    repositories: ['b', 'a'],
    errorReservations: [
      {
        repository: 'a',
        namespace: 'api',
        start: 100,
        end: 104,
        registryPath: 'errors/index.ts',
        purpose: 'Workspace errors',
      },
    ],
  },
  milestones: sequence(),
});

test('execution digests preserve only documented administrative and ordinal differences', () => {
  const baseline = input();
  const expected = computePlanRevision(baseline);
  const changed = input();
  changed.body = changed.body.replaceAll('\n', '\r\n');
  changed.metadata.repositories.reverse();
  changed.milestones = sequence(block(11, 'First', idA, 'in progress'), block(12, 'Second', idB))
    .replace('| 1 | First | pending |', '| 11 | First | in progress |')
    .replaceAll('\n', '\r\n');
  expect(computePlanRevision(changed)).toStrictEqual(expected);
});

test.each([
  'Objective',
  'Dependencies',
  'Scope',
  'Implementation',
  'Verification',
  'Acceptance',
  'Review checkpoint',
])('changing %s requirements invalidates the sequence', (field) => {
  const baseline = input();
  const changed = input();
  changed.milestones = changed.milestones!.replace(
    `**${field}:**`,
    `**${field}:** Changed requirement.`,
  );
  expect(computePlanRevision(changed).planDigest).toBe(computePlanRevision(baseline).planDigest);
  expect(computePlanRevision(changed).breakdownDigest).not.toBe(
    computePlanRevision(baseline).breakdownDigest,
  );
});

test('shared sequence rules, milestone ordering and immutable IDs are contractual', () => {
  const baseline = computePlanRevision(input());
  for (const milestones of [
    sequence().replace('Keep permissions native.', 'Grant permissions automatically.'),
    sequence(block(1, 'Second', idB), block(2, 'First', idA)),
    sequence(block(1, 'First', randomUUID())),
  ])
    expect(computePlanRevision({ ...input(), milestones }).breakdownDigest).not.toBe(
      baseline.breakdownDigest,
    );
});

test.each(['scope', 'repository', 'reservation'] as const)(
  'changing %s metadata invalidates execution',
  (kind) => {
    const baseline = input();
    const changed = input();
    if (kind === 'scope') changed.metadata.scope = 'single-repo';
    if (kind === 'repository') changed.metadata.repositories.push('c');
    if (kind === 'reservation') changed.metadata.errorReservations[0]!.end++;
    expect(computePlanRevision(changed).planDigest).not.toBe(
      computePlanRevision(baseline).planDigest,
    );
    expect(computePlanRevision(changed).breakdownDigest).not.toBe(
      computePlanRevision(baseline).breakdownDigest,
    );
  },
);

test.each([
  sequence().replace(idB, idA),
  sequence().replace(idB, 'invalid-id'),
  sequence().replace(`**Milestone ID:** ${idA}\n`, `\n**Milestone ID:** ${idA}\n`),
  sequence().replace(
    `**Milestone ID:** ${idA}\n`,
    `**Milestone ID:** ${idA}\n**Milestone ID:** ${idA}\n`,
  ),
  sequence().replace('## Milestone 2:', '## Milestone 1:'),
  sequence().replace('**Status:** pending\n', ''),
])('malformed or ambiguous milestone framing is rejected', (milestones) => {
  expectToThrowCode(
    () => computePlanRevision({ ...input(), milestones }),
    'JG_AGENT_HQ_PLAN_INVALID',
    'The HQ plan is invalid',
  );
});

test('raw breakdowns and plans without breakdowns have no execution-ready sequence digest', () => {
  const raw = sequence().replace(/^\*\*Milestone ID:\*\* .*\n/gm, '');
  expect(computePlanRevision({ ...input(), milestones: raw }).breakdownDigest).toBeNull();
  expect(computePlanRevision({ ...input(), milestones: null }).breakdownDigest).toBeNull();
});

test('Overview prose and fenced identity examples cannot hide or create requirements', () => {
  const baseline = input();
  const changed = input();
  changed.milestones = changed.milestones!.replace(
    '## Overview\n',
    '## Overview\nAn extra implementation requirement.\n',
  );
  expect(computePlanRevision(changed).breakdownDigest).not.toBe(
    computePlanRevision(baseline).breakdownDigest,
  );
  const example =
    '```md\n## Milestone 99: Example only\n**Status:** pending\n**Milestone ID:** invalid-example\n```\n';
  expect(
    computePlanRevision({
      ...input(),
      milestones: sequence().replace('**Objective:**', example + '**Objective:**'),
    }).breakdownDigest,
  ).not.toBeNull();
});

test('a fenced Overview example remains part of the sequence contract', () => {
  const sample =
    '```md\n## Overview\n\n| Milestone | Name | Status |\n| --- | --- | --- |\n| 1 | Example | pending |\n```\n';
  const first = {
    ...input(),
    milestones: sequence().replace('## Shared rules\n', '## Shared rules\n' + sample),
  };
  const changed = {
    ...first,
    milestones: first.milestones.replace(
      '| 1 | Example | pending |',
      '| 1 | Changed requirement | pending |',
    ),
  };
  expect(computePlanRevision(changed).breakdownDigest).not.toBe(
    computePlanRevision(first).breakdownDigest,
  );
});

test('real Overview status remains derived when a fenced example precedes it', () => {
  const sample =
    '```md\n## Overview\n\n| Milestone | Name | Status |\n| --- | --- | --- |\n| 1 | Example | pending |\n```\n';
  const first = {
    ...input(),
    milestones: sequence().replace('## Shared rules\n', '## Shared rules\n' + sample),
  };
  const changed = {
    ...first,
    milestones: first.milestones.replace('| 1 | First | pending |', '| 1 | First | in progress |'),
  };
  expect(computePlanRevision(changed)).toStrictEqual(computePlanRevision(first));
});

test.each(['**Milestone ID:**' + idA, '  **Milestone ID:** ' + idA])(
  'malformed identity framing is rejected',
  (marker) => {
    expectToThrowCode(
      () =>
        computePlanRevision({
          ...input(),
          milestones: sequence().replace('**Milestone ID:** ' + idA, marker),
        }),
      'JG_AGENT_HQ_PLAN_INVALID',
      'The HQ plan is invalid',
    );
  },
);

test('fenced headings within Overview do not make the following real table contractual', () => {
  const sample = '```md\n## Example heading\nExample text.\n```\n';
  const first = {
    ...input(),
    milestones: sequence().replace('## Overview\n', '## Overview\n' + sample),
  };
  const changed = {
    ...first,
    milestones: first.milestones.replace('| 1 | First | pending |', '| 1 | First | in progress |'),
  };
  expect(computePlanRevision(changed)).toStrictEqual(computePlanRevision(first));
});
