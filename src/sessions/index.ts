// native history continuations, item text limits, line counts, diffs and image formats
export {
  decodeHistoryCursor,
  encodeHistoryCursor,
  limitItemText,
  countLines,
  keepTextEnd,
  toWholeFileDiff,
  toImageMediaType,
  describeBase64Image,
} from './utilities.js';

// scoped read orchestration
export type { IClaudeSessions } from './types.js';
export { readActiveSessions, readNativeHistory, readUnstartedThreads } from './sessions.js';
export type { IHistoryRequest } from './types.js';
