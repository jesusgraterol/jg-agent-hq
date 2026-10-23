import { z } from 'zod';

import { NativeIdSchema } from '../../contracts/identities/index.js';
import type { IAgentProviderOutcome, IAgentProviderEvents, IProviderThread } from '../index.js';

import type { ICodexEvents, ICodexProvider, INativeThread } from './types.js';
import { NativeItemSchema, NativeThreadSchema, NativeTurnSchema } from './types.js';
import { parseNative } from './validations.js';
import { toHistoryItem, toNativeLineage } from './transformers.js';
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
): ICodexEvents => ({
  notify(method, params) {
    if (method === 'turn/started' || method === 'turn/completed') {
      const { threadId, turn } = parseNative(
        z.object({ threadId: NativeIdSchema, turn: NativeTurnSchema }),
        params,
      );
      if (method === 'turn/started')
        events.observe({
          kind: 'turn-started',
          provider: 'codex',
          nativeThreadId: threadId,
          nativeTurnId: turn.id,
        });
      else if (turn.status !== 'inProgress')
        events.observe({
          kind: 'turn-completed',
          provider: 'codex',
          nativeThreadId: threadId,
          nativeTurnId: turn.id,
          state: turn.status,
        });
      else parseNative(z.never(), params);
    } else if (method === 'item/started' || method === 'item/completed') {
      const { threadId, turnId, item } = parseNative(
        TargetSchema.extend({ item: NativeItemSchema.shape.item }),
        params,
      );
      events.item(threadId, toHistoryItem({ turnId, item }), method === 'item/completed');
    } else if (
      method === 'item/agentMessage/delta' ||
      method === 'item/commandExecution/outputDelta'
    ) {
      const delta = parseNative(DeltaSchema, params);
      events.delta(delta.threadId, delta.turnId, delta.itemId, delta.delta);
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
    if (error !== undefined) outcome = { kind: 'failed', requestId, failure: 'agent-unavailable' };
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
});
