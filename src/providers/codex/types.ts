import { z } from 'zod';

import {
  MAX_PAGE_SIZE,
  UsageCreditsSchema,
  UsageResetCreditsSchema,
  type IHistoryItem,
  type IItemDetail,
  type IItemImage,
  type INativeSkillInput,
  type IThreadSummary,
  type IUsageSnapshot,
  type IProviderModel,
  type IConfigurationRequest,
  type ISessionConfiguration,
  type ISessionSettings,
  type ITurnSettings,
  type IOutputSchema,
} from '../../contracts/index.js';
import type { IProviderInputFile } from '../inputs/index.js';
import type { IProviderSkills } from '../types.js';

// a session's status, which may name one newer than this adapter knows
export const NativeThreadStatusSchema = z.object({
  type: z.string().min(1).max(256),
  activeFlags: z.array(z.string()).optional(),
});
export type INativeThreadStatus = z.infer<typeof NativeThreadStatusSchema>;
// additive native responses are narrowed to fields this adapter actually uses
export const NativeThreadSchema = z.object({
  id: z.string().min(1).max(4096),
  sessionId: z.string().min(1).max(4096).nullable().optional(),
  parentThreadId: z.string().min(1).max(4096).nullable().optional(),
  forkedFromId: z.string().min(1).max(4096).nullable().optional(),
  cwd: z.string().min(1).max(4096),
  name: z.string().nullable().optional(),
  // a session Codex doesn't save, such as the helper sessions it starts itself
  ephemeral: z.boolean().optional(),
  createdAt: z.number().int().safe(),
  updatedAt: z.number().int().safe(),
  status: NativeThreadStatusSchema,
});
export const NativeTurnSchema = z.object({
  id: z.string().min(1).max(4096),
  status: z.enum(['completed', 'interrupted', 'failed', 'inProgress']),
  startedAt: z.number().int().safe().nullable().optional(),
  completedAt: z.number().int().safe().nullable().optional(),
});
// a turn's state and times in Unix milliseconds, as HQ reads them from a native turn
export const TurnSummarySchema = z.object({
  nativeId: z.string().min(1).max(4096),
  state: z.enum(['completed', 'interrupted', 'failed', 'inProgress', 'unknown']),
  startedAt: z.number().int().nullable(),
  completedAt: z.number().int().nullable(),
});
export type ITurnSummary = z.infer<typeof TurnSummarySchema>;
// recorded native item lifecycle times are milliseconds; older producers may omit them
const NativeItemTimeSchema = z
  .number()
  .int()
  .safe()
  .nonnegative()
  .max(8_640_000_000_000_000)
  .nullish();
export const NativeItemSchema = z.object({
  turnId: z.string().min(1).max(4096),
  startedAtMs: NativeItemTimeSchema,
  completedAtMs: NativeItemTimeSchema,
  item: z
    .object({
      id: z.string().min(1).max(4096),
      type: z.string().min(1).max(256),
      startedAtMs: NativeItemTimeSchema,
      completedAtMs: NativeItemTimeSchema,
    })
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
// optional billing metadata may be unavailable without invalidating measured quota windows
const NativeCreditsSchema = z.object({
  hasCredits: UsageCreditsSchema.shape.hasCredits,
  unlimited: UsageCreditsSchema.shape.isUnlimited,
  balance: UsageCreditsSchema.shape.balance,
});
export const NativeBucketSchema = z.object({
  limitId: z.string().nullable().optional(),
  limitName: z.string().nullable().optional(),
  primary: NativeWindowSchema.nullable().optional(),
  secondary: NativeWindowSchema.nullable().optional(),
  rateLimitReachedType: z.string().nullable().optional(),
  credits: NativeCreditsSchema.nullable().optional().catch(null),
});
export const NativeUsageSchema = z.object({
  rateLimitsByLimitId: z.record(z.string(), NativeBucketSchema).nullable().optional(),
  rateLimits: NativeBucketSchema.nullable().optional(),
  rateLimitResetCredits: UsageResetCreditsSchema.nullable().optional().catch(null),
  ordinaryUsageAllowed: z.boolean().nullable().optional(),
});

export type INativeThread = z.infer<typeof NativeThreadSchema>;
export type INativeTurn = z.infer<typeof NativeTurnSchema>;
export type INativeItem = z.infer<typeof NativeItemSchema>;
export type INativeUsage = z.infer<typeof NativeUsageSchema>;
export type INativePage<T> = { data: T[]; nextCursor: string | null };

// callbacks are owned by the runtime, independently of connected clients
export type ICodexEvents = {
  forgetTurn(nativeId: string): void;
  prepareTurn(nativeId: string, outputSchema: IOutputSchema | undefined): void;
  notify(method: string, params: unknown): void;
  request(id: string | number, method: string, params: unknown): void;
  lateResponse(id: string, result: unknown, error: unknown): void;
  unavailable(): void;
  // the connection opened again after the daemon restarted or the transport stopped
  connected(): void;
  // a message over the size limit was discarded, which may have been any session's
  discarded(): void;
};

// native read models and explicit control operations; execution settings remain with Codex
export type ICodexProvider = {
  userAgent: string | null;
  readonly isAvailable: boolean;
  listThreads(
    workspaceRoot: string,
    limit: number,
    cursor?: string,
    search?: string,
  ): Promise<INativePage<IThreadSummary>>;
  readThread(nativeId: string): Promise<IThreadSummary>;
  /** @returns A session's native metadata and status, without joining it. */
  readNativeThread(nativeId: string): Promise<INativeThread>;
  /** @returns A session's summary, with its workspace, and whether Codex doesn't save it. */
  readObservedThread(nativeId: string): Promise<{ thread: IThreadSummary; isEphemeral: boolean }>;
  /** @returns One page of the IDs of the threads the daemon has loaded, for any client. */
  listLoadedThreads(cursor?: string): Promise<INativePage<string>>;
  listTurns(nativeId: string, limit: number, cursor?: string): Promise<INativePage<ITurnSummary>>;
  /** @returns One page of items newest first, with full text when `fullBody` is set. */
  listItems(
    nativeId: string,
    limit: number,
    cursor?: string,
    turnId?: string,
    fullBody?: boolean,
  ): Promise<INativePage<IHistoryItem>>;
  /**
   * Reads one item of a turn with its detail.
   * @returns The detail, or null when the turn holds no such item or Codex leaves it out.
   * @throws
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   */
  readItemDetail(
    nativeId: string,
    turnId: string,
    nativeItemId: string,
  ): Promise<IItemDetail | null>;
  /**
   * Reads one image an item of a turn holds or names, by its index in the item's detail.
   * @returns A promise that resolves to the image.
   * @throws
   * - JG_AGENT_HQ_IMAGE_UNAVAILABLE: The HQ image is unavailable
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   */
  readItemImage(
    nativeId: string,
    turnId: string,
    nativeItemId: string,
    index: number,
  ): Promise<IItemImage>;
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
  /** Records the service tier Codex reports a session HQ started or resumed now uses. */
  observeServiceTier(nativeId: string, serviceTier: string | null): void;
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
   * Deletes a session from Codex's storage through the daemon, which also forgets it; a session
   * that never saved a rollout, such as one created without a turn, counts as deleted.
   * @returns A promise resolved once Codex confirms the deletion.
   * @throws
   * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   */
  deleteThread(requestId: string, nativeId: string): Promise<void>;
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
  /** Stops the current daemon connection without closing the provider; the next request reconnects. */
  disconnect(): Promise<void>;
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
