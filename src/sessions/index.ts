// native history continuations, item text limits, line counts, diffs and images
export {
  createRequestCursors,
  decodeHistoryCursor,
  encodeHistoryCursor,
  limitItemText,
  countLines,
  keepTextEnd,
  toWholeFileDiff,
  toImageMediaType,
  describeBase64Image,
  imageUnavailable,
  toItemImage,
  decodeBase64Image,
} from './utilities.js';

// image files an item names
export { readImageFile } from './images.js';

// scoped read orchestration
export type { IClaudeSessions } from './types.js';
export { readActiveSessions, readNativeHistory } from './sessions.js';
export type { IHistoryRequest } from './types.js';

// discovery across folders and providers
export { readThreads } from './discovery/index.js';
