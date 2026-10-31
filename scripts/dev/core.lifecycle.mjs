#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {authenticate,requestRpc,DEFAULT_ROOT as root,repo,stop,start} from './preview.mjs';
const {WebSocket}=createRequire('/home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh/package.json')('ws');
const ids=JSON.parse(await readFile(root+'/remote-demo.json','utf8')),fixture=JSON.parse(await readFile(repo+'/artifacts/d03/ui-fixture.json','utf8'));
let auth=await authenticate(root);
const report={checks:[],failures:[],scope:'D03-core cancellation/watch/restart development'},sockets=[];
const rpc=(m,p={})=>requestRpc(auth,m,p),scoped=(m,p={})=>rpc(m,{session_id:ids.session_id,...p});
const pass=(name,data={})=>{report.checks.push({name,...data});console.log('PASS '+name);};
const query=(sql,...args)=>{const db=new DatabaseSync(root+'/bindings.sqlite',{readOnly:true});try{return db.prepare(sql).all(...args).map(r=>({...r}));}finally{db.close();}};
const snapshot=()=>Object.fromEntries(['projects','environments','instance_records','project_bindings','session_bindings','file_read_versions'].map(t=>[t,query('SELECT * FROM '+t+' ORDER BY rowid')]));
async function until(fn,ms=25000) {const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await delay(50);}throw new Error('lifecycle observation deadline');}
async function watch() {
 const ws=new WebSocket(auth.origin.replace('http:','ws:')+'/sidebar/ws/fs-watch?sessionId='+ids.session_id,{headers:{Cookie:auth.cookie,Origin:auth.origin}}),frames=[];sockets.push(ws);
 ws.on('message',data=>frames.push(JSON.parse(data.toString())));
 await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
 ws.send(JSON.stringify({op:'watch',path:ids.target_root+'/'+fixture.dir}));await until(()=>frames.some(f=>f.ok===true));return {ws,frames};
}
async function operation(id) {
 const row=query('SELECT * FROM operation_records WHERE operation_id=?',id)[0];assert.deepEqual(await rpc('operation.get',{operation_id:id}),row);assert.ok((await scoped('operation.list')).some(r=>r.operation_id===id));return row;
}
function observe(pid) {
 const r=spawnSync('/usr/bin/python3',['-I',repo+'/scripts/dev/observe_remote.py',root],{input:JSON.stringify({...ids,paths:[],pids:[pid]}),encoding:'utf8',timeout:90000,maxBuffer:1048576,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
 assert.equal(r.status,0,'readonly observer failed');return JSON.parse(r.stdout).processes[0];
}
try {
 await scoped('remote.connect');
 const tag='cancel-'+randomUUID(),controller=new AbortController();
 const pending=fetch(auth.origin+'/sidebar/api/fs.search',{method:'POST',headers:{cookie:auth.cookie,origin:auth.origin,'content-type':'application/json'},body:JSON.stringify({sessionId:ids.session_id,query:'content:'+tag}),signal:controller.signal}).then(res=>res.json()).catch(error=>({aborted:error.name==='AbortError',error:error.name}));
 const row=await until(()=>query("SELECT * FROM operation_records WHERE kind='command.exec' AND request_json LIKE ? ORDER BY rowid DESC LIMIT 1",'%'+tag+'%')[0]);
 controller.abort();const cancelled=await pending;assert.equal(cancelled.aborted,true);
 const released=await until(()=>{const r=query('SELECT * FROM operation_records WHERE operation_id=?',row.operation_id)[0];return r.state==='released'?r:undefined;});
 assert.ok(released.remote_pid);const observed=observe(released.remote_pid);assert.ok(observed.exists===false || observed.state==='Z');
 const record=await operation(row.operation_id);assert.equal(record.state,'released');
 pass('aborted product search -> exact persisted task stopped/released -> independent PID -> full API/list',{operation_id:row.operation_id,remote_pid:released.remote_pid,after:observed});
 const subscriber=await watch();
 await scoped('remote.disconnect');await until(()=>subscriber.frames.some(f=>f.ok===false));await until(async()=>(await rpc('watch.status')).directories===0);
 const verdict=subscriber.frames.find(f=>f.ok===false);assert.equal(verdict.complete,false);
 await assert.rejects(scoped('git.status'),e=>e.code==='agent-studio/channel-disconnected');
 await assert.rejects(scoped('fs.search',{query:fixture.needle}),e=>e.code==='agent-studio/channel-disconnected');
 pass('remote disconnect refuses reads, emits incomplete watch failure and releases shared poll',{verdict});
 await scoped('remote.connect');
 const armed=await watch(),before=snapshot(),operations=query('SELECT operation_id,session_id,binding_id,version,request_sha256 FROM operation_records ORDER BY rowid');
 const stopped=await stop(root);await until(()=>armed.ws.readyState===3);assert.equal(stopped.stopped,true);
 const started=await start(root,'127.0.0.1');auth=await authenticate(root);
 assert.deepEqual(snapshot(),before);
 assert.deepEqual(query('SELECT operation_id,session_id,binding_id,version,request_sha256 FROM operation_records ORDER BY rowid'),operations);
 assert.equal(query('PRAGMA integrity_check')[0].integrity_check,'ok');
 assert.equal((await rpc('watch.status')).directories,0);
 assert.equal((await rpc('watch.status')).clients,0);
 await assert.rejects(scoped('fs.search',{query:fixture.needle}),e=>e.code==='agent-studio/channel-disconnected');
 await scoped('remote.connect');const status=await scoped('git.status');assert.equal(status.identity.binding_id,ids.binding_id);assert.equal(status.unborn,true);
 const found=await scoped('fs.search',{query:'content:'+fixture.needle});assert.ok(found.hits.some(hit=>hit.path===fixture.absolute));
 pass('restart with armed watch: socket stopped, all durable identities/versions unchanged, no polling resurrection or command replay',{origin:started.origin,tables:Object.fromEntries(Object.entries(before).map(([k,v])=>[k,v.length])),operations:operations.length,watch:await rpc('watch.status')});
 assert.equal(query("SELECT COUNT(*) AS n FROM operation_records WHERE state IN ('running','pending')")[0].n,0);
 report.result='pass-limited-development';
} catch(error) {report.result='fail';report.failures.push({name:'D03_CORE_LIFECYCLE',message:error.message,code:error.code,stack:error.stack});process.exitCode=1;}
finally {for(const socket of sockets) socket.close();await mkdir(repo+'/artifacts/d03',{recursive:true});const output=repo+'/artifacts/d03/lifecycle-'+randomUUID()+'.json';await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({result:report.result,checks:report.checks.length,failures:report.failures,output},null,2));}
