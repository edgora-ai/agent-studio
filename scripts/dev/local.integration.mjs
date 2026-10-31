#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,symlink,lstat} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {createRequire} from 'node:module';
import {authenticate,requestRpc,DEFAULT_ROOT as root,repo} from './preview.mjs';
import {localProcessIdentity} from '../../packages/dsh-agent-studio/adapters/local-provider.mjs';
const {WebSocket}=createRequire('/home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh/package.json')('ws');
const auth=await authenticate(root),ids=JSON.parse(await readFile(root+'/local-demo.json','utf8'));
const runId=randomUUID(),dir='d04-'+runId,path=dir+'/中文 file.txt',absolute=ids.target_root+'/'+path;
const report={scope:'D04 local development, not whole-project acceptance',runId,ids,checks:[],failures:[]},active=new Set(),sockets=[];
const hash=value=>createHash('sha256').update(value).digest('hex');
const rpc=(method,input={})=>requestRpc(auth,method,input),scoped=(method,input={})=>rpc(method,{session_id:ids.session_id,...input});
const side=async(method,input={})=>{
 const response=await fetch(auth.origin+'/sidebar/api/'+method,{method:'POST',headers:{cookie:auth.cookie,origin:auth.origin,'content-type':'application/json'},body:JSON.stringify({sessionId:ids.session_id,...input})});
 const result=await response.json();if(!result.ok) throw Object.assign(new Error(result.error.message),{code:result.error.code,status:response.status});return result.value;
};
const pass=(name,facts={})=>{report.checks.push({name,...facts});console.log('PASS '+name);};
async function until(predicate,ms=15000) {const end=Date.now()+ms;while(Date.now()<end) {const value=await predicate();if(value) return value;await delay(100);}throw new Error('observation deadline');}
async function finish(operation_id) {
 const state=await scoped('task.status',{operation_id});
 if(state.running) await scoped('task.cancel',{operation_id,action_id:randomUUID()});
 await scoped('task.release',{operation_id,action_id:randomUUID()});active.delete(operation_id);
}
async function command(argv,extra={}) {
 const operation_id=randomUUID(),started=await scoped('command.start',{operation_id,argv,...extra});active.add(operation_id);
 let cursor='0';const chunks=[];
 await until(async()=>{const page=await scoped('task.read',{operation_id,after_seq:cursor});cursor=page.nextSeq;assert.equal(page.truncated,false);chunks.push(...page.chunks);if(page.exited){assert.equal(page.exitCode,0,JSON.stringify(page));return page;}},25000);
 await finish(operation_id);return {...started,stdout:Buffer.concat(chunks.filter(c=>c.stream==='stdout').map(c=>Buffer.from(c.data,'base64'))).toString(),stderr:Buffer.concat(chunks.filter(c=>c.stream==='stderr').map(c=>Buffer.from(c.data,'base64'))).toString()};
}
async function operation(operation_id) {
 const db=new DatabaseSync(root+'/bindings.sqlite',{readOnly:true});const row={...db.prepare('SELECT * FROM operation_records WHERE operation_id=?').get(operation_id)};db.close();
 assert.deepEqual(await rpc('operation.get',{operation_id}),row);assert.deepEqual((await scoped('operation.list')).find(r=>r.operation_id===operation_id),row);
 assert.equal(row.execution_kind,'local');for(const field of ['channel_id','helper_session_id','remote_process_id','remote_pid']) assert.equal(row[field],null);
 return row;
}
try {
 const baseline=JSON.parse(await readFile(repo+'/artifacts/d04/pre-migration.json','utf8')),db=new DatabaseSync(root+'/bindings.sqlite',{readOnly:true});
 assert.equal(db.prepare('PRAGMA user_version').get().user_version,5);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 for(const [table,prior] of Object.entries(baseline.rows)) assert.equal(hash(JSON.stringify(db.prepare(`SELECT ${prior.columns.join(',')} FROM ${table} ORDER BY rowid LIMIT ?`).all(prior.count))),prior.sha256,table);
 for(const [table,key,method] of [['projects','project_id','project'],['environments','environment_id','environment'],['project_bindings','binding_id','binding'],['session_bindings','session_id','session']]) {
  const row={...db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(ids[key])},input={[key]:ids[key],...(method==='binding'?{version:ids.version}:{})};
  const read=await rpc(method+'.get',input);if(method==='session') delete read.native;
  assert.deepEqual(read,row);assert.ok((await rpc(method+'.list')).some(r=>r[key]===row[key]));
 }
 db.close();pass('schema v5 preserves every prior column/row; local records SQL -> full API -> list');
 assert.equal((await fetch(auth.origin+'/agent-studio/health')).status,200);
 for(const endpoint of ['/agent-studio-rpc/fs.list','/sidebar/api/fs.tree','/sidebar/api/fs.search','/sidebar/api/git.status','/sidebar/api/reference.create']) for(const cookie of ['', 'dsh_auth=invalid']) {
  const response=await fetch(auth.origin+endpoint,{method:'POST',headers:{'content-type':'application/json',cookie,origin:auth.origin},body:JSON.stringify({sessionId:ids.session_id})});assert.equal(response.status,401);
 }
 pass('public 200; missing and wrong auth 401 on all local product routes');
 const check=await scoped('dispatch.check',{operation:'command.exec'});assert.equal(check.executed,false);assert.equal(check.provider,'local-managed');assert.equal(check.execution_available,true);
 await scoped('fs.mkdir',{path:dir,operation_id:randomUUID()});
 const initial='local original\nD04_LOCAL_'+runId+'\n';
 const write=await scoped('fs.write',{path,operation_id:randomUUID(),encoding:'utf8',data:initial,expected_version:null});
 assert.equal(await readFile(absolute,'utf8'),initial);assert.equal(hash(await readFile(absolute)),write.sha256);
 const read=await scoped('fs.read',{path});assert.equal(Buffer.from(read.data,'base64').toString(),initial);assert.equal(read.sha256,write.sha256);assert.ok((await scoped('fs.list',{path:dir})).entries.some(r=>r.name==='中文 file.txt'));
 assert.equal((await operation(write.operation_id)).state,'completed');pass('mkdir/write real disk bytes and SHA -> full read -> list',{path,sha256:write.sha256,strong_version:read.version});
 const started=await command(['python3','-I','-c','import os,json;print(json.dumps({"cwd":os.getcwd(),"env":dict(os.environ),"pid":os.getpid()}))']);
 const facts=JSON.parse(started.stdout);assert.equal(facts.cwd,ids.target_root);assert.equal(facts.pid,started.pid);assert.equal(facts.env.HOME,root+'/local/d04-local-v1/home');
 assert.deepEqual(Object.keys(facts.env).sort(),['HOME','LANG','LC_ALL','PATH','TMPDIR']);assert.equal(started.stderr,'');
 const stored=await operation(started.operation_id);assert.equal(stored.local_pid,started.pid);assert.equal(stored.local_start_ticks,started.start_ticks);assert.equal(stored.state,'released');
 const observed=await localProcessIdentity(started.pid);assert.ok(!observed || observed.start_ticks!==started.start_ticks || observed.state==='Z');
 pass('real SDK command: cwd, exact env, local PID/startTick SQL identity, stop and release',{operation_id:started.operation_id,...facts,start_ticks:started.start_ticks});
 await assert.rejects(scoped('command.start',{operation_id:randomUUID(),argv:['true'],env:{HOME:'/tmp'}}),e=>e.code==='agent-studio/local-env-denied');
 for(const input of [{binding_id:'wrong-binding'},{version:ids.version+1},{path:'../escape'},{path:'/etc/passwd'}]) await assert.rejects(scoped('fs.read',{path,...input}));
 const canary=root+'/local/d04-local-v1/'+runId+'-canary';await writeFile(canary,'local-canary-'+runId,{flag:'wx',mode:0o600});await symlink(canary,ids.target_root+'/'+dir+'/link');await writeFile(ids.target_root+'/'+dir+'/.gitignore','link\n',{flag:'wx',mode:0o600});
 await assert.rejects(scoped('fs.read',{path:dir+'/link'}),e=>e.code==='agent-studio/path-outside-binding');
 assert.equal(await readFile(canary,'utf8'),'local-canary-'+runId);pass('independent execute env policy; path, symlink, binding and version failures closed');
 await command(['python3','-I','-c',`from pathlib import Path\nimport subprocess\nr=Path.cwd()\np=r/${JSON.stringify(path)}\nif not (r/'.git').exists(): subprocess.run(['git','init','--quiet'],check=True)\nsubprocess.run(['git','--literal-pathspecs','add','--',${JSON.stringify(path)}],check=True)\np.write_text(${JSON.stringify('local edited\nD04_LOCAL_'+runId+'\n')},encoding='utf-8')`]);
 const status=await side('git.status'),staged=await side('git.diff',{path,staged:true,repo_id:status.repo_id}),work=await side('git.diff',{path,staged:false,repo_id:status.repo_id});
 assert.equal(status.identity.kind,'local');assert.equal(status.entries.find(e=>e.path===path).xy,'AM');assert.match(staged.diff,/local original/);assert.match(work.diff,/local edited/);assert.equal(status.unborn,true);
 const found=await side('fs.search',{query:'content:D04_LOCAL_'+runId});assert.equal(found.hits[0].path,absolute);assert.equal(found.hits[0].line,2);assert.equal(found.identity.kind,'local');assert.ok(found.reasons.includes('symlink-skipped'));
 const reference=await side('reference.create',{path:absolute});assert.match(reference.label,/ · local /);const citation=JSON.parse(reference.text.split('\n').slice(1).join('\n'));
 assert.equal(citation.content,await readFile(absolute,'utf8'));assert.equal(citation.sha256,hash(await readFile(absolute)));assert.equal(citation.identity.binding_id,ids.binding_id);
 for(const result of [status,staged,work,found]) assert.equal((await operation(result.operation_id)).state,'released');
 pass('same provider: search line, Git status/two diffs, named local snapshot and actual bytes',{hit:found.hits[0],label:reference.label,repo_id:status.repo_id,partial:found.reasons});
 const before=await scoped('fs.read',{path}),mtime=(await side('fs.read',{path:absolute})).mtimeMs;
 await writeFile(absolute,'external edit\nD04_LOCAL_'+runId+'\n');const physical=hash(await readFile(absolute));
 await assert.rejects(scoped('fs.write',{path,operation_id:randomUUID(),encoding:'utf8',data:'lost update',expected_version:before.version}),e=>e.code==='agent-studio/E_STALE_VERSION');
 const save=await fetch(auth.origin+'/sidebar/write?'+new URLSearchParams({sessionId:ids.session_id,path:absolute,expectedMtimeMs:String(mtime)}),{method:'POST',headers:{cookie:auth.cookie,origin:auth.origin},body:'lost UI update'});assert.equal(save.status,409);assert.equal((await save.json()).error.code,'conflict');assert.equal(hash(await readFile(absolute)),physical);
 pass('strong CAS and original sidebar timestamp bridge reject external-change overwrite',{sha256:physical});
 const ws=new WebSocket(auth.origin.replace('http:','ws:')+'/sidebar/ws/fs-watch?sessionId='+ids.session_id,{headers:{Cookie:auth.cookie,Origin:auth.origin}});sockets.push(ws);const frames=[];ws.on('message',data=>frames.push(JSON.parse(data.toString())));
 await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});ws.send(JSON.stringify({op:'watch',path:ids.target_root+'/'+dir}));await until(()=>frames.some(f=>f.ok===true));
 await writeFile(absolute,'external watched\nD04_LOCAL_'+runId+'\n');await until(()=>frames.some(f=>f.ok===undefined && f.dir));assert.ok(frames.every(f=>f.identity.kind==='local'));
 ws.close();await until(async()=>(await rpc('watch.status')).directories===0);pass('original watch socket: explicit local bounded polling, external write and cleanup',{frames});
 const terminalId=randomUUID(),pty=await scoped('command.start',{operation_id:terminalId,argv:['/bin/bash','--noprofile','--norc'],tty:{rows:24,cols:80},env:{TERM:'xterm-256color'}});active.add(terminalId);
 const live=await localProcessIdentity(pty.pid);assert.equal(live.start_ticks,pty.start_ticks);assert.equal(live.session,pty.pid);
 await scoped('task.resize',{operation_id:terminalId,action_id:randomUUID(),rows:33,cols:101});
 const ptyPath=dir+'/pty.txt',tag='D04_PTY_'+runId;
 await scoped('task.input',{operation_id:terminalId,action_id:randomUUID(),data:`printf '${tag}\\n' > '${ptyPath}'; stty size; printf '\\n${tag}\\n'\n`});
 let cursor='0',output='';await until(async()=>{const page=await scoped('task.read',{operation_id:terminalId,after_seq:cursor});cursor=page.nextSeq;output+=Buffer.concat(page.chunks.map(c=>Buffer.from(c.data,'base64'))).toString();return output.split(/\r?\n/).includes(tag);});
 assert.match(output,/33 101/);assert.equal(await readFile(ids.target_root+'/'+ptyPath,'utf8'),tag+'\n');
 await finish(terminalId);assert.equal((await operation(terminalId)).state,'released');const gone=await localProcessIdentity(pty.pid);assert.ok(!gone || gone.start_ticks!==pty.start_ticks || gone.state==='Z');
 await assert.rejects(scoped('command.start',{operation_id:terminalId,argv:['/bin/bash']}),e=>e.code==='agent-studio/operation-exists');
 pass('real local PTY input/output, resize, physical file, PID/startTick, cancel/release and no replay',{pty,output});
 const legacy=(await rpc('environment.list')).find(e=>e.catalog_key==='local-preview');assert.equal(legacy.provider,'local-metadata');
 const old=(await rpc('binding.list')).find(b=>b.environment_id===legacy.environment_id),oldSession=(await rpc('session.list')).find(s=>s.binding_id===old.binding_id);
 await assert.rejects(rpc('fs.list',{session_id:oldSession.session_id,path:''}),e=>e.code==='agent-studio/provider-unavailable');
 pass('original D01 local metadata-only policy is unchanged');
 await writeFile(repo+'/artifacts/d04/ui-fixture.json',JSON.stringify({...ids,dir,path,absolute,needle:'D04_LOCAL_'+runId,runId,canary},null,2));
 report.result='pass-limited-development';
} catch(error) {report.result='fail';report.failures.push({name:'D04_LOCAL_INTEGRATION',message:error.message,code:error.code,stack:error.stack});process.exitCode=1;}
finally {
 for(const socket of sockets) socket.close();
 for(const operation_id of active) try {await finish(operation_id);} catch(error) {report.failures.push({name:'cleanup',operation_id,code:error.code});process.exitCode=1;}
 await mkdir(repo+'/artifacts/d04',{recursive:true});const output=repo+'/artifacts/d04/integration-'+runId+'.json';await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({result:report.result,checks:report.checks.length,failures:report.failures,output},null,2));
}
