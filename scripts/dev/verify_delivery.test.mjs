import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {verifyEvidence,parseChecksums,manifestPath,verifyStoredState,verifyLocalState,verifyLiveState,rowHash,main} from './verify_delivery.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const clone=value=>structuredClone(value),json=value=>JSON.stringify(value,null,2)+'\n';
const doc=name=>'docs/implementation/evidence/'+name+'.json';
const paths={main:doc('accepted'),child:doc('nested'),addendum:doc('addendum'),artifact:'artifacts/accepted payload.txt',proof:'artifacts/review-proof.json'};
async function temporary(t) {
 const root=await mkdtemp(join(tmpdir(),'agent-studio-delivery-'));
 t.after(async()=>{assert.ok(root.startsWith(join(tmpdir(),'agent-studio-delivery-'))&&root===resolve(root));await rm(root,{recursive:true,force:true});});return root;
}
async function fixture(t,change=()=>{}) {
 const root=await temporary(t),files=new Map(),put=(path,value)=>{files.set(path,typeof value==='string'?value:json(value));return {path,sha256:sha(files.get(path))};};
 const artifact=put(paths.artifact,'original accepted payload\n'),proof=put(paths.proof,{result:'pass'});
 const child=put(paths.child,{artifact}),accepted=put(paths.main,{evidence:child});
 const addendum=put(paths.addendum,{proof:{...proof,path:'/archived/repo/'+proof.path}});
 const manifest={schemaVersion:2,archiveRepositoryRoot:'/archived/repo',evidence:[accepted],addenda:[addendum]};
 change({files,put,manifest,accepted,artifact,proof,child,addendum});
 put(manifestPath,manifest);
 const sums=[...files].filter(([path])=>path.startsWith('docs/')).map(([path,bytes])=>sha(bytes)+'  '+path).join('\n')+'\n';
 files.set('docs/implementation/evidence/SHA256SUMS',sums);
 for(const [path,bytes] of files){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),bytes);}
 return {root,manifest,files};
}

test('public evidence recursively verifies accepted documents, addenda and archived-root artifacts, with spaces',async t=>{
 const {root}=await fixture(t);const result=await verifyEvidence({repoRoot:root});
 assert.equal(result.checks[0].documents,3);assert.equal(result.checks[0].artifacts,2);assert.equal(result.checks[0].files,5);
 assert.equal(result.checks[1].entries,4);assert.equal(result.payloads.get(paths.child).artifact.path,paths.artifact);
});
for(const [name,path] of Object.entries(paths)) test(`evidence closure rejects independently corrupted ${name}`,async t=>{
 const {root}=await fixture(t);await writeFile(join(root,path),'CORRUPTED');await assert.rejects(verifyEvidence({repoRoot:root}),/evidence hash/);
});
test('duplicate normalized path declarations cannot silently replace their expected hashes',async t=>{
 const {root}=await fixture(t,({put,manifest,proof})=>{manifest.addenda=[put(paths.addendum,{first:proof,second:{path:'/archived/repo/'+proof.path,sha256:'0'.repeat(64)}})];});
 await assert.rejects(verifyEvidence({repoRoot:root}),/conflicting evidence hashes/);
});
test('same-hash duplicate declarations remain valid',async t=>{
 const {root}=await fixture(t,({put,manifest,proof})=>{manifest.addenda=[put(paths.addendum,{first:proof,second:proof})];});
 assert.equal((await verifyEvidence({repoRoot:root})).checks[0].artifacts,2);
});
test('unhashed manifest addenda are rejected rather than existence-checked',async t=>{
 const {root}=await fixture(t,({manifest})=>{manifest.addenda=[paths.addendum];});await assert.rejects(verifyEvidence({repoRoot:root}),/unhashed evidence/);
});
test('accepted evidence omitted from SHA256SUMS fails',async t=>{
 const {root}=await fixture(t),path=join(root,'docs/implementation/evidence/SHA256SUMS');
 await writeFile(path,(await readFile(path,'utf8')).split('\n').filter(line=>!line.endsWith(paths.child)).join('\n'));
 await assert.rejects(verifyEvidence({repoRoot:root}),/missing\/conflicting checksum/);
});
test('checksum parser handles spaces and binary markers and rejects malformed or conflicting records',()=>{
 const hash='1'.repeat(64),path='docs/implementation/evidence/file with spaces.json';
 assert.equal(parseChecksums(hash+'  '+path+'\n').get(path),hash);assert.equal(parseChecksums(hash+' *'+path+'\n').get(path),hash);
 for(const text of ['',hash+' '+path,hash+'  '+path+'\n'+'0'.repeat(64)+'  '+path]) assert.throws(()=>parseChecksums(text));
});
test('accepted path traversal is rejected before opening the target',async t=>{
 const {root}=await fixture(t,({manifest})=>{manifest.evidence=[{path:'../../outside-secret',sha256:'0'.repeat(64)}];});
 await assert.rejects(verifyEvidence({repoRoot:root}),/out-of-scope evidence path/);
});
test('artifact symlink escape fails closed even when its bytes have the declared hash',async t=>{
 const outside=await temporary(t),secret=join(outside,'outside.txt');await writeFile(secret,'outside');
 const {root}=await fixture(t,({put,manifest})=>{manifest.evidence=[put(paths.main,{artifact:{path:'artifacts/escape.txt',sha256:sha('outside')}})];});
 await symlink(secret,join(root,'artifacts/escape.txt'));await assert.rejects(verifyEvidence({repoRoot:root}),/symlink escapes repository/);
});

test('historical baseline hashes apply to archived snapshots, not mutable source paths',async t=>{
 const snapshot='artifacts/baseline/SHA256SUMS',original='docs/implementation/evidence/SHA256SUMS';
 const {root}=await fixture(t,({put,manifest})=>{
  put(snapshot,'historical checksum bytes');
  manifest.evidence=[put(paths.main,{source:{path:original,sha256:sha('historical checksum bytes'),snapshot}})];
 });
 assert.equal((await verifyEvidence({repoRoot:root})).checks[0].artifacts,2);
 await writeFile(join(root,snapshot),'corrupt snapshot');await assert.rejects(verifyEvidence({repoRoot:root}),/evidence hash/);
});
test('historical source-index fingerprints without snapshots do not override current checksum control',async t=>{
 const control='docs/implementation/evidence/SHA256SUMS';
 const {root}=await fixture(t,({put,manifest})=>{manifest.evidence=[put(paths.main,{historicalSourceBaseline:[{path:control,sha256:sha('old index'),bytes:9}]})];});
 assert.equal((await verifyEvidence({repoRoot:root})).checks[1].entries,4);
 await writeFile(join(root,control),'not a checksum index');await assert.rejects(verifyEvidence({repoRoot:root}),/invalid SHA256SUMS/);
});
for(const control of [manifestPath,'docs/implementation/evidence/SHA256SUMS']) test('public audit rejects a control-file link to repository-private bytes: '+control,async t=>{
 const {root}=await fixture(t),secret=join(root,'private-state/sentinel.json'),bytes=await readFile(join(root,control));
 await mkdir(dirname(secret));await writeFile(secret,bytes);
 // Replacing this owned fixture file is safe: resolved target is inside the
 // freshly created, checked test directory, never a runtime path.
 const target=resolve(root,control);assert.ok(target.startsWith(root+'/docs/implementation/evidence/'));await rm(target);
 await symlink(secret,target);await assert.rejects(verifyEvidence({repoRoot:root}),/public scope/);
});
test('public artifact alias cannot read private files inside the same repository',async t=>{
 const {root}=await fixture(t,({put,manifest})=>{manifest.evidence=[put(paths.main,{artifact:{path:'artifacts/private-alias.json',sha256:sha('{"fake_secret":true}')}})];});
 const secret=join(root,'private-state/sentinel.json');await mkdir(dirname(secret));await writeFile(secret,'{"fake_secret":true}');
 await symlink(secret,join(root,'artifacts/private-alias.json'));await assert.rejects(verifyEvidence({repoRoot:root}),/public scope/);
});

function storedFixture() {
 const workspace='coder-workspace';
 const bindings=Array.from({length:5},(_,index)=>({binding_id:`binding-${index}`,version:5,state:'ready',environment_id:`environment-${index}`,workspace_id:`anchor-${index}`,target_root:`/workspace/agent-studio-binding-${index}-v5`,coder_workspace_id:workspace,session_id:`session-${index}`,session_state:'ready'}));
 const unknown=[{operation_id:'unknown-1',state:'unknown',error_code:'historical-failure',result_json:'{}',updated_at:'old'}];
 const actual={policy:{read_only:true,actions:[],workspace_ids:[workspace]},bindings,unknown,pending:0,schema:8};
 const expected={workspace_id:workspace,schemaVersion:8,expectedBindings:clone(bindings),unknownOperations:1,preservedUnknownOperations:unknown.map(row=>({operation_id:row.operation_id,sha256:rowHash(row)})),pendingLifecycleRequests:0,connectedChannels:[{workspace_id:workspace,binding_id:'binding-0',version:5}]};
 return {actual,expected};
}
test('stored state verifies exact five binding identities, complete preserved rows and read-only policy',()=>{
 const {actual,expected}=storedFixture();const facts=verifyStoredState(actual,expected);
 assert.equal(facts.bindings,5);assert.equal(facts.preservedRowHashes,1);assert.equal(facts.liveRpcChecked,false);
 assert.equal(rowHash({b:2,a:1}),rowHash({a:1,b:2}));
});
for(const [name,change] of [
 ['five wrong IDs at v1',value=>{value.bindings=value.bindings.map((row,index)=>({...row,binding_id:'wrong-'+index,version:1}));}],
 ['different binding version',value=>{value.bindings[0].version=1;}],
 ['wrong target root',value=>{value.bindings[0].target_root='/workspace/wrong';}],
 ['wrong anchor workspace',value=>{value.bindings[0].workspace_id='wrong';}],
 ['wrong Coder workspace',value=>{value.bindings[0].coder_workspace_id='wrong';}],
 ['wrong environment identity',value=>{value.bindings[0].environment_id='wrong';}],
 ['wrong session',value=>{value.bindings[0].session_id='wrong';}],
 ['not-ready session',value=>{value.bindings[0].session_state='pending';}],
 ['extra remote binding',value=>{value.bindings.push({...value.bindings[0],binding_id:'extra'});}],
 ['replaced unknown ID with unchanged count',value=>{value.unknown[0].operation_id='replacement';}],
 ['rewritten unknown outcome',value=>{value.unknown[0].error_code='rewritten';}],
 ['rewritten unknown timestamp',value=>{value.unknown[0].updated_at='new';}],
 ['missing unknown row',value=>{value.unknown=[];}],
 ['pending lifecycle request',value=>{value.pending=1;}],
 ['writable policy',value=>{value.policy.read_only=false;}],
 ['enabled lifecycle action',value=>{value.policy.actions=['start'];}],
 ['wrong database schema',value=>{value.schema=7;}]
]) test('stored state rejects '+name,()=>{const {actual,expected}=storedFixture();change(actual);assert.throws(()=>verifyStoredState(actual,expected));});

test('SQLite integration uses a read-only snapshot and leaves the owned fixture bytes unchanged',async t=>{
 const root=await temporary(t),{actual,expected}=storedFixture(),path=join(root,'bindings.sqlite');
 await writeFile(join(root,'environment-policy.json'),json(actual.policy));
 const db=new DatabaseSync(path);try {
  db.exec(`CREATE TABLE project_bindings(binding_id TEXT,version INTEGER,state TEXT,environment_id TEXT,workspace_id TEXT,target_root TEXT,record_id TEXT);CREATE TABLE instance_records(record_id TEXT,workspace_id TEXT);CREATE TABLE environments(environment_id TEXT,kind TEXT);CREATE TABLE session_bindings(session_id TEXT,binding_id TEXT,version INTEGER,state TEXT);CREATE TABLE operation_records(operation_id TEXT,state TEXT,error_code TEXT,result_json TEXT,updated_at TEXT);CREATE TABLE environment_requests(state TEXT);PRAGMA user_version=8;`);
  for(const row of actual.bindings) {db.prepare('INSERT INTO project_bindings VALUES(?,?,?,?,?,?,?)').run(row.binding_id,row.version,row.state,row.environment_id,row.workspace_id,row.target_root,row.binding_id);db.prepare('INSERT INTO instance_records VALUES(?,?)').run(row.binding_id,row.coder_workspace_id);db.prepare("INSERT INTO environments VALUES(?,'coder')").run(row.environment_id);db.prepare('INSERT INTO session_bindings VALUES(?,?,?,?)').run(row.session_id,row.binding_id,row.version,row.session_state);}
  const row=actual.unknown[0];db.prepare('INSERT INTO operation_records VALUES(?,?,?,?,?)').run(row.operation_id,row.state,row.error_code,row.result_json,row.updated_at);
 } finally {db.close();}
 const before=sha(await readFile(path));assert.equal((await verifyLocalState(root,expected)).bindings,5);assert.equal(sha(await readFile(path)),before);
});
function liveFixture() {
 const {expected}=storedFixture();return {expected,discovered:{workspaces:[{workspace_id:expected.workspace_id,status:{lifecycle:'running',agent:{status:'connected'}}}]},described:{workspaces:[{workspace_id:expected.workspace_id,bindings:[{binding_id:'binding-0',version:5,channel:{connected:true}}]}]}};
}
test('live identity checker accepts only the exact sole declared channel',()=>{const {discovered,described,expected}=liveFixture();assert.equal(verifyLiveState(discovered,described,expected).channels.length,1);});
for(const [name,change] of [
 ['wrong sole channel',value=>{value.described.workspaces[0].bindings[0].binding_id='wrong';}],
 ['wrong sole version',value=>{value.described.workspaces[0].bindings[0].version=1;}],
 ['extra connected workspace',value=>{value.described.workspaces.push({workspace_id:'other',bindings:[{binding_id:'extra',version:5,channel:{connected:true}}]});}],
 ['disconnected channel',value=>{value.described.workspaces[0].bindings[0].channel.connected=false;}],
 ['disconnected agent',value=>{value.discovered.workspaces[0].status.agent.status='disconnected';}],
 ['stopped workspace',value=>{value.discovered.workspaces[0].status.lifecycle='stopped';}],
 ['failed observation',value=>{value.discovered.workspaces[0].error_code='environment-policy-denied';}]
]) test('live identity checker rejects '+name,()=>{const value=liveFixture();change(value);assert.throws(()=>verifyLiveState(value.discovered,value.described,value.expected));});
test('runtime CLI refuses implicit credential access before importing authentication',async()=>{await assert.rejects(main(['--runtime']),/requires --allow-credential-read/);await assert.rejects(main(['--allow-credential-read']),/requires --runtime/);await assert.rejects(main(['--evidence-only','--local-state']),/conflicting/);await assert.rejects(main(['--typo']),/unknown option/);});
