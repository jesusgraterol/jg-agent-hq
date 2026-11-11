import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IAsyncInputEvent } from 'jg-agent-hq';
import { expect, test } from 'vitest';

import { withClaudeRuntime, writeFixtureControl } from '../../../scripts/test-support/index.js';

test('trusted async observations preserve controlled identity and saved/live/detail/evidence parity with isolated subscribers', async () => {
  await withClaudeRuntime(async (fixture) => {
    const events: IAsyncInputEvent[] = [];
    const failures: IAsyncInputEvent[] = [];
    const unsubscribe = fixture.runtime.observeAsyncInputs((event) => events.push(event));
    const stopFailure = fixture.runtime.observeAsyncInputs((event) => {
      failures.push(event);
      if (event.kind === 'item') throw new Error('Host enqueue failed');
    });
    // mutation is isolated from other consumers and the live/history projections
    const stopMutation = fixture.runtime.observeAsyncInputs((event) => {
      if (event.kind === 'item') event.item.asyncInput = undefined;
    });
    expect(events).toStrictEqual([
      { kind: 'recovery', provider: 'codex', source: null, reason: 'subscribed' },
    ]);
    const created = await fixture.runtime.request({
      kind: 'action',
      action: {
        id: randomUUID(),
        runtimeEpoch: fixture.runtime.runtimeEpoch,
        command: {
          kind: 'thread-create',
          provider: 'codex',
          workspaceRoot: fixture.workspaceRoot,
          name: 'async-observer',
        },
      },
    });
    const threadId = created.result.threadId!;
    const managed = async () =>
      (await fixture.runtime.request({ kind: 'managed-thread', threadId })).result;
    await expect.poll(async () => (await managed())?.state).toBe('idle');
    const nativeId = (await managed())!.nativeId!;
    const message = await fixture.runtime.request({
      kind: 'action',
      action: {
        id: randomUUID(),
        runtimeEpoch: fixture.runtime.runtimeEpoch,
        command: {
          kind: 'message',
          threadId,
          input: { kind: 'text', text: 'Start native history' },
        },
      },
    });
    await expect
      .poll(
        async () =>
          (await fixture.runtime.request({ kind: 'receipt', actionId: message.result.id })).result
            ?.completion,
      )
      .toBe('completed');
    const item = {
      id: 'question',
      type: 'agentMessage',
      delivery: 'async',
      text: 'Choose an environment',
      questions: [
        { title: 'Choose an environment', options: ['Staging', 'Production'] },
        { title: 'Anything else?', options: null },
      ],
    };
    const target = {
      threadId: nativeId,
      turnId: 'source-turn',
      completedAtMs: 1_800_000_001_123,
      item,
    };
    await writeFixtureControl(fixture.root, 'control.json', {
      emitOnce: true,
      emit: [
        { method: 'item/completed', params: { ...target, threadId: 'external-session' } },
        { method: 'item/started', params: target },
        { method: 'item/completed', params: target },
      ],
    });
    await fixture.runtime.request({ kind: 'usage', provider: 'codex' });
    await expect.poll(() => events.filter((event) => event.kind === 'item').length).toBe(1);
    const observed = events.find((event) => event.kind === 'item')!;
    if (observed.kind !== 'item') throw new Error('Missing completed item');
    expect(observed.source).toStrictEqual({
      threadId,
      provider: 'codex',
      nativeId,
      workspaceRoot: fixture.workspaceRoot,
    });
    expect(observed.item).toMatchObject({
      nativeId: 'question',
      turnId: 'source-turn',
      createdAt: 1_800_000_001_123,
      asyncInput: {
        delivery: 'async',
        state: 'available',
        questions: [
          { title: 'Choose an environment', options: ['Staging', 'Production'] },
          { title: 'Anything else?' },
        ],
      },
    });
    expect(failures.at(-1)).toStrictEqual({
      kind: 'recovery',
      provider: 'codex',
      source: null,
      reason: 'listener-failed',
    });
    const live = await fixture.request({ kind: 'live-items', threadId });
    expect(live.result.data.find((entry) => entry.nativeId === item.id)?.asyncInput).toStrictEqual(
      observed.item.asyncInput,
    );
    const source = {
      provider: 'codex' as const,
      workspaceRoot: fixture.workspaceRoot,
      nativeId,
      turnId: 'source-turn',
    };
    await writeFixtureControl(fixture.root, 'control.json', {
      items: [{ turnId: source.turnId, completedAtMs: target.completedAtMs, item }],
    });
    const saved = await fixture.request({ kind: 'items', ...source, textLimit: 1 });
    expect(saved.result.data[0]).toMatchObject({
      text: 'C',
      isTruncated: true,
      asyncInput: observed.item.asyncInput,
    });
    const detail = await fixture.request({ kind: 'item-detail', ...source, nativeItemId: item.id });
    expect(detail.result?.item.asyncInput).toStrictEqual(observed.item.asyncInput);
    const evidence = await fixture.request({ kind: 'session-evidence', ...source });
    expect(evidence.result.data[0]?.asyncInput).toStrictEqual(observed.item.asyncInput);
    expect(
      (await fixture.request({ kind: 'live-items', threadId })).result.data.some(
        (entry) => entry.nativeId === item.id,
      ),
    ).toBe(false);
    expect((await fixture.request({ kind: 'approvals', threadId })).result.data).toStrictEqual([]);
    const count = events.length;
    unsubscribe();
    stopFailure();
    stopMutation();
    await writeFixtureControl(fixture.root, 'control.json', {
      emitOnce: true,
      emit: [{ method: 'item/completed', params: target }],
    });
    await fixture.runtime.request({ kind: 'usage', provider: 'codex' });
    expect(events).toHaveLength(count);
    expect((await fixture.request({ kind: 'managed-thread', threadId })).result?.ownership).toBe(
      'managed',
    );
    const calls = (await readFile(join(fixture.root, 'calls.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
  });
});

test('async subscribers receive controlled output gaps and reconnect recovery and release at runtime shutdown', async () => {
  await withClaudeRuntime(async (fixture) => {
    const events: IAsyncInputEvent[] = [];
    fixture.runtime.observeAsyncInputs((event) => events.push(event));
    const created = await fixture.runtime.request({
      kind: 'action',
      action: {
        id: randomUUID(),
        runtimeEpoch: fixture.runtime.runtimeEpoch,
        command: {
          kind: 'thread-create',
          provider: 'codex',
          workspaceRoot: fixture.workspaceRoot,
          name: 'async-recovery',
        },
      },
    });
    const threadId = created.result.threadId!;
    const managed = async () =>
      (await fixture.runtime.request({ kind: 'managed-thread', threadId })).result;
    await expect.poll(async () => (await managed())?.state).toBe('idle');
    const nativeId = (await managed())!.nativeId!;
    await writeFixtureControl(fixture.root, 'control.json', {
      emitOnce: true,
      emit: [
        {
          method: 'item/completed',
          params: {
            threadId: nativeId,
            turnId: 'turn',
            item: { id: 'broken', type: 'commandExecution', command: 42 },
          },
        },
      ],
    });
    await fixture.runtime.request({ kind: 'usage', provider: 'codex' });
    await expect
      .poll(() =>
        events.some(
          (event) =>
            event.kind === 'recovery' &&
            event.reason === 'output-gap' &&
            event.source?.threadId === threadId,
        ),
      )
      .toBe(true);
    expect((await managed())?.ownership).toBe('managed');
    await writeFixtureControl(fixture.root, 'control.json', { disconnectOnce: true });
    await fixture.runtime.request({ kind: 'usage', provider: 'codex' });
    await expect
      .poll(() => events.some((event) => event.kind === 'recovery' && event.reason === 'reconnect'))
      .toBe(true);
    await fixture.runtime.close();
    const afterClose: IAsyncInputEvent[] = [];
    const unsubscribe = fixture.runtime.observeAsyncInputs((event) => afterClose.push(event));
    unsubscribe();
    unsubscribe();
    expect(afterClose).toStrictEqual([]);
  });
});

test('large async choices survive evidence response fitting and continuation intact', async () => {
  await withClaudeRuntime(async (fixture) => {
    const nativeId = 'thread-1023';
    const questions = [{ title: 'A'.repeat(8192), options: ['B'.repeat(8192), 'C'.repeat(8192)] }];
    const source = {
      provider: 'codex' as const,
      workspaceRoot: fixture.workspaceRoot,
      nativeId,
      turnId: 'turn-a',
    };
    await writeFixtureControl(fixture.root, 'control.json', {
      items: [
        {
          turnId: source.turnId,
          item: {
            id: 'first',
            type: 'agentMessage',
            delivery: 'async',
            text: '\u0000'.repeat(32_768),
            questions,
          },
        },
        {
          turnId: source.turnId,
          item: {
            id: 'second',
            type: 'agentMessage',
            delivery: 'async',
            text: 'Another question',
            questions,
          },
        },
      ],
    });
    let cursor: string | undefined;
    const texts = new Map<string, string>();
    let pages = 0;
    do {
      const response = await fixture.request({
        kind: 'session-evidence',
        ...source,
        cursor,
        limit: 8,
      });
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(65_280);
      for (const item of response.result.data) {
        expect(item.asyncInput).toStrictEqual({ delivery: 'async', state: 'available', questions });
        texts.set(item.reference.itemId, (texts.get(item.reference.itemId) ?? '') + item.text);
      }
      cursor = response.result.nextCursor ?? undefined;
      expect(++pages).toBeLessThan(128);
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(texts.get('first')).toBe('\u0000'.repeat(32_768));
    expect(texts.get('second')).toBe('Another question');
  });
});
