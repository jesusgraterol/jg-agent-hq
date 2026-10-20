import { readFile } from 'node:fs/promises';
import { Exception, extractMessage } from 'error-message-utils';
import { z } from 'zod';

import { createProviderProcess } from '../index.js';

const EnvelopeSchema = z.object({
  id: z.union([z.number().int(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

/**
 * Connects to the installed CLI's stdio app-server with bounded pending requests.
 * @returns An initialized transport with exact action IDs and late-response callbacks.
 * @throws
 * - -1: The Codex integration failed
 * - -1: The HQ transport failed
 */
export const createCodexRpc = async (
  handlers: {
    notify(method: string, params: unknown): void;
    request(id: string | number, method: string, params: unknown): void;
    lateResponse(id: string, result: unknown, error: unknown): void;
    unavailable(): void;
  },
  extraSkillRoots: string[] = [],
) => {
  const manifest = z
    .object({ version: z.string() })
    .parse(JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')));
  let sequence = 0;
  const pending = new Map<
    string | number,
    {
      resolve: (result: unknown) => void;
      reject: (error: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const stopped = (cause: unknown): void => {
    handlers.unavailable();
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(
        new Exception(
          `The Codex integration failed: ${extractMessage(cause)}`,
          undefined,
          { kind: 'agent-unavailable' },
          { cause },
        ),
      );
    }
    pending.clear();
  };
  const transport = createProviderProcess(
    'codex',
    ['app-server', '--listen', 'stdio://'],
    (message) => {
      const parsed = EnvelopeSchema.safeParse(message);
      if (!parsed.success)
        throw new Exception(
          'The Codex integration failed',
          undefined,
          { kind: 'agent-unavailable' },
          { cause: parsed.error },
        );
      const envelope = parsed.data;
      if (envelope.method) {
        if (envelope.id !== undefined) {
          handlers.request(envelope.id, envelope.method, envelope.params);
        } else handlers.notify(envelope.method, envelope.params);
        return;
      }
      if (envelope.id === undefined)
        throw new Exception('The Codex integration failed', undefined, {
          kind: 'agent-unavailable',
        });
      const entry = pending.get(envelope.id);
      if (!entry) {
        if (typeof envelope.id === 'string')
          handlers.lateResponse(envelope.id, envelope.result, envelope.error);
        return;
      }
      pending.delete(envelope.id);
      clearTimeout(entry.timer);
      if (envelope.error)
        entry.reject(
          new Exception(`The Codex integration failed: ${envelope.error.message}`, undefined, {
            kind: 'agent-unavailable',
            nativeCode: envelope.error.code,
          }),
        );
      else entry.resolve(envelope.result);
    },
    stopped,
  );
  const request = async (
    method: string,
    params: unknown,
    actionRequestId?: string,
  ): Promise<unknown> => {
    if (!transport.isRunning || pending.size >= 32)
      throw new Exception('The Codex integration failed', undefined, { kind: 'agent-unavailable' });
    const id = actionRequestId ?? ++sequence;
    if (pending.has(id))
      throw new Exception('The Codex integration failed', undefined, { kind: 'state-conflict' });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Exception('The Codex integration failed: request deadline exceeded', undefined, {
            kind: 'agent-unavailable',
          }),
        );
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      void transport.write({ id, method, params }).catch((cause: unknown) => {
        const entry = pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(id);
        entry.reject(
          new Exception(
            `The Codex integration failed: ${extractMessage(cause)}`,
            undefined,
            { kind: 'agent-unavailable' },
            { cause },
          ),
        );
      });
    });
  };
  try {
    const initialized = z.object({ userAgent: z.string() }).safeParse(
      await request('initialize', {
        clientInfo: { name: 'jg_agent_hq', title: 'JG Agent HQ', version: manifest.version },
        capabilities: { experimentalApi: true },
      }),
    );
    if (!initialized.success)
      throw new Exception(
        'The Codex integration failed',
        undefined,
        { kind: 'agent-unavailable' },
        { cause: initialized.error },
      );
    await transport.write({ method: 'initialized', params: {} });
    if (extraSkillRoots.length) {
      const roots = z
        .object({})
        .safeParse(await request('skills/extraRoots/set', { extraRoots: extraSkillRoots }));
      if (!roots.success)
        throw new Exception(
          'The Codex integration failed',
          undefined,
          { kind: 'agent-unavailable' },
          { cause: roots.error },
        );
    }
    return {
      userAgent: initialized.data.userAgent,
      get isAvailable() {
        return transport.isRunning;
      },
      request,
      reply: (id: string | number, result: unknown) => transport.write({ id, result }),
      reject: (id: string | number) =>
        transport.write({ id, error: { code: -32601, message: 'Unsupported request' } }),
      async close(): Promise<void> {
        stopped(new Exception('The Codex integration failed: connection closed'));
        await transport.close();
      },
    };
  } catch (error) {
    try {
      await transport.close();
    } catch (cleanup) {
      throw new Exception(
        `The Codex integration failed: ${extractMessage(cleanup)}`,
        undefined,
        { kind: 'agent-unavailable', cleanupUnconfirmed: true },
        { cause: error },
      );
    }
    throw error;
  }
};
