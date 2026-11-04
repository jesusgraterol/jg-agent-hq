// transport
export { retainNativeLineage } from './lineage/index.js';
export type {
  IProviderProcess,
  IProviderFraming,
  INativePrompt,
  IProviderSkills,
  IProviderCall,
  IProviderThread,
  IProviderInspection,
  IProviderReattachment,
  IResyncLoss,
  IAgentProvider,
  IAgentProviderFactory,
  IAgentProviderContext,
  IAgentProviderEvents,
  IAgentProviderOutcome,
} from './types.js';
export { MODEL_CATALOG_UNAVAILABLE, SUPPORTED_PROVIDER_OPERATION } from './constants.js';
export { buildProviderCapabilities } from './utilities.js';
export { createProviderProcess, isOwnedProcess } from './process.js';

// Codex
export {
  createCodexProvider,
  createCodexProviderFactory,
  NativeThreadSchema,
  NativeTurnSchema,
  NativeItemSchema,
  toHistoryItem,
  parseNative,
  parseCodexPrompt,
  buildCodexReply,
  toApprovalPresentation,
} from './codex/index.js';
export type { ICodexProvider, ICodexEvents, ICodexPrompt } from './codex/index.js';

// Claude reads
export {
  createClaudeProvider,
  createClaudeProviderFactory,
  observeClaudeAgents,
} from './claude/index.js';

// Claude control
export { createClaudeControl } from './claude/control/index.js';

// bounded native inputs and complete results
export { readInputFiles } from './inputs/index.js';
export type { IProviderInputFile } from './inputs/index.js';
export { toTurnResult } from './results/index.js';
