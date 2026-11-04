#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { hasErrorCode } from 'jg-exception';

import { HqRequestSchema } from '../contracts/index.js';
import { requestAgentHq } from '../ipc/index.js';
import { createAgentHq } from '../runtime/index.js';
import { readRuntimeOwner } from '../runtime/state/index.js';
import { HQ_ERRORS } from '../errors/index.js';

import { toCliError } from './utilities.js';

/** Runs the installed CLI without creating provider work merely to read history. */
const main = async (): Promise<void> => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'state-root': { type: 'string' },
      'workspace-root': { type: 'string', multiple: true },
      'native-id': { type: 'string' },
      'turn-id': { type: 'string' },
      'native-item-id': { type: 'string' },
      index: { type: 'string' },
      'text-limit': { type: 'string' },
      'evidence-kind': { type: 'string', multiple: true },
      'thread-id': { type: 'string' },
      'codex-extra-skill-root': { type: 'string', multiple: true },
      'claude-additional-directory': { type: 'string', multiple: true },
      topic: { type: 'string' },
      cursor: { type: 'string' },
      limit: { type: 'string' },
      'after-sequence': { type: 'string' },
      pace: { type: 'string' },
      search: { type: 'string' },
      'exclude-continued': { type: 'boolean' },
      provider: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [kind] = positionals;
  if (values.help || !kind || kind === 'help') {
    process.stdout.write(
      'jg-agent-hq serve|status|stop|capabilities|threads|thread|items|item-detail|item-image|session-evidence|usage|models|configuration|suggest-thread-name|skills|session-states|active-sessions|observation-pace|locks|request --state-root <path> [--provider <codex|claude>] [--workspace-root <path>] [--native-id <id>] [--limit <1..128>] [--cursor <cursor>] [--topic <topic>] [--thread-id <id>] [--after-sequence <sequence>]\nserve accepts repeated --codex-extra-skill-root and --claude-additional-directory.\nthreads lists sessions across repeated --workspace-root and --provider, both providers by default, and accepts --search and --exclude-continued.\nsession-evidence accepts --native-item-id and repeated --evidence-kind.\nitems reads newest first and accepts --text-limit <1..65536>, and --native-item-id with --turn-id for one item.\nitem-detail reads the detail of one item and takes --native-item-id and --turn-id.\nitem-image reads one image of an item and also takes --index <0..63>.\nobservation-pace takes --pace <live|background>.\nlocks lists the jg-locks locks on this machine with their holders; HQ never takes them.\nrequest reads one validated HQ command as JSON from stdin, such as action-wait.\n',
    );
    return;
  }
  if (positionals.length !== 1 || !values['state-root'])
    throw HQ_ERRORS.create('requestInvalid', { data: { kind: 'invalid-request' } });
  const stateRoot = resolve(values['state-root']);
  const roots = (values['workspace-root'] ?? []).map((root) => resolve(root));
  if (kind === 'request') {
    if (Object.keys(values).some((key) => key !== 'state-root'))
      throw HQ_ERRORS.create('requestInvalid', { data: { kind: 'invalid-request' } });
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      if (!Buffer.isBuffer(chunk))
        throw HQ_ERRORS.create('requestInvalid', { data: { kind: 'invalid-request' } });
      bytes += chunk.length;
      if (bytes > 65_536)
        throw HQ_ERRORS.create('requestInvalid', { data: { kind: 'invalid-request' } });
      chunks.push(chunk);
    }
    let input: unknown;
    try {
      input = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)),
      );
    } catch (cause) {
      throw HQ_ERRORS.create('requestInvalid', { data: { kind: 'invalid-request' }, cause });
    }
    const parsed = HqRequestSchema.safeParse(input);
    if (!parsed.success)
      throw HQ_ERRORS.create('requestInvalid', {
        data: { kind: 'invalid-request' },
        cause: parsed.error,
      });
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, ...(await requestAgentHq(stateRoot, parsed.data)) })}\n`,
    );
    return;
  }
  if (kind === 'serve') {
    if (
      values['native-id'] ||
      values['turn-id'] ||
      values['native-item-id'] ||
      values.index ||
      values['text-limit'] ||
      values['evidence-kind'] ||
      values['thread-id'] ||
      values.topic ||
      values.cursor ||
      values.limit ||
      values.search ||
      values['exclude-continued'] ||
      values.provider ||
      values['after-sequence']
    )
      throw HQ_ERRORS.create('requestInvalid', { data: { kind: 'invalid-request' } });
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
    throw HQ_ERRORS.create('requestInvalid', { data: { kind: 'invalid-request' } });
  if (kind === 'threads') {
    const allowed = new Set([
      'state-root',
      'workspace-root',
      'provider',
      'search',
      'exclude-continued',
      'limit',
      'cursor',
    ]);
    if (Object.keys(values).some((key) => !allowed.has(key)))
      throw HQ_ERRORS.create('requestInvalid', { data: { kind: 'invalid-request' } });
    const parsed = HqRequestSchema.safeParse({
      kind,
      workspaceRoots: roots,
      providers: values.provider,
      search: values.search,
      excludeContinued: values['exclude-continued'],
      limit: values.limit === undefined ? undefined : Number(values.limit),
      cursor: values.cursor,
    });
    if (!parsed.success)
      throw HQ_ERRORS.create('requestInvalid', {
        data: { kind: 'invalid-request' },
        cause: parsed.error,
      });
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, ...(await requestAgentHq(stateRoot, parsed.data)) })}\n`,
    );
    return;
  }
  if (roots.length > 1 || (values.provider?.length ?? 0) > 1)
    throw HQ_ERRORS.create('requestInvalid', { data: { kind: 'invalid-request' } });
  if (kind === 'session-states') {
    const allowed = new Set(['state-root', 'after-sequence', 'limit']);
    if (Object.keys(values).some((key) => !allowed.has(key)))
      throw HQ_ERRORS.create('requestInvalid', { data: { kind: 'invalid-request' } });
    const parsed = HqRequestSchema.safeParse({
      kind: 'session-states',
      afterSequence: values['after-sequence'] === undefined ? 0 : Number(values['after-sequence']),
      limit: values.limit === undefined ? 32 : Number(values.limit),
    });
    if (!parsed.success)
      throw HQ_ERRORS.create('requestInvalid', {
        data: { kind: 'invalid-request' },
        cause: parsed.error,
      });
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, ...(await requestAgentHq(stateRoot, parsed.data)) })}\n`,
    );
    return;
  }
  if (kind === 'active-sessions' || kind === 'observation-pace' || kind === 'locks') {
    const allowed = new Set(kind === 'observation-pace' ? ['state-root', 'pace'] : ['state-root']);
    if (Object.keys(values).some((key) => !allowed.has(key)))
      throw HQ_ERRORS.create('requestInvalid', { data: { kind: 'invalid-request' } });
    const parsed = HqRequestSchema.safeParse(
      kind === 'observation-pace' ? { kind, pace: values.pace } : { kind },
    );
    if (!parsed.success)
      throw HQ_ERRORS.create('requestInvalid', {
        data: { kind: 'invalid-request' },
        cause: parsed.error,
      });
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, ...(await requestAgentHq(stateRoot, parsed.data)) })}\n`,
    );
    return;
  }
  if (values['after-sequence'] || values.pace || values['exclude-continued'])
    throw HQ_ERRORS.create('requestInvalid', { data: { kind: 'invalid-request' } });
  const provider = values.provider?.[0];
  const payload = Object.fromEntries(
    [
      ['kind', kind],
      [
        'provider',
        [
          'thread',
          'items',
          'item-detail',
          'item-image',
          'session-evidence',
          'usage',
          'capabilities',
          'models',
          'configuration',
          'skills',
        ].includes(kind)
          ? (provider ?? 'codex')
          : provider,
      ],
      ['workspaceRoot', roots[0]],
      ['nativeId', values['native-id']],
      ['turnId', values['turn-id']],
      ['nativeItemId', values['native-item-id']],
      ['index', values.index === undefined ? undefined : Number(values.index)],
      ['textLimit', values['text-limit'] === undefined ? undefined : Number(values['text-limit'])],
      ['kinds', values['evidence-kind']],
      ['threadId', values['thread-id']],
      ['topic', values.topic],
      ['cursor', values.cursor],
      ['limit', values.limit === undefined ? undefined : Number(values.limit)],
      ['search', values.search],
    ].filter(([, entry]) => entry !== undefined),
  );
  const parsed = HqRequestSchema.safeParse(payload);
  if (!parsed.success)
    throw HQ_ERRORS.create('requestInvalid', {
      data: { kind: 'invalid-request' },
      cause: parsed.error,
    });
  const command = parsed.data;
  const response = await requestAgentHq(stateRoot, command);
  if (response.kind === 'stop') {
    const deadline = Date.now() + 10_000;
    let stopped = false;
    while (Date.now() < deadline) {
      try {
        const owner = await readRuntimeOwner(stateRoot);
        if (owner.nonce !== response.result.runtimeEpoch)
          throw HQ_ERRORS.create('runtimeOwnerUnverifiable', {
            data: { kind: 'state-conflict' },
          });
      } catch (error) {
        if (hasErrorCode(error, 'JG_AGENT_HQ_RUNTIME_NOT_RUNNING')) {
          stopped = true;
          break;
        }
        throw error;
      }
      await wait(100);
    }
    if (!stopped) throw HQ_ERRORS.create('transportFailed', { data: { kind: 'state-conflict' } });
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, kind: 'stop', result: { state: 'stopped', runtimeEpoch: response.result.runtimeEpoch } })}\n`,
    );
  } else process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...response })}\n`);
};

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ schemaVersion: 1, success: false, error: toCliError(error) })}\n`,
  );
  process.exitCode = 1;
}
