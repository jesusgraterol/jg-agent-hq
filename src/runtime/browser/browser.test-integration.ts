import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentHq, type IAgentHq } from 'jg-agent-hq';
import type { IBrowserAction } from 'jg-agent-hq/contracts';
import { expect, test, vi } from 'vitest';

import { installCodexFixture } from '../../../scripts/test-support/index.js';

const withRuntime = async (
  run: (fixture: {
    runtime: IAgentHq;
    stateRoot: string;
    root: string;
    workspaceRoot: string;
    reopen: () => Promise<IAgentHq>;
  }) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), 'hq-browser-'));
  const stateRoot = join(root, 'state');
  const workspaceRoot = join(root, 'workspace');
  let runtime: IAgentHq | undefined;
  try {
    await mkdir(workspaceRoot);
    const bin = await installCodexFixture(root);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    vi.stubEnv('JG_HQ_FIXTURE_DIRECTORY', root);
    vi.stubEnv('JG_HQ_FIXTURE_WORKSPACE', workspaceRoot);
    const reopen = async () =>
      (runtime = await createAgentHq({ stateRoot, allowedRoots: [workspaceRoot] }));
    runtime = await reopen();
    await run({ runtime, root, stateRoot, workspaceRoot, reopen });
  } finally {
    await runtime?.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
};

const requestFor = async (runtime: IAgentHq): Promise<IBrowserAction> => {
  const status = await runtime.request({ kind: 'status' });
  if (status.kind !== 'status') throw new Error('unexpected status');
  return {
    id: randomUUID(),
    runtimeEpoch: status.result.runtimeEpoch,
    command: {
      kind: 'plan',
      command: { kind: 'status', target: { directory: '/operator-choice' } },
    },
  };
};

test('concurrent identical requests invoke the host once; payload and operator conflicts cannot replace its receipt', async () => {
  await withRuntime(async ({ runtime, stateRoot }) => {
    const input = await requestFor(runtime);
    const execute = vi.fn(async () => undefined);
    const receipts = await Promise.all(
      Array.from({ length: 16 }, () => runtime.performBrowserAction(input, 'operator', execute)),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      receipts.every((receipt) => receipt.nativeActionId === receipts[0]!.nativeActionId),
    ).toBe(true);
    expect((await runtime.readBrowserAction(input.id, 'operator'))?.state).toBe('acknowledged');
    expect(await runtime.readBrowserAction(input.id, 'someone-else')).toBeNull();
    await expect(
      runtime.performBrowserAction(
        {
          ...input,
          command: {
            kind: 'plan',
            command: { kind: 'status', target: { directory: '/another-plan' } },
          },
        },
        'operator',
        execute,
      ),
    ).rejects.toThrow('conflicts');
    await expect(runtime.performBrowserAction(input, 'someone-else', execute)).rejects.toThrow(
      'conflicts',
    );
    expect(execute).toHaveBeenCalledTimes(1);
    await runtime.close();
    const database = await readFile(join(stateRoot, 'hq.sqlite'));
    expect(database.includes(Buffer.from('/operator-choice'))).toBe(false);
  });
});

test('an effect followed by failure remains uncertain across reconnect and runtime restart', async () => {
  await withRuntime(async ({ runtime, reopen }) => {
    const input = await requestFor(runtime);
    const execute = vi.fn(async () => {
      throw new Error('response lost after effect');
    });
    await expect(runtime.performBrowserAction(input, 'operator', execute)).rejects.toThrow(
      'response lost',
    );
    expect((await runtime.readBrowserAction(input.id, 'operator'))?.state).toBe('uncertain');
    await runtime.performBrowserAction(input, 'operator', execute);
    await runtime.close();
    const next = await reopen();
    expect((await next.performBrowserAction(input, 'operator', execute)).state).toBe('uncertain');
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(
      next.performBrowserAction({ ...input, id: randomUUID() }, 'operator', execute),
    ).rejects.toThrow('conflicts');
  });
});

test('shutdown drains admitted host work and rejects new work before releasing SQLite', async () => {
  await withRuntime(async ({ runtime }) => {
    const input = await requestFor(runtime);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const effect = runtime.performBrowserAction(input, 'operator', async () => {
      entered();
      await gate;
    });
    await started;
    const closing = runtime.close();
    await expect(
      runtime.performBrowserAction(
        { ...input, id: randomUUID() },
        'operator',
        async () => undefined,
      ),
    ).rejects.toThrow('conflicts');
    release();
    expect((await effect).state).toBe('acknowledged');
    await closing;
  });
});

test('native effects reconcile the exact server-owned child action instead of accepting an unrelated client nonce', async () => {
  await withRuntime(async ({ runtime, workspaceRoot }) => {
    const input = await requestFor(runtime);
    const native: IBrowserAction = {
      ...input,
      command: {
        kind: 'native',
        action: {
          id: randomUUID(),
          runtimeEpoch: input.runtimeEpoch,
          command: {
            kind: 'thread-create',
            provider: 'codex',
            workspaceRoot,
            name: 'browser-check',
          },
        },
      },
    };
    const receipt = await runtime.performBrowserAction(
      native,
      'operator',
      async (action, nativeActionId) => {
        if (action.command.kind !== 'native') throw new Error('unexpected command');
        await runtime.request({
          kind: 'action',
          action: { ...action.command.action, id: nativeActionId },
        });
      },
    );
    expect(receipt.native?.id).toBe(receipt.nativeActionId);
    expect(receipt.native?.kind).toBe('thread-create');
    expect(receipt.native?.threadId).not.toBeNull();
    expect(receipt.native?.completion).toBeNull();
    expect(
      await runtime.request({ kind: 'thread-plan', threadId: receipt.native!.threadId! }),
    ).toStrictEqual({ kind: 'thread-plan', result: null });
  });
});

test('startup quarantines a submitted receipt and never dispatches it automatically', async () => {
  await withRuntime(async ({ runtime, stateRoot, reopen }) => {
    const input = await requestFor(runtime);
    await runtime.performBrowserAction(input, 'operator', async () => undefined);
    await runtime.close();
    const database = new DatabaseSync(join(stateRoot, 'hq.sqlite'));
    try {
      database
        .prepare(
          "UPDATE hq_browser_action SET receipt = json_set(receipt, '$.state', 'submitted') WHERE id = ?",
        )
        .run(input.id);
    } finally {
      database.close();
    }
    const next = await reopen();
    const execute = vi.fn(async () => undefined);
    expect((await next.performBrowserAction(input, 'operator', execute)).state).toBe('uncertain');
    expect(execute).not.toHaveBeenCalled();
  });
});

test('host admission capacity is bounded and a rejected request has no receipt or effect', async () => {
  await withRuntime(async ({ runtime }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const input = await requestFor(runtime);
    const execute = vi.fn(async () => gate);
    const jobs = Array.from({ length: 32 }, () =>
      runtime.performBrowserAction({ ...input, id: randomUUID() }, 'operator', execute),
    );
    const overflow = { ...input, id: randomUUID() };
    try {
      await expect(runtime.performBrowserAction(overflow, 'operator', execute)).rejects.toThrow(
        'conflicts',
      );
      expect(await runtime.readBrowserAction(overflow.id, 'operator')).toBeNull();
    } finally {
      release();
      await Promise.all(jobs);
    }
    expect(execute).toHaveBeenCalledTimes(32);
  });
});
