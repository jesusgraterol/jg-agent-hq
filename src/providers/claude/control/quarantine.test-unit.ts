import { expect, test } from 'vitest';

import { createClaudeQuarantineMonitor } from './quarantine.js';

test('default zero and partial task notifications never prove a known empty full snapshot', () => {
  const monitor = createClaudeQuarantineMonitor();
  expect(monitor.backgroundCount).toBe(0);
  expect(monitor.canStop(monitor.revision)).toBe(false);
  monitor.observe({ type: 'system', subtype: 'task_notification', status: 'completed' });
  expect(monitor.canStop(monitor.revision)).toBe(false);
  monitor.observe({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [],
    additive: true,
  });
  expect(monitor.canStop(monitor.revision)).toBe(true);
});

test.each(['task_started', 'task_progress', 'task_updated', 'task_notification'])(
  'partial %s activity after an empty snapshot leaves task emptiness unknown until a new full snapshot',
  (subtype) => {
    const monitor = createClaudeQuarantineMonitor();
    monitor.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    expect(monitor.canStop(monitor.revision)).toBe(true);
    monitor.observe({ type: 'system', subtype, task_id: 'native-work' });
    expect(monitor.backgroundCount).toBe(0);
    expect(monitor.canStop(monitor.revision)).toBe(false);
    monitor.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    expect(monitor.canStop(monitor.revision)).toBe(true);
  },
);

test('a new native frame or completed write invalidates an earlier inventory revision', () => {
  const monitor = createClaudeQuarantineMonitor();
  monitor.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  const revision = monitor.revision;
  monitor.observe({ type: 'assistant', future: true });
  expect(monitor.canStop(revision)).toBe(false);
  expect(monitor.canStop(monitor.revision)).toBe(true);
  const beforeWrite = monitor.revision;
  monitor.written({ type: 'user', uuid: 'input' });
  expect(monitor.canStop(beforeWrite)).toBe(false);
});

test('nonempty and malformed full snapshots prevent cleanup and preserve the last known count', () => {
  const monitor = createClaudeQuarantineMonitor();
  monitor.observe({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'task' }],
  });
  expect(monitor.backgroundCount).toBe(1);
  expect(monitor.canStop(monitor.revision)).toBe(false);
  monitor.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: 'unknown' });
  expect(monitor.backgroundCount).toBe(1);
  expect(monitor.canStop(monitor.revision)).toBe(false);
  monitor.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  expect(monitor.canStop(monitor.revision)).toBe(true);
});

test('permission replies require matching native tool completion or cancellation', () => {
  const monitor = createClaudeQuarantineMonitor();
  monitor.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  monitor.observe({
    type: 'control_request',
    request_id: 'approval',
    request: { subtype: 'can_use_tool', tool_use_id: 'tool' },
  });
  monitor.written({ type: 'control_response', response: { request_id: 'approval' } });
  expect(monitor.canStop(monitor.revision)).toBe(false);
  monitor.observe({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'other' }] },
  });
  expect(monitor.canStop(monitor.revision)).toBe(false);
  monitor.observe({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool' }] },
  });
  expect(monitor.canStop(monitor.revision)).toBe(true);
  monitor.observe({
    type: 'control_request',
    request_id: 'waiting',
    request: { subtype: 'future_request' },
  });
  expect(monitor.canStop(monitor.revision)).toBe(false);
  monitor.observe({ type: 'control_cancel_request', request_id: 'waiting' });
  expect(monitor.canStop(monitor.revision)).toBe(true);
});

test('a correlated one-way elicitation resolves only after its actual reply write', () => {
  const monitor = createClaudeQuarantineMonitor();
  monitor.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  monitor.observe({
    type: 'control_request',
    request_id: 'elicitation',
    request: { subtype: 'elicitation' },
  });
  monitor.written({ type: 'control_response', response: { request_id: 'other' } });
  expect(monitor.canStop(monitor.revision)).toBe(false);
  monitor.written({ type: 'control_response', response: { request_id: 'elicitation' } });
  expect(monitor.canStop(monitor.revision)).toBe(true);
});

test.each(['malformed', 'duplicate', 'capacity'])(
  'unverifiable %s native requests remain unknown even after known requests cancel',
  (mode) => {
    const monitor = createClaudeQuarantineMonitor();
    monitor.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    if (mode === 'malformed') monitor.observe({ type: 'control_request', request: {} });
    else {
      const count = mode === 'capacity' ? 33 : 2;
      for (let index = 0; index < count; index += 1)
        monitor.observe({
          type: 'control_request',
          request_id: mode === 'capacity' ? `request-${index}` : 'same',
          request: { subtype: 'future_request' },
        });
      for (let index = 0; index < count; index += 1)
        monitor.observe({
          type: 'control_cancel_request',
          request_id: mode === 'capacity' ? `request-${index}` : 'same',
        });
    }
    expect(monitor.canStop(monitor.revision)).toBe(false);
  },
);

test('the complete 32-request cohort can cancel without inventing an overflow', () => {
  const monitor = createClaudeQuarantineMonitor();
  monitor.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  for (let index = 0; index < 32; index += 1)
    monitor.observe({
      type: 'control_request',
      request_id: `request-${index}`,
      request: { subtype: 'future_request' },
    });
  expect(monitor.canStop(monitor.revision)).toBe(false);
  for (let index = 0; index < 32; index += 1)
    monitor.observe({ type: 'control_cancel_request', request_id: `request-${index}` });
  expect(monitor.canStop(monitor.revision)).toBe(true);
});

test('an oversized task snapshot remains unknown without truncating its count to empty', () => {
  const monitor = createClaudeQuarantineMonitor();
  const tasks = Array.from({ length: 1024 }, (_, index) => ({ task_id: `task-${index}` }));
  monitor.observe({ type: 'system', subtype: 'background_tasks_changed', tasks });
  expect(monitor.backgroundCount).toBe(1024);
  monitor.observe({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [...tasks, { task_id: 'overflow' }],
  });
  expect(monitor.backgroundCount).toBe(1024);
  expect(monitor.canStop(monitor.revision)).toBe(false);
  monitor.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  expect(monitor.canStop(monitor.revision)).toBe(true);
});
