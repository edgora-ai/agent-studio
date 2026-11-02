#!/usr/bin/env node
// Renew invalid m1-a bindings through the product environment.open
// new-generation flow. No workspace lifecycle action, no create/delete.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {authenticate,requestRpc,DEFAULT_ROOT as root,repo} from './preview.mjs';

const dbPath=join(root,'bindings.sqlite');
const sql=query=>{const db=new DatabaseSync(dbPath,{readOnly:true});try{return db.prepare(query).all();}finally{db.close();}};
const auth=await authenticate(root);const rpc=(m,p={})=>requestRpc(auth,m,p);
const results=[];
const describe=await rpc('environment.discover');
const workspace=describe.workspaces.find(row=>row.workspace_id==='ff136352-6a92-41d4-9c2c-6cc783cb989b');
assert.ok(workspace && workspace.status.identity?.verified, 'm1-a observation not verified');
assert.equal(workspace.status.lifecycle,'running');
const observationId=workspace.observation_id;
const invalid=sql("SELECT binding_id,version,environment_id,project_id,state,error_code,target_root FROM project_bindings p WHERE state='invalid' AND target_root LIKE '/workspace/agent-studio-binding-%' AND NOT EXISTS (SELECT 1 FROM project_bindings n WHERE n.binding_id=p.binding_id AND n.version>p.version AND n.state='ready') ORDER BY binding_id");
try{
  for(const binding of invalid){
    let opened=null,lastError=null;
    for(let attempt=0;attempt<4&&!opened;attempt++){
      const fresh=(await rpc('environment.describe')).workspaces.find(row=>row.workspace_id===workspace.workspace_id);
      const freshObservation=fresh?.observation_id;
      try{opened=await rpc('environment.open',{request_id:'renew-'+binding.binding_id+'-'+randomUUID(),workspace_id:workspace.workspace_id,observation_id:freshObservation,environment_id:binding.environment_id,binding_id:binding.binding_id,expected_version:binding.version,renew:true});}
      catch(error){lastError=error;if(error.code!=='agent-studio/environment-selection-changed'&&error.code!=='environment-selection-changed')throw error;await new Promise(resolve=>setTimeout(resolve,1200));}
    }
    if(!opened) throw lastError??new Error('renew failed');
    assert.equal(opened.state,'ready',opened.error_code??'open not ready');
    const next=await rpc('binding.get',{binding_id:opened.binding_id,version:opened.version});
    assert.equal(next.state,'ready');
    assert.notEqual(opened.version,binding.version);
    const session=await rpc('session.get',{session_id:opened.session_id});
    assert.equal(session.state,'ready');
    results.push({binding_id:binding.binding_id,old_version:binding.version,new_version:opened.version,environment_id:binding.environment_id,target_root:binding.target_root,session_id:opened.session_id,project_id:binding.project_id});
    console.log('RENEWED',binding.binding_id,'v'+binding.version,'-> v'+opened.version,'session',opened.session_id);
  }
  const refreshed=await rpc('environment.discover');
  const current=refreshed.workspaces.find(row=>row.workspace_id==='ff136352-6a92-41d4-9c2c-6cc783cb989b');
  const channels=(await rpc('environment.describe')).workspaces.find(row=>row.workspace_id==='ff136352-6a92-41d4-9c2c-6cc783cb989b')?.bindings??[];
  const connected=channels.filter(row=>row.channel?.connected===true);
  results.push({channels:channels.map(row=>({binding_id:row.binding_id,version:row.version,state:row.state,channel:row.channel?.connected===true}))});
  assert.equal(new Set(results.slice(0,-1).map(row=>row.session_id)).size,invalid.length);
}catch(error){
  console.error(JSON.stringify({result:'fail',code:error.code??error.name,message:String(error.message).slice(0,300)}));process.exitCode=1;
}finally{
  await mkdir(join(repo,'artifacts/t202'),{recursive:true});
  const artifact=join(repo,'artifacts/t202/t202-renew-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
  await writeFile(artifact,JSON.stringify({scope:'renew invalid m1-a bindings through environment.open new-generation flow; no lifecycle/create/delete',workspace_id:workspace.workspace_id,observation_id:observationId,results,result:process.exitCode?'fail':'pass'},null,2)+'\n');
  console.log(JSON.stringify({result:process.exitCode?'fail':'pass',renewed:results.filter(row=>row.session_id).length,artifact}));
}
