// worker-owned projection
export { ClaudeHistoryModel } from './history.model.js';
// private worker contract
export { ClaudeHistoryReadSchema } from './types.js';
export type { IClaudeHistoryRead } from './types.js';

// native content normalization shared by persisted and live presentation
export { RecordSchema } from './types.js';
export { toClaudeItem } from './utilities.js';

// transcript location, for readers that count what a transcript records
export { openTranscript, projectDirectory } from './utilities.js';
