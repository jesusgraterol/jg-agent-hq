import { afterEach, expect, test, vi } from 'vitest';

import type { IHistoryItem } from '../../../contracts/index.js';

import { receiveClaudeMessage } from './stream.js';
import type { IClaudeControlEvents, IClaudeSession } from './types.js';

const createSession = (): IClaudeSession => ({
  id: 'session',
  workspaceRoot: '/workspace',
  settings: {},
  scope: 'scope',
  isClosing: false,
  hasInput: true,
  opening: Promise.resolve(),
  previews: new Map(),
  requests: new Map(),
  input: {
    id: 'input',
    requestId: 'request',
    isAcknowledged: true,
    interruptRequested: false,
    hasInterruptionMarker: false,
    finalText: null,
    isOutputOversized: false,
    resolve: () => undefined,
    reject: () => undefined,
    timer: setTimeout(() => undefined, 0),
  },
});
const createEvents = () => {
  const items: { item: IHistoryItem; isComplete: boolean; replacedIds?: string[] }[] = [];
  const events: IClaudeControlEvents = {
    observe: () => undefined,
    item: (_nativeId, item, isComplete, replacedIds) => {
      items.push({ item, isComplete, replacedIds });
    },
    gap: () => undefined,
    delta: () => undefined,
    prompt: () => undefined,
    outcome: () => undefined,
    unavailable: () => undefined,
  };
  return { events, items };
};
const streamEvent = (event: unknown) => ({ type: 'stream_event', session_id: 'session', event });

afterEach(() => {
  vi.useRealTimers();
});

test('live frames and previews present what history will: thinking and notifications left out, edits as file changes', () => {
  const session = createSession();
  const { events, items } = createEvents();
  const receive = (frame: unknown) => receiveClaudeMessage(session, frame, events);
  receive(streamEvent({ type: 'message_start', message: { id: 'api-thinking' } }));
  receive(
    streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
  );
  receive(
    streamEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'private' },
    }),
  );
  receive({
    type: 'assistant',
    session_id: 'session',
    uuid: 'thinking-record',
    message: {
      id: 'api-thinking',
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'private', signature: 'sig' }],
    },
  });
  receive(streamEvent({ type: 'message_start', message: { id: 'api-edit' } }));
  receive(
    streamEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: {} },
    }),
  );
  receive({
    type: 'assistant',
    session_id: 'session',
    uuid: 'edit-call',
    message: {
      id: 'api-edit',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: { file_path: 'a.ts' } }],
    },
  });
  receive({
    type: 'user',
    session_id: 'session',
    uuid: 'edit-result',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_edit', content: 'ok' }],
    },
    tool_use_result: {
      filePath: '/workspace/a.ts',
      structuredPatch: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-old', '+new', '+more'] },
      ],
    },
  });
  receive({
    type: 'user',
    session_id: 'session',
    uuid: 'write-result',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_write', content: 'created' }],
    },
    tool_use_result: {
      type: 'create',
      filePath: '/workspace/b.ts',
      content: 'one\ntwo\nthree',
      structuredPatch: [],
    },
  });
  receive({
    type: 'user',
    session_id: 'session',
    uuid: 'notification',
    message: { role: 'user', content: '<task-notification>\n</task-notification>' },
  });
  expect(
    items.map(({ item, isComplete, replacedIds }) => ({
      nativeId: item.nativeId,
      kind: item.kind,
      callId: item.callId,
      outcome: item.outcome,
      files: item.files,
      isComplete,
      replacedIds,
    })),
  ).toStrictEqual([
    {
      nativeId: 'live:input:api-edit:0',
      kind: 'tool',
      callId: 'toolu_edit',
      outcome: null,
      files: [],
      isComplete: false,
      replacedIds: undefined,
    },
    {
      nativeId: 'edit-call',
      kind: 'tool',
      callId: 'toolu_edit',
      outcome: null,
      files: [],
      isComplete: true,
      replacedIds: ['live:input:api-edit:0'],
    },
    {
      nativeId: 'edit-result',
      kind: 'file-change',
      callId: 'toolu_edit',
      outcome: 'succeeded',
      files: [{ path: '/workspace/a.ts', added: 2, removed: 1 }],
      isComplete: true,
      replacedIds: [],
    },
    {
      nativeId: 'write-result',
      kind: 'file-change',
      callId: 'toolu_write',
      outcome: 'succeeded',
      files: [{ path: '/workspace/b.ts', added: 3, removed: 0 }],
      isComplete: true,
      replacedIds: [],
    },
  ]);
  expect(session.previews.size).toBe(0);
});

test(
  'a live item is timed when its frame arrives, a preview and its record alike',
  { tags: ['full'] },
  () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const session = createSession();
    const { events, items } = createEvents();
    vi.setSystemTime(new Date('2026-10-28T09:00:00.000Z'));
    receiveClaudeMessage(
      session,
      streamEvent({ type: 'message_start', message: { id: 'api' } }),
      events,
    );
    receiveClaudeMessage(
      session,
      streamEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      events,
    );
    vi.setSystemTime(new Date('2026-10-28T09:00:05.000Z'));
    receiveClaudeMessage(
      session,
      {
        type: 'assistant',
        session_id: 'session',
        uuid: 'answer',
        message: { id: 'api', role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
      },
      events,
    );
    expect(items.map(({ item }) => [item.nativeId, item.createdAt])).toStrictEqual([
      ['live:input:api:0', Date.parse('2026-10-28T09:00:00.000Z')],
      ['answer', Date.parse('2026-10-28T09:00:05.000Z')],
    ]);
  },
);

test('an MCP tool request prompts for approval and writes nothing', async () => {
  const written: unknown[] = [];
  const prompts: unknown[] = [];
  // the native connection is large; these frames only write to it
  const connection = {
    write: async (message: unknown) => {
      written.push(message);
    },
  } as unknown as NonNullable<IClaudeSession['connection']>;
  const session: IClaudeSession = { ...createSession(), connection };
  const { events } = createEvents();
  receiveClaudeMessage(
    session,
    {
      type: 'control_request',
      session_id: 'session',
      request_id: 'native-request',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'mcp__fixture-server__inspect',
        tool_use_id: 'tool-request',
        input: { repository: 'example' },
      },
    },
    { ...events, prompt: (prompt) => prompts.push(prompt) },
  );
  await Promise.resolve();
  expect(written).toHaveLength(0);
  expect(prompts).toHaveLength(1);
});
