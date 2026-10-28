import { constants, lstatSync, openSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Exception, hasErrorCode } from 'jg-exception';
import { z } from 'zod';

import { MAX_ITEM_TEXT_LENGTH, type IHistoryItem } from '../../../contracts/index.js';
import { countLines } from '../../../sessions/index.js';
import { nativeProvenance } from '../../../sessions/evidence/index.js';

import { FilePatchSchema, type IFilePatch, type IRecord } from './types.js';

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
  id: z.string().min(1).max(4096).optional(),
  text: z.string().optional(),
  content: z.unknown().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  tool_use_id: z.string().min(1).max(4096).optional(),
  is_error: z.boolean().optional(),
});
type IBlock = z.infer<typeof BlockSchema>;
type IPresentation = Pick<
  IHistoryItem,
  'nativeType' | 'kind' | 'text' | 'callId' | 'outcome' | 'files'
>;

const UNSUPPORTED = '[Unsupported native content]';
// the wrappers Claude Code writes around what it shows outside a model message
const LOCAL_OUTPUT = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/;
const SHELL_INPUT = /^<bash-input>([\s\S]*)<\/bash-input>$/;
const SHELL_OUTPUT = /^<bash-stdout>([\s\S]*)<\/bash-stdout><bash-stderr>([\s\S]*)<\/bash-stderr>$/;
const COMMAND = /^<command-(?:message|name)>/;
const COMMAND_NAME = /<command-name>\/?([^<]*)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const PERSISTED_OUTPUT =
  /^<persisted-output>\nOutput too large \(([^)\n]{1,64})\)\. Full output saved to: [^\n]*\n\nPreview \([^)\n]*\):\n([\s\S]*?)\n?<\/persisted-output>([\s\S]*)$/;

/** Shows a result saved to a file as its size and preview, without the file's path. */
const toResultText = (block: IBlock): string => {
  if (typeof block.content !== 'string') return `[Native ${block.type}]`;
  const persisted = PERSISTED_OUTPUT.exec(block.content);
  return persisted
    ? `Output too large (${persisted[1]}), saved to a file\n${persisted[2]}${persisted[3]}`
    : block.content;
};

/** Reads an Edit or Write result's file, counting every line of a created file as added. */
const toFileChange = (patch: IFilePatch): Pick<IPresentation, 'text' | 'files'> => {
  if (patch.type === 'create' && patch.content !== undefined)
    return {
      text: `${patch.filePath}\n${patch.content}`,
      files: [{ path: patch.filePath, added: countLines(patch.content), removed: 0 }],
    };
  const lines = patch.structuredPatch.flatMap((hunk) => [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...hunk.lines,
  ]);
  return {
    text: [patch.filePath, ...lines].join('\n'),
    files: [
      {
        path: patch.filePath,
        added: lines.filter((line) => line.startsWith('+')).length,
        removed: lines.filter((line) => line.startsWith('-')).length,
      },
    ],
  };
};

/**
 * Presents an operator-side text record; a task notification, which the CLI doesn't show, is
 * dropped, and a `!` shell output takes its input's UUID as its call.
 */
const toUserPresentation = (record: IRecord, text: string): IPresentation | null => {
  const base = { nativeType: record.type, callId: null, outcome: null, files: [] };
  if (text.startsWith('<task-notification>')) return null;
  const local = LOCAL_OUTPUT.exec(text);
  if (local) return { ...base, kind: 'notice', text: local[1]! };
  if (text.startsWith('[Request interrupted by user')) return { ...base, kind: 'notice', text };
  const input = SHELL_INPUT.exec(text);
  if (input) return { ...base, kind: 'command', text: input[1]!.trim(), callId: record.uuid! };
  const output = SHELL_OUTPUT.exec(text);
  if (output)
    return {
      ...base,
      kind: 'command',
      text: [output[1], output[2]].filter(Boolean).join('\n'),
      callId: record.parentUuid ?? null,
    };
  const name = COMMAND.test(text) ? COMMAND_NAME.exec(text)?.[1] : undefined;
  if (name) {
    const args = COMMAND_ARGS.exec(text)?.[1]?.trim();
    return { ...base, kind: 'user-message', text: args ? `/${name} ${args}` : `/${name}` };
  }
  return { ...base, kind: 'user-message', text };
};

/** Presents a native record as the CLI shows it, or null for one it leaves out. */
const toPresentation = (record: IRecord): IPresentation | null => {
  const base = { nativeType: record.type, callId: null, outcome: null, files: [] };
  if (record.type !== 'user' && record.type !== 'assistant')
    return { ...base, kind: 'unsupported', text: UNSUPPORTED };
  const message = record.type === 'user' ? 'user-message' : 'agent-message';
  const content = record.message?.content;
  if (typeof content !== 'string' && !Array.isArray(content))
    return { ...base, kind: 'unsupported', text: UNSUPPORTED };
  // the model's thinking stays collapsed in the CLI, so a record holding only thinking is dropped
  const blocks =
    typeof content === 'string'
      ? []
      : content
          .map((block: unknown) => BlockSchema.safeParse(block).data)
          .filter((block) => block?.type !== 'thinking' && block?.type !== 'redacted_thinking');
  if (Array.isArray(content) && blocks.length === 0) return null;
  const text =
    typeof content === 'string'
      ? content
      : blocks.every((block) => block?.type === 'text')
        ? blocks.map((block) => block!.text ?? '').join('\n')
        : undefined;
  if (record.isCompactSummary) return { ...base, kind: 'notice', text: text ?? UNSUPPORTED };
  if (text !== undefined)
    return record.type === 'user'
      ? toUserPresentation(record, text)
      : { ...base, kind: 'agent-message', text };
  if (blocks.every((block) => block?.type === 'tool_result')) {
    const patch = FilePatchSchema.safeParse(record.toolUseResult);
    return {
      nativeType: 'tool-result',
      kind: patch.success ? 'file-change' : 'tool',
      ...(patch.success
        ? toFileChange(patch.data)
        : { text: blocks.map((block) => toResultText(block!)).join('\n'), files: [] }),
      callId: blocks.length === 1 ? (blocks[0]!.tool_use_id ?? null) : null,
      outcome: blocks.some((block) => block!.is_error) ? 'failed' : 'succeeded',
    };
  }
  const calls = blocks.filter((block) => block?.type === 'tool_use' && block.name);
  return {
    ...base,
    kind: calls.length > 0 ? 'tool' : message,
    text: blocks
      .map((block) => {
        if (!block) return UNSUPPORTED;
        if (block.type === 'tool_use' && block.name)
          return `${block.name}\n${JSON.stringify(block.input ?? {})}`;
        if (block.type === 'text') return block.text ?? '';
        return `[Native ${block.type}]`;
      })
      .join('\n'),
    // a record calling several tools can't pair each result with its call
    callId: calls.length === 1 ? (calls[0]!.id ?? null) : null,
  };
};

/**
 * Presents one native record as the CLI shows it, shared by history pages, live items and
 * evidence. Outcome and files come from the full record, before the text is cut.
 * @returns The item, or null for a record the CLI leaves out, such as thinking or a task notification.
 * @throws
 * - JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE: The Claude history is unavailable
 */
export const toClaudeItem = (
  record: IRecord,
  turnId: string,
  fullBody = false,
): IHistoryItem | null => {
  if (!record.uuid)
    throw new Exception('The Claude history is unavailable', {
      code: 'JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE',
      data: {
        kind: 'agent-unavailable',
      },
    });
  const presentation = toPresentation(record);
  if (!presentation) return null;
  const { text } = presentation;
  let end = fullBody ? text.length : Math.min(text.length, MAX_ITEM_TEXT_LENGTH);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end -= 1;
  return {
    ...presentation,
    nativeId: record.uuid,
    turnId,
    provenance: nativeProvenance(
      presentation.kind,
      presentation.kind === 'user-message' ? record.uuid : null,
    ),
    text: text.slice(0, end),
    isTruncated: end < text.length,
  };
};
