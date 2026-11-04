import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { inspectLock, type ILockOwner } from 'jg-locks';

const run = promisify(execFile);

/**
 * Names the private jg-locks folder of a state root, where HQ takes its locks.
 * @param stateRoot The state root.
 * @returns jg-locks' root option for that folder.
 */
export const stateLocks = (stateRoot: string): { root: string } => ({
  root: join(stateRoot, '.runtime', 'locks'),
});

/**
 * Takes a lock in a child process that exits without releasing it, as a crashed holder does.
 * @param root The locks folder.
 * @param name The lock's name.
 * @param recoverFrom The dead owner the child takes the lock over from, if any.
 * @returns A promise that resolves to the dead owner the lock now names.
 */
export const leaveLock = async (
  root: string,
  name: string,
  recoverFrom?: ILockOwner,
): Promise<ILockOwner> => {
  await run(process.execPath, [
    '--input-type=module',
    '-e',
    `const { acquireLock } = await import(${JSON.stringify(import.meta.resolve('jg-locks'))});
await acquireLock(process.argv[1], JSON.parse(process.argv[2]));`,
    name,
    JSON.stringify({ root, ...(recoverFrom ? { recoverFrom } : {}) }),
  ]);
  const { state, owner } = await inspectLock(name, { root });
  if (state !== 'owner-gone' || !owner) throw new Error(`The lock ${name} was not left behind`);
  return owner;
};
