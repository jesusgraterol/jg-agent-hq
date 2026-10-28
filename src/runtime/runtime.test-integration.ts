// @vitest-environment node
import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import { expectToRejectCode } from 'jg-exception/testing';
import { hasErrorCode } from 'jg-exception';
import { createAgentHq, requestAgentHq, type IAgentHq } from 'jg-agent-hq';
import { HqResponseSchema, type IHqRequestInput } from 'jg-agent-hq/contracts';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';

import { installCodexFixture, writeFixtureControl } from '../../scripts/test-support/index.js';

const execute = promisify(execFile);
const PidsSchema = z.object({ parent: z.number(), child: z.number() });
const CallsSchema = z.array(z.object({ method: z.string(), params: z.unknown().optional() }));

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) return false;
    throw error;
  }
};

/** Each real runtime is closed before its private fixture and native descendants are removed. */
const withRuntime = async (
  run: (fixture: {
    root: string;
    stateRoot: string;
    workspaceRoot: string;
    runtime: IAgentHq;
    control: (settings: Record<string, unknown>) => Promise<void>;
    request: (command: IHqRequestInput) => ReturnType<typeof requestAgentHq>;
  }) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'jg-hq-runtime-'));
  const workspaceRoot = join(root, 'workspace');
  const stateRoot = join(root, 'state');
  let runtime: IAgentHq | undefined;
  try {
    await mkdir(workspaceRoot);
    const bin = await installCodexFixture(root);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    vi.stubEnv('JG_HQ_FIXTURE_DIRECTORY', root);
    vi.stubEnv('JG_HQ_FIXTURE_WORKSPACE', workspaceRoot);
    runtime = await createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] });
    await run({
      root,
      stateRoot,
      workspaceRoot,
      runtime,
      control: (settings) => writeFixtureControl(root, 'control.json', settings),
      request: (command) => requestAgentHq(stateRoot, command),
    });
  } finally {
    await runtime?.close();
    vi.unstubAllEnvs();
    try {
      const pids = PidsSchema.parse(JSON.parse(await readFile(join(root, 'pids.json'), 'utf8')));
      expect(isAlive(pids.parent)).toBe(false);
      expect(isAlive(pids.child)).toBe(false);
    } catch (cause) {
      if (!hasErrorCode(cause, 'ENOENT')) throw cause;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
};

test('owner-only IPC survives abandoned clients; shutdown releases SQLite and the owned process group', async () => {
  await withRuntime(async ({ stateRoot, workspaceRoot, runtime, request }) => {
    const first = HqResponseSchema.parse(await request({ kind: 'status' }));
    expect(first.kind).toBe('status');
    if (first.kind !== 'status') throw new Error('wrong response');
    expect(first.result.store).toBe('ready');
    expect(first.result.providers).toStrictEqual([
      { provider: 'codex', state: 'idle', version: null },
      { provider: 'claude', state: 'idle', version: null },
    ]);
    const abandoned = connect(join(stateRoot, 'hq.sock'));
    await new Promise<void>((resolve, reject) => {
      abandoned.once('connect', resolve);
      abandoned.once('error', reject);
    });
    abandoned.write('{"incomplete":');
    abandoned.destroy();
    await expect(createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] })).rejects.toThrow(
      'already owned',
    );
    const reply = await request({ kind: 'threads', provider: 'codex', workspaceRoot });
    if (reply.kind !== 'threads') throw new Error('wrong response');
    expect(reply.result.data).toHaveLength(32);
    expect(reply.result.data[0]).toMatchObject({
      nativeId: 'thread-1023',
      ownership: 'external',
      createdAt: 1_700_000_511_000,
    });
    for (const filename of await readdir(stateRoot)) {
      expect((await stat(join(stateRoot, filename))).mode & 0o077).toBe(0);
    }
    await runtime.close();
    await runtime.closed;
    expect(await readdir(stateRoot)).toStrictEqual(['action.key', 'hq.sqlite']);
    const database = new DatabaseSync(join(stateRoot, 'hq.sqlite'), { readOnly: true });
    try {
      const rows = database
        .prepare(
          'SELECT native_id, runtime_epoch, continuation_cursor FROM hq_native_history_index ORDER BY native_id',
        )
        .all();
      expect(rows).toHaveLength(32);
      expect(rows[0]).toMatchObject({
        runtime_epoch: first.result.runtimeEpoch,
        continuation_cursor: reply.result.nextCursor,
      });
      expect(
        database
          .prepare('PRAGMA table_info(hq_native_history_index)')
          .all()
          .map((column) => column.name),
      ).not.toContain('text');
    } finally {
      database.close();
    }
    const restarted = await createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] });
    try {
      const status = await restarted.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('wrong response');
      expect(status.result.runtimeEpoch).not.toBe(first.result.runtimeEpoch);
    } finally {
      await restarted.close();
    }
  });
});

test('native seek pages cover 1024 sessions with stable ties and filter-bound continuation', async () => {
  await withRuntime(async ({ workspaceRoot, request }) => {
    const identities: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await request({
        kind: 'threads',
        provider: 'codex',
        workspaceRoot,
        limit: 128,
        cursor,
      });
      if (page.kind !== 'threads') throw new Error('wrong response');
      expect(page.result.data).toHaveLength(128);
      identities.push(...page.result.data.map((thread) => thread.nativeId));
      if (!cursor) {
        await expectToRejectCode(
          request({
            kind: 'threads',
            provider: 'codex',
            workspaceRoot,
            limit: 128,
            search: 'Task',
            cursor: page.result.nextCursor!,
          }),
          'JG_AGENT_HQ_CLIENT_INVALID_REQUEST',
          'Request is invalid.',
        );
      }
      cursor = page.result.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(identities).size).toBe(1024);
    expect(identities).toStrictEqual(
      Array.from({ length: 1024 }, (_, index) => `thread-${String(1023 - index).padStart(4, '0')}`),
    );
    const empty = await request({
      kind: 'threads',
      provider: 'codex',
      workspaceRoot,
      search: 'No matching task',
    });
    expect(empty).toStrictEqual({
      kind: 'threads',
      result: { data: [], nextCursor: null, source: 'native' },
    });
    await expectToRejectCode(
      request({ kind: 'threads', provider: 'codex', workspaceRoot, limit: 129 }),
      'JG_AGENT_HQ_REQUEST_INVALID',
      'The HQ request is invalid',
    );
    await expectToRejectCode(
      request({ kind: 'threads', provider: 'codex', workspaceRoot, cursor: 'invalid' }),
      'JG_AGENT_HQ_CLIENT_INVALID_REQUEST',
      'Request is invalid.',
    );
  });
});

test('authorized native history is re-read after a delayed flush and large frames are bounded for display', async () => {
  await withRuntime(async ({ root, workspaceRoot, control, request }) => {
    const target = { provider: 'codex' as const, workspaceRoot, nativeId: 'thread-1023' };
    const turns = await request({ kind: 'turns', ...target });
    expect(turns).toMatchObject({
      kind: 'turns',
      result: { data: [{ nativeId: 'turn-a', state: 'completed' }] },
    });
    await control({ awaitingFlush: true });
    expect(await request({ kind: 'items', ...target })).toMatchObject({
      kind: 'items',
      result: { data: [], history: 'persisted' },
    });
    await control({ largeItem: true });
    const flushed = await request({ kind: 'items', ...target });
    if (flushed.kind !== 'items') throw new Error('wrong response');
    expect(flushed.result.data).toStrictEqual([
      {
        nativeId: 'item-a',
        turnId: 'turn-a',
        nativeType: 'agentMessage',
        kind: 'agent-message',
        text: 'a'.repeat(65_536),
        isTruncated: true,
        callId: null,
        outcome: null,
        files: [],
        provenance: {
          origin: 'agent',
          source: 'native-kind',
          nativeInputId: null,
          actionId: null,
          contentBoundary: 'untrusted',
          grantsAuthority: false,
        },
      },
    ]);
    const calls = CallsSchema.parse(
      (await readFile(join(root, 'calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    );
    expect(
      calls.every((call) =>
        [
          'initialize',
          'initialized',
          // each connection reads the daemon's loaded threads for sessions already running
          'thread/loaded/list',
          'thread/read',
          'thread/turns/list',
          'thread/items/list',
        ].includes(call.method),
      ),
    ).toBe(true);
    expect(
      calls
        .filter((call) => call.method === 'thread/read')
        .every((call) => (call.params as { includeTurns: boolean }).includeTurns === false),
    ).toBe(true);
  });
});

test('Codex items read newest first toward older ones, cut their text, and find one item in an old turn of a long thread', async () => {
  await withRuntime(async ({ root, workspaceRoot, control, request }) => {
    const target = {
      kind: 'items',
      provider: 'codex',
      workspaceRoot,
      nativeId: 'thread-1023',
    } as const;
    // an old turn longer than two listing pages, then a newer short one
    await control({
      items: [
        ...Array.from({ length: 300 }, (_, index) => ({
          turnId: 'turn-a',
          item: { id: `a-${index}`, type: 'agentMessage', text: `older ${index}` },
        })),
        ...Array.from({ length: 3 }, (_, index) => ({
          turnId: 'turn-b',
          item: { id: `b-${index}`, type: 'agentMessage', text: `newer ${index}` },
        })),
      ],
    });
    const first = await request({ ...target, limit: 2 });
    if (first.kind !== 'items') throw new Error('wrong response');
    expect(first.result.data.map((item) => item.nativeId)).toStrictEqual(['b-2', 'b-1']);
    const next = await request({ ...target, limit: 2, cursor: first.result.nextCursor! });
    expect(next.kind === 'items' && next.result.data.map((item) => item.nativeId)).toStrictEqual([
      'b-0',
      'a-299',
    ]);
    const cut = await request({ ...target, limit: 1, textLimit: 5 });
    expect(
      cut.kind === 'items' && cut.result.data.map((item) => [item.text, item.isTruncated]),
    ).toStrictEqual([['newer', true]]);
    const oldest = await request({
      ...target,
      nativeItemId: 'a-0',
      turnId: 'turn-a',
      textLimit: 3,
    });
    expect(oldest.kind === 'items' && oldest.result).toMatchObject({
      data: [{ nativeId: 'a-0', turnId: 'turn-a', text: 'old', isTruncated: true }],
      nextCursor: null,
    });
    expect(oldest.kind === 'items' && oldest.result.data).toHaveLength(1);
    // the lookup listed only that turn, newest first and 128 items at a time
    const ListingSchema = z.object({
      turnId: z.string().optional(),
      limit: z.number(),
      sortDirection: z.string(),
    });
    const lookups = CallsSchema.parse(
      (await readFile(join(root, 'calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    )
      .filter((call) => call.method === 'thread/items/list')
      .map((call) => ListingSchema.parse(call.params))
      .filter((params) => params.turnId === 'turn-a');
    expect(lookups).toStrictEqual(
      Array.from({ length: 3 }, () => ({ turnId: 'turn-a', limit: 128, sortDirection: 'desc' })),
    );
    // an unknown item, and one outside the given turn, read as an empty page
    for (const [nativeItemId, turnId] of [
      ['a-missing', 'turn-a'],
      ['b-0', 'turn-a'],
    ] as const) {
      const empty = await request({ ...target, nativeItemId, turnId });
      expect(empty.kind === 'items' && empty.result).toMatchObject({ data: [], nextCursor: null });
    }
  });
});

test('Codex history leaves reasoning out, presents what the CLI shows and counts files past the text cut, as evidence does', async () => {
  await withRuntime(async ({ workspaceRoot, control, request }) => {
    const target = { provider: 'codex', workspaceRoot, nativeId: 'thread-1023' } as const;
    const updated = Array.from({ length: 300 }, (_, index) => `+added line ${index}`);
    const native = [
      {
        id: 'u-0',
        type: 'userMessage',
        clientId: null,
        content: [{ type: 'text', text: 'Fix it' }],
      },
      { id: 'r-0', type: 'reasoning', summary: [], content: ['private'] },
      { id: 'w-0', type: 'webSearch', query: 'zod strictObject', action: null, results: null },
      { id: 'i-0', type: 'imageView', path: '/workspace/screen.png' },
      {
        id: 'c-0',
        type: 'commandExecution',
        command: 'ls',
        aggregatedOutput: 'a.ts',
        status: 'declined',
      },
      {
        id: 'f-0',
        type: 'fileChange',
        status: 'completed',
        changes: [
          {
            path: '/workspace/a.ts',
            kind: { type: 'update', move_path: null },
            diff: ['@@ -1,2 +1,301 @@', ' kept', '-removed', ...updated].join('\n'),
          },
          { path: '/workspace/b.ts', kind: { type: 'add' }, diff: 'one\ntwo\n' },
        ],
      },
      { id: 'cc-0', type: 'contextCompaction' },
      { id: 'r-1', type: 'reasoning', summary: [], content: ['private'] },
    ];
    await control({ items: native.map((item) => ({ turnId: 'turn-a', item })) });
    const page = await request({ kind: 'items', ...target, textLimit: 2048 });
    if (page.kind !== 'items') throw new Error('wrong response');
    expect(
      page.result.data.map(({ nativeId, kind, text, outcome, files }) => ({
        nativeId,
        kind,
        text: text.length > 64 ? text.length : text,
        outcome,
        files,
      })),
    ).toStrictEqual([
      { nativeId: 'cc-0', kind: 'notice', text: '', outcome: null, files: [] },
      {
        nativeId: 'f-0',
        kind: 'file-change',
        text: 2048,
        outcome: 'succeeded',
        files: [
          { path: '/workspace/a.ts', added: 300, removed: 1 },
          { path: '/workspace/b.ts', added: 2, removed: 0 },
        ],
      },
      { nativeId: 'c-0', kind: 'command', text: 'ls\na.ts', outcome: 'failed', files: [] },
      { nativeId: 'i-0', kind: 'tool', text: '/workspace/screen.png', outcome: null, files: [] },
      { nativeId: 'w-0', kind: 'tool', text: 'zod strictObject', outcome: null, files: [] },
      { nativeId: 'u-0', kind: 'user-message', text: 'Fix it', outcome: null, files: [] },
    ]);
    // a native page holding reasoning returns fewer items than its limit, and continues past it
    const short = await request({ kind: 'items', ...target, limit: 2 });
    if (short.kind !== 'items') throw new Error('wrong response');
    expect(short.result.data.map((item) => item.nativeId)).toStrictEqual(['cc-0']);
    expect(short.result.nextCursor).not.toBeNull();
    for (const [kinds, ids] of [
      [['notice'], ['cc-0']],
      [
        ['file-change', 'command'],
        ['f-0', 'c-0'],
      ],
    ] as const) {
      const evidence = await request({ kind: 'session-evidence', ...target, kinds: [...kinds] });
      if (evidence.kind !== 'session-evidence') throw new Error('wrong response');
      expect(evidence.result.data.map((item) => item.reference.itemId)).toStrictEqual(ids);
      expect(evidence.result.data.map((item) => item.kind)).toStrictEqual(
        ids.map((id) => page.result.data.find((item) => item.nativeId === id)!.kind),
      );
    }
  });
});

test('workspace authorization precedes native access and rejects symlink escapes and cross-workspace history', async () => {
  await withRuntime(async ({ root, workspaceRoot, control, request }) => {
    const outside = join(root, 'outside');
    await mkdir(outside);
    const escaped = join(workspaceRoot, 'escape');
    await symlink(outside, escaped);
    await expectToRejectCode(
      request({ kind: 'threads', provider: 'codex', workspaceRoot: escaped }),
      'JG_AGENT_HQ_CLIENT_ACCESS_DENIED',
      'Access is denied.',
    );
    await control({ wrongRoot: outside });
    await expectToRejectCode(
      request({ kind: 'items', provider: 'codex', workspaceRoot, nativeId: 'thread-1023' }),
      'JG_AGENT_HQ_CLIENT_ACCESS_DENIED',
      'Access is denied.',
    );
    await expectToRejectCode(
      request({ kind: 'threads', provider: 'codex', workspaceRoot }),
      'JG_AGENT_HQ_CLIENT_ACCESS_DENIED',
      'Access is denied.',
    );
    const calls = await readFile(join(root, 'calls.jsonl'), 'utf8');
    expect(calls).not.toContain('thread/items/list');
    expect(calls).not.toContain('thread/resume');
  });
});

test.each([
  ['omitted', undefined],
  ['null', null],
  ['empty', {}],
])('the single quota remains available when the bucket map is %s', async (_descriptor, map) => {
  await withRuntime(async ({ control, request }) => {
    await control({
      nativeUsage: {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 25, windowDurationMins: 10080, resetsAt: 2_000_000_000 },
        },
        ...(map === undefined ? {} : { rateLimitsByLimitId: map }),
        ordinaryUsageAllowed: true,
      },
    });
    expect(await request({ kind: 'usage', provider: 'codex' })).toMatchObject({
      kind: 'usage',
      result: {
        state: 'available',
        windows: [
          {
            id: 'codex:primary',
            usedPercent: 25,
            durationMinutes: 10080,
            resetsAt: 2_000_000_000_000,
          },
        ],
      },
    });
  });
});

test('quota map selection retains exact per-bucket credits, periods and reset availability', async () => {
  await withRuntime(async ({ control, request }) => {
    const nativeUsage = {
      rateLimits: { limitId: 'ignored', primary: { usedPercent: 99 } },
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 25, windowDurationMins: 300 },
          secondary: { usedPercent: 60, windowDurationMins: 10080 },
          credits: { hasCredits: true, unlimited: false, balance: '0.29000000000000001' },
        },
        model: {
          primary: { usedPercent: 8, windowDurationMins: 60 },
          credits: { hasCredits: true, unlimited: true, balance: null },
        },
      },
      rateLimitResetCredits: { availableCount: 7, credits: [] },
    };
    await control({ nativeUsage });
    const observed = await request({ kind: 'usage', provider: 'codex' });
    if (observed.kind !== 'usage') throw new Error('wrong response');
    expect(observed.result.state).toBe('available');
    expect(
      observed.result.windows.map(({ id, period, durationMinutes }) => ({
        id,
        period,
        durationMinutes,
      })),
    ).toStrictEqual([
      { id: 'codex:primary', period: 'five-hour', durationMinutes: 300 },
      { id: 'codex:secondary', period: 'seven-day', durationMinutes: 10080 },
      { id: 'model:primary', period: 'other', durationMinutes: 60 },
    ]);
    expect(observed.result.credits).toStrictEqual([
      {
        bucket: 'codex',
        hasCredits: true,
        isUnlimited: false,
        balance: '0.29000000000000001',
      },
      { bucket: 'model', hasCredits: true, isUnlimited: true, balance: null },
    ]);
    expect(observed.result.resetCredits).toStrictEqual({ availableCount: 7 });
    await control({ quotaFailure: true });
    expect(await request({ kind: 'usage', provider: 'codex' })).toStrictEqual({
      kind: 'usage',
      result: { ...observed.result, state: 'stale' },
    });
    await control({
      nativeUsage: {
        ...nativeUsage,
        rateLimitsByLimitId: { malformed: { primary: { usedPercent: 'invalid' } } },
      },
    });
    expect(await request({ kind: 'usage', provider: 'codex' })).toStrictEqual({
      kind: 'usage',
      result: { ...observed.result, state: 'stale' },
    });
    await control({ nativeUsage, accountChangedDuringRead: true });
    expect(await request({ kind: 'usage', provider: 'codex' })).toMatchObject({
      kind: 'usage',
      result: {
        state: 'unavailable',
        observedAt: null,
        windows: [],
        credits: null,
        resetCredits: null,
      },
    });
  });
});

test.each([
  ['missing', undefined, undefined],
  ['null', null, null],
  ['incomplete', {}, {}],
  ['invalid types', { hasCredits: true, unlimited: 'yes', balance: '1' }, { availableCount: -1 }],
  [
    'unsafe count',
    { hasCredits: true, unlimited: false, balance: 1 },
    { availableCount: Number.MAX_SAFE_INTEGER + 1 },
  ],
  [
    'overlong balance',
    { hasCredits: true, unlimited: false, balance: '1'.repeat(257) },
    { availableCount: 0.5 },
  ],
])(
  'optional quota metadata %s does not erase measured windows',
  async (_descriptor, credits, resets) => {
    await withRuntime(async ({ control, request }) => {
      await control({
        nativeUsage: {
          rateLimits: { primary: { usedPercent: 25 }, credits },
          rateLimitResetCredits: resets,
        },
      });
      expect(await request({ kind: 'usage', provider: 'codex' })).toMatchObject({
        kind: 'usage',
        result: {
          state: 'available',
          windows: [{ id: 'single:primary', period: 'other', durationMinutes: null }],
          credits: null,
          resetCredits: null,
        },
      });
    });
  },
);

test.each([
  { hasCredits: false, unlimited: false, balance: '0' },
  { hasCredits: true, unlimited: true, balance: null },
])('credits without quota windows remain observable (%o)', async (credits) => {
  await withRuntime(async ({ control, request }) => {
    await control({
      nativeUsage: {
        rateLimits: { credits },
        rateLimitResetCredits: { availableCount: 0, credits: null },
      },
    });
    expect(await request({ kind: 'usage', provider: 'codex' })).toMatchObject({
      kind: 'usage',
      result: {
        state: 'unavailable',
        observedAt: expect.any(Number),
        windows: [],
        credits: [
          {
            bucket: 'single',
            hasCredits: credits.hasCredits,
            isUnlimited: credits.unlimited,
            balance: credits.balance,
          },
        ],
        resetCredits: { availableCount: 0 },
      },
    });
  });
});

test('an overlong optional credit bucket does not discard its single quota identity', async () => {
  await withRuntime(async ({ control, request }) => {
    const bucket = 'x'.repeat(257);
    await control({
      nativeUsage: {
        rateLimitsByLimitId: {
          [bucket]: {
            primary: { usedPercent: 25 },
            credits: { hasCredits: true, unlimited: false, balance: '1' },
          },
        },
      },
    });
    expect(await request({ kind: 'usage', provider: 'codex' })).toMatchObject({
      kind: 'usage',
      result: { state: 'available', windows: [{ bucket }], credits: null },
    });
  });
});

test('quota uses actual windows; failed refresh retains stale measurements and missing windows stay unavailable', async () => {
  await withRuntime(async ({ control, request }) => {
    const usage = await request({ kind: 'usage', provider: 'codex' });
    if (usage.kind !== 'usage') throw new Error('wrong response');
    expect(usage.result.state).toBe('available');
    expect(usage.result.windows[0]).toMatchObject({
      id: 'codex:primary',
      usedPercent: 25,
      remainingPercent: 75,
      durationMinutes: 300,
    });
    expect(usage.result.windows[0].resetsAt).toBeGreaterThan(Date.now());
    await control({ quotaFailure: true });
    const stale = await request({ kind: 'usage', provider: 'codex' });
    expect(stale).toStrictEqual({ kind: 'usage', result: { ...usage.result, state: 'stale' } });
    await control({ noWindows: true });
    expect(await request({ kind: 'usage', provider: 'codex' })).toMatchObject({
      kind: 'usage',
      result: { state: 'unavailable', windows: [] },
    });
    await control({ usedPercent: 105 });
    expect(await request({ kind: 'usage', provider: 'codex' })).toMatchObject({
      kind: 'usage',
      result: { windows: [{ usedPercent: 105, remainingPercent: 0 }] },
    });
    await control({ exhausted: true });
    expect(await request({ kind: 'usage', provider: 'codex' })).toMatchObject({
      kind: 'usage',
      result: { state: 'exhausted', ordinaryUsageAllowed: false },
    });
    await control({ expired: true });
    expect(await request({ kind: 'usage', provider: 'codex' })).toMatchObject({
      kind: 'usage',
      result: { state: 'stale' },
    });
  });
});

test('native quota events coalesce refreshes and an account change discards the prior account measurement', async () => {
  await withRuntime(async ({ root, workspaceRoot, control, request }) => {
    await request({ kind: 'usage', provider: 'codex' });
    await control({
      notifyUsage: true,
      usedPercent: 75,
      credits: { hasCredits: true, unlimited: false, balance: '1.25000000000000001' },
      resetCredits: { availableCount: 2 },
    });
    await request({ kind: 'threads', provider: 'codex', workspaceRoot, limit: 1 });
    const deadline = Date.now() + 2000;
    let count = 0;
    do {
      const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      count = CallsSchema.parse(calls).filter(
        (call) => call.method === 'account/rateLimits/read',
      ).length;
      if (count >= 2) break;
      await wait(10);
    } while (Date.now() < deadline);
    expect(count).toBe(2);
    expect(await request({ kind: 'usage', provider: 'codex' })).toMatchObject({
      kind: 'usage',
      result: {
        windows: [{ usedPercent: 75 }],
        credits: [
          {
            bucket: 'codex',
            hasCredits: true,
            isUnlimited: false,
            balance: '1.25000000000000001',
          },
        ],
        resetCredits: { availableCount: 2 },
      },
    });
    await control({ accountChanged: true, quotaFailure: true });
    await request({ kind: 'threads', provider: 'codex', workspaceRoot, limit: 1 });
    expect(await request({ kind: 'usage', provider: 'codex' })).toStrictEqual({
      kind: 'usage',
      result: {
        provider: 'codex',
        state: 'unavailable',
        source: 'native',
        observedAt: null,
        ordinaryUsageAllowed: null,
        windows: [],
        credits: null,
        resetCredits: null,
      },
    });
  });
});

test('malformed native items and cursors return a safe integration failure without poisoning the runtime', async () => {
  await withRuntime(async ({ workspaceRoot, control, request, runtime }) => {
    const target = { provider: 'codex' as const, workspaceRoot, nativeId: 'thread-1023' };
    await control({
      items: [
        {
          turnId: 'turn-a',
          item: { id: 'item-a', type: 'userMessage', content: [{ type: 'text' }] },
        },
      ],
    });
    await expectToRejectCode(
      request({ kind: 'items', ...target }),
      'JG_AGENT_HQ_CLIENT_AGENT_UNAVAILABLE',
      'Coding agent is unavailable.',
    );
    await control({ invalidCursor: true });
    await expectToRejectCode(
      request({ kind: 'threads', provider: 'codex', workspaceRoot }),
      'JG_AGENT_HQ_CLIENT_AGENT_UNAVAILABLE',
      'Coding agent is unavailable.',
    );
    await control({
      items: [
        {
          turnId: 'turn-a',
          item: {
            id: 'item-a',
            type: 'futureNativeType',
            privatePayload: 'must not cross the adapter',
          },
        },
      ],
    });
    expect(await runtime.request({ kind: 'items', ...target })).toMatchObject({
      kind: 'items',
      result: {
        data: [
          { kind: 'unsupported', nativeType: 'futureNativeType', text: '', isTruncated: false },
        ],
      },
    });
    expect(await request({ kind: 'status' })).toMatchObject({
      kind: 'status',
      result: {
        providers: expect.arrayContaining([
          { provider: 'codex', state: 'ready', version: 'codex-cli/fixture' },
        ]),
      },
    });
  });
});

test('a quota response from before an account change cannot restore that account measurement', async () => {
  await withRuntime(async ({ control, request }) => {
    await control({ accountChangedDuringRead: true, usedPercent: 25 });
    expect(await request({ kind: 'usage', provider: 'codex' })).toMatchObject({
      kind: 'usage',
      result: { state: 'unavailable', observedAt: null, windows: [] },
    });
    await control({ usedPercent: 75 });
    expect(await request({ kind: 'usage', provider: 'codex' })).toMatchObject({
      kind: 'usage',
      result: { state: 'available', windows: [{ usedPercent: 75 }] },
    });
  });
});

test.each(['malformed', 'oversized', 'partial', 'empty'])(
  'a %s native frame fails lazy initialization while the host remains usable and cleanup is confirmed',
  { timeout: 15_000 },
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'jg-hq-bad-frame-'));
    const stateRoot = join(root, 'state');
    let runtime: IAgentHq | undefined;
    try {
      const bin = await installCodexFixture(root);
      await writeFile(join(root, 'control.json'), JSON.stringify({ mode }));
      vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
      vi.stubEnv('JG_HQ_FIXTURE_DIRECTORY', root);
      vi.stubEnv('JG_HQ_FIXTURE_WORKSPACE', root);
      runtime = await createAgentHq({ stateRoot, allowedRoots: [root] });
      await expect(
        runtime.request({ kind: 'threads', provider: 'codex', workspaceRoot: root }),
      ).rejects.toThrow(/The (HQ transport|Codex integration) failed/);
      const pids = PidsSchema.parse(JSON.parse(await readFile(join(root, 'pids.json'), 'utf8')));
      expect(isAlive(pids.parent)).toBe(false);
      expect(isAlive(pids.child)).toBe(false);
      expect(await runtime.request({ kind: 'status' })).toMatchObject({
        kind: 'status',
        result: { store: 'ready' },
      });
      await runtime.close();
      expect(await readdir(stateRoot)).toStrictEqual(['action.key', 'hq.sqlite']);
    } finally {
      await runtime?.close();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('unverifiable owners and linked database files are never reclaimed or followed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jg-hq-state-'));
  const stateRoot = join(root, 'state');
  try {
    await mkdir(stateRoot, { mode: 0o700 });
    await writeFile(join(stateRoot, 'hq-owner.json'), 'partial', { mode: 0o600 });
    await expect(createAgentHq({ stateRoot, allowedRoots: [root] })).rejects.toThrow(
      'unverifiable',
    );
    expect(await readFile(join(stateRoot, 'hq-owner.json'), 'utf8')).toBe('partial');
    await rm(join(stateRoot, 'hq-owner.json'));
    const external = join(root, 'external.sqlite');
    await writeFile(external, 'untouched');
    await symlink(external, join(stateRoot, 'hq.sqlite'));
    await expect(createAgentHq({ stateRoot, allowedRoots: [root] })).rejects.toThrow(
      'state file is unsafe',
    );
    expect(await readFile(external, 'utf8')).toBe('untouched');
    expect(await readdir(stateRoot)).toStrictEqual(['hq.sqlite']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a corrupt SQLite file fails worker startup without deleting stored content or retaining a live owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jg-hq-database-'));
  const stateRoot = join(root, 'state');
  try {
    await mkdir(stateRoot, { mode: 0o700 });
    await writeFile(join(stateRoot, 'action.key'), Buffer.alloc(32, 1), { mode: 0o600 });
    await writeFile(join(stateRoot, 'hq.sqlite'), 'corrupt SQLite content', { mode: 0o600 });
    await expectToRejectCode(
      createAgentHq({ stateRoot, allowedRoots: [root] }),
      'JG_AGENT_HQ_STORAGE_INVALID',
      'The HQ storage is invalid',
    );
    expect(await readdir(stateRoot)).toStrictEqual(['action.key', 'hq.sqlite']);
    expect(await readFile(join(stateRoot, 'hq.sqlite'), 'utf8')).toBe('corrupt SQLite content');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(['missing', 'truncated', 'oversized', 'linked'])(
  'an existing store with a %s action key cannot silently replace its receipt identity',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'jg-hq-action-key-'));
    const stateRoot = join(root, 'state');
    try {
      await mkdir(stateRoot, { mode: 0o700 });
      await writeFile(join(stateRoot, 'hq.sqlite'), 'preserved database bytes', { mode: 0o600 });
      if (mode === 'linked') {
        const keyPath = join(root, 'external.key');
        await writeFile(keyPath, Buffer.alloc(32, 1), { mode: 0o600 });
        await symlink(keyPath, join(stateRoot, 'action.key'));
      } else if (mode !== 'missing')
        await writeFile(
          join(stateRoot, 'action.key'),
          Buffer.alloc(mode === 'truncated' ? 16 : 64, 1),
          { mode: 0o600 },
        );
      await expectToRejectCode(
        createAgentHq({ stateRoot, allowedRoots: [root] }),
        'JG_AGENT_HQ_ACTION_KEY_UNAVAILABLE',
        'The HQ action key is unavailable',
      );
      expect(await readFile(join(stateRoot, 'hq.sqlite'), 'utf8')).toBe('preserved database bytes');
      expect(await readdir(stateRoot)).not.toContain('hq-owner.json');
      if (mode === 'missing') expect(await readdir(stateRoot)).not.toContain('action.key');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('lost native output makes the provider unavailable while the independent host and store remain usable', async () => {
  await withRuntime(async ({ workspaceRoot, control, request }) => {
    await control({ mode: 'exit-on-list' });
    await expectToRejectCode(
      request({ kind: 'threads', provider: 'codex', workspaceRoot }),
      'JG_AGENT_HQ_CLIENT_AGENT_UNAVAILABLE',
      'Coding agent is unavailable.',
    );
    expect(await request({ kind: 'status' })).toMatchObject({
      kind: 'status',
      result: {
        store: 'ready',
        providers: expect.arrayContaining([
          { provider: 'codex', state: 'unavailable', version: 'codex-cli/fixture' },
        ]),
      },
    });
  });
});

test('Codex connects through the shared daemon proxy, and a failed daemon start never connects', async () => {
  const readCommands = async (root: string): Promise<unknown[]> =>
    (await readFile(join(root, 'commands.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  await withRuntime(async ({ root, workspaceRoot, control, request }) => {
    await control({ ping: true, fragmentFrames: true });
    const reply = await request({ kind: 'threads', provider: 'codex', workspaceRoot });
    if (reply.kind !== 'threads') throw new Error('wrong response');
    expect(reply.result.data[0]).toMatchObject({ nativeId: 'thread-1023' });
    expect(await readCommands(root)).toStrictEqual([
      ['app-server', 'daemon', 'start'],
      ['app-server', 'proxy'],
    ]);
    expect(await readFile(join(root, 'pongs.jsonl'), 'utf8')).toBe('keepalive\n');
  });
  await withRuntime(async ({ workspaceRoot, control, request }) => {
    await control({ wrongAccept: true });
    await expectToRejectCode(
      request({ kind: 'threads', provider: 'codex', workspaceRoot }),
      'JG_AGENT_HQ_CLIENT_AGENT_UNAVAILABLE',
      'Coding agent is unavailable.',
    );
  });
  await withRuntime(async ({ root, workspaceRoot, control, request }) => {
    await control({ daemonFailure: true });
    await expectToRejectCode(
      request({ kind: 'threads', provider: 'codex', workspaceRoot }),
      'JG_AGENT_HQ_CLIENT_AGENT_UNAVAILABLE',
      'Coding agent is unavailable.',
    );
    const commands = await readCommands(root);
    expect(commands).toContainEqual(['app-server', 'daemon', 'start']);
    expect(commands).not.toContainEqual(['app-server', 'proxy']);
  });
});

test(
  'a daemon that stops answering keepalive pings makes Codex unavailable and its sessions uncertain',
  // the keepalive interval is fixed at 10 seconds, so detection takes up to two intervals
  { timeout: 45_000 },
  async () => {
    await withRuntime(async ({ workspaceRoot, control, request }) => {
      const status = HqResponseSchema.parse(await request({ kind: 'status' }));
      if (status.kind !== 'status') throw new Error('wrong response');
      const actionId = randomUUID();
      await request({
        kind: 'action',
        action: {
          id: actionId,
          runtimeEpoch: status.result.runtimeEpoch,
          command: { kind: 'thread-create', provider: 'codex', workspaceRoot, name: 'keepalive' },
        },
      });
      await expect
        .poll(async () => {
          const receipt = await request({ kind: 'receipt', actionId });
          return receipt.kind === 'receipt' ? receipt.result?.delivery : null;
        })
        .toBe('acknowledged');
      const receipt = await request({ kind: 'receipt', actionId });
      if (receipt.kind !== 'receipt' || !receipt.result?.threadId) throw new Error('no thread');
      const threadId = receipt.result.threadId;
      await control({ ignorePings: true });
      await expect
        .poll(
          async () => {
            const current = await request({ kind: 'status' });
            return current.kind === 'status'
              ? current.result.providers.find((provider) => provider.provider === 'codex')?.state
              : null;
          },
          { timeout: 30_000, interval: 250 },
        )
        .toBe('unavailable');
      expect(await request({ kind: 'managed-thread', threadId })).toMatchObject({
        kind: 'managed-thread',
        result: { ownership: 'uncertain' },
      });
    });
  },
);

test(
  'unconfirmed native startup cleanup preserves runtime ownership evidence',
  { timeout: 15_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'jg-hq-cleanup-'));
    const stateRoot = join(root, 'state');
    const realKill = process.kill.bind(process);
    let runtime: IAgentHq | undefined;
    try {
      const bin = await installCodexFixture(root);
      await writeFile(join(root, 'control.json'), JSON.stringify({ mode: 'malformed' }));
      vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
      vi.stubEnv('JG_HQ_FIXTURE_DIRECTORY', root);
      vi.stubEnv('JG_HQ_FIXTURE_WORKSPACE', root);
      runtime = await createAgentHq({ stateRoot, allowedRoots: [root] });
      // only the OS termination-observation boundary is uncertain; actual signals still run
      const probe = vi
        .spyOn(process, 'kill')
        .mockImplementation((pid, signal) =>
          pid < 0 && signal === 0 ? true : realKill(pid, signal),
        );
      try {
        await expectToRejectCode(
          runtime.request({ kind: 'threads', provider: 'codex', workspaceRoot: root }),
          'JG_AGENT_HQ_CODEX_FAILED',
          'The Codex integration failed',
        );
        await expectToRejectCode(runtime.close(), 'JG_AGENT_HQ_TRANSPORT_FAILED');
        expect(JSON.parse(await readFile(join(stateRoot, 'hq-owner.json'), 'utf8'))).toMatchObject({
          command: 'serve',
          pid: process.pid,
        });
      } finally {
        probe.mockRestore();
      }
      const pids = PidsSchema.parse(JSON.parse(await readFile(join(root, 'pids.json'), 'utf8')));
      expect(isAlive(pids.parent)).toBe(false);
      expect(isAlive(pids.child)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'the installed CLI serves, browses, and confirms an actual shutdown',
  { timeout: 20_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'jg-hq-cli-'));
    const stateRoot = join(root, 'state');
    const cli = new URL('../../dist/cli/cli.js', import.meta.url).pathname;
    let host: ReturnType<typeof execFile> | undefined;
    let hostClosed: Promise<void> | undefined;
    try {
      const bin = await installCodexFixture(root);
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        JG_HQ_FIXTURE_DIRECTORY: root,
        JG_HQ_FIXTURE_WORKSPACE: root,
      };
      host = execFile(
        process.execPath,
        [cli, 'serve', '--state-root', stateRoot, '--workspace-root', root],
        { env },
      );
      hostClosed = new Promise<void>((resolve, reject) =>
        host!.once('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`CLI exited ${code}`)),
        ),
      );
      void hostClosed.catch(() => undefined);
      let output = '';
      await new Promise<void>((resolve, reject) => {
        host!.once('error', reject);
        host!.stdout!.on('data', (chunk: Buffer) => {
          output += chunk;
          if (output.includes('\n')) resolve();
        });
        host!.once('close', () => reject(new Error('CLI stopped before readiness')));
      });
      const listing = await execute(
        process.execPath,
        [cli, 'threads', '--state-root', stateRoot, '--workspace-root', root, '--limit', '2'],
        { env },
      );
      expect(HqResponseSchema.parse(JSON.parse(listing.stdout))).toMatchObject({
        kind: 'threads',
        result: { data: [{ nativeId: 'thread-1023' }, { nativeId: 'thread-1022' }] },
      });
      const stopped = await execute(process.execPath, [cli, 'stop', '--state-root', stateRoot], {
        env,
      });
      expect(JSON.parse(stopped.stdout)).toMatchObject({
        kind: 'stop',
        result: { state: 'stopped' },
      });
      await hostClosed;
      expect(await readdir(stateRoot)).toStrictEqual(['action.key', 'hq.sqlite']);
    } finally {
      if (host?.exitCode === null) {
        host.kill('SIGTERM');
        await hostClosed?.catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'a crashed host retains ownership evidence and requires explicit recovery before queued work can continue',
  { timeout: 20_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'jg-hq-crash-'));
    const stateRoot = join(root, 'state');
    let host: ReturnType<typeof execFile> | undefined;
    let hostClosed: Promise<void> | undefined;
    let recovered: IAgentHq | undefined;
    const until = async <T>(read: () => Promise<T>, ready: (result: T) => boolean): Promise<T> => {
      const deadline = Date.now() + 3000;
      let result = await read();
      while (!ready(result) && Date.now() < deadline) {
        await wait(10);
        result = await read();
      }
      expect(ready(result)).toBe(true);
      return result;
    };
    try {
      const bin = await installCodexFixture(root);
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        JG_HQ_FIXTURE_DIRECTORY: root,
        JG_HQ_FIXTURE_WORKSPACE: root,
      };
      host = execFile(
        process.execPath,
        [
          new URL('../../dist/cli/cli.js', import.meta.url).pathname,
          'serve',
          '--state-root',
          stateRoot,
          '--workspace-root',
          root,
        ],
        { env },
      );
      hostClosed = new Promise<void>((resolve) => host!.once('close', () => resolve()));
      await new Promise<void>((resolve, reject) => {
        let output = '';
        host!.once('error', reject);
        host!.once('close', () => reject(new Error('host exited before readiness')));
        host!.stdout!.on('data', (chunk: Buffer) => {
          output += chunk;
          if (output.includes('\n')) resolve();
        });
      });
      const status = await requestAgentHq(stateRoot, { kind: 'status' });
      if (status.kind !== 'status') throw new Error('wrong response');
      const epoch = status.result.runtimeEpoch;
      const created = await requestAgentHq(stateRoot, {
        kind: 'action',
        action: {
          id: randomUUID(),
          runtimeEpoch: epoch,
          command: {
            kind: 'thread-create',
            provider: 'codex',
            workspaceRoot: root,
            name: 'recover-work',
          },
        },
      });
      if (created.kind !== 'action') throw new Error('wrong response');
      const threadId = created.result.threadId!;
      await until(
        () => requestAgentHq(stateRoot, { kind: 'managed-thread', threadId }),
        (response) => response.kind === 'managed-thread' && response.result?.state === 'idle',
      );
      await writeFixtureControl(root, 'control.json', { holdTurn: true });
      const actionId = randomUUID();
      await requestAgentHq(stateRoot, {
        kind: 'action',
        action: {
          id: actionId,
          runtimeEpoch: epoch,
          command: {
            kind: 'message',
            threadId,
            input: { kind: 'text', text: 'Work interrupted by the host crash' },
          },
        },
      });
      const active = await until(
        () => requestAgentHq(stateRoot, { kind: 'managed-thread', threadId }),
        (response) => response.kind === 'managed-thread' && response.result?.state === 'running',
      );
      if (active.kind !== 'managed-thread') throw new Error('wrong response');
      const queuedId = randomUUID();
      await requestAgentHq(stateRoot, {
        kind: 'action',
        action: {
          id: queuedId,
          runtimeEpoch: epoch,
          command: {
            kind: 'queue',
            threadId,
            expectedTurnId: active.result!.activeTurnId!,
            input: { kind: 'text', text: 'Only continue after explicit recovery' },
          },
        },
      });
      const oldOwner = await readFile(join(stateRoot, 'hq-owner.json'), 'utf8');
      host.kill('SIGKILL');
      await hostClosed;
      const pids = PidsSchema.parse(JSON.parse(await readFile(join(root, 'pids.json'), 'utf8')));
      await until(async () => !isAlive(pids.parent) && !isAlive(pids.child), Boolean);
      await expect(createAgentHq({ stateRoot, allowedRoots: [root] })).rejects.toThrow(
        'already owned',
      );
      expect(await readFile(join(stateRoot, 'hq-owner.json'), 'utf8')).toBe(oldOwner);
      expect(JSON.parse(oldOwner)).toMatchObject({ nonce: epoch, pid: host.pid });
      // Explicit operator recovery in this disposable fixture follows proof that the exact owner and children stopped.
      expect((await lstat(join(stateRoot, 'hq.sock'))).isSocket()).toBe(true);
      await rm(join(stateRoot, 'hq.sock'));
      await rm(join(stateRoot, 'hq-owner.json'));
      vi.stubEnv('PATH', env.PATH);
      vi.stubEnv('JG_HQ_FIXTURE_DIRECTORY', root);
      vi.stubEnv('JG_HQ_FIXTURE_WORKSPACE', root);
      recovered = await createAgentHq({ stateRoot, allowedRoots: [root] });
      expect(await recovered.request({ kind: 'managed-thread', threadId })).toMatchObject({
        result: { id: threadId, name: 'recover-work', ownership: 'uncertain', state: 'unknown' },
      });
      expect(await recovered.request({ kind: 'receipt', actionId: queuedId })).toMatchObject({
        result: { delivery: 'queued' },
      });
      const newStatus = await recovered.request({ kind: 'status' });
      if (newStatus.kind !== 'status') throw new Error('wrong response');
      const recoveryId = randomUUID();
      await recovered.request({
        kind: 'action',
        action: {
          id: recoveryId,
          runtimeEpoch: newStatus.result.runtimeEpoch,
          command: {
            kind: 'thread-recover',
            threadId,
            recovery: { kind: 'resume' },
            operatorConfirmation: 'The exact crashed owner and native children have stopped',
          },
        },
      });
      await until(
        () => recovered!.request({ kind: 'managed-thread', threadId }),
        (response) => response.kind === 'managed-thread' && response.result?.state === 'idle',
      );
      expect(await recovered.request({ kind: 'receipt', actionId: queuedId })).toMatchObject({
        result: { delivery: 'queued' },
      });
      const calls = await readFile(join(root, 'calls.jsonl'), 'utf8');
      expect(
        calls.split('\n').filter((line) => line.includes('"method":"turn/start"')),
      ).toHaveLength(1);
    } finally {
      try {
        if (host?.exitCode === null && host.signalCode === null) {
          host.kill('SIGTERM');
          await hostClosed;
        }
        await recovered?.close();
        await rm(root, { recursive: true, force: true });
      } finally {
        vi.unstubAllEnvs();
      }
    }
  },
);
