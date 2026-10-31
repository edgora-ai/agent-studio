#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {authenticate,requestRpc,DEFAULT_ROOT as root,repo} from './preview.mjs';
const {WebSocket}=createRequire('/home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh/package.json')('ws');
const auth=await authenticate(root),ids=JSON.parse(await readFile(root+'/remote-demo.json','utf8'));
const report={scope:'D03-core development, not M1/M2 acceptance',ids,checks:[],failures:[]};
const runId=randomUUID(),dir='d03-'+runId,path=dir+'/中文 file.txt',absolute=ids.target_root+'/'+path;
const rpc=(method,input={})=>requestRpc(auth,method,input),scoped=(method,input={})=>rpc(method,{session_id:ids.session_id,...input});
const side=async(method,input={},signal)=>{
 const res=await fetch(auth.origin+'/sidebar/api/'+method,{method:'POST',headers:{cookie:auth.cookie,origin:auth.origin,'content-type':'application/json'},body:JSON.stringify({sessionId:ids.session_id,...input}),signal});
 const body=await res.json();if(!body.ok) throw Object.assign(new Error(body.error.message),{code:body.error.code,status:res.status});return body.value;
};
const pass=(name,facts={})=>{report.checks.push({name,...facts});console.log('PASS '+name);};
const active=new Set(),sockets=[];
await mkdir(repo+'/artifacts/d03',{recursive:true});
async function finish(id) {
 const status=await scoped('task.status',{operation_id:id});if(status.running) await scoped('task.cancel',{operation_id:id,action_id:randomUUID()});
 await scoped('task.release',{operation_id:id,action_id:randomUUID()});active.delete(id);
}
async function command(script) {
 const operation_id=randomUUID();const p=await scoped('command.start',{operation_id,argv:['python3','-I','-c',script]});active.add(operation_id);
 let cursor='0',chunks=[];
 for(let i=0;i<100;i++) {
  const page=await scoped('task.read',{operation_id,after_seq:cursor});cursor=page.nextSeq;assert.equal(page.truncated,false);chunks.push(...page.chunks);
  if(page.exited) {assert.equal(page.exitCode,0,Buffer.concat(chunks.map(c=>Buffer.from(c.data,'base64'))).toString());await finish(operation_id);return {operation_id,pid:p.pid,stdout:Buffer.concat(chunks.filter(c=>c.stream==='stdout').map(c=>Buffer.from(c.data,'base64'))).toString()};}
 }
 throw new Error('fixture command deadline');
}
function observe(paths) {
 const v=spawnSync('/usr/bin/python3',['-I',repo+'/scripts/dev/observe_remote.py',root],{input:JSON.stringify({...ids,paths,pids:[]}),encoding:'utf8',timeout:90000,maxBuffer:1048576,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
 assert.equal(v.status,0,'readonly observation failed; diagnostics withheld');return JSON.parse(v.stdout);
}
async function sqlOperation(id) {
 const db=new DatabaseSync(root+'/bindings.sqlite',{readOnly:true});const row={...db.prepare('SELECT * FROM operation_records WHERE operation_id=?').get(id)};db.close();
 assert.deepEqual(await rpc('operation.get',{operation_id:id}),row);assert.ok((await scoped('operation.list')).some(r=>r.operation_id===id));assert.equal(row.state,'released');
 return {operation_id:id,request_sha256:row.request_sha256,remote_pid:row.remote_pid,state:row.state};
}
async function watch(path) {
 const ws=new WebSocket(auth.origin.replace('http:','ws:')+'/sidebar/ws/fs-watch?sessionId='+ids.session_id,{headers:{Cookie:auth.cookie,Origin:auth.origin}});sockets.push(ws);
 const frames=[];ws.on('message',data=>frames.push(JSON.parse(data.toString())));
 await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
 ws.send(JSON.stringify({op:'watch',path}));return {ws,frames};
}
async function until(predicate,ms=15000) {const end=Date.now()+ms;while(Date.now()<end){const v=await predicate();if(v)return v;await delay(150);}throw new Error('observation deadline');}
try {
 const before=await side('git.status');pass('non-repository or existing owned synthetic repository reports truth',{isRepo:before.isRepo});
 const prep=await command(`import os,pathlib,subprocess,json\nroot=pathlib.Path.cwd()\nassert str(root)==${JSON.stringify(ids.target_root)}\nd=root/${JSON.stringify(dir)}\nd.mkdir(mode=0o700)\n(d/'many').mkdir()\n(d/'.gitignore').write_text('many/\\n')\nf=d/'中文 file.txt'\nf.write_text('index original\\nD03_INDEX_${runId}\\n',encoding='utf-8')\nif not (root/'.git').exists(): subprocess.run(['git','init','--quiet'],check=True)\nassert not subprocess.run(['git','rev-parse','--verify','HEAD'],capture_output=True).returncode==0\nsubprocess.run(['git','--literal-pathspecs','add','--',str(f.relative_to(root))],check=True)\nf.write_text('worktree edited\\nD03_NEEDLE_${runId}\\n',encoding='utf-8')\nprint(json.dumps({'path':str(f),'pid':os.getpid()}))`);
 const physical=observe([path,'.git/HEAD']);assert.equal(physical.files[0].sha256,createHash('sha256').update('worktree edited\nD03_NEEDLE_'+runId+'\n').digest('hex'));
 assert.equal(Buffer.from((await scoped('fs.read',{path})).data,'base64').toString(),'worktree edited\nD03_NEEDLE_'+runId+'\n');
 assert.ok((await scoped('fs.list',{path:dir})).entries.some(e=>e.name==='中文 file.txt'));
 pass('new fixture only: git init/index, no commit, independent bytes -> full read -> list',{dir,physical,operation:await sqlOperation(prep.operation_id)});
 const status=await side('git.status'),entry=status.entries.find(e=>e.path===path);assert.equal(entry.xy,'AM');assert.equal(status.unborn,true);assert.equal(status.identity.binding_id,ids.binding_id);assert.ok(entry.staged.additions===2 && entry.unstaged.additions===2);
 const index=await side('git.diff',{path,staged:true,repo_id:status.repo_id}),work=await side('git.diff',{path,staged:false,repo_id:status.repo_id});
 assert.match(index.diff,new RegExp('D03_INDEX_'+runId));assert.match(work.diff,new RegExp('D03_NEEDLE_'+runId));assert.equal(index.truncated,false);
 assert.equal((await side('git.diff',{path:dir+'/.gitignore',staged:false})).diff,'');
 assert.equal((await side('git.status',{repoRoot:ids.target_root+'/'+dir})).isRepo,false);
 pass('structured status, unborn HEAD, index/worktree UTF8 diff, empty diff and child non-repository',{entry,identity:status.identity,repo_id:status.repo_id,operations:await Promise.all([status,index,work].map(r=>sqlOperation(r.operation_id)))});
 for(const input of [{path:'../escape'},{path:'/etc/passwd'},{repoRoot:'/etc'},{worktree:'/workspace/other'},{repo_id:'another-repository'}]) await assert.rejects(side('git.diff',input));
 for(const method of ['git.stage','git.unstage','git.commit','git.push','git.checkout','git.discard','git.show']) await assert.rejects(side(method,{path}),e=>e.status===409);
 pass('Git paths/repository assertions and every write route fail closed');
 for(const method of ['git.status','fs.search','reference.create']) {
  await assert.rejects(side(method,{query:'中文',path:absolute,binding_id:'wrong-binding'}),e=>e.code==='binding-mismatch');
  await assert.rejects(side(method,{query:'中文',path:absolute,version:ids.version+1}),e=>e.code==='version-mismatch');
 }
 await assert.rejects(side('fs.read',{repoRoot:ids.target_root+'/'+dir,path:'../'+path}),e=>e.code==='path-outside-binding');
 pass('real read routes enforce binding/version assertions and reject traversal before repoRoot joining');
 const names=await side('fs.search',{query:'中文 file'}),found=await side('fs.search',{query:'content:D03_NEEDLE_'+runId});
 assert.ok(names.matches.includes(absolute));assert.equal(found.hits[0].path,absolute);assert.equal(found.hits[0].line,2);assert.equal(found.hits[0].identity.session_id,ids.session_id);
 const opened=await side('fs.read',{path:found.hits[0].path}),reference=await side('reference.create',{path:found.hits[0].path});
 const citation=JSON.parse(reference.text.split('\n').slice(1).join('\n'));assert.equal(citation.content,opened.content);assert.equal(citation.identity.binding_id,ids.binding_id);assert.equal(citation.path,absolute);
 assert.ok((await side('fs.search',{query:'中文 file',exclude:['*.txt']})).matches.length===0);
 pass('name + literal content search -> bound open -> versioned reference snapshot',{hits:found.hits,sha256:reference.sha256,operations:await Promise.all([names,found].map(r=>sqlOperation(r.operation_id)))});
 const wrong=(await rpc('session.list')).find(r=>r.session_id!==ids.session_id && r.binding_id!==ids.binding_id);assert.ok(wrong);
 for(const method of ['fs.read','reference.create','git.diff']) {
  const res=await fetch(auth.origin+'/sidebar/api/'+method,{method:'POST',headers:{cookie:auth.cookie,origin:auth.origin,'content-type':'application/json'},body:JSON.stringify({sessionId:wrong.session_id,path:absolute,repoRoot:ids.target_root})});assert.equal(res.status,409);
 }
 pass('cached absolute search/diff/reference target cannot be reinterpreted by another binding');
 const first=await watch(ids.target_root+'/'+dir),second=await watch(ids.target_root+'/'+dir);
 await until(()=>first.frames.some(f=>f.ok===true)&&second.frames.some(f=>f.ok===true));
 assert.equal((await rpc('watch.status')).directories,1);
 await command(`from pathlib import Path\np=Path(${JSON.stringify(dir)})/'external.txt'\np.write_text('D03_WATCH_${runId}\\n')`);
 await until(()=>first.frames.some(f=>f.dir&&f.ok===undefined)&&second.frames.some(f=>f.dir&&f.ok===undefined));
 pass('shared remote directory polling sees external bound command write',{first:first.frames,second:second.frames,status:await rpc('watch.status')});
 first.ws.close();second.ws.close();await until(async()=> (await rpc('watch.status')).directories===0);
 pass('last subscriber close releases shared polling');
 await command(`from pathlib import Path\nimport subprocess\nd=Path(${JSON.stringify(dir)})\np=d/'large.txt'\np.write_text('seed\\n')\nsubprocess.run(['git','--literal-pathspecs','add','--',str(p)],check=True)\np.write_text(('D03_BIG_'+'x'*100+'\\n')*4000)\nfor i in range(1002): (d/'many'/('entry-'+str(i))).touch(exist_ok=False)`);
 await assert.rejects(side('git.diff',{path:dir+'/large.txt'}),e=>e.code==='git-output-limit');
 const bounded=await side('fs.search',{query:'entry-'});assert.equal(bounded.truncated,true);assert.ok(bounded.matches.length<=200);assert.ok(bounded.reasons.includes('match-limit'));
 await assert.rejects(scoped('fs.list',{path:dir+'/many'}));
 const big=await watch(ids.target_root+'/'+dir+'/many');await until(()=>big.frames.some(f=>f.ok===false));await until(async()=> (await rpc('watch.status')).directories===0);
 pass('large diff refuses, search signals partial results, oversized directory/list/watch refuses',{search:{truncated:bounded.truncated,count:bounded.matches.length,reasons:bounded.reasons},watch:big.frames});
 const health=await fetch(auth.origin+'/agent-studio/health');assert.equal(health.status,200);
 const unauth=await fetch(auth.origin+'/sidebar/api/git.status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:ids.session_id})});assert.equal(unauth.status,401);
 pass('public health 200 and protected new route 401 without authentication');
 await writeFile(repo+'/artifacts/d03/ui-fixture.json',JSON.stringify({...ids,dir,path,absolute,needle:'D03_NEEDLE_'+runId,runId},null,2));
 report.result='pass-limited-development';
} catch(error) {report.result='fail';report.failures.push({name:'D03_CORE_INTEGRATION',message:error.message,code:error.code,stack:error.stack});process.exitCode=1;}
finally {
 for(const socket of sockets) socket.close();
 for(const id of active) {try{await finish(id);}catch(error){report.failures.push({name:'cleanup',operation_id:id,code:error.code});process.exitCode=1;}}
 await mkdir(repo+'/artifacts/d03',{recursive:true});const output=repo+'/artifacts/d03/integration-'+runId+'.json';
 await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({result:report.result,checks:report.checks.length,failures:report.failures,output},null,2));
}
