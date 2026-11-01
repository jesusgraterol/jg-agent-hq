import { isDeepStrictEqual } from 'node:util';

// these aggregates are never installation hooks; granular and lifecycle commands remain protected.
const DEVELOPMENT_SCRIPTS = new Set([
  'test',
  'test:full',
  'check',
  'check:full',
  'check:package',
  'check:package:full',
]);
const START = '[testing-commands:start]: #';
const END = '[testing-commands:end]: #';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Rejects invalid UTF-8 instead of normalizing it into matching replacement characters. */
const readText = (bytes: Uint8Array): string | null => {
  const buffer = Buffer.from(bytes);
  const text = buffer.toString('utf8');
  return Buffer.from(text).equals(buffer) ? text : null;
};

/** Removes only approved testing aggregates, preserving every other manifest field and script. */
const manifestWithoutDevelopmentScripts = (text: string): Record<string, unknown> | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.scripts === undefined) return parsed;
  if (
    !isRecord(parsed.scripts) ||
    Object.values(parsed.scripts).some((item) => typeof item !== 'string')
  )
    return null;
  const scripts = Object.fromEntries(
    Object.entries(parsed.scripts).filter(([name]) => !DEVELOPMENT_SCRIPTS.has(name)),
  );
  const normalized: Record<string, unknown> = { ...parsed, scripts };
  if (Object.keys(scripts).length === 0) delete normalized.scripts;
  return normalized;
};

/** Retains content outside one marked testing-command block and its optional blank separator. */
const readmeWithoutTestingCommands = (text: string): string | null => {
  let inside = false;
  let blocks = 0;
  let separator = false;
  const kept: string[] = [];
  for (const line of text.split(/(?<=\n)/u)) {
    const content = line.replace(/\r?\n$/u, '');
    if (content === START) {
      if (inside || blocks !== 0) return null;
      inside = true;
      blocks++;
    } else if (content === END) {
      if (!inside) return null;
      inside = false;
      separator = true;
    } else if (!inside) {
      if (separator && content === '') {
        separator = false;
        continue;
      }
      separator = false;
      kept.push(line);
    }
  }
  return inside ? null : kept.join('');
};

/**
 * Allows only development aggregates and explicitly marked testing-command documentation to differ.
 * Invalid metadata fails closed; all other manifest fields and README text stay protected.
 * @returns Whether both files have the same protected contents.
 */
export const sameDevelopmentMetadata = (
  path: 'package.json' | 'README.md',
  left: Uint8Array,
  right: Uint8Array,
): boolean => {
  const leftText = readText(left),
    rightText = readText(right);
  if (leftText === null || rightText === null) return false;
  if (path === 'package.json') {
    const leftManifest = manifestWithoutDevelopmentScripts(leftText);
    const rightManifest = manifestWithoutDevelopmentScripts(rightText);
    return (
      leftManifest !== null &&
      rightManifest !== null &&
      isDeepStrictEqual(leftManifest, rightManifest)
    );
  }
  const leftReadme = readmeWithoutTestingCommands(leftText);
  const rightReadme = readmeWithoutTestingCommands(rightText);
  return leftReadme !== null && rightReadme !== null && leftReadme === rightReadme;
};
