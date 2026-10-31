#!/usr/bin/env node
// Current deployment/admission/storage checks, including an owned preview restart.
// --local also verifies D04 local routes and emits separate D04 evidence.
import assert from 'node:assert/strict';
import {readFile,writeFile,lstat,readdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {authenticate,requestRpc,DEFAULT_ROOT as root,repo,start,stop,demo,modelDemo,acpDemo} from './preview.mjs';
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const hash=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
import {localProcessIdentity} from '../../packages/dsh-agent-studio/adapters/local-provider.mjs';
import {zstdDecompressSync} from 'node:zlib';
const environmentMode=process.argv.includes('--environment'),acpMode=environmentMode||process.argv.includes('--acp'),modelsMode=acpMode||process.argv.includes('--models'),local=modelsMode||process.argv.includes('--local'),slice=environmentMode?'d07':acpMode?'d06':modelsMode?'d05':local?'d04':'d03';
const report={scope:(environmentMode?'D07-environment':acpMode?'D06-ACP':modelsMode?'D05-model':local?'D04-local':'D03-core')+' final source/admission/storage check; development only',checks:[]};
const pass=(name,facts={})=>{report.checks.push({name,...facts});console.log('PASS '+name);};
async function filesUnder(dir) {
  const out=[];
  for(const entry of await readdir(dir,{withFileTypes:true})) {
    const path=dir+'/'+entry.name;
    if(entry.isDirectory()) out.push(...await filesUnder(path));
    else if(entry.isFile()) out.push(path);
  }
  return out;
}
let db;
try {
  const logBefore=await readFile(root+'/preview.log');
  await stop(root);const ready=await start(root,'127.0.0.1');await demo(root,true);
  if(local) await demo(root,false,true);
  if(acpMode) {await acpDemo(root);await acpDemo(root,true);await modelDemo(root,true);}
  const auth=await authenticate(root),rpc=(m,p={})=>requestRpc(auth,m,p);
  const ids=await json(root+'/remote-demo.json'),fixture=await json(repo+'/artifacts/d03/ui-fixture.json');
  const health=await fetch(auth.origin+'/agent-studio/health');assert.equal(health.status,200);await health.arrayBuffer();
  const statuses=[],scopes=[{kind:'remote',ids,fixture}];
  if(local) scopes.push({kind:'local',ids:await json(root+'/local-demo.json'),fixture:await json(repo+'/artifacts/d04/ui-fixture.json')});
  for(const scope of scopes) for(const method of ['git.status','git.diff','fs.search','reference.create']) for(const credential of ['absent','invalid','valid']) {
    const res=await fetch(auth.origin+'/sidebar/api/'+method,{method:'POST',headers:{origin:auth.origin,'content-type':'application/json',...(credential==='absent'?{}:{cookie:credential==='valid'?auth.cookie:'invalid=credential'})},body:JSON.stringify({sessionId:scope.ids.session_id,path:scope.fixture.absolute,query:scope.fixture.needle})});
    const value=await res.json();assert.equal(res.status,credential==='valid'?200:401);
    if(credential==='valid') assert.equal(value.ok,true);
    statuses.push({kind:scope.kind,method,credential,status:res.status});
  }
  const {WebSocket}=createRequire('/home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh/package.json')('ws');
  const watchUnauth=await new Promise((resolve,reject)=>{
    const ws=new WebSocket(auth.origin.replace('http:','ws:')+'/sidebar/ws/fs-watch?sessionId='+ids.session_id,{handshakeTimeout:10000});
    ws.on('unexpected-response',(req,res)=>{res.resume();resolve(res.statusCode);});
    ws.once('open',()=>{ws.close();reject(new Error('anonymous watch opened'));});ws.once('error',reject);
  });
  assert.equal(watchUnauth,401);
  pass('public health 200; four new reads 401/200; anonymous watch 401',{statuses,watchUnauth});
  db=new DatabaseSync(root+'/bindings.sqlite',{readOnly:true});
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,7);
  for(const [table,key,method] of [['projects','project_id','project'],['environments','environment_id','environment'],['project_bindings','binding_id','binding']]) {
    const list=await rpc(method+'.list');
    for(const raw of db.prepare('SELECT * FROM '+table).all()) {
      const row={...raw};assert.deepEqual(await rpc(method+'.get',{[key]:row[key],...(method==='binding'?{version:row.version}:{})}),row);
      assert.ok(list.some(v=>JSON.stringify(v)===JSON.stringify(row)));
    }
  }
  for(const raw of db.prepare('SELECT * FROM session_bindings').all()) {
    const row={...raw},{native,...value}=await rpc('session.get',{session_id:row.session_id});
    assert.deepEqual(value,row);assert.ok((await rpc('session.list')).some(v=>v.session_id===row.session_id));
  }
  const operations=db.prepare('SELECT * FROM operation_records').all(),lists=new Map();
  for(const raw of operations) {
    const row={...raw};assert.deepEqual(await rpc('operation.get',{operation_id:row.operation_id}),row);
    if(!lists.has(row.session_id)) lists.set(row.session_id,await rpc('operation.list',{session_id:row.session_id}));
    assert.ok(lists.get(row.session_id).some(r=>JSON.stringify(r)===JSON.stringify(row)));
  }
  const pending=db.prepare("SELECT count(*) n FROM operation_records WHERE state IN ('pending','running')").get().n;assert.equal(pending,0);
  assert.ok(db.prepare('SELECT session_id FROM session_bindings WHERE session_id=?').get('session-d591a741-bc77-487f-a2de-7e37a820ec1c'));
  const pids=db.prepare("SELECT DISTINCT remote_pid AS pid FROM operation_records WHERE kind='pty.open' AND remote_pid IS NOT NULL").all().map(r=>r.pid),processes=[];
  // Retained history grows; keep the independent observer's fixed 20-PID ceiling.
  for(let offset=0;offset<pids.length;offset+=20) {
    const observed=spawnSync('/usr/bin/python3',['-I',repo+'/scripts/dev/observe_remote.py',root],{input:JSON.stringify({...ids,paths:[],pids:pids.slice(offset,offset+20)}),encoding:'utf8',timeout:90000,maxBuffer:1048576,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
    assert.equal(observed.status,0,'readonly final process observer failed; diagnostics withheld');
    processes.push(...JSON.parse(observed.stdout).processes);
  }
  // A reused live PID is not ours to signal: fail for manual identity inspection.
  assert.ok(processes.every(p=>p.exists===false || p.state==='Z'));
  const localProcesses=[];
  for(const row of db.prepare('SELECT operation_id,local_pid,local_start_ticks FROM operation_records WHERE local_pid IS NOT NULL').all()) {
    const observed=await localProcessIdentity(row.local_pid);
    assert.ok(!observed || observed.state==='Z' || observed.start_ticks!==row.local_start_ticks,'owned local task still live: '+row.operation_id);
    localProcesses.push({...row,observed});
  }
  assert.equal(db.prepare("SELECT count(*) n FROM operation_records WHERE execution_kind='local' AND (channel_id IS NOT NULL OR helper_session_id IS NOT NULL OR remote_process_id IS NOT NULL OR remote_pid IS NOT NULL)").get().n,0);
  const watch=await rpc('watch.status');assert.equal(watch.clients,0);assert.equal(watch.directories,0);
  const models=await requestRpc(auth,'session/modelCatalog',{args:{}},'/api');
  if(modelsMode) {
    const current=await rpc('model.describe');assert.ok(Object.keys(current.providers).length>0);
    assert.ok(models.routableProviders.every(provider=>Object.hasOwn(current.providers,provider)));
    assert.deepEqual(JSON.parse(db.prepare("SELECT config_json FROM model_configurations WHERE state='active' ORDER BY revision DESC LIMIT 1").get().config_json).providers,current.providers);
  } else assert.deepEqual(models.routableProviders,[]);
  pass('all stored identities/operations -> complete APIs -> ID/list; no active tasks or polls',{operations:operations.length,pending,watch,pty_observations:processes,local_observations:localProcesses,schema:7,integrity:'ok',operation_states:db.prepare('SELECT state,count(*) n FROM operation_records GROUP BY state').all()});
  if(modelsMode) {
    const baseline=await json(repo+'/artifacts/d05/pre-migration-snapshot.json'),preserved={};
    for(const [table,rows] of Object.entries(baseline.tables)) {const current=db.prepare('SELECT * FROM '+table+' ORDER BY rowid LIMIT ?').all(rows.length).map(row=>({...row}));assert.deepEqual(current,rows,table+' prior rows changed');preserved[table]=rows.length;}
    const sessions=db.prepare('SELECT DISTINCT session_id FROM model_requests').all(),logs=await filesUnder(root+'/dsh/sessions'),history=[];
    let requestCount=0,controlCount=0;
    for(const {session_id} of sessions) {
      const requests=db.prepare('SELECT * FROM model_requests WHERE session_id=? ORDER BY created_at,rowid').all(session_id).map(row=>({...row})),controls=db.prepare('SELECT * FROM model_controls WHERE session_id=? ORDER BY created_at,rowid').all(session_id).map(row=>({...row}));
      assert.deepEqual(await rpc('model.requests',{session_id}),requests);assert.deepEqual(await rpc('model.controls',{session_id}),controls);requestCount+=requests.length;controlCount+=controls.length;
      const completed=requests.filter(r=>r.state==='completed');if(!completed.length) continue;
      const file=logs.find(path=>path.includes(session_id) && /\.jsonl(?:\.zstd)?$/.test(path));assert.ok(file);
      const bytes=await readFile(file),decoded=(file.endsWith('.zstd')?zstdDecompressSync(bytes):bytes).toString();
      const records=decoded.trim().split('\n').map(JSON.parse);assert.ok(records.length>1);assert.ok(decoded.includes('OFFLINE PROTOCOL FIXTURE COMPLETE'));
      const native=(await rpc('session.get',{session_id})).native.inspection;assert.ok(native.events.some(e=>e.type==='assistant/message' && JSON.stringify(e).includes('OFFLINE PROTOCOL FIXTURE COMPLETE')));
      history.push({session_id,file,bytes:bytes.length,records:records.length,sha256:await hash(file)});
    }
    const nativeList=JSON.stringify(await requestRpc(auth,'session/list',{args:{_request:{}}},'/api'));
    for(const item of history) assert.ok(nativeList.includes(item.session_id));
    assert.equal(db.prepare("SELECT count(*) n FROM model_requests WHERE state IN ('admitting','queued','running')").get().n,0);
    assert.equal(db.prepare("SELECT count(*) n FROM model_controls WHERE state='pending'").get().n,0);
    assert.equal(db.prepare("SELECT count(*) n FROM model_tool_calls WHERE state IN ('pending','running')").get().n,0);
    pass('schema4 baseline unchanged; model SQL -> full API/list; physical native JSONL -> inspect/list after restart',{preserved,requestCount,controlCount,history});
  }
  if(acpMode) {
    const tasks=db.prepare('SELECT * FROM acp_tasks ORDER BY created_at,rowid').all().map(row=>({...row})),controls=db.prepare('SELECT * FROM acp_controls ORDER BY created_at,rowid').all().map(row=>({...row}));
    assert.ok(tasks.length>0 && controls.length>0);assert.ok(tasks.every(task=>!['starting','running','stopping'].includes(task.state)));assert.ok(controls.every(control=>control.state!=='pending'));
    let eventCount=0;const remoteIdentities=[];
    for(const task of tasks) {
      assert.deepEqual(await rpc('acp.get',{task_id:task.task_id}),task);
      assert.deepEqual((await rpc('acp.tasks',{session_id:task.session_id})).find(row=>row.task_id===task.task_id),task);
      const events=db.prepare('SELECT * FROM acp_events WHERE task_id=? ORDER BY seq').all(task.task_id).map(row=>({...row}));eventCount+=events.length;
      assert.deepEqual(await rpc('acp.events',{task_id:task.task_id}),events);
      if(task.identity_json && task.operation_id) {
        const identity=JSON.parse(task.identity_json),operation=db.prepare('SELECT * FROM operation_records WHERE operation_id=?').get(task.operation_id);
        assert.equal(identity.operation_id,operation.operation_id);assert.equal(identity.binding_id,task.binding_id);assert.equal(identity.version,task.version);assert.equal(identity.instance_id,task.cli_instance_id);
        if(operation.remote_pid) {
          const result=spawnSync('/usr/bin/python3',['-I',repo+'/scripts/dev/observe_remote.py',root],{input:JSON.stringify({binding_id:task.binding_id,version:task.version,paths:[],pids:[identity.pid]}),encoding:'utf8',timeout:60000,maxBuffer:1048576,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
          assert.equal(result.status,0,'ACP readonly PID observation failed; diagnostics withheld');const actual=JSON.parse(result.stdout).processes[0];
          assert.ok(actual.exists===false || actual.state==='Z' || actual.start_tick!==identity.start_ticks);remoteIdentities.push({task_id:task.task_id,identity,actual});
        } else assert.equal(operation.local_start_ticks,identity.start_ticks);
      }
      assert.equal(db.prepare('SELECT count(*) n FROM model_requests WHERE session_id=?').get(task.session_id).n,0);
    }
    for(const control of controls) assert.deepEqual((await rpc('acp.controls',{session_id:control.session_id})).find(row=>row.control_id===control.control_id),control);
    const acpIds=await json(root+'/acp-remote-demo.json');
    // Independent history/PID reads may outlast D07's observation TTL. Revalidate
    // and explicitly authenticate a new channel; never recover or replay tasks.
    if(environmentMode) {await rpc('environment.discover');await rpc('remote.connect',{session_id:acpIds.session_id});}
    assert.equal((await rpc('remote.status',{session_id:acpIds.session_id})).connected,true);
    const acpAuth=[];
    for(const method of ['acp.describe','acp.start','acp.cancel','acp.reply','acp.tasks','acp.controls','acp.get','acp.events']) for(const cookie of [undefined,'invalid=synthetic']) {
      const response=await fetch(auth.origin+'/agent-studio-rpc/'+method,{method:'POST',headers:{origin:auth.origin,'content-type':'application/json',...(cookie?{cookie}:{})},body:'{}'});assert.equal(response.status,401);await response.arrayBuffer();acpAuth.push({method,credential:cookie?'invalid':'absent',status:response.status});
    }
    const credential=(await json(root+'/model-credentials.json')).references.STUDIO_ACP_OFFLINE_PEER;assert.ok(credential?.startsWith('synthetic-acp-'));
    const scanned=[...(await filesUnder(root)).filter(file=>file!==root+'/model-credentials.json'),...(await filesUnder(repo+'/artifacts/d06'))];
    for(const file of scanned) assert.equal((await readFile(file)).includes(Buffer.from(credential)),false,'dedicated ACP credential outside its private vault: '+file);
    pass('ACP SQL -> full API/list/events after restart; no fake model turns; exact remote PIDs stopped; auth and dedicated credential exclusion',{tasks:tasks.length,controls:controls.length,events:eventCount,states:db.prepare('SELECT state,count(*) n FROM acp_tasks GROUP BY state').all(),deliveries:db.prepare('SELECT state,delivery,count(*) n FROM acp_controls GROUP BY state,delivery').all(),remoteIdentities,auth:acpAuth,credential_scan_files:scanned.length,restart_replay:false,real_cli_acceptance:false,recovery_window:'not claimed'});
  }
  db.close();db=undefined;
  const lock=await json(repo+'/profiles/agent-studio-preview/sources.lock.json'),projection=await json(root+'/projection.json');
  const sdk='/home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh',side='/home/ubuntu/.dsh/profiles/web/node_modules/dsh-better-sidebar',profile=root+'/dsh/profiles/agent-studio-preview';let locked=0;
  for(const [dir,files] of [[sdk+'/node_modules/@deepseek-ai/dsh-api-gateway',{[lock.gateway.source]:lock.gateway.sha256,...lock.gateway.files}],[side,lock.sidebar.files],[sdk+'/node_modules',lock.local_sdk.files],[sdk+'/node_modules',lock.model_sdk.files],[sdk+'/node_modules',lock.acp_sdk.files],[repo+'/'+lock.remote_helper.source,lock.remote_helper.files]]) for(const [file,sha] of Object.entries(files)) {
    assert.equal(await hash(dir+'/'+file),sha);locked++;
  }
  assert.equal(await hash(repo+'/scripts/dev/sidebar-projection.mjs'),projection.sidebar.projector_sha256);
  for(const [file,sha] of Object.entries(projection.sidebar.projected_files)) assert.equal(await hash(profile+'/node_modules/dsh-better-sidebar/'+(file==='lib/index.js'?'lib/upstream-host.js':file)),sha);
  for(const file of (await filesUnder(repo+'/packages/dsh-agent-studio')).filter(f=>f.endsWith('.mjs') || f.endsWith('remote-read.py') || f.endsWith('acp-launch-v1.py'))) assert.equal(await hash(file),await hash(profile+'/studio/'+file.slice((repo+'/packages/dsh-agent-studio/').length)));
  const baseline=await json(repo+'/artifacts/d02/d01-baseline/manifest.json');
  for(const [file,sha] of Object.entries(baseline.source_sha256)) assert.equal(await hash(repo+'/artifacts/d02/d01-baseline/'+file),sha);
  assert.equal(await hash(repo+'/docs/implementation/evidence/d01-development-selftest.json'),'428ba538176f852a9149fda3cd26aeb9d18ccf00ab3a1f786cfb4e98541bc725');
  assert.equal(await hash(repo+'/docs/implementation/evidence/d02-d03-development-selftest.json'),'16368189452a21db38dca001cd244b39ecfd6d06b05e0fd975d34bfc5820a674');
  assert.equal(await hash(repo+'/docs/implementation/evidence/d03-core-development-selftest.json'),'f2e640c99695118e81870dca68dcf23cb6a60f8b4ccb9ae2669550ce81fc4f22');
  pass('locked upstream/local SDK, deployed projection/source and frozen D01-D03 evidence intact',{locked_files:locked,baseline_files:Object.keys(baseline.source_sha256).length,projector_sha256:projection.sidebar.projector_sha256,projected_chunks:Object.fromEntries(Object.entries(projection.sidebar.projected_files).filter(([p])=>['lib/client.js','lib/client-editor.js','lib/client-registry.js'].includes(p)))});
  let privateFiles=0,privateDirs=0;
  async function permissions(dir) {
    assert.equal((await lstat(dir)).mode&0o077,0);privateDirs++;
    for(const entry of await readdir(dir,{withFileTypes:true})) {
      const file=dir+'/'+entry.name;
      if(entry.isDirectory()) await permissions(file);
      else if(entry.isFile()) {assert.equal((await lstat(file)).mode&0o077,0,'private file mode: '+file);privateFiles++;}
    }
  }
  await permissions(root);assert.ok((await readFile(repo+'/.gitignore','utf8')).split('\n').includes('.preview/'));
  const currentLog=await readFile(root+'/preview.log');assert.deepEqual(currentLog,logBefore);
  pass('private permissions, ignored runtime and clean new startup log delta',{privateFiles,privateDirs,root_mode:'0700',sensitive_files:'0600-or-stricter',retained_historical_log_bytes:logBefore.length,new_log_bytes:currentLog.length-logBefore.length});
  const sourceFiles=[...(await filesUnder(repo+'/packages/dsh-agent-studio')),...(await filesUnder(repo+'/scripts/dev'))];let esm=0,python=0;
  for(const file of sourceFiles) {
    if(file.endsWith('.mjs')) {const p=spawnSync(process.execPath,['--check',file],{encoding:'utf8',timeout:15000});assert.equal(p.status,0,p.stderr);esm++;}
    else if(file.endsWith('.py')) {const p=spawnSync('/usr/bin/python3',['-I','-c','import ast,sys; ast.parse(open(sys.argv[1],encoding="utf-8").read(),filename=sys.argv[1])',file],{encoding:'utf8',timeout:15000});assert.equal(p.status,0,p.stderr);python++;}
  }
  pass('all implementation and dev harness ESM/Python syntax',{esm,python});
  report.result='pass-limited-development';report.runtime=ready;report.ids=ids;
  report.preview_status=await rpc('preview.status');report.remote=await rpc('remote.status',{session_id:ids.session_id});
} catch(error) {
  report.result='fail';report.failure={name:environmentMode?'D07_FINAL_VERIFY':acpMode?'D06_FINAL_VERIFY':modelsMode?'D05_FINAL_VERIFY':local?'D04_FINAL_VERIFY':'D03_FINAL_VERIFY',message:error.message,code:error.code};process.exitCode=1;
} finally {
  db?.close();const output=repo+'/artifacts/'+slice+'/final-verification-'+randomUUID()+'.json';
  await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({result:report.result,checks:report.checks.length,origin:report.runtime?.origin,failure:report.failure,output},null,2));
}
