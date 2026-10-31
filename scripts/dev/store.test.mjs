import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, statSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../packages/dsh-agent-studio/store.mjs';
import { Bindings } from '../../packages/dsh-agent-studio/bindings.mjs';
import { BoundProvider } from '../../packages/dsh-agent-studio/adapters/bound-provider.mjs';
import {HostFiles} from '../../packages/dsh-agent-studio/adapters/host-files.mjs';
import {BoundReads} from '../../packages/dsh-agent-studio/adapters/bound-reads.mjs';
import {projectSidebar} from './sidebar-projection.mjs';
import {LocalProvider} from '../../packages/dsh-agent-studio/adapters/local-provider.mjs';
import {ModelState,modelCallContext,sha} from '../../packages/dsh-agent-studio/model-state.mjs';
import {ModelSessions} from '../../packages/dsh-agent-studio/model-session.mjs';
import {StudioCredentials} from '../../packages/dsh-agent-studio/credentials.mjs';
import {AcpState,acpOperationContext} from '../../packages/dsh-agent-studio/acp-state.mjs';
import {permissionProjection,formProjection,formContent,controlResponse} from '../../packages/dsh-agent-studio/acp-protocol.mjs';
import {validateBackend,consumeAcpLaunch} from '../../packages/dsh-agent-studio/acp-backends.mjs';
import {AcpSessions} from '../../packages/dsh-agent-studio/acp-session.mjs';

function setup(policy='p1') {
  const root = mkdtempSync(join(tmpdir(),'agent-studio-test-store-'));
  const store = new Store(root);
  const p = store.principal;
  const spec = { key:'test',kind:'local',name:'Test environment',policy_version:policy,generation:'g1',workspace_id:'w1',agent_id:'a1',template_version:'v1',roots:[join(root,'local')] };
  const project = store.project(p,{ name:'Unicode project 中文',source_kind:'registered' });
  const environment = store.environment(p,spec);
  const binding = store.newBinding(p,{ project_id:project.project_id,environment_id:environment.environment_id },join(root,'anchors'));
  return { root,store,p,spec,project,environment,binding };
}

test('migration, transaction, full readonly SQL readback, ownership, list and restart',() => {
  const { root,store,p,project,environment,binding } = setup();
  const read = new DatabaseSync(store.path,{ readOnly:true });
  for (const [table,key,row] of [['projects','project_id',project],['environments','environment_id',environment]]) {
    assert.deepEqual({ ...read.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(row[key]) },row);
    assert.deepEqual(store.get(table,key,row[key],p),row);
    assert.ok(store.list(table,p).some(value => value[key] === row[key]));
    assert.throws(() => store.get(table,key,row[key],'another-owner'),{ code:'not-found' });
  }
  assert.equal(read.prepare('SELECT count(*) n FROM instance_records').get().n,1);
  assert.equal(read.prepare('PRAGMA user_version').get().user_version,8);
  const before = read.prepare('SELECT count(*) n FROM audit_events').get().n;
  assert.throws(() => store.transaction(() => { store.audit(p,'rollback','id','test'); throw new Error('rollback'); }));
  assert.equal(read.prepare('SELECT count(*) n FROM audit_events').get().n,before);
  read.close(); store.close();
  const reopened = new Store(root);
  assert.equal(reopened.principal,p);
  assert.deepEqual(reopened.binding(p,binding.binding_id,1),binding);
  assert.equal(statSync(reopened.path).mode & 0o777,0o600);
  reopened.close();
});

test('immutable snapshots, version CAS, forbidden client paths and principals',() => {
  const { root,store,p,project,environment,binding } = setup();
  assert.throws(() => store.db.prepare('UPDATE project_bindings SET target_root=? WHERE binding_id=?').run('/other',binding.binding_id),/immutable/);
  const input = { project_id:project.project_id,environment_id:environment.environment_id,binding_id:binding.binding_id,expected_version:1 };
  const second = store.newBinding(p,input,join(root,'anchors'));
  assert.equal(second.version,2); assert.notEqual(second.anchor_path,binding.anchor_path);
  assert.equal(store.binding(p,binding.binding_id,1).state,'superseded');
  assert.throws(() => store.newBinding(p,input,join(root,'anchors')),{ code:'version-conflict' });
  assert.throws(() => store.project(p,{ name:'X',principal_id:'forged' }),{ code:'unknown-field' });
  assert.throws(() => store.newBinding(p,{ ...input,target_root:'/arbitrary' },root),{ code:'unknown-field' });
  const service = new Bindings({},store,root,[]);
  assert.throws(() => service.principal({ principal:{ kind:'operator' } }),{ code:'unauthorized' });
  assert.equal(service.principal({ principal:{ kind:'owner' } }),p);
  store.close();
});

test('operation records retain identity, reject replay and preserve unknown outcomes',() => {
  const {root,store,p,binding}=setup();
  store.db.prepare("UPDATE project_bindings SET state='ready' WHERE binding_id=?").run(binding.binding_id);
  const session=store.newSession(p,binding,'Operation test');
  const request={operation_id:'test-operation-identity',argv:['/usr/bin/true']};
  const row=store.beginOperation(p,session,'command.exec',request);
  const ro=new DatabaseSync(store.path,{readOnly:true});
  assert.deepEqual({...ro.prepare('SELECT * FROM operation_records WHERE operation_id=?').get(row.operation_id)},row);
  assert.deepEqual(store.operation(p,row.operation_id),row);
  assert.ok(store.operations(p,session.session_id).some(item=>item.operation_id===row.operation_id));
  assert.throws(()=>store.operation('other-owner',row.operation_id),{code:'operation-not-found'});
  assert.throws(()=>store.beginOperation(p,session,'command.exec',request),{code:'operation-exists'});
  assert.throws(()=>store.db.prepare('UPDATE operation_records SET session_id=? WHERE operation_id=?').run('other',row.operation_id),/immutable/);
  ro.close();store.close();
  const restarted=new Store(root);restarted.markInterrupted();
  assert.equal(restarted.operation(p,row.operation_id).state,'unknown');
  assert.equal(restarted.operation(p,row.operation_id).request_json,JSON.stringify(request));restarted.close();
});

test('duplicate running operation cannot untrack the original process',async () => {
  const {store,p,binding}=setup();
  store.db.prepare("UPDATE project_bindings SET state='ready' WHERE binding_id=?").run(binding.binding_id);
  const session=store.newSession(p,binding,'Tracking test');
  const provider=new BoundProvider({store});
  const channel={proof:{channel_id:'channel'},client:{sessionId:'helper'},processes:new Set(),connected:true};
  const request={operation_id:'duplicate-running-operation'};
  await provider.mutation(p,session,'command.exec',request,channel,async()=>({pid:42}),'remote-process');
  await assert.rejects(provider.mutation(p,session,'command.exec',request,channel,async()=>{throw new Error('must not execute');},'other'),{code:'operation-exists'});
  assert.ok(channel.processes.has(request.operation_id));
  assert.equal(store.operation(p,request.operation_id).remote_process_id,'remote-process');
  channel.uncertain=true;
  await assert.rejects(provider.mutation(p,session,'command.exec',{operation_id:'must-not-retry-read-worker'},channel,async()=>{throw new Error('must not dispatch');},'new-process'),{code:'outcome-unknown'});
  assert.equal(store.operations(p,session.session_id).length,1);
  assert.equal(store.operation(p,request.operation_id).remote_process_id,'remote-process');
  store.close();
});

test('D07 controlled concurrent interruption preserves original operation identities and blocks automatic read-worker redispatch',async()=>{
  const {store,p,binding}=setup();store.db.prepare("UPDATE project_bindings SET state='ready' WHERE binding_id=?").run(binding.binding_id);
  const session=store.newSession(p,binding,'OFFLINE interrupted concurrent reads'),provider=new BoundProvider({store}),pending=[];
  const channel={binding,proof:{channel_id:'original-channel'},client:{sessionId:'original-helper',call:()=>{const gate=Promise.withResolvers();pending.push(gate);return gate.promise;}},processes:new Set(),connected:true,child:{exitCode:255,signalCode:null,kill:()=>{throw new Error('passive loss must not kill');}}};provider.channels.set(provider.key(binding),channel);
  const begin=index=>provider.mutation(p,session,'command.exec',{operation_id:'original-read-worker-'+index},channel,()=>provider.call(channel,'process/start',{}),'original-process-'+index);
  const a=begin(1),b=begin(2),settled=Promise.allSettled([a,b]);assert.equal(pending.length,2);
  const interrupted=Object.assign(new Error('OFFLINE transport loss'),{name:'RemoteHelperCallInterruptedError',kind:'disconnect',mutationMayHaveStarted:true});pending[0].reject(interrupted);provider.lost(channel,interrupted);pending[1].reject(interrupted);await settled;
  const rows=store.operations(p,session.session_id);assert.deepEqual(rows.map(row=>row.state),['unknown','unknown']);assert.deepEqual(rows.map(row=>row.remote_process_id),['original-process-1','original-process-2']);assert.ok(rows.every(row=>row.remote_pid===null&&row.channel_id==='original-channel'&&row.helper_session_id==='original-helper'));
  await assert.rejects(begin(3),{code:'outcome-unknown'});assert.equal(pending.length,2);assert.equal(store.operations(p,session.session_id).length,2);
  await assert.rejects(provider.disconnect(binding),{code:'cleanup-unconfirmed'});assert.equal(store.operations(p,session.session_id)[0].state,'unknown');store.close();
});

test('D07 late process ACK after suspension learns exact PID but never changes unknown back to running or rewrites its cause',async()=>{
 const {store,p,binding}=setup();store.db.prepare("UPDATE project_bindings SET state='ready' WHERE binding_id=?").run(binding.binding_id);
 const session=store.newSession(p,binding,'OFFLINE late ACK'),provider=new BoundProvider({store}),gate=Promise.withResolvers();
 const channel={binding,proof:{channel_id:'late-channel'},client:{sessionId:'late-helper'},processes:new Set(),connected:true};
 const pending=provider.mutation(p,session,'command.exec',{operation_id:'late-ack-original'},channel,()=>gate.promise,'late-process');
 provider.lost(channel,Object.assign(new Error('stale'),{code:'environment-observation-stale'}));gate.resolve({pid:2468});await assert.rejects(pending,{code:'outcome-unknown'});
 const row=store.operation(p,'late-ack-original');assert.equal(row.state,'unknown');assert.equal(row.error_code,'environment-observation-stale');assert.equal(row.remote_pid,2468);assert.equal(row.remote_process_id,'late-process');assert.ok(channel.processes.has(row.operation_id));
 provider.lost(channel,Object.assign(new Error('later close'),{code:'provider-error'}));assert.deepEqual(store.operation(p,row.operation_id),row);assert.equal(store.db.prepare("SELECT count(*) n FROM audit_events WHERE action='operation.late-result'").get().n,1);store.close();
});

test('sidebar timestamp collisions remain ambiguous after restart; aliases need owned context',()=>{
  const {root,store,p,binding}=setup();
  store.db.prepare("UPDATE project_bindings SET state='ready' WHERE binding_id=?").run(binding.binding_id);
  const session=store.newSession(p,binding,'Read version test'),context={session,binding};
  const files=new HostFiles({store});
  assert.equal(files.path(context,binding.anchor_path+'/text.txt'),'text.txt');
  assert.throws(()=>files.path(context,binding.anchor_path+'-other/text.txt'),{code:'path-outside-binding'});
  assert.throws(()=>files.path(context,binding.anchor_path+'/../text.txt'),{code:'path-outside-binding'});
  const result={metadata:{mtimeNs:1770000000000000000},version:'strong-a'};
  const time=files.baseline(context,'text.txt',result);
  const read=new DatabaseSync(store.path,{readOnly:true});
  const query=()=>({...read.prepare('SELECT * FROM file_read_versions WHERE session_id=? AND path=? AND mtime_ms=?').get(session.session_id,'text.txt',String(time))});
  assert.deepEqual(query(),{session_id:session.session_id,path:'text.txt',mtime_ms:String(time),strong_version:'strong-a'});
  files.baseline(context,'text.txt',{...result,version:'strong-b'});assert.equal(query().strong_version,null);
  files.baseline(context,'text.txt',result);assert.equal(query().strong_version,null);
  assert.equal(read.prepare('SELECT count(*) n FROM file_read_versions WHERE session_id=?').get(session.session_id).n,1);
  read.close();store.close();const restarted=new Store(root);
  assert.equal(restarted.db.prepare('SELECT strong_version FROM file_read_versions WHERE session_id=?').get(session.session_id).strong_version,null);
  restarted.close();
});

test('expired pending stays failed without creating a native session',async () => {
  const { root,store,p,binding } = setup();
  store.db.prepare("UPDATE project_bindings SET created_at='2000-01-01T00:00:00.000Z' WHERE binding_id=?").run(binding.binding_id);
  const service = new Bindings({},store,root,[]);
  const summary = await service.reconcile();
  assert.equal(summary.failed,1);
  assert.equal(store.binding(p,binding.binding_id,1).state,'invalid');
  assert.equal(store.binding(p,binding.binding_id,1).error_code,'pending-expired');
  store.close();
});

test('Host scope forwards binding assertions; lexical traversal fails before repo joining',async()=>{
  const {store,p,binding}=setup();let resolved,calls=0;
  const context={binding,session:{session_id:'scope-test'},environment:{provider:'coder-helper'}};
  const studio={resolve:async(principal,input)=>{assert.equal(principal,p);resolved=input;return context;},provider:{file:async()=>{calls++;throw new Error('must not dispatch');}}};
  const files=new HostFiles(studio);
  await files.scope(p,{sessionId:'scope-test',binding_id:binding.binding_id,version:binding.version});
  assert.deepEqual(resolved,{session_id:'scope-test',binding_id:binding.binding_id,version:binding.version});
  await assert.rejects(files.sidebar(p,'fs.read',{sessionId:'scope-test',repoRoot:binding.target_root+'/nested',path:'../outside'}),{code:'path-outside-binding'});
  await assert.rejects(files.scope(p,{sessionId:'scope-test',cwd:'/unowned'}),{code:'cwd-outside-binding'});
  assert.equal(calls,0);store.close();
});

test('bound read unit protocol releases exact task, rejects truncated output and records unknown cleanup',async()=>{
  const context={principal:'p',session:{session_id:'s'},binding:{binding_id:'b',version:1,environment_id:'e',instance_generation:'g',target_root:'/owned-test'}};
  const calls=[],audits=[];let truncated=false,failRelease=false;
  const studio={store:{audit:(...args)=>audits.push(args)},provider:{
    start:async(principal,input)=>{calls.push({method:'start',...input});},
    task:async(principal,method,input)=>{
      calls.push({method,...input});
      if(method==='read') return {nextSeq:'1',truncated,exited:true,exitCode:0,chunks:[{stream:'stdout',data:Buffer.from(JSON.stringify({ok:true,value:{complete:true,hits:[]}})).toString('base64')}]};
      if(method==='status') return {running:false};
      if(method==='release' && failRelease) throw Object.assign(new Error('transport lost'),{code:'channel-disconnected'});
    }
  }};
  const reads=new BoundReads(studio),payload={method:'fs.search',mode:'name',query:'test'};
  const result=await reads.run(context,payload);
  assert.deepEqual(result.identity,reads.identity(context));
  assert.deepEqual(calls.map(x=>x.method),['start','read','status','release']);
  assert.ok(calls.every(x=>x.operation_id===result.operation_id));
  assert.equal(calls[0].argv[4],context.binding.target_root);
  assert.deepEqual(JSON.parse(calls[0].argv[5]),payload);
  truncated=true;await assert.rejects(reads.run(context,payload),{code:'read-output-truncated'});
  assert.equal(calls.at(-1).method,'release');
  truncated=false;failRelease=true;
  await assert.rejects(reads.run(context,payload),{code:'read-cleanup-unconfirmed'});
  assert.equal(audits.at(-1)[3],'unknown');assert.equal(reads.active.get('b'),0);
});

test('fixed worker literal UTF8 search reports lines, exclusions and incomplete skipped data',()=>{
  const root=mkdtempSync(join(tmpdir(),'agent-studio-test-read-'));
  writeFileSync(join(root,'中文 file.txt'),'first\nNeedle 中文\n');
  writeFileSync(join(root,'binary.bin'),Buffer.from([0,1,2]));
  writeFileSync(join(root,'large.txt'),Buffer.alloc(196609,65));
  symlinkSync('中文 file.txt',join(root,'linked.txt'));
  mkdirSync(join(root,'.git'));writeFileSync(join(root,'.git','hidden'),'Needle');
  const worker=new URL('../../packages/dsh-agent-studio/adapters/remote-read.py',import.meta.url);
  const run=payload=>{
    const child=spawnSync('python3',['-I',worker.pathname,root,JSON.stringify(payload)],{cwd:root,encoding:'utf8',timeout:15000,maxBuffer:300000});
    assert.equal(child.error,undefined);assert.equal(child.stderr,'');
    return {code:child.status,...JSON.parse(child.stdout)};
  };
  const found=run({method:'fs.search',mode:'content',query:'needle'});
  assert.equal(found.code,0);assert.equal(found.value.hits.length,1);
  assert.equal(found.value.hits[0].path,join(root,'中文 file.txt'));assert.equal(found.value.hits[0].line,2);
  assert.equal(found.value.complete,false);
  assert.deepEqual(found.value.reasons,['binary-skipped','file-size-limit','symlink-skipped']);
  assert.equal(run({method:'fs.search',mode:'name',query:'中文'}).value.matches.length,1);
  assert.equal(run({method:'fs.search',mode:'name',query:'中文',exclude:['*.txt']}).value.matches.length,0);
  assert.equal(run({method:'fs.search',mode:'content',query:''}).error,'invalid-query');
  assert.equal(run({method:'git.status',repo:'../'}).error,'path-outside-binding');
});

test('hash-locked original sidebar projects all three chunks and refuses an unknown seam',()=>{
  const lock=JSON.parse(readFileSync(new URL('../../profiles/agent-studio-preview/sources.lock.json',import.meta.url)));
  const upstream='/home/ubuntu/.dsh/profiles/web/node_modules/dsh-better-sidebar';
  for(const file of ['lib/client.js','lib/client-registry.js','lib/client-editor.js']) {
    const original=readFileSync(join(upstream,file));
    assert.equal(createHash('sha256').update(original).digest('hex'),lock.sidebar.files[file]);
    const projected=projectSidebar(file,original);assert.notDeepEqual(projected,original);
    const checked=spawnSync(process.execPath,['--check','--input-type=module'],{input:projected,encoding:'utf8',timeout:15000});
    assert.equal(checked.status,0,checked.stderr);
    assert.throws(()=>projectSidebar(file,Buffer.from('unknown upstream bytes')),/seam|mismatch/i);
  }
});

test('local operation identity is durable, immutable and never remote-shaped',()=>{
  const {root,store,p,binding}=setup();store.db.prepare("UPDATE project_bindings SET state='ready' WHERE binding_id=?").run(binding.binding_id);
  const session=store.newSession(p,binding,'Local identity'),request={operation_id:'local-identity-test',argv:['synthetic']};
  store.beginOperation(p,session,'pty.open',request);
  const row=store.updateOperation(p,request.operation_id,{execution_kind:'local',local_runtime_id:'runtime',local_process_id:'local-process',local_pid:123,local_start_ticks:'456',state:'running'});
  const db=new DatabaseSync(store.path,{readOnly:true});assert.deepEqual({...db.prepare('SELECT * FROM operation_records WHERE operation_id=?').get(row.operation_id)},row);db.close();
  for(const updates of [{local_pid:124},{local_start_ticks:'457'},{local_runtime_id:'other'},{execution_kind:'remote'},{remote_pid:123},{helper_session_id:'fake'}]) assert.throws(()=>store.updateOperation(p,row.operation_id,updates),/immutable|remote fields/);
  store.close();const reopened=new Store(root);reopened.markInterrupted();const after=reopened.operation(p,row.operation_id);
  for(const key of ['local_runtime_id','local_process_id','local_pid','local_start_ticks','execution_kind','request_json']) assert.equal(after[key],row[key]);
  assert.equal(after.state,'unknown');assert.throws(()=>reopened.beginOperation(p,session,'pty.open',request),{code:'operation-exists'});reopened.close();
});

test('only authoritative local kind/provider dispatches local; remote failures and stale/unknown cannot fallback',async()=>{
  const {root,store,p,binding}=setup();const studio=new Bindings({},store,root,[]),provider=new BoundProvider(studio);studio.provider=provider;
  let localCalls=0,remoteCalls=0,stale=false;
  let context={session:{session_id:'s'},binding,environment:{kind:'local',provider:'local-managed'},spec:{kind:'local',provider:'local-managed'}};
  studio.resolve=async()=>{if(stale) throw Object.assign(new Error('stale'),{code:'stale-binding'});return context;};
  provider.local.verify=async()=>{localCalls++;};provider.local.file=async()=>({provider:'local-managed'});
  provider.verify=async()=>{remoteCalls++;throw Object.assign(new Error('offline'),{code:'channel-disconnected'});};
  assert.deepEqual(await provider.file(p,'list',{session_id:'s',path:''}),{provider:'local-managed'});
  const before=localCalls;
  for(const [kind,providerName,state] of [['coder','coder-helper','unverified'],['coder','local-managed','unverified'],['local','unavailable','unverified'],['local','local-metadata','metadata-only']]) {
    context={...context,environment:{kind,provider:providerName,connection_state:state},spec:{kind,provider:providerName}};
    await assert.rejects(provider.file(p,'list',{session_id:'s',path:''}));
  }
  stale=true;await assert.rejects(provider.file(p,'list',{session_id:'s',path:''}),{code:'stale-binding'});
  assert.equal(localCalls,before);assert.equal(remoteCalls,1);store.close();
});

test('local bounded buffer reports loss and environment is an explicit whitelist',async()=>{
  const local=new LocalProvider({store:{}}),realm={home:'/owned/home',tmp:'/owned/tmp'};
  assert.deepEqual(local.environment(realm,{TERM:'xterm-256color'}),{PATH:'/usr/bin:/bin',HOME:realm.home,LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TMPDIR:realm.tmp,TERM:'xterm-256color'});
  for(const key of ['HOME','PATH','BASH_ENV','NODE_OPTIONS','HTTP_PROXY','TOKEN','Unlisted']) assert.throws(()=>local.environment(realm,{[key]:'value'}),{code:'local-env-denied'});
  const task={seq:0,bytes:0,chunks:[],session_id:'s',binding_id:'b',version:1,exited:true};local.append(task,'stdout',Buffer.alloc(1100000,65));
  assert.ok(task.bytes<=1048576);assert.ok(task.chunks[0].seq>1);
  const row={operation_id:'test',execution_kind:'local',local_runtime_id:local.runtimeId,state:'completed'};local.tasks.set('test',task);
  const page=await local.task({session:{session_id:'s'},binding:{binding_id:'b',version:1}},'read',{after_seq:'0'},row);
  assert.equal(page.truncated,true);assert.ok(page.chunks.reduce((n,c)=>n+Buffer.from(c.data,'base64').length,0)<=65536);
  await assert.rejects(local.task({session:{session_id:'different'},binding:{binding_id:'b',version:1}},'read',{},row),{code:'task-not-owned'});
  await assert.rejects(local.task({session:{session_id:'s'},binding:{binding_id:'b',version:1}},'read',{}, {...row,state:'unknown'}),{code:'task-runtime-lost'});
});

test('local shutdown serializes with an already queued native cancel and release is monotonic',async()=>{
  const {store,p,binding}=setup();store.db.prepare("UPDATE project_bindings SET state='ready' WHERE binding_id=?").run(binding.binding_id);
  const session=store.newSession(p,binding,'Cleanup race'),local=new LocalProvider({store});
  let row=store.beginOperation(p,session,'pty.open',{operation_id:'local-shutdown-race'});
  row=store.updateOperation(p,row.operation_id,{execution_kind:'local',local_runtime_id:local.runtimeId,local_process_id:'p',local_pid:123,local_start_ticks:'456',state:'running'});
  const task={operationId:row.operation_id,principal:p,session_id:session.session_id,binding_id:binding.binding_id,version:binding.version,exited:false};local.tasks.set(row.operation_id,task);
  const stopped=Promise.withResolvers(),entered=Promise.withResolvers();
  local.stop=async()=>{entered.resolve();await stopped.promise;task.exited=true;task.finished=true;};
  const context={session,binding};
  const cancel=local.task(context,'cancel',{operation_id:row.operation_id,action_id:'cancel-race-first'},row);await entered.promise;
  const disposing=local.dispose();stopped.resolve();await Promise.all([cancel,disposing]);
  assert.equal(store.operation(p,row.operation_id).state,'released');assert.equal(local.tasks.size,0);assert.equal(local.closed,true);store.close();
});

test('global fence stays closed; exact local capability is one-shot and expires across asynchronous continuations',()=>{
  const root=mkdtempSync(join(tmpdir(),'agent-studio-test-fence-')),target=join(root,'projects/d04-local-v1');mkdirSync(target,{recursive:true,mode:0o700});
  const script=`import assert from 'node:assert/strict';import cp from 'node:child_process';import net from 'node:net';
    const env={PATH:'/usr/bin:/bin',HOME:process.env.AGENT_STUDIO_ROOT+'/local/d04-local-v1/home',LANG:'C.UTF-8'};
    const spec={root:${JSON.stringify(target)},cwd:${JSON.stringify(target)},binding_id:'binding-12345678-1234-1234-1234-123456789abc',version:1,argv:['/usr/bin/true'],env};
    const options={cwd:spec.cwd,env,detached:true,stdio:['pipe','pipe','pipe']};
    const denied=fn=>assert.throws(fn,{code:'PREVIEW_UNAVAILABLE'});
    denied(()=>cp.spawn('/usr/bin/true',[],options));denied(()=>cp.spawnSync('/usr/bin/true'));
    denied(()=>fetch('https://example.invalid/'));denied(()=>new net.Socket().connect({host:'192.0.2.1',port:9}));
    const gate=Promise.withResolvers();let late;
    await globalThis[Symbol.for('agent-studio.local-run')](spec,async()=>{
      denied(()=>cp.spawn('/usr/bin/false',[],options));
      denied(()=>cp.spawn('/usr/bin/true',[],{...options,env:{...env,UNLISTED:'x'}}));
      const child=cp.spawn('/usr/bin/true',[],options);child.stdout.resume();child.stderr.resume();
      denied(()=>cp.spawn('/usr/bin/true',[],options));
      await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>{assert.equal(code,0);resolve();});});
      late=gate.promise.then(()=>denied(()=>cp.spawn('/usr/bin/true',[],options)));
    });gate.resolve();await late;
    console.log(JSON.stringify(globalThis[Symbol.for('agent-studio.fence')]));`;
  const result=spawnSync(process.execPath,['--import',new URL('./fence.mjs',import.meta.url).pathname,'--input-type=module','-e',script],{cwd:root,env:{PATH:'/usr/bin:/bin',HOME:root,AGENT_STUDIO_ROOT:root},encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);const counters=JSON.parse(result.stdout);assert.equal(counters.networkBlocked,2);assert.equal(counters.subprocessBlocked,6);
});

function modelSetup() {
  const data=setup(),{store,p,binding}=data;
  store.db.prepare("UPDATE project_bindings SET state='ready' WHERE binding_id=?").run(binding.binding_id);
  const session=store.newSession(p,binding,'Model control unit'),state=new ModelState(store,'unit-run'),stamp=new Date().toISOString();
  store.db.prepare('INSERT INTO model_configurations VALUES(?,?,?,?,?,?,?)').run(1,p,1,'{}',sha('{}'),'active',stamp);
  store.db.prepare('INSERT INTO model_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('unit-request',p,session.session_id,binding.binding_id,binding.version,1,'studio-model-unit','unit',sha('prompt'),'unit-run','running',1,null,stamp,stamp);
  store.db.prepare('INSERT INTO model_tool_calls VALUES(?,?,?,?,?,?,?,?)').run('unit-call',session.session_id,'unit-request','write',sha('args'),'running',stamp,stamp);
  const request=state.request(p,'unit-request');
  const open=(kind='approval',deadline=Date.now()+10000)=>state.openControl({eventId:'event-'+Math.random(),session,binding,request,callId:'unit-call',kind,payload:kind==='approval'?{toolName:'write'}:{questions:[{id:'q',options:[{label:'A'},{label:'B'}],multiSelect:false}]},deadline});
  const scope=control=>({control_id:control.control_id,session_id:session.session_id,binding_id:binding.binding_id,version:binding.version});
  return {...data,session,state,request,open,scope};
}

test('D05 controls: owner/session/version, hard deadline, one-shot SQL state and restart invalidation',()=>{
  const {root,store,p,session,binding,state,open,scope}=modelSetup(),control=open();
  const ro=new DatabaseSync(store.path,{readOnly:true});
  assert.deepEqual({...ro.prepare('SELECT * FROM model_controls WHERE control_id=?').get(control.control_id)},{...control});
  assert.deepEqual(state.controls(p,session.session_id).map(c=>c.control_id),[control.control_id]);
  assert.throws(()=>state.decide('foreign',scope(control),'allowed-once'),{code:'control-not-found'});
  for(const change of [{session_id:'foreign'},{binding_id:'foreign'},{version:binding.version+1}]) assert.throws(()=>state.decide(p,{...scope(control),...change},'allowed-once'),{code:'control-binding-mismatch'});
  assert.throws(()=>state.decide(p,scope(control),'allowed-always'),{code:'invalid-approval-answer'});
  state.decide(p,scope(control),'allowed-once');state.delivered(control.control_id,'delivered');
  assert.equal(ro.prepare('SELECT state FROM model_controls WHERE control_id=?').get(control.control_id).state,'answered');
  assert.throws(()=>state.decide(p,scope(control),'allowed-once'),{code:'control-not-pending'});
  assert.throws(()=>store.db.prepare("UPDATE model_controls SET state='pending' WHERE control_id=?").run(control.control_id),/already settled/);
  assert.throws(()=>store.db.prepare('UPDATE model_controls SET deadline_ms=? WHERE control_id=?').run(Date.now()+99999,control.control_id),/immutable/);
  const expired=open('approval',Date.now()-1);assert.throws(()=>state.decide(p,scope(expired),'allowed-once'),{code:'control-expired'});
  const pending=open(),kept=state.control(p,control.control_id);ro.close();store.close();
  const restarted=new Store(root),newState=new ModelState(restarted,'new-run');newState.restart();
  assert.deepEqual(newState.control(p,control.control_id),kept);
  assert.equal(newState.control(p,pending.control_id).state,'cancelled');
  assert.equal(newState.request(p,'unit-request').state,'interrupted');
  assert.throws(()=>newState.decide(p,scope(pending),'allowed-once'),{code:'control-not-pending'});restarted.close();
});

test('D07 environment loss cancels old model decisions, interrupts native work, and does not invalidate a same-generation binding',()=>{
  const {store,p,session,binding,state,open,scope}=modelSetup(),control=open(),controller=new AbortController(),cancelled=[];
  const models=Object.create(ModelSessions.prototype),timer=setTimeout(()=>{throw new Error('timer must be cleared');},60000);timer.unref();
  Object.assign(models,{store,state,active:new Map([[session.session_id,{request_id:'unit-request'}]]),controlTimers:new Map([[control.control_id,{session_id:session.session_id,controller,timer}]]),ctx:{agents:{get:()=>({cancel:(cause,options)=>cancelled.push({cause,options})})}}});
  models.bindingUnavailable(binding,'environment-suspended');assert.ok(controller.signal.aborted);assert.equal(state.control(p,control.control_id).state,'cancelled');assert.equal(state.request(p,'unit-request').state,'interrupted');assert.deepEqual(cancelled,[{cause:{kind:'hook',reason:'environment-suspended'},options:{keepInbox:false}}]);assert.equal(store.binding(p,binding.binding_id,binding.version).state,'ready');
  assert.throws(()=>state.decide(p,scope(control),'allowed-once'),{code:'control-not-pending'});store.close();
});

test('D05 question validation and operation lineage refuse unowned or inactive calls before storage',()=>{
  const {store,p,session,state,open,scope}=modelSetup(),question=open('question');
  for(const answers of [[{id:'wrong',selected:['A']}],[{id:'q',selected:['foreign']}],[{id:'q',selected:['A','B']}],[{id:'q',selected:['A','A']}],[]]) assert.throws(()=>state.decide(p,scope(question),{answers}),{code:'invalid-question-answer'});
  state.decide(p,scope(question),{answers:[{id:'q',selected:['B']}]});
  assert.deepEqual(JSON.parse(state.control(p,question.control_id).answer_json),{answers:[{id:'q',selected:['B']}]});
  const attempt=(context,id)=>modelCallContext.run(context,()=>store.beginOperation(p,session,'fs.write',{operation_id:id}));
  assert.throws(()=>attempt({principal:p,session_id:'foreign',call_id:'unit-call'},'denied-owner'),{code:'tool-operation-owner-mismatch'});
  assert.throws(()=>attempt({principal:p,session_id:session.session_id,call_id:'missing'},'denied-call'),{code:'tool-operation-context-inactive'});
  assert.equal(store.db.prepare('SELECT count(*) n FROM operation_records').get().n,0);
  attempt({principal:p,session_id:session.session_id,call_id:'unit-call'},'owned-call');
  assert.equal(store.db.prepare('SELECT operation_id FROM model_tool_operations WHERE call_id=?').get('unit-call').operation_id,'owned-call');store.close();
});

test('D05 original custom-model defaults become explicit text-only config; dangerous routes and branches fail closed',()=>{
  const models=Object.create(ModelSessions.prototype),config={providers:{'studio-model-unit':{api:'openai-completions',apiKeyEnv:'STUDIO_MODEL_UNIT_API_KEY',baseURL:'https://synthetic.example.invalid/v1',models:[{id:'unit'}]}}};
  const valid=models.validateConfig(config);assert.deepEqual(valid.providers['studio-model-unit'].models[0],{id:'unit',input:['text'],reasoningEfforts:false});
  assert.equal(config.providers['studio-model-unit'].models[0].input,undefined);
  for(const patch of [{apiKeyEnv:'OPENAI_API_KEY'},{baseURL:'https://user:secret@synthetic.example.invalid/v1'},{baseURL:'https://synthetic.example.invalid/v1?secret=value'},{headers:{Authorization:'synthetic'}}]) assert.throws(()=>models.validateConfig({providers:{'studio-model-unit':{...config.providers['studio-model-unit'],...patch}}}));
  assert.throws(()=>models.validateConfig({providers:{'studio-model-unit':{...config.providers['studio-model-unit'],models:[{id:'unit',input:['image']}]}}}),{code:'model-modality-not-enabled'});
  for(const part of [{type:'file',receiptId:'synthetic'},{type:'image',data:'x'},{type:'unknown',text:'x'}]) assert.throws(()=>models.content([part],{}));
});

test('D07 cold native Send reinstalls only the persisted authorized model selection before admission; mismatch and replay reject',async()=>{
  const {store,p,session,binding,state}=modelSetup(),models=Object.create(ModelSessions.prototype),order=[];
  state.transition('unit-request','completed');store.db.prepare('INSERT INTO model_selections VALUES(?,?,?,?,?,?)').run(session.session_id,p,'studio-model-unit','unit',1,new Date().toISOString());
  let mismatch=true,sends=0,credential=true,revoked=false;
  Object.assign(models,{store,state,active:new Map(),runId:'unit-run',authorize:async principal=>{if(principal!==p) throw Object.assign(new Error('foreign'),{code:'not-found'});return {session,binding};},route:(provider,model,revision)=>{assert.equal(provider,'studio-model-unit');assert.ok(['unit','unit-new'].includes(model));assert.equal(revision,1);if(revoked) throw Object.assign(new Error('revoked'),{code:'model-revision-changed'});return {apiKeyEnv:'STUDIO_MODEL_UNIT_API_KEY'};},studio:{ensureAgent:async()=>{order.push('ensure');}},ctx:{credentials:{resolve:async()=>credential?{value:'synthetic-unit-only'}:undefined},sessionController:{selectModel:async input=>{assert.equal(input.sessionId,session.session_id);assert.equal(input.provider,'studio-model-unit');order.push('select');return {selected:{provider:'studio-model-unit',model:mismatch?'other':input.model}};}},sessions:{get:()=>session,flush:async()=>{order.push('flush');}}}});
  const input={sessionId:session.session_id,requestId:'cold-request',mode:'queue',content:[{type:'text',text:'synthetic new authenticated send'}]},signal=new AbortController().signal,native=async()=>{sends++;order.push('send');return {accepted:true};};
  await assert.rejects(models.prompt(p,input,signal,native),{code:'model-request-mismatch'});assert.equal(sends,0);assert.equal(store.db.prepare('SELECT count(*) n FROM model_requests WHERE request_id=?').get(input.requestId).n,0);
  mismatch=false;credential=false;await assert.rejects(models.prompt(p,input,signal,native),{code:'model-credential-unconfigured'});credential=true;revoked=true;await assert.rejects(models.prompt(p,input,signal,native),{code:'model-revision-changed'});revoked=false;
  await assert.rejects(models.prompt('foreign',input,signal,native),{code:'not-found'});const aborted=new AbortController();aborted.abort();await assert.rejects(models.prompt(p,input,aborted.signal,native));assert.equal(sends,0);
  order.length=0;assert.deepEqual(await models.prompt(p,input,signal,native),{accepted:true});assert.deepEqual(order,['ensure','select','send','flush']);assert.equal(state.request(p,input.requestId).state,'queued');
  const ro=new DatabaseSync(store.path,{readOnly:true});assert.deepEqual({...ro.prepare('SELECT * FROM model_requests WHERE request_id=?').get(input.requestId)},{...state.request(p,input.requestId)});assert.ok(state.requests(p,session.session_id).some(row=>row.request_id===input.requestId));ro.close();
  await assert.rejects(models.prompt(p,input,signal,native),{code:'prompt-replay-disabled'});assert.equal(sends,1);state.transition(input.requestId,'completed');
  const selection=models.select(p,{sessionId:session.session_id,provider:'studio-model-unit',model:'unit-new'},async()=>({selected:{provider:'studio-model-unit',model:'unit-new'}}));
  const send=models.prompt(p,{...input,requestId:'after-new-selection'},signal,native);await selection;await send;assert.equal(state.request(p,'after-new-selection').model,'unit-new');assert.equal(sends,2);store.close();
});

test('D05 native cancel validates ownership without requiring a live execution provider',async()=>{
  const {store,p,binding}=setup('d05-model-local-v1');store.db.prepare("UPDATE project_bindings SET state='ready' WHERE binding_id=?").run(binding.binding_id);
  const session=store.newSession(p,binding,'Disconnected cancel'),studio=new Bindings({},store,'/unused',[]),models=Object.create(ModelSessions.prototype);
  Object.assign(models,{store,studio,controlTimers:new Map()});let stops=0;
  await models.cancel(p,{sessionId:session.session_id},()=>{stops++;});assert.equal(stops,1);
  await assert.rejects(models.cancel('foreign',{sessionId:session.session_id},()=>{stops++;}),{code:'not-found'});assert.equal(stops,1);store.close();
});

test('D05 corrupt private vault diagnostics never quote stored synthetic bytes',async()=>{
  const root=mkdtempSync(join(tmpdir(),'agent-studio-test-credentials-')),file=join(root,'model-credentials.json'),provider=Object.create(StudioCredentials.prototype);provider.file=file;
  writeFileSync(file,'{"version":1,"references":{"STUDIO_MODEL_X":"SYNTHETIC_DO_NOT_QUOTE", BROKEN}',{mode:0o600});
  await assert.rejects(provider.load(),error=>error.code==='credential-vault-unavailable' && !error.message.includes('SYNTHETIC_DO_NOT_QUOTE'));
});

test('D05 network capability: real exact POST only, no redirect, unrelated connection or async escape',()=>{
  const script=`import assert from 'node:assert/strict';import http from 'node:http';import net from 'node:net';import cp from 'node:child_process';
    let hits=0,redirect=false;const server=http.createServer((req,res)=>{hits++;if(redirect){res.writeHead(302,{location:'/unrelated'});res.end();}else{res.end('synthetic-capability-ok');}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const url='http://127.0.0.1:'+server.address().port+'/v1/chat/completions';
    const cap=globalThis[Symbol.for('agent-studio.model-request')],signal=new AbortController().signal,spec={url,session_id:'unit',request_id:'unit',revision:1,signal};
    const denied=fn=>assert.throws(fn,{code:'PREVIEW_UNAVAILABLE'});
    denied(()=>fetch(url,{method:'POST'}));
    await cap(spec,async()=>{denied(()=>fetch(url));denied(()=>fetch(url+'/other',{method:'POST'}));denied(()=>new net.Socket().connect({host:'127.0.0.1',port:server.address().port}));denied(()=>cp.spawn('/usr/bin/true'));assert.equal(await (await fetch(url,{method:'POST'})).text(),'synthetic-capability-ok');});
    const gate=Promise.withResolvers();let late;await cap(spec,()=>{late=gate.promise.then(()=>denied(()=>fetch(url,{method:'POST'})));});gate.resolve();await late;
    redirect=true;await assert.rejects(cap(spec,()=>fetch(url,{method:'POST'})));assert.equal(hits,2);
    await new Promise(resolve=>server.close(resolve));console.log(JSON.stringify({hits,...globalThis[Symbol.for('agent-studio.fence')]}));`;
  const result=spawnSync(process.execPath,['--import',new URL('./fence.mjs',import.meta.url).pathname,'--input-type=module','-e',script],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);const facts=JSON.parse(result.stdout);assert.equal(facts.hits,2);assert.equal(facts.networkBlocked,5);assert.equal(facts.subprocessBlocked,1);
});

test('D07 channel loss cancels old ACP decisions without claiming peer cancellation or task recovery',()=>{
 const {store,p,session,binding,state,task,open,scope}=acpSetup(),control=open(),controller=new AbortController(),entryController=new AbortController(),acp=Object.create(AcpSessions.prototype);
 const active={task,controller,controls:[{row:control,controller:entryController}]};Object.assign(acp,{store,state,active:new Map([[session.session_id,active]])});
 acp.channelLost(binding,Object.assign(new Error('OFFLINE disconnect'),{code:'environment-suspended'}));assert.ok(controller.signal.aborted&&entryController.signal.aborted);assert.equal(state.control(p,control.control_id).state,'cancelled');assert.throws(()=>state.decide(p,scope(control),'allowed-once'),{code:'control-not-pending'});assert.equal(state.task(p,task.task_id).state,'running');assert.equal(active.cancelRequested,undefined);store.close();
});

const acpPermission={sessionId:'peer-session',toolCall:{toolCallId:'peer-tool',title:'Synthetic write'},options:[{optionId:'one',name:'Allow one synthetic write',kind:'allow_once'},{optionId:'no',name:'Reject this synthetic write',kind:'reject_once'},{optionId:'forever',name:'Never advertised by the bridge',kind:'allow_always'}]};
function acpSetup() {
  const data=setup('d06-acp-local-v1'),{store,p,binding}=data;
  store.db.prepare("UPDATE project_bindings SET state='ready' WHERE binding_id=?").run(binding.binding_id);
  const session=store.newSession(p,binding,'ACP unit'),state=new AcpState(store,'acp-unit-run');
  let task=state.create(session,binding,{id:'offline-peer',version:'1',protocol:'acp-v1'},{request_id:'acp-request',prompt:'offline unit'},Date.now()+60000);
  const context={principal:p,session_id:session.session_id,task_id:task.task_id,run_id:task.run_id,cli_instance_id:task.cli_instance_id};
  acpOperationContext.run(context,()=>store.beginOperation(p,session,'command.exec',{operation_id:'acp-unit-operation'}));
  task=state.update(p,task.task_id,{state:'running',operation_id:'acp-unit-operation',cli_session_id:'peer-session',identity_json:'{"synthetic":true}'});
  const open=(deadline=Date.now()+10000,extra={})=>state.openControl({eventId:'acp-event-'+Math.random(),session,binding,request:task,callId:'peer-tool-'+Math.random(),kind:'approval',payload:{acp_request:acpPermission},deadline,extra:{cli_session_id:task.cli_session_id,cli_instance_id:task.cli_instance_id,rpc_request_id:JSON.stringify('rpc-'+Math.random()),...extra}});
  const scope=c=>({control_id:c.control_id,session_id:session.session_id,binding_id:binding.binding_id,version:binding.version});
  return {...data,session,state,task,context,open,scope};
}

test('D06 reuses controls without fake model turns: real FK scope, single response, SQL readback/list and restart',()=>{
  const {root,store,p,session,state,task,open,scope}=acpSetup(),control=open();
  const ro=new DatabaseSync(store.path,{readOnly:true});assert.equal(ro.prepare('SELECT count(*) n FROM model_requests').get().n,0);
  assert.deepEqual({...ro.prepare('SELECT * FROM acp_controls WHERE control_id=?').get(control.control_id)},{...control});
  assert.equal(state.controls(p,session.session_id)[0].control_id,control.control_id);
  assert.throws(()=>state.decide('foreign',scope(control),'allowed-once'),{code:'control-not-found'});
  assert.throws(()=>state.decide(p,{...scope(control),version:2},'allowed-once'),{code:'control-binding-mismatch'});
  assert.throws(()=>state.decide(p,scope(control),'allowed-always'),{code:'invalid-approval-answer'});
  const decided=state.decide(p,scope(control),'allowed-once');assert.deepEqual(JSON.parse(decided.response_json),{outcome:{outcome:'selected',optionId:'one'}});
  state.delivered(control.control_id,'stdio-written-unconfirmed');assert.equal(ro.prepare('SELECT delivery FROM acp_controls WHERE control_id=?').get(control.control_id).delivery,'stdio-written-unconfirmed');
  assert.throws(()=>state.decide(p,scope(control),'rejected'),{code:'control-not-pending'});
  assert.throws(()=>store.db.prepare("UPDATE acp_controls SET response_json='{}' WHERE control_id=?").run(control.control_id),/immutable/);
  assert.throws(()=>store.db.prepare("UPDATE acp_controls SET state='pending' WHERE control_id=?").run(control.control_id),/already settled/);
  const wrong=open(undefined,{cli_session_id:'another-peer'});assert.throws(()=>state.decide(p,scope(wrong),'allowed-once'),{code:'control-instance-mismatch'});
  const expired=open(Date.now()-1);assert.throws(()=>state.decide(p,scope(expired),'allowed-once'),{code:'control-expired'});
  const pending=open(),kept={...state.control(p,control.control_id)};ro.close();store.close();
  const reopened=new Store(root),next=new AcpState(reopened,'new-run');next.restart();
  assert.deepEqual({...next.control(p,control.control_id)},kept);assert.equal(next.task(p,task.task_id).state,'interrupted');
  assert.equal(next.control(p,pending.control_id).state,'cancelled');assert.throws(()=>next.decide(p,scope(pending),'allowed-once'),{code:'control-not-pending'});reopened.close();
});

test('D06 operation lineage, immutable instance and bounded stream reject before insertion',()=>{
  const {store,p,session,state,task,context}=acpSetup();
  const attempt=(ctx,id)=>acpOperationContext.run(ctx,()=>store.beginOperation(p,session,'task.input',{operation_id:id}));
  assert.throws(()=>attempt({...context,session_id:'foreign'},'bad-acp-owner'),{code:'acp-operation-owner-mismatch'});
  assert.throws(()=>attempt({...context,cli_instance_id:'foreign'},'bad-acp-instance'),{code:'acp-operation-context-inactive'});
  assert.equal(store.db.prepare('SELECT count(*) n FROM operation_records').get().n,1);
  attempt(context,'good-acp-input');assert.equal(store.db.prepare('SELECT count(*) n FROM acp_task_operations WHERE task_id=?').get(task.task_id).n,2);
  assert.throws(()=>state.update(p,task.task_id,{cli_session_id:'foreign'}),/immutable/);
  assert.throws(()=>state.append(p,task.task_id,'update',{text:'x'.repeat(65536)}),{code:'acp-output-limit'});
  const event=state.append(p,task.task_id,'update',{text:'OFFLINE ACP UNIT'});assert.deepEqual({...state.events(p,task.task_id)[0]},event);
  assert.throws(()=>store.db.prepare("UPDATE acp_events SET payload_json='{}' WHERE task_id=?").run(task.task_id),/immutable/);
  state.update(p,task.task_id,{state:'unknown'});assert.throws(()=>attempt(context,'late-acp-write'),{code:'acp-operation-context-inactive'});store.close();
});

test('D06 ACP form answers retain wire types, constraints and actual once-only option IDs',()=>{
  assert.equal(permissionProjection(acpPermission).allow.optionId,'one');
  assert.deepEqual(controlResponse({kind:'approval',payload_json:JSON.stringify({acp_request:acpPermission})},'rejected'),{outcome:{outcome:'selected',optionId:'no'}});
  assert.throws(()=>permissionProjection({...acpPermission,options:acpPermission.options.filter(o=>o.kind!=='allow_once')}),{code:'acp-permission-once-options-unsupported'});
  const request={mode:'form',sessionId:'peer-session',message:'Synthetic form',requestedSchema:{type:'object',required:['color','count','ready','tag'],properties:{color:{type:'string',enum:['red','blue']},count:{type:'integer',minimum:1,maximum:5},ready:{type:'boolean'},tag:{type:'string',minLength:2,maxLength:8},labels:{type:'array',items:{type:'string',enum:['a','b']},maxItems:1}}}};
  const projection=formProjection(request);assert.equal(projection.questions.length,5);
  const answers={answers:[{id:'color',selected:['blue']},{id:'count',selected:[],custom:'3'},{id:'ready',selected:['False']},{id:'tag',selected:[],custom:'unit'},{id:'labels',selected:['a']}]};
  assert.deepEqual(JSON.parse(JSON.stringify(formContent({acp_request:request},answers))),{color:'blue',count:3,ready:false,tag:'unit',labels:['a']});
  const badCount=structuredClone(answers);badCount.answers[1].custom='9';assert.throws(()=>formContent({acp_request:request},badCount),{code:'acp-form-number-invalid'});
  const badEnum=structuredClone(answers);badEnum.answers[0].custom='hidden';assert.throws(()=>formContent({acp_request:request},badEnum),{code:'acp-form-custom-enum-denied'});
  assert.throws(()=>formProjection({...request,mode:'url'}),{code:'acp-elicitation-mode-unsupported'});
  const unsafe=structuredClone(request);unsafe.requestedSchema.properties.tag.pattern='(a+)+$';assert.throws(()=>formProjection(unsafe),{code:'acp-form-constraint-unsupported'});
  const duplicate=structuredClone(request);duplicate.requestedSchema.properties.color.enum=['','(empty string)'];assert.throws(()=>formProjection(duplicate),{code:'acp-form-duplicate-label'});
  const optional=structuredClone(answers);optional.answers[4].selected=[];
  const omitted=formContent({acp_request:request},optional);assert.equal(Object.hasOwn(omitted,'labels'),false);
});

test('D06 backend registration requires dedicated refs and fixed executable/hash/policy; JSON cannot mint a launch ticket',()=>{
  const row={id:'unit-peer',name:'Offline unit',version:'1',protocol:'acp',kinds:['local'],policies:['d06-acp-local-v1'],executable:'/usr/bin/python3.12',executable_sha256:'a'.repeat(64),argv:['-I','{root}/peer.py'],credential_refs:{ACP_TEST_KEY:'STUDIO_ACP_UNIT'},environment:{},offline_fixture:true,bootstrap:{executable:'/usr/bin/python3.12',sha256:'a'.repeat(64)},assets:[{name:'peer.py',sha256:'b'.repeat(64)}]};
  assert.equal(validateBackend(row),row);
  assert.throws(()=>validateBackend({...row,credential_refs:{ACP_TEST_KEY:'STUDIO_MODEL_UNIT'}}),{code:'acp-dedicated-credential-required'});
  assert.throws(()=>validateBackend({...row,credential_refs:{CODER_SESSION_TOKEN:'STUDIO_ACP_UNIT'}}),{code:'acp-dedicated-credential-required'});
  assert.throws(()=>validateBackend({...row,environment:{LD_PRELOAD:'own.so'}}),{code:'acp-backend-env-invalid'});
  assert.throws(()=>validateBackend({...row,environment:{OPENAI_API_KEY:'synthetic-secret'}}),{code:'acp-backend-env-invalid'});
  assert.throws(()=>validateBackend({...row,policies:['d05-model-local-v1']}),{code:'acp-backend-policy-invalid'});
  assert.throws(()=>validateBackend({...row,executable:'python3'}),{code:'acp-backend-executable-invalid'});
  assert.throws(()=>validateBackend({...row,assets:[{name:'../secret',sha256:'b'.repeat(64)}]}),{code:'acp-backend-asset-invalid'});
  assert.equal(consumeAcpLaunch(JSON.parse(JSON.stringify({credential_names:['ACP_TEST_KEY'],secrets:{ACP_TEST_KEY:'synthetic'},task_id:'made-up'})),{}),undefined);
});

test('D06 actual mutation gate rechecks response id/instance/deadline and signal, allowing only cancellation cleanup',()=>{
  const {store,p,session,state,task,context,open,scope}=acpSetup(),control=open();state.decide(p,scope(control),'allowed-once');
  const decided=state.control(p,control.control_id),frame={jsonrpc:'2.0',id:JSON.parse(control.rpc_request_id),result:JSON.parse(decided.response_json)};
  const input=(ctx,id,data)=>acpOperationContext.run(ctx,()=>store.beginOperation(p,session,'task.input',{operation_id:id,data:JSON.stringify(data)+'\n'}));
  const owner={...context,control_id:control.control_id};
  assert.throws(()=>input(owner,'wrong-response-id',{...frame,id:'another-rpc'}),{code:'acp-response-mismatch'});
  const aborted=new AbortController();aborted.abort();assert.throws(()=>input({...owner,signal:aborted.signal},'aborted-response',frame),{code:'acp-task-deadline'});
  input(owner,'accepted-response',frame);state.delivered(control.control_id,'stdio-written-unconfirmed');
  assert.throws(()=>input(owner,'duplicate-response',frame),{code:'acp-response-mismatch'});
  state.update(p,task.task_id,{state:'stopping'});
  assert.throws(()=>input(context,'late-prompt-frame',{method:'session/prompt'}),{code:'acp-task-deadline'});
  input({...context,signal:aborted.signal},'cancel-notification',{method:'session/cancel',params:{sessionId:'peer-session'}});
  assert.equal(store.db.prepare('SELECT count(*) n FROM acp_task_operations').get().n,3);store.close();
});

test('D06 repeated ACP request is rejected before reaching the shared native event source',async()=>{
  const {store,state,task,open}=acpSetup(),row=open(),records=[];
  const receiver={store,state,runningSession:()=>task,record:(_active,kind,payload)=>records.push({kind,payload})};
  const active={task,controls:new Set()};
  await assert.rejects(AcpSessions.prototype.control.call(receiver,active,'approval',{params:{...acpPermission,toolCall:{...acpPermission.toolCall,toolCallId:row.call_id}},requestId:JSON.parse(row.rpc_request_id),signal:new AbortController().signal}),error=>error.code===-32602 && error.data.code==='acp-control-duplicate');
  assert.equal(records[0].payload.code,'acp-control-duplicate');assert.equal(state.controls(task.principal_id,task.session_id).length,1);store.close();
});
