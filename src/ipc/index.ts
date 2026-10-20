// framing
export { createLineDecoder } from './framing.js';
export {
  MAX_CONNECTIONS,
  MAX_REQUEST_BYTES,
  MAX_FRAME_BYTES,
  IPC_TIMEOUT_MS,
  CONTROL_SOCKET,
} from './constants.js';

// local command connections
export { createIpcServer } from './server.js';
export { requestAgentHq } from './client.js';
