// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAgentHq } from 'jg-agent-hq';
import { HqResponseSchema } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';

import { claudeRecord, withClaudeRuntime } from '../../../../scripts/test-support/index.js';

test('native API diagnostics stay out of compacted conversation history and preserve resume eligibility', async () => {
  await withClaudeRuntime(async ({ workspaceRoot, transcript, request, runtime }) => {
    const nativeId = randomUUID();
    const first = claudeRecord(workspaceRoot, nativeId, { text: 'Before compaction' });
    const boundary = {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: randomUUID(),
      parentUuid: null,
      logicalParentUuid: first.uuid,
      sessionId: nativeId,
      cwd: workspaceRoot,
      timestamp: '2026-10-22T00:00:00.000Z',
      isMeta: true,
    };
    const summary = {
      ...claudeRecord(workspaceRoot, nativeId, {
        parentUuid: boundary.uuid,
        text: 'Native compacted summary',
      }),
      isCompactSummary: true,
    };
    const answer = claudeRecord(workspaceRoot, nativeId, {
      type: 'assistant',
      parentUuid: summary.uuid,
      text: 'After compaction',
    });
    await writeFile(
      transcript(nativeId),
      [
        first,
        {
          type: 'api-request-blob',
          sessionId: nativeId,
          hash: 'native-diagnostic',
          message: { role: 'user', content: 'PRIVATE API DIAGNOSTIC' },
        },
        boundary,
        summary,
        answer,
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
    );
    const items = await request({ kind: 'items', provider: 'claude', workspaceRoot, nativeId });
    expect(items).toMatchObject({
      kind: 'items',
      result: {
        data: [
          { nativeId: answer.uuid, text: 'After compaction' },
          { nativeId: summary.uuid, text: 'Native compacted summary' },
        ],
      },
    });
    expect(JSON.stringify(items)).not.toContain('PRIVATE API DIAGNOSTIC');
    const status = await runtime.request({ kind: 'status' });
    if (status.kind !== 'status') throw new Error('Missing status');
    const id = randomUUID();
    await request({
      kind: 'action',
      action: {
        id,
        runtimeEpoch: status.result.runtimeEpoch,
        command: {
          kind: 'thread-adopt',
          provider: 'claude',
          nativeId,
          workspaceRoot,
          name: 'compacted-session',
          operatorConfirmation: 'Other controllers are closed.',
        },
      },
    });
    await expect
      .poll(() => request({ kind: 'receipt', actionId: id }))
      .toMatchObject({ kind: 'receipt', result: { delivery: 'acknowledged' } });
  });
});

test('empty discovery and byte-limited indexing/pages return honest boundaries', async () => {
  await withClaudeRuntime(async ({ workspaceRoot, transcript, request }) => {
    const empty = await request({ kind: 'threads', provider: 'claude', workspaceRoot });
    expect(empty.kind === 'threads' && empty.result).toStrictEqual({
      data: [],
      nextCursor: null,
      source: 'native',
    });
    const nativeId = randomUUID();
    let parentUuid: string | null = null;
    const records = [];
    for (let index = 0; index < 6; index += 1) {
      const record = claudeRecord(workspaceRoot, nativeId, {
        parentUuid,
        text: 'a'.repeat(900_000),
      });
      records.push(record);
      parentUuid = record.uuid;
    }
    await writeFile(
      transcript(nativeId),
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
    const first = await request({
      kind: 'items',
      provider: 'claude',
      workspaceRoot,
      nativeId,
      limit: 128,
    });
    if (first.kind !== 'items') throw new Error('wrong response');
    // the page byte budget holds four of the six newest records
    expect(first.result.data.map((item) => item.nativeId)).toStrictEqual(
      records
        .slice(2)
        .reverse()
        .map((record) => record.uuid),
    );
    const last = await request({
      kind: 'items',
      provider: 'claude',
      workspaceRoot,
      nativeId,
      limit: 128,
      cursor: first.result.nextCursor!,
    });
    expect(last.kind === 'items' && last.result.data.map((item) => item.nativeId)).toStrictEqual(
      records
        .slice(0, 2)
        .reverse()
        .map((record) => record.uuid),
    );
    expect(last.kind === 'items' && last.result.nextCursor).toBeNull();
  });
});

test.each(['session', 'workspace'])(
  'native API metadata with a foreign %s cannot bypass history boundaries',
  async (scenario) => {
    await withClaudeRuntime(async ({ workspaceRoot, root, transcript, request }) => {
      const nativeId = randomUUID();
      const first = claudeRecord(workspaceRoot, nativeId);
      const metadata = {
        type: 'api-request-blob',
        sessionId: scenario === 'session' ? randomUUID() : nativeId,
        cwd: scenario === 'workspace' ? join(root, 'foreign') : workspaceRoot,
        message: { role: 'user', content: 'Diagnostic' },
      };
      await writeFile(
        transcript(nativeId),
        [first, metadata].map((row) => JSON.stringify(row)).join('\n') + '\n',
      );
      await expect(
        request({ kind: 'items', provider: 'claude', workspaceRoot, nativeId }),
      ).rejects.toThrow('Coding agent is unavailable');
    });
  },
);

test('native files are paged by chain position with truthful unknown execution states and searchable native titles', async () => {
  await withClaudeRuntime(async ({ workspaceRoot, transcript, request }) => {
    const nativeId = randomUUID();
    const first = claudeRecord(workspaceRoot, nativeId, { text: 'first question' });
    const answer = claudeRecord(workspaceRoot, nativeId, {
      type: 'assistant',
      parentUuid: first.uuid,
      text: 'first answer',
    });
    const second = claudeRecord(workspaceRoot, nativeId, {
      parentUuid: answer.uuid,
      text: 'second question',
    });
    const last = claudeRecord(workspaceRoot, nativeId, {
      type: 'assistant',
      parentUuid: second.uuid,
      text: 'second answer',
    });
    await writeFile(
      transcript(nativeId),
      [
        ...[first, answer, second, last],
        { type: 'custom-title', sessionId: nativeId, customTitle: 'Review cache' },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const threads = await request({
      kind: 'threads',
      provider: 'claude',
      workspaceRoot,
      search: 'cache',
    });
    expect(
      threads.kind === 'threads' &&
        threads.result.data.map((thread) => [
          thread.nativeId,
          thread.name,
          thread.nativeState,
          thread.historyState,
        ]),
    ).toStrictEqual([[nativeId, 'Review cache', 'unknown', 'available']]);
    const initial = await request({
      kind: 'items',
      provider: 'claude',
      workspaceRoot,
      nativeId,
      limit: 2,
    });
    if (initial.kind !== 'items') throw new Error('wrong response');
    expect(initial.result.data.map((item) => item.text)).toStrictEqual([
      'second answer',
      'second question',
    ]);
    expect(initial.result.nextCursor).not.toBeNull();
    const final = HqResponseSchema.parse(
      await request({
        kind: 'items',
        provider: 'claude',
        workspaceRoot,
        nativeId,
        limit: 2,
        cursor: initial.result.nextCursor!,
      }),
    );
    if (final.kind !== 'items') throw new Error('wrong response');
    expect(final.result.data.map((item) => item.text)).toStrictEqual([
      'first answer',
      'first question',
    ]);
    expect(final.result.nextCursor).toBeNull();
    const turns = await request({ kind: 'turns', provider: 'claude', workspaceRoot, nativeId });
    expect(
      turns.kind === 'turns' &&
        turns.result.data.map((turn) => [turn.nativeId, turn.state, turn.completedAt]),
    ).toStrictEqual([
      [first.uuid, 'unknown', null],
      [second.uuid, 'unknown', null],
    ]);
    const selected = await request({
      kind: 'items',
      provider: 'claude',
      workspaceRoot,
      nativeId,
      turnId: second.uuid,
    });
    expect(
      selected.kind === 'items' && selected.result.data.map((item) => item.nativeId),
    ).toStrictEqual([last.uuid, second.uuid]);
    await appendFile(
      transcript(nativeId),
      JSON.stringify({ type: 'custom-title', sessionId: nativeId, customTitle: 'Updated title' }) +
        '\n',
    );
    const renamed = await request({ kind: 'thread', provider: 'claude', workspaceRoot, nativeId });
    expect(renamed.kind === 'thread' && renamed.result.name).toBe('Updated title');
    expect(renamed.kind === 'thread' && renamed.result.updatedAt).toBe(
      Math.trunc((await stat(transcript(nativeId))).mtimeMs),
    );
    await expect(
      request({
        kind: 'items',
        provider: 'claude',
        workspaceRoot,
        nativeId,
        turnId: first.uuid,
        limit: 2,
        cursor: initial.result.nextCursor!,
      }),
    ).rejects.toThrow('Request is invalid');
  });
});

test('incomplete tails are retained, appends advance, and changed chain revisions reject stale continuations', async () => {
  await withClaudeRuntime(async ({ workspaceRoot, transcript, request }) => {
    const nativeId = randomUUID();
    const first = claudeRecord(workspaceRoot, nativeId);
    const answer = claudeRecord(workspaceRoot, nativeId, {
      type: 'assistant',
      parentUuid: first.uuid,
      text: 'original answer',
    });
    const next = claudeRecord(workspaceRoot, nativeId, {
      parentUuid: answer.uuid,
      text: 'appended question',
    });
    const text = JSON.stringify(next);
    await writeFile(
      transcript(nativeId),
      `${JSON.stringify(first)}\n${JSON.stringify(answer)}\n${text.slice(0, 32)}`,
    );
    const partial = await request({ kind: 'items', provider: 'claude', workspaceRoot, nativeId });
    expect(
      partial.kind === 'items' && partial.result.data.map((item) => item.nativeId),
    ).toStrictEqual([answer.uuid, first.uuid]);
    await appendFile(transcript(nativeId), text.slice(32) + '\n');
    const appended = await request({
      kind: 'items',
      provider: 'claude',
      workspaceRoot,
      nativeId,
      limit: 2,
    });
    if (appended.kind !== 'items') throw new Error('wrong response');
    expect(appended.result.nextCursor).not.toBeNull();
    const alternate = claudeRecord(workspaceRoot, nativeId, {
      type: 'assistant',
      parentUuid: first.uuid,
      text: 'revised branch',
    });
    await appendFile(transcript(nativeId), JSON.stringify(alternate) + '\n');
    await expect(
      request({
        kind: 'items',
        provider: 'claude',
        workspaceRoot,
        nativeId,
        limit: 2,
        cursor: appended.result.nextCursor!,
      }),
    ).rejects.toThrow('Request is invalid');
    const branch = await request({ kind: 'items', provider: 'claude', workspaceRoot, nativeId });
    expect(branch.kind === 'items' && branch.result.data.map((item) => item.text)).toStrictEqual([
      'revised branch',
      'Example native message',
    ]);
  });
});

test('hidden native records preserve turn grouping and repeated message identities replace their rendered content', async () => {
  await withClaudeRuntime(async ({ workspaceRoot, transcript, request }) => {
    const nativeId = randomUUID();
    const prompt = claudeRecord(workspaceRoot, nativeId, { text: 'prompt' });
    const hidden = {
      ...claudeRecord(workspaceRoot, nativeId, { parentUuid: prompt.uuid }),
      type: 'attachment',
      message: undefined,
    };
    const answer = claudeRecord(workspaceRoot, nativeId, {
      type: 'assistant',
      parentUuid: hidden.uuid,
      text: 'initial answer',
    });
    const tool = {
      ...claudeRecord(workspaceRoot, nativeId, { parentUuid: answer.uuid }),
      message: { role: 'user', content: [{ type: 'tool_result', content: 'command output' }] },
    };
    await writeFile(
      transcript(nativeId),
      [prompt, hidden, answer, tool].map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
    const first = await request({ kind: 'items', provider: 'claude', workspaceRoot, nativeId });
    expect(
      first.kind === 'items' &&
        first.result.data.map((item) => [item.text, item.turnId, item.kind]),
    ).toStrictEqual([
      ['command output', prompt.uuid, 'tool'],
      ['initial answer', prompt.uuid, 'agent-message'],
      ['prompt', prompt.uuid, 'user-message'],
    ]);
    await appendFile(
      transcript(nativeId),
      JSON.stringify({ ...answer, message: { role: 'assistant', content: 'final answer' } }) + '\n',
    );
    const replaced = await request({ kind: 'items', provider: 'claude', workspaceRoot, nativeId });
    expect(
      replaced.kind === 'items' && replaced.result.data.map((item) => item.text),
    ).toStrictEqual(['final answer', 'prompt']);
    const turns = await request({ kind: 'turns', provider: 'claude', workspaceRoot, nativeId });
    expect(turns.kind === 'turns' && turns.result.data.map((turn) => turn.nativeId)).toStrictEqual([
      prompt.uuid,
    ]);
  });
});

test('hidden records Claude Code writes before the records they follow keep the session and its turn', async () => {
  await withClaudeRuntime(async ({ workspaceRoot, transcript, request }) => {
    const nativeId = randomUUID();
    const hidden = (parentUuid: string, type: string) => ({
      ...claudeRecord(workspaceRoot, nativeId, { parentUuid }),
      type,
      message: undefined,
    });
    const prompt = claudeRecord(workspaceRoot, nativeId, { text: 'prompt' });
    const first = hidden(prompt.uuid, 'attachment');
    const second = hidden(first.uuid, 'attachment');
    const third = hidden(second.uuid, 'system');
    const answer = claudeRecord(workspaceRoot, nativeId, {
      type: 'assistant',
      parentUuid: third.uuid,
      text: 'answer',
    });
    // each hidden record precedes its parent, as instructions attachments and scheduled tasks do
    await writeFile(
      transcript(nativeId),
      [prompt, third, second, first, answer].map((record) => JSON.stringify(record)).join('\n') +
        '\n',
    );
    const items = await request({ kind: 'items', provider: 'claude', workspaceRoot, nativeId });
    expect(
      items.kind === 'items' && items.result.data.map((item) => [item.text, item.turnId]),
    ).toStrictEqual([
      ['answer', prompt.uuid],
      ['prompt', prompt.uuid],
    ]);
    const turns = await request({ kind: 'turns', provider: 'claude', workspaceRoot, nativeId });
    expect(turns.kind === 'turns' && turns.result.data.map((turn) => turn.nativeId)).toStrictEqual([
      prompt.uuid,
    ]);
  });
});

test('a hidden record whose parent never appears keeps its session readable, and a message never does', async () => {
  await withClaudeRuntime(async ({ workspaceRoot, transcript, request }) => {
    const nativeId = randomUUID();
    const prompt = claudeRecord(workspaceRoot, nativeId, { text: 'prompt' });
    const answer = claudeRecord(workspaceRoot, nativeId, {
      type: 'assistant',
      parentUuid: prompt.uuid,
      text: 'answer',
    });
    const orphan = {
      ...claudeRecord(workspaceRoot, nativeId, { parentUuid: randomUUID() }),
      type: 'attachment',
      message: undefined,
    };
    await writeFile(
      transcript(nativeId),
      [prompt, answer, orphan].map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
    const items = await request({ kind: 'items', provider: 'claude', workspaceRoot, nativeId });
    expect(items.kind === 'items' && items.result.data.map((item) => item.text)).toStrictEqual([
      'answer',
      'prompt',
    ]);
    const unknownId = randomUUID();
    const reply = claudeRecord(workspaceRoot, unknownId, {
      type: 'assistant',
      parentUuid: randomUUID(),
    });
    await writeFile(
      transcript(unknownId),
      [claudeRecord(workspaceRoot, unknownId), reply].map((row) => JSON.stringify(row)).join('\n') +
        '\n',
    );
    await expect(
      request({ kind: 'items', provider: 'claude', workspaceRoot, nativeId: unknownId }),
    ).rejects.toThrow('Coding agent is unavailable');
  });
});

test('a record over a mebibyte, such as a tool result holding images, keeps its session', async () => {
  await withClaudeRuntime(async ({ workspaceRoot, transcript, request }) => {
    const nativeId = randomUUID();
    const prompt = claudeRecord(workspaceRoot, nativeId, { text: 'prompt' });
    const tool = {
      ...claudeRecord(workspaceRoot, nativeId, { parentUuid: prompt.uuid }),
      message: { role: 'user', content: [{ type: 'tool_result', content: 'a'.repeat(4_194_304) }] },
    };
    const answer = claudeRecord(workspaceRoot, nativeId, {
      type: 'assistant',
      parentUuid: tool.uuid,
      text: 'answer',
    });
    await writeFile(
      transcript(nativeId),
      [prompt, tool, answer].map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
    // the large record fills a page of its own, past the budget either neighbor would leave
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = await request({
        kind: 'items',
        provider: 'claude',
        workspaceRoot,
        nativeId,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (page.kind !== 'items') throw new Error('wrong response');
      pages.push(page.result.data.map((item) => item.kind));
      cursor = page.result.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(pages).toStrictEqual([['agent-message'], ['tool'], ['user-message']]);
    const evidence = await request({
      kind: 'session-evidence',
      provider: 'claude',
      workspaceRoot,
      nativeId,
      kinds: ['agent-message'],
      limit: 1,
    });
    expect(evidence).toMatchObject({
      kind: 'session-evidence',
      result: { data: [{ text: 'answer' }] },
    });
  });
});

test.each(['truncate', 'replace'])(
  'file identity(%s) -> stale continuations rejected',
  async (operation) => {
    await withClaudeRuntime(async ({ workspaceRoot, transcript, request, root }) => {
      const nativeId = randomUUID();
      const first = claudeRecord(workspaceRoot, nativeId);
      const second = claudeRecord(workspaceRoot, nativeId, {
        type: 'assistant',
        parentUuid: first.uuid,
      });
      await writeFile(
        transcript(nativeId),
        `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
      );
      const page = await request({
        kind: 'items',
        provider: 'claude',
        workspaceRoot,
        nativeId,
        limit: 1,
      });
      if (page.kind !== 'items') throw new Error('wrong response');
      const replacement =
        JSON.stringify(claudeRecord(workspaceRoot, nativeId, { text: 'fresh content' })) + '\n';
      if (operation === 'replace') {
        const path = join(root, 'replacement.jsonl');
        await writeFile(path, replacement);
        await rename(path, transcript(nativeId));
      } else await writeFile(transcript(nativeId), replacement);
      await expect(
        request({
          kind: 'items',
          provider: 'claude',
          workspaceRoot,
          nativeId,
          limit: 1,
          cursor: page.result.nextCursor!,
        }),
      ).rejects.toThrow('Request is invalid');
      const fresh = await request({ kind: 'items', provider: 'claude', workspaceRoot, nativeId });
      expect(fresh.kind === 'items' && fresh.result.data.map((item) => item.text)).toStrictEqual([
        'fresh content',
      ]);
    });
  },
);

test.each([
  ['2.1.304', ['2.1.304', '2.1.304']],
  ['2.1.306', ['2.1.296', '2.1.299']],
  ['2.1.306', ['2.1.306', '2.1.306']],
  ['2.1.306', ['2.1.304', '2.1.306']],
  ['2.1.296', ['2.1.296', '2.1.309']],
  ['2.1.299', ['2.1.299', '9.0.0']],
  ['2.1.309', ['2.1.306', '2.1.309']],
  ['9.0.0', ['2.1.309', '9.0.0']],
])('compatible CLI %s reads and pages transcript labels %o', async (cliVersion, versions) => {
  await withClaudeRuntime(async ({ workspaceRoot, transcript, request, control }) => {
    await control({ version: cliVersion });
    const nativeId = randomUUID();
    const question = {
      ...claudeRecord(workspaceRoot, nativeId, { text: 'qualified question' }),
      version: versions[0],
    };
    const answer = {
      ...claudeRecord(workspaceRoot, nativeId, {
        type: 'assistant',
        parentUuid: question.uuid,
        text: 'qualified answer',
      }),
      version: versions[1],
    };
    await writeFile(
      transcript(nativeId),
      [question, answer].map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
    const threads = await request({ kind: 'threads', provider: 'claude', workspaceRoot });
    expect(
      threads.kind === 'threads' &&
        threads.result.data.map((thread) => [thread.nativeId, thread.historyState]),
    ).toStrictEqual([[nativeId, 'available']]);
    const first = await request({
      kind: 'items',
      provider: 'claude',
      workspaceRoot,
      nativeId,
      limit: 1,
    });
    if (first.kind !== 'items') throw new Error('wrong response');
    expect(first.result.data.map((item) => [item.nativeId, item.text])).toStrictEqual([
      [answer.uuid, 'qualified answer'],
    ]);
    expect(first.result.nextCursor).not.toBeNull();
    const last = await request({
      kind: 'items',
      provider: 'claude',
      workspaceRoot,
      nativeId,
      limit: 1,
      cursor: first.result.nextCursor!,
    });
    if (last.kind !== 'items') throw new Error('wrong response');
    expect(last.result.data.map((item) => [item.nativeId, item.text])).toStrictEqual([
      [question.uuid, 'qualified question'],
    ]);
    expect(last.result.nextCursor).toBeNull();
  });
});

test('history qualification refreshes a rejected projection after runtime restart', async () => {
  await withClaudeRuntime(async ({ workspaceRoot, transcript, stateRoot, runtime, request }) => {
    const nativeId = randomUUID();
    const path = transcript(nativeId);
    await writeFile(path, JSON.stringify(claudeRecord(workspaceRoot, nativeId)) + '\n');
    const initial = await request({ kind: 'items', provider: 'claude', workspaceRoot, nativeId });
    expect(initial.kind === 'items' && initial.result.data.length).toBe(1);
    await runtime.close();
    const identity = await stat(path);
    const prefix = (await readFile(path)).subarray(0, 256);
    const fileIdentity = `${identity.dev}:${identity.ino}:${identity.birthtimeMs}:${createHash('sha256').update(prefix).digest('hex')}`;
    const database = new DatabaseSync(join(stateRoot, 'hq.sqlite'));
    try {
      database
        .prepare('UPDATE hq_claude_file SET identity = ?, supported = -1 WHERE native_id = ?')
        .run(fileIdentity, nativeId);
    } finally {
      database.close();
    }
    const replacement = await createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] });
    try {
      const refreshed = await replacement.request({
        kind: 'items',
        provider: 'claude',
        workspaceRoot,
        nativeId,
      });
      expect(
        refreshed.kind === 'items' && refreshed.result.data.map((item) => item.text),
      ).toStrictEqual(['Example native message']);
    } finally {
      await replacement.close();
    }
  });
});

test.each(['2.1.305', '9.0.0'])(
  'compatible transcript and CLI label %s remains usable alongside other transcript labels',
  async (version) => {
    await withClaudeRuntime(async ({ workspaceRoot, transcript, request, control }) => {
      const supportedId = randomUUID();
      const anotherId = randomUUID();
      await writeFile(
        transcript(supportedId),
        JSON.stringify(claudeRecord(workspaceRoot, supportedId)) + '\n',
      );
      await writeFile(
        transcript(anotherId),
        JSON.stringify({ ...claudeRecord(workspaceRoot, anotherId), version }) + '\n',
      );
      const threads = await request({ kind: 'threads', provider: 'claude', workspaceRoot });
      expect(
        threads.kind === 'threads' &&
          threads.result.data.find((thread) => thread.nativeId === anotherId)?.historyState,
      ).toBe('available');
      const another = await request({
        kind: 'items',
        provider: 'claude',
        workspaceRoot,
        nativeId: anotherId,
      });
      expect(another.kind === 'items' && another.result.data.length).toBe(1);
      const valid = await request({
        kind: 'items',
        provider: 'claude',
        workspaceRoot,
        nativeId: supportedId,
      });
      expect(valid.kind === 'items' && valid.result.data.length).toBe(1);
      await control({ version });
    });
    await withClaudeRuntime(async ({ workspaceRoot, request, control }) => {
      await control({ version });
      expect(await request({ kind: 'threads', provider: 'claude', workspaceRoot })).toMatchObject({
        kind: 'threads',
        result: { data: [], nextCursor: null },
      });
    });
  },
);

test('additive fields and unknown ordered content remain explicit without inventing an agent response', async () => {
  await withClaudeRuntime(async ({ workspaceRoot, transcript, request, control }) => {
    await control({ version: 'next-development-build' });
    const nativeId = randomUUID();
    const question = {
      ...claudeRecord(workspaceRoot, nativeId),
      version: undefined,
      extension: { value: true },
    };
    const unknown = {
      ...claudeRecord(workspaceRoot, nativeId, { parentUuid: question.uuid }),
      type: 'future-native-content',
      version: 'next-development-build',
      message: { role: 'future-role', content: 'Uninterpreted content' },
    };
    const answer = claudeRecord(workspaceRoot, nativeId, {
      type: 'assistant',
      parentUuid: unknown.uuid,
      text: 'Known answer',
    });
    await writeFile(
      transcript(nativeId),
      [question, unknown, answer].map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
    const items = await request({ kind: 'items', provider: 'claude', workspaceRoot, nativeId });
    expect(
      items.kind === 'items' &&
        items.result.data.map((item) => [item.nativeId, item.kind, item.turnId, item.text]),
    ).toStrictEqual([
      [answer.uuid, 'agent-message', question.uuid, 'Known answer'],
      [unknown.uuid, 'unsupported', question.uuid, '[Unsupported native content]'],
      [question.uuid, 'user-message', question.uuid, 'Example native message'],
    ]);
  });
});

test.each(['user', 'future-content'])(
  'content without an ordering identity is unavailable: %s',
  async (type) => {
    await withClaudeRuntime(async ({ workspaceRoot, transcript, request }) => {
      const nativeId = randomUUID();
      const first = claudeRecord(workspaceRoot, nativeId);
      const unidentifiable = {
        ...claudeRecord(workspaceRoot, nativeId, { parentUuid: first.uuid }),
        type,
        uuid: undefined,
      };
      await writeFile(
        transcript(nativeId),
        [first, unidentifiable].map((record) => JSON.stringify(record)).join('\n') + '\n',
      );
      await expect(
        request({ kind: 'items', provider: 'claude', workspaceRoot, nativeId }),
      ).rejects.toThrow('Coding agent is unavailable');
    });
  },
);

test('a malformed conversation record makes the file unavailable instead of silently hiding a native message', async () => {
  await withClaudeRuntime(async ({ workspaceRoot, transcript, request }) => {
    const nativeId = randomUUID();
    const first = claudeRecord(workspaceRoot, nativeId);
    const malformed = {
      ...claudeRecord(workspaceRoot, nativeId, { type: 'assistant', parentUuid: first.uuid }),
      message: undefined,
    };
    await writeFile(
      transcript(nativeId),
      [first, malformed].map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
    await expect(
      request({ kind: 'items', provider: 'claude', workspaceRoot, nativeId }),
    ).rejects.toThrow('Coding agent is unavailable');
  });
});

test.each(['existing', 'removed'])(
  'a native transcript retains messages from a workspace subdirectory (%s)',
  async (state) => {
    await withClaudeRuntime(async ({ workspaceRoot, transcript, request }) => {
      const nativeId = randomUUID();
      const child = join(workspaceRoot, 'planning');
      await mkdir(child);
      if (state === 'removed') await rm(child, { recursive: true });
      const first = claudeRecord(workspaceRoot, nativeId);
      const next = {
        ...claudeRecord(child, nativeId, {
          type: 'assistant',
          parentUuid: first.uuid,
          text: 'Subdirectory response',
        }),
        version: '2.1.299',
      };
      await writeFile(
        transcript(nativeId),
        [first, next].map((record) => JSON.stringify(record)).join('\n') + '\n',
      );
      const items = await request({ kind: 'items', provider: 'claude', workspaceRoot, nativeId });
      expect(items.kind === 'items' && items.result.data.map((item) => item.text)).toStrictEqual([
        'Subdirectory response',
        'Example native message',
      ]);
    });
  },
);

test.each(['sibling', 'symlink', 'excluded', 'symlink-excluded'])(
  'native cwd %s cannot escape the selected workspace',
  async (state) => {
    await withClaudeRuntime(async ({ workspaceRoot, transcript, request, root }) => {
      const nativeId = randomUUID();
      let cwd = workspaceRoot + '-other';
      if (state === 'symlink' || state === 'symlink-excluded') {
        const target =
          state === 'symlink' ? join(root, 'foreign') : join(workspaceRoot, '_archive');
        await mkdir(target);
        const link = join(workspaceRoot, 'escape');
        await symlink(target, link);
        cwd = join(link, 'removed');
      } else if (state === 'excluded') cwd = join(workspaceRoot, '_archive');
      await writeFile(transcript(nativeId), JSON.stringify(claudeRecord(cwd, nativeId)) + '\n');
      const threads = await request({ kind: 'threads', provider: 'claude', workspaceRoot });
      expect(threads.kind === 'threads' && threads.result.data).toStrictEqual([]);
      await expect(
        request({ kind: 'items', provider: 'claude', workspaceRoot, nativeId }),
      ).rejects.toThrow('Coding agent is unavailable');
    });
  },
);

test('workspace authorization, excluded subtrees, links and malformed native identity fail closed', async () => {
  await withClaudeRuntime(async ({ workspaceRoot, projectRoot, transcript, request, root }) => {
    const supportedId = randomUUID();
    const linkedId = randomUUID();
    const foreignId = randomUUID();
    await writeFile(
      transcript(supportedId),
      JSON.stringify(claudeRecord(workspaceRoot, supportedId)) + '\n',
    );
    const secretPath = join(root, 'foreign.jsonl');
    await writeFile(secretPath, JSON.stringify(claudeRecord(workspaceRoot, linkedId)) + '\n');
    await symlink(secretPath, transcript(linkedId));
    await writeFile(
      transcript(foreignId),
      [
        { type: 'custom-title', sessionId: foreignId, customTitle: 'Private foreign title' },
        claudeRecord(join(root, 'foreign'), foreignId),
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    for (const name of ['_archive', '_archives', '_backup', '_backups']) {
      const excluded = join(projectRoot, name);
      await mkdir(excluded);
      await writeFile(join(excluded, `${randomUUID()}.jsonl`), 'unsupported content\n');
    }
    const threads = await request({ kind: 'threads', provider: 'claude', workspaceRoot });
    expect(
      threads.kind === 'threads' && threads.result.data.map((thread) => thread.nativeId).sort(),
    ).toStrictEqual([supportedId]);
    expect(JSON.stringify(threads)).not.toContain('Private foreign title');
    for (const nativeId of [linkedId, foreignId, '../escape']) {
      await expect(
        request({ kind: 'items', provider: 'claude', workspaceRoot, nativeId }),
      ).rejects.toThrow('Coding agent is unavailable');
    }
    await expect(
      request({ kind: 'items', provider: 'claude', workspaceRoot: root, nativeId: supportedId }),
    ).rejects.toThrow('Access is denied');
  });
});

test(
  '1,024 equal-time native sessions use bounded seek pages and do not skip concurrent newer inserts',
  { timeout: 30_000 },
  async () => {
    await withClaudeRuntime(async ({ workspaceRoot, transcript, request }) => {
      const ids: string[] = [];
      for (let index = 0; index < 1024; index += 1) {
        const nativeId = randomUUID();
        ids.push(nativeId);
        await writeFile(
          transcript(nativeId),
          JSON.stringify(claudeRecord(workspaceRoot, nativeId)) + '\n',
        );
      }
      ids.sort().reverse();
      let cursor: string | undefined;
      const seen: string[] = [];
      do {
        const page = await request({
          kind: 'threads',
          provider: 'claude',
          workspaceRoot,
          limit: 128,
          cursor,
        });
        if (page.kind !== 'threads') throw new Error('wrong response');
        expect(page.result.data.length).toBeLessThanOrEqual(128);
        seen.push(...page.result.data.map((thread) => thread.nativeId));
        cursor = page.result.nextCursor ?? undefined;
        if (seen.length === 128) {
          const newer = randomUUID();
          await writeFile(
            transcript(newer),
            JSON.stringify(
              claudeRecord(workspaceRoot, newer, { timestamp: '2026-10-20T12:00:00.000Z' }),
            ) + '\n',
          );
        }
      } while (cursor);
      expect(seen).toStrictEqual(ids);
    });
  },
);

test(
  '1,024-message native histories remain on disk and public pages truncate text without splitting Unicode',
  { timeout: 15_000 },
  async () => {
    await withClaudeRuntime(async ({ workspaceRoot, transcript, request }) => {
      const nativeId = randomUUID();
      let parentUuid: string | null = null;
      const records: ReturnType<typeof claudeRecord>[] = [];
      for (let index = 0; index < 1024; index += 1) {
        const record = claudeRecord(workspaceRoot, nativeId, {
          parentUuid,
          type: index % 2 === 0 ? 'user' : 'assistant',
          text: index === 0 ? 'a'.repeat(65_535) + '😀suffix' : `Native message ${index}`,
        });
        records.push(record);
        parentUuid = record.uuid;
      }
      await writeFile(
        transcript(nativeId),
        records.map((record) => JSON.stringify(record)).join('\n') + '\n',
      );
      let cursor: string | undefined;
      const seen: string[] = [];
      do {
        const page = await request({
          kind: 'items',
          provider: 'claude',
          workspaceRoot,
          nativeId,
          limit: 128,
          cursor,
        });
        if (page.kind !== 'items') throw new Error('wrong response');
        expect(page.result.data.length).toBeLessThanOrEqual(128);
        const oldest = page.result.data.find((item) => item.nativeId === records[0]!.uuid);
        if (oldest) {
          expect(oldest.text).toBe('a'.repeat(65_535));
          expect(oldest.isTruncated).toBe(true);
        }
        seen.push(...page.result.data.map((item) => item.nativeId));
        cursor = page.result.nextCursor ?? undefined;
      } while (cursor);
      // newest first, each page continuing toward older items until the oldest
      expect(seen).toStrictEqual(records.map((record) => record.uuid).reverse());
    });
  },
);

test('items cut text at their text limit on a code-point boundary, and read one item within its turn', async () => {
  await withClaudeRuntime(async ({ workspaceRoot, transcript, request }) => {
    const nativeId = randomUUID();
    const prompt = claudeRecord(workspaceRoot, nativeId, { text: 'abc😀def' });
    const hidden = {
      ...claudeRecord(workspaceRoot, nativeId, { parentUuid: prompt.uuid }),
      type: 'attachment',
      message: undefined,
    };
    const answer = claudeRecord(workspaceRoot, nativeId, {
      type: 'assistant',
      parentUuid: hidden.uuid,
      text: 'x'.repeat(100),
    });
    const next = claudeRecord(workspaceRoot, nativeId, { parentUuid: answer.uuid, text: 'next' });
    const reply = claudeRecord(workspaceRoot, nativeId, {
      type: 'assistant',
      parentUuid: next.uuid,
      text: 'reply',
    });
    await writeFile(
      transcript(nativeId),
      [prompt, hidden, answer, next, reply].map((record) => JSON.stringify(record)).join('\n') +
        '\n',
    );
    const target = { kind: 'items', provider: 'claude', workspaceRoot, nativeId } as const;
    const cut = await request({ ...target, textLimit: 4 });
    // the emoji's surrogate pair would straddle the limit, so its text stops before it
    expect(
      cut.kind === 'items' && cut.result.data.map((item) => [item.text, item.isTruncated]),
    ).toStrictEqual([
      ['repl', true],
      ['next', false],
      ['xxxx', true],
      ['abc', true],
    ]);
    const one = await request({
      ...target,
      nativeItemId: answer.uuid,
      turnId: prompt.uuid,
      textLimit: 10,
    });
    expect(one.kind === 'items' && one.result).toMatchObject({
      data: [
        { nativeId: answer.uuid, turnId: prompt.uuid, text: 'x'.repeat(10), isTruncated: true },
      ],
      nextCursor: null,
    });
    expect(one.kind === 'items' && one.result.data).toHaveLength(1);
    // a hidden item, an unknown one, and one outside the given turn read as an empty page
    for (const [nativeItemId, turnId] of [
      [hidden.uuid, prompt.uuid],
      [randomUUID(), prompt.uuid],
      [answer.uuid, next.uuid],
    ] as const) {
      const empty = await request({ ...target, nativeItemId, turnId });
      expect(empty.kind === 'items' && empty.result).toMatchObject({ data: [], nextCursor: null });
    }
    // one item is read only within its turn, and without a cursor
    await expect(request({ ...target, nativeItemId: answer.uuid })).rejects.toThrow(
      'The HQ request is invalid',
    );
    const page = await request({ ...target, limit: 1 });
    if (page.kind !== 'items') throw new Error('wrong response');
    await expect(
      request({
        ...target,
        nativeItemId: answer.uuid,
        turnId: prompt.uuid,
        cursor: page.result.nextCursor!,
      }),
    ).rejects.toThrow('The HQ request is invalid');
  });
});
