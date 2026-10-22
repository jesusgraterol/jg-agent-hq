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
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    input.close();process.stdin.destroy();
    if (nativeChild.exitCode !== null || nativeChild.signalCode !== null) return;
    nativeChild.once('close',() => { process.exitCode = 0; });
    nativeChild.kill('SIGTERM');
  };
  process.on('SIGTERM',shutdown);
  input.on('close',shutdown);
  const controls = () => JSON.parse(readFileSync(join(directory,'control.json'),'utf8'));
  const threads = Array.from({ length: 1024 },(_,index) => ({ id: 'thread-'+String(index).padStart(4,'0'), cwd: workspaceRoot, name: 'Task '+index, createdAt: 1_700_000_000 + Math.floor(index/2), updatedAt: 1_700_000_100, status: { type: 'notLoaded' } })).reverse();
  const respond = (id,result) => process.stdout.write(JSON.stringify({ id,result })+'\n');
  const notify = (method,params) => process.stdout.write(JSON.stringify({ method,params })+'\n');
  const managed = new Map();
  let threadSequence = 0;
  let turnSequence = 0;
  const interrupts = [];
  const complete = (threadId,status = 'completed') => {
    const thread = managed.get(threadId);
    if (!thread?.activeTurn) return;
    notify('turn/completed',{threadId,turn:{id:thread.activeTurn,status}});
    thread.activeTurn = null;
  };
  input.on('line',(line) => {
    const request = JSON.parse(line);
    const control = controls();
    if (!request.method) {
      appendFileSync(join(directory,'replies.jsonl'),JSON.stringify(request)+'\n');
      const threadId = control.promptThread || [...managed.keys()].at(-1);
      if (control.replyResolutionDelay) setTimeout(() => notify('serverRequest/resolved',{threadId,requestId:request.id}),control.replyResolutionDelay);
      else notify('serverRequest/resolved',{threadId,requestId:request.id});
      if (control.completeOnReply) complete(threadId);
      return;
    }
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
    if (control.emit) for (const event of control.emit) notify(event.method,event.params);
    if (method === 'skills/extraRoots/set') {respond(request.id,{});return;}
    if (method === 'skills/list') {
      if(control.releaseThreadId)complete(control.releaseThreadId);
      if(control.skillsFailure){respond(request.id,{data:'invalid'});return;}
      const skills = Array.from({length:control.skillNames?.length??control.skillCount??2},(_,index)=>{
        const name=control.skillNames?.[index]??(index===0&&control.planSkill?control.planSkill:(control.skillRevision?'changed-':'')+(index===0?'explicit-skill':index===1?'implicit-skill':'skill-'+index));
        return {name,description:control.skillDescriptionSize?'d'.repeat(control.skillDescriptionSize):'Native installed skill '+index,path:join(directory,'skills',name,'SKILL.md'),scope:'user',enabled:!(control.disabledSkill&&index===0),dependencies:{tools:[{type:'mcp',value:'example',description:'Native declared prerequisite'}]}};
      });
      respond(request.id,{data:[{cwd:control.wrongSkillRoot??params.cwds[0],skills,errors:control.skillErrors?[{}]:[]}]});return;
    }
    if (method === 'thread/start') {
      const thread = { ...threads[0],id:'native-'+(++threadSequence),cwd:params.cwd,name:null,status:{type:'idle'},activeTurn:null };
      managed.set(thread.id,thread);
      respond(request.id,{thread});return;
    }
    if (method === 'thread/resume') {
      const thread = managed.get(params.threadId) || { ...threads[0],id:params.threadId,activeTurn:null };
      thread.status = {type:'idle'}; managed.set(thread.id,thread);
      respond(request.id,{thread});return;
    }
    if (method === 'thread/name/set') { managed.get(params.threadId).name=params.name;respond(request.id,{});return; }
    if (method === 'turn/start') {
      const skill = params.input?.find(item => item.type === 'skill')?.name;
      const documents = control.planningSources?.[skill];
      if (documents) {
        // Test-owned provider output only; the real HQ observes these files afterward.
        for (const filename of ['plan.md', 'milestones.md'])
          if (documents[filename] !== undefined)
            writeFileSync(join(workspaceRoot, 'example-plan', filename), documents[filename]);
      }
      if (control.rejectTurn) { process.stdout.write(JSON.stringify({id:request.id,error:{code:-32602,message:'Synthetic input rejection'}})+'\n');return; }
      const thread = managed.get(params.threadId);
      const turn = {id:'native-turn-'+(++turnSequence),status:'inProgress'};
      thread.activeTurn=turn.id;
      notify('turn/started',{threadId:thread.id,turn});
      const item = {id:'live-'+turnSequence,type:'agentMessage',text:''};
      notify('item/started',{threadId:thread.id,turnId:turn.id,item});
      notify('item/agentMessage/delta',{threadId:thread.id,turnId:turn.id,itemId:item.id,delta:'Live response'});
      if (control.prompt) process.stdout.write(JSON.stringify({id:'native-approval-'+turnSequence,method:control.prompt.method,params:{threadId:thread.id,turnId:turn.id,itemId:'tool-'+turnSequence,...control.prompt.params}})+'\n');
      if (control.loseOutput) { process.stdout.end();return; }
      const acknowledge = () => respond(request.id,{turn});
      if (control.lateTurnAck) setTimeout(acknowledge,31_000); else acknowledge();
      if (!control.holdTurn && !control.prompt) {
        notify('item/completed',{threadId:thread.id,turnId:turn.id,item:{...item,text:'Live response'}});
        complete(thread.id);
      }
      return;
    }
    if (method === 'turn/steer') {
      if (control.completeOnSteer) complete(params.threadId);
      if (managed.get(params.threadId)?.activeTurn !== params.expectedTurnId) { process.stdout.write(JSON.stringify({id:request.id,error:{code:-32602,message:'Turn no longer active'}})+'\n');return; }
      respond(request.id,{turnId:params.expectedTurnId});return;
    }
    if (method === 'turn/interrupt') {
      if (control.interruptBarrier) {
        interrupts.push(request);
        if (interrupts.length >= control.interruptBarrier) for (const pending of interrupts.splice(0)) {
          respond(pending.id,{});
          complete(pending.params.threadId,'interrupted');
        }
        return;
      }
      respond(request.id,{});
      setTimeout(() => complete(params.threadId,'interrupted'),control.interruptDelay || 1);
      return;
    }
    if (method === 'thread/backgroundTerminals/clean') { respond(request.id,{});return; }
    if (method === 'thread/backgroundTerminals/list') { respond(request.id,{data:control.backgroundRemaining?[{id:'remaining-task'}]:[],nextCursor:null});return; }
    if (method === 'thread/unsubscribe') { managed.get(params.threadId).status={type:control.unsubscribeState??'notLoaded'};respond(request.id,{status:'unsubscribed'});return; }
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
    if (method === 'thread/read') { respond(request.id,{ thread: { ...threads[0],...managed.get(params.threadId),id: params.threadId,cwd: control.wrongRoot || workspaceRoot } });return; }
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
