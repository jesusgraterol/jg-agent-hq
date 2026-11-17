// @vitest-environment node
import { describe, expect, test } from 'vitest';

import { ActionCommandSchema, HqRequestSchema } from '../../../dist/contracts/index.js';
import { openHostDatabase, restoreHqSnapshot, type IAgentHq } from '../../../dist/index.js';

import { HOME_CONTENT } from './index.ts';

// wire operations advertised by the homepage must exist in the public contracts
const operations = new Set<string>([
  ...ActionCommandSchema.options.map((option) => option.shape.kind.value),
  ...HqRequestSchema.options.map((option) => option.shape.kind.value),
]);
const names = [
  ...HOME_CONTENT.map.links.flatMap(({ down, up }) => [...down.items, ...up.items]),
  ...HOME_CONTENT.capabilities
    .filter(({ id }) => id !== 'storage')
    .flatMap(({ commands }) => commands),
];

describe('homepage names', { tags: ['full'] }, () => {
  test.each([...new Set(names)])('%s is a supported public operation', (name) => {
    expect(operations.has(name)).toBe(true);
  });

  test('the storage capability names public runtime members and callable exports', () => {
    const members = ['storage', 'createSnapshot'] satisfies (keyof IAgentHq)[];
    expect(HOME_CONTENT.capabilities.find(({ id }) => id === 'storage')?.commands).toStrictEqual([
      `hq.${members[0]}`,
      'openHostDatabase',
      members[1],
      'restoreHqSnapshot',
    ]);
    expect(openHostDatabase).toBeTypeOf('function');
    expect(restoreHqSnapshot).toBeTypeOf('function');
  });
});
