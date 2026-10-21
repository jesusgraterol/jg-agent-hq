// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HqResponseSchema } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';

import { claudeRecord, withClaudeRuntime } from '../../../../scripts/test-support/index.js';

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
    expect(first.result.data.map((item) => item.nativeId)).toStrictEqual(
      records.slice(0, 4).map((record) => record.uuid),
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
      records.slice(4).map((record) => record.uuid),
    );
    expect(last.kind === 'items' && last.result.nextCursor).toBeNull();
  });
});

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
      'first question',
      'first answer',
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
      'second question',
      'second answer',
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
    ).toStrictEqual([second.uuid, last.uuid]);
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
    ).toStrictEqual([first.uuid, answer.uuid]);
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
      'Example native message',
      'revised branch',
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
      ['prompt', prompt.uuid, 'user-message'],
      ['initial answer', prompt.uuid, 'agent-message'],
      ['command output', prompt.uuid, 'command'],
    ]);
    await appendFile(
      transcript(nativeId),
      JSON.stringify({ ...answer, message: { role: 'assistant', content: 'final answer' } }) + '\n',
    );
    const replaced = await request({ kind: 'items', provider: 'claude', workspaceRoot, nativeId });
    expect(
      replaced.kind === 'items' && replaced.result.data.map((item) => item.text),
    ).toStrictEqual(['prompt', 'final answer']);
    const turns = await request({ kind: 'turns', provider: 'claude', workspaceRoot, nativeId });
    expect(turns.kind === 'turns' && turns.result.data.map((turn) => turn.nativeId)).toStrictEqual([
      prompt.uuid,
    ]);
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
  ['2.1.306', ['2.1.306', '2.1.306']],
  ['2.1.306', ['2.1.304', '2.1.306']],
])('qualified CLI %s reads and pages transcript versions %o', async (cliVersion, versions) => {
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
      [question.uuid, 'qualified question'],
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
      [answer.uuid, 'qualified answer'],
    ]);
    expect(last.result.nextCursor).toBeNull();
  });
});

test.each(['2.1.305', '9.0.0'])(
  'unqualified file/CLI version %s is unavailable while qualified discoveries remain browsable',
  async (version) => {
    await withClaudeRuntime(async ({ workspaceRoot, transcript, request, control }) => {
      const supportedId = randomUUID();
      const unsupportedId = randomUUID();
      await writeFile(
        transcript(supportedId),
        JSON.stringify(claudeRecord(workspaceRoot, supportedId)) + '\n',
      );
      await writeFile(
        transcript(unsupportedId),
        JSON.stringify({ ...claudeRecord(workspaceRoot, unsupportedId), version }) + '\n',
      );
      const threads = await request({ kind: 'threads', provider: 'claude', workspaceRoot });
      expect(
        threads.kind === 'threads' &&
          threads.result.data.find((thread) => thread.nativeId === unsupportedId)?.historyState,
      ).toBe('unavailable');
      await expect(
        request({ kind: 'items', provider: 'claude', workspaceRoot, nativeId: unsupportedId }),
      ).rejects.toThrow('Coding agent is unavailable');
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
      await expect(request({ kind: 'threads', provider: 'claude', workspaceRoot })).rejects.toThrow(
        'Coding agent is unavailable',
      );
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
      const records = [];
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
        if (seen.length === 0) {
          expect(page.result.data[0]?.text).toBe('a'.repeat(65_535));
          expect(page.result.data[0]?.isTruncated).toBe(true);
        }
        seen.push(...page.result.data.map((item) => item.nativeId));
        cursor = page.result.nextCursor ?? undefined;
      } while (cursor);
      expect(seen).toStrictEqual(records.map((record) => record.uuid));
    });
  },
);
