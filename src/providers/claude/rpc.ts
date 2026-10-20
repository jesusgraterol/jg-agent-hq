import { Exception, extractMessage } from 'error-message-utils';
import { z } from 'zod';

import { createProviderProcess } from '../index.js';

import { ClaudeInitializeSchema } from './types.js';

const EnvelopeSchema = z.object({
  type: z.string(),
  response: z
    .object({
      subtype: z.enum(['success', 'error']),
      request_id: z.string(),
      response: z.unknown().optional(),
      error: z.string().optional(),
    })
    .optional(),
  request_id: z.string().optional(),
});

/**
 * Opens an idle native structured lane without a user prompt or inference.
 * @returns An owned control connection; normal CLI configuration remains enabled.
 * @throws
 * - -1: The Claude integration failed
 */
export const createClaudeRpc = async (
  invalidate: (reason: 'account' | 'limits' | 'unavailable') => void,
  control?: {
    nativeId: string;
    workspaceRoot: string;
    additionalDirectories: string[];
    isResume: boolean;
    receive(message: unknown): void;
    lateResponse(id: string, result: unknown, error: unknown): void;
  },
) => {
  let sequence = 0;
  const late = new Set<string>();
  const pending = new Map<
    string,
    {
      resolve(result: unknown): void;
      reject(cause: unknown): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const fail = (cause: unknown): void => {
    invalidate('unavailable');
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(
        new Exception(
          `The Claude integration failed: ${extractMessage(cause)}`,
          undefined,
          { kind: 'agent-unavailable' },
          { cause },
        ),
      );
    }
    pending.clear();
  };
  const transport = createProviderProcess(
    'claude',
    [
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      ...(control
        ? [
            '--permission-prompt-tool=stdio',
            '--replay-user-messages',
            '--include-partial-messages',
            control.isResume ? '--resume' : '--session-id',
            control.nativeId,
            ...control.additionalDirectories.flatMap((directory) => ['--add-dir', directory]),
          ]
        : []),
    ],
    (message) => {
      const parsed = EnvelopeSchema.safeParse(message);
      if (!parsed.success)
        throw new Exception(
          'The Claude integration failed',
          undefined,
          { kind: 'agent-unavailable' },
          { cause: parsed.error },
        );
      const envelope = parsed.data;
      if (envelope.type === 'control_response') {
        const response = envelope.response;
        if (!response)
          throw new Exception('The Claude integration failed', undefined, {
            kind: 'agent-unavailable',
          });
        const entry = pending.get(response.request_id);
        if (!entry) {
          if (late.delete(response.request_id))
            control?.lateResponse(
              response.request_id,
              response.response,
              response.subtype === 'error'
                ? (response.error ?? 'Native request rejected')
                : undefined,
            );
          return;
        }
        clearTimeout(entry.timer);
        pending.delete(response.request_id);
        if (response.subtype === 'error')
          entry.reject(
            new Exception(
              `The Claude integration failed: ${response.error ?? 'native control request rejected'}`,
              undefined,
              { kind: 'agent-unavailable', nativeRejection: true },
            ),
          );
        else entry.resolve(response.response);
      } else if (control) {
        control.receive(message);
      } else if (envelope.type === 'control_request' && envelope.request_id) {
        // this read-only lane never grants native tool permissions
        void transport
          .write({
            type: 'control_response',
            response: {
              subtype: 'error',
              request_id: envelope.request_id,
              error: 'Unsupported request',
            },
          })
          .catch(fail);
      } else if (envelope.type === 'auth_status') invalidate('account');
      else if (envelope.type === 'rate_limit_event') invalidate('limits');
    },
    fail,
    control?.workspaceRoot,
  );
  /**
   * Matches one native control acknowledgement and retains bounded late-response identity.
   * @returns The native success payload, which may be absent for acknowledgement-only controls.
   * @throws
   * - -1: The Claude integration failed
   */
  const request = (
    requestBody: { subtype: string; [key: string]: unknown },
    requestId?: string,
  ): Promise<unknown> => {
    if (!transport.isRunning || pending.size >= 32)
      return Promise.reject(
        new Exception('The Claude integration failed', undefined, { kind: 'agent-unavailable' }),
      );
    const id = requestId ?? `hq-read-${++sequence}`;
    if (pending.has(id) || late.has(id))
      return Promise.reject(
        new Exception('The Claude integration failed', undefined, { kind: 'agent-unavailable' }),
      );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        if (control) {
          late.add(id);
          if (late.size > 64) {
            fail(new Exception('The Claude integration failed'));
            void transport.close().catch(fail);
          }
        }
        reject(
          new Exception('The Claude integration failed: request deadline exceeded', undefined, {
            kind: 'agent-unavailable',
          }),
        );
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      void transport
        .write({
          type: 'control_request',
          request_id: id,
          request: requestBody,
        })
        .catch((cause: unknown) => {
          const entry = pending.get(id);
          if (!entry) return;
          pending.delete(id);
          clearTimeout(entry.timer);
          entry.reject(
            new Exception(
              `The Claude integration failed: ${extractMessage(cause)}`,
              undefined,
              { kind: 'agent-unavailable' },
              { cause },
            ),
          );
        });
    });
  };
  try {
    const initialized = ClaudeInitializeSchema.safeParse(await request({ subtype: 'initialize' }));
    if (!initialized.success)
      throw new Exception(
        'The Claude integration failed',
        undefined,
        { kind: 'agent-unavailable' },
        { cause: initialized.error },
      );
    return {
      version: initialized.data.claude_code_version,
      initialization: initialized.data,
      initializedAt: Date.now(),
      requestControl: request,
      write: transport.write,
      get isAvailable() {
        return transport.isRunning;
      },
      /**
       * Requests the native account observation without transcript-behavior scanning.
       * @returns The structured native response for the adapter to validate.
       * @throws
       * - -1: The Claude integration failed
       */
      requestUsage: () => request({ subtype: 'get_usage', skip_behaviors: true }),
      /**
       * Cancels pending reads and confirms native process-group exit.
       * @returns Confirmed native shutdown.
       * @throws
       * - -1: The HQ transport failed
       */
      async close(): Promise<void> {
        fail(new Exception('The Claude integration failed: connection closed'));
        await transport.close();
      },
    };
  } catch (cause) {
    try {
      await transport.close();
    } catch (cleanup) {
      throw new Exception(
        `The Claude integration failed: ${extractMessage(cleanup)}`,
        undefined,
        { kind: 'agent-unavailable', cleanupUnconfirmed: true },
        { cause },
      );
    }
    throw cause;
  }
};
