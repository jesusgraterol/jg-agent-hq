#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { Exception, hasErrorCode } from 'error-message-utils';

import { HqRequestSchema } from '../contracts/index.js';
import { toPublicError } from '../errors/index.js';
import { requestAgentHq } from '../ipc/index.js';
import { createAgentHq } from '../runtime/index.js';
import { readRuntimeOwner } from '../runtime/state/index.js';

/** Runs the installed CLI without creating provider work merely to read history. */
const main = async (): Promise<void> => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'state-root': { type: 'string' },
      'workspace-root': { type: 'string', multiple: true },
      'native-id': { type: 'string' },
      'turn-id': { type: 'string' },
      'thread-id': { type: 'string' },
      'skill-id': { type: 'string' },
      arguments: { type: 'string' },
      'codex-extra-skill-root': { type: 'string', multiple: true },
      'claude-additional-directory': { type: 'string', multiple: true },
      name: { type: 'string' },
      topic: { type: 'string' },
      cursor: { type: 'string' },
      limit: { type: 'string' },
      search: { type: 'string' },
      provider: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [kind] = positionals;
  if (values.help || !kind || kind === 'help') {
    process.stdout.write(
      'jg-agent-hq serve|status|stop|threads|thread|turns|items|usage|managed-thread-name|suggest-thread-name|skills|skill-preview|request --state-root <path> [--provider codex|claude] [--workspace-root <path>] [--native-id <id>] [--limit <1..128>] [--cursor <cursor>] [--name <name>] [--topic <topic>] [--thread-id <id>] [--skill-id <id>] [--arguments <text>]\nserve accepts repeated --codex-extra-skill-root and --claude-additional-directory.\nrequest reads one validated HQ command as JSON from stdin.\n',
    );
    return;
  }
  if (positionals.length !== 1 || !values['state-root'])
    throw new Exception('The HQ request is invalid', undefined, { kind: 'invalid-request' });
  const stateRoot = resolve(values['state-root']);
  const roots = (values['workspace-root'] ?? []).map((root) => resolve(root));
  if (kind === 'request') {
    if (Object.keys(values).some((key) => key !== 'state-root'))
      throw new Exception('The HQ request is invalid', undefined, { kind: 'invalid-request' });
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      if (!Buffer.isBuffer(chunk))
        throw new Exception('The HQ request is invalid', undefined, { kind: 'invalid-request' });
      bytes += chunk.length;
      if (bytes > 65_536)
        throw new Exception('The HQ request is invalid', undefined, { kind: 'invalid-request' });
      chunks.push(chunk);
    }
    let input: unknown;
    try {
      input = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)),
      );
    } catch (cause) {
      throw new Exception(
        'The HQ request is invalid',
        undefined,
        { kind: 'invalid-request' },
        { cause },
      );
    }
    const parsed = HqRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new Exception(
        'The HQ request is invalid',
        undefined,
        { kind: 'invalid-request' },
        { cause: parsed.error },
      );
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, ...(await requestAgentHq(stateRoot, parsed.data)) })}\n`,
    );
    return;
  }
  if (kind === 'serve') {
    if (
      values['native-id'] ||
      values['turn-id'] ||
      values['thread-id'] ||
      values['skill-id'] ||
      values.arguments ||
      values.name ||
      values.topic ||
      values.cursor ||
      values.limit ||
      values.search ||
      values.provider
    )
      throw new Exception('The HQ request is invalid', undefined, { kind: 'invalid-request' });
    const runtime = await createAgentHq({
      stateRoot,
      allowedRoots: roots,
      codexExtraSkillRoots: values['codex-extra-skill-root']?.map((path) => resolve(path)),
      claudeAdditionalDirectories: values['claude-additional-directory']?.map((path) =>
        resolve(path),
      ),
    });
    const onInterrupt = (): void => {
      process.exitCode = 130;
      void runtime.close().catch(() => undefined);
    };
    const onTerminate = (): void => {
      process.exitCode = 143;
      void runtime.close().catch(() => undefined);
    };
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    try {
      process.stdout.write(
        `${JSON.stringify({ schemaVersion: 1, kind: 'ready', result: await runtime.request({ kind: 'status' }) })}\n`,
      );
      await runtime.closed;
    } finally {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
      await runtime.close();
    }
    return;
  }
  if (values['codex-extra-skill-root'] || values['claude-additional-directory'])
    throw new Exception('The HQ request is invalid', undefined, { kind: 'invalid-request' });
  if (roots.length > 1)
    throw new Exception('The HQ request is invalid', undefined, { kind: 'invalid-request' });
  const payload = Object.fromEntries(
    [
      ['kind', kind],
      [
        'provider',
        ['threads', 'thread', 'turns', 'items', 'usage'].includes(kind)
          ? (values.provider ?? 'codex')
          : values.provider,
      ],
      ['workspaceRoot', roots[0]],
      ['nativeId', values['native-id']],
      ['turnId', values['turn-id']],
      ['threadId', values['thread-id']],
      ['skillId', values['skill-id']],
      ['arguments', values.arguments ?? (kind === 'skill-preview' ? '' : undefined)],
      ['name', values.name],
      ['topic', values.topic],
      ['cursor', values.cursor],
      ['limit', values.limit === undefined ? undefined : Number(values.limit)],
      ['search', values.search],
    ].filter(([, entry]) => entry !== undefined),
  );
  const parsed = HqRequestSchema.safeParse(payload);
  if (!parsed.success)
    throw new Exception(
      'The HQ request is invalid',
      undefined,
      { kind: 'invalid-request' },
      { cause: parsed.error },
    );
  const command = parsed.data;
  const response = await requestAgentHq(stateRoot, command);
  if (response.kind === 'stop') {
    const deadline = Date.now() + 10_000;
    let stopped = false;
    while (Date.now() < deadline) {
      try {
        const { owner } = await readRuntimeOwner(stateRoot);
        if (owner.nonce !== response.result.runtimeEpoch)
          throw new Exception('The HQ runtime owner is unverifiable', undefined, {
            kind: 'state-conflict',
          });
      } catch (error) {
        if (error instanceof Exception && hasErrorCode(error.cause, 'ENOENT')) {
          stopped = true;
          break;
        }
        throw error;
      }
      await wait(100);
    }
    if (!stopped)
      throw new Exception('The HQ transport failed', undefined, { kind: 'state-conflict' });
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, kind: 'stop', result: { state: 'stopped', runtimeEpoch: response.result.runtimeEpoch } })}\n`,
    );
  } else process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...response })}\n`);
};

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ schemaVersion: 1, success: false, error: toPublicError(error) })}\n`,
  );
  process.exitCode = 1;
}
