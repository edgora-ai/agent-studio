#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {authenticate,requestRpc,start,stop,demo,DEFAULT_ROOT as root,repo} from './preview.mjs';
import {localProcessIdentity} from '../../packages/dsh-agent-studio/adapters/local-provider.mjs';
const {WebSocket}=createRequire('/home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh/package.json')('ws');
const ids=JSON.parse(await readFile(root+'/local-demo.json','utf8')),remote=JSON.parse(await readFile(root+'/remote-demo.json','utf8')),fixture=JSON.parse(await readFile(repo+'/artifacts/d04/ui-fixture.json','utf8'));
let auth=await authenticate(root),socket;
const rpc=(method,input={})=>requestRpc(auth,method,input),native=(method,args)=>rpcNative(method,args);
const rpcNative=(method,args)=>requestRpc(auth,method,{args},'/api');
const sql=(query,...values)=>{const db=new DatabaseSync(root+'/bindings.sqlite',{readOnly:true});try{return db.prepare(query).all(...values).map(row=>({...row}));}finally{db.close();}};
const snapshots=()=>Object.fromEntries(['projects','environments','instance_records','project_bindings','session_bindings','file_read_versions'].map(table=>[table,sql(`SELECT * FROM ${table} ORDER BY rowid`)]));
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const report={scope:'D04 local normal shutdown/restart/no-fallback, development only',checks:[],failures:[]};
const pass=(name,facts={})=>{report.checks.push({name,...facts});console.log('PASS '+name);};
try {
 const termId=randomUUID();await native('terminal/create',{agentId:ids.session_id,request:{id:termId,rows:24,cols:80}});
 const terminal=sql("SELECT * FROM operation_records WHERE session_id=? AND kind='pty.open' ORDER BY rowid DESC LIMIT 1",ids.session_id)[0];
 const command=await rpc('command.start',{session_id:ids.session_id,operation_id:randomUUID(),argv:['python3','-I','-c','import time; time.sleep(120)']});
 const beforeProcesses=await Promise.all([terminal.local_pid,command.pid].map(localProcessIdentity));assert.ok(beforeProcesses.every(p=>p && p.state!=='Z'));
 socket=new WebSocket(auth.origin.replace('http:','ws:')+'/sidebar/ws/fs-watch?sessionId='+ids.session_id,{headers:{Cookie:auth.cookie,Origin:auth.origin}});
 await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
 const acknowledged=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('watch acknowledgement timeout')),10000);socket.on('message',bytes=>{const v=JSON.parse(bytes.toString());if(v.ok===true){clearTimeout(timer);resolve(v);}});});
 socket.send(JSON.stringify({op:'watch',path:ids.target_root+'/'+fixture.dir}));assert.equal((await acknowledged).identity.kind,'local');
 const before=snapshots(),ops=sql('SELECT * FROM operation_records ORDER BY rowid'),canary=await hash(fixture.absolute),previous=JSON.parse(await readFile(root+'/ready.json','utf8'));
 assert.equal((await stop(root)).stopped,true);
 const afterProcesses=await Promise.all(beforeProcesses.map(p=>localProcessIdentity(p.pid)));
 for(let i=0;i<beforeProcesses.length;i++) assert.ok(!afterProcesses[i] || afterProcesses[i].start_ticks!==beforeProcesses[i].start_ticks || afterProcesses[i].state==='Z');
 for(const id of [terminal.operation_id,command.operation_id]) assert.equal(sql('SELECT state FROM operation_records WHERE operation_id=?',id)[0].state,'released');
 pass('normal stop joins local native PTY and command and persists release',{beforeProcesses,afterProcesses,terminal_id:termId,operation_ids:[terminal.operation_id,command.operation_id]});
 const ready=await start(root,'127.0.0.1');auth=await authenticate(root);assert.notEqual(ready.run_id,previous.run_id);assert.deepEqual(snapshots(),before);assert.equal(await hash(fixture.absolute),canary);
 for(const old of ops) {
  const row=await rpc('operation.get',{operation_id:old.operation_id});
  for(const key of ['operation_id','session_id','binding_id','version','principal_id','kind','request_sha256','execution_kind','local_runtime_id','local_process_id','local_pid','local_start_ticks','remote_process_id','remote_pid','helper_session_id','channel_id']) assert.equal(row[key],old[key]);
  if(old.state==='unknown') assert.equal(row.state,'unknown');
 }
 assert.equal((await rpc('watch.status')).directories,0);assert.equal((await rpc('watch.status')).clients,0);
 assert.equal(sql('PRAGMA integrity_check')[0].integrity_check,'ok');
 pass('restart retains all snapshots/identities and unknowns; physical bytes persist, watches are cleared',{tables:Object.fromEntries(Object.entries(before).map(([key,value])=>[key,value.length])),operations:ops.length,ready});
 const operationCount=sql('SELECT count(*) n FROM operation_records')[0].n;
 await assert.rejects(native('terminal/create',{agentId:ids.session_id,request:{id:termId,rows:24,cols:80}}),e=>e.code==='agent-studio/operation-exists');
 assert.equal(sql('SELECT count(*) n FROM operation_records')[0].n,operationCount);
 await assert.rejects(rpc('task.read',{session_id:ids.session_id,operation_id:command.operation_id}),e=>e.code==='agent-studio/task-runtime-lost');
 const again=randomUUID();await native('terminal/create',{agentId:ids.session_id,request:{id:again,rows:24,cols:80}});await native('terminal/close',{agentId:ids.session_id,id:again});
 const reused=await demo(root,false,true);delete reused.origin;assert.deepEqual(reused,ids);
 pass('old tab/task cannot replay; explicit new native terminal works; local-demo is idempotent');
 assert.equal((await rpc('remote.status',{session_id:remote.session_id})).connected,false);
 for(const [method,input] of [['fs.read',{path:fixture.path}],['fs.write',{path:fixture.path,operation_id:randomUUID(),encoding:'utf8',data:'MUST_NOT_WRITE_LOCAL',expected_version:null}],['command.start',{operation_id:randomUUID(),argv:['/bin/sh','-c','printf MUST_NOT_EXECUTE > '+JSON.stringify(fixture.path)]}],['fs.search',{query:'content:'+fixture.needle}],['reference.create',{path:fixture.path}]]) {
  await assert.rejects(rpc(method,{session_id:remote.session_id,...input}),e=>e.code==='agent-studio/channel-disconnected');
 }
 assert.equal(await hash(fixture.absolute),canary);assert.equal(Buffer.from((await rpc('fs.read',{session_id:ids.session_id,path:fixture.path})).data,'base64').toString(),await readFile(fixture.absolute,'utf8'));
 pass('disconnected remote reads/writes/exec/search/reference never fall back local',{local_canary_sha256:canary});
 await demo(root,true);
 const rootList=await rpc('fs.list',{session_id:remote.session_id,path:''});
 if(!rootList.entries.some(e=>e.name===fixture.dir)) await rpc('fs.mkdir',{session_id:remote.session_id,path:fixture.dir,operation_id:randomUUID()});
 const listing=await rpc('fs.list',{session_id:remote.session_id,path:fixture.dir});
 let version=null;if(listing.entries.some(e=>e.name==='中文 file.txt')) version=(await rpc('fs.read',{session_id:remote.session_id,path:fixture.path})).version;
 const remoteContent='REMOTE_D04_'+fixture.runId+'\nSame relative filename, different environment\n';
 await rpc('fs.write',{session_id:remote.session_id,path:fixture.path,operation_id:randomUUID(),encoding:'utf8',data:remoteContent,expected_version:version});
 assert.equal(Buffer.from((await rpc('fs.read',{session_id:remote.session_id,path:fixture.path})).data,'base64').toString(),remoteContent);
 assert.equal(await hash(fixture.absolute),canary);
 const reference=await rpc('reference.create',{session_id:remote.session_id,path:fixture.path});assert.equal(reference.identity.kind,'remote');assert.equal(JSON.parse(reference.text.split('\n').slice(1).join('\n')).content,remoteContent);
 pass('connected local and remote have same relative file with distinct bytes and typed snapshots',{local_path:fixture.absolute,remote_path:remote.target_root+'/'+fixture.path,remote_sha256:reference.sha256});
 report.result='pass-limited-development';
} catch(error) {report.result='fail';report.failures.push({name:'D04_LOCAL_RESTART',code:error.code,message:error.message,stack:error.stack});process.exitCode=1;}
finally {socket?.close();await mkdir(repo+'/artifacts/d04',{recursive:true});const output=repo+'/artifacts/d04/restart-'+randomUUID()+'.json';await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({result:report.result,checks:report.checks.length,failures:report.failures,output},null,2));}
