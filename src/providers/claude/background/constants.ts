// the bytes one read of a transcript takes, and the longest record the history reader accepts
export const CHUNK_BYTES = 65_536;
export const MAX_RECORD_BYTES = 33_554_432;

// the bytes one poll reads across every listed transcript, and one session read on its own
export const READ_BUDGET_BYTES = 67_108_864;

/*
 * The tasks tracked per session, and the stop calls, tool results and ended tasks remembered so a
 * call and its result, or a task's start and end, pair in whichever order Claude Code wrote them.
 */
export const MAX_TRACKED_TASKS = 256;
export const MAX_PENDING_STOPS = 64;
export const MAX_ENDED_TASKS = 256;

// a line holding one of these may start or end a background task, so it is read whole
export const TASK_MARKERS = [
  'backgroundTaskId',
  '"isAsync":true',
  'task-notification',
  'task_status',
  '"TaskStop"',
  '"KillShell"',
];

// a tool result can answer a stop call; a longer one is a command's output, never a stop's answer
export const RESULT_MARKER = '"tool_result"';
export const MAX_RESULT_LINE_BYTES = 65_536;
