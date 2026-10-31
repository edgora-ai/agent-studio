#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {authenticate,requestRpc,start,stop,demo,repo,DEFAULT_ROOT as root} from './preview.mjs';
const ids=JSON.parse(await readFile(join(root,'remote-demo.json'),'utf8'));
let auth=await authenticate();
const report={scope:'D02/D03 restart development verification; not M1/M2 acceptance',checks:[],failures:[]};
const pass=(name,facts={})=>{report.checks.push({name,...facts});console.log('PASS '+name);};
const rpc=(method,payload={})=>requestRpc(auth,method,payload);
const native=(method,args)=>requestRpc(auth,method,{args},'/api');
const sql=(query,...params)=>{const db=new DatabaseSync(join(root,'bindings.sqlite'),{readOnly:true});try{return db.prepare(query).all(...params).map(r=>({...r}));}finally{db.close();}};
const snapshots=()=>Object.fromEntries(['projects','environments','instance_records','project_bindings','session_bindings','file_read_versions'].map(table=>[table,sql(`SELECT * FROM ${table} ORDER BY rowid`)]));
function observe(pids) {
  const result=spawnSync('/usr/bin/python3',['-I',join(repo,'scripts/dev/observe_remote.py'),root],{input:JSON.stringify({...ids,pids}),encoding:'utf8',timeout:90000,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
  assert.equal(result.status,0,'Independent observer failed; diagnostics withheld');return JSON.parse(result.stdout);
}
try {
  await rpc('remote.connect',{session_id:ids.session_id});
  const termId=randomUUID();
  await native('terminal/create',{agentId:ids.session_id,request:{id:termId,rows:24,cols:80}});
  const terminal=sql("SELECT * FROM operation_records WHERE session_id=? AND kind='pty.open' ORDER BY rowid DESC LIMIT 1",ids.session_id)[0];
  const command=await rpc('command.start',{session_id:ids.session_id,operation_id:randomUUID(),argv:['python3','-I','-c','import time; time.sleep(60)']});
  const oldProcesses=observe([terminal.remote_pid,command.pid]);
  const before=snapshots(),oldOps=sql('SELECT * FROM operation_records ORDER BY rowid');
  const previous=JSON.parse(await readFile(join(root,'ready.json'),'utf8'));
  const stopped=await stop(root);assert.equal(stopped.stopped,true);
  const afterStop=observe([terminal.remote_pid,command.pid]);
  for(const old of oldProcesses.processes) {
    const current=afterStop.processes.find(p=>p.pid===old.pid);
    assert.ok(current.exists===false || current.state==='Z' || current.start_tick!==old.start_tick);
  }
  for(const id of [terminal.operation_id,command.operation_id]) assert.equal(sql('SELECT state FROM operation_records WHERE operation_id=?',id)[0].state,'released');
  pass('owned preview stop confirms native PTY and command stopped/released before transport closure',{stopped,oldProcesses,afterStop});
  const ready=await start(root,'127.0.0.1');auth=await authenticate();
  assert.notEqual(ready.run_id,previous.run_id);assert.deepEqual(snapshots(),before);
  const status=await rpc('remote.status',{session_id:ids.session_id});assert.equal(status.connected,false);
  await assert.rejects(rpc('fs.read',{session_id:ids.session_id,path:'unavailable.txt'}),e=>e.code==='agent-studio/channel-disconnected');
  for(const row of oldOps) {
    const current=await rpc('operation.get',{operation_id:row.operation_id});
    for(const key of ['operation_id','session_id','binding_id','version','principal_id','kind','request_sha256','remote_process_id','remote_pid','channel_id','helper_session_id']) assert.equal(current[key],row[key]);
    if(row.state==='unknown') assert.equal(current.state,'unknown');
  }
  assert.equal(sql('PRAGMA integrity_check')[0].integrity_check,'ok');
  pass('restart preserves D01 and D02 rows, strong read baselines and all operation identities; no automatic channel or replay',{tables:Object.fromEntries(Object.entries(before).map(([t,r])=>[t,r.length])),operations:oldOps.length,ready});
  const connected=await demo(root,true);const {origin,...reused}=connected;assert.deepEqual(reused,ids);
  for(const [table,key,method,list] of [['projects','project_id','project.get','project.list'],['environments','environment_id','environment.get','environment.list'],['project_bindings','binding_id','binding.get','binding.list']]) {
    const row=sql(`SELECT * FROM ${table} WHERE ${key}=?`,ids[key])[0];
    assert.deepEqual(await rpc(method,{[key]:ids[key],...(key==='binding_id'?{version:ids.version}:{})}),row);
    assert.ok((await rpc(list)).some(item=>JSON.stringify(item)===JSON.stringify(row)));
  }
  const session=await rpc('session.get',{session_id:ids.session_id});const {native:stored,...row}=session;
  assert.deepEqual(row,sql('SELECT * FROM session_bindings WHERE session_id=?',ids.session_id)[0]);
  assert.equal(stored.inspection.meta.cwd,before.project_bindings.find(b=>b.binding_id===ids.binding_id).anchor_path);
  const operationCount=sql('SELECT count(*) n FROM operation_records')[0].n;
  await assert.rejects(native('terminal/create',{agentId:ids.session_id,request:{id:termId,rows:24,cols:80}}),e=>e.code==='agent-studio/operation-exists');
  assert.equal(sql('SELECT count(*) n FROM operation_records')[0].n,operationCount);
  pass('restored native terminal identity cannot allocate a new operation after restart',{terminal_id:termId,operation_id:terminal.operation_id});
  const termAgain=randomUUID();await native('terminal/create',{agentId:ids.session_id,request:{id:termAgain,rows:24,cols:80}});
  await native('terminal/close',{agentId:ids.session_id,id:termAgain});
  pass('explicit remote-demo reuses immutable binding/project root; SQL -> complete API -> list and native terminal after restart',{ids,origin});
  report.result='pass';
} catch(error) {report.result='fail';report.failures.push({name:error.name,code:error.code,message:error.message});process.exitCode=1;console.error(error);}
finally {const path=join(repo,'artifacts/d02',`restart-${randomUUID()}.json`);await writeFile(path,JSON.stringify(report,null,2));console.log(JSON.stringify({result:report.result,evidence:path}));}
