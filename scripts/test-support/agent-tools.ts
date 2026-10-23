import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { AgentToolResultSchema } from 'jg-agent-hq/contracts';
import { expect } from 'vitest';
import { z } from 'zod';

import type { ICollaborationFixture } from './collaboration.js';
import { writeFixtureControl } from './controls.js';

/** Exercises the actual Codex callback connection through an external native fixture. */
export const callCodexTool = async (
  fixture: ICollaborationFixture,
  name: string,
  argumentsValue: object,
  controls: object = {},
) => {
  await writeFixtureControl(fixture.native.root, 'control.json', {
    toolCall: { tool: name, arguments: argumentsValue },
    ...controls,
  });
  const status = await fixture.native.request({ kind: 'status' });
  if (status.kind !== 'status') throw new Error('Missing status');
  const actionId = randomUUID();
  await fixture.native.request({
    kind: 'action',
    action: {
      id: actionId,
      runtimeEpoch: status.result.runtimeEpoch,
      command: {
        kind: 'message',
        threadId: fixture.agentIds[0]!,
        input: { kind: 'text', text: 'Use the configured HQ fixture tool' },
      },
    },
  });
  await expect
    .poll(async () => {
      const receipt = await fixture.native.request({ kind: 'receipt', actionId });
      return receipt.kind === 'receipt' ? receipt.result?.completion : null;
    })
    .toBe('completed');
  const replies = (await readFile(join(fixture.native.root, 'replies.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) =>
      z
        .object({ id: z.string(), result: z.unknown().optional(), error: z.unknown().optional() })
        .parse(JSON.parse(line)),
    );
  const reply = replies.filter((item) => item.id.startsWith('tool-call-')).at(-1);
  if (!reply) throw new Error('Missing native tool reply');
  return reply;
};

/** Starts the installed bridge exactly as Claude's session-specific MCP configuration specifies. */
export const withAgentBridge = async (
  fixture: ICollaborationFixture,
  run: (bridge: {
    filePath: string;
    pid: number;
    request(method: string, params?: object): Promise<unknown>;
    call(name: string, argumentsValue: object): Promise<z.infer<typeof AgentToolResultSchema>>;
  }) => Promise<void>,
): Promise<void> => {
  const starts = (await readFile(join(fixture.native.root, 'claude-starts.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => z.object({ id: z.string(), args: z.array(z.string()) }).parse(JSON.parse(line)));
  const selected = await fixture.native.request({
    kind: 'managed-thread',
    threadId: fixture.agentIds[1]!,
  });
  if (selected.kind !== 'managed-thread' || !selected.result)
    throw new Error('Missing Claude identity');
  const args = starts.filter((start) => start.id === selected.result!.nativeId).at(-1)!.args;
  const configuration = z
    .object({
      mcpServers: z.record(
        z.string(),
        z.object({
          command: z.string(),
          args: z.array(z.string()),
          env: z.record(z.string(), z.string()),
        }),
      ),
    })
    .parse(JSON.parse(args[args.indexOf('--mcp-config') + 1]!));
  const server = Object.values(configuration.mcpServers)[0]!;
  const child = spawn(server.command, server.args, {
    env: { ...process.env, ...server.env },
    stdio: 'pipe',
  });
  const closed = once(child, 'close');
  const reader = createInterface({ input: child.stdout });
  const pending = new Map<
    number,
    { resolve(result: unknown): void; reject(error: unknown): void }
  >();
  let sequence = 0;
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 65_536) stderr += chunk.toString();
  });
  reader.on('line', (line) => {
    const envelope = z
      .object({
        id: z.number().optional(),
        result: z.unknown().optional(),
        error: z.unknown().optional(),
      })
      .parse(JSON.parse(line));
    if (envelope.id === undefined) return;
    const entry = pending.get(envelope.id);
    if (!entry) return;
    pending.delete(envelope.id);
    if (envelope.error) entry.reject(new Error('MCP request rejected'));
    else entry.resolve(envelope.result);
  });
  child.once('close', () => {
    for (const entry of pending.values()) entry.reject(new Error('MCP process closed'));
    pending.clear();
  });
  const request = async (method: string, params: object = {}): Promise<unknown> => {
    const id = ++sequence;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('MCP fixture request timed out'));
        }, 10_000);
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'hq-fixture', version: '1' },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    await run({
      filePath: server.env.JG_AGENT_HQ_BRIDGE_FILE!,
      pid: child.pid!,
      request,
      call: async (name, argumentsValue) =>
        AgentToolResultSchema.parse(
          await request('tools/call', { name, arguments: argumentsValue }),
        ),
    });
    expect(stderr).toBe('');
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGTERM'), 2000);
    try {
      await closed;
    } finally {
      clearTimeout(timer);
      reader.close();
    }
    expect(() => process.kill(child.pid!, 0)).toThrow();
  }
};
