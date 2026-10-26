import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hasErrorCode } from 'jg-exception';

import { LOCAL_ENVIRONMENT_ID, MAX_ROOT_SKILLS, MAX_SKILL_FILE_BYTES } from './constants.js';

/**
 * Reads a skill's single-line `name` and `description` frontmatter, the only fields HQ takes from
 * skill files.
 * @returns The skill identity, or null when the frontmatter is missing or not plain single-line.
 */
export const parseSkillFrontmatter = (
  source: string,
): { name: string; description: string } | null => {
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
  return { name, description };
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
 * Lists the skills in operator-supplied roots, one directory per skill holding a regular
 * `SKILL.md`. Linked directories and files are not followed.
 * @returns The readable skills and how many entries could not be read.
 */
export const readSkillRoots = async (
  roots: string[],
): Promise<{
  skills: { name: string; description: string; path: string }[];
  unavailableCount: number;
}> => {
  const skills: { name: string; description: string; path: string }[] = [];
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
      let source: string;
      try {
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stats = await handle.stat();
          if (!stats.isFile() || stats.size > MAX_SKILL_FILE_BYTES) {
            unavailableCount += 1;
            continue;
          }
          source = await handle.readFile('utf8');
        } finally {
          await handle.close();
        }
      } catch (error) {
        // a directory without SKILL.md is not a skill
        if (!hasErrorCode(error, 'ENOENT')) unavailableCount += 1;
        continue;
      }
      const parsed = parseSkillFrontmatter(source);
      if (parsed) skills.push({ ...parsed, path });
      else unavailableCount += 1;
    }
  }
  return { skills, unavailableCount };
};
