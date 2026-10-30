import { expect, test } from 'vitest';

import type { IRecord } from './types.js';
import { toClaudeItem } from './index.js';

const user = (content: unknown, extra: Partial<IRecord> = {}): IRecord => ({
  type: 'user',
  uuid: 'record',
  parentUuid: 'parent',
  message: { role: 'user', content },
  ...extra,
});
const assistant = (content: unknown): IRecord => ({
  type: 'assistant',
  uuid: 'record',
  parentUuid: 'parent',
  message: { role: 'assistant', content },
});
const presented = (record: IRecord) => {
  const item = toClaudeItem(record, 'turn');
  return (
    item && {
      kind: item.kind,
      text: item.text,
      callId: item.callId,
      outcome: item.outcome,
      files: item.files,
    }
  );
};
const editResult = {
  filePath: '/workspace/a.ts',
  oldString: 'old',
  newString: 'new',
  originalFile: 'old\nkept\n',
  structuredPatch: [
    { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-old', '+new', ' kept'] },
  ],
  userModified: false,
  replaceAll: false,
};

test.each([
  ['an operator message', user('Fix the login'), 'user-message', 'Fix the login'],
  [
    'a slash command',
    user(
      '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>the login flow</command-args>',
    ),
    'user-message',
    '/review the login flow',
  ],
  [
    'a slash command without arguments, with its tags in another order',
    user(
      '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>',
    ),
    'user-message',
    '/clear',
  ],
  [
    'local command output',
    user('<local-command-stdout>Compacted the conversation</local-command-stdout>'),
    'notice',
    'Compacted the conversation',
  ],
  [
    'a compaction summary',
    user('This session is being continued.', { isCompactSummary: true }),
    'notice',
    'This session is being continued.',
  ],
  [
    'an interruption marker',
    user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
    'notice',
    '[Request interrupted by user for tool use]',
  ],
  ['an agent message', assistant([{ type: 'text', text: 'Done.' }]), 'agent-message', 'Done.'],
  [
    'an agent message after its thinking',
    assistant([
      { type: 'thinking', thinking: 'private', signature: 'sig' },
      { type: 'text', text: 'Visible' },
    ]),
    'agent-message',
    'Visible',
  ],
  [
    'an image the operator sent',
    user([
      { type: 'text', text: 'Look' },
      { type: 'image', source: {} },
    ]),
    'user-message',
    'Look\n[Native image]',
  ],
  [
    'a record without content',
    { type: 'user', uuid: 'record', message: { role: 'user', content: undefined } },
    'unsupported',
    '[Unsupported native content]',
  ],
  [
    'another native record type',
    { type: 'system', uuid: 'record', message: { role: 'system', content: 'x' } },
    'unsupported',
    '[Unsupported native content]',
  ],
])('toClaudeItem(%s) presents it as the CLI does', (_label, record, kind, text) => {
  expect(presented(record)).toStrictEqual({ kind, text, callId: null, outcome: null, files: [] });
});

test.each([
  ['a thinking block', assistant([{ type: 'thinking', thinking: 'private', signature: 'sig' }])],
  ['a redacted thinking block', assistant([{ type: 'redacted_thinking', data: 'opaque' }])],
  [
    'a task notification',
    user('<task-notification>\n<task-id>abc</task-id>\n</task-notification>'),
  ],
])('toClaudeItem(%s) -> null', (_label, record) => {
  expect(toClaudeItem(record, 'turn')).toBeNull();
});

test.each([
  ['2026-10-28T09:15:30.250Z', 1_793_178_930_250],
  [undefined, null],
  ['not a time', null],
])('toClaudeItem(timestamp %s) -> createdAt %s', { tags: ['full'] }, (timestamp, createdAt) => {
  expect(toClaudeItem(user('Fix the login', { timestamp }), 'turn')?.createdAt).toBe(createdAt);
});

test('a shell input and its output are commands paired by the input UUID', () => {
  expect(
    presented({ ...user('<bash-input> git status</bash-input>'), uuid: 'shell-input' }),
  ).toStrictEqual({
    kind: 'command',
    text: 'git status',
    callId: 'shell-input',
    outcome: null,
    files: [],
  });
  expect(
    presented(
      user('<bash-stdout>On branch main</bash-stdout><bash-stderr>warning</bash-stderr>', {
        parentUuid: 'shell-input',
      }),
    ),
  ).toStrictEqual({
    kind: 'command',
    text: 'On branch main\nwarning',
    callId: 'shell-input',
    outcome: null,
    files: [],
  });
});

test('a tool call and its result pair by the call ID, and a record of several calls has none', () => {
  expect(
    presented(
      assistant([
        { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'example.ts' } },
      ]),
    ),
  ).toStrictEqual({
    kind: 'tool',
    text: 'Read\n{"file_path":"example.ts"}',
    callId: 'toolu_read',
    outcome: null,
    files: [],
  });
  expect(
    presented(user([{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'contents' }])),
  ).toStrictEqual({
    kind: 'tool',
    text: 'contents',
    callId: 'toolu_read',
    outcome: 'succeeded',
    files: [],
  });
  expect(
    presented(
      assistant([
        { type: 'tool_use', id: 'toolu_a', name: 'Read', input: {} },
        { type: 'tool_use', id: 'toolu_b', name: 'Grep', input: {} },
      ]),
    ),
  ).toMatchObject({ kind: 'tool', callId: null });
});

test.each([
  [true, 'failed'],
  [false, 'succeeded'],
  [undefined, 'succeeded'],
])('a tool result with is_error %s -> %s', (isError, outcome) => {
  expect(
    presented(
      user([{ type: 'tool_result', tool_use_id: 'toolu', content: 'out', is_error: isError }]),
    )?.outcome,
  ).toBe(outcome);
});

test('a result saved to a file reads as its size and preview, without its path', () => {
  const content =
    '<persisted-output>\nOutput too large (45.2KB). Full output saved to: /home/user/.claude/tool-results/b1.txt\n\nPreview (first 2KB):\nline one\nline two\n</persisted-output>\nShell cwd was reset to /workspace';
  expect(
    presented(user([{ type: 'tool_result', tool_use_id: 'toolu', content, is_error: false }])),
  ).toStrictEqual({
    kind: 'tool',
    text: 'Output too large (45.2KB), saved to a file\nline one\nline two\nShell cwd was reset to /workspace',
    callId: 'toolu',
    outcome: 'succeeded',
    files: [],
  });
});

test('Edit and Write results are file changes, and a created file counts every line as added', () => {
  expect(
    presented(
      user([{ type: 'tool_result', tool_use_id: 'toolu_edit', content: 'updated' }], {
        toolUseResult: editResult,
      }),
    ),
  ).toStrictEqual({
    kind: 'file-change',
    text: '/workspace/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n kept',
    callId: 'toolu_edit',
    outcome: 'succeeded',
    files: [{ path: '/workspace/a.ts', added: 1, removed: 1 }],
  });
  expect(
    presented(
      user([{ type: 'tool_result', tool_use_id: 'toolu_write', content: 'created' }], {
        toolUseResult: {
          type: 'create',
          filePath: '/workspace/b.ts',
          content: 'one\ntwo\nthree\n',
          structuredPatch: [],
          originalFile: null,
        },
      }),
    ),
  ).toStrictEqual({
    kind: 'file-change',
    text: '/workspace/b.ts\none\ntwo\nthree\n',
    callId: 'toolu_write',
    outcome: 'succeeded',
    files: [{ path: '/workspace/b.ts', added: 3, removed: 0 }],
  });
  expect(
    presented(
      user([{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'listing' }], {
        toolUseResult: { stdout: 'listing', stderr: '', interrupted: false },
      }),
    ),
  ).toMatchObject({ kind: 'tool', files: [] });
});

test('outcome and files come from the full record before the text is cut', () => {
  const lines = Array.from({ length: 40_000 }, (_, index) => `+line ${index}`);
  const item = toClaudeItem(
    user([{ type: 'tool_result', tool_use_id: 'toolu_edit', content: 'updated', is_error: true }], {
      toolUseResult: {
        ...editResult,
        structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 40_000, lines }],
      },
    }),
    'turn',
  );
  expect(item?.isTruncated).toBe(true);
  expect(item?.text).toHaveLength(65_536);
  expect(item?.outcome).toBe('failed');
  expect(item?.files).toStrictEqual([{ path: '/workspace/a.ts', added: 40_000, removed: 0 }]);
});
