#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { Exception, hasErrorCode, isException } from 'jg-exception';

import { HqRequestSchema } from '../contracts/index.js';
import { requestAgentHq } from '../ipc/index.js';
import { createAgentHq } from '../runtime/index.js';
import { readRuntimeOwner } from '../runtime/state/index.js';
import { serveAgentBridge } from '../agent-tools/mcp/index.js';
import { AGENT_BRIDGE_FILE_ENV } from '../agent-tools/index.js';

import { toCliError } from './utilities.js';

/** Runs the installed CLI without creating provider work merely to read history. */
const main = async (): Promise<void> => {
  if (process.argv[2] === 'agent-bridge') {
    const credentialPath = process.env[AGENT_BRIDGE_FILE_ENV];
    if (process.argv.length !== 3 || !credentialPath)
      throw new Exception('The HQ request is invalid', {
        code: 'JG_AGENT_HQ_REQUEST_INVALID',
        data: { kind: 'invalid-request' },
      });
    await serveAgentBridge(credentialPath);
    return;
  }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'state-root': { type: 'string' },
      'coordination-root': { type: 'string' },
      directory: { type: 'string' },
      'workspace-root': { type: 'string', multiple: true },
      'native-id': { type: 'string' },
      'turn-id': { type: 'string' },
      'native-item-id': { type: 'string' },
      'text-limit': { type: 'string' },
      'evidence-kind': { type: 'string', multiple: true },
      'thread-id': { type: 'string' },
      'server-name': { type: 'string' },
      'skill-id': { type: 'string' },
      arguments: { type: 'string' },
      'codex-extra-skill-root': { type: 'string', multiple: true },
      'claude-additional-directory': { type: 'string', multiple: true },
      name: { type: 'string' },
      topic: { type: 'string' },
      cursor: { type: 'string' },
      limit: { type: 'string' },
      'after-sequence': { type: 'string' },
      pace: { type: 'string' },
      search: { type: 'string' },
      provider: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [kind] = positionals;
  if (values.help || !kind || kind === 'help') {
    process.stdout.write(
      'jg-agent-hq serve|status|stop|capabilities|threads|thread|turns|items|sessions|session-evidence|usage|account|models|configuration|mcp-servers|mcp-tools|mcp-resources|managed-thread-name|suggest-thread-name|skills|skill-preview|plan-status|plan-milestones|session-states|active-sessions|unstarted-threads|observation-pace|request --state-root <path> [--provider <provider-id>] [--workspace-root <path>] [--native-id <id>] [--limit <1..128>] [--cursor <cursor>] [--name <name>] [--topic <topic>] [--thread-id <id>] [--server-name <name>] [--skill-id <id>] [--arguments <text>] [--directory <path>] [--after-sequence <sequence>]\nserve accepts repeated --codex-extra-skill-root and --claude-additional-directory, and --coordination-root for a separate existing coordination directory.\nsession-evidence accepts --native-item-id and repeated --evidence-kind.\nitems reads newest first and accepts --text-limit <1..65536>, and --native-item-id with --turn-id for one item.\nobservation-pace takes --pace <live|background>.\nrequest reads one validated HQ command as JSON from stdin.\n',
    );
    return;
  }
  if (positionals.length !== 1 || !values['state-root'])
    throw new Exception('The HQ request is invalid', {
      code: 'JG_AGENT_HQ_REQUEST_INVALID',
      data: { kind: 'invalid-request' },
    });
  const stateRoot = resolve(values['state-root']);
  const roots = (values['workspace-root'] ?? []).map((root) => resolve(root));
  if (kind === 'request') {
    if (Object.keys(values).some((key) => key !== 'state-root'))
      throw new Exception('The HQ request is invalid', {
        code: 'JG_AGENT_HQ_REQUEST_INVALID',
        data: { kind: 'invalid-request' },
      });
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      if (!Buffer.isBuffer(chunk))
        throw new Exception('The HQ request is invalid', {
          code: 'JG_AGENT_HQ_REQUEST_INVALID',
          data: { kind: 'invalid-request' },
        });
      bytes += chunk.length;
      if (bytes > 65_536)
        throw new Exception('The HQ request is invalid', {
          code: 'JG_AGENT_HQ_REQUEST_INVALID',
          data: { kind: 'invalid-request' },
        });
      chunks.push(chunk);
    }
    let input: unknown;
    try {
      input = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)),
      );
    } catch (cause) {
      throw new Exception('The HQ request is invalid', {
        code: 'JG_AGENT_HQ_REQUEST_INVALID',
        data: { kind: 'invalid-request' },
        cause,
      });
    }
    const parsed = HqRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new Exception('The HQ request is invalid', {
        code: 'JG_AGENT_HQ_REQUEST_INVALID',
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
      values.directory ||
      values['native-id'] ||
      values['turn-id'] ||
      values['native-item-id'] ||
      values['text-limit'] ||
      values['evidence-kind'] ||
      values['thread-id'] ||
      values['skill-id'] ||
      values.arguments ||
      values.name ||
      values.topic ||
      values.cursor ||
      values.limit ||
      values.search ||
      values.provider ||
      values['after-sequence']
    )
      throw new Exception('The HQ request is invalid', {
        code: 'JG_AGENT_HQ_REQUEST_INVALID',
        data: { kind: 'invalid-request' },
      });
    const runtime = await createAgentHq({
      stateRoot,
      coordinationRoot: values['coordination-root']
        ? resolve(values['coordination-root'])
        : undefined,
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
  if (
    values['codex-extra-skill-root'] ||
    values['claude-additional-directory'] ||
    values['coordination-root']
  )
    throw new Exception('The HQ request is invalid', {
      code: 'JG_AGENT_HQ_REQUEST_INVALID',
      data: { kind: 'invalid-request' },
    });
  if (roots.length > 1)
    throw new Exception('The HQ request is invalid', {
      code: 'JG_AGENT_HQ_REQUEST_INVALID',
      data: { kind: 'invalid-request' },
    });
  if (kind === 'plan-status' || kind === 'plan-milestones') {
    const allowed = new Set([
      'state-root',
      'directory',
      ...(kind === 'plan-milestones' ? ['limit', 'cursor'] : []),
    ]);
    if (!values.directory || Object.keys(values).some((key) => !allowed.has(key)))
      throw new Exception('The HQ request is invalid', {
        code: 'JG_AGENT_HQ_REQUEST_INVALID',
        data: { kind: 'invalid-request' },
      });
    const parsed = HqRequestSchema.safeParse({
      kind: 'plan',
      command: {
        kind: kind === 'plan-status' ? 'status' : 'milestones',
        target: { directory: resolve(values.directory) },
        ...(kind === 'plan-milestones'
          ? { limit: values.limit === undefined ? 32 : Number(values.limit), cursor: values.cursor }
          : {}),
      },
    });
    if (!parsed.success)
      throw new Exception('The HQ request is invalid', {
        code: 'JG_AGENT_HQ_REQUEST_INVALID',
        data: { kind: 'invalid-request' },
        cause: parsed.error,
      });
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, ...(await requestAgentHq(stateRoot, parsed.data)) })}\n`,
    );
    return;
  }
  if (kind === 'session-states') {
    const allowed = new Set(['state-root', 'after-sequence', 'limit']);
    if (Object.keys(values).some((key) => !allowed.has(key)))
      throw new Exception('The HQ request is invalid', {
        code: 'JG_AGENT_HQ_REQUEST_INVALID',
        data: { kind: 'invalid-request' },
      });
    const parsed = HqRequestSchema.safeParse({
      kind: 'session-states',
      afterSequence: values['after-sequence'] === undefined ? 0 : Number(values['after-sequence']),
      limit: values.limit === undefined ? 32 : Number(values.limit),
    });
    if (!parsed.success)
      throw new Exception('The HQ request is invalid', {
        code: 'JG_AGENT_HQ_REQUEST_INVALID',
        data: { kind: 'invalid-request' },
        cause: parsed.error,
      });
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, ...(await requestAgentHq(stateRoot, parsed.data)) })}\n`,
    );
    return;
  }
  if (kind === 'active-sessions' || kind === 'observation-pace') {
    const allowed = new Set(kind === 'observation-pace' ? ['state-root', 'pace'] : ['state-root']);
    if (Object.keys(values).some((key) => !allowed.has(key)))
      throw new Exception('The HQ request is invalid', {
        code: 'JG_AGENT_HQ_REQUEST_INVALID',
        data: { kind: 'invalid-request' },
      });
    const parsed = HqRequestSchema.safeParse(
      kind === 'active-sessions' ? { kind } : { kind, pace: values.pace },
    );
    if (!parsed.success)
      throw new Exception('The HQ request is invalid', {
        code: 'JG_AGENT_HQ_REQUEST_INVALID',
        data: { kind: 'invalid-request' },
        cause: parsed.error,
      });
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, ...(await requestAgentHq(stateRoot, parsed.data)) })}\n`,
    );
    return;
  }
  if (values.directory || values['after-sequence'] || values.pace)
    throw new Exception('The HQ request is invalid', {
      code: 'JG_AGENT_HQ_REQUEST_INVALID',
      data: { kind: 'invalid-request' },
    });
  const payload = Object.fromEntries(
    [
      ['kind', kind],
      [
        'provider',
        [
          'threads',
          'unstarted-threads',
          'thread',
          'turns',
          'items',
          'sessions',
          'session-evidence',
          'usage',
          'capabilities',
          'models',
          'configuration',
          'account',
          'provider-actions',
        ].includes(kind)
          ? (values.provider ?? 'codex')
          : values.provider,
      ],
      ['workspaceRoot', roots[0]],
      ['nativeId', values['native-id']],
      ['turnId', values['turn-id']],
      ['nativeItemId', values['native-item-id']],
      ['textLimit', values['text-limit'] === undefined ? undefined : Number(values['text-limit'])],
      ['kinds', values['evidence-kind']],
      ['threadId', values['thread-id']],
      ['serverName', values['server-name']],
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
    throw new Exception('The HQ request is invalid', {
      code: 'JG_AGENT_HQ_REQUEST_INVALID',
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
        const { owner } = await readRuntimeOwner(stateRoot);
        if (owner.nonce !== response.result.runtimeEpoch)
          throw new Exception('The HQ runtime owner is unverifiable', {
            code: 'JG_AGENT_HQ_RUNTIME_OWNER_UNVERIFIABLE',
            data: {
              kind: 'state-conflict',
            },
          });
      } catch (error) {
        if (isException(error) && hasErrorCode(error.cause, 'ENOENT')) {
          stopped = true;
          break;
        }
        throw error;
      }
      await wait(100);
    }
    if (!stopped)
      throw new Exception('The HQ transport failed', {
        code: 'JG_AGENT_HQ_TRANSPORT_FAILED',
        data: { kind: 'state-conflict' },
      });
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
