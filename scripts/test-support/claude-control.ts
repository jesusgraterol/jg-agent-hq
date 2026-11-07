// synthetic external Claude controls; runtime, ledger, files, IPC and process ownership stay real
export const CLAUDE_CONTROL_SOURCE = String.raw`
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {appendFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
// the commands initialize reports, from claude-control.json, the same for a session and a read
export const fixtureCommands = (settings) => settings.skillsFailure?undefined:Array.from({length:settings.skillNames?.length??settings.skillCount??2},(_,index)=>({name:settings.skillNames?.[index]??(settings.skillRevision?'changed-':'')+(index===0?(settings.symbolicCommand?'native/command':'explicit-skill'):index===1?'implicit-skill':'skill-'+index),description:settings.skillDescriptionSize?'d'.repeat(settings.skillDescriptionSize):'Native installed skill '+index,argumentHint:'[task]'}));
export const startClaudeControl = () => {
 const root=process.env.JG_HQ_FIXTURE_DIRECTORY;
 const args=process.argv.slice(2);
 const flag=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
 const startupControls=JSON.parse(readFileSync(join(root,'claude-control.json'),'utf8'));
 if(startupControls.rejectDialectReference&&flag('--json-schema')&&JSON.parse(flag('--json-schema')).$schema){process.exitCode=1;return;}
 let model=flag('--model')??'model-0000',effort=flag('--effort')??'native-effort';
 // fast mode set through flag settings, null until one sets it; fastUnavailable names a reason it can't serve
 let fast=flag('--settings')?JSON.parse(flag('--settings')).fastMode??null:null;
 // like Claude, an SDK client without the flag set hears that it must opt in first
 const fastReport=()=>!fast?{fast_mode_state:'off',fast_mode_disabled_reason:'sdk_opt_in_required'}:control().fastUnavailable?{fast_mode_state:'off',fast_mode_disabled_reason:control().fastUnavailable}:{fast_mode_state:'on'};
 const id=args[args.indexOf(args.includes('--session-id')?'--session-id':'--resume')+1];
 const directory=join(process.env.CLAUDE_CONFIG_DIR,'projects',process.cwd().replace(/[^a-zA-Z0-9]/g,'-'));
 mkdirSync(directory,{recursive:true});
 const transcript=join(directory,id+'.jsonl');
 const child=spawn(process.execPath,['-e','setInterval(()=>{},60000)'],{stdio:'ignore'});
 appendFileSync(join(root,'claude-pids.jsonl'),JSON.stringify({pid:process.pid,child:child.pid})+'\n');
 appendFileSync(join(root,'claude-starts.jsonl'),JSON.stringify({args,cwd:process.cwd(),id})+'\n');
 const control=()=>JSON.parse(readFileSync(join(root,'claude-control.json'),'utf8'));
 const out=message=>process.stdout.write(JSON.stringify({...message,session_id:id})+'\n');
 const record=(uuid,type,content,parentUuid=null,toolUseResult)=>appendFileSync(transcript,JSON.stringify({type,uuid,parentUuid,sessionId:id,cwd:process.cwd(),version:'2.1.304',timestamp:new Date().toISOString(),isSidechain:false,message:{role:type,content},...(toolUseResult===undefined?{}:{toolUseResult})})+'\n');
 let input=null;
 // steer 'join' replays text written during a turn at once, as Claude does at a tool boundary;
 // 'next' holds it until the turn's result, as for text written while the answer streams
 let steers=[];
 let leaf=null;
 const recordQueued=message=>{
  const uuid=randomUUID();
  appendFileSync(transcript,JSON.stringify({type:'attachment',uuid,parentUuid:leaf,sessionId:id,cwd:process.cwd(),version:'2.1.319',timestamp:new Date().toISOString(),isSidechain:false,attachment:{type:'queued_command',prompt:message.message.content,source_uuid:message.uuid,delivery_id:randomUUID(),commandMode:'prompt',hostsOwnTurn:true}})+'\n');
  leaf=uuid;
 };
 let hasPrompt=false;
 let isClosing=false;
 // a turn the CLI starts on its own, as Claude does after a background command finishes
 let native=null,nativeTrigger=null,isTaskRunning=false,hasRaced=false;
 const endNative=interrupted=>{
  if(!native)return;
  const ended=native;native=null;
  if(interrupted){const uuid=randomUUID(),content=[{type:'text',text:'[Request interrupted by user]'}];record(uuid,'user',content,leaf);leaf=uuid;out({type:'user',uuid,message:{role:'user',content}});}
  out({type:'result',subtype:interrupted?'error_during_execution':'success',is_error:interrupted,usage:{input_tokens:5,output_tokens:2},...fastReport()});
  // Claude replays input written during its own turn only after that turn's result
  for(const next of ended.onEnd)next();
 };
 const startNative=onEnd=>{
  const settings=control();
  native={onEnd:onEnd?[onEnd]:[],hasPrompt:false};
  out({type:'system',subtype:'init',...fastReport()});
  out({type:'stream_event',event:{type:'message_start',message:{id:'native-message'}}});
  out({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text'}}});
  out({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Native follow-up'}}});
  const uuid=randomUUID();record(uuid,'assistant',[{type:'text',text:'Native follow-up'}],leaf);leaf=uuid;
  out({type:'assistant',uuid,message:{id:'native-message',role:'assistant',content:[{type:'text',text:'Native follow-up'}]}});
  if(settings.nativePrompt){
   native.hasPrompt=true;
   const toolInput={command:'echo native'},tool=randomUUID();
   record(tool,'assistant',[{type:'tool_use',id:'native-tool',name:'Bash',input:toolInput}],leaf);leaf=tool;
   out({type:'assistant',uuid:tool,message:{id:'native-tool-message',role:'assistant',content:[{type:'tool_use',id:'native-tool',name:'Bash',input:toolInput}]}});
   out({type:'control_request',request_id:'native-turn-request',request:{subtype:'can_use_tool',tool_name:'Bash',tool_use_id:'native-tool',input:toolInput}});
  }else if(settings.nativeTurnMs)setTimeout(()=>endNative(false),settings.nativeTurnMs);
  else if(!settings.nativeHold)endNative(false);
 };
 // holdResult streams and saves a turn's answer, then holds its result until releaseResult
 let heldResult=null;
 const complete=(interrupted=false)=>{
  if(!input||heldResult)return;
  // scripted frames are written to the transcript as the CLI would, with their result metadata
  if(!interrupted&&control().frames)for(const frame of control().frames){out(frame);if(frame.type==='user'||frame.type==='assistant'){record(frame.uuid,frame.type,frame.message.content,leaf,frame.tool_use_result);leaf=frame.uuid;}}
  else if(!interrupted){
   const uuid=randomUUID(),text=control().outputText??(control().outputSize?'x'.repeat(control().outputSize):'Native response to '+input.message.content);
   out({type:'stream_event',event:{type:'message_start',message:{id:'api-message'}}});
   out({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text'}}});
   out({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}});
   record(uuid,'assistant',[{type:'text',text}],leaf);leaf=uuid;
   out({type:'assistant',uuid,message:{id:'api-message',role:'assistant',content:[{type:'text',text}]}});
   out({type:'stream_event',event:{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null}}});
  }
  if(!interrupted&&control().holdResult){heldResult=()=>finish(false);return;}
  finish(interrupted);
 };
 const finish=interrupted=>{
  if(interrupted){const uuid=randomUUID(),content=[{type:'text',text:'[Request interrupted by user]'}];record(uuid,'user',content,leaf);leaf=uuid;out({type:'user',uuid,message:{role:'user',content}});}
  // a turn that starts a background command reports it, as Claude does, before its result
  if(!interrupted&&control().backgroundTask&&!isTaskRunning){isTaskRunning=true;out({type:'system',subtype:'background_tasks_changed',tasks:[{task_id:'task-1',run_id:'run-1',description:'sleep',task_type:'local_bash'}]});out({type:'system',subtype:'task_started',task_id:'task-1',run_id:'run-1',tool_use_id:'tool-task',description:'sleep',is_backgrounded:true,task_type:'local_bash'});}
  out({type:'result',subtype:interrupted?'error_during_execution':'success',is_error:interrupted,user_message_uuid:input.uuid,structured_output:control().structuredOutput,usage:control().usageMalformed?'unknown-usage':{input_tokens:7,output_tokens:3,cache_read_input_tokens:2},errors:interrupted?['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null']:undefined,...fastReport()});
  input=null;hasPrompt=false;
  // a held steer then runs as the session's next turn, which its result names
  for(const steer of steers.splice(0)){
   record(steer.uuid,'user',steer.message.content,leaf);leaf=steer.uuid;
   out({...steer,isReplay:true});
   const uuid=randomUUID(),text='Native response to '+steer.message.content;
   record(uuid,'assistant',[{type:'text',text}],leaf);leaf=uuid;
   out({type:'assistant',uuid,message:{id:'steer-message',role:'assistant',content:[{type:'text',text}]}});
   out({type:'result',subtype:'success',is_error:false,user_message_uuid:steer.uuid,usage:{input_tokens:3,output_tokens:2},...fastReport()});
  }
 };
 const lines=createInterface({input:process.stdin});
 const interval=setInterval(()=>{
  if(input&&!native&&control().release&&!hasPrompt){if(control().releaseOnce)writeFileSync(join(root,'claude-control.json'),JSON.stringify({...control(),release:false,releaseOnce:false}));complete();}
  if(heldResult&&control().releaseResult){const held=heldResult;heldResult=null;held();}
  const settings=control();
  if(isTaskRunning&&settings.finishBackgroundTask){isTaskRunning=false;out({type:'system',subtype:'task_updated',task_id:'task-1',run_id:'run-1',patch:{status:'completed',end_time:Date.now()}});out({type:'system',subtype:'task_notification',task_id:'task-1',run_id:'run-1',tool_use_id:'tool-task',status:'completed',output_file:'',summary:'done'});out({type:'system',subtype:'background_tasks_changed',tasks:[]});}
  if(native&&!native.hasPrompt&&settings.nativeRelease)endNative(false);
  // nativeAbandonPrompt ends the turn with its permission request still unanswered
  if(native&&native.hasPrompt&&settings.nativeAbandonPrompt)endNative(false);
  if(!native&&!input&&settings.nativeTurn&&settings.nativeTurn!==nativeTrigger){nativeTrigger=settings.nativeTurn;startNative();}
 },25);
 lines.on('line',line=>{
  const message=JSON.parse(line),settings=control();
  appendFileSync(join(root,'claude-calls.jsonl'),JSON.stringify(message)+'\n');
  if(message.type==='control_request'){
   const subtype=message.request.subtype;
   const response=body=>out({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:body}});
   // nativeOnSettings starts a turn of its own just before answering a settings read
   if(subtype==='get_settings'&&settings.nativeOnSettings&&!native&&!input)startNative();
   if(subtype==='get_settings'){response({effective:{model,effortLevel:'stale-effort',agent:flag('--agent'),...(fast===null?{}:{fastMode:fast}),secret:'must-not-leak'},applied:settings.unavailableSettings?{model:null,effort:null}:{model,effort}});return;}
   if(subtype==='apply_flag_settings'){model=message.request.settings.model??model;effort=message.request.settings.effortLevel??effort;fast=message.request.settings.fastMode??fast;response();return;}
   if(subtype==='initialize'){response({...(settings.omitVersion?{}:{claude_code_version:settings.version??'2.1.304'}),futureMetadata:settings.futureMetadata,agents:settings.agentsUnavailable?undefined:Array.from({length:settings.agentCount??4},(_,index)=>({name:'agent-'+String(index).padStart(4,'0'),description:settings.configRevision?'Updated agent':'Native agent',model:'model-0000'})),current_permission_mode:flag('--permission-mode')??'default',session_state:settings.omitIdle?undefined:settings.nativeState??'idle',commands:fixtureCommands(settings)});return;}
   if(subtype==='rename_session'){
    if(settings.rejectName){out({type:'control_response',response:{subtype:'error',request_id:message.request_id,error:'Synthetic name rejection'}});return;}
    if(message.request.session_id!==id){out({type:'control_response',response:{subtype:'error',request_id:message.request_id,error:'Wrong session'}});return;}
    appendFileSync(transcript,JSON.stringify({type:'custom-title',sessionId:id,customTitle:message.request.title})+'\n');
    out({type:'system',subtype:'session_title_changed',title:message.request.title});if(settings.lateName)setTimeout(()=>response(),31000);else response();return;
   }
   if(subtype==='interrupt'){
    if(native){if(native.hasPrompt)out({type:'control_cancel_request',request_id:'native-turn-request'});response();setTimeout(()=>endNative(true),settings.interruptDelay??1);return;}
    if(hasPrompt)out({type:'control_cancel_request',request_id:'native-request'});
    const acknowledge=()=>{response();setTimeout(()=>complete(!settings.completeOnInterrupt),settings.interruptDelay??1);};
    // interruptBarrier withholds every session's acknowledgement until that many sessions received one
    if(settings.interruptBarrier){
     appendFileSync(join(root,'claude-interrupts.jsonl'),id+'\n');
     const waitForBarrier=()=>readFileSync(join(root,'claude-interrupts.jsonl'),'utf8').trim().split('\n').length>=settings.interruptBarrier?acknowledge():setTimeout(waitForBarrier,8);
     waitForBarrier();
    }else acknowledge();
    return;
   }
  }else if(message.type==='user'){
   if(input&&settings.steer==='join'){recordQueued(message);out({...message,isReplay:true});return;}
   if(input&&settings.steer==='next'){steers.push(message);return;}
   if(input)throw new Error('Native input duplicated');
   input=message;
   record(message.uuid,'user',message.message.content,leaf);leaf=message.uuid;
   if(settings.malformed){process.stdout.write('not-json\n');return;}
   if(settings.partial){process.stdout.end('{"type":');return;}
   const acknowledge=()=>{
    if(!input)return;
    out({...message,isReplay:true});
    if(settings.prompt){
     hasPrompt=true;
     const tool=settings.toolName??(settings.prompt==='question'?'AskUserQuestion':'Bash');
     const toolInput=tool==='Bash'?{command:settings.largeCommand?'echo '+ 'x'.repeat(16384)+' visible-end':'echo example'}:tool==='AskUserQuestion'?{questions:[{question:'Which color?',header:'Color',multiSelect:!!settings.multiSelect,options:[{label:'Red',description:'First'},{label:'Blue',description:'Second'}]}]}:{repository:'example'};
     const uuid=randomUUID();out({type:'assistant',uuid,message:{role:'assistant',content:[{type:'tool_use',id:'tool-request',name:tool,input:toolInput}]}});
     record(uuid,'assistant',[{type:'tool_use',id:'tool-request',name:tool,input:toolInput}],leaf);leaf=uuid;
     out({type:'stream_event',event:{type:'message_delta',delta:{stop_reason:'tool_use',stop_sequence:null}}});
     out({type:'control_request',request_id:'native-request',request:settings.elicitation??{subtype:'can_use_tool',tool_name:tool,tool_use_id:'tool-request',input:toolInput,...settings.permissionMetadata}});
     if(settings.doublePrompt)out({type:'control_request',request_id:'other-request',request:{subtype:'can_use_tool',tool_name:tool,tool_use_id:'other-tool',input:toolInput}});
    }else if(!settings.holdTurn)complete();
   };
   if(native)native.onEnd.push(acknowledge);
   // nativeBeforeReplay starts a turn of Claude's own once, just as input arrives
   else if(settings.nativeBeforeReplay&&!hasRaced){hasRaced=true;startNative(acknowledge);}
   else if(settings.lateAck)setTimeout(acknowledge,31000);else acknowledge();
  }else if(message.type==='control_response'){
   if(settings.holdReply)return;
   if(native&&message.response.request_id==='native-turn-request'){
    const uuid=randomUUID(),content=[{type:'tool_result',tool_use_id:'native-tool',content:'Tool finished',is_error:false}];
    record(uuid,'user',content,leaf);leaf=uuid;
    out({type:'user',uuid,message:{role:'user',content}});
    native.hasPrompt=false;
    if(!settings.nativeHold)endNative(false);
    return;
   }
   if(settings.cancelReply){out({type:'control_cancel_request',request_id:message.response.request_id});return;}
   const uuid=randomUUID();const content=[{type:'tool_result',tool_use_id:'tool-request',content:settings.toolFailure?'Tool failed':'Tool finished',is_error:!!settings.toolFailure}];
   record(uuid,'user',content,leaf);leaf=uuid;
   out({type:'user',uuid,message:{role:'user',content}});
   if(!settings.holdAfterReply)complete();
  }
 });
 const shutdown=()=>{
  if(isClosing)return;isClosing=true;clearInterval(interval);lines.close();process.stdin.destroy();
  child.once('close',()=>{process.exitCode=0;});child.kill('SIGTERM');
 };
 lines.on('close',shutdown);process.on('SIGTERM',shutdown);
};
`;
