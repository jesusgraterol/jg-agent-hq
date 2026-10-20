import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Replaces native fixture settings atomically so live readers always see complete JSON.
 * @returns Completion after the settings are installed and temporary output is removed.
 */
export const writeFixtureControl = async (
  directory: string,
  filename: 'control.json' | 'claude-control.json',
  settings: object,
): Promise<void> => {
  const temporary = join(directory, `${randomUUID()}.json`);
  try {
    await writeFile(temporary, JSON.stringify(settings));
    await rename(temporary, join(directory, filename));
  } finally {
    await rm(temporary, { force: true });
  }
};
