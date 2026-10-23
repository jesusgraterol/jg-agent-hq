import { z } from 'zod';

import {
  MAX_PAGE_SIZE,
  type IHistoryItem,
  type INativeSkillInput,
  type IThreadSummary,
  type ITurnSummary,
  type IUsageSnapshot,
  type IProviderModel,
  type IConfigurationRequest,
  type ISessionConfiguration,
  type ISessionSettings,
  type ITurnSettings,
  type IOutputSchema,
  type IAccountObservation,
  type IAccountControlCommand,
  type IExtensionControlCommand,
  type ILoginObservation,
  type INativeControlResult,
} from '../../contracts/index.js';
import type { IProviderInputFile } from '../inputs/index.js';
import type { IAgentProviderOutcome } from '../index.js';
import type { IProviderSkills } from '../types.js';
import type {
  IProviderMcpServerPage,
  IProviderMcpTools,
  IProviderMcpResources,
} from '../extensions/index.js';

// additive native responses are narrowed to fields this adapter actually uses
export const NativeThreadSchema = z.object({
  id: z.string().min(1).max(4096),
  sessionId: z.string().min(1).max(4096).nullable().optional(),
  parentThreadId: z.string().min(1).max(4096).nullable().optional(),
  forkedFromId: z.string().min(1).max(4096).nullable().optional(),
  cwd: z.string().min(1).max(4096),
  name: z.string().nullable().optional(),
  createdAt: z.number().int().safe(),
  updatedAt: z.number().int().safe(),
  status: z.object({ type: z.enum(['notLoaded', 'idle', 'systemError', 'active']) }),
});
export const NativeTurnSchema = z.object({
  id: z.string().min(1).max(4096),
  status: z.enum(['completed', 'interrupted', 'failed', 'inProgress']),
  startedAt: z.number().int().safe().nullable().optional(),
  completedAt: z.number().int().safe().nullable().optional(),
});
export const NativeItemSchema = z.object({
  turnId: z.string().min(1).max(4096),
  item: z
    .object({ id: z.string().min(1).max(4096), type: z.string().min(1).max(256) })
    .catchall(z.unknown()),
});
export const NativeThreadPageSchema = z.object({
  data: z.array(NativeThreadSchema).max(MAX_PAGE_SIZE),
  nextCursor: z.string().min(1).max(8192).nullable(),
});
export const NativeTurnPageSchema = z.object({
  data: z.array(NativeTurnSchema).max(MAX_PAGE_SIZE),
  nextCursor: z.string().min(1).max(8192).nullable(),
});
export const NativeItemPageSchema = z.object({
  data: z.array(NativeItemSchema).max(MAX_PAGE_SIZE),
  nextCursor: z.string().min(1).max(8192).nullable(),
});
const NativeWindowSchema = z.object({
  usedPercent: z.number().finite().nonnegative(),
  windowDurationMins: z.number().int().positive().nullable().optional(),
  resetsAt: z.number().int().safe().nullable().optional(),
});
export const NativeBucketSchema = z.object({
  limitId: z.string().nullable().optional(),
  limitName: z.string().nullable().optional(),
  primary: NativeWindowSchema.nullable().optional(),
  secondary: NativeWindowSchema.nullable().optional(),
  rateLimitReachedType: z.string().nullable().optional(),
});
export const NativeUsageSchema = z.object({
  rateLimitsByLimitId: z.record(z.string(), NativeBucketSchema).nullable(),
  ordinaryUsageAllowed: z.boolean().nullable().optional(),
});

export type INativeThread = z.infer<typeof NativeThreadSchema>;
export type INativeTurn = z.infer<typeof NativeTurnSchema>;
export type INativeItem = z.infer<typeof NativeItemSchema>;
export type INativeUsage = z.infer<typeof NativeUsageSchema>;
export type INativePage<T> = { data: T[]; nextCursor: string | null };

// callbacks are owned by the runtime, independently of connected clients
export type ICodexEvents = {
  controlOutcome(outcome: IAgentProviderOutcome): void;
  forgetTurn(nativeId: string): void;
  prepareTurn(nativeId: string, outputSchema: IOutputSchema | undefined): void;
  notify(method: string, params: unknown): void;
  request(id: string | number, method: string, params: unknown): void;
  lateResponse(id: string, result: unknown, error: unknown): void;
  unavailable(): void;
};

// native read models and explicit control operations; execution settings remain with Codex
export type ICodexProvider = {
  /** Reports declared or observed experimental dynamic tools for a controlled session. */
  hasAgentTools(nativeId: string): boolean;
  /** @returns Safe native account metadata without refreshing tokens. */
  readAccount(): Promise<IAccountObservation>;
  /** @returns Live presentation for the exact native challenge. */
  readLogin(requestId: string): Promise<ILoginObservation>;
  /** @returns Native authentication admission without accepting raw credentials. */
  controlAccount(
    requestId: string,
    command: IAccountControlCommand,
    loginRequestId?: string,
  ): Promise<INativeControlResult>;
  /** @returns One concrete native extension-control acknowledgement. */
  controlExtensions(
    requestId: string,
    nativeId: string,
    workspaceRoot: string,
    command: IExtensionControlCommand,
  ): Promise<INativeControlResult>;
  /** @returns A safe native MCP server page for the selected thread. */
  readMcpServers(nativeId: string, limit: number, cursor?: string): Promise<IProviderMcpServerPage>;
  /** @returns One bounded configured tool inventory. */
  readMcpTools(nativeId: string, serverName: string): Promise<IProviderMcpTools>;
  /** @returns One bounded configured resource inventory. */
  readMcpResources(nativeId: string, serverName: string): Promise<IProviderMcpResources>;
  userAgent: string | null;
  readonly isAvailable: boolean;
  listThreads(
    workspaceRoot: string,
    limit: number,
    cursor?: string,
    search?: string,
  ): Promise<INativePage<IThreadSummary>>;
  readThread(nativeId: string): Promise<IThreadSummary>;
  listTurns(nativeId: string, limit: number, cursor?: string): Promise<INativePage<ITurnSummary>>;
  listItems(
    nativeId: string,
    limit: number,
    cursor?: string,
    turnId?: string,
    evidence?: boolean,
  ): Promise<INativePage<IHistoryItem>>;
  readUsage(): Promise<IUsageSnapshot>;
  /**
   * Reads one native model page without starting inference.
   * @returns Model and effort choices with native continuation.
   * @throws
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   */
  readModels(limit: number, cursor?: string): Promise<INativePage<IProviderModel>>;
  /**
   * Reads known native settings without returning the configuration document.
   * @returns Effective fields and one bounded native agent/profile page.
   * @throws
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
   */
  readConfiguration(
    command: IConfigurationRequest,
    nativeId?: string,
    signal?: AbortSignal,
  ): Promise<ISessionConfiguration>;
  /**
   * Forks stored history into a new native identity.
   * @returns An idle native fork with its source identity.
   * @throws
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   */
  forkThread(requestId: string, nativeId: string): Promise<INativeThread>;
  /**
   * @returns Native archive acknowledgement.
   * @throws
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   */
  archiveThread(requestId: string, nativeId: string): Promise<void>;
  /**
   * @returns The exact restored native identity.
   * @throws
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   */
  unarchiveThread(requestId: string, nativeId: string): Promise<INativeThread>;
  /**
   * @returns Native compaction admission, independent of completion.
   * @throws
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   */
  compactThread(requestId: string, nativeId: string): Promise<void>;
  /**
   * @returns The native thread after history reversion, without changing files.
   * @throws
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   */
  revertThread(requestId: string, nativeId: string, beforeTurnId: string): Promise<INativeThread>;
  /**
   * Reads the native workspace inventory without loading skill content or starting inference.
   * @returns Bounded metadata and the count of native discovery failures.
   * @throws
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   */
  readSkills(workspaceRoot: string): Promise<IProviderSkills>;
  /** Installs runtime-owned callbacks independently of client connections. */
  setEvents(events: ICodexEvents): void;
  /**
   * Creates an empty native thread using the configured execution settings.
   * @returns The created native thread metadata.
   * @throws
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
   */
  startThread(
    requestId: string,
    workspaceRoot: string,
    settings?: ISessionSettings,
  ): Promise<INativeThread>;
  /**
   * Loads one explicitly adopted thread without hydrating its complete history.
   * @returns The resumed native thread metadata.
   * @throws
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
   */
  resumeThread(
    requestId: string,
    nativeId: string,
    settings?: ISessionSettings,
    signal?: AbortSignal,
  ): Promise<INativeThread>;
  /**
   * Sets the native readable name with the admitted request identity.
   * @returns A promise resolved after native name acknowledgement.
   * @throws
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   */
  nameThread(requestId: string, nativeId: string, name: string): Promise<void>;
  /**
   * Starts idle input with optional native model and effort selection.
   * @returns The accepted native turn metadata.
   * @throws
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   */
  startTurn(
    requestId: string,
    nativeId: string,
    text: string,
    skill?: INativeSkillInput | null,
    settings?: ITurnSettings,
    files?: IProviderInputFile[],
  ): Promise<INativeTurn>;
  /**
   * Steers only the required active native turn and verifies its response identity.
   * @returns The acknowledged native turn identity.
   * @throws
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   */
  steer(requestId: string, nativeId: string, expectedTurnId: string, text: string): Promise<string>;
  /**
   * Requests interruption; its acknowledgement does not prove completion.
   * @returns A promise resolved after native interruption-request acknowledgement.
   * @throws
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   */
  interrupt(requestId: string, nativeId: string, nativeTurnId: string): Promise<void>;
  /**
   * Requests cleanup of the controlled thread’s native background terminals.
   * @returns A promise resolved after native cleanup-request acknowledgement.
   * @throws
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   */
  cleanTerminals(requestId: string, nativeId: string): Promise<void>;
  /**
   * Verifies an empty native terminal page before releasing control.
   * @returns A promise resolved only when the native terminal page is empty.
   * @throws
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   */
  verifyTerminalsClosed(nativeId: string): Promise<void>;
  /**
   * Unsubscribes one cleaned native thread and validates the resulting state.
   * @returns A promise resolved after Codex confirms it no longer subscribes to this thread.
   * @throws
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   */
  unsubscribe(requestId: string, nativeId: string): Promise<void>;
  /**
   * Writes an exact native request response; resolution arrives separately.
   * @returns A promise resolved after the native transport accepts the response.
   * @throws
   * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
   */
  reply(id: string | number, result: unknown): Promise<void>;
  /**
   * Rejects an unsupported native request without granting permissions.
   * @returns A promise resolved after the native transport accepts the rejection.
   * @throws
   * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
   */
  reject(id: string | number): Promise<void>;
  close(): Promise<void>;
};

// native discovery is unpaged; limit inventory size and retain only display/invocation metadata
export const NativeSkillsSchema = z.object({
  data: z
    .array(
      z.object({
        cwd: z.string().min(1).max(4096),
        skills: z
          .array(
            z.object({
              name: z
                .string()
                .min(1)
                .max(256)
                .regex(/^[^\s\p{Cc}]+$/u),
              description: z.string().max(8192),
              path: z.string().min(1).max(4096),
              scope: z.enum(['user', 'repo', 'system', 'admin']),
              enabled: z.boolean(),
              dependencies: z
                .object({
                  tools: z
                    .array(
                      z.object({
                        type: z.string().max(128),
                        value: z.string().max(4096),
                        description: z.string().max(4096).optional(),
                      }),
                    )
                    .max(128),
                })
                .optional(),
            }),
          )
          .max(4096),
        errors: z.array(z.unknown()).max(4096),
      }),
    )
    .length(1),
});
