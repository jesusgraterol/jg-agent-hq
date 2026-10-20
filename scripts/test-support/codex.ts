import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// a synthetic external CLI boundary; the actual runtime/IPC/worker remain real in tests
const FIXTURE_SOURCE = String.raw`#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
if (process.argv.includes('--version')) { process.stdout.write('codex-cli 0.163.0\n'); }
else {
  const directory = process.env.JG_HQ_FIXTURE_DIRECTORY;
  const workspaceRoot = process.env.JG_HQ_FIXTURE_WORKSPACE;
  const nativeChild = spawn(process.execPath,['-e','setInterval(() => {},60000)'],{ stdio: 'ignore' });
  writeFileSync(join(directory,'pids.json'),JSON.stringify({ parent: process.pid, child: nativeChild.pid }));
  const input = createInterface({ input: process.stdin });
  let shuttingDown = false;
  process.on('SIGTERM',() => {
    if (shuttingDown) return;
    shuttingDown = true;
    input.close();process.stdin.destroy();
    if (nativeChild.exitCode !== null || nativeChild.signalCode !== null) return;
    nativeChild.once('close',() => { process.exitCode = 0; });
    nativeChild.kill('SIGTERM');
  });
  const controls = () => JSON.parse(readFileSync(join(directory,'control.json'),'utf8'));
  const threads = Array.from({ length: 1024 },(_,index) => ({ id: 'thread-'+String(index).padStart(4,'0'), cwd: workspaceRoot, name: 'Task '+index, createdAt: 1_700_000_000 + Math.floor(index/2), updatedAt: 1_700_000_100, status: { type: 'notLoaded' } })).reverse();
  const respond = (id,result) => process.stdout.write(JSON.stringify({ id,result })+'\n');
  input.on('line',(line) => {
    const request = JSON.parse(line);
    const control = controls();
    appendFileSync(join(directory,'calls.jsonl'),JSON.stringify({ method: request.method, params: request.params })+'\n');
    if (request.id === undefined) return;
    if (request.method === 'initialize') {
      if (control.mode === 'malformed') { process.stdout.write('invalid JSON\n');return; }
      if (control.mode === 'oversized') { process.stdout.write('x'.repeat(8_388_609));return; }
      if (control.mode === 'partial') { process.stdout.end('{"id":1,"result":');return; }
      if (control.mode === 'empty') { process.stdout.end();return; }
      respond(request.id,{ userAgent: 'codex-cli/fixture' });return;
    }
    const { method,params = {} } = request;
    if (method === 'thread/list') {
      if (control.mode === 'exit-on-list') { process.stdout.end();return; }
      if (control.notifyUsage) {
        const params = { rateLimits: { primary: { usedPercent: control.usedPercent ?? 25 } } };
        process.stdout.write(JSON.stringify({ method: 'account/rateLimits/updated', params })+'\n');
        process.stdout.write(JSON.stringify({ method: 'account/rateLimits/updated', params })+'\n');
      }
      if (control.accountChanged) process.stdout.write(JSON.stringify({ method: 'account/updated', params: {} })+'\n');
      const selected = params.searchTerm ? threads.filter((thread) => thread.name.includes(params.searchTerm)) : threads;
      const after = params.cursor ? selected.findIndex((thread) => thread.id === params.cursor) + 1 : 0;
      const batch = selected.slice(after,after+params.limit);
      respond(request.id,{ data: control.wrongRoot ? batch.map((thread) => ({ ...thread,cwd: control.wrongRoot })) : batch, nextCursor: control.invalidCursor ? 'x'.repeat(8193) : after+batch.length < selected.length ? batch.at(-1).id : null });return;
    }
    if (method === 'thread/read') { respond(request.id,{ thread: { ...threads[0],id: params.threadId,cwd: control.wrongRoot || workspaceRoot } });return; }
    if (method === 'thread/turns/list') { respond(request.id,{ data: [{ id: 'turn-a',status: 'completed',startedAt: 1_700_000_000,completedAt: 1_700_000_001 }],nextCursor: null });return; }
    if (method === 'thread/items/list') {
      const text = control.largeItem ? 'a'.repeat(1_048_576) : 'Hello from the native history';
      respond(request.id,{ data: control.awaitingFlush ? [] : control.items ?? [{ turnId: 'turn-a',item: { id: 'item-a',type: 'agentMessage',text } }],nextCursor: null });return;
    }
    if (method === 'account/rateLimits/read') {
      if (control.accountChangedDuringRead) process.stdout.write(JSON.stringify({ method: 'account/updated', params: {} })+'\n');
      if (control.quotaFailure) { process.stdout.write(JSON.stringify({ id: request.id,error: { code: -32603,message: 'synthetic account failure' } })+'\n');return; }
      const bucket = { limitId: 'codex',limitName: 'Codex',primary: { usedPercent: control.usedPercent ?? 25,windowDurationMins: 300,resetsAt: control.expired ? Math.floor(Date.now()/1000)-1 : Math.floor(Date.now()/1000)+3600 },secondary: null,rateLimitReachedType: control.exhausted ? 'reached' : null };
      respond(request.id,{ rateLimits: bucket, rateLimitsByLimitId: control.noWindows ? null : { codex: bucket },ordinaryUsageAllowed: !control.exhausted });return;
    }
    process.stdout.write(JSON.stringify({ id: request.id,error: { code: -32601,message: 'Unsupported method' } })+'\n');
  });
}
`;

/** Installs one disposable native-boundary fixture in a caller-owned test directory. */
export const installCodexFixture = async (directory: string): Promise<string> => {
  const bin = join(directory, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(directory, 'control.json'), '{}');
  await writeFile(join(directory, 'calls.jsonl'), '');
  await writeFile(join(bin, 'codex'), FIXTURE_SOURCE, { mode: 0o755 });
  return bin;
};
