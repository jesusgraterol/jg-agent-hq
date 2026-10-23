import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectToRejectCode } from 'jg-exception/testing';
import type { IActionCommand, IActionReceipt } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';

import {
  withClaudeRuntime,
  writeFixtureControl,
  type IClaudeFixture,
} from '../../scripts/test-support/index.js';

const submit = async (
  fixture: IClaudeFixture,
  command: IActionCommand,
): Promise<IActionReceipt> => {
  const status = await fixture.request({ kind: 'status' });
  if (status.kind !== 'status') throw new Error('Missing status');
  const response = await fixture.request({
    kind: 'action',
    action: { id: randomUUID(), runtimeEpoch: status.result.runtimeEpoch, command },
  });
  if (response.kind !== 'action') throw new Error('Missing action');
  return response.result;
};
const receipt = async (fixture: IClaudeFixture, id: string): Promise<IActionReceipt> => {
  const response = await fixture.request({ kind: 'receipt', actionId: id });
  if (response.kind !== 'receipt' || !response.result) throw new Error('Missing receipt');
  return response.result;
};
const settle = async (fixture: IClaudeFixture, id: string): Promise<IActionReceipt> => {
  await expect.poll(async () => (await receipt(fixture, id)).delivery).not.toBe('submitted');
  return receipt(fixture, id);
};
const create = async (fixture: IClaudeFixture, provider: string): Promise<string> => {
  const result = await submit(fixture, {
    kind: 'thread-create',
    provider,
    workspaceRoot: fixture.workspaceRoot,
    name: 'extensions',
  });
  await settle(fixture, result.id);
  return result.threadId!;
};

test.each(['codex', 'claude'])(
  'MCP catalogs(%s) omit configuration and preserve missing native fields',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const threadId = await create(fixture, provider);
      const servers = await fixture.request({ kind: 'mcp-servers', threadId });
      expect(servers).toMatchObject({
        kind: 'mcp-servers',
        result: {
          state: 'available',
          data: [{ name: 'fixture-server', connectionState: 'connected' }],
          nextCursor: null,
        },
      });
      expect(JSON.stringify(servers)).not.toContain('credential-must-not-be-returned');
      const tools = await fixture.request({
        kind: 'mcp-tools',
        threadId,
        serverName: 'fixture-server',
      });
      expect(tools).toMatchObject({
        kind: 'mcp-tools',
        result: {
          state: 'available',
          data: [
            {
              name: 'inspect',
              isReadOnly: true,
              inputSchema: provider === 'codex' ? { type: 'object' } : null,
            },
          ],
        },
      });
      const resources = await fixture.request({
        kind: 'mcp-resources',
        threadId,
        serverName: 'fixture-server',
        limit: 1,
      });
      expect(resources).toMatchObject({
        kind: 'mcp-resources',
        result:
          provider === 'codex'
            ? {
                state: 'available',
                data: [{ kind: expect.stringMatching(/resource|template/) }],
                nextCursor: expect.any(String),
              }
            : { state: 'unsupported', data: [], nextCursor: null },
      });
    });
  },
);

test.each(['codex', 'claude'])(
  'native catalog failure(%s) remains local to metadata reads',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const threadId = await create(fixture, provider);
      if (provider === 'codex')
        await writeFixtureControl(fixture.root, 'control.json', { mcpFailure: true });
      else await fixture.control({ mcpFailure: true });
      expect(await fixture.request({ kind: 'mcp-servers', threadId })).toMatchObject({
        kind: 'mcp-servers',
        result: { state: 'unavailable', data: [] },
      });
      const sent = await submit(fixture, {
        kind: 'message',
        threadId,
        input: { kind: 'text', text: 'Still available' },
      });
      expect((await settle(fixture, sent.id)).delivery).toBe('acknowledged');
    });
  },
);

test('tool pagination binds content revisions, server selection and page size', async () => {
  await withClaudeRuntime(async (fixture) => {
    const threadId = await create(fixture, 'codex');
    const server = {
      name: 'fixture-server',
      tools: { a: { name: 'a' }, b: { name: 'b' }, c: { name: 'c' } },
      resources: [],
      resourceTemplates: [],
    };
    await writeFixtureControl(fixture.root, 'control.json', { mcpServers: [server] });
    const first = await fixture.request({
      kind: 'mcp-tools',
      threadId,
      serverName: server.name,
      limit: 2,
    });
    if (first.kind !== 'mcp-tools') throw new Error('Missing catalog');
    expect(first.result.data.map((tool) => tool.name)).toStrictEqual(['a', 'b']);
    expect(first.result.nextCursor).not.toBeNull();
    const continuation = {
      kind: 'mcp-tools' as const,
      threadId,
      serverName: server.name,
      limit: 2,
      cursor: first.result.nextCursor!,
    };
    expect(await fixture.request(continuation)).toMatchObject({
      kind: 'mcp-tools',
      result: { data: [{ name: 'c' }], nextCursor: null },
    });
    await expectToRejectCode(
      fixture.request({ ...continuation, serverName: 'other' }),
      'JG_AGENT_HQ_CLIENT_INVALID_REQUEST',
    );
    await writeFixtureControl(fixture.root, 'control.json', {
      mcpServers: [{ ...server, tools: { ...server.tools, d: { name: 'd' } } }],
    });
    await expectToRejectCode(fixture.request(continuation), 'JG_AGENT_HQ_CLIENT_INVALID_REQUEST');
  });
});

test.each(['codex', 'claude'])(
  'skill reload(%s) refreshes the explicit-only catalog without sending a turn',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const threadId = await create(fixture, provider);
      const before = await fixture.request({ kind: 'skills', threadId });
      if (before.kind !== 'skills') throw new Error('Missing skills');
      expect(before.result.state).toBe('available');
      expect(before.result.data.map((skill) => skill.name).sort()).toStrictEqual([
        'explicit-skill',
        'implicit-skill',
      ]);
      if (provider === 'codex')
        await writeFixtureControl(fixture.root, 'control.json', { skillRevision: true });
      else await fixture.control({ skillRevision: true });
      const reload = await submit(fixture, { kind: 'skills-reload', threadId });
      expect(await settle(fixture, reload.id)).toMatchObject({
        delivery: 'acknowledged',
        controlState: 'applied',
        completion: 'completed',
      });
      const after = await fixture.request({ kind: 'skills', threadId });
      if (after.kind !== 'skills') throw new Error('Missing skills');
      expect(after.result.state).toBe('available');
      expect(after.result.data.map((skill) => skill.name).sort()).toStrictEqual([
        'changed-explicit-skill',
        'changed-implicit-skill',
      ]);
      const calls = await readFile(
        join(fixture.root, provider === 'codex' ? 'calls.jsonl' : 'claude-calls.jsonl'),
        'utf8',
      );
      expect(calls).not.toContain('turn/start');
      expect(calls).not.toContain('"type":"user"');
    });
  },
);

test.each([
  ['codex', 'mcp-reload'],
  ['claude', 'mcp-reconnect'],
  ['claude', 'mcp-set-enabled'],
  ['claude', 'plugins-reload'],
] as const)('extension control(%s, %s) uses the native operation', async (provider, kind) => {
  await withClaudeRuntime(async (fixture) => {
    const threadId = await create(fixture, provider);
    const command =
      kind === 'mcp-reload' || kind === 'plugins-reload'
        ? { kind, threadId }
        : kind === 'mcp-reconnect'
          ? { kind, threadId, serverName: 'fixture-server' }
          : { kind, threadId, serverName: 'fixture-server', isEnabled: false };
    const result = await submit(fixture, command);
    expect(await settle(fixture, result.id)).toMatchObject({
      delivery: 'acknowledged',
      controlState: 'applied',
      completion: 'completed',
    });
    const calls = await readFile(
      join(fixture.root, provider === 'codex' ? 'calls.jsonl' : 'claude-calls.jsonl'),
      'utf8',
    );
    expect(calls).toContain(
      kind === 'mcp-reload'
        ? 'config/mcpServer/reload'
        : kind === 'mcp-reconnect'
          ? 'mcp_reconnect'
          : kind === 'mcp-set-enabled'
            ? 'mcp_toggle'
            : 'reload_plugins',
    );
  });
});

test('held plugin reload is reported without claiming the native change was applied', async () => {
  await withClaudeRuntime(async (fixture) => {
    const threadId = await create(fixture, 'claude');
    await fixture.control({ holdPlugins: true });
    const result = await submit(fixture, { kind: 'plugins-reload', threadId });
    expect(await settle(fixture, result.id)).toMatchObject({
      delivery: 'acknowledged',
      controlState: 'held',
      completion: 'completed',
    });
  });
});

test.each(['codex', 'claude'])(
  'native extension rejection(%s) leaves the idle session usable and diagnostics private',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const threadId = await create(fixture, provider);
      if (provider === 'codex')
        await writeFixtureControl(fixture.root, 'control.json', { rejectExtension: true });
      else await fixture.control({ rejectExtension: true });
      const result = await submit(
        fixture,
        provider === 'codex'
          ? { kind: 'mcp-reload', threadId }
          : { kind: 'mcp-reconnect', threadId, serverName: 'fixture-server' },
      );
      expect(await settle(fixture, result.id)).toMatchObject({
        delivery: 'failed',
        failure: 'agent-unavailable',
      });
      expect(JSON.stringify(await receipt(fixture, result.id))).not.toContain(
        'Sensitive native failure',
      );
      expect(await fixture.request({ kind: 'managed-thread', threadId })).toMatchObject({
        kind: 'managed-thread',
        result: { state: 'idle' },
      });
      const sent = await submit(fixture, {
        kind: 'message',
        threadId,
        input: { kind: 'text', text: 'Still available' },
      });
      expect((await settle(fixture, sent.id)).delivery).toBe('acknowledged');
    });
  },
);

test.each(['codex', 'claude'])(
  'extension changes(%s) cannot bypass a native permission wait',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const threadId = await create(fixture, provider);
      if (provider === 'codex')
        await writeFixtureControl(fixture.root, 'control.json', {
          holdTurn: true,
          prompt: {
            method: 'item/commandExecution/requestApproval',
            params: {
              startedAtMs: Date.now(),
              command: 'echo fixture',
              cwd: fixture.workspaceRoot,
              availableDecisions: ['accept', 'decline'],
            },
          },
        });
      else await fixture.control({ prompt: 'permission' });
      const sent = await submit(fixture, {
        kind: 'message',
        threadId,
        input: { kind: 'text', text: 'Wait for native permission' },
      });
      await settle(fixture, sent.id);
      await expect
        .poll(async () => {
          const result = await fixture.request({ kind: 'managed-thread', threadId });
          return result.kind === 'managed-thread' ? result.result?.state : null;
        })
        .toBe('waiting-approval');
      const result = await submit(fixture, { kind: 'skills-reload', threadId });
      expect(result).toMatchObject({ delivery: 'failed', failure: 'state-conflict' });
    });
  },
);

test('MCP OAuth completion is correlated to its exact login, server and native thread', async () => {
  await withClaudeRuntime(async (fixture) => {
    const threadId = await create(fixture, 'codex');
    await writeFixtureControl(fixture.root, 'control.json', { loginCompletesEarly: true });
    const started = await submit(fixture, {
      kind: 'mcp-login',
      threadId,
      serverName: 'fixture-server',
    });
    await expect
      .poll(async () => (await receipt(fixture, started.id)).completion)
      .toBe('completed');
    expect(await fixture.request({ kind: 'login', actionId: started.id })).toMatchObject({
      kind: 'login',
      result: { state: 'completed', authorizationUrl: null },
    });
  });
});

test.each(['codex', 'claude'])(
  'an exact late extension acknowledgement(%s) resolves uncertainty without replay',
  { timeout: 45_000 }, // exercises the native 30-second request deadline and its delayed acknowledgement
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const threadId = await create(fixture, provider);
      if (provider === 'codex')
        await writeFixtureControl(fixture.root, 'control.json', { lateExtension: true });
      else await fixture.control({ lateExtension: true });
      const result = await submit(
        fixture,
        provider === 'codex'
          ? { kind: 'mcp-reload', threadId }
          : { kind: 'mcp-reconnect', threadId, serverName: 'fixture-server' },
      );
      await expect
        .poll(async () => (await receipt(fixture, result.id)).delivery, { timeout: 33_000 })
        .toBe('uncertain');
      await expect
        .poll(async () => (await receipt(fixture, result.id)).delivery, { timeout: 8_000 })
        .toBe('acknowledged');
      expect(await receipt(fixture, result.id)).toMatchObject({
        controlState: 'applied',
        completion: 'completed',
      });
      expect(await fixture.request({ kind: 'managed-thread', threadId })).toMatchObject({
        kind: 'managed-thread',
        result: { state: 'idle' },
      });
      const filename = provider === 'codex' ? 'calls.jsonl' : 'claude-calls.jsonl';
      const calls = (await readFile(join(fixture.root, filename), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { method?: string; request?: { subtype?: string } });
      expect(
        calls.filter((call) =>
          provider === 'codex'
            ? call.method === 'config/mcpServer/reload'
            : call.request?.subtype === 'mcp_reconnect',
        ),
      ).toHaveLength(1);
    });
  },
);

test.each(['codex', 'claude'])(
  'excessive native tool inventories(%s) remain unavailable without affecting server status',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const threadId = await create(fixture, provider);
      const tools = Array.from({ length: 4097 }, (_, index) => ({ name: 'tool-' + index }));
      const settings = {
        mcpServers: [
          {
            name: 'fixture-server',
            status: 'connected',
            runtimeStatus: 'connected',
            tools:
              provider === 'codex'
                ? Object.fromEntries(tools.map((tool) => [tool.name, tool]))
                : tools,
            resources: [],
            resourceTemplates: [],
          },
        ],
      };
      if (provider === 'codex') await writeFixtureControl(fixture.root, 'control.json', settings);
      else await fixture.control(settings);
      expect(
        await fixture.request({ kind: 'mcp-tools', threadId, serverName: 'fixture-server' }),
      ).toMatchObject({
        kind: 'mcp-tools',
        result: { state: 'unavailable', data: [], nextCursor: null },
      });
      expect(await fixture.request({ kind: 'mcp-servers', threadId })).toMatchObject({
        kind: 'mcp-servers',
        result: { state: 'available', data: [{ name: 'fixture-server', serverInfo: null }] },
      });
    });
  },
);

test('native reload leaves interrupted queued input paused for an explicit send', async () => {
  await withClaudeRuntime(async (fixture) => {
    const threadId = await create(fixture, 'codex');
    await writeFixtureControl(fixture.root, 'control.json', { holdTurn: true });
    const sent = await submit(fixture, {
      kind: 'message',
      threadId,
      input: { kind: 'text', text: 'Hold this turn' },
    });
    const running = await settle(fixture, sent.id);
    if (!running.nativeTurnId) throw new Error('Missing turn');
    const queued = await submit(fixture, {
      kind: 'queue',
      threadId,
      expectedTurnId: running.nativeTurnId,
      input: { kind: 'text', text: 'Keep this queued' },
    });
    const interrupted = await submit(fixture, {
      kind: 'interrupt',
      threadId,
      expectedTurnId: running.nativeTurnId,
    });
    await settle(fixture, interrupted.id);
    await expect
      .poll(async () => {
        const response = await fixture.request({ kind: 'managed-thread', threadId });
        return response.kind === 'managed-thread' ? response.result?.state : null;
      })
      .toBe('interrupted');
    const reloaded = await submit(fixture, { kind: 'mcp-reload', threadId });
    expect((await settle(fixture, reloaded.id)).delivery).toBe('acknowledged');
    expect(await receipt(fixture, queued.id)).toMatchObject({
      delivery: 'queued',
      completion: null,
    });
    const calls = (await readFile(join(fixture.root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method: string });
    expect(calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
  });
});

test('MCP completion selects the full server/session identity when native login IDs collide', async () => {
  await withClaudeRuntime(async (fixture) => {
    const threadId = await create(fixture, 'codex');
    await writeFixtureControl(fixture.root, 'control.json', { sharedMcpLoginId: true });
    const first = await submit(fixture, {
      kind: 'mcp-login',
      threadId,
      serverName: 'first-server',
    });
    await settle(fixture, first.id);
    await writeFixtureControl(fixture.root, 'control.json', {
      sharedMcpLoginId: true,
      loginCompletesEarly: true,
    });
    const second = await submit(fixture, {
      kind: 'mcp-login',
      threadId,
      serverName: 'second-server',
    });
    await expect.poll(async () => (await receipt(fixture, second.id)).completion).toBe('completed');
    expect(await receipt(fixture, first.id)).toMatchObject({
      delivery: 'acknowledged',
      completion: null,
    });
  });
});

test('native plugin reload errors remain visible after a partially applied change', async () => {
  await withClaudeRuntime(async (fixture) => {
    const threadId = await create(fixture, 'claude');
    await fixture.control({ pluginErrors: 1 });
    const result = await submit(fixture, { kind: 'plugins-reload', threadId });
    expect(await settle(fixture, result.id)).toMatchObject({
      delivery: 'acknowledged',
      controlState: 'applied',
      completion: 'failed',
    });
    expect(await fixture.request({ kind: 'managed-thread', threadId })).toMatchObject({
      kind: 'managed-thread',
      result: { state: 'idle' },
    });
  });
});

test('skill reload uses the authorized managed workspace instead of a native response path', async () => {
  await withClaudeRuntime(async (fixture) => {
    const threadId = await create(fixture, 'codex');
    await writeFixtureControl(fixture.root, 'control.json', {
      wrongRoot: join(fixture.root, 'not-allowed'),
    });
    const reloaded = await submit(fixture, { kind: 'skills-reload', threadId });
    expect((await settle(fixture, reloaded.id)).delivery).toBe('acknowledged');
    const calls = (await readFile(join(fixture.root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            method: string;
            params: { forceReload?: boolean; cwds?: string[] };
          },
      );
    expect(
      calls.find((call) => call.method === 'skills/list' && call.params.forceReload)?.params.cwds,
    ).toStrictEqual([fixture.workspaceRoot]);
  });
});

test('Claude server pagination covers empty catalogs, exact boundaries and inventory changes', async () => {
  await withClaudeRuntime(async (fixture) => {
    const threadId = await create(fixture, 'claude');
    const command = { kind: 'mcp-servers' as const, threadId, limit: 2 };
    await fixture.control({ mcpServers: [] });
    expect(await fixture.request(command)).toMatchObject({
      kind: 'mcp-servers',
      result: { state: 'available', data: [], nextCursor: null },
    });
    const servers = ['server-a', 'server-b', 'server-c', 'server-d'].map((name) => ({
      name,
      status: 'connected',
    }));
    await fixture.control({ mcpServers: servers.slice(0, 2).reverse() });
    expect(await fixture.request(command)).toMatchObject({
      kind: 'mcp-servers',
      result: { data: [{ name: 'server-a' }, { name: 'server-b' }], nextCursor: null },
    });
    await fixture.control({ mcpServers: servers.slice(0, 3).reverse() });
    const first = await fixture.request(command);
    if (first.kind !== 'mcp-servers' || !first.result.nextCursor)
      throw new Error('Missing server cursor');
    expect(first.result.data.map((server) => server.name)).toStrictEqual(['server-a', 'server-b']);
    const continuation = { ...command, cursor: first.result.nextCursor };
    expect(await fixture.request(continuation)).toMatchObject({
      kind: 'mcp-servers',
      result: { data: [{ name: 'server-c' }], nextCursor: null },
    });
    await expectToRejectCode(
      fixture.request({ ...continuation, limit: 1 }),
      'JG_AGENT_HQ_CLIENT_INVALID_REQUEST',
    );
    for (const mcpServers of [servers, servers.slice(0, 2)]) {
      await fixture.control({ mcpServers });
      await expectToRejectCode(fixture.request(continuation), 'JG_AGENT_HQ_CLIENT_INVALID_REQUEST');
    }
    await fixture.control({ mcpServers: [servers[0], servers[0]] });
    expect(await fixture.request(command)).toMatchObject({
      kind: 'mcp-servers',
      result: { state: 'unavailable', data: [], nextCursor: null },
    });
  });
});
