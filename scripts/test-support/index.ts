// external native fixture
export { installCodexFixture } from './codex.js';
export { installClaudeFixture } from './claude.js';
export { withClaudeRuntime, claudeRecord, waitForWarmUp } from './claude-runtime.js';
export type { IClaudeFixture } from './claude-runtime.js';

// locks a crashed holder leaves in a state root
export { stateLocks, leaveLock } from './locks.js';

// live fixture configuration
export { writeFixtureControl } from './controls.js';

// held waits, such as idle periods, released by the test
export {
  holdDelays,
  startHoldingDelays,
  stopHoldingDelays,
  countHeldDelays,
  releaseHeldDelays,
} from './delays.js';
