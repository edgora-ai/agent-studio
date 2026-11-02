import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {CURRENT_SCHEMA_VERSION} from '../../packages/dsh-agent-studio/store.mjs';
import {authenticate,requestRpc,DEFAULT_ROOT,repo,start,stop} from './preview.mjs';

const root=DEFAULT_ROOT,run=randomUUID(),out=join(repo,'artifacts/d07/integration-'+run+'.json'),report={scope:'D07 real approved Coder READ ONLY + persistent product data; no platform mutation, no real model or external CLI',run,checks:[]};
const pass=(name,facts={})=>{report.checks.push({name,...facts});console.log('PASS '+name);};
let auth=await authenticate(root);const rpc=(method,input={})=>requestRpc(auth,method,input);const db=new DatabaseSync(join(root,'bindings.sqlite'),{readOnly:true}),sql=(query,...args)=>db.prepare(query).all(...args).map(row=>({...row}));
try {
 const health=await fetch(auth.origin+'/agent-studio/health');assert.equal(health.status,200);const rootStatus=await fetch(auth.origin+'/',{redirect:'manual'});assert.equal(rootStatus.status,401);
 const endpoints=['environment.describe','environment.discover','environment.observations','environment.open','environment.link','environment.prepare','environment.confirm','environment.request','environment.poll'];
 for(const method of endpoints) for(const cookie of ['', 'invalid']) {const response=await fetch(auth.origin+'/agent-studio-rpc/'+method,{method:'POST',headers:{'content-type':'application/json',origin:auth.origin,...(cookie?{cookie}:{})},body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method,payload:{}})});assert.equal(response.status,401);}
 pass('public health 200; protected root and all new endpoints absent/wrong auth 401',{health:200,protected:18});
 assert.equal(sql('PRAGMA user_version')[0].user_version,CURRENT_SCHEMA_VERSION);assert.equal(sql('PRAGMA integrity_check')[0].integrity_check,'ok');
 const baseline=JSON.parse(await readFile(join(repo,'artifacts/d07/pre-migration-snapshot.json'),'utf8')),preserved={},normalPromptTimestamps=[];
 for(const [table,rows] of Object.entries(baseline.tables)) {
  const serialized=row=>JSON.stringify(Object.entries(row).sort(([a],[b])=>a.localeCompare(b))),available=new Map();
  for(const row of sql('SELECT * FROM '+table)) {const key=serialized(row);available.set(key,(available.get(key)??0)+1);}
  for(const row of rows) {
   const key=serialized(row),count=available.get(key)??0;
   if(count===0 && table==='model_selections' && process.argv.includes('--after-regression')) {
    const actual=sql('SELECT * FROM model_selections WHERE session_id=?',row.session_id)[0],{updated_at:before,...identity}=row,{updated_at:after,...actualIdentity}=actual;
    assert.deepEqual(actualIdentity,identity);assert.ok(Date.parse(after)>Date.parse(before));
    const admitted=sql('SELECT * FROM model_requests WHERE session_id=? ORDER BY rowid DESC LIMIT 1',row.session_id)[0];
    assert.ok(!baseline.tables.model_requests.some(old=>old.request_id===admitted.request_id));assert.equal(admitted.provider,row.provider);assert.equal(admitted.model,row.model);assert.equal(admitted.revision,row.revision);
    assert.ok(Date.parse(admitted.created_at)>=Date.parse(after) && Date.parse(admitted.created_at)-Date.parse(after)<10000);
    normalPromptTimestamps.push({session_id:row.session_id,before,after,new_request_id:admitted.request_id,only_changed_column:'updated_at'});
   } else {assert.ok(count>0,'Original complete row missing or changed in '+table);available.set(key,count-1);}
  }preserved[table]=rows.length;
 }
 pass(normalPromptTimestamps.length?'schema6 identities/data preserved; only ordinary new-Send selection timestamps changed and matched to new requests':`schema6 baseline preserved byte-for-field at current schema${CURRENT_SCHEMA_VERSION}`,{schema:CURRENT_SCHEMA_VERSION,integrity:'ok',preserved,normalPromptTimestamps});
 const directory=await rpc('environment.discover');assert.equal(directory.read_only,true);assert.deepEqual(directory.actions,[]);assert.equal(directory.workspaces.length,1);
 const observed=directory.workspaces[0],status=observed.status;assert.equal(status.workspace_id,'ff136352-6a92-41d4-9c2c-6cc783cb989b');assert.equal(status.lifecycle,'running');assert.equal(status.agent.status,'connected');assert.ok(status.database_consistent);assert.ok(status.identity.verified);
 const row=sql('SELECT * FROM environment_observations WHERE observation_id=?',observed.observation_id)[0];assert.deepEqual(JSON.parse(row.status_json),status);assert.deepEqual((await rpc('environment.observations',{workspace_id:row.workspace_id})).find(item=>item.observation_id===row.observation_id),row);assert.equal((await rpc('environment.describe')).workspaces[0].observation_id,row.observation_id);
 const broker=spawnSync('/usr/bin/python3',['-I',join(repo,'packages/dsh-agent-studio/adapters/coder_broker.py'),root,'environment-discover'],{encoding:'utf8',timeout:90000,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});assert.equal(broker.status,0,'Readonly broker failed; diagnostics withheld');const independent=JSON.parse(broker.stdout),actual=independent.workspaces[0];
 for(const key of ['workspace_id','owner_id','organization_id','template_id','template_version_id','lifecycle','identity','build','job','database_consistent']) assert.deepEqual(actual[key],status[key]);for(const key of ['id','name','status','lifecycle_state','first_connected_at','disconnected_at']) assert.deepEqual(actual.agent[key],status.agent[key]);
 pass('authenticated real control-plane + independent known DB association -> persisted full observation -> API/history/search',{observation_id:row.observation_id,status,independent_observed_at:independent.observed_at,last_connected_at_may_advance:{product:status.agent.last_connected_at,independent:actual.agent.last_connected_at},server:directory.server,templates:directory.templates});
 const input={request_id:'readonly-'+run,action:'stop',workspace_id:row.workspace_id,template_version_id:status.template_version_id};
 await assert.rejects(()=>rpc('environment.prepare',input),{code:'agent-studio/environment-read-only'});
 await assert.rejects(()=>rpc('environment.prepare',{...input,read_only:false}),{code:'agent-studio/unknown-field'});
 await assert.rejects(()=>rpc('environment.discover',{principal_id:'another-owner'}),{code:'agent-studio/unknown-field'});
 await assert.rejects(()=>rpc('environment.open',{request_id:'bad-target-'+run,workspace_id:'11111111-1111-4111-8111-111111111111',observation_id:row.observation_id}),{code:'agent-studio/environment-observation-stale'});
 assert.equal(sql('SELECT count(*) n FROM environment_requests')[0].n,0);
 pass('read-only policy, browser privilege override, forged principal and unknown target denied; zero lifecycle requests/attempts',{lifecycle_requests:0,platform_posts_enabled:false});
 const links=sql('SELECT * FROM environment_links');for(const link of links) {assert.deepEqual(await rpc('environment.link',{request_id:link.request_id}),link);if(link.state==='ready') {const session=await rpc('session.get',{session_id:link.session_id});assert.equal(session.binding_id,link.binding_id);assert.equal(session.version,link.version);assert.ok(session.native);const binding=await rpc('binding.get',{binding_id:link.binding_id,version:link.version});assert.equal(binding.environment_id,link.environment_id);assert.ok((await rpc('binding.list')).some(item=>item.binding_id===binding.binding_id&&item.version===binding.version));}}
 pass('all environment connection requests -> direct SQL -> complete API -> native sessions and binding search',{links});
 if(process.argv.includes('--restart')) {
  const observations=sql('SELECT * FROM environment_observations ORDER BY rowid'),snapshot=Object.fromEntries(Object.keys(baseline.tables).map(table=>[table,sql('SELECT * FROM '+table+' ORDER BY rowid')]));
  await stop(root);const ready=await start(root,'127.0.0.1');auth=await authenticate(root);
  for(const [table,rows] of Object.entries(snapshot)) assert.deepEqual(sql('SELECT * FROM '+table+' ORDER BY rowid'),rows,'Restart changed '+table);
  for(const observation of observations) assert.deepEqual((await rpc('environment.observations',{workspace_id:observation.workspace_id})).find(item=>item.observation_id===observation.observation_id),observation);
  for(const link of links) assert.deepEqual(await rpc('environment.link',{request_id:link.request_id}),link);
  for(const {session_id} of snapshot.session_bindings) {const session=await rpc('session.get',{session_id});assert.ok(session.native);assert.deepEqual(await rpc('model.requests',{session_id}),sql('SELECT * FROM model_requests WHERE session_id=? ORDER BY created_at,rowid',session_id));assert.deepEqual(await rpc('model.controls',{session_id}),sql('SELECT * FROM model_controls WHERE session_id=? ORDER BY created_at,rowid',session_id));}
  for(const task of snapshot.acp_tasks) {assert.deepEqual(await rpc('acp.get',{task_id:task.task_id}),task);assert.deepEqual(await rpc('acp.events',{task_id:task.task_id}),sql('SELECT * FROM acp_events WHERE task_id=? ORDER BY seq',task.task_id));}
  pass('owned preview restart preserves exact observations/links and all 17 current tables; model/ACP/native history reread; no automatic lifecycle or task replay',{pid:ready.pid,origin:ready.origin,observations:observations.length,links:links.length,tables:Object.fromEntries(Object.entries(snapshot).map(([table,rows])=>[table,rows.length]))});
 }
 report.status='pass-limited-development';
} catch(error) {report.status='failed';report.failure={message:error.message,code:error.code,stack:error.stack};throw error;} finally {db.close();await writeFile(out,JSON.stringify(report,null,2));console.log(out);}
