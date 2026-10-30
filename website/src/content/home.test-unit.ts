// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

import { HOME_CONTENT } from './index.ts';

// the canonical documents every name on the homepage must come from
const canonical = (
  await Promise.all(
    ['../../../README.md', '../../../api/README.md'].map((path) =>
      readFile(new URL(path, import.meta.url), 'utf8'),
    ),
  )
).join('\n');

const names = [
  ...HOME_CONTENT.map.links.flatMap(({ down, up }) => [...down.items, ...up.items]),
  ...HOME_CONTENT.capabilities.flatMap(({ commands }) => commands),
  ...HOME_CONTENT.more.items.map(({ name }) => name),
];

describe('homepage names', { tags: ['full'] }, () => {
  test.each([...new Set(names)])('%s appears in README.md or api/README.md', (name) => {
    expect(canonical).toContain(name);
  });
});
