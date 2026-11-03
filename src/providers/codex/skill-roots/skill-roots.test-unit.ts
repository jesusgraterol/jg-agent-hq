import { expect, test } from 'vitest';

import { parseSkillFrontmatter, readSkillHint, toCapabilityRoots } from './index.js';

test.each([
  [
    'plain fields',
    '---\nname: hq-plan\ndescription: Plan registered work.\n---\nBody',
    { name: 'hq-plan', description: 'Plan registered work.', argumentHint: null },
  ],
  [
    'double quotes',
    '---\nname: "hq-plan"\ndescription: "Plan: registered work"\n---\n',
    { name: 'hq-plan', description: 'Plan: registered work', argumentHint: null },
  ],
  [
    'single quotes',
    "---\nname: 'hq-plan'\ndescription: 'Plan work'\n---",
    { name: 'hq-plan', description: 'Plan work', argumentHint: null },
  ],
  [
    'CRLF lines and other keys',
    '---\r\nlicense: MIT\r\nname: hq-plan\r\ndescription: Plan\r\n---\r\n',
    { name: 'hq-plan', description: 'Plan', argumentHint: null },
  ],
  [
    'an empty description',
    '---\nname: hq-plan\ndescription:\n---\n',
    { name: 'hq-plan', description: '', argumentHint: null },
  ],
])('parseSkillFrontmatter(%s) -> identity', (_label, source, expected) => {
  expect(parseSkillFrontmatter(source)).toStrictEqual(expected);
});

test.each([
  [
    'an unquoted hint',
    'argument-hint: [auto] [plan-path] [milestone N]',
    '[auto] [plan-path] [milestone N]',
  ],
  ['a single-quoted hint', "argument-hint: '[task or amendments]'", '[task or amendments]'],
  ['a double-quoted hint', 'argument-hint: "<session-name> [focus]"', '<session-name> [focus]'],
  ['a hint of 1024 characters', `argument-hint: ${'h'.repeat(1024)}`, 'h'.repeat(1024)],
  ['no hint', 'license: MIT', null],
  ['an empty hint', 'argument-hint:', null],
  ['an empty quoted hint', "argument-hint: ''", null],
  ['a folded hint', 'argument-hint: >\n  [task]', null],
  ['a literal hint', 'argument-hint: |\n  [task]', null],
  ['a hint past 1024 characters', `argument-hint: ${'h'.repeat(1025)}`, null],
])('parseSkillFrontmatter(%s) -> argument hint', (_label, line, argumentHint) => {
  expect(
    parseSkillFrontmatter(`---\nname: jg-plan\ndescription: Plan a change\n${line}\n---\n`),
  ).toStrictEqual({ name: 'jg-plan', description: 'Plan a change', argumentHint });
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

test('a skill path that is not absolute has no hint, and is never opened', async () => {
  expect(await readSkillHint('skills/jg-plan/SKILL.md')).toBeNull();
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
