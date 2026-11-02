#!/usr/bin/env node
// T-202 minimal real lifecycle acceptance: start/stop the existing m1-a only.
// Uses the product environment RPC. Temporarily widens the private policy to
// start/stop, then restores the original read-only policy in finally.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {authenticate,requestRpc,DEFAULT_ROOT as root,repo} from './preview.mjs';

const policyPath=join(root,'environment-policy.json');
const original=await readFile(policyPath);
const originalPolicy=JSON.parse(original.toString('utf8'));
const templateVersionId=(originalPolicy.templates??[])[0]?.version_id;
const checks=[];let stopRequest=null,startRequest=null,workspaceId=null;
const pass=(name,facts={})=>{checks.push({name,...facts});console.log('PASS '+name);};
const restore=async()=>{await writeFile(policyPath,original,{mode:0o600});};
const sql=query=>{const db=new DatabaseSync(join(root,'bindings.sqlite'),{readOnly:true});try{return db.prepare(query).all();}finally{db.close();}};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

try {
  const auth=await authenticate(root);const rpc=(method,payload={})=>requestRpc(auth,method,payload);
  workspaceId=originalPolicy.workspace_ids[0];
  await rpc('environment.discover');                                        // refreshes observation and reads the still-read-only policy
  const before=(await rpc('environment.describe')).workspaces.find(row=>row.workspace_id===workspaceId);
  assert.ok(before && !before.error_code,'m1-a observation not ready');
  assert.equal(before.status.identity?.verified,true);
  assert.equal(before.status.lifecycle,'running');

  await writeFile(policyPath,JSON.stringify({...originalPolicy,read_only:false,actions:['start','stop']},null,2)+'\n',{mode:0o600});
  await rpc('environment.discover');
  const widened=await rpc('environment.describe');
  assert.equal(widened.read_only,false);
  assert.deepEqual([...widened.actions].sort(),['start','stop']);
  pass('temporary minimal policy allows only start/stop for the existing m1-a (no create/rebuild/delete)',{workspace_id:workspaceId,actions:widened.actions});

  async function request(action) {
    const input={request_id:'t202-'+action+'-'+randomUUID(),action,workspace_id:workspaceId,template_version_id:templateVersionId};
    const prepared=await rpc('environment.prepare',input);
    assert.equal(prepared.state,'prepared');
    assert.equal(prepared.action,action);
    const phrase=JSON.parse(prepared.confirmation_json).phrase;
    const confirmed=await rpc('environment.confirm',{request_id:prepared.request_id,parameters_sha256:prepared.parameters_sha256,phrase});
    assert.equal(confirmed.state,'submitting');
    const deadline=Date.now()+190000;
    while(Date.now()<deadline) {
      const row=await rpc('environment.poll',{request_id:prepared.request_id});
      if(['succeeded','failed','unknown','timed-out'].includes(row.state)) return row;
      await sleep(500);
    }
    throw Object.assign(new Error('action poll deadline'),{code:'acceptance-poll-timeout'});
  }

  stopRequest=await request('stop');
  assert.equal(stopRequest.state,'succeeded',stopRequest.error_code??'stop not succeeded');
  const stopped=(await rpc('environment.describe')).workspaces.find(row=>row.workspace_id===workspaceId);
  assert.equal(stopped.status.lifecycle,'stopped');
  pass('real Coder stop accepted and polled to lifecycle stopped with a durable request row',{request_id:stopRequest.request_id,build_id:stopRequest.build_id,state:stopRequest.state,lifecycle:stopped.status.lifecycle});

  startRequest=await request('start');
  assert.equal(startRequest.state,'succeeded',startRequest.error_code??'start not succeeded');
  let running=null;
  for(let attempt=0;attempt<60;attempt++) {
    await rpc('environment.discover');
    running=(await rpc('environment.describe')).workspaces.find(row=>row.workspace_id===workspaceId);
    if(running?.status.lifecycle==='running') break;
    await sleep(500);
  }
  assert.equal(running.status.lifecycle,'running');
  pass('real Coder start accepted and polled back to running; workspace data/lifecycle preserved',{request_id:startRequest.request_id,build_id:startRequest.build_id,state:startRequest.state,lifecycle:running.status.lifecycle,agent:running.status.agent?.status});

  const rows=sql("SELECT request_id,action,state,build_id,attempted_at FROM environment_requests ORDER BY created_at,rowid");
  const byId=Object.fromEntries(rows.map(row=>[row.request_id,row]));
  assert.equal(byId[stopRequest.request_id].state,'succeeded');
  assert.equal(byId[startRequest.request_id].state,'succeeded');
  assert.equal(rows.length,2);
  assert.ok(rows.every(row=>row.attempted_at));
  assert.ok(!rows.some(row=>row.state==='unknown'));
  pass('environment_requests SQL readback: exactly two attempted requests, both succeeded, no unknown submission',{requests:rows.map(row=>({request_id:row.request_id,action:row.action,state:row.state,build_id:row.build_id}))});
} catch (error) {
  console.error(JSON.stringify({result:'fail',code:error.code??error.name,message:String(error.message).slice(0,300)}));
  process.exitCode=1;
} finally {
  await restore();
  // Prove the restored read-only policy gates a new action before any Coder call.
  try {
    const auth=await authenticate(root);
    await assert.rejects(()=>requestRpc(auth,'environment.prepare',{request_id:'t202-restore-probe-'+randomUUID(),action:'start',workspace_id:workspaceId,template_version_id:templateVersionId}),
      error=>error.code==='agent-studio/environment-read-only'||error.code==='environment-read-only');
    const describe=await requestRpc(auth,'environment.describe');
    assert.equal(describe.read_only,true);
    assert.deepEqual(describe.actions,[]);
    pass('original read-only policy restored; a post-restore start prepare is refused before any Coder call',{read_only:describe.read_only,actions:describe.actions});
  } catch (error) {
    console.error(JSON.stringify({result:'fail',stage:'policy-restore-verification',code:error.code??error.name,message:String(error.message).slice(0,300)}));
    process.exitCode=1;
  }
  const unknown=sql("SELECT count(*) n FROM operation_records WHERE state='unknown'")[0].n;
  await mkdir(join(repo,'artifacts/t202'),{recursive:true});
  const artifact=join(repo,'artifacts/t202/t202-lifecycle-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
  await writeFile(artifact,JSON.stringify({scope:'T-202 minimal real lifecycle acceptance: start/stop existing m1-a only; temporary start/stop policy restored in finally; no create/rebuild/delete/credential',checks,stopRequest,startRequest,unknownOperationsAfter:unknown,result:process.exitCode?'fail':'pass'},null,2)+'\n');
  console.log(JSON.stringify({result:process.exitCode?'fail':'pass',checks:checks.length,artifact}));
}
