import { constants, lstatSync, openSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Exception, hasErrorCode } from 'jg-exception';
import { z } from 'zod';

import {
  MAX_ITEM_IMAGES,
  MAX_ITEM_TEXT_LENGTH,
  type IHistoryItem,
  type IItemDetail,
} from '../../../contracts/index.js';
import {
  countLines,
  describeBase64Image,
  keepTextEnd,
  toWholeFileDiff,
} from '../../../sessions/index.js';
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
  source: z.unknown().optional(),
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

// an edit's hunks as unified diff lines
const toPatchLines = (patch: IFilePatch): string[] =>
  patch.structuredPatch.flatMap((hunk) => [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...hunk.lines,
  ]);

/** Reads an Edit or Write result's file, counting every line of a created file as added. */
const toFileChange = (patch: IFilePatch): Pick<IPresentation, 'text' | 'files'> => {
  if (patch.type === 'create' && patch.content !== undefined)
    return {
      text: `${patch.filePath}\n${patch.content}`,
      files: [{ path: patch.filePath, added: countLines(patch.content), removed: 0 }],
    };
  const lines = toPatchLines(patch);
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
 * evidence. Outcome and files come from the full record, before the text is cut, and its time
 * from the record's `timestamp`.
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
  const createdAt = Date.parse(record.timestamp ?? '');
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
    createdAt: Number.isFinite(createdAt) ? createdAt : null,
  };
};

// a record's content blocks, without the ones that don't parse
const toBlocks = (record: IRecord): IBlock[] => {
  const content = record.message?.content;
  return Array.isArray(content)
    ? content.flatMap((block: unknown) => BlockSchema.safeParse(block).data ?? [])
    : [];
};
// a record's text, when it holds text alone
const toText = (record: IRecord): string | undefined => {
  const content = record.message?.content;
  if (typeof content === 'string') return content;
  const blocks = toBlocks(record);
  return Array.isArray(content) &&
    blocks.length > 0 &&
    blocks.every((block) => block.type === 'text')
    ? blocks.map((block) => block.text ?? '').join('\n')
    : undefined;
};
// the result Claude Code records on a Bash call
const ShellResultSchema = z.object({ stdout: z.string(), stderr: z.string() });
const Base64SourceSchema = z.object({ type: z.literal('base64'), data: z.string() });
const MCP_TOOL = /^mcp__(.+?)__(.+)$/;

/** Presents a command with its output, keeping the output's end; Claude records no exit code. */
const toCommandDetail = (command: string | null, output: string | null): IItemDetail['command'] => {
  const kept = output === null ? null : keepTextEnd(output);
  return {
    command,
    output: kept?.text ?? null,
    isOutputStartCut: kept?.isStartCut ?? false,
    exitCode: null,
    durationMs: null,
  };
};

/** Presents a tool call or result, an MCP tool's name split into its server and tool. */
const toToolDetail = (
  name: string | null,
  input: string | null,
  result: string | null,
): IItemDetail['tool'] => {
  const mcp = name === null ? null : MCP_TOOL.exec(name);
  const kept = result === null ? null : keepTextEnd(result);
  return {
    server: mcp ? mcp[1]! : null,
    name: mcp ? mcp[2]! : name,
    input,
    result: kept?.text ?? null,
    isResultStartCut: kept?.isStartCut ?? false,
  };
};

// a tool result's text: its string content, or the text of its content blocks
const toResultBody = (block: IBlock): string =>
  Array.isArray(block.content)
    ? block.content
        .flatMap((part: unknown) => BlockSchema.safeParse(part).data ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n')
    : toResultText(block);

// a Bash call's command
const toShellCommand = (input: unknown): string | null =>
  z.object({ command: z.string() }).safeParse(input).data?.command ?? null;

/**
 * Lists the images a record holds, in its message and in its tool results' content, in order.
 * @param record The record.
 * @returns At most 64 images, each its base64 data, or null for one that has no base64 source.
 */
export const toClaudeImageData = (record: IRecord): (string | null)[] =>
  toBlocks(record)
    .flatMap((block) =>
      block.type === 'tool_result' && Array.isArray(block.content)
        ? block.content.flatMap((part: unknown) => BlockSchema.safeParse(part).data ?? [])
        : [block],
    )
    .filter((block) => block.type === 'image')
    .slice(0, MAX_ITEM_IMAGES)
    .map((block) => Base64SourceSchema.safeParse(block.source).data?.data ?? null);

// describes each image a record holds, by its index
const toImages = (record: IRecord): IItemDetail['images'] =>
  toClaudeImageData(record).map((data, index) => ({
    index,
    ...(data === null ? { mediaType: null, byteCount: null } : describeBase64Image(data)),
  }));

/**
 * Tells whether an item answers an earlier record of its turn: a tool result its call, or a `!`
 * shell output the input it follows.
 * @param record The item's record.
 * @param item The item, as history presents it.
 * @returns Whether the item has a call to pair it with.
 */
export const isClaudeAnswer = (record: IRecord, item: IHistoryItem): boolean =>
  item.callId !== null &&
  (item.nativeType === 'tool-result' || (item.kind === 'command' && item.callId !== record.uuid));

/**
 * Tells whether a record is the call an answering item follows.
 * @param candidate The record, one of the item's ancestors.
 * @param item The answering item.
 * @returns Whether the record holds the item's tool call, or is the shell input it follows.
 */
export const isClaudeCallFor = (candidate: IRecord, item: IHistoryItem): boolean =>
  item.nativeType === 'tool-result'
    ? toBlocks(candidate).some((block) => block.type === 'tool_use' && block.id === item.callId)
    : candidate.uuid === item.callId;

/**
 * Reads what a developer inspects in one record beyond its display text: a Bash command or `!`
 * shell input with its output, a tool call or result, an Edit or Write patch, and the images it
 * holds. A result takes its command or tool name from the call it answers.
 * @param record The item's record.
 * @param call The call it answers, or null when it answers none or the call isn't found.
 * @returns The detail's parts; the item itself comes from `toClaudeItem`.
 */
export const toClaudeDetail = (
  record: IRecord,
  call: IRecord | null,
): Omit<IItemDetail, 'item'> => {
  const detail: Omit<IItemDetail, 'item'> = {
    command: null,
    tool: null,
    files: [],
    images: toImages(record),
  };
  const text = toText(record);
  if (record.type === 'user' && text !== undefined) {
    const input = SHELL_INPUT.exec(text);
    const output = SHELL_OUTPUT.exec(text);
    if (input) detail.command = toCommandDetail(input[1]!.trim(), null);
    else if (output) {
      const callInput = SHELL_INPUT.exec((call && toText(call)) ?? '');
      detail.command = toCommandDetail(
        callInput ? callInput[1]!.trim() : null,
        [output[1], output[2]].filter(Boolean).join('\n'),
      );
    }
    return detail;
  }
  const blocks = toBlocks(record);
  const result = blocks.find((block) => block.type === 'tool_result');
  if (result && blocks.every((block) => block.type === 'tool_result')) {
    const use =
      call &&
      toBlocks(call).find((block) => block.type === 'tool_use' && block.id === result.tool_use_id);
    const patch = FilePatchSchema.safeParse(record.toolUseResult);
    if (patch.success)
      detail.files = [
        patch.data.type === 'create' && patch.data.content !== undefined
          ? {
              path: patch.data.filePath,
              added: countLines(patch.data.content),
              removed: 0,
              diff: toWholeFileDiff(patch.data.content, '+'),
            }
          : {
              ...toFileChange(patch.data).files[0]!,
              diff: toPatchLines(patch.data).join('\n'),
            },
      ];
    if (use?.name === 'Bash') {
      const shell = ShellResultSchema.safeParse(record.toolUseResult);
      detail.command = toCommandDetail(
        toShellCommand(use.input),
        shell.success
          ? [shell.data.stdout, shell.data.stderr].filter(Boolean).join('\n')
          : toResultBody(result),
      );
    } else detail.tool = toToolDetail(use?.name ?? null, null, toResultBody(result));
    return detail;
  }
  const use = blocks.find((block) => block.type === 'tool_use' && block.name);
  if (use?.name === 'Bash') detail.command = toCommandDetail(toShellCommand(use.input), null);
  else if (use) detail.tool = toToolDetail(use.name!, JSON.stringify(use.input ?? {}), null);
  return detail;
};
