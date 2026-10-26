import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// a synthetic external CLI boundary; the actual runtime/IPC/worker remain real in tests
const FIXTURE_SOURCE = String.raw`#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('codex-cli 0.163.0\n'); }
else if (args.join(' ') === 'app-server daemon start') {
  const directory = process.env.JG_HQ_FIXTURE_DIRECTORY;
  appendFileSync(join(directory,'commands.jsonl'),JSON.stringify(args)+'\n');
  if (JSON.parse(readFileSync(join(directory,'control.json'),'utf8')).daemonFailure) { process.stderr.write('daemon unavailable\n');process.exitCode = 1; }
  else process.stdout.write(JSON.stringify({ status: 'alreadyRunning' })+'\n');
}
else {
  const directory = process.env.JG_HQ_FIXTURE_DIRECTORY;
  const workspaceRoot = process.env.JG_HQ_FIXTURE_WORKSPACE;
  appendFileSync(join(directory,'commands.jsonl'),JSON.stringify(args)+'\n');
  const nativeChild = spawn(process.execPath,['-e','setInterval(() => {},60000)'],{ stdio: 'ignore' });
  writeFileSync(join(directory,'pids.json'),JSON.stringify({ parent: process.pid, child: nativeChild.pid }));
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdin.destroy();
    if (nativeChild.exitCode !== null || nativeChild.signalCode !== null) return;
    nativeChild.once('close',() => { process.exitCode = 0; });
    nativeChild.kill('SIGTERM');
  };
  process.on('SIGTERM',shutdown);
  process.stdin.on('end',shutdown);
  const controls = () => JSON.parse(readFileSync(join(directory,'control.json'),'utf8'));
  // the daemon control socket speaks WebSocket; the proxy forwards its bytes unchanged
  const frame = (text,opcode = 1,isFinal = true) => {
    const payload = Buffer.from(text);
    const header = payload.length < 126 ? Buffer.from([0,payload.length]) : payload.length < 65536 ? Buffer.from([0,126,payload.length >> 8,payload.length & 255]) : Buffer.concat([Buffer.from([0,127]),Buffer.alloc(8)]);
    if (payload.length >= 65536) header.writeBigUInt64BE(BigInt(payload.length),2);
    header[0] = (isFinal ? 0x80 : 0) | opcode;
    return Buffer.concat([header,payload]);
  };
  // framing options come from the settings read for the current request, not a file read per message
  let requestControl = {};
  const send = (text) => {
    if (requestControl.fragmentFrames && text.length > 1) { process.stdout.write(frame(text.slice(0,1),1,false));process.stdout.write(frame(text.slice(1),0,true)); }
    else process.stdout.write(frame(text));
  };
  let inbound = Buffer.alloc(0);
  let isOpen = false;
  process.stdin.on('data',(chunk) => {
    inbound = Buffer.concat([inbound,chunk]);
    if (!isOpen) {
      const end = inbound.indexOf('\r\n\r\n');
      if (end < 0) return;
      const key = /sec-websocket-key:\s*(\S+)/i.exec(inbound.subarray(0,end).toString('latin1'))[1];
      inbound = inbound.subarray(end+4);
      isOpen = true;
      const accept = controls().wrongAccept ? 'invalid' : createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      process.stdout.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
      if (controls().ping) process.stdout.write(frame('keepalive',9));
    }
    while (inbound.length >= 2) {
      let length = inbound[1] & 127;
      let offset = 2;
      if (length === 126) { if (inbound.length < 4) return; length = inbound.readUInt16BE(2);offset = 4; }
      else if (length === 127) { if (inbound.length < 10) return; length = Number(inbound.readBigUInt64BE(2));offset = 10; }
      // a real server closes the connection on an unmasked client frame
      if (!(inbound[1] & 128)) { process.stdout.end();return; }
      if (inbound.length < offset+4+length) return;
      const mask = inbound.subarray(offset,offset+4);
      const payload = Buffer.from(inbound.subarray(offset+4,offset+4+length)).map((byte,index) => byte ^ mask[index & 3]);
      const opcode = inbound[0] & 15;
      inbound = inbound.subarray(offset+4+length);
      if (opcode === 1) handle(payload.toString('utf8'));
      else if (opcode === 9 && !controls().ignorePings) process.stdout.write(frame(payload.toString('utf8'),10));
      else if (opcode === 10) appendFileSync(join(directory,'pongs.jsonl'),payload.toString('utf8')+'\n');
    }
  });
  const threads = Array.from({ length: 1024 },(_,index) => ({ id: 'thread-'+String(index).padStart(4,'0'), cwd: workspaceRoot, name: 'Task '+index, createdAt: 1_700_000_000 + Math.floor(index/2), updatedAt: 1_700_000_100, ephemeral: false, status: { type: 'notLoaded' } })).reverse();
  const respond = (id,result) => send(JSON.stringify({ id,result }));
  const notify = (method,params) => send(JSON.stringify({ method,params }));
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
  const handle = (line) => {
    const request = JSON.parse(line);
    const control = controls();
    requestControl = control;
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
      if (control.mode === 'malformed') { send('invalid JSON');return; }
      if (control.mode === 'oversized') { send('x'.repeat(8_388_609));return; }
      if (control.mode === 'partial') { const partial = frame('{"id":1,"result":null}');process.stdout.end(partial.subarray(0,partial.length-5));return; }
      if (control.mode === 'empty') { process.stdout.end();return; }
      respond(request.id,{ ...(control.omitVersion?{}:{userAgent:control.version??'codex-cli/fixture'}), futureMetadata:control.futureMetadata });return;
    }
    const { method,params = {} } = request;
    // held interrupts are confirmed together on the first request after releaseInterrupts is set
    if (control.releaseInterrupts && !control.holdInterrupt) for (const pending of interrupts.splice(0)) { respond(pending.id,{});complete(pending.params.threadId,'interrupted'); }
    // threadStatuses reports sessions another client drives, by thread ID; ephemeralThreads lists the ones Codex doesn't save
    const statusOf = (thread) => control.threadStatuses?.[thread.id] ?? thread.status;
    if (control.emitOnce) writeFileSync(join(directory,'control.json'),JSON.stringify({...control,emit:undefined,emitOnce:undefined}));
    if (control.emit) for (const event of control.emit) notify(event.method,event.params);
    if (method === 'model/list') {
      const choices = Array.from({length:control.modelCount??4},(_,index)=>({id:'model-'+String(index).padStart(4,'0'),model:'model-'+String(index).padStart(4,'0'),displayName:'Native model '+index,description:control.modelRevision?'Updated choice':'Native model choice',supportedReasoningEfforts:[{reasoningEffort:control.modelEffort??'native-effort'}],defaultReasoningEffort:control.modelEffort??'native-effort',isDefault:index===0}));
      if(control.modelsMalformed)choices[0].id='';
      const offset=params.cursor?Number(params.cursor.split(':')[1]):0;
      respond(request.id,{data:choices.slice(offset,offset+params.limit),nextCursor:offset+params.limit<choices.length?'models:'+String(offset+params.limit):null});return;
    }
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
      if(control.rejectAuth){send(JSON.stringify({id:request.id,error:{code:-32603,message:'Sensitive native failure must not escape'}}));return;}
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
      if(control.rejectExtension){send(JSON.stringify({id:request.id,error:{code:-32602,message:'Sensitive native failure must not escape'}}));return;}
      if(control.lateExtension)setTimeout(()=>respond(request.id,{}),31000);else respond(request.id,{});return;
    }
    if (method === 'account/read') {respond(request.id,control.accountUnavailable?{}:{account:Object.hasOwn(control,'account')?control.account:{type:'chatgpt',email:'fixture@example.com',planType:'pro',token:'credential-must-not-be-returned'},requiresOpenaiAuth:true,credential:'credential-must-not-be-returned'});return;}
    if (method === 'mcpServerStatus/list') {
      if(control.mcpFailure){send(JSON.stringify({id:request.id,error:{code:-32603,message:'Native catalog unavailable'}}));return;}
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
      if(control.rejectFork){send(JSON.stringify({id:request.id,error:{code:-32602,message:'Synthetic fork rejection'}}));return;}
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
      if (control.rejectTurn) { send(JSON.stringify({id:request.id,error:{code:-32602,message:'Synthetic input rejection'}}));return; }
      const thread = managed.get(params.threadId);
      thread.model=params.model??thread.model;thread.reasoningEffort=params.effort??thread.reasoningEffort;
      const turn = {id:(control.turnPrefix??'')+'native-turn-'+(++turnSequence),status:'inProgress'};
      thread.activeTurn=turn.id;
      notify('turn/started',{threadId:thread.id,turn});
      const item = {id:'live-'+turnSequence,type:'agentMessage',text:''};
      notify('item/started',{threadId:thread.id,turnId:turn.id,item});
      notify('item/agentMessage/delta',{threadId:thread.id,turnId:turn.id,itemId:item.id,delta:'Live response'});
      if (control.prompt) send(JSON.stringify({id:'native-approval-'+turnSequence,method:control.prompt.method,params:{threadId:thread.id,turnId:turn.id,...(control.prompt.method==='mcpServer/elicitation/request'?{}:{itemId:'tool-'+turnSequence}),...control.prompt.params}}));
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
        send(JSON.stringify({id:callId,method:'item/tool/call',params:{threadId:callbackThreadId,turnId:control.toolTurnId??turn.id,callId,namespace:null,...control.toolCall}}));
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
      if (managed.get(params.threadId)?.activeTurn !== params.expectedTurnId) { send(JSON.stringify({id:request.id,error:{code:-32602,message:'Turn no longer active'}}));return; }
      respond(request.id,{turnId:params.expectedTurnId});return;
    }
    if (method === 'turn/interrupt') {
      if (control.holdInterrupt) { interrupts.push(request);return; }
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
        send(JSON.stringify({ method: 'account/rateLimits/updated', params }));
        send(JSON.stringify({ method: 'account/rateLimits/updated', params }));
      }
      if (control.accountChanged) send(JSON.stringify({ method: 'account/updated', params: {} }));
      const selected = params.searchTerm ? threads.filter((thread) => thread.name.includes(params.searchTerm)) : threads;
      const after = params.cursor ? selected.findIndex((thread) => thread.id === params.cursor) + 1 : 0;
      const batch = selected.slice(after,after+params.limit).map((thread) => ({ ...thread,status: statusOf(thread) }));
      respond(request.id,{ data: control.wrongRoot ? batch.map((thread) => ({ ...thread,cwd: control.wrongRoot })) : batch, nextCursor: control.invalidCursor ? 'x'.repeat(8193) : after+batch.length < selected.length ? batch.at(-1).id : null });return;
    }
    if (method === 'config/read') {
      const profiles=Object.fromEntries(Array.from({length:control.profileCount??4},(_,index)=>['profile-'+String(index).padStart(4,'0'),{description:control.configRevision?'Updated profile':'Native profile',model:'model-0000'}]));
      respond(request.id,{config:control.configMalformed?{model:42}:{model:'model-0000',model_reasoning_effort:'native-effort',profile:null,profiles,agents:{max_threads:4,explore:{description:'Read native code',model:'model-0000'}},approval_policy:'on-request',sandbox_mode:'read-only',secret:'must-not-leak'}});return;
    }
    if (method === 'thread/read') { respond(request.id,{ thread: { ...threads[0],...managed.get(params.threadId),...(control.ephemeralThreads?.includes(params.threadId) ? { ephemeral: true } : {}),status: statusOf({ id: params.threadId,status: managed.get(params.threadId)?.status ?? threads[0].status }),...(control.unavailableSettings?{model:null,reasoningEffort:null}:{}),id: params.threadId,cwd: control.wrongRoot || managed.get(params.threadId)?.cwd || workspaceRoot } });return; }
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
      if (control.accountChangedDuringRead) send(JSON.stringify({ method: 'account/updated', params: {} }));
      if (control.quotaFailure) { send(JSON.stringify({ id: request.id,error: { code: -32603,message: 'synthetic account failure' } }));return; }
      if (Object.hasOwn(control,'nativeUsage')) {respond(request.id,control.nativeUsage);return;}
      const bucket = { limitId: 'codex',limitName: 'Codex',primary: control.noWindows ? null : { usedPercent: control.usedPercent ?? 25,windowDurationMins: 300,resetsAt: control.expired ? Math.floor(Date.now()/1000)-1 : Math.floor(Date.now()/1000)+3600 },secondary: null,rateLimitReachedType: control.exhausted ? 'reached' : null,credits: control.credits??null };
      respond(request.id,{ rateLimits: bucket, rateLimitsByLimitId: control.noWindows ? null : { codex: bucket },ordinaryUsageAllowed: !control.exhausted,rateLimitResetCredits: control.resetCredits??null });return;
    }
    send(JSON.stringify({ id: request.id,error: { code: -32601,message: 'Unsupported method' } }));
  };
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
