#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rename, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { zstdDecompressSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { start, stop, authenticate, requestRpc, repo } from './preview.mjs';
import { Store } from '../../packages/dsh-agent-studio/store.mjs';
const require = createRequire('/home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh/package.json');
const WebSocket = require('ws');
const root = await mkdtemp('/tmp/agent-studio-test-integration-');
const out = join(repo,'artifacts/d02',`local-regression-${randomUUID()}`); await mkdir(out,{ recursive:true });
const report = { scope:'D01 self-test; not M1/M2 acceptance', root, checks:[], failures:[] };
let auth;
const pass = (name, facts = {}) => { report.checks.push({ name,...facts }); console.log(`PASS ${name}`); };
const rpc = (method,payload = {}) => requestRpc(auth,method,payload);
async function denied(method,payload,code,channel) {
  await assert.rejects(requestRpc(auth,method,payload,channel),error => error.code === `agent-studio/${code}`);
  pass(`${method} rejects ${code}`);
}
async function sqlCheck(table,key,row,method) {
  const db = new DatabaseSync(join(root,'bindings.sqlite'),{ readOnly:true });
  const raw = { ...db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(row[key]) }; db.close();
  assert.deepEqual(raw,row);
  assert.deepEqual(await rpc(method,{ [key]:row[key] }),row);
  const list = await rpc(`${method.split('.')[0]}.list`);
  assert.ok(list.some(item => item[key] === row[key]));
  pass(`${table}: write -> readonly SQL -> full RPC -> list`,{ row });
}
async function http(path,options={}) { return fetch(`${auth.origin}${path}`,options); }
function stream(endpoint,args) {
  return new Promise((resolve,reject) => {
    const ws = new WebSocket(`${auth.origin.replace('http','ws')}/api/remote.mux`,{ headers:{ cookie:auth.cookie,origin:auth.origin } });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error(`stream timeout: ${endpoint}`)); },5000);
    ws.once('error',error => { clearTimeout(timer); reject(error); });
    ws.once('open',() => ws.send(JSON.stringify({ type:'open',streamId:randomUUID(),endpoint,payload:{ args } })));
    ws.once('message',data => { clearTimeout(timer); const frame=JSON.parse(data.toString()); ws.close(); resolve(frame); });
  });
}
async function filesUnder(dir) {
  const files=[];
  for (const entry of await readdir(dir,{ withFileTypes:true })) {
    const path=join(dir,entry.name);
    if(entry.isDirectory()) files.push(...await filesUnder(path));
    else if(entry.isFile()) files.push(path);
  }
  return files;
}
try {
  process.env.AGENT_STUDIO_INHERIT_CANARY = 'synthetic-test-must-not-reach-child';
  const ready = await start(root,'127.0.0.1'); auth=await authenticate(root);
  delete process.env.AGENT_STUDIO_INHERIT_CANARY;
  pass('actual dsh startup and cookie exchange',{ origin:ready.origin });
  const childEnv = Object.fromEntries((await readFile(`/proc/${ready.pid}/environ`,'utf8')).split('\0').filter(Boolean).map(entry => {
    const split=entry.indexOf('='); return [entry.slice(0,split),entry.slice(split+1)];
  }));
  assert.deepEqual(Object.keys(childEnv).sort(),['PATH','HOME','DSH_HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','TMPDIR','TMP','TEMP','LANG','DSH_TELEMETRY_DISABLED','AGENT_STUDIO_ROOT','AGENT_STUDIO_RUN_ID','AGENT_STUDIO_REPO'].sort());
  assert.equal(childEnv.HOME,join(root,'home')); assert.equal(childEnv.DSH_HOME,join(root,'dsh'));
  pass('owned child uses exact environment allowlist; inherited canary absent');
  for(const [path,options,status] of [
    ['/agent-studio/health',{},200],['/',{},401],['/agent-studio-rpc/project.list',{method:'POST'},401],
    ['/agent-studio-rpc/project.list',{method:'POST',headers:{cookie:'invalid=credential'}},401],
    ['/agent-studio-rpc/project.list',{method:'POST',headers:{cookie:auth.cookie,origin:'https://untrusted.invalid'}},403],
    ['/agent-studio/health',{headers:{origin:'https://untrusted.invalid'}},403],
    ['/api/session/list',{method:'POST'},401],['/sidebar/api/settings.get',{method:'POST'},401],
  ]) { const response=await http(path,options); assert.equal(response.status,status); await response.arrayBuffer(); pass(`HTTP ${path} -> ${status}`); }
  const response=await http('/agent-studio-rpc/project.list',{method:'POST',headers:{cookie:auth.cookie,'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'mismatch',method:'project.get',payload:{}})});
  assert.equal(response.status,200); assert.equal((await response.json()).result.ok,false); pass('HTTP 200 envelope mismatch is RPC failure');
  const project=await rpc('project.create',{name:'D01 Integration 中文',source_kind:'registered'});
  const environment=await rpc('environment.register',{catalog_key:'local-preview'});
  await sqlCheck('projects','project_id',project,'project.get');
  await sqlCheck('environments','environment_id',environment,'environment.get');
  const remote=await rpc('environment.register',{catalog_key:'remote-unverified'});
  await sqlCheck('environments','environment_id',remote,'environment.get');
  await denied('environment.register',{catalog_key:'not-registered'},'unknown-environment');
  await denied('environment.register',{catalog_key:'local-preview',credential:'not-a-real-secret'},'unknown-field');
  await denied('project.create',{name:'forged',principal_id:'other'},'unknown-field');
  const binding=await rpc('binding.create',{project_id:project.project_id,environment_id:environment.environment_id});
  const ro=new DatabaseSync(join(root,'bindings.sqlite'),{readOnly:true});
  assert.deepEqual({...ro.prepare('SELECT * FROM project_bindings WHERE binding_id=? AND version=?').get(binding.binding_id,1)},binding);
  assert.deepEqual(await rpc('binding.get',{binding_id:binding.binding_id,version:1}),binding);
  assert.ok((await rpc('binding.list')).some(row=>row.binding_id===binding.binding_id));
  pass('versioned binding full SQL/RPC/list',{row:binding,instance_record:{...ro.prepare('SELECT * FROM instance_records WHERE record_id=?').get(binding.record_id)}});
  const session=await rpc('session.create',{binding_id:binding.binding_id,version:1,title:'D01 Integration Native'});
  assert.deepEqual({...ro.prepare('SELECT * FROM session_bindings WHERE session_id=?').get(session.session_id)},session);
  const native=await rpc('session.get',{session_id:session.session_id});
  assert.deepEqual(Object.fromEntries(Object.entries(native).filter(([key])=>key!=='native')),session);
  assert.ok((await rpc('session.list')).some(row=>row.session_id===session.session_id));
  assert.equal(native.native.inspection.meta.cwd,binding.anchor_path); assert.ok(native.native.snapshot.sizeBytes>0);
  assert.ok(native.native.inspection.events.some(e=>e.type==='session/title' && e.data.title==='D01 Integration Native'));
  const logFiles=await filesUnder(join(root,'dsh/sessions'));
  const log=logFiles.find(file=>file.includes(session.session_id) && /\.jsonl(?:\.zstd)?$/.test(file));
  assert.ok(log,'physical JSONL exists');
  const bytes=await readFile(log);
  const decoded=log.endsWith('.zstd') ? zstdDecompressSync(bytes) : bytes;
  const records=decoded.toString().trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(decoded.toString().includes(session.session_id)); assert.ok(records.length>1);
  pass('native factory + flush + Workspace association + inspect + physical JSONL',{row:session,jsonl:log,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  const good=await rpc('dispatch.check',{session_id:session.session_id,operation:'metadata.read',binding_id:binding.binding_id,version:1,cwd:'.'});
  assert.equal(good.eligible,true); assert.equal(good.executed,false); pass('explicit local metadata eligibility (not execution)',{decision:good});
  await denied('dispatch.check',{session_id:session.session_id,operation:'metadata.read',binding_id:'other'},'binding-mismatch');
  await denied('dispatch.check',{session_id:session.session_id,operation:'metadata.read',version:9},'version-mismatch');
  await denied('dispatch.check',{operation:'metadata.read'},'missing-field');
  await denied('dispatch.check',{session_id:'unknown',operation:'metadata.read'},'not-found');
  await denied('dispatch.check',{session_id:session.session_id,operation:'metadata.read',cwd:binding.anchor_path},'cwd-outside-binding');
  for(const operation of ['fs.read','fs.write','command.exec','pty.open']) await denied('dispatch.check',{session_id:session.session_id,operation},'provider-unavailable');
  await denied('binding.create',{project_id:project.project_id,environment_id:environment.environment_id,target_root:'/arbitrary'},'unknown-field');
  const remoteBinding=await rpc('binding.create',{project_id:project.project_id,environment_id:remote.environment_id});
  const remoteSession=await rpc('session.create',{binding_id:remoteBinding.binding_id,version:1,title:'Unverified remote history only'});
  await denied('dispatch.check',{session_id:remoteSession.session_id,operation:'metadata.read'},'remote-unverified');
  assert.deepEqual(await readdir(remoteBinding.anchor_path),[]); pass('remote empty anchor, never remote source mirror');

  const uiCreate = request => requestRpc(auth,'session/create',{args:{request}},'/api');
  const countBeforeUi=ro.prepare('SELECT count(*) n FROM session_bindings').get().n;
  assert.deepEqual(await uiCreate({workspaceId:binding.workspace_id,sessionId:session.session_id,agentPreset:'preview'}),{sessionId:session.session_id,agentPreset:'preview'});
  assert.equal(ro.prepare('SELECT count(*) n FROM session_bindings').get().n,countBeforeUi);
  assert.deepEqual(await readFile(log),bytes);
  pass('native UI reopens owned bound session without duplicating or changing its JSONL');
  const uiNew=await uiCreate({workspaceId:binding.workspace_id,agentPreset:'preview'});
  assert.notEqual(uiNew.sessionId,session.session_id);
  const uiRow={...ro.prepare('SELECT * FROM session_bindings WHERE session_id=?').get(uiNew.sessionId)};
  assert.equal(uiRow.state,'ready'); assert.equal(uiRow.binding_id,binding.binding_id); assert.equal(uiRow.version,1);
  const uiRead=await rpc('session.get',{session_id:uiNew.sessionId});
  assert.deepEqual(Object.fromEntries(Object.entries(uiRead).filter(([key])=>key!=='native')),uiRow);
  assert.ok((await rpc('session.list')).some(row=>row.session_id===uiNew.sessionId));
  assert.equal(uiRead.native.inspection.meta.cwd,binding.anchor_path); assert.ok(uiRead.native.snapshot.sizeBytes>0);
  assert.equal((await uiCreate({workspaceId:binding.workspace_id,sessionId:uiNew.sessionId})).sessionId,uiNew.sessionId);
  pass('native UI creates durable bound session: SQL -> full RPC -> list -> native/Workspace readback',{row:uiRow});
  for(const [request,code] of [
    [{workspaceId:'unknown-workspace'},'workspace-not-owned'],
    [{workspaceId:remoteBinding.workspace_id,sessionId:session.session_id},'binding-mismatch'],
    [{workspaceId:binding.workspace_id,sessionId:'unknown-session'},'not-found'],
    [{workspaceId:binding.workspace_id,agentPreset:'standard'},'disabled'],
  ]) await denied('session/create',{args:{request}},code,'/api');
  const ack={ns:'ui-settings-general',ops:[{op:'set',path:['welcomeNoticeVersion'],value:'2026-09-28.1'}]};
  await requestRpc(auth,'settings/mutate',{args:ack},'/api');
  const hasAcknowledgement = async () => require('yaml').parse(
    await readFile(join(root,'dsh/profiles/agent-studio-preview/cordis.patch.yml'),'utf8'),
    {customTags:[{tag:'tag:yaml.org,2002:js',resolve:value=>value}]}
  ).some(row=>row.id==='ui-settings-general' && row.config?.welcomeNoticeVersion==='2026-09-28.1');
  assert.ok(await hasAcknowledgement());
  pass('single welcome acknowledgement persists to private native profile');
  for(const ops of [
    [{op:'set',path:['welcomeNoticeVersion'],value:'unrecognized'}],
    [{op:'set',path:['anotherField'],value:'2026-09-28.1'}],
    [...ack.ops,{op:'set',path:['anotherField'],value:'unrecognized'}],
  ]) await denied('settings/mutate',{args:{ns:ack.ns,ops}},'disabled','/api');

  // Owner calls, not merely anonymous calls: valid parameters must reach the common guard before lookup.
  const stock=[
    ['session/create',{request:{}}],
    ['session/create',{request:{workspaceId:binding.workspace_id,cwd:binding.target_root}}],
    ['session/create',{request:{cwd:binding.target_root}}],
    ['session/prompt',{request:{requestId:randomUUID(),sessionId:session.session_id,mode:'queue',content:[{type:'text',text:'Must not run a model'}]}}],
    ['session/openWorkspacePath',{request:{path:binding.target_root}}],
    ['settings/update',{ns:'session-title-llm',patch:{targetWords:7}}],
    ['workspace/create',{request:{path:binding.target_root}}],
    ['workspaceFiles/read',{workspaceFileScopeId:'nonexistent-session',path:'no-file',range:{}}],
    ['terminal/create',{agentId:'nonexistent-session',request:{id:'preview-denied-terminal',cols:80,rows:24}}],
  ];
  for(const [method,args] of stock) await denied(method,{args},method==='session/prompt'?'generation-disabled':'disabled','/api');
  const streamDeny=await stream('workspaceFiles/changes',{workspaceFileScopeId:'nonexistent-session',path:'.'});
  assert.equal(streamDeny.type,'error'); assert.equal(streamDeny.error.code,'agent-studio/disabled'); pass('owner stream guard rejects before workspace lookup',{frame:streamDeny});
  const follow=await stream('session/follow',{request:{address:{kind:'session',sessionId:session.session_id}}});
  assert.equal(follow.type,'item',JSON.stringify(follow)); pass('native session follow stream remains readable');
  const listed=await requestRpc(auth,'session/list',{args:{_request:{}}},'/api');
  assert.ok(listed.items.some(row=>row.sessionId===session.session_id)); pass('native session list remains readable');
  for(const method of ['fs.read','fs.trees','git.status','git.commit','git.generateCommitMessage','open.external','sidechat.start','settings.update']) {
    const res=await http(`/sidebar/api/${method}`,{method:'POST',headers:{cookie:auth.cookie,'content-type':'application/json'},body:JSON.stringify({sessionId:session.session_id,path:binding.target_root})});
    assert.equal(res.status,409); assert.equal((await res.json()).ok,false); pass(`sidebar ${method} backend disabled`);
  }
  for(const path of ['/sidebar/upload','/sidebar/write','/sidebar/file','/sidebar/archive','/sidebar/html','/api/session/uploadFileBinary']) {
    const res=await http(path,{method:'POST',headers:{cookie:auth.cookie,'content-type':'application/octet-stream'},body:'synthetic bytes'});
    assert.equal(res.status,409); await res.arrayBuffer(); pass(`raw route ${path} disabled`);
  }
  const sideMeta=await http('/sidebar/api/session.cwd',{method:'POST',headers:{cookie:auth.cookie,'content-type':'application/json'},body:JSON.stringify({sessionId:session.session_id})});
  assert.equal((await sideMeta.json()).value.cwd,binding.target_root); pass('sidebar metadata uses public target root, not anchor');
  assert.deepEqual(await readFile(log),bytes); assert.deepEqual(await readdir(binding.target_root),[]);
  const status=await rpc('preview.status'); assert.equal(status.counters.networkBlocked,0); assert.equal(status.counters.subprocessBlocked,0); assert.equal(status.counters.generationBlocked,0);
  const models=await requestRpc(auth,'session/modelCatalog',{args:{}},'/api'); assert.deepEqual(models.routableProviders,[]);
  pass('denied operations: unchanged JSONL, empty project root, no model route/network/process attempt',{counters:status.counters});

  const second=await rpc('binding.create',{project_id:project.project_id,environment_id:environment.environment_id,binding_id:binding.binding_id,expected_version:1});
  assert.equal(second.version,2); assert.notEqual(second.anchor_path,binding.anchor_path);
  await denied('dispatch.check',{session_id:session.session_id,operation:'metadata.read'},'stale-binding');
  const secondSession=await rpc('session.create',{binding_id:second.binding_id,version:2,title:'Current version'});
  const invalid=await rpc('binding.create',{project_id:project.project_id,environment_id:environment.environment_id});
  const invalidSession=await rpc('session.create',{binding_id:invalid.binding_id,version:1,title:'Anchor invalidation test'});
  await rename(invalid.anchor_path,`${invalid.anchor_path}.retained`);
  await denied('dispatch.check',{session_id:invalidSession.session_id,operation:'metadata.read'},'anchor-invalid');
  assert.equal((await rpc('binding.get',{binding_id:invalid.binding_id,version:1})).state,'invalid');
  ro.close();
  const principal=status.principal_id;
  await stop(root);
  const store=new Store(root);
  // Deterministic crash-boundary simulations in this fresh test root only; no runtime fault-injection API.
  store.db.prepare("UPDATE session_bindings SET state='pending',ready_at=NULL WHERE session_id=?").run(secondSession.session_id);
  const recover=store.newSession(principal,second,'Pending before native creation');
  const expired=store.newSession(principal,second,'Expired pending');
  store.db.prepare("UPDATE session_bindings SET created_at='2000-01-01T00:00:00.000Z' WHERE session_id=?").run(expired.session_id);
  const pendingBinding=store.newBinding(principal,{project_id:project.project_id,environment_id:environment.environment_id},join(root,'anchors'));
  store.close();
  const restarted=await start(root,'127.0.0.1'); auth=await authenticate(root);
  assert.ok(await hasAcknowledgement());
  assert.equal((await rpc('session.get',{session_id:uiNew.sessionId})).session_id,uiNew.sessionId);
  pass('restart preserves native UI-created session and sole welcome acknowledgement');
  assert.equal((await rpc('preview.status')).principal_id,principal);
  assert.deepEqual(await rpc('project.get',{project_id:project.project_id}),project);
  assert.deepEqual(await rpc('environment.get',{environment_id:environment.environment_id}),environment);
  assert.equal((await rpc('session.get',{session_id:session.session_id})).version,1);
  for(const sid of [secondSession.session_id,recover.session_id]) assert.equal((await rpc('session.get',{session_id:sid})).state,'ready');
  assert.equal((await rpc('session.get',{session_id:expired.session_id})).state,'failed');
  await denied('dispatch.check',{session_id:expired.session_id,operation:'metadata.read'},'session-not-ready');
  assert.equal((await rpc('binding.get',{binding_id:pendingBinding.binding_id,version:1})).state,'ready');
  assert.equal((await rpc('binding.get',{binding_id:invalid.binding_id,version:1})).state,'invalid');
  await assert.rejects(lstat(invalid.anchor_path),{code:'ENOENT'});
  assert.equal((await rpc('dispatch.check',{session_id:secondSession.session_id,operation:'metadata.read'})).eligible,true);
  const after=new DatabaseSync(join(root,'bindings.sqlite'),{readOnly:true});
  assert.equal(after.prepare('SELECT principal_id FROM session_bindings WHERE session_id=?').get(recover.session_id).principal_id,principal);
  assert.equal(after.prepare('SELECT state FROM session_bindings WHERE session_id=?').get(expired.session_id).state,'failed');
  after.close();
  pass('restart: ready unchanged; pending with/without JSONL recovered; expired failed; invalid anchor not recreated',{reconciliation:restarted.reconciliation});
  for(const file of await filesUnder(root)) assert.equal((await lstat(file)).mode & 0o077,0,`private file mode: ${file}`);
  assert.equal((await lstat(root)).mode & 0o777,0o700); pass('private runtime 0700 and files 0600-or-stricter');
  report.result='pass';
} catch(error) {
  report.result='fail'; report.failures.push({name:error.name,message:error.message,code:error.code});
  console.error(error); process.exitCode=1;
} finally {
  try { report.stop=await stop(root); } catch(error) { report.result='fail'; report.failures.push({stop:error.message}); process.exitCode=1; }
  await writeFile(join(out,'integration.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({result:report.result,checks:report.checks.length,root,evidence:join(out,'integration.json'),stopped:report.stop}));
}
