// @vitest-environment node
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHqSnapshot, packHqSnapshot, restoreHqSnapshot, unpackHqSnapshot } from 'jg-agent-hq';
import { expectToRejectCode } from 'jg-exception/testing';
import { afterEach, expect, test, vi } from 'vitest';

import { withClaudeRuntime } from '../../../scripts/test-support/index.js';

// every directory the package creates, to show a rejected archive never reserves its destination
const created = vi.hoisted(() => ({ paths: [] as string[] }));
// a disk failure while the decrypted plaintext is written
const disk = vi.hoisted(() => ({ isFull: false }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => {
      const stream = actual.createWriteStream(...args);
      if (disk.isFull && String(args[0]).endsWith('/plaintext'))
        stream.once('open', () =>
          stream.destroy(
            Object.assign(new Error('no space left on device'), {
              code: 'ENOSPC',
              syscall: 'write',
            }),
          ),
        );
      return stream;
    },
  };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      created.paths.push(String(args[0]));
      return actual.mkdir(...args);
    },
  };
});
afterEach(() => {
  created.paths.length = 0;
  disk.isFull = false;
});

const KEY = Buffer.alloc(32, 7);

// an independent encoder of the archive layout, for archives the package would never write
const encodeArchive = (entries: { path: string; content: Buffer }[], key = KEY): Buffer => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.concat(
    entries.flatMap(({ path, content }) => {
      const name = Buffer.from(path);
      const header = Buffer.alloc(2 + name.length + 8);
      header.writeUInt16BE(name.length, 0);
      name.copy(header, 2);
      header.writeBigUInt64BE(BigInt(content.length), 2 + name.length);
      return [header, content];
    }),
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from('JGHQSNA1'), iv, ciphertext, cipher.getAuthTag()]);
};

// a snapshot with a registered plan, its files in archive order and a packed archive
const withArchive = async (
  run: (fixture: {
    root: string;
    snapshot: Awaited<ReturnType<typeof createHqSnapshot>>;
    entries: { path: string; content: Buffer }[];
    archive: string;
  }) => Promise<void>,
): Promise<void> => {
  await withClaudeRuntime(async ({ runtime, root, workspaceRoot }) => {
    const directory = join(workspaceRoot, 'archived-plan');
    await mkdir(directory);
    await writeFile(
      join(directory, 'plan.md'),
      '---\nid: archived-plan\ncreated_at: 2026-10-25T00:00:00.000Z\nupdated_at: 2026-10-25T00:00:00.000Z\nrevision: 1\nstatus: pending\n---\n# Archived plan\n\nKeep the archive private.\n',
    );
    await writeFile(
      join(directory, 'milestones.md'),
      '# Milestones\n\n## Milestone 1: Archive\n**Status:** pending\n**Milestone ID:** 10000000-0000-4000-8000-000000000001\n\nPack the snapshot.\n',
    );
    // an approval writes the plan operation that registers the plan for capture
    const status = await runtime.request({
      kind: 'plan',
      command: { kind: 'status', target: { directory } },
    });
    if (status.kind !== 'plan' || status.result.kind !== 'status') throw new Error('Missing plan');
    await runtime.request({
      kind: 'plan',
      command: {
        kind: 'approve',
        target: { directory },
        action: {
          id: randomUUID(),
          operatorId: 'archive-owner',
          source: { kind: 'user-action', reference: 'archive-test' },
        },
        expected: status.result.result.revision,
        scope: 'plan',
        presentationHash: status.result.result.inspection.plan,
      },
    });
    const snapshot = await createHqSnapshot(runtime, join(root, 'snapshot'));
    expect(snapshot.planCount).toBe(1);
    const planKey = (await readdir(join(snapshot.directory, 'plans')))[0]!;
    const entries = await Promise.all(
      [
        'manifest.jsonl',
        'complete.json',
        'hq.sqlite',
        'action.key',
        `plans/${planKey}/plan.md`,
        `plans/${planKey}/milestones.md`,
        `plans/${planKey}/coordination.json`,
      ].map(async (path) => ({ path, content: await readFile(join(snapshot.directory, path)) })),
    );
    const archive = join(root, 'snapshot.hqa');
    await run({ root, snapshot, entries, archive });
  });
};

test('a packed snapshot unpacks byte for byte and restores, and the archive hides its contents', async () => {
  await withArchive(async ({ root, snapshot, entries, archive }) => {
    expect(await packHqSnapshot(snapshot.directory, archive, KEY)).toStrictEqual(snapshot);
    const bytes = await readFile(archive);
    expect((await lstat(archive)).mode & 0o777).toBe(0o600);
    expect(bytes.subarray(0, 8).toString()).toBe('JGHQSNA1');
    expect(bytes.includes(Buffer.from('Keep the archive private.'))).toBe(false);
    const unpacked = await unpackHqSnapshot(archive, join(root, 'unpacked'), KEY);
    expect(unpacked).toStrictEqual({ ...snapshot, directory: join(root, 'unpacked') });
    expect(created.paths).toContain(join(root, 'unpacked'));
    for (const { path, content } of entries)
      expect(await readFile(join(root, 'unpacked', path))).toStrictEqual(content);
    const restored = await restoreHqSnapshot({
      snapshotDirectory: unpacked.directory,
      destination: join(root, 'recovery'),
    });
    expect(restored.planCount).toBe(1);
    expect((await readdir(root)).filter((name) => name.startsWith('.hq-unpack-'))).toStrictEqual(
      [],
    );
  });
});

test.each([
  ['a wrong key', (_bytes: Buffer) => null],
  ['a flipped format byte', (bytes: Buffer) => (bytes[0] ^= 1)],
  ['a flipped IV byte', (bytes: Buffer) => (bytes[10] ^= 1)],
  ['a flipped ciphertext byte', (bytes: Buffer) => (bytes[Math.floor(bytes.length / 2)] ^= 1)],
  ['a flipped tag byte', (bytes: Buffer) => (bytes[bytes.length - 1] ^= 1)],
  ['a truncated archive', (bytes: Buffer) => bytes.subarray(0, bytes.length - 1)],
  ['a header-only archive', (bytes: Buffer) => bytes.subarray(0, 36)],
])('unpacking %s is refused before its destination is created', async (label, damage) => {
  await withArchive(async ({ root, snapshot, archive }) => {
    await packHqSnapshot(snapshot.directory, archive, KEY);
    const bytes = await readFile(archive);
    const result = damage(bytes);
    await writeFile(archive, Buffer.isBuffer(result) ? result : bytes);
    const before = await readdir(root);
    created.paths.length = 0;
    await expectToRejectCode(
      unpackHqSnapshot(
        archive,
        join(root, 'unpacked'),
        label === 'a wrong key' ? Buffer.alloc(32, 8) : KEY,
      ),
      'JG_AGENT_HQ_SNAPSHOT_INVALID',
    );
    expect(created.paths).not.toContain(join(root, 'unpacked'));
    expect(await readdir(root)).toStrictEqual(before);
  });
});

test.each([
  [
    'an unlisted path',
    (entries: { path: string; content: Buffer }[]) => [
      ...entries,
      { path: '../outside', content: Buffer.from('escape') },
    ],
  ],
  [
    'an oversized entry',
    (entries: { path: string; content: Buffer }[]) =>
      entries.map((entry) =>
        entry.path === 'hq.sqlite'
          ? { ...entry, content: Buffer.concat([entry.content, Buffer.from([0])]) }
          : entry,
      ),
  ],
  ['a repeated entry', (entries: { path: string; content: Buffer }[]) => [...entries, entries[3]!]],
  [
    'a missing entry',
    (entries: { path: string; content: Buffer }[]) =>
      entries.filter((entry) => entry.path !== 'action.key'),
  ],
  [
    'a manifest that is not first',
    (entries: { path: string; content: Buffer }[]) => [
      entries[1]!,
      entries[0]!,
      ...entries.slice(2),
    ],
  ],
])('an authentic archive with %s leaves no unpacked files', async (_label, change) => {
  await withArchive(async ({ root, entries, archive }) => {
    await writeFile(archive, encodeArchive(change(entries)));
    await expectToRejectCode(
      unpackHqSnapshot(archive, join(root, 'unpacked'), KEY),
      'JG_AGENT_HQ_SNAPSHOT_INVALID',
    );
    await expect(lstat(join(root, 'unpacked'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(dirname(root), 'outside'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(root)).filter((name) => name.startsWith('.hq-unpack-'))).toStrictEqual(
      [],
    );
  });
});

test('a disk failure while decrypting is operational and leaves nothing behind', async () => {
  await withArchive(async ({ root, snapshot, archive }) => {
    await packHqSnapshot(snapshot.directory, archive, KEY);
    const before = await readdir(root);
    disk.isFull = true;
    await expectToRejectCode(
      unpackHqSnapshot(archive, join(root, 'unpacked'), KEY),
      'JG_AGENT_HQ_SNAPSHOT_FAILED',
      'The HQ snapshot operation failed: no space left on device',
    );
    expect(await readdir(root)).toStrictEqual(before);
  });
});

test('occupied targets and invalid keys are refused without touching anything', async () => {
  await withArchive(async ({ root, snapshot, archive }) => {
    await writeFile(archive, 'existing');
    await expectToRejectCode(
      packHqSnapshot(snapshot.directory, archive, KEY),
      'JG_AGENT_HQ_SNAPSHOT_INVALID',
    );
    expect(await readFile(archive, 'utf8')).toBe('existing');
    const packed = join(root, 'packed.hqa');
    for (const key of [Buffer.alloc(31), Buffer.alloc(33)])
      await expectToRejectCode(
        packHqSnapshot(snapshot.directory, packed, key),
        'JG_AGENT_HQ_SNAPSHOT_INVALID',
      );
    await expect(lstat(packed)).rejects.toMatchObject({ code: 'ENOENT' });
    await packHqSnapshot(snapshot.directory, packed, KEY);
    await mkdir(join(root, 'occupied'));
    await expectToRejectCode(
      unpackHqSnapshot(packed, join(root, 'occupied'), KEY),
      'JG_AGENT_HQ_SNAPSHOT_INVALID',
    );
    expect(await readdir(join(root, 'occupied'))).toStrictEqual([]);
  });
});
