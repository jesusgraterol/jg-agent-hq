// external native fixture
export { installCodexFixture } from './codex.js';
export { installClaudeFixture } from './claude.js';
export { withClaudeRuntime, claudeRecord } from './claude-runtime.js';
export type { IClaudeFixture } from './claude-runtime.js';

// live fixture configuration
export { writeFixtureControl } from './controls.js';

// collaboration integration setup
export { withCollaboration } from './collaboration.js';
export type { ICollaborationFixture } from './collaboration.js';

// native tool connections
export { callCodexTool, withAgentBridge } from './agent-tools.js';
