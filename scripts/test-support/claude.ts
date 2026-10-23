import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CLAUDE_CONTROL_SOURCE } from './claude-control.js';

// only the external Claude executable is doubled; its transport, files and worker remain real
const FIXTURE_SOURCE = String.raw`#!/usr/bin/env node
import {readFileSync,appendFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {startClaudeControl} from './claude-control.mjs';
if(process.argv.includes('--permission-prompt-tool=stdio'))startClaudeControl();
else {
const root=process.env.JG_HQ_FIXTURE_DIRECTORY;
writeFileSync(join(root,'claude-pid.json'),JSON.stringify({pid:process.pid}));
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{
 const message=JSON.parse(line);
 appendFileSync(join(root,'claude-calls.jsonl'),JSON.stringify(message)+'\n');
 if(message.type!=='control_request')return;
 const control=JSON.parse(readFileSync(join(root,'claude-control.json'),'utf8'));
 const response=(body)=>process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:body}})+'\n');
 if(message.request.subtype==='initialize') {response({...(control.omitVersion?{}:{claude_code_version:control.version??'2.1.304'}),futureMetadata:control.futureMetadata});return;}
 if(message.request.subtype==='get_usage') {
  if(control.hold)return;
  if(control.malformed){process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:42}})+'\n');return;}
  if(control.authChange)process.stdout.write(JSON.stringify({type:'auth_status',isAuthenticating:false})+'\n');
  if(control.rateEvent)process.stdout.write(JSON.stringify({type:'rate_limit_event',rate_limit_info:{status:'allowed'}})+'\n');
  if(control.failure){process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'error',request_id:message.request_id,error:'synthetic usage failure'}})+'\n');return;}
  response({subscription_type:'team',rate_limits_available:!control.unavailable,behaviors:null,rate_limits:control.unavailable?null:{limits:control.rows??[
   {kind:'session',group:'session',percent:25,resets_at:new Date(Date.now()+(control.expired?-1000:3600000)).toISOString(),scope:null,is_active:true},
   {kind:'weekly_scoped',group:'weekly',percent:60,resets_at:null,scope:{model:{id:null,display_name:'Example'},surface:null},is_active:false}
  ]}});return;
 }
});
lines.on('close',()=>{process.exitCode=0;});
}
`;

/** Installs a disposable POSIX native-boundary fixture next to the Codex fixture. */
export const installClaudeFixture = async (directory: string): Promise<string> => {
  const bin = join(directory, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(directory, 'claude-control.json'), '{}');
  await writeFile(join(directory, 'claude-calls.jsonl'), '');
  await writeFile(join(bin, 'claude-control.mjs'), CLAUDE_CONTROL_SOURCE);
  await writeFile(join(directory, 'claude-pids.jsonl'), '');
  await writeFile(join(directory, 'claude-starts.jsonl'), '');
  await writeFile(join(bin, 'claude'), FIXTURE_SOURCE, { mode: 0o755 });
  return bin;
};
