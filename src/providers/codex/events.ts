import { isException } from 'jg-exception';
import { z } from 'zod';

import {
  MAX_RESULT_BYTES,
  type IOutputSchema,
  type ISessionState,
  type ITurnUsage,
} from '../../contracts/index.js';
import { toTurnResult } from '../results/index.js';

import { NativeIdSchema } from '../../contracts/identities/index.js';
import type { IAgentProviderOutcome, IAgentProviderEvents, IProviderThread } from '../index.js';
import { parseActionRequest } from '../utilities.js';

import { LOST_NOTIFICATIONS, RUNNING_TURNS_CAPACITY } from './constants.js';
import type { ICodexEvents, ICodexProvider, INativeThread, ITurnSummary } from './types.js';
import {
  NativeItemSchema,
  NativeThreadSchema,
  NativeThreadStatusSchema,
  NativeTurnSchema,
} from './types.js';
import { parseNative } from './validations.js';
import {
  toHistoryItem,
  toNativeLineage,
  toNativeState,
  toSessionState,
  toTurnSummary,
} from './transformers.js';
import { buildCodexReply, parseCodexPrompt, toApprovalPresentation } from './approvals/index.js';

const TargetSchema = z.object({ threadId: NativeIdSchema, turnId: NativeIdSchema });
const DeltaSchema = TargetSchema.extend({ itemId: NativeIdSchema, delta: z.string() });

/** @returns Exact native session metadata normalized to the common control boundary. */
export const toProviderThread = (thread: INativeThread): IProviderThread => ({
  nativeId: thread.id,
  nativeLineage: toNativeLineage(thread),
  workspaceRoot: thread.cwd,
  nativeState: toNativeState(thread.status),
});

/**
 * Converts Codex protocol events to provider-bound evidence without owning action ledger state.
 * @returns The callbacks installed on the native Codex connection.
 */
export const createCodexEvents = (
  native: ICodexProvider,
  events: IAgentProviderEvents,
  observeSession: (nativeId: string, state: ISessionState | null) => void,
  observeLoaded: () => void,
): ICodexEvents => {
  const turns = new Map<
    string,
    {
      turnId: string | null;
      schema: IOutputSchema | undefined;
      text: string | null;
      oversized: boolean;
      usage: ITurnUsage | null;
    }
  >();
  // each thread's running turn, which times its live items
  const runningTurns = new Map<string, ITurnSummary>();
  /**
   * Keeps HQ's result capture in step with a turn whose start or end failed validation: a lost
   * start still binds the capture prepared for HQ's input, and a lost end drops its turn's capture,
   * which would otherwise refuse the session's next turn that HQ didn't prepare, such as one
   * another client starts.
   */
  const settleLostCapture = (method: string, params: unknown): void => {
    const lifecycle = z
      .object({ threadId: NativeIdSchema, turn: z.object({ id: NativeIdSchema }) })
      .safeParse(params);
    if (!lifecycle.success) return;
    const { threadId, turn } = lifecycle.data;
    const captured = turns.get(threadId);
    if (method === 'turn/started' && captured?.turnId === null) captured.turnId = turn.id;
    if (method === 'turn/completed' && captured?.turnId === turn.id) turns.delete(threadId);
  };
  /**
   * Turns one daemon notification into provider evidence.
   * @throws
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   */
  const receiveNotification = (method: string, params: unknown): void => {
    if (method === 'turn/started' || method === 'turn/completed') {
      const { threadId, turn } = parseNative(
        z.object({ threadId: NativeIdSchema, turn: NativeTurnSchema }),
        params,
      );
      if (method === 'turn/started') {
        const captured = turns.get(threadId);
        // a second turn started for HQ's own input breaks the protocol
        if (captured?.turnId && captured.turnId !== turn.id) parseNative(z.never(), params);
        const summary = toTurnSummary(turn);
        runningTurns.delete(threadId);
        if (runningTurns.size >= RUNNING_TURNS_CAPACITY)
          runningTurns.delete(runningTurns.keys().next().value!);
        runningTurns.set(threadId, summary);
        if (captured) captured.turnId = turn.id;
        events.observe({
          kind: 'turn-started',
          provider: 'codex',
          nativeThreadId: threadId,
          nativeTurnId: turn.id,
        });
      } else if (turn.status !== 'inProgress') {
        if (runningTurns.get(threadId)?.nativeId === turn.id) runningTurns.delete(threadId);
        const pending = turns.get(threadId);
        const captured = pending?.turnId === turn.id ? pending : undefined;
        const result = captured
          ? toTurnResult(turn.status, captured.text, undefined, captured.schema, captured.usage)
          : undefined;
        if (result && captured?.oversized) {
          result.state = 'failed';
          result.failure = 'result-too-large';
          result.isComplete = false;
          result.text = null;
          result.structuredOutput = null;
        }
        // a capture prepared for the session's next turn outlives an earlier turn's end
        if (captured) turns.delete(threadId);
        events.observe({
          kind: 'turn-completed',
          provider: 'codex',
          nativeThreadId: threadId,
          nativeTurnId: turn.id,
          state: result?.state ?? turn.status,
          ...(result ? { result } : {}),
        });
      } else parseNative(z.never(), params);
    } else if (method === 'item/started' || method === 'item/completed') {
      const { threadId, turnId, item } = parseNative(
        TargetSchema.extend({ item: NativeItemSchema.shape.item }),
        params,
      );
      const captured = turns.get(threadId);
      if (
        captured?.turnId === turnId &&
        method === 'item/completed' &&
        item.type === 'agentMessage'
      ) {
        const message = parseNative(
          z.object({ text: z.string(), phase: z.string().nullish() }),
          item,
        );
        if (
          message.phase === undefined ||
          message.phase === null ||
          message.phase === 'final_answer'
        ) {
          if (Buffer.byteLength(message.text) > MAX_RESULT_BYTES) {
            captured.oversized = true;
            captured.text = null;
          } else if (!captured.oversized) captured.text = message.text;
        }
      }
      const running = runningTurns.get(threadId);
      const presented = toHistoryItem(
        { turnId, item },
        running?.nativeId === turnId ? running : undefined,
      );
      if (presented) events.item(threadId, presented, method === 'item/completed');
    } else if (
      method === 'item/agentMessage/delta' ||
      method === 'item/commandExecution/outputDelta'
    ) {
      const delta = parseNative(DeltaSchema, params);
      events.delta(delta.threadId, delta.turnId, delta.itemId, delta.delta);
    } else if (method === 'thread/tokenUsage/updated') {
      const token = z.number().int().nonnegative().safe();
      const usage = parseNative(
        TargetSchema.extend({
          tokenUsage: z.object({
            last: z.object({ inputTokens: token, outputTokens: token, cachedInputTokens: token }),
          }),
        }),
        params,
      );
      const captured = turns.get(usage.threadId);
      if (captured?.turnId === usage.turnId)
        captured.usage = { ...usage.tokenUsage.last, scope: 'turn' };
    } else if (method === 'thread/status/changed') {
      // the daemon broadcasts every thread's status, including sessions other clients drive
      const { threadId, status } = parseNative(
        z.object({ threadId: NativeIdSchema, status: NativeThreadStatusSchema }),
        params,
      );
      observeSession(threadId, toSessionState(status));
    } else if (method === 'thread/name/updated') {
      const { threadId } = parseNative(z.object({ threadId: NativeIdSchema }), params);
      // read current metadata once, including a cleared name, without inventing a state change
      observeSession(threadId, null);
    } else if (method === 'thread/settings/updated') {
      // the thread record leaves the tier out, so a turn that changes it is followed here
      const { threadId, threadSettings } = parseNative(
        z.object({
          threadId: NativeIdSchema,
          threadSettings: z.object({ serviceTier: z.string().min(1).max(4096).nullish() }),
        }),
        params,
      );
      if (threadSettings.serviceTier !== undefined)
        native.observeServiceTier(threadId, threadSettings.serviceTier);
    } else if (method === 'serverRequest/resolved') {
      const { threadId, requestId } = parseNative(
        z.object({
          threadId: NativeIdSchema,
          requestId: z.union([NativeIdSchema, z.number().int()]),
        }),
        params,
      );
      events.observe({
        kind: 'request-resolved',
        provider: 'codex',
        nativeThreadId: threadId,
        requestId: JSON.stringify(requestId),
      });
    }
  };
  return {
    prepareTurn(nativeId, schema) {
      if (!turns.has(nativeId) && turns.size >= 32) parseNative(z.never(), nativeId);
      turns.set(nativeId, {
        turnId: null,
        schema,
        text: null,
        oversized: false,
        usage: null,
      });
    },
    forgetTurn(nativeId) {
      turns.delete(nativeId);
    },
    notify(method, params) {
      try {
        receiveNotification(method, params);
      } catch (error) {
        if (!isException(error) || error.code !== 'JG_AGENT_HQ_CODEX_FAILED') throw error;
        // a notification that fails validation never fails the connection every session shares
        const thread = z.object({ threadId: NativeIdSchema }).safeParse(params);
        const threadId = thread.success ? thread.data.threadId : undefined;
        settleLostCapture(method, params);
        const lost = LOST_NOTIFICATIONS.get(method);
        // a lost turn or approval notification is made up for by reading the session
        if (lost) events.resync(threadId, threadId === undefined ? 'unknown' : lost);
        else if (threadId !== undefined) events.gap(threadId);
      }
    },
    request(id, method, params) {
      const prompt = parseCodexPrompt(method, params);
      if (!prompt) {
        // a request on a session is refused only when HQ controls that session
        const thread = z.object({ threadId: NativeIdSchema }).safeParse(params);
        if (thread.success) events.unpresentable(thread.data.threadId, () => native.reject(id));
        else void native.reject(id).catch(() => events.unavailable());
        return;
      }
      events.prompt({
        provider: 'codex',
        nativeThreadId: prompt.params.threadId,
        nativeTurnId: prompt.params.turnId,
        requestId: JSON.stringify(id),
        fingerprint: JSON.stringify([method, params]),
        presentation: toApprovalPresentation(prompt),
        validate: (response) => buildCodexReply(prompt, response),
        reply: (result) => native.reply(id, result),
        reject: () => native.reject(id),
      });
    },
    lateResponse(requestId, result, error) {
      /*
       * A reply's request ID is the native approval's, and answers no action phase. A deletion
       * runs within its request, which records its outcome, so a late answer to it changes nothing.
       */
      const request = parseActionRequest(requestId);
      if (!request || request.phase === 'reply' || request.phase === 'delete') return;
      let outcome: IAgentProviderOutcome;
      let thread: IProviderThread | undefined;
      if (error !== undefined)
        outcome = { kind: 'failed', ...request, failure: 'agent-unavailable' };
      else if (request.phase === 'create' || request.phase === 'resume') {
        thread = toProviderThread(
          parseNative(z.object({ thread: NativeThreadSchema }), result).thread,
        );
        outcome =
          request.phase === 'create'
            ? { kind: 'created', ...request, nativeId: thread.nativeId }
            : { kind: 'resumed', ...request, nativeState: thread.nativeState };
      } else if (request.phase === 'turn')
        outcome = {
          kind: 'turn-accepted',
          ...request,
          nativeTurnId: parseNative(z.object({ turn: NativeTurnSchema }), result).turn.id,
        };
      else if (request.phase === 'steer')
        outcome = {
          kind: 'steer-accepted',
          ...request,
          nativeTurnId: parseNative(z.object({ turnId: NativeIdSchema }), result).turnId,
        };
      else if (
        request.phase === 'name' ||
        request.phase === 'interrupt' ||
        request.phase === 'clean'
      ) {
        parseNative(z.object({}), result);
        outcome = {
          kind:
            request.phase === 'name'
              ? 'renamed'
              : request.phase === 'interrupt'
                ? 'interrupt-accepted'
                : 'cleaned',
          ...request,
        };
      } else {
        parseNative(
          z.object({ status: z.enum(['unsubscribed', 'notSubscribed', 'notLoaded']) }),
          result,
        );
        outcome = { kind: 'closed', ...request };
      }
      events.outcome(outcome, thread);
    },
    unavailable: () => {
      // a disconnected stream cannot supply a complete result from its partial capture
      turns.clear();
      runningTurns.clear();
      events.unavailable();
    },
    connected: () => observeLoaded(),
    // a discarded message's session can't be known, so every session HQ controls is read
    discarded: () => events.resync(undefined, 'unknown'),
  };
};
