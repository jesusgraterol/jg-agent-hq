import { expect, test } from 'vitest';

import { sameDevelopmentMetadata } from './metadata.ts';

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const manifest = {
  name: 'fixture',
  version: '1.0.0',
  exports: './dist/index.js',
  dependencies: { library: '1.0.0' },
  scripts: { build: 'tsc', 'test:unit': 'vitest run', test: 'old tests' },
};

test('aggregate testing commands can change while all other manifest fields match', () => {
  expect(
    sameDevelopmentMetadata(
      'package.json',
      bytes(manifest),
      bytes({
        ...manifest,
        scripts: {
          ...manifest.scripts,
          test: 'essential tests',
          'test:full': 'all tests',
          check: 'essential check',
          'check:full': 'all checks',
          'check:package': 'package check',
          'check:package:full': 'all package checks',
        },
      }),
    ),
  ).toBe(true);
  expect(
    sameDevelopmentMetadata(
      'package.json',
      bytes({ name: 'fixture' }),
      bytes({ name: 'fixture', scripts: { test: 'test' } }),
    ),
  ).toBe(true);
});

test.each([
  'build',
  'test:unit',
  'test:integration',
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'pretest',
  'test:unknown',
])('script %s remains protected', (name) => {
  expect(
    sameDevelopmentMetadata(
      'package.json',
      bytes(manifest),
      bytes({ ...manifest, scripts: { ...manifest.scripts, [name]: 'changed' } }),
    ),
  ).toBe(false);
});

test.each([
  ['version', '1.0.1'],
  ['dependencies', { library: '2.0.0' }],
  ['devDependencies', { tool: '1.0.0' }],
  ['exports', './other.js'],
  ['bin', './cli.js'],
  ['engines', { node: '>=26' }],
  ['files', ['other']],
  ['type', 'commonjs'],
])('manifest field %s remains protected', (name, value) => {
  expect(
    sameDevelopmentMetadata('package.json', bytes(manifest), bytes({ ...manifest, [name]: value })),
  ).toBe(false);
});

test.each(['{', 'null', '[]', '{"scripts":[]}', '{"scripts":{"test":null}}'])(
  'invalid manifest %s fails closed',
  (value) => {
    expect(sameDevelopmentMetadata('package.json', Buffer.from(value), Buffer.from(value))).toBe(
      false,
    );
  },
);

test('only one marked testing-command documentation block can differ', () => {
  const old = Buffer.from('# Package\n\n## Usage\nProtected usage.\n');
  const updated = Buffer.from(
    '# Package\n\n[testing-commands:start]: #\n## Testing\nNew commands.\n[testing-commands:end]: #\n## Usage\nProtected usage.\n',
  );
  expect(sameDevelopmentMetadata('README.md', old, updated)).toBe(true);
  expect(
    sameDevelopmentMetadata(
      'README.md',
      old,
      Buffer.from(
        updated.toString().replace('[testing-commands:end]: #\n', '[testing-commands:end]: #\n\n'),
      ),
    ),
  ).toBe(true);
  expect(
    sameDevelopmentMetadata(
      'README.md',
      old,
      Buffer.from(updated.toString().replace('Protected usage.', 'Changed usage.')),
    ),
  ).toBe(false);
});

test.each([
  '[testing-commands:start]: #\nUnclosed\n',
  '[testing-commands:end]: #\n',
  '[testing-commands:start]: #\n[testing-commands:start]: #\n[testing-commands:end]: #\n',
  '[testing-commands:start]: #\n[testing-commands:end]: #\n[testing-commands:start]: #\n[testing-commands:end]: #\n',
])('malformed documentation markers fail closed (%#)', (text) => {
  expect(sameDevelopmentMetadata('README.md', Buffer.from(text), Buffer.from(text))).toBe(false);
});

test('invalid UTF-8 cannot hide a protected metadata change', () => {
  const malformed = Buffer.from([0xff]);
  expect(sameDevelopmentMetadata('README.md', malformed, malformed)).toBe(false);
  expect(sameDevelopmentMetadata('package.json', malformed, malformed)).toBe(false);
});
