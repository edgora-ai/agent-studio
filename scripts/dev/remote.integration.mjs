#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {authenticate,requestRpc,DEFAULT_ROOT as root,repo} from './preview.mjs';

const auth=await authenticate(root), ids=JSON.parse(await readFile(join(root,'remote-demo.json'),'utf8'));
const session_id=ids.session_id;
const report={scope:'D02 development-only; not M1/M2 acceptance',root,ids,checks:[],failures:[]};
const rpc=(method,payload={})=>requestRpc(auth,method,payload);
const scoped=(method,payload={})=>rpc(method,{session_id,...payload});
const pass=(name,facts={})=>{report.checks.push({name,...facts});console.log('PASS '+name);};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const active=new Set();
function observe(paths=[],pids=[]) {
  const result=spawnSync('/usr/bin/python3',['-I',join(repo,'scripts/dev/observe_remote.py'),root],{
    input:JSON.stringify({...ids,paths,pids}),encoding:'utf8',timeout:90000,
    env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},maxBuffer:1024*1024});
  assert.equal(result.status,0,`Independent observation failed (${result.status}); diagnostics withheld`);
  return JSON.parse(result.stdout);
}
async function operation(operation_id) {
  const db=new DatabaseSync(join(root,'bindings.sqlite'),{readOnly:true});
  const row={...db.prepare('SELECT * FROM operation_records WHERE operation_id=?').get(operation_id)};db.close();
  assert.deepEqual(await rpc('operation.get',{operation_id}),row);
  assert.ok((await scoped('operation.list')).some(item=>item.operation_id===operation_id));
  pass('operation SQL -> complete API -> ID/list',{row});return row;
}
async function until(operation_id,predicate) {
  let cursor='0',chunks=[];
  for(let i=0;i<40;i++) {
    const page=await scoped('task.read',{operation_id,after_seq:cursor});cursor=page.nextSeq;chunks.push(...page.chunks);
    assert.equal(page.truncated,false);
    const stdout=Buffer.concat(chunks.filter(c=>['stdout','pty'].includes(c.stream)).map(c=>Buffer.from(c.data,'base64'))).toString();
    const stderr=Buffer.concat(chunks.filter(c=>c.stream==='stderr').map(c=>Buffer.from(c.data,'base64'))).toString();
    if(predicate({page,stdout,stderr})) return {page,stdout,stderr};
    if(page.exited) throw new Error('Task exited before expected output');
    await delay(100);
  }
  throw new Error('Task observation deadline');
}
async function denied(method,input,expected) {
  await assert.rejects(scoped(method,input),error=>error.code==='agent-studio/'+expected);pass(`${method} rejects ${expected}`);
}
async function finish(operation_id) {
  const state=await scoped('task.status',{operation_id});
  if(state.running) await scoped('task.cancel',{operation_id,action_id:randomUUID()});
  await scoped('task.release',{operation_id,action_id:randomUUID()});active.delete(operation_id);
}
try {
  const connected=await scoped('remote.connect');assert.equal(connected.connected,true);pass('same-channel verified helper connection',{connected});
  const stem='d02-'+randomUUID();
  const text=Buffer.from('Remote UTF8 中文\n'+randomUUID()+'\n');const binary=randomBytes(32768);
  for(const [path,bytes] of [[stem+'.txt',text],[stem+'.bin',binary]]) {
    const operation_id=randomUUID();
    await scoped('fs.write',{path,operation_id,encoding:'base64',data:bytes.toString('base64'),expected_version:null});
    const physical=observe([path]).files[0];assert.equal(physical.sha256,sha(bytes));assert.equal(physical.bytes,bytes.length);
    const read=await scoped('fs.read',{path});assert.deepEqual(Buffer.from(read.data,'base64'),bytes);
    assert.ok((await scoped('fs.list',{path:''})).entries.some(entry=>entry.name===path));
    await operation(operation_id);pass('remote write -> independent physical bytes/hash -> full provider read -> list',{path,...physical});
  }
  const before=await scoped('fs.read',{path:stem+'.txt'}), replacement='Remote edit persisted\n'+randomUUID();
  await scoped('fs.write',{path:stem+'.txt',operation_id:randomUUID(),encoding:'utf8',data:replacement,expected_version:before.version});
  await denied('fs.write',{path:stem+'.txt',operation_id:randomUUID(),encoding:'utf8',data:'must not overwrite',expected_version:before.version},'E_STALE_VERSION');
  assert.equal(observe([stem+'.txt']).files[0].sha256,sha(Buffer.from(replacement)));pass('guarded version conflict leaves remote replacement intact');
  await denied('fs.read',{path:'../outside'},'path-outside-binding');
  await denied('fs.write',{path:stem+'.txt',operation_id:randomUUID(),encoding:'utf8',data:'no version'},'version-required');
  const command_id=randomUUID();
  const cmd=await scoped('command.start',{operation_id:command_id,cwd:'',env:{D02_SYNTHETIC:'visible'},argv:['python3','-I','-c',
    'import json,os,sys; print(json.dumps({"cwd":os.getcwd(),"env":os.getenv("D02_SYNTHETIC"),"pid":os.getpid(),"isatty":os.isatty(0)}),flush=True); print("stderr-observed",file=sys.stderr); sys.exit(7)']});
  active.add(command_id);
  const output=await until(command_id,({page})=>page.exited);
  const info=JSON.parse(output.stdout.trim());assert.equal(info.cwd,ids.target_root);assert.equal(info.env,'visible');assert.equal(info.pid,cmd.pid);assert.equal(info.isatty,false);assert.equal(output.page.exitCode,7);assert.match(output.stderr,/stderr-observed/);
  await operation(command_id);pass('remote command cwd/env/stdout/stderr/exit and real remote PID',{info,exit:output.page.exitCode});
  await denied('command.start',{operation_id:command_id,argv:['/usr/bin/true']},'operation-exists');
  await finish(command_id);
  const pty_id=randomUUID();
  const pty=await scoped('command.start',{operation_id:pty_id,tty:{rows:25,cols:90},argv:['python3','-I','-u','-c',
    'import os,json,signal,sys; print(json.dumps({"tty":os.isatty(0),"pid":os.getpid(),"start_tick":open("/proc/self/stat").read().split(") ")[1].split()[19]}),flush=True); signal.signal(signal.SIGWINCH,lambda a,b:print("SIZE:"+str(os.get_terminal_size(0)),flush=True));\nfor line in sys.stdin: print("INPUT:"+line.strip(),flush=True)']});
  active.add(pty_id);
  const initial=await until(pty_id,({stdout})=>stdout.includes('start_tick'));const ttyInfo=JSON.parse(initial.stdout.trim());assert.equal(ttyInfo.tty,true);assert.equal(ttyInfo.pid,pty.pid);
  const observed=observe([], [pty.pid]).processes[0];assert.equal(observed.start_tick,ttyInfo.start_tick);assert.equal(observed.cwd,ids.target_root);assert.equal(observed.coder_credentials_present,false);
  await scoped('task.input',{operation_id:pty_id,action_id:randomUUID(),data:'d02-input\n'});
  await until(pty_id,({stdout})=>stdout.includes('INPUT:d02-input'));
  await scoped('task.resize',{operation_id:pty_id,action_id:randomUUID(),rows:31,cols:101});
  await until(pty_id,({stdout})=>stdout.includes('columns=101') && stdout.includes('lines=31'));
  await denied('command.start',{operation_id:pty_id,argv:['true']},'operation-exists');
  assert.equal((await scoped('task.status',{operation_id:pty_id})).running,true);
  const cancel=await scoped('task.cancel',{operation_id:pty_id,action_id:randomUUID()});assert.equal(cancel.running,false);
  const dead=observe([], [pty.pid]).processes[0];assert.ok(dead.exists===false || dead.start_tick!==ttyInfo.start_tick || dead.state==='Z');
  await operation(pty_id);await finish(pty_id);pass('PTY isatty/input/resize/cancellation and independent PID/startTick check',{observed,after:dead});
  const closed=await scoped('remote.disconnect');assert.equal(closed.cleanup,'confirmed');
  await denied('fs.read',{path:stem+'.txt'},'channel-disconnected');
  const reopened=await scoped('remote.connect');assert.notEqual(reopened.channel_id,connected.channel_id);
  assert.equal((await scoped('fs.read',{path:stem+'.txt'})).sha256,sha(Buffer.from(replacement)));
  pass('confirmed process/release/workspace/session/transport close; explicit reconnect re-verifies and reuses project',{closed,reopened});
  const side=async(method,payload)=>{
    const response=await fetch(auth.origin+'/sidebar/api/'+method,{method:'POST',headers:{cookie:auth.cookie,origin:auth.origin,'content-type':'application/json'},body:JSON.stringify({sessionId:session_id,...payload})});
    const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.ok,true);return result.value;
  };
  const uiPath=ids.target_root+'/'+stem+'.txt';
  assert.ok((await side('fs.trees',{paths:[ids.target_root]})).levels[0].entries.some(entry=>entry.path===uiPath));
  const draft=await side('fs.read',{path:uiPath});assert.equal(draft.content,replacement);
  const ro=new DatabaseSync(join(root,'bindings.sqlite'),{readOnly:true});
  const baseline={...ro.prepare('SELECT * FROM file_read_versions WHERE session_id=? AND path=? AND mtime_ms=?').get(session_id,stem+'.txt',String(draft.mtimeMs))};ro.close();
  assert.equal(baseline.strong_version,(await scoped('fs.read',{path:stem+'.txt'})).version);
  const uiContent='Original sidebar save 中文 '+randomUUID()+'\n';
  const save=async(mtime,content)=>fetch(auth.origin+'/sidebar/write?'+new URLSearchParams({sessionId:session_id,path:uiPath,expectedMtimeMs:String(mtime)}),{method:'POST',headers:{cookie:auth.cookie,origin:auth.origin,'content-type':'text/plain; charset=utf-8'},body:content});
  const saved=await save(draft.mtimeMs,uiContent);assert.equal(saved.status,200);assert.equal((await saved.json()).value.ok,true);
  assert.equal(observe([stem+'.txt']).files[0].sha256,sha(Buffer.from(uiContent)));
  assert.equal((await side('fs.read',{path:uiPath})).content,uiContent);
  const stale=await save(draft.mtimeMs,'must not overwrite');assert.equal(stale.status,409);assert.equal((await stale.json()).error.code,'conflict');
  const native=(method,args)=>requestRpc(auth,method,{args},'/api');
  const host=await native('workspaceFiles/read',{workspaceFileScopeId:session_id,path:uiPath,range:{}});assert.equal(host.text,uiContent.trimEnd());
  assert.ok((await native('workspaceFiles/list',{workspaceFileScopeId:session_id,path:'.'})).entries.some(entry=>entry.name===stem+'.txt'));
  await assert.rejects(native('workspaceFiles/read',{workspaceFileScopeId:session_id,path:'/etc/passwd',range:{}}),error=>error.code==='agent-studio/path-outside-binding');
  pass('original sidebar Files and Host workspaceFiles use remote bytes and durable strong CAS baseline',{baseline,host});
  await writeFile(join(repo,'artifacts/d02/ui-fixture.json'),JSON.stringify({path:uiPath,relative:stem+'.txt',content:uiContent,...ids}));
  const terminalId=randomUUID();
  const terminal=await native('terminal/create',{agentId:session_id,request:{id:terminalId,rows:24,cols:80}});
  assert.equal(terminal.cwd,ids.target_root);assert.equal(terminal.state,'running');
  assert.ok((await native('terminal/list',{sessionId:session_id})).some(item=>item.id===terminalId));
  await native('terminal/close',{agentId:session_id,id:terminalId});
  assert.ok(!(await native('terminal/list',{sessionId:session_id})).some(item=>item.id===terminalId));
  pass('original native TerminalController creates and closes real Agent-realm remote PTY',{terminal});
  const shellId=randomUUID();
  await scoped('command.start',{operation_id:shellId,argv:['bash','-i'],tty:{rows:24,cols:80}});active.add(shellId);
  await scoped('task.input',{operation_id:shellId,action_id:randomUUID(),data:"python3 -I -u -c 'import time,signal,sys; signal.signal(signal.SIGINT,lambda a,b:(print(\"SIGNAL-OBSERVED\",flush=True),sys.exit(0))); print(\"SIGNAL-READY\",flush=True); time.sleep(30)'\n"});
  await until(shellId,({stdout})=>stdout.includes('\r\nSIGNAL-READY\r\n'));
  const foreground=await scoped('task.foreground',{operation_id:shellId});assert.equal(foreground.verified,true);
  const signal=await scoped('task.signal',{operation_id:shellId,action_id:randomUUID(),signal:'SIGINT'});
  assert.equal(signal.delivered,true);assert.equal(signal.verified,true);assert.equal(signal.targetPgid,foreground.pgid);
  await until(shellId,({stdout})=>stdout.includes('\r\nSIGNAL-OBSERVED\r\n'));await finish(shellId);
  pass('PTY foreground identity and SIGINT delivery observed by real child',{foreground,signal});
  // A transport loss is not cancellation. The test task has its own bounded lifetime.
  const lostId=randomUUID(), marker=stem+'-lost.txt',canary=Buffer.from('central-canary-'+randomUUID());
  await writeFile(join(root,'cwd',marker),canary,{mode:0o600});
  const lost=await scoped('command.start',{operation_id:lostId,argv:['python3','-I','-u','-c',
    'import os,time,json; f=open('+JSON.stringify(marker)+',"x"); f.write("once"); f.close(); print(json.dumps({"pid":os.getpid(),"start_tick":open("/proc/self/stat").read().split(") ")[1].split()[19]}),flush=True); time.sleep(20)']});
  const identity=JSON.parse((await until(lostId,({stdout})=>stdout.includes('start_tick'))).stdout.trim());
  const ready=JSON.parse(await readFile(join(root,'ready.json'),'utf8')),brokers=[];
  for(const dir of await readdir('/proc')) {
    if(!/^\d+$/.test(dir)) continue;
    try {
      const args=(await readFile('/proc/'+dir+'/cmdline','utf8')).split('\0');
      if(args.includes(join(repo,'packages/dsh-agent-studio/adapters/coder_broker.py')) && args.includes(root) && args.includes('connect') && args.includes(ids.binding_id)) {
        const stat=(await readFile('/proc/'+dir+'/stat','utf8')).split(') ')[1].split(' ');
        if(Number(stat[1])===ready.pid) brokers.push({pid:Number(dir),start:stat[19]});
      }
    } catch(error) {if(!['ENOENT','EACCES','ESRCH'].includes(error.code)) throw error;}
  }
  assert.equal(brokers.length,1);
  const broker=brokers[0];assert.equal((await readFile('/proc/'+broker.pid+'/stat','utf8')).split(') ')[1].split(' ')[19],broker.start);
  process.kill(broker.pid,'SIGTERM');await delay(500);
  await denied('task.status',{operation_id:lostId},'channel-disconnected');
  const unknown=await operation(lostId);assert.equal(unknown.state,'unknown');assert.equal(unknown.remote_pid,lost.pid);
  assert.deepEqual(await readFile(join(root,'cwd',marker)),canary);
  await scoped('remote.connect');
  await denied('command.start',{operation_id:lostId,argv:['true']},'operation-exists');
  await denied('task.status',{operation_id:lostId},'task-channel-lost');
  await delay(21000);
  const afterLoss=observe([marker],[lost.pid]);assert.equal(afterLoss.files[0].sha256,sha(Buffer.from('once')));
  const old=afterLoss.processes[0];assert.ok(old.exists===false || old.start_tick!==identity.start_tick || old.state==='Z');
  assert.equal((await rpc('operation.get',{operation_id:lostId})).state,'unknown');
  pass('transport loss persists unknown identity, forbids replay, leaves central canary; bounded remote PID observed stopped',{broker,identity,unknown,afterLoss,cleanup:'independently observed stopped after bounded lifetime; no cancellation claim'});
  report.result='pass';
} catch(error) {report.result='fail';report.failures.push({name:error.name,code:error.code,message:error.message});console.error(error);process.exitCode=1;}
finally {
  for(const operation_id of active) {try {await finish(operation_id);} catch(error) {report.failures.push({cleanup:operation_id,code:error.code,message:error.message});report.result='fail';process.exitCode=1;}}
  await mkdir(join(repo,'artifacts/d02'),{recursive:true});
  const file=join(repo,'artifacts/d02',`integration-${randomUUID()}.json`);await writeFile(file,JSON.stringify(report,null,2));
  console.log(JSON.stringify({result:report.result,checks:report.checks.length,evidence:file}));
}
