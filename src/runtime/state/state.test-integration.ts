// @vitest-environment node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectToRejectCode } from 'jg-exception/testing';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { removeStaleHqLock } from '../../locks/index.js';

import { claimRuntimeOwner } from './index.js';

let stateRoot = '';
const ownerPath = () => join(stateRoot, 'hq-owner.json');

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'jg-hq-owner-'));
});

afterEach(async () => {
  if (stateRoot) await rm(stateRoot, { recursive: true, force: true });
  stateRoot = '';
});

// the PID of a process that has just exited, which no process holds now
const stoppedPid = async (): Promise<number> => {
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');
  return child.pid!;
};
const ownerRecord = (pid: number, command = 'serve') =>
  `${JSON.stringify({ pid, nonce: randomUUID(), command, createdAt: new Date().toISOString() })}\n`;
const writeOwner = async (pid: number): Promise<string> => {
  const content = ownerRecord(pid);
  await writeFile(ownerPath(), content, { mode: 0o600 });
  return content;
};

test('the owner record of a runtime whose process is gone is replaced once the host proves it stopped', async () => {
  const pid = await stoppedPid();
  const content = await writeOwner(pid);
  const check = vi.fn(async () => true);
  const claimed = await claimRuntimeOwner(stateRoot, check);
  expect(check).toHaveBeenCalledWith({ pid, createdAt: JSON.parse(content).createdAt });
  expect(claimed.isReclaimed).toBe(true);
  expect(JSON.parse(await readFile(ownerPath(), 'utf8'))).toMatchObject({
    pid: process.pid,
    nonce: claimed.owner.nonce,
  });
  await claimed.release();
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
])('the owner record of a runtime whose process is gone stays when %s', async (_label, check) => {
  const content = await writeOwner(await stoppedPid());
  await expectToRejectCode(
    claimRuntimeOwner(stateRoot, check),
    'JG_AGENT_HQ_RUNTIME_ALREADY_OWNED',
    'The HQ runtime is already owned',
  );
  expect(await readFile(ownerPath(), 'utf8')).toBe(content);
});

test('the owner record of a process that exists is never checked or replaced', async () => {
  const content = await writeOwner(process.pid);
  const check = vi.fn(async () => true);
  await expectToRejectCode(
    claimRuntimeOwner(stateRoot, check),
    'JG_AGENT_HQ_RUNTIME_ALREADY_OWNED',
    'The HQ runtime is already owned',
  );
  expect(check).not.toHaveBeenCalled();
  expect(await readFile(ownerPath(), 'utf8')).toBe(content);
});

test('an owner record that changes while the host checks it stays', async () => {
  await writeOwner(await stoppedPid());
  let replaced = '';
  await expectToRejectCode(
    claimRuntimeOwner(stateRoot, async () => {
      replaced = await writeOwner(await stoppedPid());
      return true;
    }),
    'JG_AGENT_HQ_RUNTIME_ALREADY_OWNED',
    'The HQ runtime is already owned',
  );
  expect(await readFile(ownerPath(), 'utf8')).toBe(replaced);
});

test('a state-root lock whose holder is gone is removed, and one whose holder exists stays', async () => {
  await mkdir(join(stateRoot, '.runtime'), { mode: 0o700 });
  const lockPath = join(stateRoot, '.runtime', 'hq.lock');
  await writeFile(lockPath, ownerRecord(await stoppedPid(), 'snapshot'), { mode: 0o600 });
  expect(await removeStaleHqLock(stateRoot)).toBe(true);
  await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  const live = ownerRecord(process.pid, 'snapshot');
  await writeFile(lockPath, live, { mode: 0o600 });
  expect(await removeStaleHqLock(stateRoot)).toBe(false);
  expect(await readFile(lockPath, 'utf8')).toBe(live);
});
