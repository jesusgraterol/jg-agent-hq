// synthetic external Claude controls; runtime, ledger, files, IPC and process ownership stay real
export const CLAUDE_CONTROL_SOURCE = String.raw`
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {appendFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
export const startClaudeControl = () => {
 const root=process.env.JG_HQ_FIXTURE_DIRECTORY;
 const args=process.argv.slice(2);
 const flag=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
 let model=flag('--model')??'model-0000',effort=flag('--effort')??'native-effort';
 const id=args[args.indexOf(args.includes('--session-id')?'--session-id':'--resume')+1];
 const directory=join(process.env.CLAUDE_CONFIG_DIR,'projects',process.cwd().replace(/[^a-zA-Z0-9]/g,'-'));
 mkdirSync(directory,{recursive:true});
 const transcript=join(directory,id+'.jsonl');
 const inherited=args.includes('--fork-session')?readFileSync(join(directory,args[args.indexOf('--resume')+1]+'.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>({...JSON.parse(line),sessionId:id})):[];
 if(inherited.length)writeFileSync(transcript,inherited.map(row=>JSON.stringify(row)).join('\n')+'\n');
 const child=spawn(process.execPath,['-e','setInterval(()=>{},60000)'],{stdio:'ignore'});
 appendFileSync(join(root,'claude-pids.jsonl'),JSON.stringify({pid:process.pid,child:child.pid})+'\n');
 appendFileSync(join(root,'claude-starts.jsonl'),JSON.stringify({args,cwd:process.cwd(),id})+'\n');
 const control=()=>JSON.parse(readFileSync(join(root,'claude-control.json'),'utf8'));
 const out=message=>process.stdout.write(JSON.stringify({...message,session_id:id})+'\n');
 const record=(uuid,type,content,parentUuid=null)=>appendFileSync(transcript,JSON.stringify({type,uuid,parentUuid,sessionId:id,cwd:process.cwd(),version:'2.1.304',timestamp:new Date().toISOString(),isSidechain:false,message:{role:type,content}})+'\n');
 let input=null;
 let leaf=inherited.filter(row=>row.uuid).at(-1)?.uuid??null;
 let hasPrompt=false;
 let isClosing=false;
 const complete=(interrupted=false)=>{
  if(!input)return;
  if(!interrupted){
   const uuid=randomUUID(),text=control().outputText??(control().outputSize?'x'.repeat(control().outputSize):'Native response to '+input.message.content);
   out({type:'stream_event',event:{type:'message_start',message:{id:'api-message'}}});
   out({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text'}}});
   out({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}});
   record(uuid,'assistant',[{type:'text',text}],leaf);leaf=uuid;
   out({type:'assistant',uuid,message:{id:'api-message',role:'assistant',content:[{type:'text',text}]}});
   out({type:'stream_event',event:{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null}}});
  }
  if(interrupted){const uuid=randomUUID(),content=[{type:'text',text:'[Request interrupted by user]'}];record(uuid,'user',content,leaf);leaf=uuid;out({type:'user',uuid,message:{role:'user',content}});}
  out({type:'result',subtype:interrupted?'error_during_execution':'success',is_error:interrupted,user_message_uuid:input.uuid,structured_output:control().structuredOutput,usage:control().usageMalformed?'unknown-usage':{input_tokens:7,output_tokens:3,cache_read_input_tokens:2},errors:interrupted?['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null']:undefined});
  input=null;hasPrompt=false;
 };
 const lines=createInterface({input:process.stdin});
 const interval=setInterval(()=>{if(input&&control().release&&!hasPrompt)complete();},25);
 lines.on('line',line=>{
  const message=JSON.parse(line),settings=control();
  appendFileSync(join(root,'claude-calls.jsonl'),JSON.stringify(message)+'\n');
  if(message.type==='control_request'){
   const subtype=message.request.subtype;
   const response=body=>out({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:body}});
   if(subtype==='get_settings'){response({effective:{model,effortLevel:'stale-effort',agent:flag('--agent'),secret:'must-not-leak'},applied:settings.unavailableSettings?{model:null,effort:null}:{model,effort}});return;}
   if(subtype==='apply_flag_settings'){model=message.request.settings.model??model;effort=message.request.settings.effortLevel??effort;response();return;}
   if(subtype==='initialize'){response({...(settings.omitVersion?{}:{claude_code_version:settings.version??'2.1.304'}),futureMetadata:settings.futureMetadata,agents:settings.agentsUnavailable?undefined:Array.from({length:settings.agentCount??4},(_,index)=>({name:'agent-'+String(index).padStart(4,'0'),description:settings.configRevision?'Updated agent':'Native agent',model:'model-0000'})),current_permission_mode:flag('--permission-mode')??'default',session_state:settings.omitIdle?undefined:settings.nativeState??'idle',commands:settings.skillsFailure?undefined:Array.from({length:settings.skillNames?.length??settings.skillCount??2},(_,index)=>({name:settings.skillNames?.[index]??(settings.skillRevision?'changed-':'')+(index===0?(settings.symbolicCommand?'native/command':'explicit-skill'):index===1?'implicit-skill':'skill-'+index),description:settings.skillDescriptionSize?'d'.repeat(settings.skillDescriptionSize):'Native installed skill '+index,argumentHint:'[task]'}))});return;}
   if(subtype==='rename_session'){
    if(settings.rejectName){out({type:'control_response',response:{subtype:'error',request_id:message.request_id,error:'Synthetic name rejection'}});return;}
    if(message.request.session_id!==id){out({type:'control_response',response:{subtype:'error',request_id:message.request_id,error:'Wrong session'}});return;}
    appendFileSync(transcript,JSON.stringify({type:'custom-title',sessionId:id,customTitle:message.request.title})+'\n');
    out({type:'system',subtype:'session_title_changed',title:message.request.title});if(settings.lateName)setTimeout(()=>response(),31000);else response();return;
   }
   if(subtype==='interrupt'){
    if(hasPrompt)out({type:'control_cancel_request',request_id:'native-request'});
    response();
    setTimeout(()=>complete(!settings.completeOnInterrupt),settings.interruptDelay??1);return;
   }
  }else if(message.type==='user'){
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
     const tool=settings.prompt==='question'?'AskUserQuestion':'Bash';
     const toolInput=tool==='Bash'?{command:settings.largeCommand?'echo '+ 'x'.repeat(16384)+' visible-end':'echo example'}:{questions:[{question:'Which color?',header:'Color',multiSelect:!!settings.multiSelect,options:[{label:'Red',description:'First'},{label:'Blue',description:'Second'}]}]};
     const uuid=randomUUID();out({type:'assistant',uuid,message:{role:'assistant',content:[{type:'tool_use',id:'tool-request',name:tool,input:toolInput}]}});
     record(uuid,'assistant',[{type:'tool_use',id:'tool-request',name:tool,input:toolInput}],leaf);leaf=uuid;
     out({type:'stream_event',event:{type:'message_delta',delta:{stop_reason:'tool_use',stop_sequence:null}}});
     out({type:'control_request',request_id:'native-request',request:settings.elicitation??{subtype:'can_use_tool',tool_name:tool,tool_use_id:'tool-request',input:toolInput,...settings.permissionMetadata}});
     if(settings.doublePrompt)out({type:'control_request',request_id:'other-request',request:{subtype:'can_use_tool',tool_name:tool,tool_use_id:'other-tool',input:toolInput}});
    }else if(!settings.holdTurn)complete();
   };
   if(settings.lateAck)setTimeout(acknowledge,31000);else acknowledge();
  }else if(message.type==='control_response'){
   if(settings.holdReply)return;
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
