import { expectToThrowCode } from 'jg-exception/testing';
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
  isResumed: false,
  backgroundTaskCount: 0,
  opening: Promise.resolve(),
  previews: new Map(),
  requests: new Map(),
  steers: new Map(),
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
    background: () => undefined,
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

test("a skill's text, which Claude adds as a synthetic user message, stays out of the live items as it does of history", () => {
  const session = createSession();
  const { events, items } = createEvents();
  const receive = (frame: unknown) => receiveClaudeMessage(session, frame, events);
  receive({
    type: 'user',
    session_id: 'session',
    uuid: 'skill-text',
    isSynthetic: true,
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Base directory for this skill: /skills/example' }],
    },
  });
  receive({
    type: 'user',
    session_id: 'session',
    uuid: 'operator-text',
    message: { role: 'user', content: 'Use the example skill' },
  });
  expect(items.map(({ item }) => [item.nativeId, item.kind])).toStrictEqual([
    ['operator-text', 'user-message'],
  ]);
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

test("a result without a user message while no turn of Claude's own runs makes the session unavailable", () => {
  const { events } = createEvents();
  expectToThrowCode(
    () =>
      receiveClaudeMessage(
        { ...createSession(), input: undefined },
        { type: 'result', session_id: 'session', subtype: 'success', is_error: false },
        events,
      ),
    'JG_AGENT_HQ_CLAUDE_FAILED',
    'The Claude integration failed',
  );
});

test('input replayed while a turn Claude started still runs makes the session unavailable', () => {
  const session: IClaudeSession = {
    ...createSession(),
    input: { ...createSession().input!, isAcknowledged: false },
    nativeTurn: { id: 'native', interruptRequested: false, hasInterruptionMarker: false },
  };
  const { events } = createEvents();
  expectToThrowCode(
    () =>
      receiveClaudeMessage(
        session,
        {
          type: 'user',
          session_id: 'session',
          uuid: 'input',
          message: { role: 'user', content: 'Waiting request' },
        },
        events,
      ),
    'JG_AGENT_HQ_CLAUDE_FAILED',
    'The Claude integration failed',
  );
});

// a frame of the subagent an Agent call started, which names that call
const subagent = (frame: Record<string, unknown>) => ({
  ...frame,
  session_id: 'session',
  parent_tool_use_id: 'toolu_agent',
});

test("a subagent's frames show no live item and the session's own still do, as history leaves sidechains out", () => {
  const session = createSession();
  const { events, items } = createEvents();
  const receive = (frame: unknown) => receiveClaudeMessage(session, frame, events);
  receive(
    subagent({
      type: 'user',
      uuid: 'sub-prompt',
      message: { role: 'user', content: 'Read the official pages' },
    }),
  );
  receive(subagent(streamEvent({ type: 'message_start', message: { id: 'api-sub' } })));
  receive(
    subagent(
      streamEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
    ),
  );
  receive(
    subagent({
      type: 'assistant',
      uuid: 'sub-fetch',
      message: {
        id: 'api-sub',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_fetch', name: 'WebFetch', input: { url: 'x' } }],
      },
    }),
  );
  expect(items).toStrictEqual([]);
  receive({
    type: 'assistant',
    session_id: 'session',
    parent_tool_use_id: null,
    uuid: 'answer',
    message: { id: 'api-main', role: 'assistant', content: [{ type: 'text', text: 'The answer' }] },
  });
  expect(items.map(({ item }) => [item.nativeId, item.text])).toStrictEqual([
    ['answer', 'The answer'],
  ]);
  // a subagent's text is never the turn's result
  expect(session.input?.finalText).toBe('The answer');
});

test("a background subagent's frames after the session's turn start no turn of Claude's own", () => {
  const session: IClaudeSession = { ...createSession(), input: undefined };
  const observed: string[] = [];
  const { events, items } = createEvents();
  receiveClaudeMessage(
    session,
    subagent({
      type: 'assistant',
      uuid: 'sub-fetch',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Still reading' }] },
    }),
    { ...events, observe: (observation) => observed.push(observation.kind) },
  );
  expect(session.nativeTurn).toBeUndefined();
  expect(observed).toStrictEqual([]);
  expect(items).toStrictEqual([]);
});

test("a subagent's tool result still settles the approval it asked for", () => {
  const session = createSession();
  session.requests.set('native-request', {
    toolId: 'toolu_fetch',
    scopedId: 'scoped-request',
    fingerprint: 'fingerprint',
    isWritten: true,
  });
  const resolved: string[] = [];
  const { events } = createEvents();
  receiveClaudeMessage(
    session,
    subagent({
      type: 'user',
      uuid: 'sub-result',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_fetch', content: 'Fetched' }],
      },
    }),
    {
      ...events,
      observe: (observation) => {
        if (observation.kind === 'request-resolved') resolved.push(observation.requestId);
      },
    },
  );
  expect(resolved).toStrictEqual(['scoped-request']);
  expect(session.requests.size).toBe(0);
});

// the input's turn and the steer written into it, each a UUID, as results name them
const INPUT = '11111111-1111-4111-8111-111111111111';
const STEER = '22222222-2222-4222-8222-222222222222';

// a steer HQ wrote into the input's turn, with what it settled with
const addSteer = (session: IClaudeSession) => {
  session.input!.id = INPUT;
  const settled: { turnId?: string; error?: unknown } = {};
  session.steers.set(STEER, {
    id: STEER,
    turnId: INPUT,
    resolve: (turnId) => {
      settled.turnId = turnId;
    },
    reject: (error) => {
      settled.error = error;
    },
  });
  return settled;
};
const userFrame = (uuid: string, content: unknown) => ({
  type: 'user',
  session_id: 'session',
  uuid,
  message: { role: 'user', content },
});
const resultFrame = (userMessageUuid: string) => ({
  type: 'result',
  session_id: 'session',
  subtype: 'success',
  is_error: false,
  user_message_uuid: userMessageUuid,
  result: 'Done',
});

test('a steer Claude replays at a tool boundary joins the turn it named, which ends with one result', () => {
  const session = createSession();
  const { events, items } = createEvents();
  const observed: unknown[] = [];
  events.observe = (observation) => observed.push(observation);
  const settled = addSteer(session);

  receiveClaudeMessage(session, userFrame(STEER, 'Also run the linter.'), events);

  expect(settled).toStrictEqual({ turnId: INPUT });
  expect(session.steers.size).toBe(0);
  expect(session.nativeTurn).toBeUndefined();
  expect(items.map(({ item }) => [item.kind, item.turnId, item.text])).toStrictEqual([
    ['user-message', INPUT, 'Also run the linter.'],
  ]);
  receiveClaudeMessage(session, resultFrame(INPUT), events);
  expect(observed).toStrictEqual([
    expect.objectContaining({ kind: 'turn-completed', nativeTurnId: INPUT, state: 'completed' }),
  ]);
});

test("a steer Claude replays after its turn's result runs as the next turn, which its result ends", () => {
  vi.useFakeTimers();
  const session = createSession();
  const { events, items } = createEvents();
  const observed: { kind: string; nativeTurnId?: string }[] = [];
  events.observe = (observation) => observed.push(observation);
  const settled = addSteer(session);

  // written while the final answer streamed, so Claude ends the turn first
  receiveClaudeMessage(session, resultFrame(INPUT), events);
  expect(settled).toStrictEqual({});
  receiveClaudeMessage(session, userFrame(STEER, 'Also add a summary.'), events);
  vi.advanceTimersByTime(60_000);

  expect(settled).toStrictEqual({ turnId: INPUT });
  expect(session.nativeTurn?.id).toBe(STEER);
  receiveClaudeMessage(
    session,
    {
      type: 'assistant',
      session_id: 'session',
      uuid: 'answer',
      message: {
        id: 'api-answer',
        role: 'assistant',
        content: [{ type: 'text', text: 'Summary' }],
      },
    },
    events,
  );
  receiveClaudeMessage(session, resultFrame(STEER), events);

  expect(items.map(({ item }) => [item.kind, item.turnId])).toStrictEqual([
    ['user-message', STEER],
    ['agent-message', STEER],
  ]);
  // the operator's steer started it, under its own UUID
  expect(observed.map(({ kind, nativeTurnId }) => [kind, nativeTurnId])).toStrictEqual([
    ['turn-completed', INPUT],
    ['turn-started', STEER],
    ['turn-completed', STEER],
  ]);
  expect(session.nativeTurn).toBeUndefined();
});

test('a steer Claude never replays fails 30 seconds after the turn it named ended', () => {
  vi.useFakeTimers();
  const session = createSession();
  const { events } = createEvents();
  const settled = addSteer(session);

  receiveClaudeMessage(session, resultFrame(INPUT), events);
  vi.advanceTimersByTime(29_999);
  expect(settled).toStrictEqual({});
  vi.advanceTimersByTime(1);

  expect(settled.error).toMatchObject({ code: 'JG_AGENT_HQ_CLAUDE_FAILED' });
  expect(session.steers.size).toBe(0);
});

test("Claude's background command reports set the session's count, and report each change once", () => {
  const session = createSession();
  const { events } = createEvents();
  const counts: [string, number][] = [];
  events.background = (nativeId, count) => counts.push([nativeId, count]);
  const report = (tasks: unknown[]) =>
    receiveClaudeMessage(
      session,
      { type: 'system', session_id: 'session', subtype: 'background_tasks_changed', tasks },
      events,
    );
  const task = { task_id: 'task-1', run_id: 'run-1', description: 'e2e', task_type: 'local_bash' };

  report([task]);
  report([task]);
  report([]);

  expect(counts).toStrictEqual([
    ['session', 1],
    ['session', 0],
  ]);
  expect(session.backgroundTaskCount).toBe(0);
});
