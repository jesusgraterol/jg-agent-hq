import { Exception, isException } from 'jg-exception';
import { z } from 'zod';

import {
  LoginObservationSchema,
  type IAccountControlCommand,
  type ILoginObservation,
  type INativeControlResult,
} from '../../../contracts/index.js';
import type { IAgentProviderOutcome } from '../../index.js';
import { capabilityUnavailable } from '../../registry/index.js';
import type { createCodexRpc } from '../rpc.js';

const LoginSchema = z.object({
  type: z.literal('chatgpt'),
  loginId: z.string().min(1).max(4096),
  authUrl: LoginObservationSchema.shape.authorizationUrl.unwrap(),
});
const McpLoginSchema = z.object({
  loginId: z.string().min(1).max(4096),
  authorizationUrl: LoginObservationSchema.shape.authorizationUrl.unwrap(),
});
const CompletionSchema = z.object({
  loginId: z.string().min(1).max(4096),
  success: z.boolean(),
  name: z.string().optional(),
  threadId: z.string().nullable().optional(),
});
type ICompletion = z.infer<typeof CompletionSchema>;
type IAttempt = {
  kind: 'account' | 'mcp';
  nativeId: string | null;
  threadId?: string;
  serverName?: string;
  url: string | null;
  observedAt: number | null;
  isCanceling?: boolean;
  deferredCompletion?: ICompletion;
};

/**
 * Correlates native authentication challenges without persisting URLs or credential material.
 * @returns Concrete account/MCP login controls and bounded exact-identity notification routing.
 */
export const createCodexAuthentication = (
  connection: Awaited<ReturnType<typeof createCodexRpc>>,
  emit: (outcome: IAgentProviderOutcome) => void,
) => {
  const attempts = new Map<string, IAttempt>();
  const early = new Map<string, { kind: IAttempt['kind']; completion: ICompletion }>();
  const controls = new Map<string, { kind: 'cancel' | 'logout'; loginRequestId?: string }>();
  const isRejected = (error: unknown): boolean =>
    isException(error) && z.object({ nativeCode: z.number() }).safeParse(error.data).success;
  const conflict: () => never = () => {
    throw new Exception('The HQ action conflicts with its recorded state', {
      code: 'JG_AGENT_HQ_ACTION_CONFLICT',
      data: { kind: 'state-conflict' },
    });
  };
  const finish = (kind: IAttempt['kind'], completion: ICompletion): void => {
    for (const [requestId, attempt] of attempts) {
      if (attempt.kind !== kind || attempt.nativeId !== completion.loginId) continue;
      if (
        kind === 'mcp' &&
        (attempt.threadId !== completion.threadId || attempt.serverName !== completion.name)
      )
        continue;
      if (attempt.isCanceling && !completion.success) {
        attempt.deferredCompletion = completion;
        return;
      }
      attempts.delete(requestId);
      emit({
        kind: 'control-completed',
        requestId,
        completion: completion.success ? 'completed' : 'failed',
      });
      return;
    }
    if ([...attempts.values()].some((attempt) => attempt.nativeId === null) && early.size < 32)
      early.set(completion.loginId, { kind, completion });
  };
  const accepted = (requestId: string, raw: unknown): void => {
    const attempt = attempts.get(requestId);
    if (!attempt) return;
    const parsed = attempt.kind === 'account' ? LoginSchema.parse(raw) : McpLoginSchema.parse(raw);
    attempt.nativeId = parsed.loginId;
    attempt.url = 'authUrl' in parsed ? parsed.authUrl : parsed.authorizationUrl;
    attempt.observedAt = Date.now();
    const completion = early.get(parsed.loginId);
    if (completion) {
      early.delete(parsed.loginId);
      finish(completion.kind, completion.completion);
    }
    if (![...attempts.values()].some((attempt) => attempt.nativeId === null)) early.clear();
  };
  const begin = async (requestId: string, attempt: IAttempt): Promise<INativeControlResult> => {
    if (attempts.size >= 32) capabilityUnavailable();
    if (attempts.has(requestId)) conflict();
    attempts.set(requestId, attempt);
    try {
      const raw = await connection.request(
        attempt.kind === 'account' ? 'account/login/start' : 'mcpServer/oauth/login',
        attempt.kind === 'account'
          ? { type: 'chatgpt' }
          : { name: attempt.serverName, threadId: attempt.threadId },
        requestId,
      );
      accepted(requestId, raw);
      return { state: 'accepted', completion: null };
    } catch (error) {
      // keep the opaque request for an exact late response, but never show an unverified URL
      attempt.url = null;
      if (isRejected(error)) attempts.delete(requestId);
      throw error;
    }
  };
  /** Resolves cancellation only from its exact native acknowledgement, not error text. */
  const completeControl = (requestId: string, raw: unknown): INativeControlResult => {
    const control = controls.get(requestId);
    if (!control) conflict();
    if (control.kind === 'logout') {
      z.object({}).parse(raw);
      controls.delete(requestId);
      return { state: 'applied', completion: 'completed' };
    }
    const result = z.object({ status: z.enum(['canceled', 'notFound']) }).parse(raw);
    controls.delete(requestId);
    const attempt = attempts.get(control.loginRequestId!);
    if (result.status === 'canceled') {
      attempts.delete(control.loginRequestId!);
      emit({
        kind: 'control-completed',
        requestId: control.loginRequestId!,
        completion: 'interrupted',
      });
    } else if (attempt) {
      attempt.isCanceling = false;
      if (attempt.deferredCompletion) finish('account', attempt.deferredCompletion);
    }
    return { state: result.status === 'canceled' ? 'applied' : 'held', completion: 'completed' };
  };
  return {
    /** @returns Safe live presentation only while the exact native login remains pending. */
    async readLogin(requestId: string): Promise<ILoginObservation> {
      const attempt = attempts.get(requestId);
      return attempt
        ? {
            state: attempt.url ? 'pending' : 'unavailable',
            authorizationUrl: attempt.url,
            canCancel:
              attempt.kind === 'account' && attempt.nativeId !== null && !attempt.isCanceling,
            observedAt: attempt.observedAt,
          }
        : { state: 'unavailable', authorizationUrl: null, canCancel: false, observedAt: null };
    },
    /**
     * Starts, cancels or signs out through native account methods; never accepts raw credentials.
     * @returns Native acknowledgement with completion kept separate from login initiation.
     * @throws
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
     * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    async controlAccount(
      requestId: string,
      command: IAccountControlCommand,
      loginRequestId?: string,
    ): Promise<INativeControlResult> {
      if (command.kind === 'account-login')
        return begin(requestId, { kind: 'account', nativeId: null, url: null, observedAt: null });
      if (controls.size >= 32) capabilityUnavailable();
      const attempt = loginRequestId ? attempts.get(loginRequestId) : undefined;
      if (command.kind === 'account-login-cancel') {
        if (!attempt?.nativeId || attempt.kind !== 'account' || attempt.isCanceling) conflict();
        attempt.isCanceling = true;
      }
      controls.set(requestId, {
        kind: command.kind === 'account-logout' ? 'logout' : 'cancel',
        loginRequestId,
      });
      try {
        return completeControl(
          requestId,
          await connection.request(
            command.kind === 'account-logout' ? 'account/logout' : 'account/login/cancel',
            command.kind === 'account-logout' ? {} : { loginId: attempt!.nativeId },
            requestId,
          ),
        );
      } catch (error) {
        if (isRejected(error)) {
          controls.delete(requestId);
          if (attempt) {
            attempt.isCanceling = false;
            if (attempt.deferredCompletion) finish('account', attempt.deferredCompletion);
          }
        }
        throw error;
      }
    },
    /**
     * Starts OAuth for one configured native server and exact managed session.
     * @returns Native challenge admission; completion is matched by login, server and session IDs.
     * @throws
     * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
     * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
     * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
     * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
     */
    loginMcp(
      requestId: string,
      nativeId: string,
      serverName: string,
    ): Promise<INativeControlResult> {
      return begin(requestId, {
        kind: 'mcp',
        nativeId: null,
        threadId: nativeId,
        serverName,
        url: null,
        observedAt: null,
      });
    },
    /** Routes only supported completion notifications with exact correlation metadata. */
    notify(method: string, raw: unknown): void {
      const kind =
        method === 'account/login/completed'
          ? 'account'
          : method === 'mcpServer/oauthLogin/completed'
            ? 'mcp'
            : null;
      if (!kind) return;
      const parsed = CompletionSchema.safeParse(raw);
      if (parsed.success) finish(kind, parsed.data);
    },
    /** Retains uncertain initiation until its exact delayed native response is received. */
    lateResponse(requestId: string, result: unknown, error: unknown): boolean {
      if (controls.has(requestId)) {
        if (error !== undefined) {
          const control = controls.get(requestId)!;
          controls.delete(requestId);
          const attempt = control.loginRequestId ? attempts.get(control.loginRequestId) : undefined;
          if (attempt) {
            attempt.isCanceling = false;
            if (attempt.deferredCompletion) finish('account', attempt.deferredCompletion);
          }
          emit({ kind: 'failed', requestId, failure: 'agent-unavailable' });
        } else emit({ kind: 'control-accepted', requestId, ...completeControl(requestId, result) });
        return true;
      }
      if (!attempts.has(requestId)) return false;
      if (error !== undefined) {
        attempts.delete(requestId);
        emit({ kind: 'failed', requestId, failure: 'agent-unavailable' });
        return true;
      }
      accepted(requestId, result);
      emit({ kind: 'control-accepted', requestId, state: 'accepted', completion: null });
      return true;
    },
    /** Removes sensitive presentation when native ownership is lost. */
    unavailable(): void {
      attempts.clear();
      early.clear();
      controls.clear();
    },
  };
};
