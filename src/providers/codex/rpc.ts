import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { Exception, extractMessage } from 'jg-exception';
import { z } from 'zod';

import { createPendingRequests } from '../../pending/index.js';
import { createProviderProcess, type IProviderProcess } from '../index.js';
import { HQ_ERRORS } from '../../errors/index.js';

import { createWebSocketFraming } from './websocket/index.js';

const run = promisify(execFile);

const EnvelopeSchema = z.object({
  id: z.union([z.number().int(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

/**
 * Connects to the installed CLI's shared app-server daemon through its stdio proxy, starting the
 * daemon when no terminal session has, with bounded pending requests. The daemon's control socket
 * speaks WebSocket, which the proxy forwards as raw bytes. When the daemon restarts, the lost
 * connection's requests fail and the next request reconnects; nothing is sent again.
 * @param daemonLauncher The command and arguments run before `codex app-server daemon start`, so a
 * host can start the shared daemon outside its own service; empty runs the start directly.
 * @param handlers The callbacks for native messages and connection changes.
 * @returns An initialized transport with exact action IDs and late-response callbacks.
 * @throws
 * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
 * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
 */
export const createCodexRpc = async (
  daemonLauncher: string[],
  handlers: {
    notify(method: string, params: unknown): void;
    request(id: string | number, method: string, params: unknown): void;
    lateResponse(id: string, result: unknown, error: unknown): void;
    unavailable(): void;
    opened(): void;
    // a message over the size limit was discarded, so whatever it said is unknown
    discarded(): void;
  },
) => {
  const [launcherCommand, ...launcherArguments] = daemonLauncher;
  const daemonStart: [string, string[]] = launcherCommand
    ? [launcherCommand, [...launcherArguments, 'codex', 'app-server', 'daemon', 'start']]
    : ['codex', ['app-server', 'daemon', 'start']];
  const manifest = z
    .object({ version: z.string() })
    .parse(JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')));
  let sequence = 0;
  let isClosed = false;
  const pending = createPendingRequests<string | number>();
  const stopped = (cause: unknown): void => {
    handlers.unavailable();
    pending.rejectAll(
      new Exception(`The Codex integration failed: ${extractMessage(cause)}`, {
        code: 'JG_AGENT_HQ_CODEX_FAILED',
        data: { kind: 'agent-unavailable' },
        cause,
      }),
    );
  };
  const receive = (message: unknown): void => {
    const parsed = EnvelopeSchema.safeParse(message);
    if (!parsed.success)
      throw HQ_ERRORS.create('codexFailed', {
        data: { kind: 'agent-unavailable' },
        cause: parsed.error,
      });
    const envelope = parsed.data;
    if (envelope.method) {
      if (envelope.id !== undefined) {
        handlers.request(envelope.id, envelope.method, envelope.params);
      } else handlers.notify(envelope.method, envelope.params);
      return;
    }
    if (envelope.id === undefined)
      throw HQ_ERRORS.create('codexFailed', {
        data: { kind: 'agent-unavailable' },
      });
    const isPending = envelope.error
      ? pending.reject(
          envelope.id,
          new Exception(`The Codex integration failed: ${envelope.error.message}`, {
            code: 'JG_AGENT_HQ_CODEX_FAILED',
            data: {
              kind: 'agent-unavailable',
              nativeCode: envelope.error.code,
            },
          }),
        )
      : pending.resolve(envelope.id, envelope.result);
    if (!isPending && typeof envelope.id === 'string')
      handlers.lateResponse(envelope.id, envelope.result, envelope.error);
  };
  /**
   * Sends one request on the given transport and waits for its response.
   * @returns The native result.
   * @throws
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   */
  const send = (
    transport: IProviderProcess,
    method: string,
    params: unknown,
    actionRequestId?: string,
  ): Promise<unknown> => {
    if (!transport.isRunning || pending.size >= 32)
      throw HQ_ERRORS.create('codexFailed', { data: { kind: 'agent-unavailable' } });
    const id = actionRequestId ?? ++sequence;
    if (pending.has(id))
      throw HQ_ERRORS.create('codexFailed', { data: { kind: 'state-conflict' } });
    const response = pending.add(
      id,
      30_000,
      () =>
        new Exception('The Codex integration failed: request deadline exceeded', {
          code: 'JG_AGENT_HQ_CODEX_FAILED',
          data: { kind: 'agent-unavailable' },
        }),
    );
    void transport.write({ id, method, params }).catch((cause: unknown) => {
      pending.reject(
        id,
        new Exception(`The Codex integration failed: ${extractMessage(cause)}`, {
          code: 'JG_AGENT_HQ_CODEX_FAILED',
          data: { kind: 'agent-unavailable' },
          cause,
        }),
      );
    });
    return response;
  };
  /**
   * Opens and initializes one proxy connection; terminal sessions and HQ share one daemon,
   * which outlives it.
   * @returns The open transport and the daemon's user agent.
   * @throws
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
   */
  const open = async (): Promise<{ transport: IProviderProcess; userAgent: string | null }> => {
    try {
      await run(...daemonStart, { timeout: 30_000, maxBuffer: 65_536 });
    } catch (cause) {
      throw new Exception(`The Codex integration failed: ${extractMessage(cause)}`, {
        code: 'JG_AGENT_HQ_CODEX_FAILED',
        data: { kind: 'agent-unavailable' },
        cause,
      });
    }
    // EOF and child exit describe one loss; an old exit must not invalidate a replacement.
    let hasStopped = false;
    const transport = createProviderProcess(
      'codex',
      ['app-server', 'proxy'],
      receive,
      (cause) => {
        if (hasStopped) return;
        hasStopped = true;
        stopped(cause);
      },
      undefined,
      createWebSocketFraming(),
      () => handlers.discarded(),
    );
    try {
      const initialized = z
        .object({ userAgent: z.string().max(4096).nullable().optional().catch(null) })
        .safeParse(
          await send(transport, 'initialize', {
            clientInfo: { name: 'jg_agent_hq', title: 'JG Agent HQ', version: manifest.version },
            capabilities: { experimentalApi: true },
          }),
        );
      if (!initialized.success)
        throw HQ_ERRORS.create('codexFailed', {
          data: { kind: 'agent-unavailable' },
          cause: initialized.error,
        });
      await transport.write({ method: 'initialized', params: {} });
      return { transport, userAgent: initialized.data.userAgent ?? null };
    } catch (error) {
      try {
        await transport.close();
      } catch (cleanup) {
        throw new Exception(`The Codex integration failed: ${extractMessage(cleanup)}`, {
          code: 'JG_AGENT_HQ_CODEX_FAILED',
          data: { kind: 'agent-unavailable', cleanupUnconfirmed: true },
          cause: error,
        });
      }
      throw error;
    }
  };
  let connection = await open();
  let reopening: Promise<void> | undefined;
  /**
   * Reconnects once after the transport stopped, sharing one attempt between callers.
   * @throws
   * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
   * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
   */
  const ensureOpen = async (): Promise<void> => {
    if (connection.transport.isRunning) return;
    if (isClosed)
      throw new Exception('The Codex integration failed: connection closed', {
        code: 'JG_AGENT_HQ_CODEX_FAILED',
        data: { kind: 'agent-unavailable' },
      });
    reopening ??= (async () => {
      try {
        await connection.transport.close();
        connection = await open();
        handlers.opened();
      } finally {
        reopening = undefined;
      }
    })();
    await reopening;
  };
  return {
    get userAgent() {
      return connection.userAgent;
    },
    // false while disconnected; the next request reconnects until the connection is closed
    get isAvailable() {
      return connection.transport.isRunning;
    },
    async request(method: string, params: unknown, actionRequestId?: string): Promise<unknown> {
      await ensureOpen();
      return send(connection.transport, method, params, actionRequestId);
    },
    reply: (id: string | number, result: unknown) => connection.transport.write({ id, result }),
    reject: (id: string | number) =>
      connection.transport.write({ id, error: { code: -32601, message: 'Unsupported request' } }),
    /** Stops the current transport; the next request opens a new one. */
    async disconnect(): Promise<void> {
      await connection.transport.close();
    },
    async close(): Promise<void> {
      isClosed = true;
      stopped(
        new Exception('The Codex integration failed: connection closed', {
          code: 'JG_AGENT_HQ_CODEX_FAILED',
        }),
      );
      await connection.transport.close();
    },
  };
};
