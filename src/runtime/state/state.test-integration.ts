// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectToRejectCode } from 'jg-exception/testing';
import { acquireLock, inspectLock } from 'jg-locks';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { leaveLock, stateLocks } from '../../../scripts/test-support/index.js';

import { claimRuntimeOwner, recoverSnapshotLock } from './index.js';

let stateRoot = '';
const locks = () => stateLocks(stateRoot);

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'jg-hq-owner-'));
});

afterEach(async () => {
  if (stateRoot) await rm(stateRoot, { recursive: true, force: true });
  stateRoot = '';
});

test('the runtime lock of a runtime whose process is gone is taken over once the host proves it stopped', async () => {
  const previous = await leaveLock(locks().root, 'runtime');
  const check = vi.fn(async () => true);
  const claimed = await claimRuntimeOwner(stateRoot, check);
  expect(check).toHaveBeenCalledWith({ pid: previous.pid, createdAt: previous.startedAt });
  expect(claimed.previous).toStrictEqual(previous);
  expect(await inspectLock('runtime', locks())).toMatchObject({
    state: 'held',
    owner: { pid: process.pid, nonce: claimed.epoch },
  });
  await claimed.release();
  expect((await inspectLock('runtime', locks())).state).toBe('free');
});

test.each<[string, (() => Promise<boolean>) | undefined]>([
  ['the check resolves false', async () => false],
  [
    'the check rejects',
    async () => {
      throw new Error('cgroup unreadable');
    },
  ],
  ['no check is supplied', undefined],
])('the runtime lock of a runtime whose process is gone stays when %s', async (_label, check) => {
  const previous = await leaveLock(locks().root, 'runtime');
  await expectToRejectCode(
    claimRuntimeOwner(stateRoot, check),
    'JG_AGENT_HQ_RUNTIME_ALREADY_OWNED',
    'The HQ runtime is already owned',
  );
  expect(await inspectLock('runtime', locks())).toMatchObject({
    state: 'owner-gone',
    owner: previous,
  });
});

test('a runtime lock a live process holds is never checked or taken over', async () => {
  const holder = await acquireLock('runtime', locks());
  try {
    const check = vi.fn(async () => true);
    await expectToRejectCode(
      claimRuntimeOwner(stateRoot, check),
      'JG_AGENT_HQ_RUNTIME_ALREADY_OWNED',
      'The HQ runtime is already owned',
    );
    expect(check).not.toHaveBeenCalled();
    expect((await inspectLock('runtime', locks())).owner).toStrictEqual(holder.owner);
  } finally {
    await holder.release();
  }
});

test('a runtime lock that another process takes over while the host checks stays with it', async () => {
  const previous = await leaveLock(locks().root, 'runtime');
  let replaced = previous;
  await expectToRejectCode(
    claimRuntimeOwner(stateRoot, async () => {
      replaced = await leaveLock(locks().root, 'runtime', previous);
      return true;
    }),
    'JG_AGENT_HQ_RUNTIME_ALREADY_OWNED',
    'The HQ runtime is already owned',
  );
  expect(replaced.nonce).not.toBe(previous.nonce);
  expect((await inspectLock('runtime', locks())).owner).toStrictEqual(replaced);
});

test("a snapshot lock the stopped runtime's process left is recovered, and one any other process holds or left stays", async () => {
  const left = await leaveLock(locks().root, 'snapshot');
  await recoverSnapshotLock(stateRoot, left.pid + 1);
  expect((await inspectLock('snapshot', locks())).owner).toStrictEqual(left);
  await recoverSnapshotLock(stateRoot, left.pid);
  expect((await inspectLock('snapshot', locks())).state).toBe('free');
  const live = await acquireLock('snapshot', locks());
  try {
    await recoverSnapshotLock(stateRoot, process.pid);
    expect(await inspectLock('snapshot', locks())).toMatchObject({
      state: 'held',
      owner: live.owner,
    });
  } finally {
    await live.release();
  }
});
