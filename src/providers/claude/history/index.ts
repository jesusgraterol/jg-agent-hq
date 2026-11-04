// worker-owned projection
export { ClaudeHistoryModel } from './history.model.js';
// private worker contract
export type { IClaudeHistoryRead } from './types.js';

// native content normalization shared by persisted and live presentation
export { toClaudeItem } from './utilities.js';

// transcript location, for readers that count what a transcript records
export { openTranscript, projectDirectory } from './utilities.js';
