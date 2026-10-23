import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hasErrorCode } from 'jg-exception';
import { expectToRejectCode } from 'jg-exception/testing';
import { abortable } from 'jg-utilities';
import { createAgentHq } from 'jg-agent-hq';
import type { IActionCommand, IActionReceipt } from 'jg-agent-hq/contracts';
import { expect, onTestFinished, test } from 'vitest';
import { z } from 'zod';

import {
  withClaudeRuntime,
  writeFixtureControl,
  type IClaudeFixture,
} from '../../scripts/test-support/index.js';

const submit = async (
  fixture: IClaudeFixture,
  command: IActionCommand,
  id: string = randomUUID(),
): Promise<IActionReceipt> => {
  const status = await fixture.request({ kind: 'status' });
  if (status.kind !== 'status') throw new Error('Missing status');
  const response = await fixture.request({
    kind: 'action',
    action: { id, runtimeEpoch: status.result.runtimeEpoch, command },
  });
  if (response.kind !== 'action') throw new Error('Missing action');
  return response.result;
};
const receipt = async (fixture: IClaudeFixture, id: string): Promise<IActionReceipt> => {
  const response = await fixture.request({ kind: 'receipt', actionId: id });
  if (response.kind !== 'receipt' || !response.result) throw new Error('Missing receipt');
  return response.result;
};
const settle = async (fixture: IClaudeFixture, id: string): Promise<IActionReceipt> => {
  await expect.poll(async () => (await receipt(fixture, id)).delivery).not.toBe('submitted');
  return receipt(fixture, id);
};
const confirmation = 'Use this disposable native account configuration';

test.each(['codex', 'claude'])(
  'account(%s) exposes metadata without credentials',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const response = await fixture.request({ kind: 'account', provider });
      expect(response).toMatchObject({
        kind: 'account',
        result: { provider, state: 'available', email: 'fixture@example.com' },
      });
      expect(JSON.stringify(response)).not.toContain('credential-must-not-be-returned');
    });
  },
);

test.each(['codex', 'claude'])(
  'missing optional account metadata leaves %s session controls available',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      if (provider === 'codex')
        await writeFixtureControl(fixture.root, 'control.json', { accountUnavailable: true });
      else await fixture.control({ accountUnavailable: true });
      expect(await fixture.request({ kind: 'account', provider })).toMatchObject({
        kind: 'account',
        result: { state: 'unavailable' },
      });
      const created = await submit(fixture, {
        kind: 'thread-create',
        provider,
        workspaceRoot: fixture.workspaceRoot,
        name: 'optional-account',
      });
      expect((await settle(fixture, created.id)).delivery).toBe('acknowledged');
    });
  },
);

test('native account login has live-only presentation, idempotent dispatch, and a provider-scoped execution fence', async () => {
  await withClaudeRuntime(async (fixture) => {
    const command = {
      kind: 'account-login',
      provider: 'codex',
      operatorConfirmation: confirmation,
    } as const;
    const started = await submit(fixture, command, '00000000-0000-4000-8000-000000000001');
    expect(await settle(fixture, started.id)).toMatchObject({
      delivery: 'acknowledged',
      controlState: 'accepted',
      completion: null,
      provider: 'codex',
      threadId: null,
    });
    expect(await fixture.request({ kind: 'login', actionId: started.id })).toMatchObject({
      kind: 'login',
      result: {
        state: 'pending',
        authorizationUrl: 'https://auth.example.test/authorize?state=transient-challenge',
        canCancel: true,
      },
    });
    await submit(fixture, command, started.id);
    const calls = (await readFile(join(fixture.root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method: string });
    expect(calls.filter((call) => call.method === 'account/login/start')).toHaveLength(1);
    const blocked = await submit(
      fixture,
      {
        kind: 'thread-create',
        provider: 'codex',
        workspaceRoot: fixture.workspaceRoot,
        name: 'blocked-auth',
      },
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
    );
    expect(blocked).toMatchObject({ delivery: 'failed', failure: 'state-conflict' });
    const unrelated = await submit(fixture, {
      kind: 'thread-create',
      provider: 'claude',
      workspaceRoot: fixture.workspaceRoot,
      name: 'other-provider',
    });
    expect((await settle(fixture, unrelated.id)).delivery).toBe('acknowledged');
    const database = new DatabaseSync(fixture.runtime.storage.databasePath, { readOnly: true });
    try {
      expect(
        JSON.stringify(
          database
            .prepare(
              'SELECT id, kind, control_state, completion, result, queued_input FROM hq_action',
            )
            .all(),
        ),
      ).not.toContain('transient-challenge');
    } finally {
      database.close();
    }
    const actions = await fixture.request({
      kind: 'provider-actions',
      provider: 'codex',
      limit: 1,
    });
    expect(actions).toMatchObject({
      kind: 'provider-actions',
      result: { data: [{ id: blocked.id }], nextCursor: expect.any(String) },
    });
    if (actions.kind !== 'provider-actions' || !actions.result.nextCursor)
      throw new Error('Missing provider cursor');
    expect(
      await fixture.request({
        kind: 'provider-actions',
        provider: 'codex',
        limit: 1,
        cursor: actions.result.nextCursor,
      }),
    ).toMatchObject({
      kind: 'provider-actions',
      result: { data: [{ id: started.id }], nextCursor: null },
    });
    await expectToRejectCode(
      fixture.request({
        kind: 'provider-actions',
        provider: 'claude',
        limit: 1,
        cursor: actions.result.nextCursor,
      }),
      'JG_AGENT_HQ_CLIENT_INVALID_REQUEST',
    );
  });
});

test.each([false, true])(
  'account cancellation resolves the exact login when the completion notification precedes its acknowledgement: %s',
  async (cancelNotifiesEarly) => {
    await withClaudeRuntime(async (fixture) => {
      await writeFixtureControl(fixture.root, 'control.json', { cancelNotifiesEarly });
      const started = await submit(fixture, {
        kind: 'account-login',
        provider: 'codex',
        operatorConfirmation: confirmation,
      });
      await settle(fixture, started.id);
      const canceled = await submit(fixture, {
        kind: 'account-login-cancel',
        provider: 'codex',
        loginActionId: started.id,
        operatorConfirmation: confirmation,
      });
      expect(await settle(fixture, canceled.id)).toMatchObject({
        delivery: 'acknowledged',
        controlState: 'applied',
      });
      await expect
        .poll(async () => (await receipt(fixture, started.id)).completion)
        .toBe('interrupted');
      expect(await fixture.request({ kind: 'login', actionId: started.id })).toMatchObject({
        kind: 'login',
        result: { state: 'canceled', authorizationUrl: null, canCancel: false },
      });
    });
  },
);

test.each([false, true])(
  'account completion reconciles the exact action before/after initiation acknowledgement: %s',
  async (loginCompletesEarly) => {
    await withClaudeRuntime(async (fixture) => {
      await writeFixtureControl(fixture.root, 'control.json', {
        loginCompletes: !loginCompletesEarly,
        loginCompletesEarly,
        duplicateLoginCompletion: true,
      });
      const started = await submit(fixture, {
        kind: 'account-login',
        provider: 'codex',
        operatorConfirmation: confirmation,
      });
      await expect
        .poll(async () => (await receipt(fixture, started.id)).completion)
        .toBe('completed');
      expect(await fixture.request({ kind: 'login', actionId: started.id })).toMatchObject({
        kind: 'login',
        result: { state: 'completed', authorizationUrl: null },
      });
    });
  },
);

test('unrelated native login completion cannot resolve another action', async () => {
  await withClaudeRuntime(async (fixture) => {
    await writeFixtureControl(fixture.root, 'control.json', {
      loginCompletesEarly: true,
      wrongLoginId: true,
    });
    const started = await submit(fixture, {
      kind: 'account-login',
      provider: 'codex',
      operatorConfirmation: confirmation,
    });
    expect(await settle(fixture, started.id)).toMatchObject({
      completion: null,
      controlState: 'accepted',
    });
  });
});

test.each(['codex', 'claude'])(
  'account logout(%s) changes native auth observations and requires managed sessions to be closed',
  async (provider) => {
    await withClaudeRuntime(async (fixture) => {
      const created = await submit(fixture, {
        kind: 'thread-create',
        provider,
        workspaceRoot: fixture.workspaceRoot,
        name: 'before-logout',
      });
      await settle(fixture, created.id);
      const blocked = await submit(fixture, {
        kind: 'account-logout',
        provider,
        operatorConfirmation: confirmation,
      });
      expect(blocked).toMatchObject({ delivery: 'failed', failure: 'state-conflict' });
      const closed = await submit(fixture, { kind: 'thread-close', threadId: created.threadId! });
      await settle(fixture, closed.id);
      const signedOut = await submit(fixture, {
        kind: 'account-logout',
        provider,
        operatorConfirmation: confirmation,
      });
      expect(await settle(fixture, signedOut.id)).toMatchObject({
        delivery: 'acknowledged',
        controlState: 'applied',
        completion: 'completed',
      });
      const account = await fixture.request({ kind: 'account', provider });
      expect(account).toMatchObject({
        kind: 'account',
        result:
          provider === 'codex'
            ? { state: 'available', accountType: null }
            : { state: 'unavailable' },
      });
    });
  },
);

test('restart retains authentication receipts without replaying login or retaining its URL', async () => {
  await withClaudeRuntime(async (fixture) => {
    const started = await submit(fixture, {
      kind: 'account-login',
      provider: 'codex',
      operatorConfirmation: confirmation,
    });
    await settle(fixture, started.id);
    await fixture.runtime.close();
    const restarted = await createAgentHq({
      stateRoot: fixture.stateRoot,
      allowedRoots: [fixture.workspaceRoot],
    });
    try {
      expect(await fixture.request({ kind: 'login', actionId: started.id })).toMatchObject({
        kind: 'login',
        result: { state: 'unavailable', authorizationUrl: null },
      });
      expect(await receipt(fixture, started.id)).toMatchObject({
        delivery: 'acknowledged',
        completion: null,
      });
      expect(
        (await readFile(join(fixture.root, 'calls.jsonl'), 'utf8')).match(/account\/login\/start/g),
      ).toHaveLength(1);
    } finally {
      await restarted.close();
    }
  });
});

test('native authentication rejection is a failed receipt and does not expose provider diagnostics', async () => {
  await withClaudeRuntime(async (fixture) => {
    await writeFixtureControl(fixture.root, 'control.json', { rejectAuth: true });
    const started = await submit(fixture, {
      kind: 'account-login',
      provider: 'codex',
      operatorConfirmation: confirmation,
    });
    const failed = await settle(fixture, started.id);
    expect(failed).toMatchObject({ delivery: 'failed', failure: 'agent-unavailable' });
    expect(JSON.stringify(failed)).not.toContain('Sensitive native failure');
    expect(await fixture.request({ kind: 'login', actionId: started.id })).toMatchObject({
      kind: 'login',
      result: { state: 'unavailable', authorizationUrl: null },
    });
  });
});

test(
  'late native login initiation reconciles an earlier terminal result without replay',
  { timeout: 45_000 }, // exercises the native 30-second request deadline and late initiation acknowledgement
  async () => {
    await withClaudeRuntime(async (fixture) => {
      await writeFixtureControl(fixture.root, 'control.json', {
        lateAuth: true,
        loginCompletesEarly: true,
      });
      const started = await submit(fixture, {
        kind: 'account-login',
        provider: 'codex',
        operatorConfirmation: confirmation,
      });
      await expect
        .poll(async () => (await receipt(fixture, started.id)).delivery, { timeout: 33_000 })
        .toBe('uncertain');
      await expect
        .poll(async () => (await receipt(fixture, started.id)).completion, { timeout: 8_000 })
        .toBe('completed');
      expect(await fixture.request({ kind: 'login', actionId: started.id })).toMatchObject({
        kind: 'login',
        result: { state: 'completed', authorizationUrl: null },
      });
      expect(
        (await readFile(join(fixture.root, 'calls.jsonl'), 'utf8')).match(/account\/login\/start/g),
      ).toHaveLength(1);
    });
  },
);

test(
  'unconfirmed native logout cleanup retains runtime ownership',
  { timeout: 30_000 }, // allows the isolated controller deadline and verified process teardown
  async () => {
    await withClaudeRuntime(async (fixture) => {
      const source = String.raw`
      import {existsSync,readFileSync} from 'node:fs';
      import {join} from 'node:path';
      import {setTimeout as wait} from 'node:timers/promises';
      import {createAgentHq} from 'jg-agent-hq';
      const root=process.argv[1],workspaceRoot=process.argv[2];
      const originalKill=process.kill.bind(process);
      process.kill=(pid,signal)=>{
        if(pid<0&&signal===0){
          let logout;
          try{logout=JSON.parse(readFileSync(join(root,'claude-logout-pid.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
          if(logout?.pid===-pid)throw Object.assign(new Error('Synthetic native group probe failure'),{code:'EPERM'});
        }
        return originalKill(pid,signal);
      };
      const stateRoot=join(root,'fault-state');
      let hq;
      try{
        hq=await createAgentHq({stateRoot,allowedRoots:[workspaceRoot]});
        const epoch=(await hq.request({kind:'status'})).result.runtimeEpoch;
        const action=(await hq.request({kind:'action',action:{id:crypto.randomUUID(),runtimeEpoch:epoch,command:{kind:'account-logout',provider:'claude',operatorConfirmation:'Disposable cleanup qualification'}}})).result;
        const deadline=Date.now()+5000;
        let delivery;
        do{delivery=(await hq.request({kind:'receipt',actionId:action.id})).result.delivery;if(delivery!=='submitted')break;await wait(32);}while(Date.now()<deadline);
        if(delivery!=='uncertain')throw new Error('Logout must retain uncertain delivery');
        let closeFailed=false;
        try{await hq.close();}catch{closeFailed=true;}
        const result={closeFailed,ownerRetained:existsSync(join(stateRoot,'hq-owner.json'))};
        process.kill=originalKill;
        process.stdout.write(JSON.stringify(result)+'\n',()=>process.exit(0));
      }catch(error){process.kill=originalKill;await hq?.close().catch(()=>{});process.stderr.write(String(error));process.exit(1);}
    `;
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', source, fixture.root, fixture.workspaceRoot],
        { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const closed = once(child, 'close');
      let stdout = '',
        stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk) => {
        stderr += chunk;
      });
      let cleanup: Promise<void> | undefined;
      const cleanupChild = (): Promise<void> =>
        (cleanup ??= (async () => {
          const stop = (pid: number, signal: NodeJS.Signals): void => {
            try {
              process.kill(-pid, signal);
            } catch (error) {
              if (!hasErrorCode(error, 'ESRCH')) throw error;
            }
          };
          if (child.pid) stop(child.pid, 'SIGTERM');
          try {
            await abortable(closed, { signal: AbortSignal.timeout(5000) });
          } catch (error) {
            if (child.pid) stop(child.pid, 'SIGKILL');
            await closed;
          }
          for (const filename of ['claude-read-pids.jsonl', 'claude-pids.jsonl']) {
            const lines = (await readFile(join(fixture.root, filename), 'utf8'))
              .trim()
              .split('\n')
              .filter(Boolean);
            for (const line of lines) {
              const pids = z
                .record(z.string(), z.number().int().positive())
                .parse(JSON.parse(line));
              if (pids.pid) stop(pids.pid, 'SIGKILL');
            }
          }
        })());
      onTestFinished(cleanupChild);
      try {
        const [code] = await abortable(closed, { signal: AbortSignal.timeout(15000) });
        expect(code, stderr).toBe(0);
        const result = z
          .strictObject({ closeFailed: z.boolean(), ownerRetained: z.boolean() })
          .parse(JSON.parse(stdout));
        expect(result).toStrictEqual({ closeFailed: true, ownerRetained: true });
      } finally {
        await cleanupChild();
      }
    });
  },
);
