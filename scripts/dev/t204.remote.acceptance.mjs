#!/usr/bin/env node
// T-204 remote acceptance on the connected D02 v4 single channel: one command
// and one PTY through the product/stock APIs, bounded, then release.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {authenticate,requestRpc,DEFAULT_ROOT as root,repo} from './preview.mjs';
const ids=JSON.parse(await readFile(join(root,'remote-demo.json'),'utf8'));
assert.equal(ids.version,4);
const auth=await authenticate(root),rpc=(m,p={})=>requestRpc(auth,m,p);
const sha=b=>createHash('sha256').update(b).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const checks=[],pass=(name,facts={})=>{checks.push({name,...facts});console.log('PASS '+name);};
const run=randomUUID();let terminalId=null,operationId=null;
try{
 // Command (no tty) through the studio provider.
 const marker='T204_REMOTE_CMD_'+run,op='t204-cmd-'+run;
 await rpc('command.start',{session_id:ids.session_id,operation_id:op,argv:['/usr/bin/bash','-c','echo '+marker+'; sleep 1']});
 let text='';
 for(let i=0;i<60;i++){
  const read=await rpc('task.read',{session_id:ids.session_id,operation_id:op,after_seq:'0'});
  text=read.chunks.map(c=>Buffer.from(c.data,'base64').toString()).join('');
  if(text.includes(marker)) break;
  await sleep(200);
 }
 assert.ok(text.includes(marker),'remote command marker missing: '+text.slice(0,200));
 const status=await rpc('task.status',{session_id:ids.session_id,operation_id:op});
 const released=await rpc('task.release',{session_id:ids.session_id,operation_id:op,action_id:randomUUID()});
 assert.equal(released.operation_id!==undefined,true);
 pass('remote command exec streams the marker and releases with a real provider operation',{operation_id:op,status,text_sha256:sha(Buffer.from(text))});

 // PTY through the stock terminal API on the same channel.
 terminalId=randomUUID();
 const created=await requestRpc(auth,'terminal/create',{args:{agentId:ids.session_id,request:{id:terminalId,rows:24,cols:80}}},'/api');
 assert.equal(created.agentId??created.session_id??ids.session_id,ids.session_id);
 operationId='terminal-'+sha(ids.session_id+'\0'+terminalId);
 const ptyMarker='T204_REMOTE_PTY_'+run;
 await rpc('task.input',{session_id:ids.session_id,operation_id:operationId,action_id:randomUUID(),data:'echo '+ptyMarker+'\n'});
 let ptyText='';
 for(let i=0;i<80;i++){
  const read=await rpc('task.read',{session_id:ids.session_id,operation_id:operationId,after_seq:'0'});
  ptyText=read.chunks.map(c=>Buffer.from(c.data,'base64').toString()).join('');
  if(ptyText.includes(ptyMarker)) break;
  await sleep(200);
 }
 assert.ok(ptyText.includes(ptyMarker),'remote PTY marker missing: '+ptyText.slice(-300));
 await rpc('task.cancel',{session_id:ids.session_id,operation_id:operationId,action_id:randomUUID()});
 await requestRpc(auth,'terminal/close',{args:{agentId:ids.session_id,id:terminalId}},'/api');
 let final=null;
 for(let i=0;i<40;i++){const row=await rpc('operation.get',{operation_id:operationId});if(['released','completed','cancelled','unknown'].includes(row.state)){final=row;break;}await sleep(200);}
 assert.ok(final&&['released','completed','cancelled'].includes(final.state),'terminal not settled: '+(final&&final.state));
 pass('remote PTY accepts input, streams output, cancels and releases on the same single channel',{terminal_id:terminalId,operation_id:operationId,final_state:final.state,output_sha256:sha(Buffer.from(ptyText))});
}catch(error){console.error(JSON.stringify({result:'fail',code:error.code??error.name,message:String(error.message).slice(0,300),terminalId,operationId}));process.exitCode=1;}
finally{
 if(terminalId) try{await requestRpc(auth,'terminal/close',{args:{agentId:ids.session_id,id:terminalId}},'/api');}catch{}
 await mkdir(join(repo,'artifacts/t204'),{recursive:true});
 const artifact=join(repo,'artifacts/t204/t204-remote-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
 await writeFile(artifact,JSON.stringify({scope:'T-204 remote command/PTY acceptance on D02 v4 single channel; bounded, no lifecycle',ids,run,checks,result:process.exitCode?'fail':'pass'},null,2)+'\n');
 console.log(JSON.stringify({result:process.exitCode?'fail':'pass',checks:checks.length,artifact}));
}
