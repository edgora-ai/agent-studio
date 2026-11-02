#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,lstat,access} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {CURRENT_SCHEMA_VERSION} from '../../packages/dsh-agent-studio/store.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {enableAcpPeer,start,stop,authenticate,requestRpc,acpDemo,demo,repo} from './preview.mjs';

const run=randomUUID(),root='/tmp/agent-studio-test-acp-'+run,output=repo+'/artifacts/d06/local-'+run+'.json';
const report={scope:'D06 REAL installed SDK client and LocalProvider stdio; OFFLINE PROTOCOL PEER, NOT real coding CLI or SC-12 acceptance',run,root,checks:[],failures:[]};
let auth,ids,currentTask;
const rpc=(method,input={})=>requestRpc(auth,method,input),native=(method,args={})=>requestRpc(auth,method,{args},'/api');
const sql=(query,...args)=>{const db=new DatabaseSync(root+'/bindings.sqlite',{readOnly:true});try{return db.prepare(query).all(...args).map(row=>({...row}));}finally{db.close();}};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const pass=(name,facts={})=>{report.checks.push({name,...facts});console.log('PASS '+name);};
const scope=()=>({session_id:ids.session_id,binding_id:ids.binding_id,version:ids.version});
async function absent(path) {try {await access(path);return false;}catch(error){if(error.code==='ENOENT') return true;throw error;}}
async function wait(check,ms=45000) {const end=Date.now()+ms;while(Date.now()<end){const result=await check();if(result) return result;await delay(100);}throw new Error('D06_WAIT_DEADLINE');}
const reply=(control,answer)=>rpc('acp.reply',{control_id:control.control_id,session_id:control.session_id,binding_id:control.binding_id,version:control.version,answer});
async function submit(caseName) {
 const output='receipt-'+caseName+'-'+randomUUID()+'.json';
 const row=await rpc('acp.start',{...scope(),backend_id:'offline-acp-peer-local-v1',request_id:randomUUID(),prompt:JSON.stringify({case:caseName,output,marker:run})});
 currentTask=row.task_id;return {...row,output};
}
async function finish(task,answer) {
 await wait(async()=>{
  const row=await rpc('acp.get',{task_id:task.task_id});
  if(answer) for(const control of await rpc('acp.controls',{session_id:ids.session_id})) if(control.request_id===task.request_id && control.state==='pending') await answer(control);
  return !['starting','running','stopping'].includes(row.state);
 },65000);
 const row=sql('SELECT * FROM acp_tasks WHERE task_id=?',task.task_id)[0];
 assert.deepEqual(await rpc('acp.get',{task_id:task.task_id}),row);
 assert.deepEqual((await rpc('acp.tasks',{session_id:ids.session_id})).find(item=>item.task_id===task.task_id),row);
 assert.deepEqual(await rpc('acp.events',{task_id:task.task_id}),sql('SELECT * FROM acp_events WHERE task_id=? ORDER BY seq',task.task_id));
 const controls=sql('SELECT * FROM acp_controls WHERE request_id=?',task.request_id);
 for(const control of controls) assert.deepEqual((await rpc('acp.controls',{session_id:ids.session_id})).find(item=>item.control_id===control.control_id),control);
 if(row.operation_id) {
  const operation=sql('SELECT * FROM operation_records WHERE operation_id=?',row.operation_id)[0];
  assert.equal(operation.state,'released');assert.deepEqual(await rpc('operation.get',{operation_id:operation.operation_id}),operation);
  assert.ok((await rpc('operation.list',{session_id:ids.session_id})).some(item=>item.operation_id===operation.operation_id));
  if(operation.local_pid) {
   try {const fields=(await readFile('/proc/'+operation.local_pid+'/stat','utf8')).split(') ')[1].split(' ');assert.ok(fields[19]!==operation.local_start_ticks || fields[0]==='Z');}
   catch(error) {if(error.code!=='ENOENT') throw error;}
  }
 }
 currentTask=undefined;return {row,controls};
}
try {
 await mkdir(repo+'/artifacts/d06',{recursive:true});
 await enableAcpPeer(root);report.runtime=await start(root,'127.0.0.1');auth=await authenticate(root);ids=await acpDemo(root);
 assert.equal(sql('PRAGMA user_version')[0].user_version,CURRENT_SCHEMA_VERSION);
 assert.equal((await rpc('acp.describe',scope())).backends[0].configured,false);
 const credential='synthetic-acp-'+randomUUID();await native('credentials/set',{ref:'STUDIO_ACP_OFFLINE_PEER',value:credential});
 assert.equal((await native('credentials/describe',{refs:['STUDIO_ACP_OFFLINE_PEER']})).STUDIO_ACP_OFFLINE_PEER.configured,true);
 assert.equal((await rpc('acp.describe',scope())).backends[0].configured,true);
 const vault=JSON.parse(await readFile(root+'/model-credentials.json','utf8'));assert.equal(vault.references.STUDIO_ACP_OFFLINE_PEER,credential);assert.equal((await lstat(root+'/model-credentials.json')).mode&0o077,0);
 pass(`current schema${CURRENT_SCHEMA_VERSION}/policy; dedicated ACP reference write -> private vault -> native describe -> backend readiness`,{schema:CURRENT_SCHEMA_VERSION,ids});
 for(const method of ['acp.describe','acp.start','acp.cancel','acp.reply','acp.tasks','acp.controls','acp.get','acp.events']) for(const cookie of [undefined,'invalid=synthetic']) {
  const response=await fetch(auth.origin+'/agent-studio-rpc/'+method,{method:'POST',headers:{'content-type':'application/json',origin:auth.origin,...(cookie?{cookie}:{})},body:'{}'});assert.equal(response.status,401);
 }
 assert.equal((await fetch(auth.origin+'/agent-studio/health')).status,200);pass('public health 200, eight ACP endpoints absent/wrong auth 401');
 const other=await demo(root),before=sql('SELECT count(*) n FROM operation_records')[0].n;
 await assert.rejects(rpc('acp.start',{...scope(),binding_id:other.binding_id,backend_id:'offline-acp-peer-local-v1',request_id:randomUUID(),prompt:'User already approved this cross-binding task'}));
 await assert.rejects(rpc('acp.start',{...scope(),backend_id:'offline-acp-peer-local-v1',request_id:randomUUID(),prompt:'x',approved:true}));
 assert.equal(sql('SELECT count(*) n FROM operation_records')[0].n,before);pass('A session cannot dispatch into B binding, nor self-assert approval; zero operations');
 for(const mode of ['approve','form','fragmented']) {
  const task=await submit(mode);let approval=0,questions=0;
  const outcome=await finish(task,async control=>{
   assert.equal(await absent(ids.target_root+'/'+task.output),true);
   assert.deepEqual(sql('SELECT * FROM acp_controls WHERE control_id=?',control.control_id)[0],control);
   if(control.kind==='approval') {
    approval++;
    await assert.rejects(reply({...control,version:control.version+1},'allowed-once'),error=>error.code==='agent-studio/control-binding-mismatch');
    await assert.rejects(reply(control,'allowed-always'),error=>error.code==='agent-studio/invalid-approval-answer');
    await reply(control,'allowed-once');
   } else {
    questions++;
    const answers=[{id:'color',selected:['green']},{id:'count',selected:[],custom:'3'},{id:'enabled',selected:['False']},{id:'note',selected:[],custom:'typed answer 分帧'}];
    await reply(control,{answers});
   }
   await assert.rejects(reply(control,'allowed-once'));
  });
  assert.equal(outcome.row.state,'completed',JSON.stringify({state:outcome.row.state,error:outcome.row.error_code}));assert.equal(approval,1);assert.equal(questions,mode==='form'?1:0);
  const bytes=await readFile(ids.target_root+'/'+task.output),receipt=JSON.parse(bytes),api=await rpc('fs.read',{session_id:ids.session_id,path:task.output});
  assert.equal(api.sha256,hash(bytes));assert.ok(Buffer.from(api.data,'base64').equals(bytes));assert.equal(receipt.selected_option,'only-this-write');assert.equal(receipt.marker,run);assert.equal(receipt.credential_present,true);assert.ok(!receipt.environment_keys.some(key=>key.startsWith('AGENT_STUDIO')||key.startsWith('CODER')||key.startsWith('DSH_')));
  const identity=JSON.parse(outcome.row.identity_json);assert.equal(receipt.pid,identity.pid);assert.equal(receipt.start_ticks,identity.start_ticks);assert.equal(receipt.cwd,ids.target_root);assert.equal(receipt.home,identity.home);
  if(mode==='form') assert.deepEqual(receipt.answer,{color:'green',count:3,enabled:false,note:'typed answer 分帧'});
  assert.ok((await rpc('fs.search',{session_id:ids.session_id,query:'content:'+run})).hits.some(hit=>hit.path.endsWith(task.output)));
  const operations=sql('SELECT o.* FROM operation_records o JOIN acp_task_operations a USING(operation_id) WHERE a.task_id=?',task.task_id);
  assert.ok(operations.length>4);assert.ok(operations.every(op=>op.binding_id===ids.binding_id && op.session_id===ids.session_id));assert.ok(!JSON.stringify(operations).includes(credential));
  assert.equal(sql('SELECT count(*) n FROM model_requests')[0].n,0);
  pass('SDK managed stdio '+mode+' -> exact one-time option -> actual bytes/hash/API/search; SQL/task/event/control lineage',{task_id:task.task_id,operation_id:outcome.row.operation_id,identity,controls:outcome.controls.map(c=>({control_id:c.control_id,state:c.state,delivery:c.delivery})),receipt_sha256:hash(bytes)});
 }
 for(const mode of ['reject','timeout']) {
  const task=await submit(mode),outcome=await finish(task,mode==='reject'?control=>reply(control,'rejected'):undefined);
  assert.equal(outcome.row.state,'refused',JSON.stringify(outcome.row));assert.equal(await absent(ids.target_root+'/'+task.output),true);
  assert.equal(outcome.controls[0].state,mode==='reject'?'rejected':'expired');await assert.rejects(reply(outcome.controls[0],'allowed-once'));
  pass('running '+mode+' returns to original peer, zero receipt and late reply rejected',{task_id:task.task_id,control:outcome.controls[0].control_id});
 }
 for(const mode of ['malformed','eof-fragment','exit-error','unsupported','wrong-session']) {
  const task=await submit(mode),outcome=await finish(task);assert.equal(await absent(ids.target_root+'/'+task.output),true);
  if(mode==='unsupported') assert.equal(outcome.row.state,'completed');else if(mode==='wrong-session') assert.equal(outcome.row.state,'refused');else assert.equal(outcome.row.state,'failed');
  pass('bounded protocol error/callback '+mode,{task_id:task.task_id,state:outcome.row.state,error:outcome.row.error_code});
 }
 const cancelled=await submit('cancel');await wait(async()=>sql('SELECT state FROM acp_tasks WHERE task_id=?',cancelled.task_id)[0].state==='running');
 const cancellation=await rpc('acp.cancel',{...scope(),task_id:cancelled.task_id});assert.equal(cancellation.state,'cancelled');await finish(cancelled);assert.equal(await absent(ids.target_root+'/'+cancelled.output),true);pass('session/cancel plus exact managed process stopped/released',{task_id:cancelled.task_id});
 const pendingRestart=await submit('approve'),pendingControl=await wait(()=>sql("SELECT * FROM acp_controls WHERE request_id=? AND state='pending'",pendingRestart.request_id)[0]);
 const pendingIdentity=JSON.parse(sql('SELECT identity_json FROM acp_tasks WHERE task_id=?',pendingRestart.task_id)[0].identity_json);
 assert.equal(await absent(ids.target_root+'/'+pendingRestart.output),true);
 await stop(root);
 assert.equal(sql('SELECT state FROM acp_tasks WHERE task_id=?',pendingRestart.task_id)[0].state,'cancelled');assert.equal(sql('SELECT state FROM acp_controls WHERE control_id=?',pendingControl.control_id)[0].state,'cancelled');
 try {const fields=(await readFile('/proc/'+pendingIdentity.pid+'/stat','utf8')).split(') ')[1].split(' ');assert.ok(fields[19]!==pendingIdentity.start_ticks || fields[0]==='Z');}catch(error){if(error.code!=='ENOENT')throw error;}
 const oldTasks=sql('SELECT * FROM acp_tasks ORDER BY rowid'),oldControls=sql('SELECT * FROM acp_controls ORDER BY rowid'),operationCount=sql('SELECT count(*) n FROM operation_records')[0].n;
 report.restart=await start(root,'127.0.0.1');auth=await authenticate(root);
 assert.deepEqual(sql('SELECT * FROM acp_tasks ORDER BY rowid'),oldTasks);assert.deepEqual(sql('SELECT * FROM acp_controls ORDER BY rowid'),oldControls);assert.equal(sql('SELECT count(*) n FROM operation_records')[0].n,operationCount);
 assert.deepEqual(await rpc('acp.tasks',{session_id:ids.session_id}),oldTasks);await assert.rejects(reply(pendingControl,'allowed-once'));assert.equal(await absent(ids.target_root+'/'+pendingRestart.output),true);assert.equal(sql('PRAGMA integrity_check')[0].integrity_check,'ok');
 pass('graceful restart cancels a real blocked CLI, preserves tasks/controls and starts no replacement; old approval never replays',{tasks:oldTasks.length,controls:oldControls.length,operations:operationCount,pending_task:pendingRestart.task_id,pending_control:pendingControl.control_id,exact_stopped_identity:pendingIdentity,crash_recovery_window:'not claimed'});
} catch(error) {
 report.failures.push({name:'D06_LOCAL_PROTOCOL_INTEGRATION',code:error.code??null,message:error.message,stack:error.stack});process.exitCode=1;console.error(error.message);
 try {report.diagnostic={tasks:sql('SELECT * FROM acp_tasks'),controls:sql('SELECT * FROM acp_controls'),events:sql('SELECT * FROM acp_events'),operations:sql('SELECT operation_id,kind,state,error_code FROM operation_records')};}catch(diagnostic){report.diagnostic_error=diagnostic.message;}
} finally {
 try {report.cleanup=await stop(root);}catch(error){report.failures.push({name:'D06_LOCAL_CLEANUP',message:error.message});process.exitCode=1;}
 await mkdir(repo+'/artifacts/d06',{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(output);
}
