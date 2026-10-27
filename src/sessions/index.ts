// native history continuations, item text limits and line counts
export {
  decodeHistoryCursor,
  encodeHistoryCursor,
  limitItemText,
  countLines,
} from './utilities.js';

// scoped read orchestration
export { readNativeHistory } from './sessions.js';
export type { IHistoryRequest } from './types.js';
