#!/usr/bin/env node
// T-201 product-RPC acceptance slice. Uses only the already-running local preview's
// authenticated /agent-studio-rpc route; no restart, remote, network or model.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {authenticate,requestRpc,DEFAULT_ROOT as root} from './preview.mjs';

const checks=[];
const pass=(name,facts={})=>{checks.push({name,...facts});console.log('PASS '+name);};
const run=randomUUID();
try {
  const ready=JSON.parse(await readFile(join(root,'ready.json'),'utf8'));
  assert.ok(ready.pid && ready.origin, 'preview not running');
  const auth=await authenticate(root);
  const rpc=(method,payload)=>requestRpc(auth,method,payload);

  const project=await rpc('project.create',{name:'T-201 RPC acceptance '+run,source_kind:'empty'});
  const environment=await rpc('environment.register',{catalog_key:'local-preview'});
  const binding=await rpc('binding.create',{project_id:project.project_id,environment_id:environment.environment_id});
  assert.equal(binding.state,'ready');
  assert.ok(binding.anchor_path && binding.anchor_dev && binding.anchor_ino && binding.workspace_id);
  const session=await rpc('session.create',{binding_id:binding.binding_id,version:binding.version,title:'T-201 RPC session '+run});
  assert.equal(session.state,'ready');
  assert.equal(session.binding_id,binding.binding_id);
  assert.equal(session.version,binding.version);
  pass('product RPC project.create/environment.register/binding.create/session.create reach a ready versioned binding and session',{project_id:project.project_id,environment_id:environment.environment_id,binding_id:binding.binding_id,version:binding.version,session_id:session.session_id,anchor_path:binding.anchor_path});

  const fetched={project:await rpc('project.get',{project_id:project.project_id}),
    binding:await rpc('binding.get',{binding_id:binding.binding_id,version:binding.version}),
    session:await rpc('session.get',{session_id:session.session_id})};
  assert.equal(fetched.project.project_id,project.project_id);
  assert.equal(fetched.binding.binding_id,binding.binding_id);
  assert.equal(fetched.binding.version,binding.version);
  assert.equal(fetched.session.session_id,session.session_id);
  assert.equal(fetched.session.native.inspection.meta.cwd,binding.anchor_path);
  const listed=(await rpc('binding.list')).filter(row=>row.binding_id===binding.binding_id);
  assert.ok(listed.some(row=>row.version===binding.version));
  const db=new DatabaseSync(join(root,'bindings.sqlite'),{readOnly:true});
  const direct={project:db.prepare('SELECT * FROM projects WHERE project_id=?').get(project.project_id),
    binding:db.prepare('SELECT * FROM project_bindings WHERE binding_id=? AND version=?').get(binding.binding_id,binding.version),
    session:db.prepare('SELECT * FROM session_bindings WHERE session_id=?').get(session.session_id)};
  db.close();
  assert.deepEqual({...project},{...direct.project});
  assert.deepEqual({...binding},{...direct.binding});
  assert.deepEqual({...session},{...direct.session});
  pass('write through RPC -> direct read-only SQL -> product RPC by ID/list return the same immutable rows',{project_id:project.project_id,binding_id:binding.binding_id,session_id:session.session_id});

  await assert.rejects(()=>rpc('binding.create',{project_id:project.project_id,environment_id:environment.environment_id,binding_id:binding.binding_id,expected_version:99}),
    error=>error.code==='agent-studio/version-conflict'||error.code==='version-conflict');
  await assert.rejects(()=>rpc('dispatch.check',{session_id:session.session_id,binding_id:binding.binding_id,version:binding.version+1,operation:'metadata.read'}),
    error=>error.code==='agent-studio/version-mismatch'||error.code==='version-mismatch');
  const eligible=await rpc('dispatch.check',{session_id:session.session_id,operation:'metadata.read'});
  assert.equal(eligible.eligible,true);
  assert.equal(eligible.executed,false);
  assert.equal(eligible.binding_id,binding.binding_id);
  assert.equal(eligible.version,binding.version);
  pass('product RPC dispatch guard rejects version mismatch and a stale/unknown binding version, while metadata.read stays non-executing',{eligible:eligible.eligible,executed:eligible.executed});
} catch (error) {
  console.error(JSON.stringify({result:'fail',code:error.code??error.name,message:String(error.message).slice(0,300)}));
  process.exitCode=1;
} finally {
  await mkdir(join(root.replace(/\/\.preview\/agent-studio\/?$/,''),'artifacts/t201'),{recursive:true});
  const artifact=join(root.replace(/\/\.preview\/agent-studio\/?$/,''),'artifacts/t201/t201-rpc-slice-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
  await writeFile(artifact,JSON.stringify({scope:'T-201 product RPC acceptance slice on the already-running local preview; no restart/remote/network/model',run,checks,result:process.exitCode?'fail':'pass'},null,2)+'\n');
  console.log(JSON.stringify({result:process.exitCode?'fail':'pass',checks:checks.length,artifact}));
}
