import { expect, test } from 'vitest';

import { toClaudeItem } from './index.js';

test('native tool calls and results remain distinguishable from agent messages', () => {
  expect(
    toClaudeItem(
      {
        type: 'assistant',
        uuid: 'tool',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'example.ts' } }],
        },
      },
      'turn',
    ),
  ).toMatchObject({ kind: 'tool', text: 'Read\n{"file_path":"example.ts"}' });
  expect(
    toClaudeItem(
      {
        type: 'user',
        uuid: 'result',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'file contents' }] },
      },
      'turn',
    ),
  ).toMatchObject({ kind: 'tool', text: 'file contents' });
});
