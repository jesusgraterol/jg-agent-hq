// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectToRejectCode } from 'jg-exception/testing';
import type { IHqRequestInput, IThreadsPage } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';

import {
  claudeRecord,
  withClaudeRuntime,
  writeFixtureControl,
  type IClaudeFixture,
} from '../../../scripts/test-support/index.js';

// one native session a test lists, last active at a whole second, in Unix milliseconds
type ISession = {
  provider: 'claude' | 'codex';
  folder: string;
  nativeId: string;
  updatedAt: number;
  name?: string;
  continuedIn?: string;
};
type IThreadsCommand = Omit<Extract<IHqRequestInput, { kind: 'threads' }>, 'kind'>;

const BASE = 1_761_040_800_000;

// a folder inside the allowed workspace, with the Claude project directory its transcripts go in
const createFolder = async (fixture: IClaudeFixture, name: string): Promise<string> => {
  const folder = join(fixture.workspaceRoot, name);
  await mkdir(folder);
  await mkdir(join(fixture.configRoot, 'projects', folder.replace(/[^a-zA-Z0-9]/g, '-')));
  return folder;
};

/*
 * Writes each Claude session as a transcript last active at its time, and lists each Codex
 * session in the fake daemon, which sorts ties by ascending ID, unlike HQ's list.
 */
const writeSessions = async (fixture: IClaudeFixture, sessions: ISession[]): Promise<void> => {
  for (const session of sessions.filter(({ provider }) => provider === 'claude')) {
    const at = new Date(session.updatedAt);
    const records: object[] = [
      claudeRecord(session.folder, session.nativeId, { timestamp: at.toISOString() }),
    ];
    if (session.name)
      records.push({
        type: 'custom-title',
        sessionId: session.nativeId,
        customTitle: session.name,
      });
    if (session.continuedIn)
      records.push({
        type: 'continued-in',
        timestamp: at.toISOString(),
        sessionId: session.nativeId,
        continuedInSessionId: session.continuedIn,
      });
    const path = join(
      fixture.configRoot,
      'projects',
      session.folder.replace(/[^a-zA-Z0-9]/g, '-'),
      `${session.nativeId}.jsonl`,
    );
    await writeFile(path, records.map((record) => `${JSON.stringify(record)}\n`).join(''));
    await utimes(path, at, at);
  }
  await writeFixtureControl(fixture.root, 'control.json', {
    listedThreads: sessions
      .filter(({ provider }) => provider === 'codex')
      .map((session) => ({
        id: session.nativeId,
        cwd: session.folder,
        name: session.name ?? 'Task',
        updatedAt: session.updatedAt / 1000,
      })),
  });
};

const list = async (fixture: IClaudeFixture, command: IThreadsCommand): Promise<IThreadsPage> => {
  const response = await fixture.runtime.request({ kind: 'threads', ...command });
  if (response.kind !== 'threads') throw new Error('Missing sessions');
  return response.result;
};

// lists every page, each continuing the one before
const listAll = async (fixture: IClaudeFixture, command: IThreadsCommand): Promise<string[][]> => {
  const pages: string[][] = [];
  let cursor: string | undefined;
  do {
    const page = await list(fixture, { ...command, ...(cursor ? { cursor } : {}) });
    pages.push(page.data.map((session) => session.nativeId));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return pages;
};

// the Codex daemon's session list calls, in order
const listCalls = async (
  fixture: IClaudeFixture,
): Promise<{ cwd: string; limit: number; cursor?: string }[]> =>
  (await readFile(join(fixture.root, 'calls.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((call) => call.method === 'thread/list')
    .map((call) => call.params);

/*
 * The sessions one daemon call returns: a folder's sessions, last activity first with ties by
 * ascending ID, after the `<seconds>|<id>` continuation, as the fake daemon lists them.
 */
const returnedBy = (
  sessions: ISession[],
  call: { cwd: string; limit: number; cursor?: string },
): string[] => {
  const native = sessions
    .filter((session) => session.provider === 'codex' && session.folder === call.cwd)
    .map((session) => [session.updatedAt / 1000, session.nativeId] as const)
    .sort(([leftAt, leftId], [rightAt, rightId]) =>
      leftAt !== rightAt ? rightAt - leftAt : leftId < rightId ? -1 : 1,
    );
  const start = call.cursor ? native.findIndex(([at, id]) => `${at}|${id}` === call.cursor) + 1 : 0;
  return native.slice(start, start + call.limit).map(([, id]) => id);
};

test('an empty list has one page without a cursor, and pages ending exactly at the last session have no next cursor', async () => {
  await withClaudeRuntime(async (fixture) => {
    const a = await createFolder(fixture, 'a');
    const b = await createFolder(fixture, 'b');
    await writeSessions(fixture, []);
    expect(await list(fixture, { workspaceRoots: [a, b] })).toStrictEqual({
      data: [],
      nextCursor: null,
      unavailable: [],
    });
    const sessions: ISession[] = [
      { provider: 'codex', folder: a, nativeId: 'codex-a', updatedAt: BASE },
      { provider: 'claude', folder: b, nativeId: randomUUID(), updatedAt: BASE - 1_000 },
      { provider: 'codex', folder: b, nativeId: 'codex-b', updatedAt: BASE - 2_000 },
      { provider: 'claude', folder: a, nativeId: randomUUID(), updatedAt: BASE - 3_000 },
    ];
    await writeSessions(fixture, sessions);
    const ids = sessions.map((session) => session.nativeId);
    const whole = await list(fixture, { workspaceRoots: [a, b], limit: 4 });
    expect(whole.data.map((session) => session.nativeId)).toStrictEqual(ids);
    expect(whole.nextCursor).toBeNull();
    expect(await listAll(fixture, { workspaceRoots: [a, b], limit: 2 })).toStrictEqual([
      ids.slice(0, 2),
      ids.slice(2),
    ]);
  });
});

test(
  'pages continue across folders and providers in order, and a later page never reads a native page it listed whole',
  { timeout: 30_000 },
  async () => {
    await withClaudeRuntime(async (fixture) => {
      const a = await createFolder(fixture, 'a');
      const b = await createFolder(fixture, 'b');
      // each letter names the next session's source, newest first: Codex or Claude, in a or b
      const sources = {
        X: ['codex', a],
        Y: ['codex', b],
        c: ['claude', a],
        y: ['claude', b],
      } as const;
      const sessions = [...'XXcYyyXycXYcyYXyycXYXcYyccXYyXyX'].map((letter, index): ISession => {
        const [provider, folder] = sources[letter as keyof typeof sources];
        return {
          provider,
          folder,
          nativeId: provider === 'codex' ? `codex-${String(index).padStart(2, '0')}` : randomUUID(),
          updatedAt: BASE - index * 1_000,
        };
      });
      await writeSessions(fixture, sessions);
      const listed: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const before = (await listCalls(fixture)).length;
        const page = await list(fixture, { workspaceRoots: [b, a], limit: 3, cursor });
        expect(page.data.length).toBe(page.nextCursor ? 3 : sessions.length % 3 || 3);
        // every native page a later list page reads holds a session no earlier page listed
        if (pages > 0)
          for (const call of (await listCalls(fixture)).slice(before))
            expect(returnedBy(sessions, call).some((id) => !listed.includes(id))).toBe(true);
        listed.push(...page.data.map((session) => session.nativeId));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor);
      expect(listed).toStrictEqual(sessions.map((session) => session.nativeId));
      expect(pages).toBe(Math.ceil(sessions.length / 3));
    });
  },
);

test('sessions last active at the same moment list by provider, then native ID, descending, each once', async () => {
  await withClaudeRuntime(async (fixture) => {
    const a = await createFolder(fixture, 'a');
    const b = await createFolder(fixture, 'b');
    const claudeIds = [randomUUID(), randomUUID(), randomUUID()].sort().reverse();
    const sessions: ISession[] = [
      { provider: 'codex', folder: a, nativeId: 'tie-1', updatedAt: BASE },
      { provider: 'codex', folder: b, nativeId: 'tie-2', updatedAt: BASE },
      { provider: 'codex', folder: a, nativeId: 'tie-3', updatedAt: BASE },
      { provider: 'claude', folder: a, nativeId: claudeIds[1]!, updatedAt: BASE },
      { provider: 'claude', folder: b, nativeId: claudeIds[0]!, updatedAt: BASE },
      { provider: 'claude', folder: a, nativeId: claudeIds[2]!, updatedAt: BASE },
      { provider: 'codex', folder: b, nativeId: 'older', updatedAt: BASE - 1_000 },
    ];
    await writeSessions(fixture, sessions);
    const expected = ['tie-3', 'tie-2', 'tie-1', ...claudeIds, 'older'];
    for (const limit of [1, 2, 3])
      expect((await listAll(fixture, { workspaceRoots: [a, b], limit })).flat()).toStrictEqual(
        expected,
      );
  });
});

test('search and the continued filter apply before a page is counted', async () => {
  await withClaudeRuntime(async (fixture) => {
    const a = await createFolder(fixture, 'a');
    const next = randomUUID();
    const continued = [randomUUID(), randomUUID(), randomUUID()];
    const kept = [randomUUID(), randomUUID()];
    await writeSessions(fixture, [
      { provider: 'claude', folder: a, nativeId: next, updatedAt: BASE - 60_000, name: 'Other' },
      ...continued.map(
        (nativeId, index): ISession => ({
          provider: 'claude',
          folder: a,
          nativeId,
          updatedAt: BASE - index * 2_000,
          name: 'Match moved',
          continuedIn: next,
        }),
      ),
      ...kept.map(
        (nativeId, index): ISession => ({
          provider: 'claude',
          folder: a,
          nativeId,
          updatedAt: BASE - 1_000 - index * 4_000,
          name: 'Match kept',
        }),
      ),
      { provider: 'codex', folder: a, nativeId: 'codex-other', updatedAt: BASE - 3_000 },
      {
        provider: 'codex',
        folder: a,
        nativeId: 'codex-match',
        updatedAt: BASE - 9_000,
        name: 'Match',
      },
    ]);
    const page = await list(fixture, {
      workspaceRoots: [a],
      search: 'Match',
      excludeContinued: true,
      limit: 2,
    });
    expect(page.data.map((session) => session.nativeId)).toStrictEqual(kept);
    expect(
      await listAll(fixture, {
        workspaceRoots: [a],
        search: 'Match',
        excludeContinued: true,
        limit: 2,
      }),
    ).toStrictEqual([kept, ['codex-match']]);
    // without the filter, the continued sessions count, each naming the session it continues in
    const all = await list(fixture, { workspaceRoots: [a], search: 'Match', limit: 2 });
    expect(all.data.map((session) => [session.nativeId, session.continuedIn])).toStrictEqual([
      [continued[0], next],
      [kept[0], null],
    ]);
  });
});

test(
  'sessions HQ created that no turn has started list by their last update among native sessions',
  { timeout: 30_000 },
  async () => {
    await withClaudeRuntime(async (fixture) => {
      const a = await createFolder(fixture, 'a');
      const b = await createFolder(fixture, 'b');
      const status = await fixture.runtime.request({ kind: 'status' });
      if (status.kind !== 'status') throw new Error('Missing status');
      const created = [];
      for (const [folder, name] of [
        [a, 'first-created'],
        [b, 'second-created'],
      ] as const) {
        const action = await fixture.runtime.request({
          kind: 'action',
          action: {
            id: randomUUID(),
            runtimeEpoch: status.result.runtimeEpoch,
            command: { kind: 'thread-create', provider: 'codex', workspaceRoot: folder, name },
          },
        });
        if (action.kind !== 'action') throw new Error('Missing admission');
        const threadId = action.result.threadId!;
        await expect
          .poll(async () => {
            const thread = await fixture.runtime.request({ kind: 'managed-thread', threadId });
            return thread.kind === 'managed-thread' ? thread.result?.state : null;
          })
          .toBe('idle');
        const thread = await fixture.runtime.request({ kind: 'managed-thread', threadId });
        if (thread.kind !== 'managed-thread' || !thread.result) throw new Error('Missing thread');
        created.push(thread.result);
      }
      // native sessions last active an hour after and an hour before HQ created them
      const later = Math.ceil(Date.now() / 1000) * 1000 + 3_600_000;
      const earlier = Math.floor(created[0]!.updatedAt / 1000) * 1000 - 3_600_000;
      const newest = randomUUID();
      await writeSessions(fixture, [
        { provider: 'claude', folder: b, nativeId: newest, updatedAt: later },
        { provider: 'codex', folder: a, nativeId: 'codex-old', updatedAt: earlier },
      ]);
      const unstarted = [...created]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((thread) => thread.nativeId);
      expect((await listAll(fixture, { workspaceRoots: [a, b], limit: 1 })).flat()).toStrictEqual([
        newest,
        ...unstarted,
        'codex-old',
      ]);
      const page = await list(fixture, { workspaceRoots: [a, b], providers: ['codex'] });
      expect(page.data.map((session) => [session.name, session.ownership])).toStrictEqual([
        ...[...created]
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .map((thread) => [thread.name, 'managed']),
        ['Task', 'external'],
      ]);
      // they follow the request's providers and search too
      expect(
        (await list(fixture, { workspaceRoots: [a, b], providers: ['claude'] })).data,
      ).toStrictEqual([expect.objectContaining({ nativeId: newest })]);
      expect(
        (await list(fixture, { workspaceRoots: [a, b], search: 'second' })).data.map(
          (session) => session.name,
        ),
      ).toStrictEqual(['second-created']);
    });
  },
);

test('a session added after the last listed one shows, one added before it or removed before its page does not, and none shows twice', async () => {
  await withClaudeRuntime(async (fixture) => {
    const a = await createFolder(fixture, 'a');
    const session = (nativeId: string, seconds: number): ISession => ({
      provider: 'codex',
      folder: a,
      nativeId,
      updatedAt: BASE - seconds * 1_000,
    });
    const original = [1, 2, 3, 4, 5, 6].map((index) => session(`s${index}`, index * 10));
    await writeSessions(fixture, original);
    const first = await list(fixture, { workspaceRoots: [a], providers: ['codex'], limit: 2 });
    expect(first.data.map(({ nativeId }) => nativeId)).toStrictEqual(['s1', 's2']);
    // s1 was listed and s4 not yet when both are removed; n0 is newer than the cursor, n4 older
    await writeSessions(fixture, [
      session('n0', 0),
      ...original.filter(({ nativeId }) => nativeId !== 's1' && nativeId !== 's4'),
      session('n4', 45),
    ]);
    const rest: string[] = [];
    let cursor = first.nextCursor ?? undefined;
    while (cursor) {
      const page = await list(fixture, {
        workspaceRoots: [a],
        providers: ['codex'],
        limit: 2,
        cursor,
      });
      rest.push(...page.data.map(({ nativeId }) => nativeId));
      cursor = page.nextCursor ?? undefined;
    }
    expect(rest).toStrictEqual(['s3', 'n4', 's5', 's6']);
  });
});

test('a provider that cannot be read is left out of the page and named, while the other lists', async () => {
  await withClaudeRuntime(async (fixture) => {
    const a = await createFolder(fixture, 'a');
    const b = await createFolder(fixture, 'b');
    const claude = [randomUUID(), randomUUID(), randomUUID()];
    await writeSessions(
      fixture,
      claude.map((nativeId, index) => ({
        provider: 'claude',
        folder: index ? a : b,
        nativeId,
        updatedAt: BASE - index * 1_000,
      })),
    );
    await writeFixtureControl(fixture.root, 'control.json', { mode: 'exit-on-list' });
    const first = await list(fixture, { workspaceRoots: [a, b], limit: 2 });
    expect(first.data.map(({ nativeId }) => nativeId)).toStrictEqual(claude.slice(0, 2));
    expect(first.unavailable).toStrictEqual([
      { provider: 'codex', workspaceRoot: a },
      { provider: 'codex', workspaceRoot: b },
    ]);
    // the rest of the list continues without the provider it left out, which it doesn't read
    await writeFixtureControl(fixture.root, 'control.json', { listedThreads: [] });
    const calls = (await listCalls(fixture)).length;
    expect(
      await list(fixture, { workspaceRoots: [a, b], limit: 2, cursor: first.nextCursor! }),
    ).toMatchObject({ data: [{ nativeId: claude[2] }], nextCursor: null, unavailable: [] });
    expect(await listCalls(fixture)).toHaveLength(calls);
  });
});

test('a cursor continues only the folders, providers, search and filter it came from, in any order', async () => {
  await withClaudeRuntime(async (fixture) => {
    const a = await createFolder(fixture, 'a');
    const b = await createFolder(fixture, 'b');
    await writeSessions(
      fixture,
      [0, 1, 2].map((index) => ({
        provider: 'codex',
        folder: index ? a : b,
        nativeId: `codex-${index}`,
        updatedAt: BASE - index * 1_000,
      })),
    );
    const first = await list(fixture, {
      workspaceRoots: [a, b],
      providers: ['codex', 'claude'],
      limit: 1,
    });
    expect(first.data.map(({ nativeId }) => nativeId)).toStrictEqual(['codex-0']);
    const cursor = first.nextCursor!;
    // the same filters in another order continue it
    expect(
      await list(fixture, {
        workspaceRoots: [b, a],
        providers: ['claude', 'codex'],
        limit: 2,
        cursor,
      }),
    ).toMatchObject({ data: [{ nativeId: 'codex-1' }, { nativeId: 'codex-2' }], nextCursor: null });
    const tampered = `${cursor.slice(0, 8)}${cursor[8] === 'A' ? 'B' : 'A'}${cursor.slice(9)}`;
    for (const changed of [
      { workspaceRoots: [a], cursor },
      { workspaceRoots: [a, b], providers: ['codex' as const], cursor },
      { workspaceRoots: [a, b], search: 'codex', cursor },
      { workspaceRoots: [a, b], excludeContinued: true, cursor },
      { workspaceRoots: [a, b], cursor: tampered },
      { workspaceRoots: [a, b], cursor: 'not-a-cursor' },
    ])
      await expectToRejectCode(
        fixture.runtime.request({ kind: 'threads', ...changed }),
        'JG_AGENT_HQ_CURSOR_INVALID',
        'The HQ cursor does not match this request',
      );
  });
});

test('a page holds 32 sessions unless asked for up to 128, from 1 to 64 distinct folders inside the allowed workspaces', async () => {
  await withClaudeRuntime(async (fixture) => {
    const a = await createFolder(fixture, 'a');
    await writeSessions(
      fixture,
      Array.from({ length: 130 }, (_, index) => ({
        provider: 'codex',
        folder: a,
        nativeId: `codex-${String(index).padStart(3, '0')}`,
        updatedAt: BASE - index * 1_000,
      })),
    );
    const byDefault = await list(fixture, { workspaceRoots: [a] });
    expect(byDefault.data).toHaveLength(32);
    expect(byDefault.nextCursor).not.toBeNull();
    const largest = await list(fixture, { workspaceRoots: [a], limit: 128 });
    expect(largest.data).toHaveLength(128);
    expect(largest.data.at(-1)?.nativeId).toBe('codex-127');
    const invalid: IThreadsCommand[] = [
      { workspaceRoots: [a], limit: 129 },
      { workspaceRoots: [a], limit: 0 },
      { workspaceRoots: [] },
      { workspaceRoots: [a, a] },
      { workspaceRoots: [a], providers: [] },
      { workspaceRoots: [a], providers: ['codex', 'codex'] },
      { workspaceRoots: Array.from({ length: 65 }, (_, index) => join(a, `folder-${index}`)) },
    ];
    for (const command of invalid)
      await expectToRejectCode(
        fixture.runtime.request({ kind: 'threads', ...command }),
        'JG_AGENT_HQ_REQUEST_INVALID',
        'The HQ request is invalid',
      );
    // two paths to one folder would list its sessions twice
    const link = join(fixture.workspaceRoot, 'link');
    await symlink(a, link);
    await expectToRejectCode(
      fixture.runtime.request({ kind: 'threads', workspaceRoots: [a, link] }),
      'JG_AGENT_HQ_REQUEST_INVALID',
      'The HQ request is invalid',
    );
    await expectToRejectCode(
      fixture.runtime.request({ kind: 'threads', workspaceRoots: [a, fixture.root] }),
      'JG_AGENT_HQ_TARGET_FORBIDDEN',
      'The HQ target is outside the allowed workspaces',
    );
  });
});
