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
  const toolCalls = new Map();
  let threadSequence = 0;
  let turnSequence = 0;
  const interrupts = [];
  const logins=new Map();
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
      if(toolCalls.has(request.id)) {
        const {threadId,turnId}=toolCalls.get(request.id);toolCalls.delete(request.id);
        notify('item/completed',{threadId,turnId,item:{id:'tool-result-'+turnId,type:'agentMessage',text:JSON.stringify(control.structuredOutput??request.result??request.error)}});
        complete(threadId);return;
      }
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
      respond(request.id,{ ...(control.omitVersion?{}:{userAgent:control.version??'codex-cli/fixture'}), futureMetadata:control.futureMetadata });return;
    }
    const { method,params = {} } = request;
    if (control.emitOnce) writeFileSync(join(directory,'control.json'),JSON.stringify({...control,emit:undefined,emitOnce:undefined}));
    if (control.emit) for (const event of control.emit) notify(event.method,event.params);
    if (method === 'model/list') {
      const choices = Array.from({length:control.modelCount??4},(_,index)=>({id:'model-'+String(index).padStart(4,'0'),model:'model-'+String(index).padStart(4,'0'),displayName:'Native model '+index,description:control.modelRevision?'Updated choice':'Native model choice',supportedReasoningEfforts:[{reasoningEffort:control.modelEffort??'native-effort'}],defaultReasoningEffort:control.modelEffort??'native-effort',isDefault:index===0}));
      if(control.modelsMalformed)choices[0].id='';
      const offset=params.cursor?Number(params.cursor.split(':')[1]):0;
      respond(request.id,{data:choices.slice(offset,offset+params.limit),nextCursor:offset+params.limit<choices.length?'models:'+String(offset+params.limit):null});return;
    }
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
    if(method==='account/login/start'||method==='mcpServer/oauth/login'){
      if(control.rejectAuth){process.stdout.write(JSON.stringify({id:request.id,error:{code:-32603,message:'Sensitive native failure must not escape'}})+'\n');return;}
      const loginId=control.sharedMcpLoginId&&method==='mcpServer/oauth/login'?'shared-native-login':'login-'+request.id;
      const kind=method==='account/login/start'?'account':'mcp';
      logins.set(loginId,{kind,threadId:params.threadId,name:params.name});
      const completeLogin=()=>{notify(kind==='account'?'account/login/completed':'mcpServer/oauthLogin/completed',{loginId:control.wrongLoginId?'unrelated-login':loginId,success:control.loginFails?false:true,threadId:params.threadId,name:params.name});if(control.duplicateLoginCompletion)notify(kind==='account'?'account/login/completed':'mcpServer/oauthLogin/completed',{loginId,success:true,threadId:params.threadId,name:params.name});};
      if(control.loginCompletesEarly)completeLogin();
      const acknowledge=()=>respond(request.id,kind==='account'?{type:'chatgpt',loginId,authUrl:'https://auth.example.test/authorize?state=transient-challenge'}:{loginId,authorizationUrl:'https://mcp.example.test/authorize?state=transient-challenge'});if(control.lateAuth)setTimeout(acknowledge,31000);else acknowledge();
      if(control.loginCompletes)setImmediate(completeLogin);
      return;
    }
    if(method==='account/login/cancel'){
      const login=logins.get(params.loginId);
      if(login&&control.cancelNotifiesEarly)notify('account/login/completed',{loginId:params.loginId,success:false,error:'Canceled'});
      respond(request.id,{status:login?'canceled':'notFound'});logins.delete(params.loginId);return;
    }
    if(method==='account/logout'){
      writeFileSync(join(directory,'control.json'),JSON.stringify({...control,account:null}));
      notify('account/updated',{authMode:null});respond(request.id,{});return;
    }
    if(method==='config/mcpServer/reload'){
      if(control.rejectExtension){process.stdout.write(JSON.stringify({id:request.id,error:{code:-32602,message:'Sensitive native failure must not escape'}})+'\n');return;}
      if(control.lateExtension)setTimeout(()=>respond(request.id,{}),31000);else respond(request.id,{});return;
    }
    if (method === 'account/read') {respond(request.id,control.accountUnavailable?{}:{account:Object.hasOwn(control,'account')?control.account:{type:'chatgpt',email:'fixture@example.com',planType:'pro',token:'credential-must-not-be-returned'},requiresOpenaiAuth:true,credential:'credential-must-not-be-returned'});return;}
    if (method === 'mcpServerStatus/list') {
      if(control.mcpFailure){process.stdout.write(JSON.stringify({id:request.id,error:{code:-32603,message:'Native catalog unavailable'}})+'\n');return;}
      const servers=control.mcpServers??[{name:'fixture-server',runtimeStatus:'connected',authStatus:'oAuth',pluginId:null,serverInfo:{name:'Fixture MCP',version:'1'},tools:{inspect:{name:'inspect',description:'Fixture native tool',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}}},toolsError:null,resources:[{uri:'fixture://readme',name:'Fixture readme',mimeType:'text/plain'}],resourceTemplates:[{uriTemplate:'fixture://{name}',name:'Fixture template'}],config:{headers:{authorization:'credential-must-not-be-returned'}}}];
      const selected=params.serverName?servers.filter(server=>server.name===params.serverName):servers;
      const offset=Number(params.cursor??0),limit=params.limit??32;
      respond(request.id,{data:selected.slice(offset,offset+limit),nextCursor:offset+limit<selected.length?String(offset+limit):null});return;
    }
    if (method === 'thread/start') {
      const nativeId='native-'+(++threadSequence);
      const thread = { ...threads[0],id:nativeId,sessionId:'session-for-'+nativeId,parentThreadId:null,forkedFromId:null,cwd:params.cwd,name:null,status:{type:'idle'},activeTurn:null };
      thread.model=params.model??'model-0000';thread.reasoningEffort=params.config?.model_reasoning_effort??'native-effort';
      managed.set(thread.id,thread);
      if(control.suppressStartAck)return;
      respond(request.id,{thread,model:thread.model,reasoningEffort:thread.reasoningEffort,approvalPolicy:params.approvalPolicy??'on-request',sandbox:{type:params.sandbox??'read-only'},instructionSources:[]});return;
    }
    if (method === 'thread/fork') {
      if(control.rejectFork){process.stdout.write(JSON.stringify({id:request.id,error:{code:-32602,message:'Synthetic fork rejection'}})+'\n');return;}
      const source=managed.get(params.threadId)||{...threads[0],id:params.threadId};
      const nativeId='native-'+(++threadSequence);
      const thread={...source,id:nativeId,sessionId:'session-for-'+nativeId,forkedFromId:control.wrongForkSource??params.threadId,parentThreadId:null,status:{type:'idle'},activeTurn:null};
      managed.set(nativeId,thread);respond(request.id,{thread});return;
    }
    if (method === 'thread/resume') {
      const thread = managed.get(params.threadId) || { ...threads[0],id:params.threadId,activeTurn:null };
      thread.status = {type:'idle'};thread.model=params.model??thread.model;thread.reasoningEffort=params.config?.model_reasoning_effort??thread.reasoningEffort; managed.set(thread.id,thread);
      respond(request.id,{thread,model:thread.model,reasoningEffort:thread.reasoningEffort,approvalPolicy:params.approvalPolicy??'on-request',sandbox:{type:params.sandbox??'read-only'},instructionSources:[]});return;
    }
    if (method === 'thread/name/set') { managed.get(params.threadId).name=params.name;respond(request.id,{});return; }
    if (method === 'thread/archive') { const thread=managed.get(params.threadId);thread.isArchived=true;thread.status={type:'notLoaded'};respond(request.id,{});return; }
    if (method === 'thread/unarchive') { const thread=managed.get(params.threadId);thread.isArchived=false;thread.status={type:'notLoaded'};respond(request.id,{thread});return; }
    if (method === 'thread/revert') { const thread=managed.get(params.threadId);respond(request.id,{thread});return; }
    if (method === 'thread/compact/start') {
      const thread=managed.get(params.threadId);const turn={id:'compact-'+(++turnSequence),status:'inProgress'};thread.activeTurn=turn.id;
      const started=()=>notify('turn/started',{threadId:thread.id,turn});
      if(control.compactAckFirst){respond(request.id,{});setImmediate(()=>{started();complete(thread.id);});}
      else {started();if(!control.holdTurn)complete(thread.id);respond(request.id,{});}
      return;
    }
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
      thread.model=params.model??thread.model;thread.reasoningEffort=params.effort??thread.reasoningEffort;
      const turn = {id:(control.turnPrefix??'')+'native-turn-'+(++turnSequence),status:'inProgress'};
      thread.activeTurn=turn.id;
      notify('turn/started',{threadId:thread.id,turn});
      const item = {id:'live-'+turnSequence,type:'agentMessage',text:''};
      notify('item/started',{threadId:thread.id,turnId:turn.id,item});
      notify('item/agentMessage/delta',{threadId:thread.id,turnId:turn.id,itemId:item.id,delta:'Live response'});
      if (control.prompt) process.stdout.write(JSON.stringify({id:'native-approval-'+turnSequence,method:control.prompt.method,params:{threadId:thread.id,turnId:turn.id,...(control.prompt.method==='mcpServer/elicitation/request'?{}:{itemId:'tool-'+turnSequence}),...control.prompt.params}})+'\n');
      if (control.loseOutput) { process.stdout.end();return; }
      const acknowledge = () => respond(request.id,{turn});
      if (control.lateTurnAck) setTimeout(acknowledge,31_000); else acknowledge();
      if(control.toolCall) {
        const callId='tool-call-'+turnSequence;
        let callbackThreadId=thread.id;
        if(control.toolChild) {
          callbackThreadId='child-'+thread.id;
          managed.set(callbackThreadId,{...thread,id:callbackThreadId,parentThreadId:control.toolParent??thread.id,cwd:control.toolRoot??thread.cwd});
        }
        toolCalls.set(callId,{threadId:thread.id,turnId:turn.id});
        process.stdout.write(JSON.stringify({id:callId,method:'item/tool/call',params:{threadId:callbackThreadId,turnId:control.toolTurnId??turn.id,callId,namespace:null,...control.toolCall}})+'\n');
      }
      if (!control.holdTurn && !control.prompt && !control.toolCall) {
        const text=control.outputText??(control.outputSize?'x'.repeat(control.outputSize):control.structuredOutput!==undefined?JSON.stringify(control.structuredOutput):'Live response');
        notify('item/completed',{threadId:thread.id,turnId:turn.id,item:{...item,text}});
        notify('thread/tokenUsage/updated',{threadId:thread.id,turnId:turn.id,tokenUsage:control.usageMalformed?'unknown-usage':{last:{inputTokens:7,outputTokens:3,cachedInputTokens:2}}});
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
    if (method === 'config/read') {
      const profiles=Object.fromEntries(Array.from({length:control.profileCount??4},(_,index)=>['profile-'+String(index).padStart(4,'0'),{description:control.configRevision?'Updated profile':'Native profile',model:'model-0000'}]));
      respond(request.id,{config:control.configMalformed?{model:42}:{model:'model-0000',model_reasoning_effort:'native-effort',profile:null,profiles,agents:{max_threads:4,explore:{description:'Read native code',model:'model-0000'}},approval_policy:'on-request',sandbox_mode:'read-only',secret:'must-not-leak'}});return;
    }
    if (method === 'thread/read') { respond(request.id,{ thread: { ...threads[0],...managed.get(params.threadId),...(control.unavailableSettings?{model:null,reasoningEffort:null}:{}),id: params.threadId,cwd: control.wrongRoot || managed.get(params.threadId)?.cwd || workspaceRoot } });return; }
    if (method === 'thread/turns/list') { respond(request.id,{ data: [{ id: 'turn-a',status: 'completed',startedAt: 1_700_000_000,completedAt: 1_700_000_001 }],nextCursor: null });return; }
    if (method === 'thread/items/list') {
      const text = control.largeItem ? 'a'.repeat(1_048_576) : 'Hello from the native history';
      let selected = control.awaitingFlush ? [] : control.items ?? [{ turnId: 'turn-a',item: { id: 'item-a',type: 'agentMessage',text } }];
      if(params.turnId)selected=selected.filter(entry=>entry.turnId===params.turnId);
      if(params.sortDirection==='desc')selected=[...selected].reverse();
      const after=params.cursor?selected.findIndex(entry=>entry.item.id===params.cursor)+1:0;
      const batch=selected.slice(after,after+params.limit);
      respond(request.id,{data:batch,nextCursor:after+batch.length<selected.length?batch.at(-1).item.id:null});return;
    }
    if (method === 'account/rateLimits/read') {
      if (control.accountChangedDuringRead) process.stdout.write(JSON.stringify({ method: 'account/updated', params: {} })+'\n');
      if (control.quotaFailure) { process.stdout.write(JSON.stringify({ id: request.id,error: { code: -32603,message: 'synthetic account failure' } })+'\n');return; }
      if (Object.hasOwn(control,'nativeUsage')) {respond(request.id,control.nativeUsage);return;}
      const bucket = { limitId: 'codex',limitName: 'Codex',primary: control.noWindows ? null : { usedPercent: control.usedPercent ?? 25,windowDurationMins: 300,resetsAt: control.expired ? Math.floor(Date.now()/1000)-1 : Math.floor(Date.now()/1000)+3600 },secondary: null,rateLimitReachedType: control.exhausted ? 'reached' : null,credits: control.credits??null };
      respond(request.id,{ rateLimits: bucket, rateLimitsByLimitId: control.noWindows ? null : { codex: bucket },ordinaryUsageAllowed: !control.exhausted,rateLimitResetCredits: control.resetCredits??null });return;
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
