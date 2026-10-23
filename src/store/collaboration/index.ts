// worker-owned metadata and delivery transactions
export { CollaborationModel } from './collaboration.model.js';
export { agentSpawnContext, recordAgentSpawn, reserveAgentChild, readAgentSpawn } from './spawn.js';
// native admission joins the existing action transaction
export { prepareDispatch, reserveDispatch } from './dispatch.js';
