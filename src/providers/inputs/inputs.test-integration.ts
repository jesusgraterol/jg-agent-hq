// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentHq } from 'jg-agent-hq';
import {
  MAX_RESULT_BYTES,
  type IActionCommand,
  type IActionReceipt,
  type IHqRequestInput,
} from 'jg-agent-hq/contracts';
import { expectToRejectCode } from 'jg-exception/testing';
import { expect, test } from 'vitest';

import {
  withClaudeRuntime,
  writeFixtureControl,
  type IClaudeFixture,
} from '../../../scripts/test-support/index.js';

const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};
const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCdcAAAAASUVORK5CYII=',
  'base64',
);

const createClient = async (
  fixture: IClaudeFixture,
  provider: 'codex' | 'claude',
  structured = false,
) => {
  const status = await fixture.request({ kind: 'status' });
  if (status.kind !== 'status') throw new Error('Missing status');
  const envelope = (command: IActionCommand): IHqRequestInput => ({
    kind: 'action',
    action: { id: randomUUID(), runtimeEpoch: status.result.runtimeEpoch, command },
  });
  const receipt = async (actionId: string): Promise<IActionReceipt> => {
    const response = await fixture.request({ kind: 'receipt', actionId });
    if (response.kind !== 'receipt' || !response.result) throw new Error('Missing receipt');
    return response.result;
  };
  const send = async (command: IActionCommand) => {
    const response = await fixture.request(envelope(command));
    if (response.kind !== 'action') throw new Error('Missing action');
    return response.result;
  };
  const created = await send({
    kind: 'thread-create',
    provider,
    workspaceRoot: fixture.workspaceRoot,
    name: 'media',
    ...(structured ? { settings: { outputSchema: schema } } : {}),
  });
  await expect.poll(() => receipt(created.id)).toMatchObject({ delivery: 'acknowledged' });
  const threadId = created.threadId!;
  const thread = async () => {
    const response = await fixture.request({ kind: 'managed-thread', threadId });
    if (response.kind !== 'managed-thread' || !response.result) throw new Error('Missing thread');
    return response.result;
  };
  const control = (settings: object) =>
    writeFixtureControl(
      fixture.root,
      provider === 'codex' ? 'control.json' : 'claude-control.json',
      settings,
    );
  const inputs = async () =>
    (
      await readFile(
        join(fixture.root, provider === 'codex' ? 'calls.jsonl' : 'claude-calls.jsonl'),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line): unknown => JSON.parse(line));
  return { threadId, receipt, send, envelope, thread, control, inputs };
};

test.each(['codex', 'claude'] as const)(
  '%s transmits bounded image/text files and retains complete structured output across reconnect',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const api = await createClient(fixture, provider, true);
      await writeFile(join(fixture.workspaceRoot, 'pixel.png'), image);
      await writeFile(join(fixture.workspaceRoot, 'note.txt'), 'A trusted UTF-8 document.');
      const output = { answer: '🧪'.repeat(40_000) };
      await api.control({ structuredOutput: output, outputText: JSON.stringify(output) });
      const message = await api.send({
        kind: 'message',
        threadId: api.threadId,
        input: {
          kind: 'text',
          text: 'Read these files.',
          files: [
            { path: 'pixel.png', mediaType: 'image/png' },
            { path: 'note.txt', mediaType: 'text/plain' },
          ],
        },
        settings: { outputSchema: schema },
      });
      await expect
        .poll(() => api.receipt(message.id))
        .toMatchObject({
          completion: 'completed',
          result: {
            structuredOutput: output,
            isComplete: true,
            usage: { inputTokens: 7, outputTokens: 3, cachedInputTokens: 2, scope: 'turn' },
          },
        });
      const calls = JSON.stringify(await api.inputs());
      expect(calls).toContain(image.toString('base64'));
      expect(calls).toContain('A trusted UTF-8 document.');
      const live = await fixture.request({ kind: 'live-items', threadId: api.threadId });
      if (live.kind !== 'live-items') throw new Error('Missing live items');
      expect(
        live.result.data.some((item) => item.kind === 'agent-message' && item.isTruncated),
      ).toBe(true);
      expect(
        JSON.stringify(await fixture.request({ kind: 'actions', threadId: api.threadId })),
      ).not.toContain(output.answer);
      const complete = await api.receipt(message.id);
      await fixture.runtime.close();
      const restarted = await createAgentHq({
        stateRoot: fixture.stateRoot,
        allowedRoots: [fixture.workspaceRoot],
      });
      try {
        expect(await restarted.request({ kind: 'receipt', actionId: message.id })).toMatchObject({
          kind: 'receipt',
          result: { result: complete.result },
        });
      } finally {
        await restarted.close();
      }
    });
  },
);

test.each([
  ['codex', 'changed'],
  ['codex', 'missing'],
  ['codex', 'linked'],
  ['claude', 'changed'],
  ['claude', 'missing'],
  ['claude', 'linked'],
] as const)('%s rejects a %s queued reference before native delivery', async (provider, mode) => {
  await withClaudeRuntime(async (fixture) => {
    const api = await createClient(fixture, provider);
    const path = join(fixture.workspaceRoot, 'pending.txt');
    await writeFile(path, 'The admitted document');
    await api.control({ holdTurn: true });
    const first = await api.send({
      kind: 'message',
      threadId: api.threadId,
      input: { kind: 'text', text: 'First turn' },
    });
    await expect.poll(() => api.receipt(first.id)).toMatchObject({ delivery: 'acknowledged' });
    const active = await api.thread();
    const queued = await api.send({
      kind: 'queue',
      threadId: api.threadId,
      expectedTurnId: active.activeTurnId!,
      input: {
        kind: 'text',
        text: 'Queued file',
        files: [{ path: 'pending.txt', mediaType: 'text/plain' }],
      },
    });
    expect(queued.queuedInput?.files[0]).toMatchObject({
      path,
      bytes: 21,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    if (mode === 'changed') await writeFile(path, 'A different document');
    else {
      await rm(path);
      if (mode === 'linked') {
        const external = join(fixture.root, 'external.txt');
        await writeFile(external, 'The admitted document');
        await symlink(external, path);
      }
    }
    await api.send({
      kind: 'interrupt',
      threadId: api.threadId,
      expectedTurnId: active.activeTurnId!,
    });
    await expect.poll(api.thread).toMatchObject({ state: 'interrupted' });
    await api.control({});
    await api.send({ kind: 'queue-send', queuedActionId: queued.id });
    await expect
      .poll(() => api.receipt(queued.id))
      .toMatchObject({
        delivery: 'failed',
        failure: mode === 'linked' ? 'access-denied' : 'state-conflict',
      });
    const calls = await api.inputs();
    expect(
      calls.filter((call) => {
        const record = call as { method?: string; type?: string };
        return provider === 'codex' ? record.method === 'turn/start' : record.type === 'user';
      }),
    ).toHaveLength(1);
  });
});

test.each(['codex', 'claude'] as const)(
  '%s rejects invalid files, escapes and oversized inputs before admission',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const api = await createClient(fixture, provider);
      const external = join(fixture.root, 'outside.txt');
      await writeFile(external, 'outside');
      await symlink(external, join(fixture.workspaceRoot, 'escape.txt'));
      for (const path of [external, '../outside.txt', 'escape.txt'])
        await expectToRejectCode(
          fixture.request(
            api.envelope({
              kind: 'message',
              threadId: api.threadId,
              input: { kind: 'text', text: 'Read', files: [{ path, mediaType: 'text/plain' }] },
            }),
          ),
          'JG_AGENT_HQ_CLIENT_ACCESS_DENIED',
        );
      await writeFile(join(fixture.workspaceRoot, 'invalid.png'), 'not an image');
      await writeFile(join(fixture.workspaceRoot, 'large.txt'), 'x'.repeat(65_537));
      for (const [path, mediaType] of [
        ['invalid.png', 'image/png'],
        ['large.txt', 'text/plain'],
      ] as const)
        await expectToRejectCode(
          fixture.request(
            api.envelope({
              kind: 'message',
              threadId: api.threadId,
              input: { kind: 'text', text: 'Read', files: [{ path, mediaType }] },
            }),
          ),
          'JG_AGENT_HQ_CLIENT_INVALID_REQUEST',
        );
      await expectToRejectCode(
        fixture.request(
          api.envelope({
            kind: 'message',
            threadId: api.threadId,
            input: { kind: 'text', text: '🧪'.repeat(8192) },
          }),
        ),
        'JG_AGENT_HQ_REQUEST_INVALID',
      );
    });
  },
);

test.each(['codex', 'claude'] as const)(
  '%s fails invalid structured output and oversized capture without saving an excerpt as a result',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const api = await createClient(fixture, provider, true);
      await api.control({ structuredOutput: { answer: 42 } });
      const invalid = await api.send({
        kind: 'message',
        threadId: api.threadId,
        input: { kind: 'text', text: 'Invalid result' },
      });
      await expect
        .poll(() => api.receipt(invalid.id))
        .toMatchObject({
          completion: 'failed',
          result: {
            state: 'failed',
            failure: 'invalid-structured-output',
            structuredOutput: { answer: 42 },
          },
        });
      await api.control({ outputSize: MAX_RESULT_BYTES });
      const large = await api.send({
        kind: 'message',
        threadId: api.threadId,
        input: { kind: 'text', text: 'Oversized result' },
      });
      await expect
        .poll(() => api.receipt(large.id))
        .toMatchObject({
          completion: 'failed',
          result: {
            state: 'failed',
            text: null,
            structuredOutput: null,
            isComplete: false,
            failure: 'result-too-large',
          },
        });
    });
  },
);

test.each(['codex', 'claude'] as const)(
  '%s accepted file maxima fit the native frame and excess aggregate data is rejected',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const api = await createClient(fixture, provider);
      await writeFile(join(fixture.workspaceRoot, 'boundary.txt'), '\u0001'.repeat(65_536));
      const files = Array.from({ length: 8 }, () => ({
        path: 'boundary.txt',
        mediaType: 'text/plain' as const,
      }));
      const accepted = await api.send({
        kind: 'message',
        threadId: api.threadId,
        input: { kind: 'text', text: 'Bounded input', files },
      });
      await expect.poll(() => api.receipt(accepted.id)).toMatchObject({ completion: 'completed' });
      const records = await api.inputs();
      expect(
        Math.max(...records.map((record) => Buffer.byteLength(JSON.stringify(record)))),
      ).toBeLessThan(8_388_608);
      await expectToRejectCode(
        fixture.request(
          api.envelope({
            kind: 'message',
            threadId: api.threadId,
            input: { kind: 'text', text: 'Too many files', files: [...files, files[0]!] },
          }),
        ),
        'JG_AGENT_HQ_REQUEST_INVALID',
      );
      const largeImage = Buffer.alloc(2_097_152);
      image.copy(largeImage);
      await writeFile(join(fixture.workspaceRoot, 'large.png'), largeImage);
      await expectToRejectCode(
        fixture.request(
          api.envelope({
            kind: 'message',
            threadId: api.threadId,
            input: {
              kind: 'text',
              text: 'Too many bytes',
              files: [
                { path: 'large.png', mediaType: 'image/png' },
                { path: 'large.png', mediaType: 'image/png' },
              ],
            },
          }),
        ),
        'JG_AGENT_HQ_CLIENT_INVALID_REQUEST',
      );
      if (provider === 'claude') {
        await expectToRejectCode(
          fixture.request(
            api.envelope({
              kind: 'message',
              threadId: api.threadId,
              input: { kind: 'text', text: 'Unsupported live schema change' },
              settings: { outputSchema: schema },
            }),
          ),
          'JG_AGENT_HQ_CLIENT_AGENT_UNAVAILABLE',
        );
      } else {
        await writeFile(join(fixture.workspaceRoot, 'document.pdf'), '%PDF-1.7\n');
        await expectToRejectCode(
          fixture.request(
            api.envelope({
              kind: 'message',
              threadId: api.threadId,
              input: {
                kind: 'text',
                text: 'Unsupported PDF input',
                files: [{ path: 'document.pdf', mediaType: 'application/pdf' }],
              },
            }),
          ),
          'JG_AGENT_HQ_CLIENT_AGENT_UNAVAILABLE',
        );
      }
    });
  },
);

test.each(['codex', 'claude'] as const)(
  '%s queued delivery retains files, output schema and native turn settings',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const api = await createClient(fixture, provider, true);
      await api.control({ holdTurn: true });
      const first = await api.send({
        kind: 'message',
        threadId: api.threadId,
        input: { kind: 'text', text: 'Pause this turn' },
      });
      await expect.poll(() => api.receipt(first.id)).toMatchObject({ delivery: 'acknowledged' });
      const active = await api.thread();
      await writeFile(join(fixture.workspaceRoot, 'queued.txt'), 'The queued document');
      const settings = {
        model: 'model-0002',
        effort: 'queued-effort',
        outputSchema: {
          additionalProperties: false,
          required: ['answer'],
          properties: { answer: { type: 'string' } },
          type: 'object',
        },
      };
      const queued = await api.send({
        kind: 'queue',
        threadId: api.threadId,
        expectedTurnId: active.activeTurnId!,
        input: {
          kind: 'text',
          text: 'Use queued settings',
          files: [{ path: 'queued.txt', mediaType: 'text/plain' }],
        },
        settings,
      });
      expect(queued.queuedInput?.settings).toStrictEqual(settings);
      await api.send({
        kind: 'interrupt',
        threadId: api.threadId,
        expectedTurnId: active.activeTurnId!,
      });
      await expect.poll(api.thread).toMatchObject({ state: 'interrupted' });
      await api.control({ structuredOutput: { answer: 'queued-result' } });
      await api.send({ kind: 'queue-send', queuedActionId: queued.id });
      await expect
        .poll(() => api.receipt(queued.id))
        .toMatchObject({
          completion: 'completed',
          queuedInput: null,
          result: { structuredOutput: { answer: 'queued-result' } },
        });
      const configuration = await fixture.request({
        kind: 'configuration',
        provider,
        workspaceRoot: fixture.workspaceRoot,
        threadId: api.threadId,
      });
      expect(configuration).toMatchObject({
        kind: 'configuration',
        result: { effective: { model: 'model-0002', effort: 'queued-effort' } },
      });
      expect(JSON.stringify(await api.inputs())).toContain('The queued document');
    });
  },
);

test.each(['codex', 'claude'] as const)(
  '%s optional malformed usage does not invalidate a complete structured result',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const api = await createClient(fixture, provider, true);
      await api.control({ usageMalformed: true, structuredOutput: { answer: 'verified' } });
      const message = await api.send({
        kind: 'message',
        threadId: api.threadId,
        input: { kind: 'text', text: 'Return the structured result' },
      });
      await expect
        .poll(() => api.receipt(message.id))
        .toMatchObject({
          completion: 'completed',
          result: { isComplete: true, structuredOutput: { answer: 'verified' }, usage: null },
        });
    });
  },
);

test.each(['codex', 'claude'] as const)(
  '%s delivers a complete 1 MiB report through native and HQ frames with worst-case escaping',
  // the escaped payload crosses native, worker, SQLite and IPC as more than 6 MiB
  { timeout: 15_000 },
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const api = await createClient(fixture, provider, true);
      const output = { answer: '\u0001'.repeat(1_048_576) };
      await api.control({ structuredOutput: output });
      const message = await api.send({
        kind: 'message',
        threadId: api.threadId,
        input: { kind: 'text', text: 'Return the complete report' },
      });
      await expect
        .poll(
          async () => {
            const receipt = await api.receipt(message.id);
            const result = receipt.result?.structuredOutput;
            return (
              receipt.completion === 'completed' &&
              result !== null &&
              typeof result === 'object' &&
              !Array.isArray(result) &&
              result.answer === output.answer
            );
          },
          { timeout: 10_000 },
        )
        .toBe(true);
      const receipt = await api.receipt(message.id);
      expect(receipt.result?.text).toBeNull();
      expect(receipt.result?.isComplete).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(receipt.result))).toBeLessThanOrEqual(
        MAX_RESULT_BYTES,
      );
    });
  },
);

test.each(['codex', 'claude'] as const)(
  '%s compaction preserves native completion in a schema-configured session',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const api = await createClient(fixture, provider, true);
      const compact = await api.send({ kind: 'thread-compact', threadId: api.threadId });
      await expect.poll(async () => (await api.receipt(compact.id)).completion).toBe('completed');
      expect(await api.thread()).toMatchObject({ state: 'completed' });
    });
  },
);

test('Codex native input rejection requires recovery before further native controls', async () => {
  await withClaudeRuntime(async (fixture) => {
    const api = await createClient(fixture, 'codex', true);
    await api.control({ rejectTurn: true });
    const rejected = await api.send({
      kind: 'message',
      threadId: api.threadId,
      input: { kind: 'text', text: 'Rejected input' },
    });
    await expect.poll(() => api.receipt(rejected.id)).toMatchObject({ delivery: 'failed' });
    await api.control({});
    const compact = await api.send({ kind: 'thread-compact', threadId: api.threadId });
    await expect
      .poll(async () => {
        const receipt = await api.receipt(compact.id);
        return {
          delivery: receipt.delivery,
          completion: receipt.completion,
          failure: receipt.failure,
          resultState: receipt.result?.state,
        };
      })
      .toMatchObject({ delivery: 'failed', completion: null, failure: 'state-conflict' });
    expect(JSON.stringify(await api.inputs())).not.toContain('thread/compact/start');
  });
});
