import { constants } from 'node:fs';
import { open, lstat, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Exception, extractMessage, hasErrorCode } from 'error-message-utils';

import { PlanCoordinationSchema, type IPlanTarget } from '../contracts/index.js';
import { resolveWorkspaceTarget } from '../runtime/state/index.js';

import { computePlanRevision, hashPlanContent, parsePlanMilestones } from './utilities.js';
import type { IPlanArtifacts } from './types.js';

const MAX_PLAN_BYTES = 1_048_576;

/**
 * Reads one bounded regular artifact without following a file symlink.
 * @returns Exact UTF-8 contents, or null only for an optional absent artifact.
 * @throws
 * - -1: The HQ plan is invalid
 * - -1: The HQ plan operation failed
 */
export const readPlanFile = async (
  directory: string,
  name: string,
  isOptional = false,
): Promise<string | null> => {
  let handle;
  try {
    handle = await open(
      join(directory, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const details = await handle.stat();
    if (!details.isFile() || details.nlink !== 1 || details.size > MAX_PLAN_BYTES)
      throw new Exception('The HQ plan is invalid', undefined, { kind: 'invalid-request' });
    const bytes = Buffer.alloc(MAX_PLAN_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > MAX_PLAN_BYTES)
      throw new Exception('The HQ plan is invalid', undefined, { kind: 'invalid-request' });
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, length),
    );
  } catch (error) {
    if (isOptional && hasErrorCode(error, 'ENOENT')) return null;
    if (error instanceof Exception) throw error;
    throw new Exception(
      `The HQ plan operation failed: ${extractMessage(error)}`,
      undefined,
      { kind: 'operation-failed' },
      { cause: error },
    );
  } finally {
    await handle?.close();
  }
};

/**
 * Resolves an authorized selected directory and computes current execution and inspection identity.
 * @returns Current bounded artifacts, never a recursive repository scan.
 * @throws
 * - -1: The HQ target is outside the allowed workspaces
 * - -1: The HQ plan is invalid
 * - -1: The HQ plan operation failed
 */
export const readPlanArtifacts = async (
  target: IPlanTarget,
  roots: string[],
): Promise<IPlanArtifacts> => {
  const directory = await resolveWorkspaceTarget(target.directory, roots);
  if (
    directory
      .split(/[\\/]/)
      .some((component) => ['_archive', '_archives', '_backup', '_backups'].includes(component)) ||
    !(await lstat(directory)).isDirectory()
  )
    throw new Exception('The HQ plan is invalid', undefined, { kind: 'invalid-request' });
  const [plan, milestones, coordinationText] = await Promise.all([
    readPlanFile(directory, 'plan.md'),
    readPlanFile(directory, 'milestones.md', true),
    readPlanFile(directory, 'coordination.json', true),
  ]);
  if (!plan) throw new Exception('The HQ plan is invalid', undefined, { kind: 'invalid-request' });
  const bodyStart = target.context?.bodyStart ?? 0;
  // the private caller parses YAML; this core verifies exactly the excluded framing boundary
  if (bodyStart !== 0) {
    const boundary = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(plan);
    if (!boundary || boundary[0].length !== bodyStart)
      throw new Exception('The HQ plan is invalid', undefined, { kind: 'invalid-request' });
  }
  let coordination;
  try {
    coordination =
      coordinationText === null
        ? {
            schemaVersion: 1 as const,
            finalized: null,
            planApproval: null,
            sequenceApproval: null,
            execution: null,
            lastActionId: null,
          }
        : PlanCoordinationSchema.parse(JSON.parse(coordinationText));
  } catch (cause) {
    throw new Exception(
      'The HQ plan is invalid',
      undefined,
      { kind: 'invalid-request' },
      { cause },
    );
  }
  const metadata = target.context?.metadata ?? {
    scope: 'local',
    repositories: [],
    errorReservations: [],
  };
  return {
    directory,
    plan,
    milestones,
    coordinationText,
    coordination,
    parsed: milestones === null ? [] : parsePlanMilestones(milestones),
    revision: computePlanRevision({ body: plan.slice(bodyStart), metadata, milestones }),
    hashes: {
      plan: hashPlanContent(plan),
      milestones: milestones === null ? null : hashPlanContent(milestones),
      coordination: coordinationText === null ? null : hashPlanContent(coordinationText),
    },
  };
};

/**
 * Atomically replaces a selected artifact after syncing its task-owned temporary file.
 * @returns A promise resolved after the containing directory is synced.
 * @throws
 * - -1: The HQ plan operation failed
 */
export const writePlanFile = async (
  directory: string,
  name: string,
  content: string,
): Promise<void> => {
  const path = join(directory, `.hq-${randomUUID()}.tmp`);
  let hasTemporaryFile = false;
  try {
    const file = await open(path, 'wx', 0o600);
    hasTemporaryFile = true;
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(path, join(directory, name));
    hasTemporaryFile = false;
    const parent = await open(directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } catch (cause) {
    throw new Exception(
      `The HQ plan operation failed: ${extractMessage(cause)}`,
      undefined,
      { kind: 'operation-failed' },
      { cause },
    );
  } finally {
    try {
      if (hasTemporaryFile) await rm(path, { force: true });
    } catch (cause) {
      throw new Exception(
        `The HQ plan operation failed: ${extractMessage(cause)}`,
        undefined,
        { kind: 'operation-failed' },
        { cause },
      );
    }
  }
};
