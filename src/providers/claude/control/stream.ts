import { randomUUID } from 'node:crypto';
import { Exception } from 'jg-exception';
import { z } from 'zod';

import { RecordSchema, toClaudeItem } from '../history/index.js';
import { MAX_RESULT_BYTES, type ITurnUsage } from '../../../contracts/index.js';
import { toTurnResult } from '../../results/index.js';

import type {
  IClaudeControlEvents,
  IClaudeNativeTurn,
  IClaudeSession,
  IClaudeTurn,
} from './types.js';
import { createClaudePrompt } from './permissions.js';

const FrameSchema = z.object({ type: z.string(), session_id: z.string().optional() });
const MessageSchema = z.object({
  uuid: z.string().min(1).max(4096),
  message: z.object({ role: z.string(), content: z.unknown() }),
  tool_use_result: z.unknown().optional(),
  // text Claude adds to a turn itself, such as a loaded skill's, which its transcript marks isMeta
  isSynthetic: z.boolean().optional(),
});
const ResultSchema = z.object({
  subtype: z.string(),
  is_error: z.boolean(),
  // absent from the result of a turn Claude started itself
  user_message_uuid: z.uuid().optional(),
  errors: z.array(z.string()).max(128).optional(),
  structured_output: z.unknown().optional(),
  result: z.string().optional(),
  usage: z.unknown().optional(),
});
const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative().safe(),
  output_tokens: z.number().int().nonnegative().safe(),
  cache_read_input_tokens: z.number().int().nonnegative().safe().optional(),
});
const InterruptionMarkerSchema = z.tuple([
  z.object({ type: z.literal('text'), text: z.literal('[Request interrupted by user]') }),
]);
const isClaudeInterruptionMarker = (content: unknown): boolean =>
  InterruptionMarkerSchema.safeParse(content).success;
const RequestSchema = z.object({ request_id: z.string().min(1).max(4096), request: z.unknown() });
const CancelSchema = z.object({ request_id: z.string().min(1).max(4096) });
const ToolResultsSchema = z.array(
  z.object({ type: z.string(), tool_use_id: z.string().optional() }),
);
const PartialSchema = z.object({ event: z.object({ type: z.string() }) });
const MessageStartSchema = z.object({
  event: z.object({ message: z.object({ id: z.string().min(1).max(256) }) }),
});
const BlockStartSchema = z.object({
  event: z.object({
    index: z.number().int().min(0).max(127),
    content_block: z.object({
      type: z.string(),
      id: z.string().optional(),
      name: z.string().optional(),
      text: z.string().optional(),
    }),
  }),
});
const BlockDeltaSchema = z.object({
  event: z.object({
    index: z.number().int().min(0).max(127),
    delta: z.object({ type: z.string(), text: z.string().optional() }),
  }),
});
// Claude's list of the background commands still running, sent whenever one starts or ends
const BackgroundTasksSchema = z.object({
  subtype: z.literal('background_tasks_changed'),
  tasks: z.array(z.object({ task_id: z.string() })).max(1024),
});

const unavailable: () => never = () => {
  throw new Exception('The Claude integration failed', {
    code: 'JG_AGENT_HQ_CLAUDE_FAILED',
    data: { kind: 'agent-unavailable' },
  });
};

/**
 * Returns the turn the session's frames belong to: a turn Claude started, or the acknowledged
 * input's. Input still waiting for its replay has no turn yet.
 */
const getActiveTurn = (session: IClaudeSession): IClaudeTurn | undefined =>
  session.nativeTurn ?? (session.input?.isAcknowledged ? session.input : undefined);

/** Acknowledges the single current input before forwarding its ordered turn evidence. */
const acknowledge = (session: IClaudeSession, events: IClaudeControlEvents | undefined): void => {
  const input = session.input;
  if (!input || input.isAcknowledged) return;
  input.isAcknowledged = true;
  clearTimeout(input.timer);
  input.resolve({ id: input.id });
  events?.outcome({
    kind: input.requestId.endsWith(':compact') ? 'compaction-accepted' : 'turn-accepted',
    requestId: input.requestId,
    nativeTurnId: input.id,
  });
  events?.observe({
    kind: 'turn-started',
    provider: 'claude',
    nativeThreadId: session.id,
    nativeTurnId: input.id,
  });
};

/**
 * Starts tracking a turn Claude began without HQ input, under an ID HQ generates. Input waiting
 * for its replay keeps waiting: Claude replays it only after this turn's result.
 */
const startNativeTurn = (
  session: IClaudeSession,
  events: IClaudeControlEvents | undefined,
): IClaudeNativeTurn => {
  const turn = { id: randomUUID(), interruptRequested: false, hasInterruptionMarker: false };
  session.nativeTurn = turn;
  events?.observe({
    kind: 'turn-started',
    provider: 'claude',
    nativeThreadId: session.id,
    nativeTurnId: turn.id,
    isAgentInitiated: true,
  });
  return turn;
};

/** Classifies a result: interrupted only after the marker of an interrupt HQ requested. */
const toTurnState = (
  result: z.infer<typeof ResultSchema>,
  turn: IClaudeTurn,
): 'completed' | 'interrupted' | 'failed' =>
  !result.is_error && result.subtype === 'success'
    ? 'completed'
    : turn.hasInterruptionMarker
      ? 'interrupted'
      : 'failed';

/** Releases what a finished turn held: its previews and its unanswered requests. */
const endTurn = (session: IClaudeSession, events: IClaudeControlEvents | undefined): void => {
  if (session.previews.size) events?.gap(session.id);
  session.previews.clear();
  session.requests.clear();
};

/**
 * Normalizes native stream evidence without retaining another conversation buffer. A turn frame
 * that arrives while no turn is active, and isn't the waiting input's replay, starts a turn of
 * Claude's own; frames then belong to the active turn until its result.
 * @throws
 * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
 */
export const receiveClaudeMessage = (
  session: IClaudeSession,
  raw: unknown,
  events: IClaudeControlEvents | undefined,
): void => {
  const frame = FrameSchema.parse(raw);
  if (frame.session_id && frame.session_id !== session.id) unavailable();
  if (frame.type === 'user' || frame.type === 'assistant') {
    const message = MessageSchema.parse(raw);
    const isReplay =
      frame.type === 'user' && session.input !== undefined && message.uuid === session.input.id;
    if (isReplay) {
      // Claude replays input written during its own turn only after that turn's result
      if (session.nativeTurn) unavailable();
      acknowledge(session, events);
    }
    const turn = getActiveTurn(session) ?? startNativeTurn(session, events);
    if (
      frame.type === 'user' &&
      !isReplay &&
      turn.interruptRequested &&
      isClaudeInterruptionMarker(message.message.content)
    ) {
      turn.hasInterruptionMarker = true;
      return;
    }
    // like history, which skips the transcript's isMeta records, live items leave synthetic text out
    const item = message.isSynthetic
      ? null
      : toClaudeItem(
          RecordSchema.parse({
            type: frame.type,
            uuid: message.uuid,
            message: message.message,
            toolUseResult: message.tool_use_result,
            // a live item is timed when its frame arrives
            timestamp: new Date().toISOString(),
          }),
          turn.id,
        );
    // final wrappers may share an API message ID while containing different content blocks
    const content = z
      .object({ message: z.object({ id: z.string().optional(), content: z.unknown() }) })
      .parse(raw).message;
    const blocks = z.array(z.object({ type: z.string() })).safeParse(content.content);
    // only an HQ input's turn captures a result, since only its action can hold one
    const input = session.input;
    if (frame.type === 'assistant' && blocks.success && input && turn === input) {
      const texts = z
        .array(z.object({ type: z.string(), text: z.string().optional() }))
        .parse(content.content)
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '');
      const text = texts.join('\n');
      if (text) {
        if (Buffer.byteLength(text) > MAX_RESULT_BYTES) {
          input.isOutputOversized = true;
          input.finalText = null;
        } else if (!input.isOutputOversized) input.finalText = text;
      }
    }
    const replacedIds: string[] = [];
    if (blocks.success && content.id === session.apiMessageId)
      for (const block of blocks.data) {
        const preview = [...session.previews].find(
          ([, candidate]) => candidate.type === block.type,
        );
        if (preview) {
          session.previews.delete(preview[0]);
          replacedIds.push(preview[1].id);
        }
      }
    if (item) events?.item(session.id, item, true, replacedIds);
    if (frame.type === 'user') {
      const results = ToolResultsSchema.safeParse(message.message.content);
      if (results.success)
        for (const result of results.data) {
          if (result.type !== 'tool_result' || !result.tool_use_id) continue;
          for (const [id, request] of session.requests)
            if (request.toolId === result.tool_use_id) {
              events?.observe({
                kind: 'request-resolved',
                provider: 'claude',
                nativeThreadId: session.id,
                requestId: request.scopedId,
              });
              session.requests.delete(id);
            }
        }
    }
  } else if (frame.type === 'stream_event') {
    const turn = getActiveTurn(session) ?? startNativeTurn(session, events);
    const event = PartialSchema.parse(raw).event;
    if (event.type === 'message_start') {
      if (session.previews.size) events?.gap(session.id);
      session.apiMessageId = MessageStartSchema.parse(raw).event.message.id;
      session.previews.clear();
    } else if (event.type === 'content_block_start') {
      const block = BlockStartSchema.parse(raw).event;
      if (!session.apiMessageId) unavailable();
      const id = `live:${turn.id}:${session.apiMessageId}:${block.index}`;
      const preview = toClaudeItem(
        {
          type: 'assistant',
          uuid: id,
          message: { role: 'assistant', content: [block.content_block] },
          timestamp: new Date().toISOString(),
        },
        turn.id,
      );
      // a block the CLI leaves out, such as thinking, has no preview to show or replace
      if (preview) {
        session.previews.set(block.index, { id, type: block.content_block.type });
        events?.item(session.id, preview, false);
      }
    } else if (event.type === 'content_block_delta') {
      const block = BlockDeltaSchema.parse(raw).event;
      if (block.delta.type === 'text_delta') {
        const preview = session.previews.get(block.index);
        if (!preview || block.delta.text === undefined) unavailable();
        events?.delta(session.id, turn.id, preview.id, block.delta.text);
      }
    }
  } else if (frame.type === 'result') {
    const result = ResultSchema.parse(raw);
    if (result.user_message_uuid === undefined) {
      // a turn Claude started completes without a captured result, since no action owns it
      const turn = session.nativeTurn;
      if (!turn) unavailable();
      session.nativeTurn = undefined;
      endTurn(session, events);
      events?.observe({
        kind: 'turn-completed',
        provider: 'claude',
        nativeThreadId: session.id,
        nativeTurnId: turn.id,
        state: toTurnState(result, turn),
      });
      return;
    }
    const input = session.input;
    if (!input || input.id !== result.user_message_uuid || session.nativeTurn) unavailable();
    acknowledge(session, events);
    const state = toTurnState(result, input);
    session.input = undefined;
    endTurn(session, events);
    const observedUsage = UsageSchema.safeParse(result.usage);
    const usage: ITurnUsage | null = observedUsage.success
      ? {
          inputTokens: observedUsage.data.input_tokens,
          outputTokens: observedUsage.data.output_tokens,
          cachedInputTokens: observedUsage.data.cache_read_input_tokens ?? null,
          scope: 'turn',
        }
      : null;
    const captured = toTurnResult(
      state,
      result.result ?? input.finalText,
      result.structured_output,
      input.requestId.endsWith(':compact') ? undefined : session.settings.outputSchema,
      usage,
    );
    if (input.isOutputOversized) {
      captured.state = 'failed';
      captured.failure = 'result-too-large';
      captured.isComplete = false;
      captured.text = null;
      captured.structuredOutput = null;
    }
    events?.observe({
      kind: 'turn-completed',
      provider: 'claude',
      nativeThreadId: session.id,
      nativeTurnId: input.id,
      state: captured.state,
      result: captured,
    });
  } else if (frame.type === 'control_request') {
    const request = RequestSchema.parse(raw);
    const turn = getActiveTurn(session);
    if (!turn || !session.connection) unavailable();
    const parsed = createClaudePrompt(
      request.request,
      session.id,
      turn.id,
      session.scope,
      request.request_id,
      async (message) => {
        const pending = session.requests.get(request.request_id);
        // a reply belongs to the turn its request came from, so it is written only while it runs
        if (getActiveTurn(session) !== turn || !pending || pending.isWritten) unavailable();
        pending.isWritten = true;
        await session.connection!.write(message);
        // elicitation control replies have no tool_result acknowledgement on this native protocol
      },
    );
    if (!parsed || session.requests.size >= 32) {
      void session.connection
        .write({
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: request.request_id,
            error: "HQ couldn't present this request",
          },
        })
        .catch(() => events?.unavailable(session.id));
      return;
    }
    const existing = session.requests.get(request.request_id);
    if (existing) {
      if (existing.fingerprint !== parsed.prompt.fingerprint) unavailable();
      return;
    }
    session.requests.set(request.request_id, {
      toolId: parsed.toolId,
      scopedId: parsed.prompt.requestId,
      fingerprint: parsed.prompt.fingerprint,
      isWritten: false,
    });
    events?.prompt(parsed.prompt);
  } else if (frame.type === 'control_cancel_request') {
    const id = CancelSchema.parse(raw).request_id;
    const request = session.requests.get(id);
    if (request)
      events?.observe({
        kind: 'request-canceled',
        provider: 'claude',
        nativeThreadId: session.id,
        requestId: request.scopedId,
      });
    session.requests.delete(id);
  } else if (frame.type === 'system') {
    // a list in an unexpected shape leaves the count as it was, as parking only waits on it
    const background = BackgroundTasksSchema.safeParse(raw);
    if (background.success) session.backgroundTaskCount = background.data.tasks.length;
  }
};
