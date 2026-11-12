import { Exception, extractMessage } from 'jg-exception';
import { z } from 'zod';

import type { ISessionSettings } from '../../contracts/index.js';
import { createPendingRequests } from '../../pending/index.js';
import { createProviderProcess } from '../index.js';
import { HQ_ERRORS } from '../../errors/index.js';

import { ClaudeInitializeSchema } from './types.js';
import { toClaudeSessionFlags } from './configuration/index.js';

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
// identity remains a fatal fence outside recoverable interpretation of an owned lane
const ControlIdentitySchema = z.object({ session_id: z.string().optional() });

/**
 * Opens an idle native structured lane without a user prompt or inference: a session's, or a
 * session-less read lane, which a folder-scoped read starts in its folder with the additional
 * directories sessions get, so it sees the commands a session started there would.
 * @returns An owned control connection; normal CLI configuration remains enabled.
 * @throws
 * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
 * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
 */
export const createClaudeRpc = async (
  invalidate: (reason: 'account' | 'limits' | 'unavailable') => void,
  control?: {
    nativeId: string;
    workspaceRoot: string;
    additionalDirectories: string[];
    isResume: boolean;
    settings?: ISessionSettings;
    quarantine(cause?: unknown): boolean;
    observe?(message: unknown): void;
    written?(message: unknown): void;
    receive(message: unknown): void;
    lateResponse(id: string, result: unknown, error: unknown): void;
  },
  lane?: { workspaceRoot: string; additionalDirectories: string[] },
  signal?: AbortSignal,
) => {
  let sequence = 0;
  const late = new Set<string>();
  const pending = createPendingRequests<string>();
  const inFlight = new Set<string>();
  const quarantinedRequests = new Set<string>();
  let isInitialized = false;
  let isQuarantined = false;
  let pendingWrites = 0;
  let hasUnverifiableRequests = false;
  /** Rejects HQ promises without closing the native transport or accepting late acknowledgements. */
  const quarantine = (cause?: unknown): void => {
    if (isQuarantined) return;
    isQuarantined = true;
    for (const id of inFlight) quarantinedRequests.add(id);
    inFlight.clear();
    pending.rejectAll(
      new Exception(
        `The Claude integration failed${cause === undefined ? '' : `: ${extractMessage(cause)}`}`,
        { code: 'JG_AGENT_HQ_CLAUDE_FAILED', data: { kind: 'agent-unavailable' }, cause },
      ),
    );
  };
  /** Contains only an initialized owned controller; startup and unowned lane failures remain fatal. */
  const contain = (cause: unknown): void => {
    if (!isInitialized || !control?.quarantine(cause)) throw cause;
    quarantine(cause);
  };
  const fail = (cause: unknown): void => {
    invalidate('unavailable');
    pending.rejectAll(
      new Exception(`The Claude integration failed: ${extractMessage(cause)}`, {
        code: 'JG_AGENT_HQ_CLAUDE_FAILED',
        data: { kind: 'agent-unavailable' },
        cause,
      }),
    );
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
            ...toClaudeSessionFlags(control.settings ?? {}),
          ]
        : (lane?.additionalDirectories.flatMap((directory) => ['--add-dir', directory]) ?? [])),
    ],
    (message) => {
      if (control) {
        const identity = ControlIdentitySchema.safeParse(message);
        if (
          !identity.success ||
          (identity.data.session_id !== undefined && identity.data.session_id !== control.nativeId)
        )
          throw HQ_ERRORS.create('claudeFailed', { data: { kind: 'agent-unavailable' } });
        control.observe?.(message);
      }
      const parsed = EnvelopeSchema.safeParse(message);
      if (!parsed.success) {
        contain(
          HQ_ERRORS.create('claudeFailed', {
            data: { kind: 'agent-unavailable' },
            cause: parsed.error,
          }),
        );
        return;
      }
      const envelope = parsed.data;
      if (envelope.type === 'control_response') {
        const response = envelope.response;
        if (!response) {
          contain(
            HQ_ERRORS.create('claudeFailed', {
              data: { kind: 'agent-unavailable' },
            }),
          );
          return;
        }
        if (isQuarantined) {
          quarantinedRequests.delete(response.request_id);
          late.delete(response.request_id);
          return;
        }
        inFlight.delete(response.request_id);
        const isPending =
          response.subtype === 'error'
            ? pending.reject(
                response.request_id,
                new Exception(
                  `The Claude integration failed: ${response.error ?? 'native control request rejected'}`,
                  {
                    code: 'JG_AGENT_HQ_CLAUDE_FAILED',
                    data: { kind: 'agent-unavailable', nativeRejection: true },
                  },
                ),
              )
            : pending.resolve(response.request_id, response.response);
        if (!isPending && late.delete(response.request_id))
          control?.lateResponse(
            response.request_id,
            response.response,
            response.subtype === 'error'
              ? (response.error ?? 'Native request rejected')
              : undefined,
          );
      } else if (control) {
        if (isQuarantined) return;
        try {
          control.receive(message);
        } catch (cause) {
          contain(cause);
        }
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
    control?.workspaceRoot ?? lane?.workspaceRoot,
  );
  /**
   * Matches one native control acknowledgement and retains bounded late-response identity.
   * @returns The native success payload, which may be absent for acknowledgement-only controls.
   * @throws
   * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
   */
  const request = (
    requestBody: { subtype: string; [key: string]: unknown },
    requestId?: string,
  ): Promise<unknown> => {
    if (isQuarantined || !transport.isRunning || pending.size >= 32)
      return Promise.reject(
        HQ_ERRORS.create('claudeFailed', { data: { kind: 'agent-unavailable' } }),
      );
    const id = requestId ?? `hq-read-${++sequence}`;
    if (pending.has(id) || late.has(id))
      return Promise.reject(
        HQ_ERRORS.create('claudeFailed', { data: { kind: 'agent-unavailable' } }),
      );
    inFlight.add(id);
    const response = pending.add(id, 30_000, () => {
      inFlight.delete(id);
      // a controlled session keeps a late answer's identity, to settle what it acknowledges
      if (control) {
        late.add(id);
        if (late.size > 64) {
          late.delete(id);
          hasUnverifiableRequests = true;
          if (control.quarantine()) quarantine();
          else {
            fail(HQ_ERRORS.create('claudeFailed'));
            void transport.close().catch(fail);
          }
        }
      }
      return new Exception('The Claude integration failed: request deadline exceeded', {
        code: 'JG_AGENT_HQ_CLAUDE_FAILED',
        data: { kind: 'agent-unavailable' },
      });
    });
    void transport
      .write({
        type: 'control_request',
        request_id: id,
        request: requestBody,
      })
      .catch((cause: unknown) => {
        inFlight.delete(id);
        pending.reject(
          id,
          new Exception(`The Claude integration failed: ${extractMessage(cause)}`, {
            code: 'JG_AGENT_HQ_CLAUDE_FAILED',
            data: { kind: 'agent-unavailable' },
            cause,
          }),
        );
      });
    return response;
  };
  let cancellationCleanup: Promise<void> | undefined;
  const cancel = (): void => {
    fail(HQ_ERRORS.create('claudeFailed', { data: { kind: 'agent-unavailable' } }));
    cancellationCleanup ??= transport.close();
    // the owning close/catch awaits this same cleanup and preserves an unconfirmed exit
    void cancellationCleanup.catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted)
      throw HQ_ERRORS.create('claudeFailed', { data: { kind: 'agent-unavailable' } });
    const initialized = ClaudeInitializeSchema.safeParse(await request({ subtype: 'initialize' }));
    if (!initialized.success)
      throw HQ_ERRORS.create('claudeFailed', {
        data: { kind: 'agent-unavailable' },
        cause: initialized.error,
      });
    isInitialized = true;
    return {
      version: initialized.data.claude_code_version ?? null,
      initialization: initialized.data,
      initializedAt: Date.now(),
      requestControl: request,
      quarantine,
      pid: transport.pid,
      get hasPendingRequests() {
        return (
          hasUnverifiableRequests ||
          pending.size > 0 ||
          late.size > 0 ||
          quarantinedRequests.size > 0 ||
          pendingWrites > 0
        );
      },
      /**
       * Writes native input only while rich control remains available.
       * @returns Confirmation that the transport accepted the write, never native consumption.
       * @throws
       * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
       * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
       */
      async write(message: unknown): Promise<void> {
        if (isQuarantined)
          throw HQ_ERRORS.create('claudeFailed', { data: { kind: 'agent-unavailable' } });
        pendingWrites += 1;
        try {
          await transport.write(message);
          control?.written?.(message);
        } catch (cause) {
          // write integrity failures retain the transport shutdown path, unlike interpretation loss
          fail(cause);
          throw new Exception(`The HQ transport failed: ${extractMessage(cause)}`, {
            code: 'JG_AGENT_HQ_TRANSPORT_FAILED',
            data: { kind: 'agent-unavailable' },
            cause,
          });
        } finally {
          pendingWrites -= 1;
        }
      },
      get isAvailable() {
        return transport.isRunning;
      },
      /**
       * Requests the native account observation without transcript-behavior scanning.
       * @returns The structured native response for the adapter to validate.
       * @throws
       * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
       */
      requestUsage: () => request({ subtype: 'get_usage', skip_behaviors: true }),
      /**
       * Cancels pending reads and confirms native process-group exit.
       * @returns Confirmed native shutdown.
       * @throws
       * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
       */
      async close(): Promise<void> {
        signal?.removeEventListener('abort', cancel);
        fail(
          new Exception('The Claude integration failed: connection closed', {
            code: 'JG_AGENT_HQ_CLAUDE_FAILED',
          }),
        );
        await (cancellationCleanup ?? transport.close());
      },
    };
  } catch (cause) {
    signal?.removeEventListener('abort', cancel);
    try {
      await (cancellationCleanup ?? transport.close());
    } catch (cleanup) {
      throw new Exception(`The Claude integration failed: ${extractMessage(cleanup)}`, {
        code: 'JG_AGENT_HQ_CLAUDE_FAILED',
        data: { kind: 'agent-unavailable', cleanupUnconfirmed: true },
        cause,
      });
    }
    throw cause;
  }
};
