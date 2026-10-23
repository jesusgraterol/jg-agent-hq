// verified native session and task context
export {
  NativeToolBindingSchema,
  AgentIdentityQuerySchema,
  AgentIdentitySchema,
  AgentSpawnAdmissionSchema,
  AgentSpawnReadSchema,
  AgentSpawnRecordSchema,
} from './types.js';

// private native bridge credentials
export { createAgentCredentials, readBridgeCredential } from './credentials.js';
export type { IAgentCredentialLease, IBridgeCredential } from './types.js';
export type {
  INativeToolBinding,
  IAgentIdentityQuery,
  IAgentIdentity,
  IAgentSpawnAdmission,
  IAgentSpawnRead,
  IAgentSpawnRecord,
} from './types.js';
