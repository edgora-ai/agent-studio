#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {authenticate,requestRpc,modelDemo,repo,DEFAULT_ROOT as root} from './preview.mjs';
const run=randomUUID(),report={scope:'D05 native model tools on existing authorized m1-a with OFFLINE protocol only',run,checks:[],failures:[]};
const auth=await authenticate(root),rpc=(m,p={})=>requestRpc(auth,m,p),native=(m,args={})=>requestRpc(auth,m,{args},'/api');
const sql=(query,...args)=>{const db=new DatabaseSync(root+'/bindings.sqlite',{readOnly:true});try{return db.prepare(query).all(...args).map(r=>({...r}));}finally{db.close();}};
const hash=value=>createHash('sha256').update(value).digest('hex');
const pass=(name,facts={})=>{report.checks.push({name,...facts});console.log('PASS '+name);};
async function wait(check,timeout=120000) {const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await check();if(value)return value;await delay(150);}throw new Error('D05_REMOTE_DEADLINE');}
async function observe(ids,paths,pids=[]) {
 const child=spawn('/usr/bin/python3',['-I',repo+'/scripts/dev/observe_remote.py',root],{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe']});
 let output='';child.stdout.on('data',b=>output+=b);child.stderr.resume();child.stdin.end(JSON.stringify({...ids,paths,pids}));
 const exit=await new Promise((done,fail)=>{child.once('error',fail);child.once('close',done);});assert.equal(exit,0,'Independent readonly observation failed; diagnostics withheld');return JSON.parse(output);
}
const approval=c=>({control_id:c.control_id,session_id:c.session_id,binding_id:c.binding_id,version:c.version,answer:c.kind==='approval'?'allowed-once':{answers:[{id:'synthetic-choice',selected:['Synthetic B']}]}});
try {
 const ids=await modelDemo(root,true),local=JSON.parse(await readFile(root+'/model-local-demo.json','utf8'));report.ids=ids;
 await native('session/selectModel',{request:{sessionId:ids.session_id,provider:'studio-model-offline',model:'offline-protocol-v1'}});
 const path='remote-model-'+run+'.txt',canary=local.target_root+'/'+path;
 await writeFile(canary,'CENTRAL_CANARY_'+run+'\n',{flag:'wx',mode:0o600});const canaryHash=hash(await readFile(canary));
 await rpc('fs.write',{session_id:ids.session_id,path,operation_id:randomUUID(),data:'D05_ALPHA synthetic remote native input\n',encoding:'utf8',expected_version:null});
 const requestId=randomUUID();assert.deepEqual(await native('session/prompt',{request:{sessionId:ids.session_id,requestId,mode:'queue',content:[{type:'text',text:`[D05 scenario:tools] [D05 path:${path}] Explicit synthetic m1-a tool test.`}]}}),{accepted:true});
 const answered=[];await wait(async()=>{
  for(const c of await rpc('model.controls',{session_id:ids.session_id})) if(c.request_id===requestId && c.state==='pending') {await rpc('model.reply',approval(c));answered.push(c.control_id);}
  const row=sql('SELECT * FROM model_requests WHERE request_id=?',requestId)[0];return !['admitting','queued','running'].includes(row.state)&&row;
 });
 const row=sql('SELECT * FROM model_requests WHERE request_id=?',requestId)[0],events=(await rpc('session.get',{session_id:ids.session_id})).native.inspection.events.filter(e=>e.data?.turn===row.turn),results=events.filter(e=>e.type==='tool/result');
 assert.equal(row.state,'completed');assert.equal(results.length,6);assert.deepEqual(results.filter(e=>e.data.message.isError),[]);assert.equal(answered.length,4);
 const full=await rpc('fs.read',{session_id:ids.session_id,path});assert.equal(Buffer.from(full.data,'base64').toString(),'D05_BETA synthetic remote native input\n');
 const physical=await observe(ids,[path,path+'.written']);assert.equal(physical.files[0].sha256,full.sha256);assert.equal(physical.files[1].sha256,hash('D05_WRITTEN synthetic model tool bytes\n'));
 assert.ok((await rpc('fs.list',{session_id:ids.session_id,path:''})).entries.some(e=>e.name===path));assert.ok((await rpc('fs.search',{session_id:ids.session_id,query:'content:D05_BETA'})).hits.some(h=>h.path.endsWith(path)));
 assert.equal(hash(await readFile(canary)),canaryHash);
 const operations=sql('SELECT o.* FROM operation_records o JOIN model_tool_operations m USING(operation_id) JOIN model_tool_calls c ON c.session_id=m.session_id AND c.call_id=m.call_id WHERE c.request_id=?',requestId);
 assert.ok(operations.some(o=>o.remote_pid && o.remote_process_id && o.helper_session_id));assert.ok(operations.every(o=>!o.local_pid));
 pass('native remote read/edit/write/search/bash/questions -> SQL lineage -> full API -> independent m1-a bytes -> search; central same-name canary unchanged',{request_id:requestId,controls:answered,physical,operations:operations.length,canary_sha256:canaryHash});
 const remoteRef=await rpc('reference.create',{session_id:ids.session_id,path});
 await assert.rejects(native('session/prompt',{request:{sessionId:local.session_id,requestId:randomUUID(),mode:'queue',content:[{type:'text',text:remoteRef.text}]}}),e=>e.code==='agent-studio/cross-binding-reference');pass('real remote snapshot cannot send through local binding');
 const disconnectedId=randomUUID(),blocked='disconnected-'+run+'.txt';
 await native('session/prompt',{request:{sessionId:ids.session_id,requestId:disconnectedId,mode:'queue',content:[{type:'text',text:`[D05 scenario:write] [D05 path:${blocked}] Offline test: disconnect before approving.`}]}});
 const pending=await wait(async()=>(await rpc('model.controls',{session_id:ids.session_id})).find(c=>c.request_id===disconnectedId && c.state==='pending'));
 const beforeOps=sql('SELECT count(*) n FROM operation_records WHERE session_id=?',ids.session_id)[0].n;
 await rpc('remote.disconnect',{session_id:ids.session_id});await rpc('model.reply',approval(pending));
 await wait(()=>!['admitting','queued','running'].includes(sql('SELECT state FROM model_requests WHERE request_id=?',disconnectedId)[0].state));
 assert.equal(sql('SELECT count(*) n FROM operation_records WHERE session_id=?',ids.session_id)[0].n,beforeOps);assert.equal(hash(await readFile(canary)),canaryHash);
 await assert.rejects(native('session/prompt',{request:{sessionId:ids.session_id,requestId:randomUUID(),mode:'queue',content:[{type:'text',text:'[D05 scenario:basic] disconnected request must not enter'}]}}),e=>e.code==='agent-studio/channel-disconnected');
 await rpc('remote.connect',{session_id:ids.session_id});assert.ok(!(await rpc('fs.list',{session_id:ids.session_id,path:''})).entries.some(e=>e.name===blocked));
 await assert.rejects(rpc('model.reply',approval(pending)),e=>e.code==='agent-studio/control-not-pending');
 pass('post-approval target recheck refuses disconnected remote without local fallback, write or replay',{request_id:disconnectedId,operation_count_unchanged:beforeOps,canary_sha256:canaryHash});
 const cancelId=randomUUID();
 await native('session/prompt',{request:{sessionId:ids.session_id,requestId:cancelId,mode:'queue',content:[{type:'text',text:'[D05 scenario:cancel] Explicit disconnect then native cancellation test.'}]}});
 await wait(async()=>{const row=sql('SELECT * FROM model_requests WHERE request_id=?',cancelId)[0];return row.state==='running' && (await readFile(root+'/offline-fixture-events.jsonl','utf8')).trim().split('\n').map(JSON.parse).some(e=>e.kind==='request' && e.scenario==='cancel' && Date.parse(e.time)>=Date.parse(row.created_at));});
 await rpc('remote.disconnect',{session_id:ids.session_id});await native('session/cancel',{request:{sessionId:ids.session_id}});
 await wait(()=>sql('SELECT state FROM model_requests WHERE request_id=?',cancelId)[0].state==='cancelled');
 assert.equal(hash(await readFile(canary)),canaryHash);await rpc('remote.connect',{session_id:ids.session_id});
 pass('authenticated native stream cancellation remains available after execution channel disconnect',{request_id:cancelId,canary_sha256:canaryHash});
 report.remote_status=await rpc('remote.status',{session_id:ids.session_id});
} catch(error){report.failures.push({name:'D05_REMOTE_NATIVE',code:error.code??null,message:error.message,stack:error.stack});console.error(error);process.exitCode=1;}
finally {await mkdir(repo+'/artifacts/d05',{recursive:true});const output=repo+'/artifacts/d05/remote-'+run+'.json';await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(output);}
