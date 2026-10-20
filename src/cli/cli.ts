#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { Exception, hasErrorCode } from 'error-message-utils';

import { HqRequestSchema } from '../contracts/index.js';
import { requestAgentHq, toPublicError } from '../ipc/index.js';
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
      cursor: { type: 'string' },
      limit: { type: 'string' },
      search: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [kind] = positionals;
  if (values.help || !kind || kind === 'help') {
    process.stdout.write(
      'jg-agent-hq serve|status|stop|threads|thread|turns|items|usage --state-root <path> [--workspace-root <path>] [--native-id <id>] [--limit <1..128>] [--cursor <cursor>]\n',
    );
    return;
  }
  if (positionals.length !== 1 || !values['state-root'])
    throw new Exception('The HQ request is invalid', undefined, { kind: 'invalid-request' });
  const stateRoot = resolve(values['state-root']);
  const roots = (values['workspace-root'] ?? []).map((root) => resolve(root));
  if (kind === 'serve') {
    if (values['native-id'] || values['turn-id'] || values.cursor || values.limit || values.search)
      throw new Exception('The HQ request is invalid', undefined, { kind: 'invalid-request' });
    const runtime = await createAgentHq({ stateRoot, allowedRoots: roots });
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
  if (roots.length > 1)
    throw new Exception('The HQ request is invalid', undefined, { kind: 'invalid-request' });
  const payload = Object.fromEntries(
    [
      ['kind', kind],
      ['provider', kind === 'status' || kind === 'stop' ? undefined : 'codex'],
      ['workspaceRoot', roots[0]],
      ['nativeId', values['native-id']],
      ['turnId', values['turn-id']],
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
