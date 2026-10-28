import { z } from 'zod';

import {
  MAX_RESULT_BYTES,
  type IOutputSchema,
  type ISessionState,
  type ITurnSummary,
  type ITurnUsage,
} from '../../contracts/index.js';
import { toTurnResult } from '../results/index.js';

import { NativeIdSchema } from '../../contracts/identities/index.js';
import type { IAgentProviderOutcome, IAgentProviderEvents, IProviderThread } from '../index.js';

import { RUNNING_TURNS_CAPACITY } from './constants.js';
import type { ICodexEvents, ICodexProvider, INativeThread } from './types.js';
import { NativeItemSchema, NativeThreadSchema, NativeTurnSchema } from './types.js';
import { parseNative } from './validations.js';
import { toHistoryItem, toNativeLineage, toSessionState, toTurnSummary } from './transformers.js';
import { buildCodexReply, parseCodexPrompt, toApprovalPresentation } from './approvals/index.js';

const TargetSchema = z.object({ threadId: NativeIdSchema, turnId: NativeIdSchema });
const DeltaSchema = TargetSchema.extend({ itemId: NativeIdSchema, delta: z.string() });
const PhaseIdSchema = z
  .string()
  .regex(
    /^[a-f0-9-]{36}:(create|fork|resume|name|turn|steer|interrupt|clean|close|archive|unarchive|revert|compact)$/,
  );

/** @returns Exact native session metadata normalized to the common control boundary. */
export const toProviderThread = (thread: INativeThread): IProviderThread => ({
  nativeId: thread.id,
  nativeLineage: toNativeLineage(thread),
  workspaceRoot: thread.cwd,
  nativeState: thread.status.type,
});

/**
 * Converts Codex protocol events to provider-bound evidence without owning action ledger state.
 * @returns The callbacks installed on the native Codex connection.
 */
export const createCodexEvents = (
  native: ICodexProvider,
  events: IAgentProviderEvents,
  observeSession: (nativeId: string, state: ISessionState) => void,
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
  return {
    controlOutcome: (outcome) => events.outcome(outcome),
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
      if (method === 'turn/started' || method === 'turn/completed') {
        const { threadId, turn } = parseNative(
          z.object({ threadId: NativeIdSchema, turn: NativeTurnSchema }),
          params,
        );
        if (method === 'turn/started') {
          runningTurns.delete(threadId);
          if (runningTurns.size >= RUNNING_TURNS_CAPACITY)
            runningTurns.delete(runningTurns.keys().next().value!);
          runningTurns.set(threadId, toTurnSummary(turn));
          const captured = turns.get(threadId);
          if (captured) {
            if (captured.turnId && captured.turnId !== turn.id) parseNative(z.never(), params);
            captured.turnId = turn.id;
          }
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
          turns.delete(threadId);
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
        const usage = TargetSchema.extend({
          tokenUsage: z.object({
            last: z.object({ inputTokens: token, outputTokens: token, cachedInputTokens: token }),
          }),
        }).safeParse(params);
        if (usage.success) {
          const captured = turns.get(usage.data.threadId);
          if (captured?.turnId === usage.data.turnId)
            captured.usage = { ...usage.data.tokenUsage.last, scope: 'turn' };
        }
      } else if (method === 'thread/status/changed') {
        // the daemon broadcasts every thread's status, including sessions other clients drive
        const { threadId, status } = parseNative(
          z.object({ threadId: NativeIdSchema, status: NativeThreadSchema.shape.status }),
          params,
        );
        observeSession(threadId, toSessionState(status));
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
    },
    request(id, method, params) {
      const prompt = parseCodexPrompt(method, params);
      if (!prompt) {
        void native.reject(id).catch(() => events.unavailable());
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
      if (!PhaseIdSchema.safeParse(requestId).success) return;
      let outcome: IAgentProviderOutcome;
      let thread: IProviderThread | undefined;
      if (error !== undefined)
        outcome = { kind: 'failed', requestId, failure: 'agent-unavailable' };
      else if (
        requestId.endsWith(':create') ||
        requestId.endsWith(':fork') ||
        requestId.endsWith(':resume')
      ) {
        thread = toProviderThread(
          parseNative(z.object({ thread: NativeThreadSchema }), result).thread,
        );
        outcome =
          requestId.endsWith(':create') || requestId.endsWith(':fork')
            ? { kind: 'created', requestId, nativeId: thread.nativeId }
            : { kind: 'resumed', requestId, nativeState: thread.nativeState };
      } else if (requestId.endsWith(':unarchive') || requestId.endsWith(':revert')) {
        thread = toProviderThread(
          parseNative(z.object({ thread: NativeThreadSchema }), result).thread,
        );
        outcome = { kind: requestId.endsWith(':unarchive') ? 'unarchived' : 'reverted', requestId };
      } else if (requestId.endsWith(':archive') || requestId.endsWith(':compact')) {
        parseNative(z.object({}), result);
        outcome = requestId.endsWith(':archive')
          ? { kind: 'archived', requestId }
          : { kind: 'compaction-accepted', requestId, nativeTurnId: null };
      } else if (requestId.endsWith(':turn'))
        outcome = {
          kind: 'turn-accepted',
          requestId,
          nativeTurnId: parseNative(z.object({ turn: NativeTurnSchema }), result).turn.id,
        };
      else if (requestId.endsWith(':steer'))
        outcome = {
          kind: 'steer-accepted',
          requestId,
          nativeTurnId: parseNative(z.object({ turnId: NativeIdSchema }), result).turnId,
        };
      else if (
        requestId.endsWith(':name') ||
        requestId.endsWith(':interrupt') ||
        requestId.endsWith(':clean')
      ) {
        parseNative(z.object({}), result);
        outcome = {
          kind: requestId.endsWith(':name')
            ? 'renamed'
            : requestId.endsWith(':interrupt')
              ? 'interrupt-accepted'
              : 'cleaned',
          requestId,
        };
      } else {
        parseNative(
          z.object({ status: z.enum(['unsubscribed', 'notSubscribed', 'notLoaded']) }),
          result,
        );
        outcome = { kind: 'closed', requestId };
      }
      events.outcome(outcome, thread);
    },
    unavailable: () => events.unavailable(),
    connected: () => observeLoaded(),
  };
};
