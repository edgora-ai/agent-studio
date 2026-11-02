#!/usr/bin/env node
// Public evidence audit by default. --local-state opens only policy/SQLite,
// read-only; authenticated RPC additionally requires --allow-credential-read.
import assert from 'node:assert/strict';
import {readFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const repo=fileURLToPath(new URL('../../',import.meta.url));
export const manifestPath='docs/implementation/evidence/m2-delivery-manifest-2026-11-02.json';
const sumsPath='docs/implementation/evidence/SHA256SUMS';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const hashPattern=/^[a-f0-9]{64}$/;
export const canonical=value=>JSON.stringify(value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,JSON.parse(canonical(value[key]))])):Array.isArray(value)?value.map(item=>JSON.parse(canonical(item))):value);
export const rowHash=row=>sha(canonical(row));
// The mutable checksum index is a control file, not an immutable JSON report.
const evidencePath=path=>path.startsWith('docs/implementation/evidence/')&&path.endsWith('.json')||path.startsWith('artifacts/');
const publicPath=path=>path.startsWith('docs/implementation/')||path.startsWith('artifacts/');

export function parseChecksums(text) {
 const result=new Map();
 for(const line of text.split('\n').filter(line=>line.trim())) {
  // sha256sum has exactly one separator plus a text/binary marker; paths may
  // contain spaces. Escaped/newline filenames are deliberately unsupported.
  const match=/^([a-f0-9]{64}) [ *](.+)$/.exec(line);
  assert.ok(match,'invalid SHA256SUMS record');
  const [,hash,path]=match;
  assert.ok(!result.has(path)||result.get(path)===hash,'conflicting checksum: '+path);
  result.set(path,hash);
 }
 assert.ok(result.size,'empty SHA256SUMS');return result;
}

export async function verifyEvidence({repoRoot=repo,manifestFile=manifestPath}={}) {
 repoRoot=await realpath(repoRoot);
 const bytesAt=async path=>{
  const logical=relative(repoRoot,resolve(repoRoot,path));
  assert.ok(publicPath(logical),'out-of-scope public path: '+path);
  const actual=await realpath(resolve(repoRoot,path)),rel=relative(repoRoot,actual);
  assert.ok(publicPath(rel),'evidence symlink escapes repository/public scope: '+path);
  return readFile(actual);
 };
 const manifest=JSON.parse(await bytesAt(manifestFile));
 assert.equal(manifest.schemaVersion,2,'delivery manifest schemaVersion');
 assert.ok(Array.isArray(manifest.evidence)&&manifest.evidence.length,'empty accepted evidence');
 assert.ok(Array.isArray(manifest.addenda),'missing accepted addenda');
 const normalize=(path,{checksum=false}={})=>{
  assert.equal(typeof path,'string','evidence path');
  const archive=manifest.archiveRepositoryRoot;
  if(isAbsolute(path)&&archive&&path.startsWith(archive+'/')) path=path.slice(archive.length+1);
  const rel=relative(repoRoot,resolve(repoRoot,path));
  assert.ok(rel&&!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel)&&(checksum?publicPath(rel):evidencePath(rel)),'out-of-scope evidence path: '+path);
  return rel;
 };
 const declarations=new Map(),queue=[],payloads=new Map();
 const register=(reference,source)=>{
  assert.ok(reference&&typeof reference==='object'&&!Array.isArray(reference),'unhashed evidence reference in '+source);
  const path=normalize(reference.path),hash=reference.sha256;
  assert.ok(typeof hash==='string'&&hashPattern.test(hash),'invalid evidence hash: '+path);
  const previous=declarations.get(path);
  assert.ok(!previous||previous.sha256===hash,'conflicting evidence hashes: '+path);
  if(!previous){declarations.set(path,{path,sha256:hash,source});queue.push(path);}
 };
 for(const reference of [...manifest.evidence,...manifest.addenda]) register(reference,'delivery manifest');
 const visit=(value,source)=>{
  if(!value||typeof value!=='object') return;
  // Source baselines name mutable originals as `path`; their hash belongs to
  // the archived `snapshot`, never to today's source/checksum file.
  const reference=typeof value.snapshot==='string'?{...value,path:value.snapshot}:value;
  if(typeof reference.path==='string'&&typeof reference.sha256==='string'&&(evidencePath(reference.path)||reference.path.includes('/artifacts/')||reference.path.includes('/docs/implementation/evidence/')&&reference.path.endsWith('.json'))) register(reference,source);
  for(const child of Object.values(value)) visit(child,source);
 };
 for(let index=0;index<queue.length;index++) {
  const path=queue[index],bytes=await bytesAt(path);
  assert.equal(sha(bytes),declarations.get(path).sha256,'evidence hash: '+path+' (declared in '+declarations.get(path).source+')');
  if(path.endsWith('.json')) {const value=JSON.parse(bytes);payloads.set(path,value);visit(value,path);}
 }
 const sums=parseChecksums((await bytesAt(sumsPath)).toString('utf8')),normalizedSums=new Map();
 for(const [name,hash] of sums) {
  const path=normalize(name,{checksum:true});
  assert.ok(!normalizedSums.has(path)||normalizedSums.get(path)===hash,'conflicting checksum: '+path);
  normalizedSums.set(path,hash);assert.equal(sha(await bytesAt(path)),hash,'SHA256SUMS: '+path);
 }
 assert.ok(normalizedSums.has(manifestFile),'delivery manifest missing from SHA256SUMS');
 for(const [path,reference] of declarations) if(path.startsWith('docs/implementation/evidence/')) assert.equal(normalizedSums.get(path),reference.sha256,'accepted evidence missing/conflicting checksum: '+path);
 return {manifest,payloads,checks:[
  {name:'accepted evidence and addenda hash closure',roots:manifest.evidence.length+manifest.addenda.length,documents:[...declarations.keys()].filter(path=>path.startsWith('docs/')).length,artifacts:[...declarations.keys()].filter(path=>path.startsWith('artifacts/')).length,files:declarations.size},
  {name:'SHA256SUMS matches all listed evidence bytes',entries:normalizedSums.size}
 ]};
}

export function verifyStoredState({policy,bindings,unknown,pending,schema},expected) {
 assert.equal(policy.read_only,true,'policy read_only');assert.deepEqual(policy.actions,[],'policy actions');
 assert.ok(policy.workspace_ids.includes(expected.workspace_id),'policy workspace');
 assert.equal(schema,expected.schemaVersion,'database schema');
 assert.equal(pending,expected.pendingLifecycleRequests,'pending lifecycle requests');
 assert.ok(Array.isArray(expected.expectedBindings)&&expected.expectedBindings.length,'missing declared bindings');
 const ordered=rows=>[...rows].sort((a,b)=>a.binding_id.localeCompare(b.binding_id)||String(a.session_id).localeCompare(String(b.session_id)));
 assert.deepEqual(ordered(bindings),ordered(expected.expectedBindings),'exact current binding/session identity');
 assert.ok(expected.expectedBindings.every(row=>row.coder_workspace_id===expected.workspace_id&&row.state==='ready'&&row.session_state==='ready'&&row.target_root===`/workspace/agent-studio-${row.binding_id}-v${row.version}`),'invalid declared binding scope');
 const preserved=unknown.map(row=>({operation_id:row.operation_id,sha256:rowHash(row)})).sort((a,b)=>a.operation_id.localeCompare(b.operation_id));
 assert.ok(Array.isArray(expected.preservedUnknownOperations)&&expected.preservedUnknownOperations.length===expected.unknownOperations,'missing preserved unknown row baseline');
 assert.equal(unknown.length,expected.unknownOperations,'unknown operation count');
 assert.deepEqual(preserved,[...expected.preservedUnknownOperations].sort((a,b)=>a.operation_id.localeCompare(b.operation_id)),'preserved unknown operation identity/content');
 return {name:'read-only local database and policy match exact manifest identities',schema,bindings:bindings.length,versions:[...new Set(bindings.map(row=>row.version))],unknown:unknown.length,preservedRowHashes:preserved.length,pending,policy:{read_only:policy.read_only,actions:policy.actions},liveRpcChecked:false};
}

export async function verifyLocalState(root,expected) {
 const policy=JSON.parse(await readFile(join(root,'environment-policy.json'),'utf8'));
 const db=new DatabaseSync(join(root,'bindings.sqlite'),{readOnly:true});
 try {
  db.exec('BEGIN');
  const bindings=db.prepare(`SELECT p.binding_id,p.version,p.state,p.environment_id,p.workspace_id,p.target_root,i.workspace_id AS coder_workspace_id,s.session_id,s.state AS session_state FROM project_bindings p JOIN instance_records i ON i.record_id=p.record_id JOIN environments e ON e.environment_id=p.environment_id LEFT JOIN session_bindings s ON s.binding_id=p.binding_id AND s.version=p.version WHERE p.version=(SELECT max(m.version) FROM project_bindings m WHERE m.binding_id=p.binding_id) AND e.kind='coder' AND i.workspace_id=? ORDER BY p.binding_id,s.session_id`).all(expected.workspace_id).map(row=>({...row}));
  const unknown=db.prepare("SELECT * FROM operation_records WHERE state='unknown' ORDER BY operation_id").all();
  const pending=db.prepare("SELECT count(*) n FROM environment_requests WHERE state IN ('prepared','submitting','accepted','unknown','timed-out')").get().n;
  const schema=db.prepare('PRAGMA user_version').get().user_version;
  return verifyStoredState({policy,bindings,unknown,pending,schema},expected);
 } finally {db.close();}
}

export function verifyLiveState(discovered,described,expected) {
 const workspace=discovered.workspaces?.find(row=>row.workspace_id===expected.workspace_id);
 assert.equal(workspace?.error_code??workspace?.status?.error_code??null,null,'live observation error');
 assert.equal(workspace?.status?.agent?.status,'connected','live agent');assert.equal(workspace?.status?.lifecycle,'running','live lifecycle');
 const connected=(described.workspaces??[]).flatMap(workspace=>(workspace.bindings??[]).filter(binding=>binding.channel?.connected===true).map(binding=>({workspace_id:workspace.workspace_id,binding_id:binding.binding_id,version:binding.version})));
 assert.deepEqual(connected,expected.connectedChannels,'exact sole channel across all workspaces');
 return {name:'authenticated live agent and exact sole channel',channels:connected};
}

export async function verifyDelivery({repoRoot=repo,root=join(repoRoot,'.preview/agent-studio'),localState=false,rpc}={}) {
 const result=await verifyEvidence({repoRoot});
 if(localState||rpc) result.checks.push(await verifyLocalState(root,result.manifest.runtime));
 if(rpc) result.checks.push(verifyLiveState(await rpc('environment.discover'),await rpc('environment.describe'),result.manifest.runtime));
 return {result:'pass',mode:rpc?'authenticated-runtime':localState?'evidence-and-local-state':'public-evidence-only',checks:result.checks.length,facts:result.checks,liveRpcChecked:!!rpc};
}

export async function main(argv=process.argv.slice(2)) {
 const args=new Set(argv),allowed=new Set(['--evidence-only','--local-state','--runtime','--allow-credential-read']);
 for(const arg of args) assert.ok(allowed.has(arg),'unknown option: '+arg);
 assert.ok(!args.has('--evidence-only')||!args.has('--local-state')&&!args.has('--runtime'),'conflicting verification modes');
 assert.ok(!args.has('--runtime')||args.has('--allow-credential-read'),'--runtime requires --allow-credential-read; use --local-state for a no-credential audit');
 assert.ok(!args.has('--allow-credential-read')||args.has('--runtime'),'--allow-credential-read requires --runtime');
 let rpc;
 if(args.has('--runtime')) {const {authenticate,requestRpc}=await import('./preview.mjs');const auth=await authenticate(join(repo,'.preview/agent-studio'));rpc=(method,input={})=>requestRpc(auth,method,input);}
 const result=await verifyDelivery({localState:args.has('--local-state'),rpc});
 for(const fact of result.facts) console.log('PASS '+fact.name);
 console.log(JSON.stringify(result));return result;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) main().catch(error=>{console.error('FAIL '+error.message);process.exitCode=1;});
