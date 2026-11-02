#!/usr/bin/env node
// Reproducible delivery audit: evidence hashes, checksum manifest, runtime
// invariants and (with --runtime) live environment state. Read-only.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join,isAbsolute} from 'node:path';
import {authenticate,requestRpc,DEFAULT_ROOT as root,repo} from './preview.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const args=new Set(process.argv.slice(2)),checks=[];
const pass=(name,facts={})=>{checks.push({name,...facts});console.log('PASS '+name);};
const manifestPath='docs/implementation/evidence/m2-delivery-manifest-2026-11-02.json';
const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
for(const item of manifest.evidence){const bytes=await readFile(item.path);assert.equal(sha(bytes),item.sha256,item.path);}
pass('delivery manifest evidence hashes',{entries:manifest.evidence.length});
for(const addendum of manifest.addenda??[]){await readFile(addendum);}
pass('delivery manifest addenda exist',{count:(manifest.addenda??[]).length});
// Evidence payloads embed artifact paths/hashes (JSON reports, screenshots);
// verify those bytes too so a stale artifact cannot hide behind a good
// delivery-manifest entry.
const nested=[];const visit=value=>{if(!value||typeof value!=='object')return;if(typeof value.path==='string'&&typeof value.sha256==='string'&&(value.path.startsWith('artifacts/')||value.path.includes('/artifacts/')))nested.push({path:value.path,sha256:value.sha256});for(const child of Object.values(value))visit(child);};
for(const item of manifest.evidence){visit(JSON.parse(await readFile(item.path,'utf8')));}
const unique=new Map(nested.map(entry=>[entry.path,entry.sha256]));
for(const [path,expected] of unique){const resolved=isAbsolute(path)?path:join(repo,path);assert.equal(sha(await readFile(resolved)),expected,path);}
pass('embedded artifact hashes match current bytes',{artifacts:unique.size});
const sumLines=(await readFile('docs/implementation/evidence/SHA256SUMS','utf8')).split('\n').filter(line=>line.trim());
for(const line of sumLines){const [expected,path]=line.trim().split(/\s+/,2);assert.equal(sha(await readFile(path)),expected,path);}
pass('SHA256SUMS entries match current evidence bytes',{entries:sumLines.length});
const policy=JSON.parse(await readFile(join(root,'environment-policy.json'),'utf8'));
assert.equal(policy.read_only,true);assert.deepEqual(policy.actions,[]);
pass('environment policy is read-only with no actions');
const db=new DatabaseSync(join(root,'bindings.sqlite'),{readOnly:true});
const unknown=db.prepare("SELECT count(*) n FROM operation_records WHERE state='unknown'").get().n;
const pending=db.prepare("SELECT count(*) n FROM environment_requests WHERE state IN ('prepared','submitting','accepted','unknown','timed-out')").get().n;
const latest=db.prepare("SELECT binding_id,version,state FROM project_bindings p WHERE version=(SELECT max(version) FROM project_bindings m WHERE m.binding_id=p.binding_id) AND target_root LIKE '/workspace/agent-studio-binding-%'").all();
db.close();
assert.equal(unknown,manifest.runtime.unknownOperations);assert.equal(pending,0);
assert.ok(latest.length>=5 && latest.every(row=>row.state==='ready'),JSON.stringify(latest));
pass('database invariants match the manifest',{unknown,pending,latestBindings:latest.length,version:[...new Set(latest.map(row=>row.version))]});
if(args.has('--runtime')){
 const auth=await authenticate(root),rpc=(m,p={})=>requestRpc(auth,m,p);
 const discovered=await rpc('environment.discover'),workspace=discovered.workspaces?.find(row=>row.workspace_id==='ff136352-6a92-41d4-9c2c-6cc783cb989b');
 assert.equal(workspace?.status?.agent?.status,'connected');assert.equal(workspace?.status?.lifecycle,'running');
 const described=await rpc('environment.describe'),target=described.workspaces.find(row=>row.workspace_id===workspace.workspace_id);
 const connected=target.bindings.filter(binding=>binding.channel?.connected===true);
 assert.equal(connected.length,1,JSON.stringify(connected));
 pass('live runtime: agent connected, lifecycle running, exactly one remote channel',{channel:connected[0].binding_id.slice(-8)+' v'+connected[0].version});
}
console.log(JSON.stringify({result:'pass',checks:checks.length,files:manifest.evidence.length}));
