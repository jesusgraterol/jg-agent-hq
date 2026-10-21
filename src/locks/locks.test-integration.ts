// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectToRejectCode } from 'jg-exception/testing';
import { hasErrorCode } from 'jg-exception';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { acquireHqLock, readHqLockState, releaseHqLock, withHqLock } from 'jg-agent-hq';

let root = '';
const children: { child: ChildProcess; closed: Promise<unknown> }[] = [];
const lockPath = (): string => join(root, '.runtime', 'hq.lock');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jg-hq-lock-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  const stopped = await Promise.allSettled(
    children.splice(0).map(async ({ child, closed }) => {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch (error) {
          if (!hasErrorCode(error, 'ESRCH')) throw error;
        }
      }
      await closed;
    }),
  );
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
  for (const result of stopped) if (result.status === 'rejected') throw result.reason;
});

const writeOwner = async (pid: number, nonce = randomUUID()): Promise<string> => {
  await mkdir(join(root, '.runtime'), { recursive: true, mode: 0o700 });
  const content = JSON.stringify({
    pid,
    nonce,
    command: 'test',
    createdAt: new Date().toISOString(),
  });
  await writeFile(lockPath(), content, { mode: 0o600 });
  return content;
};

// a real process holds the built package lock until explicitly released over IPC
const startHolder = () => {
  const source = `
    const { acquireHqLock } = await import(${JSON.stringify(import.meta.resolve('jg-agent-hq'))});
    const requested = new Promise((resolve) => process.once('message', resolve));
    const release = await acquireHqLock(${JSON.stringify(root)}, 'holder');
    process.send({ type: 'acquired' });
    await requested;
    await release();
    process.disconnect();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const closed = once(child, 'close');
  children.push({ child, closed });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-16_384);
  });
  const waiting = new AbortController();
  child.once('close', () => waiting.abort());
  const ready = once(child, 'message', {
    signal: AbortSignal.any([waiting.signal, AbortSignal.timeout(10_000)]),
  });
  // teardown may close a child before a failed test reaches its readiness await
  void ready.catch(() => undefined);
  return { child, closed, ready, stderr: () => stderr };
};

describe('acquisition and exact release', () => {
  test.each([
    ['', {}],
    ['   ', {}],
    ['line\nbreak', {}],
    ['index', { pollIntervalMs: 0 }],
    ['index', { waitTimeoutMs: Number.NaN }],
    ['index', { setupWindowMs: -1 }],
  ])('invalid acquisition arguments (%s, %o) leave no lock', async (command, options) => {
    await expectToRejectCode(
      acquireHqLock(root, command, options),
      'JG_AGENT_HQ_LOCK_INVALID_ARGUMENTS',
      'The HQ lock acquisition arguments are invalid',
    );
    expect(await readHqLockState(root)).toStrictEqual({ kind: 'free' });
  });

  test('creates private metadata and releases idempotently without deleting a new owner', async () => {
    const release = await acquireHqLock(root, 'index');
    expect((await stat(join(root, '.runtime'))).mode & 0o777).toBe(0o700);
    expect((await stat(lockPath())).mode & 0o777).toBe(0o600);
    expect(await readHqLockState(root)).toMatchObject({
      kind: 'held',
      owner: { pid: process.pid, command: 'index' },
      liveness: 'alive',
    });
    await release();
    const next = await acquireHqLock(root, 'next');
    const content = await readFile(lockPath(), 'utf8');
    await release();
    expect(await readFile(lockPath(), 'utf8')).toBe(content);
    await next();
    expect(await readHqLockState(root)).toStrictEqual({ kind: 'free' });
  });

  test('does not delete a replacement owner', async () => {
    const release = await acquireHqLock(root, 'index');
    const replacement = await writeOwner(process.pid);
    await expectToRejectCode(
      release(),
      'JG_AGENT_HQ_LOCK_OWNERSHIP_CHANGED',
      'HQ lock ownership changed before release',
    );
    expect(await readFile(lockPath(), 'utf8')).toBe(replacement);
  });

  test('releases when the protected operation fails and preserves its error', async () => {
    const failure = new Error('operation failed');
    await expect(
      withHqLock(root, 'index', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await readHqLockState(root)).toStrictEqual({ kind: 'free' });
  });
});

describe('contention and recovery', () => {
  test('an operation failure stays primary when its lock was replaced', async () => {
    const failure = new Error('operation failed');
    const reported = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let replacement = '';
    await expect(
      withHqLock(root, 'index', async () => {
        replacement = await writeOwner(process.pid);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await readFile(lockPath(), 'utf8')).toBe(replacement);
    expect(reported).toHaveBeenCalledWith('HQ lock ownership changed before release\n');
  });

  test('an unverifiable live owner is preserved rather than reclaimed', async () => {
    const content = await writeOwner(process.pid);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    });
    await expectToRejectCode(
      acquireHqLock(root, 'index'),
      'JG_AGENT_HQ_LOCK_OWNER_UNVERIFIABLE',
      'The HQ lock owner could not be verified',
    );
    expect(await readFile(lockPath(), 'utf8')).toBe(content);
    expect(await readHqLockState(root)).toMatchObject({ kind: 'held', liveness: 'unknown' });
  });

  test('a second process waits for the first owner before acquiring', async () => {
    const first = startHolder();
    expect((await first.ready)[0]).toStrictEqual({ type: 'acquired' });
    const second = startHolder();
    await expect.poll(second.stderr).toContain('Waiting for the HQ lock');
    first.child.send({ type: 'release' });
    expect((await second.ready)[0]).toStrictEqual({ type: 'acquired' });
    expect(await readHqLockState(root)).toMatchObject({
      kind: 'held',
      owner: { pid: second.child.pid },
    });
    second.child.send({ type: 'release' });
    await Promise.all([first.closed, second.closed]);
    expect(await readHqLockState(root)).toStrictEqual({ kind: 'free' });
  });

  test('a live owner times out without losing its lock', async () => {
    await writeOwner(process.pid);
    await expectToRejectCode(
      acquireHqLock(root, 'wait', { waitTimeoutMs: 300, pollIntervalMs: 50 }),
      'JG_AGENT_HQ_LOCK_TIMEOUT',
      'Timed out waiting for the HQ lock',
    );
    expect((await readHqLockState(root)).kind).toBe('held');
  });

  test('a dead process is refused and left for explicit recovery', async () => {
    const child = spawn(process.execPath, ['-e', '']);
    await once(child, 'close');
    if (!child.pid) throw new Error('test process did not start');
    const content = await writeOwner(child.pid);
    await expectToRejectCode(
      acquireHqLock(root, 'index'),
      'JG_AGENT_HQ_LOCK_OWNER_INACTIVE',
      'The HQ lock has an inactive owner',
    );
    expect(await readFile(lockPath(), 'utf8')).toBe(content);
    expect(await readHqLockState(root)).toMatchObject({ kind: 'held', liveness: 'dead' });
  });

  test('manual recovery rejects the wrong nonce and accepts the inspected nonce without a PID test', async () => {
    const nonce = randomUUID();
    const content = await writeOwner(process.pid, nonce);
    await expectToRejectCode(
      releaseHqLock(root, randomUUID()),
      'JG_AGENT_HQ_LOCK_NONCE_MISMATCH',
      'The HQ lock nonce does not match',
    );
    expect(await readFile(lockPath(), 'utf8')).toBe(content);
    expect(await releaseHqLock(root, nonce)).toMatchObject({ pid: process.pid, nonce });
    expect(await readHqLockState(root)).toStrictEqual({ kind: 'free' });
    await expectToRejectCode(
      releaseHqLock(root, nonce),
      'JG_AGENT_HQ_LOCK_NOT_HELD',
      'The HQ lock is not held',
    );
  });

  test('an incomplete owner times out without automatic reclamation', async () => {
    await mkdir(join(root, '.runtime'), { mode: 0o700 });
    await writeFile(lockPath(), '', { mode: 0o600 });
    await expect(
      acquireHqLock(root, 'index', { setupWindowMs: 200, pollIntervalMs: 50 }),
    ).rejects.toThrow('The HQ lock owner is incomplete');
    expect(await readFile(lockPath(), 'utf8')).toBe('');
  });
});

describe('untrusted metadata', () => {
  test('invalid and oversized owner files are refused without removal', async () => {
    await mkdir(join(root, '.runtime'), { mode: 0o700 });
    await writeFile(lockPath(), 'invalid', { mode: 0o600 });
    await expect(acquireHqLock(root, 'index')).rejects.toThrow(
      'The HQ lock owner could not be read',
    );
    await writeFile(lockPath(), 'x'.repeat(1_048_576));
    await expectToRejectCode(
      acquireHqLock(root, 'index'),
      'JG_AGENT_HQ_LOCK_OWNER_OVERSIZED',
      'The HQ lock owner exceeds the supported size',
    );
    expect((await stat(lockPath())).size).toBe(1_048_576);
    expect((await readHqLockState(root)).kind).toBe('unreadable');
  });

  test('an oversized operation label cannot create an unreadable lock', async () => {
    await expectToRejectCode(
      acquireHqLock(root, 'x'.repeat(16_384)),
      'JG_AGENT_HQ_LOCK_OWNER_OVERSIZED',
      'The HQ lock owner exceeds the supported size',
    );
    expect(await readHqLockState(root)).toStrictEqual({ kind: 'free' });
  });

  test('refuses permissive runtime or lock permissions', async () => {
    await writeOwner(process.pid);
    await chmod(join(root, '.runtime'), 0o755);
    await expect(acquireHqLock(root, 'index')).rejects.toThrow(
      'The HQ runtime directory must be private',
    );
    await chmod(join(root, '.runtime'), 0o700);
    await chmod(lockPath(), 0o644);
    await expect(acquireHqLock(root, 'index')).rejects.toThrow('The HQ lock must be private');
  });

  test('never follows runtime or lock symlinks', async () => {
    const outside = join(root, 'outside');
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(root, '.runtime'));
    await expectToRejectCode(
      acquireHqLock(root, 'index'),
      'JG_AGENT_HQ_RUNTIME_DIRECTORY_INVALID',
      'The HQ runtime directory must be a real directory',
    );
    expect((await readHqLockState(root)).kind).toBe('unreadable');
    await rm(join(root, '.runtime'));
    await mkdir(join(root, '.runtime'), { mode: 0o700 });
    const target = join(outside, 'owner');
    await writeFile(target, 'preserve');
    await symlink(target, lockPath());
    await expectToRejectCode(
      acquireHqLock(root, 'index'),
      'JG_AGENT_HQ_LOCK_FILE_INVALID',
      'The HQ lock must be a regular file',
    );
    expect(await readFile(target, 'utf8')).toBe('preserve');
  });
});
