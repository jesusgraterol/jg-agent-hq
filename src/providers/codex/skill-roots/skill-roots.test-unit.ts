import { expect, test } from 'vitest';

import { parseSkillFrontmatter, toCapabilityRoots } from './index.js';

test.each([
  [
    'plain fields',
    '---\nname: hq-plan\ndescription: Plan registered work.\n---\nBody',
    { name: 'hq-plan', description: 'Plan registered work.' },
  ],
  [
    'double quotes',
    '---\nname: "hq-plan"\ndescription: "Plan: registered work"\n---\n',
    { name: 'hq-plan', description: 'Plan: registered work' },
  ],
  [
    'single quotes',
    "---\nname: 'hq-plan'\ndescription: 'Plan work'\n---",
    { name: 'hq-plan', description: 'Plan work' },
  ],
  [
    'CRLF lines and other keys',
    '---\r\nlicense: MIT\r\nname: hq-plan\r\ndescription: Plan\r\n---\r\n',
    { name: 'hq-plan', description: 'Plan' },
  ],
  [
    'an empty description',
    '---\nname: hq-plan\ndescription:\n---\n',
    { name: 'hq-plan', description: '' },
  ],
])('parseSkillFrontmatter(%s) -> identity', (_label, source, expected) => {
  expect(parseSkillFrontmatter(source)).toStrictEqual(expected);
});

test.each([
  ['no frontmatter', 'name: hq-plan\ndescription: Plan\n'],
  ['unclosed frontmatter', '---\nname: hq-plan\ndescription: Plan\n'],
  ['a missing name', '---\ndescription: Plan\n---\n'],
  ['a missing description', '---\nname: hq-plan\n---\n'],
  ['a folded description', '---\nname: hq-plan\ndescription: >\n  Plan work\n---\n'],
  ['a literal description', '---\nname: hq-plan\ndescription: |\n  Plan work\n---\n'],
  ['a name with spaces', '---\nname: hq plan\ndescription: Plan\n---\n'],
  ['a name past 256 characters', `---\nname: ${'a'.repeat(257)}\ndescription: Plan\n---\n`],
  [
    'a description past 8192 characters',
    `---\nname: hq-plan\ndescription: ${'d'.repeat(8193)}\n---\n`,
  ],
])('parseSkillFrontmatter(%s) -> null', (_label, source) => {
  expect(parseSkillFrontmatter(source)).toBeNull();
});

test('each root becomes a distinct local-environment capability root', () => {
  expect(toCapabilityRoots(['/srv/a', '/srv/b'])).toStrictEqual([
    {
      id: 'jg-agent-hq-skills-0',
      location: { type: 'environment', environmentId: 'local', path: '/srv/a' },
    },
    {
      id: 'jg-agent-hq-skills-1',
      location: { type: 'environment', environmentId: 'local', path: '/srv/b' },
    },
  ]);
});
