#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {authenticate,requestRpc,acpDemo,repo,DEFAULT_ROOT as root} from './preview.mjs';
const run=randomUUID(),output=repo+'/artifacts/d06/remote-'+run+'.json',report={scope:'D06 real SDK/BoundProvider stdio on existing authorized m1-a; OFFLINE peer, NOT real CLI/SC-12',run,checks:[],failures:[]};
const auth=await authenticate(root),rpc=(m,p={})=>requestRpc(auth,m,p),native=(m,args={})=>requestRpc(auth,m,{args},'/api');
let ids,active;
const sql=(query,...args)=>{const db=new DatabaseSync(root+'/bindings.sqlite',{readOnly:true});try{return db.prepare(query).all(...args).map(row=>({...row}));}finally{db.close();}};
const hash=value=>createHash('sha256').update(value).digest('hex');
const pass=(name,facts={})=>{report.checks.push({name,...facts});console.log('PASS '+name);};
const scope=()=>({session_id:ids.session_id,binding_id:ids.binding_id,version:ids.version});
async function wait(check,ms=120000) {const end=Date.now()+ms;while(Date.now()<end){const value=await check();if(value)return value;await delay(150);}throw new Error('D06_REMOTE_DEADLINE');}
async function observe(paths=[],pids=[]) {
 const child=spawn('/usr/bin/python3',['-I',repo+'/scripts/dev/observe_remote.py',root],{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe'],timeout:60000});
 let output='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.resume();child.stdin.end(JSON.stringify({...ids,paths,pids}));
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0,'Independent readonly observation failed; diagnostics withheld');return JSON.parse(output);
}
const reply=(control,answer)=>rpc('acp.reply',{control_id:control.control_id,...scope(),answer});
async function submit(mode) {
 const output='remote-acp-'+mode+'-'+randomUUID()+'.json';
 const row=await rpc('acp.start',{...scope(),backend_id:'offline-acp-peer-m1-a-v1',request_id:randomUUID(),prompt:JSON.stringify({case:mode,output,marker:run})});active=row;return {...row,output};
}
async function complete(task,answer) {
 await wait(async()=>{
  const row=sql('SELECT * FROM acp_tasks WHERE task_id=?',task.task_id)[0];
  if(answer) for(const control of sql("SELECT * FROM acp_controls WHERE request_id=? AND state='pending'",task.request_id)) await answer(control);
  return !['starting','running','stopping'].includes(row.state);
 });
 const row=sql('SELECT * FROM acp_tasks WHERE task_id=?',task.task_id)[0];
 assert.deepEqual(await rpc('acp.get',{task_id:row.task_id}),row);assert.deepEqual((await rpc('acp.tasks',{session_id:ids.session_id})).find(item=>item.task_id===row.task_id),row);
 assert.deepEqual(await rpc('acp.events',{task_id:row.task_id}),sql('SELECT * FROM acp_events WHERE task_id=? ORDER BY seq',row.task_id));
 const controls=sql('SELECT * FROM acp_controls WHERE request_id=?',task.request_id);
 for(const control of controls) assert.deepEqual((await rpc('acp.controls',{session_id:ids.session_id})).find(item=>item.control_id===control.control_id),control);
 const operations=sql('SELECT o.* FROM operation_records o JOIN acp_task_operations a USING(operation_id) WHERE a.task_id=?',task.task_id);
 for(const operation of operations) {assert.deepEqual(await rpc('operation.get',{operation_id:operation.operation_id}),operation);assert.ok(!operation.local_pid);assert.equal(operation.binding_id,ids.binding_id);}
 assert.ok((await rpc('operation.list',{session_id:ids.session_id})).some(item=>item.operation_id===row.operation_id));
 active=undefined;return {row,controls,operations};
}
try {
 ids=await acpDemo(root,true);report.ids=ids;
 if(!(await native('credentials/describe',{refs:['STUDIO_ACP_OFFLINE_PEER']})).STUDIO_ACP_OFFLINE_PEER.configured) await native('credentials/set',{ref:'STUDIO_ACP_OFFLINE_PEER',value:'synthetic-acp-'+randomUUID()});
 assert.equal((await rpc('acp.describe',scope())).backends[0].configured,true);
 const modelCount=sql('SELECT count(*) n FROM model_requests')[0].n;
 for(const mode of ['form','fragmented']) {
  const task=await submit(mode),canary=root+'/cwd/'+task.output;
  await writeFile(canary,'CENTRAL_CANARY_'+run,{flag:'wx',mode:0o600});const before=hash(await readFile(canary));
  let live;
  const finished=await complete(task,async control=>{
   assert.equal((await observe([task.output])).files[0].exists,false);
   if(control.kind==='approval') {
    const identity=JSON.parse(sql('SELECT identity_json FROM acp_tasks WHERE task_id=?',task.task_id)[0].identity_json);
    live=(await observe([], [identity.pid])).processes[0];assert.equal(live.start_tick,identity.start_ticks);assert.equal(live.cwd,ids.target_root);assert.equal(live.coder_credentials_present,false);
    await reply(control,'allowed-once');
   } else await reply(control,{answers:[{id:'color',selected:['blue']},{id:'count',selected:[],custom:'7'},{id:'enabled',selected:['True']},{id:'note',selected:[],custom:'remote answer 回传'}]});
  });
  assert.equal(finished.row.state,'completed',JSON.stringify({state:finished.row.state,error:finished.row.error_code}));
  const identity=JSON.parse(finished.row.identity_json),api=await rpc('fs.read',{session_id:ids.session_id,path:task.output}),receipt=JSON.parse(Buffer.from(api.data,'base64'));
  const physical=await observe([task.output],[identity.pid]),dead=physical.processes[0];
  assert.equal(physical.files[0].sha256,api.sha256);assert.equal(hash(Buffer.from(api.data,'base64')),api.sha256);assert.ok(dead.exists===false||dead.start_tick!==identity.start_ticks||dead.state==='Z');
  assert.equal(receipt.cwd,ids.target_root);assert.equal(receipt.pid,identity.pid);assert.equal(receipt.start_ticks,identity.start_ticks);assert.equal(receipt.home,identity.home);assert.equal(receipt.credential_present,true);assert.equal(receipt.selected_option,'only-this-write');
  if(mode==='form') assert.deepEqual(receipt.answer,{color:'blue',count:7,enabled:true,note:'remote answer 回传'});
  assert.ok((await rpc('fs.search',{session_id:ids.session_id,query:'content:'+run})).hits.some(hit=>hit.path.endsWith(task.output)));
  assert.equal(hash(await readFile(canary)),before);assert.equal(sql('SELECT state FROM operation_records WHERE operation_id=?',finished.row.operation_id)[0].state,'released');
  pass('remote '+mode+' real stdio/permission/answers -> SQL/API/list -> independent bytes and PID; central canary unchanged',{task_id:task.task_id,operation_id:finished.row.operation_id,identity,live,physical,central_canary_sha256:before});
 }
 const cancel=await submit('cancel');await wait(()=>sql('SELECT state FROM acp_tasks WHERE task_id=?',cancel.task_id)[0].state==='running');
 const cancelled=await rpc('acp.cancel',{...scope(),task_id:cancel.task_id});assert.equal(cancelled.state,'cancelled');await complete(cancel);
 const cancelledIdentity=JSON.parse(cancelled.identity_json),afterCancel=await observe([cancel.output],[cancelledIdentity.pid]);assert.equal(afterCancel.files[0].exists,false);assert.ok(afterCancel.processes[0].exists===false||afterCancel.processes[0].start_tick!==cancelledIdentity.start_ticks||afterCancel.processes[0].state==='Z');
 pass('remote session/cancel and exact PID stopped/released; no receipt',{task_id:cancel.task_id,afterCancel});
 const lost=await submit('approve'),pending=await wait(()=>sql("SELECT * FROM acp_controls WHERE request_id=? AND state='pending'",lost.request_id)[0]);
 const identity=JSON.parse(sql('SELECT identity_json FROM acp_tasks WHERE task_id=?',lost.task_id)[0].identity_json),canary=root+'/cwd/'+lost.output;
 await writeFile(canary,'CENTRAL_UNKNOWN_CANARY_'+run,{flag:'wx',mode:0o600});const before=hash(await readFile(canary));
 const ready=JSON.parse(await readFile(root+'/ready.json','utf8')),brokers=[];
 for(const name of await readdir('/proc')) if(/^\d+$/.test(name)) {
  try {
   const argv=(await readFile('/proc/'+name+'/cmdline','utf8')).split('\0');
   if(argv.includes(repo+'/packages/dsh-agent-studio/adapters/coder_broker.py') && argv.includes(root) && argv.includes('connect') && argv.includes(ids.binding_id)) {
    const fields=(await readFile('/proc/'+name+'/stat','utf8')).split(') ')[1].split(' ');if(Number(fields[1])===ready.pid) brokers.push({pid:Number(name),start_ticks:fields[19]});
   }
  }catch(error){if(!['ENOENT','EACCES','ESRCH'].includes(error.code))throw error;}
 }
 assert.equal(brokers.length,1);assert.equal((await readFile('/proc/'+brokers[0].pid+'/stat','utf8')).split(') ')[1].split(' ')[19],brokers[0].start_ticks);
 process.kill(brokers[0].pid,'SIGTERM');
 const unknown=await complete(lost);assert.equal(unknown.row.state,'unknown');assert.equal(sql('SELECT state FROM operation_records WHERE operation_id=?',unknown.row.operation_id)[0].state,'unknown');await assert.rejects(reply(pending,'allowed-once'));
 const lineage=sql('SELECT count(*) n FROM acp_task_operations WHERE task_id=?',lost.task_id)[0].n;
 await rpc('remote.connect',{session_id:ids.session_id});await assert.rejects(reply(pending,'allowed-once'));
 await assert.rejects(rpc('task.status',{session_id:ids.session_id,operation_id:unknown.row.operation_id}),error=>error.code==='agent-studio/task-channel-lost');
 assert.equal(sql('SELECT count(*) n FROM acp_task_operations WHERE task_id=?',lost.task_id)[0].n,lineage);assert.equal(hash(await readFile(canary)),before);
 const afterLoss=await wait(async()=>{const observation=await observe([lost.output],[identity.pid]),process=observation.processes[0];assert.equal(observation.files[0].exists,false);if(process.exists===false||process.start_tick!==identity.start_ticks||process.state==='Z') return observation;await delay(2000);},180000);
 assert.equal((await rpc('acp.get',{task_id:lost.task_id})).state,'unknown');assert.equal(sql('SELECT count(*) n FROM model_requests')[0].n,modelCount);
 pass('exact broker channel loss -> unknown, no approval replay/relaunch/fallback; old remote PID independently stopped (not claimed cancelled)',{task_id:lost.task_id,broker:brokers[0],identity,afterLoss,central_canary_sha256:before,mutation_replay:false});
 assert.equal(sql('PRAGMA integrity_check')[0].integrity_check,'ok');
} catch(error) {report.failures.push({name:'D06_REMOTE_PROTOCOL',code:error.code??null,message:error.message,stack:error.stack});process.exitCode=1;console.error(error.message);if(ids) report.tasks=sql('SELECT * FROM acp_tasks WHERE session_id=?',ids.session_id);}
finally {
 if(active) try {report.cleanup=await rpc('acp.cancel',{...scope(),task_id:active.task_id});}catch(error){report.cleanup_error={code:error.code,message:error.message};}
 await mkdir(repo+'/artifacts/d06',{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(output);
}
