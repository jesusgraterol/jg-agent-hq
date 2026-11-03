import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { hasErrorCode } from 'jg-exception';

import {
  LOCAL_ENVIRONMENT_ID,
  MAX_ARGUMENT_HINT_LENGTH,
  MAX_ROOT_SKILLS,
  MAX_SKILL_FILE_BYTES,
} from './constants.js';
import type { IRootSkill, ISkillFrontmatter } from './types.js';

/**
 * Reads a skill's single-line `name`, `description` and `argument-hint` frontmatter, the only
 * fields HQ takes from skill files. A hint that is missing, empty, a block scalar or over
 * MAX_ARGUMENT_HINT_LENGTH characters reads as null and never rejects the skill's identity.
 * @returns The skill's frontmatter, or null when its identity is missing or not plain single-line.
 */
export const parseSkillFrontmatter = (source: string): ISkillFrontmatter | null => {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1];
  if (block === undefined) return null;
  const read = (key: string): string | null => {
    const value = new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, 'm').exec(block)?.[1];
    if (value === undefined) return null;
    return /^(['"])(.*)\1$/.exec(value)?.[2] ?? value;
  };
  const name = read('name');
  const description = read('description');
  if (
    !name ||
    name.length > 256 ||
    !/^[^\s\p{Cc}]+$/u.test(name) ||
    description === null ||
    description.length > 8192 ||
    /^[>|]/.test(description)
  )
    return null;
  const hint = read('argument-hint');
  const argumentHint =
    !hint || hint.length > MAX_ARGUMENT_HINT_LENGTH || /^[>|]/.test(hint) ? null : hint;
  return { name, description, argumentHint };
};

/**
 * Builds the per-thread capability roots Codex resolves for a thread HQ starts, so HQ's skills
 * never reach other sessions on the shared daemon.
 * @returns One local-environment root per operator-supplied directory.
 */
export const toCapabilityRoots = (roots: string[]) =>
  roots.map((path, index) => ({
    id: `jg-agent-hq-skills-${index}`,
    location: { type: 'environment', environmentId: LOCAL_ENVIRONMENT_ID, path },
  }));

/**
 * Reads a skill file without following a link at its path: a regular file of at most
 * MAX_SKILL_FILE_BYTES. The native error of opening or reading it, such as ENOENT when nothing is
 * at the path, propagates for the caller to classify.
 * @returns The file's text, or null when it is not a regular file or is too large.
 */
const readSkillFile = async (path: string): Promise<string | null> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_SKILL_FILE_BYTES) return null;
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
};

/**
 * Reads the `argument-hint` of the skill file at an absolute path, such as one native discovery
 * lists, as `readSkillRoots` reads its files. A file that can't be read leaves the skill without
 * a hint, never without its listing.
 * @returns A promise that resolves to the hint, or null when there is none or the file can't be
 * read.
 */
export const readSkillHint = async (path: string): Promise<string | null> => {
  if (!isAbsolute(path)) return null;
  try {
    const source = await readSkillFile(path);
    return source === null ? null : (parseSkillFrontmatter(source)?.argumentHint ?? null);
  } catch {
    return null;
  }
};

/**
 * Lists the skills in operator-supplied roots, one directory per skill holding a regular
 * `SKILL.md`. Linked directories and files are not followed.
 * @returns The readable skills and how many entries could not be read.
 */
export const readSkillRoots = async (
  roots: string[],
): Promise<{ skills: IRootSkill[]; unavailableCount: number }> => {
  const skills: IRootSkill[] = [];
  let unavailableCount = 0;
  for (const root of roots) {
    let directories: string[];
    try {
      directories = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      unavailableCount += 1;
      continue;
    }
    unavailableCount += Math.max(0, directories.length - MAX_ROOT_SKILLS);
    for (const directory of directories.slice(0, MAX_ROOT_SKILLS)) {
      const path = join(root, directory, 'SKILL.md');
      let source: string | null;
      try {
        source = await readSkillFile(path);
      } catch (error) {
        // a directory without SKILL.md is not a skill
        if (!hasErrorCode(error, 'ENOENT')) unavailableCount += 1;
        continue;
      }
      const parsed = source === null ? null : parseSkillFrontmatter(source);
      if (parsed) skills.push({ ...parsed, path });
      else unavailableCount += 1;
    }
  }
  return { skills, unavailableCount };
};
