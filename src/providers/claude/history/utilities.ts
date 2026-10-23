import { constants, lstatSync, openSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Exception, hasErrorCode } from 'jg-exception';
import { z } from 'zod';

import type { IHistoryItem } from '../../../contracts/index.js';

import type { IRecord } from './types.js';

const EXCLUDED = new Set(['_archive', '_archives', '_backup', '_backups']);

/**
 * Resolves only the verified native project layout, without following directory links.
 * @returns The exact native project directory; no recursive discovery is used.
 * @throws
 * - JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE: The Claude history is unavailable
 */
export const projectDirectory = (workspaceRoot: string): string => {
  const root = resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'));
  if ([...root.split(sep), ...workspaceRoot.split(sep)].some((part) => EXCLUDED.has(part)))
    throw new Exception('The Claude history is unavailable', {
      code: 'JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE',
      data: {
        kind: 'agent-unavailable',
      },
    });
  // longer native project keys use another format; this reader does not guess that format
  const key = workspaceRoot.replace(/[^a-zA-Z0-9]/g, '-');
  if (key.length > 200)
    throw new Exception('The Claude history is unavailable', {
      code: 'JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE',
      data: {
        kind: 'agent-unavailable',
      },
    });
  const directory = join(root, 'projects', key);
  for (const path of [root, join(root, 'projects'), directory]) {
    const entry = lstatSync(path);
    if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(path) !== path)
      throw new Exception('The Claude history is unavailable', {
        code: 'JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE',
        data: {
          kind: 'agent-unavailable',
        },
      });
  }
  const child = relative(root, directory);
  if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`))
    throw new Exception('The Claude history is unavailable', {
      code: 'JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE',
      data: {
        kind: 'agent-unavailable',
      },
    });
  return directory;
};

/**
 * Verifies a native cwd within its selected workspace, including removed subdirectories.
 * @returns Whether existing path ancestors remain inside the workspace without excluded segments.
 */
export const isClaudeWorkspaceCwd = (cwd: string | undefined, workspaceRoot: string): boolean => {
  if (cwd === workspaceRoot) return true;
  if (
    !cwd ||
    cwd.length > 4096 ||
    !isAbsolute(cwd) ||
    resolve(cwd) !== cwd ||
    cwd.split(sep).some((part) => EXCLUDED.has(part))
  )
    return false;
  const child = relative(workspaceRoot, cwd);
  if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) return false;
  let ancestor = cwd;
  while (ancestor !== workspaceRoot) {
    try {
      const canonical = realpathSync(ancestor);
      if (canonical.split(sep).some((part) => EXCLUDED.has(part))) return false;
      const resolved = relative(workspaceRoot, canonical);
      return !isAbsolute(resolved) && resolved !== '..' && !resolved.startsWith(`..${sep}`);
    } catch (cause) {
      if (!hasErrorCode(cause, 'ENOENT') && !hasErrorCode(cause, 'ENOTDIR')) throw cause;
      ancestor = dirname(ancestor);
    }
  }
  return true;
};

/**
 * Opens only one direct native UUID transcript, refusing links and traversal.
 * @returns The descriptor, which its caller must close.
 * @throws
 * - JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE: The Claude history is unavailable
 */
export const openTranscript = (directory: string, nativeId: string): number => {
  if (!z.uuid().safeParse(nativeId).success)
    throw new Exception('The Claude history is unavailable', {
      code: 'JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE',
      data: {
        kind: 'agent-unavailable',
      },
    });
  return openSync(join(directory, `${nativeId}.jsonl`), constants.O_RDONLY | constants.O_NOFOLLOW);
};

const BlockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  content: z.unknown().optional(),
});

/**
 * Renders selected native content as bounded plain text, never as HTML.
 * @throws
 * - JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE: The Claude history is unavailable
 */
export const toClaudeItem = (record: IRecord, turnId: string): IHistoryItem => {
  if (!record.uuid)
    throw new Exception('The Claude history is unavailable', {
      code: 'JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE',
      data: {
        kind: 'agent-unavailable',
      },
    });
  if (record.type !== 'user' && record.type !== 'assistant')
    return {
      nativeId: record.uuid,
      turnId,
      nativeType: record.type,
      kind: 'unsupported',
      text: '[Unsupported native content]',
      isTruncated: false,
    };
  const content = record.message?.content;
  let text = '[Unsupported native content]';
  let isToolResult = false;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    isToolResult =
      content.length > 0 &&
      content.every(
        (block: unknown) => z.object({ type: z.literal('tool_result') }).safeParse(block).success,
      );
    text = content
      .map((block: unknown) => {
        const parsed = BlockSchema.safeParse(block);
        if (!parsed.success) return '[Unsupported native content]';
        if (parsed.data.type === 'text') return parsed.data.text ?? '';
        if (parsed.data.type === 'tool_result' && typeof parsed.data.content === 'string')
          return parsed.data.content;
        return `[Native ${parsed.data.type}]`;
      })
      .join('\n');
  }
  let end = Math.min(text.length, 65_536);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end -= 1;
  return {
    nativeId: record.uuid,
    turnId,
    nativeType: isToolResult ? 'tool-result' : record.type,
    kind: isToolResult ? 'command' : record.type === 'user' ? 'user-message' : 'agent-message',
    text: text.slice(0, end),
    isTruncated: end < text.length,
  };
};
