import { constants } from 'node:fs';
import { open, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomicIfUnchanged } from 'jg-fs';
import { Exception, extractMessage, hasErrorCode, isException } from 'jg-exception';

import {
  PlanCoordinationSchema,
  type IPlanTarget,
  type IPlanCoordination,
} from '../contracts/index.js';
import { resolveWorkspaceTarget } from '../runtime/state/index.js';

import {
  computeObservedPlanRevision,
  hashPlanContent,
  projectPlanMilestones,
} from './utilities.js';
import {
  observePlanConformance,
  observePlanContract,
  observeSkillsBinding,
  observeSequence,
} from './documents.js';
import type { IPlanArtifacts, IPlanContractParser } from './types.js';

const MAX_PLAN_BYTES = 1_048_576;

/**
 * Reads one bounded regular artifact without following a file symlink.
 * @returns Exact UTF-8 contents, or null only for an optional absent artifact.
 * @throws
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 * - JG_AGENT_HQ_PLAN_FAILED: The HQ plan operation failed
 */
export const readPlanFile = async (
  directory: string,
  name: string,
  isOptional = false,
  maximumBytes = MAX_PLAN_BYTES,
): Promise<string | null> => {
  let handle;
  try {
    handle = await open(
      join(directory, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const details = await handle.stat();
    if (!details.isFile() || details.nlink !== 1 || details.size > maximumBytes)
      throw new Exception('The HQ plan is invalid', {
        code: 'JG_AGENT_HQ_PLAN_INVALID',
        data: { kind: 'invalid-request' },
      });
    const bytes = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > maximumBytes)
      throw new Exception('The HQ plan is invalid', {
        code: 'JG_AGENT_HQ_PLAN_INVALID',
        data: { kind: 'invalid-request' },
      });
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, length),
    );
  } catch (error) {
    if (isOptional && hasErrorCode(error, 'ENOENT')) return null;
    if (isException(error)) throw error;
    throw new Exception(`The HQ plan operation failed: ${extractMessage(error)}`, {
      code: 'JG_AGENT_HQ_PLAN_FAILED',
      data: { kind: 'operation-failed' },
      cause: error,
    });
  } finally {
    await handle?.close();
  }
};

/**
 * Parses the one coordination contract and normalizes corrupt metadata to the existing plan error.
 * @returns Current coordination, or the empty first-use state only when the file is absent.
 * @throws
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 */
export const parsePlanCoordination = (coordinationText: string | null): IPlanCoordination => {
  try {
    return coordinationText === null
      ? {
          schemaVersion: 1 as const,
          comparisons: [],
          finalized: null,
          planApproval: null,
          sequenceApproval: null,
          execution: null,
          lastActionId: null,
          completions: [],
          correspondences: [],
          revision: null,
          baseline: null,
          observedConflict: null,
        }
      : PlanCoordinationSchema.parse(JSON.parse(coordinationText));
  } catch (cause) {
    throw new Exception('The HQ plan is invalid', {
      code: 'JG_AGENT_HQ_PLAN_INVALID',
      data: { kind: 'invalid-request' },
      cause,
    });
  }
};

/**
 * Validates bounded coordination and its exact written bytes before preparing any file mutation.
 * @returns The canonical JSON document, including its final newline.
 * @throws
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 */
export const serializePlanCoordination = (coordination: IPlanCoordination): string => {
  const parsed = PlanCoordinationSchema.safeParse(coordination);
  if (!parsed.success)
    throw new Exception('The HQ plan is invalid', {
      code: 'JG_AGENT_HQ_PLAN_INVALID',
      data: { kind: 'invalid-request' },
      cause: parsed.error,
    });
  const content = `${JSON.stringify(parsed.data, null, 2)}\n`;
  if (Buffer.byteLength(content) > 8_388_608)
    throw new Exception('The HQ plan is invalid', {
      code: 'JG_AGENT_HQ_PLAN_INVALID',
      data: { kind: 'invalid-request' },
    });
  return content;
};

/**
 * Resolves the selected live directory before acquiring document locks or reading artifacts.
 * @throws
 * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 */
export const resolvePlanDirectory = async (selected: string, roots: string[]): Promise<string> => {
  const directory = await resolveWorkspaceTarget(selected, roots);
  if (
    directory
      .split(/[\\/]/)
      .some((component) => ['_archive', '_archives', '_backup', '_backups'].includes(component)) ||
    !(await lstat(directory)).isDirectory()
  )
    throw new Exception('The HQ plan is invalid', {
      code: 'JG_AGENT_HQ_PLAN_INVALID',
      data: { kind: 'invalid-request' },
    });
  return directory;
};

/**
 * Resolves an authorized selected directory and computes current execution and inspection identity.
 * @returns Current bounded artifacts, never a recursive repository scan.
 * @throws
 * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 * - JG_AGENT_HQ_PLAN_FAILED: The HQ plan operation failed
 */
export const readPlanArtifacts = async (
  target: IPlanTarget,
  roots: string[],
  parseContract?: IPlanContractParser,
): Promise<IPlanArtifacts> => {
  const directory = await resolvePlanDirectory(target.directory, roots);
  const [plan, milestones, coordinationText] = await Promise.all([
    readPlanFile(directory, 'plan.md'),
    readPlanFile(directory, 'milestones.md', true),
    readPlanFile(directory, 'coordination.json', true, 8_388_608),
  ]);
  if (!plan)
    throw new Exception('The HQ plan is invalid', {
      code: 'JG_AGENT_HQ_PLAN_INVALID',
      data: { kind: 'invalid-request' },
    });
  const contract = observePlanContract(
    plan,
    parseContract ? await parseContract({ directory, content: plan }) : undefined,
  );
  const sequence = milestones === null ? null : observeSequence(milestones);
  const skillsBinding = observeSkillsBinding(plan, sequence);
  const coordination = parsePlanCoordination(coordinationText);
  const parsed = sequence === null ? null : projectPlanMilestones(sequence);
  return {
    directory,
    contract: { body: contract.body, metadata: contract.metadata },
    plan,
    milestones,
    coordinationText,
    skillsBinding,
    coordination,
    parsed: parsed ?? [],
    revision: computeObservedPlanRevision({ ...contract, milestones: parsed }),
    hashes: {
      plan: hashPlanContent(plan),
      milestones: milestones === null ? null : hashPlanContent(milestones),
      coordination: coordinationText === null ? null : hashPlanContent(coordinationText),
    },
    // observed, not enforced: reads and revisions continue while stage gates use the result
    conformance: observePlanConformance(plan, milestones),
  };
};

/** Flushes fixed-name creation/removal before journal completion. */
const syncPlanDirectory = async (directory: string): Promise<void> => {
  const parent = await open(directory, 'r');
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
};

/**
 * Applies a private checked replacement or exclusive creation under the caller's document locks.
 * @throws
 * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
 * - JG_AGENT_HQ_PLAN_FAILED: The HQ plan operation failed
 */
export const writePlanFile = async (
  directory: string,
  name: 'plan.md' | 'milestones.md' | 'coordination.json',
  content: string,
  expected: string | null,
): Promise<void> => {
  const path = join(directory, name);
  let owned: { dev: number; ino: number } | undefined;
  let isDurable = false;
  try {
    if (expected !== null) {
      await writeFileAtomicIfUnchanged(path, content, Buffer.from(expected), 0o600);
      return;
    }
    const file = await open(path, 'wx', 0o600);
    try {
      owned = await file.stat();
      await file.chmod(0o600);
      await file.writeFile(content);
      await file.sync();
      isDurable = true;
    } finally {
      await file.close();
    }
    await syncPlanDirectory(directory);
  } catch (cause) {
    if (owned && !isDurable) {
      try {
        const current = await lstat(path);
        if (current.dev === owned.dev && current.ino === owned.ino) {
          await unlink(path);
          await syncPlanDirectory(directory);
        }
      } catch (cleanup) {
        if (!hasErrorCode(cleanup, 'ENOENT'))
          cause = new AggregateError([cause, cleanup], 'Private plan creation cleanup failed');
      }
    }
    if (hasErrorCode(cause, 'FILE_CHANGED') || hasErrorCode(cause, 'EEXIST'))
      throw new Exception('The HQ action conflicts with its recorded state', {
        code: 'JG_AGENT_HQ_ACTION_CONFLICT',
        data: { kind: 'state-conflict' },
        cause,
      });
    throw new Exception(`The HQ plan operation failed: ${extractMessage(cause)}`, {
      code: 'JG_AGENT_HQ_PLAN_FAILED',
      data: { kind: 'operation-failed' },
      cause,
    });
  }
};

/**
 * Removes only the unchanged selected milestone artifact and flushes its parent directory.
 * @throws
 * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 * - JG_AGENT_HQ_PLAN_FAILED: The HQ plan operation failed
 */
export const removePlanMilestones = async (
  directory: string,
  expected: string | null,
): Promise<void> => {
  const current = await readPlanFile(directory, 'milestones.md', true);
  if (current !== expected)
    throw new Exception('The HQ action conflicts with its recorded state', {
      code: 'JG_AGENT_HQ_ACTION_CONFLICT',
      data: { kind: 'state-conflict' },
    });
  try {
    if (current !== null) await unlink(join(directory, 'milestones.md'));
    await syncPlanDirectory(directory);
  } catch (cause) {
    throw new Exception(`The HQ plan operation failed: ${extractMessage(cause)}`, {
      code: 'JG_AGENT_HQ_PLAN_FAILED',
      data: { kind: 'operation-failed' },
      cause,
    });
  }
};
