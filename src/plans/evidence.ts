import { constants } from 'node:fs';
import { open, lstat, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Exception, extractMessage, hasErrorCode, isException } from 'jg-exception';

import type { IPlanCheckout, IPlanWorktreeProof } from '../contracts/index.js';
import { isWithinWorkspace, resolveWorkspaceTarget } from '../runtime/state/index.js';

const run = promisify(execFile);
const excluded = new Set(['_archive', '_archives', '_backup', '_backups']);

/**
 * Captures Git identity through bounded read-only local commands without staging any files.
 * @returns The exact branch and commit identity.
 * @throws
 * - JG_AGENT_HQ_PLAN_FAILED: The HQ plan operation failed
 */
const gitIdentity = async (directory: string): Promise<{ head: string; branch: string | null }> => {
  try {
    const options = {
      cwd: directory,
      timeout: 5000,
      maxBuffer: 4096,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    };
    const head = (await run('git', ['rev-parse', '--verify', 'HEAD'], options)).stdout.trim();
    const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], options)).stdout.trim();
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head))
      throw new Exception('The HQ plan operation failed', { code: 'JG_AGENT_HQ_PLAN_FAILED' });
    return { head, branch: branch === 'HEAD' ? null : branch };
  } catch (cause) {
    throw new Exception(`The HQ plan operation failed: ${extractMessage(cause)}`, {
      code: 'JG_AGENT_HQ_PLAN_FAILED',
      data: { kind: 'operation-failed' },
      cause,
    });
  }
};

/**
 * Rejects traversal and verifies the closest existing parent before opening a selected path.
 * @returns A lexically contained target with no parent-link escape.
 * @throws
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
 */
const selectedTarget = async (root: string, path: string): Promise<string> => {
  if (
    !path ||
    isAbsolute(path) ||
    /^[a-z]:/i.test(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    path
      .split('/')
      .some(
        (part) => part === '..' || part === '.' || !part || part === '.git' || excluded.has(part),
      )
  )
    throw new Exception('The HQ plan is invalid', {
      code: 'JG_AGENT_HQ_PLAN_INVALID',
      data: { kind: 'invalid-request' },
    });
  const target = join(root, ...path.split('/'));
  const suffix = relative(root, target);
  if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`) || !suffix)
    throw new Exception('The HQ target is outside the allowed workspaces', {
      code: 'JG_AGENT_HQ_TARGET_FORBIDDEN',
      data: {
        kind: 'access-denied',
      },
    });
  let parent = dirname(target);
  while (true) {
    try {
      const canonical = await realpath(parent);
      if (!isWithinWorkspace(root, canonical))
        throw new Exception('The HQ target is outside the allowed workspaces', {
          code: 'JG_AGENT_HQ_TARGET_FORBIDDEN',
          data: {
            kind: 'access-denied',
          },
        });
      return target;
    } catch (cause) {
      if (!hasErrorCode(cause, 'ENOENT')) throw cause;
      const next = dirname(parent);
      if (next === parent) throw cause;
      parent = next;
    }
  }
};

/**
 * Streams one selected regular file, or hashes a link target without following it.
 * @returns Bounded metadata and a content digest; missing paths represent deletions.
 * @throws
 * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
 * - JG_AGENT_HQ_PLAN_FAILED: The HQ plan operation failed
 */
const fingerprintPath = async (root: string, path: string) => {
  const target = await selectedTarget(root, path);
  try {
    const details = await lstat(target);
    if (details.isSymbolicLink())
      return {
        path,
        mode: 'symlink',
        digest: createHash('sha256')
          .update(await readlink(target))
          .digest('hex'),
      };
    if (!details.isFile() || details.nlink !== 1)
      throw new Exception('The HQ plan is invalid', {
        code: 'JG_AGENT_HQ_PLAN_INVALID',
        data: { kind: 'invalid-request' },
      });
    const handle = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1)
        throw new Exception('The HQ plan is invalid', {
          code: 'JG_AGENT_HQ_PLAN_INVALID',
          data: { kind: 'invalid-request' },
        });
      const digest = createHash('sha256');
      const stream = handle.createReadStream({ autoClose: false });
      for await (const chunk of stream) {
        if (!Buffer.isBuffer(chunk))
          throw new Exception('The HQ plan is invalid', {
            code: 'JG_AGENT_HQ_PLAN_INVALID',
            data: { kind: 'invalid-request' },
          });
        digest.update(chunk);
      }
      const after = await handle.stat();
      const current = await lstat(target);
      if (
        before.dev !== details.dev ||
        before.ino !== details.ino ||
        before.dev !== current.dev ||
        before.ino !== current.ino ||
        after.nlink !== 1 ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new Exception('The HQ action conflicts with its recorded state', {
          code: 'JG_AGENT_HQ_ACTION_CONFLICT',
          data: {
            kind: 'state-conflict',
          },
        });
      return {
        path,
        mode: before.mode & 0o111 ? 'executable' : 'file',
        digest: digest.digest('hex'),
      };
    } finally {
      await handle.close();
    }
  } catch (cause) {
    if (hasErrorCode(cause, 'ENOENT')) return { path, mode: 'missing', digest: null };
    if (isException(cause)) throw cause;
    throw new Exception(`The HQ plan operation failed: ${extractMessage(cause)}`, {
      code: 'JG_AGENT_HQ_PLAN_FAILED',
      data: { kind: 'operation-failed' },
      cause,
    });
  }
};

/**
 * Captures exact task-selected checkout identities and worktree fingerprints without Git writes.
 * @returns Proof for the supplied current paths; unrelated paths are neither claimed nor changed.
 * @throws
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
 * - JG_AGENT_HQ_PLAN_FAILED: The HQ plan operation failed
 * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
 */
export const capturePlanWorktrees = async (
  checkouts: IPlanCheckout[],
  roots: string[],
): Promise<IPlanWorktreeProof[]> => {
  const result: IPlanWorktreeProof[] = [];
  for (const checkout of checkouts) {
    const directory = await resolveWorkspaceTarget(checkout.directory, roots);
    if (directory.split(/[\\/]/).some((part) => excluded.has(part)))
      throw new Exception('The HQ plan is invalid', {
        code: 'JG_AGENT_HQ_PLAN_INVALID',
        data: { kind: 'invalid-request' },
      });
    const identity = await gitIdentity(directory);
    const files = [];
    for (const path of [...checkout.paths].sort())
      files.push(await fingerprintPath(directory, path));
    const current = await gitIdentity(directory);
    if (current.head !== identity.head || current.branch !== identity.branch)
      throw new Exception('The HQ action conflicts with its recorded state', {
        code: 'JG_AGENT_HQ_ACTION_CONFLICT',
        data: {
          kind: 'state-conflict',
        },
      });
    result.push({
      ...checkout,
      directory,
      ...identity,
      fingerprint: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    });
  }
  return result;
};
