// limits bound simultaneous local clients and all buffered protocol input
export const MAX_CONNECTIONS = 32;
export const MAX_REQUEST_BYTES = 65_536;
export const MAX_FRAME_BYTES = 8_388_608;
export const IPC_TIMEOUT_MS = 35_000;
export const CONTROL_SOCKET = 'hq.sock';
