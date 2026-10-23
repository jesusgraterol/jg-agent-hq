// transport
export { retainNativeLineage } from './lineage/index.js';
export type {
  IProviderProcess,
  INativePrompt,
  IProviderSkills,
  IProviderCall,
  IProviderThread,
  IProviderInspection,
  IAgentProvider,
  IAgentProviderFactory,
  IAgentProviderContext,
  IAgentProviderEvents,
  IAgentProviderOutcome,
} from './types.js';
export { ProviderThreadSchema, ProviderInspectionSchema, ProviderSkillsSchema } from './types.js';
export { PROVIDER_INPUT_SCHEMA, SUPPORTED_PROVIDER_OPERATION } from './constants.js';
export { createProviderProcess } from './process.js';

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
export { createClaudeProvider, createClaudeProviderFactory } from './claude/index.js';

// Claude control
export { createClaudeControl } from './claude/control/index.js';

// bounded native inputs and complete results
export { readInputFiles } from './inputs/index.js';
export type { IProviderInputFile } from './inputs/index.js';
export type {
  IProviderMcpServerPage,
  IProviderMcpTools,
  IProviderMcpResources,
} from './extensions/index.js';
export { toTurnResult } from './results/index.js';
