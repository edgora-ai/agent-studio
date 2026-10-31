#!/usr/bin/env node
// D07 targeted D04-D06 regression: existing private fixture, existing bindings,
// new operation IDs only; no platform lifecycle, model configuration or fault injection.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {authenticate,requestRpc,DEFAULT_ROOT as root,repo} from './preview.mjs';
import {localProcessIdentity} from '../../packages/dsh-agent-studio/adapters/local-provider.mjs';

const run=randomUUID(),out=repo+'/artifacts/d07/regression-'+run+'.json';
const report={scope:'D07 targeted real local/approved m1-a providers with existing OFFLINE model/ACP protocol peers; not external model/CLI, platform lifecycle or recovery',run,checks:[],failures:[]};
const auth=await authenticate(root),rpc=(method,input={})=>requestRpc(auth,method,input),native=(method,args={})=>requestRpc(auth,method,{args},'/api');
const db=new DatabaseSync(root+'/bindings.sqlite',{readOnly:true}),sql=(query,...args)=>db.prepare(query).all(...args).map(row=>({...row}));
const json=async path=>JSON.parse(await readFile(path,'utf8')),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const pass=(name,facts={})=>{report.checks.push({name,...facts});console.log('PASS '+name);};
const originalUnknown=sql("SELECT * FROM operation_records WHERE state='unknown' ORDER BY rowid"),configuration=sql('SELECT * FROM model_configurations ORDER BY rowid'),selections=sql('SELECT * FROM model_selections ORDER BY rowid');
const active=[];
async function wait(check,ms=120000) {const until=Date.now()+ms;while(Date.now()<until){const value=await check();if(value)return value;await delay(100);}throw new Error('D07_REGRESSION_DEADLINE');}
function observe(ids,paths,pids=[]) {
 const child=spawnSync('/usr/bin/python3',['-I',repo+'/scripts/dev/observe_remote.py',root],{input:JSON.stringify({...ids,paths,pids}),encoding:'utf8',timeout:90000,maxBuffer:1048576,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
 assert.equal(child.status,0,'Independent read-only observation failed; diagnostics withheld');return JSON.parse(child.stdout);
}
async function verifyOperation(id) {const row=sql('SELECT * FROM operation_records WHERE operation_id=?',id)[0];assert.deepEqual(await rpc('operation.get',{operation_id:id}),row);assert.deepEqual((await rpc('operation.list',{session_id:row.session_id})).find(item=>item.operation_id===id),row);return row;}
try {
 const browser=await json(repo+'/artifacts/d07/ui-new-path/browser.json');
 assert.deepEqual(browser.js_errors,[]);assert.deepEqual(browser.external_requests,[]);
 assert.deepEqual(browser.http_errors,[{path:'/sidebar/api/changes.ops',status:409},{path:'/agent-studio-rpc/environment.discover',status:401}]);
 for(const error of browser.rpc_errors) assert.ok((['/api/skills/list','/api/schedule/catalog'].includes(error.path)&&error.code==='agent-studio/disabled') || (error.path==='/sidebar/api/changes.ops'&&error.code==='agent-studio/provider-unavailable'));
 assert.deepEqual(browser.response_decode_errors,[{path:'/agent-studio-rpc/environment.discover',error:'JSONDecodeError'}]);
 const denied=await fetch(auth.origin+'/sidebar/api/changes.ops',{method:'POST',headers:{cookie:auth.cookie,origin:auth.origin,'content-type':'application/json'},body:'{}'}),denial=await denied.json();
 assert.equal(denied.status,409);assert.equal(denial.error.code,'agent-studio/provider-unavailable');assert.match(denial.error.message,/session-change history/);
 const unauth=await fetch(auth.origin+'/agent-studio-rpc/environment.discover',{method:'POST',headers:{origin:auth.origin,'content-type':'application/json'},body:'{}'}),body=await unauth.text();assert.equal(unauth.status,401);assert.throws(()=>JSON.parse(body));
 const timeline=sql("SELECT action,resource_id,outcome,created_at FROM audit_events WHERE created_at BETWEEN ? AND ? AND (action='channel.connected' OR (action='sidebar.denied' AND resource_id='/sidebar/api/changes.ops')) ORDER BY rowid",'2026-10-31T03:18:00','2026-10-31T03:19:05');
 assert.equal(timeline[0].action,'channel.connected');assert.equal(timeline[1].resource_id,'/sidebar/api/changes.ops');
 pass('browser errors classified by exact route/scenario, not blanket ignored: disabled history 409 and explicit unauthenticated non-JSON 401',{timeline,changes_ops:'Persistently disabled session-change history, after existing binding connected and before later new-session/new-binding links; not a connection loss and no claim this route recovered. Original Files and terminal succeeded.',unauthenticated:{status:401,content_type:unauth.headers.get('content-type'),listener_decode_error:true,ui:'HTTP 401 alert verified in screenshot; frontend checks status before JSON'},unexpected_errors:[]});
 const local=await json(root+'/local-demo.json'),fixture=await json(repo+'/artifacts/d04/ui-fixture.json');
 const file=await rpc('fs.read',{session_id:local.session_id,path:fixture.path}),actual=await readFile(fixture.absolute);assert.ok(Buffer.from(file.data,'base64').equals(actual));assert.equal(file.sha256,hash(actual));
 assert.ok((await rpc('fs.search',{session_id:local.session_id,query:'content:'+fixture.needle})).hits.some(hit=>hit.path===fixture.absolute));
 const operation_id=randomUUID(),task=await rpc('command.start',{session_id:local.session_id,operation_id,argv:['python3','-I','-c','import os; print(os.getcwd())']});active.push({kind:'task',session_id:local.session_id,operation_id});
 const output=await wait(async()=>{const row=await rpc('task.read',{session_id:local.session_id,operation_id});return row.exited&&row;});assert.equal(output.exitCode,0);assert.equal(Buffer.concat(output.chunks.filter(c=>c.stream==='stdout').map(c=>Buffer.from(c.data,'base64'))).toString().trim(),local.target_root);
 await rpc('task.release',{session_id:local.session_id,operation_id,action_id:randomUUID()});active.pop();assert.equal((await verifyOperation(operation_id)).state,'released');const process=await localProcessIdentity(task.pid);assert.ok(!process||process.start_ticks!==task.start_ticks||process.state==='Z');
 pass('D04 existing local binding: exact file bytes/search and real command cwd/PID -> SQL/full API/list -> released',{operation_id,sha256:file.sha256,pid:task.pid,start_ticks:task.start_ticks});
 const fixtureConfig=await json(root+'/offline-model-fixture.json'),modelInfo=await rpc('model.describe');assert.equal(fixtureConfig.kind,'offline-protocol-fixture');assert.equal(modelInfo.providers['studio-model-offline'].baseURL,fixtureConfig.baseURL);
 for(const kind of ['local','remote']) {
  const ids=await json(root+'/model-'+kind+'-demo.json'),selection=selections.find(row=>row.session_id===ids.session_id);assert.equal(selection.provider,'studio-model-offline');assert.equal(selection.model,'offline-protocol-v1');
  if(kind==='remote') {await rpc('environment.discover');await rpc('remote.connect',{session_id:ids.session_id});}
  const path='d07-model-'+kind+'-'+run+'.txt';await rpc('fs.write',{session_id:ids.session_id,path,operation_id:randomUUID(),encoding:'utf8',data:'D05_ALPHA synthetic native input\n',expected_version:null});
  const request_id=randomUUID();await native('session/prompt',{request:{requestId:request_id,sessionId:ids.session_id,mode:'queue',content:[{type:'text',text:`[D05 scenario:tools] [D05 path:${path}] Explicit D07 OFFLINE regression ${run}.`}]}});active.push({kind:'model',session_id:ids.session_id});
  await wait(async()=>{for(const control of await rpc('model.controls',{session_id:ids.session_id})) if(control.request_id===request_id && control.state==='pending') await rpc('model.reply',{control_id:control.control_id,session_id:ids.session_id,binding_id:ids.binding_id,version:ids.version,answer:control.kind==='approval'?'allowed-once':{answers:[{id:'synthetic-choice',selected:['Synthetic A']}]}});const row=sql('SELECT * FROM model_requests WHERE request_id=?',request_id)[0];return !['admitting','queued','running'].includes(row.state);});active.pop();
  const row=sql('SELECT * FROM model_requests WHERE request_id=?',request_id)[0];assert.equal(row.state,'completed');assert.deepEqual((await rpc('model.requests',{session_id:ids.session_id})).find(r=>r.request_id===request_id),row);
  const calls=sql('SELECT * FROM model_tool_calls WHERE request_id=?',request_id),controls=sql('SELECT * FROM model_controls WHERE request_id=?',request_id);assert.equal(calls.length,6);assert.ok(calls.every(c=>c.state==='completed'));assert.equal(controls.length,4);assert.ok(controls.every(c=>c.state==='answered'));
  const events=(await rpc('session.get',{session_id:ids.session_id})).native.inspection.events.filter(e=>e.data?.turn===row.turn),results=events.filter(e=>e.type==='tool/result');assert.equal(results.length,6);assert.ok(results.every(e=>!e.data.message.isError));
  const read=await rpc('fs.read',{session_id:ids.session_id,path});assert.equal(Buffer.from(read.data,'base64').toString(),'D05_BETA synthetic native input\n');assert.ok((await rpc('fs.search',{session_id:ids.session_id,query:'content:D05_BETA'})).hits.some(h=>h.path.endsWith(path)));
  if(kind==='local') assert.equal(hash(await readFile(ids.target_root+'/'+path)),read.sha256);else assert.equal(observe(ids,[path]).files[0].sha256,read.sha256);
  const operations=sql('SELECT o.* FROM operation_records o JOIN model_tool_operations m USING(operation_id) JOIN model_tool_calls c ON c.session_id=m.session_id AND c.call_id=m.call_id WHERE c.request_id=?',request_id);for(const operation of operations) {await verifyOperation(operation.operation_id);assert.ok(!['pending','running','unknown'].includes(operation.state));}
  pass('D05 '+kind+' actual native Agent six tools/one-time controls -> SQL/native events/full read/search; same offline configuration',{request_id,session_id:ids.session_id,calls:calls.length,controls:controls.length,operations:operations.length,sha256:read.sha256});
 }
 const cancelIds=await json(root+'/model-remote-demo.json'),cancelRequest=randomUUID();
 await native('session/prompt',{request:{requestId:cancelRequest,sessionId:cancelIds.session_id,mode:'queue',content:[{type:'text',text:'[D05 scenario:cancel] Explicit D07 offline stream cancellation regression.'}]}});active.push({kind:'model',session_id:cancelIds.session_id});
 await wait(async()=>{const row=sql('SELECT * FROM model_requests WHERE request_id=?',cancelRequest)[0];return row.state==='running'&&(await readFile(root+'/offline-fixture-events.jsonl','utf8')).trim().split('\n').map(JSON.parse).some(event=>event.kind==='request'&&event.scenario==='cancel'&&Date.parse(event.time)>=Date.parse(row.created_at));});
 await native('session/cancel',{request:{sessionId:cancelIds.session_id}});await wait(()=>sql('SELECT state FROM model_requests WHERE request_id=?',cancelRequest)[0].state==='cancelled');active.pop();
 assert.deepEqual((await rpc('model.requests',{session_id:cancelIds.session_id})).find(row=>row.request_id===cancelRequest),sql('SELECT * FROM model_requests WHERE request_id=?',cancelRequest)[0]);pass('D05 real offline in-flight stream remains cancellable after cold saved-selection restore',{request_id:cancelRequest,state:'cancelled'});
 for(const kind of ['local','remote']) {
  const ids=await json(root+'/acp-'+kind+'-demo.json'),scope={session_id:ids.session_id,binding_id:ids.binding_id,version:ids.version};
  if(kind==='remote') {await rpc('environment.discover');await rpc('remote.connect',{session_id:ids.session_id});}
  const backends=await rpc('acp.describe',scope);assert.equal(backends.backends[0].configured,true);
  const output='d07-acp-'+kind+'-'+run+'.json',task=await rpc('acp.start',{...scope,backend_id:kind==='local'?'offline-acp-peer-local-v1':'offline-acp-peer-m1-a-v1',request_id:randomUUID(),prompt:JSON.stringify({case:'form',output,marker:run})});active.push({kind:'acp',...scope,task_id:task.task_id});
  await wait(async()=>{for(const control of await rpc('acp.controls',{session_id:ids.session_id})) if(control.request_id===task.request_id && control.state==='pending') await rpc('acp.reply',{...scope,control_id:control.control_id,answer:control.kind==='approval'?'allowed-once':{answers:[{id:'color',selected:['blue']},{id:'count',selected:[],custom:'7'},{id:'enabled',selected:['True']},{id:'note',selected:[],custom:'D07 typed answer'}]}});const row=sql('SELECT * FROM acp_tasks WHERE task_id=?',task.task_id)[0];return !['starting','running','stopping'].includes(row.state);});active.pop();
  const row=sql('SELECT * FROM acp_tasks WHERE task_id=?',task.task_id)[0];assert.equal(row.state,'completed');assert.deepEqual(await rpc('acp.get',{task_id:task.task_id}),row);assert.deepEqual((await rpc('acp.tasks',{session_id:ids.session_id})).find(r=>r.task_id===task.task_id),row);assert.deepEqual(await rpc('acp.events',{task_id:task.task_id}),sql('SELECT * FROM acp_events WHERE task_id=? ORDER BY seq',task.task_id));
  const read=await rpc('fs.read',{session_id:ids.session_id,path:output}),receipt=JSON.parse(Buffer.from(read.data,'base64')),identity=JSON.parse(row.identity_json);assert.equal(receipt.marker,run);assert.equal(receipt.cwd,ids.target_root);assert.equal(receipt.pid,identity.pid);assert.equal(receipt.start_ticks,identity.start_ticks);assert.deepEqual(receipt.answer,{color:'blue',count:7,enabled:true,note:'D07 typed answer'});
  assert.ok((await rpc('fs.search',{session_id:ids.session_id,query:'content:'+run})).hits.some(hit=>hit.path.endsWith(output)));
  if(kind==='local') {assert.equal(hash(await readFile(ids.target_root+'/'+output)),read.sha256);const observed=await localProcessIdentity(identity.pid);assert.ok(!observed||observed.start_ticks!==identity.start_ticks||observed.state==='Z');} else {const observed=observe(ids,[output],[identity.pid]);assert.equal(observed.files[0].sha256,read.sha256);const p=observed.processes[0];assert.ok(!p.exists||p.start_tick!==identity.start_ticks||p.state==='Z');}
  assert.equal((await verifyOperation(row.operation_id)).state,'released');assert.equal(sql('SELECT count(*) n FROM model_requests WHERE session_id=?',ids.session_id)[0].n,0);
  pass('D06 '+kind+' real SDK peer stdio/form/one-time approval -> actual bytes/PID -> SQL/full API/search -> stopped/released; no fake model turn',{task_id:task.task_id,operation_id:row.operation_id,identity,sha256:read.sha256});
 }
 assert.deepEqual(sql("SELECT * FROM operation_records WHERE state='unknown' ORDER BY rowid"),originalUnknown);
 assert.deepEqual(sql('SELECT * FROM model_configurations ORDER BY rowid'),configuration);
 const currentSelections=sql('SELECT * FROM model_selections ORDER BY rowid'),withoutTimestamp=rows=>rows.map(({updated_at,...row})=>row);assert.deepEqual(withoutTimestamp(currentSelections),withoutTimestamp(selections));
 report.selection_timestamp_updates=currentSelections.filter(row=>selections.find(old=>old.session_id===row.session_id).updated_at!==row.updated_at).map(row=>({session_id:row.session_id,before:selections.find(old=>old.session_id===row.session_id).updated_at,after:row.updated_at,reason:'existing authenticated prompt snapshots current revision; selection identity/configuration unchanged'}));
 assert.equal(sql('SELECT count(*) n FROM environment_requests')[0].n,0);assert.equal(sql("SELECT count(*) n FROM operation_records WHERE state IN ('pending','running')")[0].n,0);
 pass('historical unknown full rows and model configuration/selection identity unchanged; prompt timestamps explicit; no active operations or platform lifecycle requests',{unknown_operations:originalUnknown.length,lifecycle_requests:0});report.status='pass-limited-development';
} catch(error) {report.status='failed';report.failures.push({name:'D07_TARGETED_REGRESSION',code:error.code,message:error.message,stack:error.stack});process.exitCode=1;console.error(error.message);}
finally {
 for(const item of active) try {if(item.kind==='model') await native('session/cancel',{request:{sessionId:item.session_id}});else if(item.kind==='acp') await rpc('acp.cancel',{session_id:item.session_id,binding_id:item.binding_id,version:item.version,task_id:item.task_id});else {await rpc('task.cancel',{session_id:item.session_id,operation_id:item.operation_id,action_id:randomUUID()});await rpc('task.release',{session_id:item.session_id,operation_id:item.operation_id,action_id:randomUUID()});}} catch(error) {report.failures.push({name:'D07_TARGETED_CLEANUP',code:error.code,message:error.message});process.exitCode=1;}
 db.close();await writeFile(out,JSON.stringify(report,null,2));console.log(out);
}
