import { describe, expect, test } from 'vitest';

import { readBackgroundEvents } from './utilities.js';

/*
 * Records shaped as Claude Code 2.1.317 writes them, with their content replaced: a command run in
 * or moved to the background, an agent launched in it, a task notification as a message and as a
 * queued input, a task status after a compaction, and a TaskStop call with its result.
 */
const STARTED_AT = Date.parse('2026-11-03T10:00:00.000Z');
const LATER = '2026-11-03T10:05:00.000Z';
const EARLIER = '2026-11-03T09:55:00.000Z';

const backgroundResult = (taskId: string, timestamp = LATER) => ({
  type: 'user',
  isSidechain: false,
  timestamp,
  message: {
    role: 'user',
    content: [
      {
        tool_use_id: 'toolu_start',
        type: 'tool_result',
        content: `Command running in background with ID: ${taskId}. Output is being written to: /tmp/output`,
        is_error: false,
      },
    ],
  },
  toolUseResult: {
    stdout: '',
    stderr: '',
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
    backgroundTaskId: taskId,
  },
});
const movedResult = {
  ...backgroundResult('bmoved01'),
  toolUseResult: {
    stdout: 'partial output',
    stderr: '',
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
    backgroundTaskId: 'bmoved01',
    timedOutAfterMs: 600_000,
  },
};
const agentResult = {
  type: 'user',
  timestamp: LATER,
  message: {
    role: 'user',
    content: [{ tool_use_id: 'toolu_agent', type: 'tool_result', content: 'Launched' }],
  },
  toolUseResult: {
    isAsync: true,
    status: 'async_launched',
    agentId: 'a1b2c3d4e5',
    description: 'Review the change',
    outputFile: '/tmp/agent-output',
  },
};
const notification = (taskId: string, status: string) =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>toolu_start</tool-use-id>\n<output-file>/tmp/output</output-file>\n<status>${status}</status>\n<summary>Background command finished</summary>\n</task-notification>`;
const stopCall = (toolUseId: string, input: object) => ({
  type: 'assistant',
  timestamp: LATER,
  message: {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: toolUseId, name: 'TaskStop', input, caller: { type: 'direct' } },
    ],
  },
});
const stopResult = (toolUseId: string, isError: boolean) => ({
  type: 'user',
  timestamp: LATER,
  message: {
    role: 'user',
    content: [
      {
        tool_use_id: toolUseId,
        type: 'tool_result',
        content: isError
          ? 'No task found with ID: bgone001'
          : '{"message":"Successfully stopped task: bstop001"}',
        ...(isError ? { is_error: true } : {}),
      },
    ],
  },
});
const NONE = { starts: [], ends: [], stopCalls: [], results: [] };

describe('readBackgroundEvents', () => {
  test('readBackgroundEvents(a command run in the background) -> its start', () => {
    expect(readBackgroundEvents(backgroundResult('bs854tb56'), STARTED_AT)).toStrictEqual({
      ...NONE,
      starts: ['bs854tb56'],
      results: [{ toolUseId: 'toolu_start', isSuccess: true }],
    });
  });

  test.each([
    ['a command moved to the background after its timeout', movedResult, 'bmoved01'],
    ['an agent launched in the background', agentResult, 'a1b2c3d4e5'],
  ])('readBackgroundEvents(%s) -> its start', (_case, record, taskId) => {
    expect(readBackgroundEvents(record, STARTED_AT).starts).toStrictEqual([taskId]);
  });

  test.each([
    ['written before the process started', backgroundResult('bold0001', EARLIER), STARTED_AT, []],
    ['without a process start', backgroundResult('bold0001', EARLIER), null, ['bold0001']],
    ['with no time', { ...backgroundResult('bnotime1'), timestamp: undefined }, STARTED_AT, []],
  ])('readBackgroundEvents(a start %s) -> %o', (_case, record, startedAt, starts) => {
    expect(readBackgroundEvents(record, startedAt).starts).toStrictEqual(starts);
  });

  test.each([
    [
      'a notification as a message',
      {
        type: 'user',
        timestamp: LATER,
        message: { role: 'user', content: notification('bs854tb56', 'completed') },
      },
      ['bs854tb56'],
    ],
    [
      'notifications in text blocks',
      {
        type: 'user',
        timestamp: LATER,
        message: {
          role: 'user',
          content: [
            { type: 'text', text: notification('bfail001', 'failed') },
            { type: 'text', text: notification('bkill001', 'killed') },
          ],
        },
      },
      ['bfail001', 'bkill001'],
    ],
    [
      'a queued notification',
      {
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: LATER,
        content: notification('bstop002', 'stopped'),
      },
      ['bstop002'],
    ],
    [
      'a finished task status',
      {
        type: 'attachment',
        timestamp: LATER,
        attachment: {
          type: 'task_status',
          taskId: 'bdone001',
          taskType: 'local_bash',
          status: 'completed',
        },
      },
      ['bdone001'],
    ],
    [
      'a running task status',
      {
        type: 'attachment',
        timestamp: LATER,
        attachment: {
          type: 'task_status',
          taskId: 'brun0001',
          taskType: 'local_bash',
          status: 'running',
        },
      },
      [],
    ],
  ])('readBackgroundEvents(%s) -> ends %o', (_case, record, ends) => {
    expect(readBackgroundEvents(record, STARTED_AT).ends).toStrictEqual(ends);
  });

  test('readBackgroundEvents(a TaskStop call) -> the task it names, by its tool use ID', () => {
    expect(
      readBackgroundEvents(stopCall('toolu_stop', { task_id: 'bstop001' }), STARTED_AT),
    ).toStrictEqual({
      ...NONE,
      stopCalls: [{ toolUseId: 'toolu_stop', taskId: 'bstop001' }],
    });
    expect(
      readBackgroundEvents(
        {
          ...stopCall('toolu_kill', {}),
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_kill',
                name: 'KillShell',
                input: { shell_id: 'bkill002' },
              },
            ],
          },
        },
        STARTED_AT,
      ).stopCalls,
    ).toStrictEqual([{ toolUseId: 'toolu_kill', taskId: 'bkill002' }]);
  });

  test.each([
    ['a stop that succeeded', stopResult('toolu_stop', false), true],
    ['a stop that failed', stopResult('toolu_stop', true), false],
  ])('readBackgroundEvents(%s) -> its result', (_case, record, isSuccess) => {
    expect(readBackgroundEvents(record, STARTED_AT).results).toStrictEqual([
      { toolUseId: 'toolu_stop', isSuccess },
    ]);
  });

  test.each([
    ['a subagent record', { ...backgroundResult('bside001'), isSidechain: true }],
    [
      'a request copy',
      { type: 'api-request-blob', hash: 'h', message: backgroundResult('bcopy001').message },
    ],
    ['a record in another shape', { type: 7 }],
    ['no record', null],
  ])('readBackgroundEvents(%s) -> nothing', (_case, record) => {
    expect(readBackgroundEvents(record, STARTED_AT)).toStrictEqual(NONE);
  });

  test('readBackgroundEvents(a start whose task ID has a path in it) -> no start', () => {
    expect(readBackgroundEvents(backgroundResult('../outside'), STARTED_AT).starts).toStrictEqual(
      [],
    );
  });
});
