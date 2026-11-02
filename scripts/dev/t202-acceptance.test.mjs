import test from 'node:test';
import assert from 'node:assert/strict';
import {runT202ConnectBindings} from './t202.connect.bindings.mjs';
import {runT202RestoreRemaining} from './t202.restore.remaining.mjs';

// Deliberately different identities: Coder target != native binding workspace anchor.
const CODER='ff136352-6a92-41d4-9c2c-6cc783cb989b';
const ANCHOR='11111111-2222-4333-8444-555555555555';
const RENEWED_ANCHOR='66666666-7777-4888-8999-aaaaaaaaaaaa';
const copy=value=>structuredClone(value);
function fixture(ids=['one']) {
  const f={calls:[],passes:[],writes:[],sessions:new Map(),rows:new Map(),before:null,after:null};
  f.workspace={workspace_id:CODER,observation_id:'observation-fixture',stale:false,status:{lifecycle:'running',agent:{status:'connected'},identity:{verified:true}},bindings:[]};
  const channel=(row,connected)=>({binding_id:row.binding_id,version:row.version,target_root:row.target_root,connected,channel_id:'channel-'+row.binding_id,helper_session_id:'helper-'+row.binding_id});
  for(const id of ids) {
    const row={binding_id:id,version:4,environment_id:'environment-'+id,project_id:'project-'+id,workspace_id:ANCHOR,target_root:'/workspace/fixture-'+id+'-v4',state:'ready'};
    row.channel=channel(row,false);f.workspace.bindings.push(row);f.rows.set(id+':4',row);
    f.sessions.set('session-'+id+'-v4',{session_id:'session-'+id+'-v4',binding_id:id,version:4,state:'ready'});
  }
  f.rpc=async(method,input={})=>{
    f.calls.push({method,input:copy(input)});await f.before?.(method,input,f);
    let value;
    if(method==='environment.discover'||method==='environment.describe')value={workspaces:[f.workspace]};
    else if(method==='session.list')value=[...f.sessions.values()];
    else if(method==='session.get')value=f.sessions.get(input.session_id);
    else if(method==='binding.get')value=f.rows.get(input.binding_id+':'+input.version);
    else if(method==='environment.open') {
      const old=f.workspace.bindings.filter(row=>row.binding_id===input.binding_id).sort((a,b)=>b.version-a.version)[0];
      assert.ok(old,'fixture open missing binding');assert.equal(input.workspace_id,CODER);assert.equal(input.expected_version,old.version);
      let row=old,sessionId=input.session_id;
      if(input.renew) {
        row={...old,version:old.version+1,workspace_id:RENEWED_ANCHOR,target_root:'/workspace/fixture-'+old.binding_id+'-v'+(old.version+1)};
        sessionId='session-'+row.binding_id+'-v'+row.version;
        f.sessions.set(sessionId,{session_id:sessionId,binding_id:row.binding_id,version:row.version,state:'ready'});
        old.state='invalid';old.channel={...old.channel,connected:false};
        f.rows.set(row.binding_id+':'+row.version,row);f.workspace.bindings.push(row);
      }
      row.channel=channel(row,true);
      value={state:'ready',binding_id:row.binding_id,version:row.version,environment_id:row.environment_id,project_id:row.project_id,session_id:sessionId};
    } else throw new Error('unexpected fixture RPC: '+method);
    value=copy(value);const replaced=await f.after?.(method,input,value,f);return replaced===undefined?value:replaced;
  };
  f.connect=(options={})=>runT202ConnectBindings({rpc:f.rpc,coderWorkspaceId:CODER,bindingIds:ids,pause:async()=>{},onPass:name=>f.passes.push(name),...options});
  f.restore=(options={})=>runT202RestoreRemaining({rpc:f.rpc,coderWorkspaceId:CODER,bindings:ids.map((id,index)=>({id,file:index===0?'model-remote-demo.json':null})),pause:async()=>{},writeDemo:async(file,payload)=>f.writes.push({file,payload:copy(payload)}),onPass:name=>f.passes.push(name),...options});
  return f;
}
async function rejectsAcceptance(promise,f,inspect=()=>{}) {
  await assert.rejects(promise,error=>{
    assert.equal(error.acceptanceReport?.result,'fail');assert.equal(f.passes.length,0,'no aggregate PASS on failed acceptance');inspect(error.acceptanceReport);return true;
  });
}

test('both real runners import without executing auth, SQLite, filesystem or RPC entrypoints',()=>{
  assert.equal(typeof runT202ConnectBindings,'function');assert.equal(typeof runT202RestoreRemaining,'function');
  assert.notEqual(CODER,ANCHOR);
});
test('connect positively verifies the actual RPC runner and separated workspace identities',async()=>{
  const f=fixture(),report=await f.connect();assert.equal(report.result,'pass');assert.equal(report.results.length,1);
  assert.equal(report.results[0].connected,true);assert.equal(f.passes.length,1);
  assert.equal(f.calls.filter(row=>row.method==='environment.open').length,1);
});
test('an already connected exact selection is verified, not silently filtered into an empty pass',async()=>{
  const f=fixture();f.workspace.bindings[0].channel.connected=true;
  const report=await f.connect();assert.equal(report.results.length,1);assert.equal(f.calls.filter(row=>row.method==='environment.open').length,0);
});

for(const [name,mutate] of [
  ['no eligible bindings',f=>{f.workspace.bindings=[];}],
  ['requested binding missing',f=>{f.workspace.bindings[0].binding_id='other';}],
  ['requested binding is invalid',f=>{f.workspace.bindings[0].state='invalid';}],
  ['session list missing exact version',f=>{f.sessions.clear();}],
  ['session no longer ready',f=>{f.before=(method,input,s)=>{if(method==='session.get')s.sessions.get(input.session_id).state='invalid';};}],
  ['binding anchor mismatch',f=>{f.after=(method,input,result)=>method==='binding.get'?{...result,workspace_id:CODER}:undefined;}],
  ['link ready but channel disconnected',f=>{f.after=(method,input,result,s)=>{if(method==='environment.open')s.workspace.bindings[0].channel.connected=false;};}],
  ['ready link identifies another binding',f=>{f.after=(method,input,result)=>method==='environment.open'?{...result,binding_id:'other'}:undefined;}],
  ['ready link identifies another version',f=>{f.after=(method,input,result)=>method==='environment.open'?{...result,version:3}:undefined;}],
  ['ready link identifies another session',f=>{f.after=(method,input,result)=>method==='environment.open'?{...result,session_id:'other'}:undefined;}],
  ['binding moves to a newer version after open',f=>{f.after=(method,input,result,s)=>{if(method==='environment.open')s.workspace.bindings[0].version++;};}],
  ['channel version mismatch',f=>{f.after=(method,input,result,s)=>{if(method==='environment.open')s.workspace.bindings[0].channel.version=3;};}],
  ['channel binding mismatch',f=>{f.after=(method,input,result,s)=>{if(method==='environment.open')s.workspace.bindings[0].channel.binding_id='other';};}],
  ['channel target root mismatch',f=>{f.after=(method,input,result,s)=>{if(method==='environment.open')s.workspace.bindings[0].channel.target_root='/workspace/other';};}],
  ['channel proof identity missing',f=>{f.after=(method,input,result,s)=>{if(method==='environment.open')s.workspace.bindings[0].channel.channel_id=null;};}],
  ['helper session identity missing',f=>{f.after=(method,input,result,s)=>{if(method==='environment.open')s.workspace.bindings[0].channel.helper_session_id=null;};}],
  ['stale observation',f=>{f.workspace.stale=true;}],
  ['missing explicit freshness',f=>{delete f.workspace.stale;}],
  ['unverified workspace',f=>{f.workspace.status.identity.verified=false;}],
  ['missing explicit verified identity',f=>{delete f.workspace.status.identity;}],
  ['workspace error despite connected/running fields',f=>{f.workspace.error_code='environment-not-ready';}],
  ['status error despite connected/running fields',f=>{f.workspace.status.error_code='environment-not-ready';}],
])test('connect rejects '+name,async()=>{const f=fixture();mutate(f);await rejectsAcceptance(f.connect(),f);});
test('connect rejects an explicit stale version without any open',async()=>{
  const f=fixture();await rejectsAcceptance(f.connect({expectedVersions:{one:3}}),f);
  assert.equal(f.calls.some(row=>row.method==='environment.open'),false);
});
test('connect cannot pass when only some explicit requested IDs exist',async()=>{
  const f=fixture();await rejectsAcceptance(f.connect({bindingIds:['one','missing']}),f);
});
test('connect only retries the explicit selection-changed error and rechecks channel evidence',async()=>{
  const f=fixture();let attempts=0;
  f.before=method=>{if(method==='environment.open'&&attempts++===0)throw Object.assign(new Error('selection changed'),{code:'agent-studio/environment-selection-changed'});};
  const report=await f.connect();assert.equal(report.result,'pass');assert.equal(attempts,2);
});

test('connect accepts retained invalid history but selects only the unique latest ready version',async()=>{
  const f=fixture(),old=copy(f.workspace.bindings[0]);old.version=3;old.state='invalid';old.target_root='/workspace/fixture-one-v3';old.channel={...old.channel,version:3,target_root:old.target_root,connected:false};
  f.workspace.bindings.unshift(old);f.rows.set('one:3',old);
  const report=await f.connect();assert.equal(report.result,'pass');assert.equal(report.results[0].version,4);
});
test('connect cannot select an older ready row when a newer invalid version exists',async()=>{
  const f=fixture(),newer=copy(f.workspace.bindings[0]);newer.version=5;newer.state='invalid';f.workspace.bindings.push(newer);
  await rejectsAcceptance(f.connect({expectedVersions:{one:4}}),f);assert.equal(f.calls.some(row=>row.method==='environment.open'),false);
});
test('connect rejects duplicate latest version rows instead of choosing an arbitrary identity',async()=>{
  const f=fixture();f.workspace.bindings.push(copy(f.workspace.bindings[0]));await rejectsAcceptance(f.connect(),f);
});

test('restore positively runs actual renewal and connect verification for every requested binding',async()=>{
  const f=fixture(['one','two']),report=await f.restore();assert.equal(report.result,'pass');assert.equal(report.results.length,2);
  assert.ok(report.results.every(row=>row.old_version===4&&row.version===5&&row.connected));
  assert.equal(new Set(report.results.map(row=>row.session_id)).size,2);assert.equal(f.passes.length,1);
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].payload.workspace_id,RENEWED_ANCHOR);assert.equal(f.writes[0].payload.version,5);
  assert.equal(f.calls.filter(row=>row.method==='environment.open'&&row.input.renew===true).length,2);
});
test('restore all-skipped agent outage is FAIL with no aggregate PASS or side effects',async()=>{
  const f=fixture(['one','two']);f.workspace.status.agent.status='disconnected';
  await rejectsAcceptance(f.restore(),f,report=>{assert.equal(report.results.length,2);assert.ok(report.results.every(row=>row.status==='skipped'));});
  assert.equal(f.calls.some(row=>row.method==='environment.open'),false);assert.equal(f.writes.length,0);
});
test('restore empty requested set is incomplete, never a vacuous PASS',async()=>{
  const f=fixture();await rejectsAcceptance(f.restore({bindings:[]}),f);assert.equal(f.calls.length,0);
});
test('restore partial renewal failure remains FAIL and records the successful subset truthfully',async()=>{
  const f=fixture(['one','two']);f.before=(method,input)=>{if(method==='environment.open'&&input.renew&&input.binding_id==='two')throw new Error('fixture renewal failed');};
  await rejectsAcceptance(f.restore(),f,report=>assert.deepEqual(report.results.map(row=>row.status),['restored','failed']));
});
for(const [name,mutate] of [
  ['missing binding',f=>{f.workspace.bindings=[];}],
  ['renewal did not advance version',f=>{f.after=(method,input,result)=>method==='environment.open'&&input.renew?{...result,version:4}:undefined;}],
  ['renewal ready with wrong binding',f=>{f.after=(method,input,result)=>method==='environment.open'&&input.renew?{...result,binding_id:'other'}:undefined;}],
  ['renewal ready with wrong environment',f=>{f.after=(method,input,result)=>method==='environment.open'&&input.renew?{...result,environment_id:'other'}:undefined;}],
  ['renewal failed link',f=>{f.after=(method,input,result)=>method==='environment.open'&&input.renew?{...result,state:'failed',error_code:'fixture-failed'}:undefined;}],
  ['renewed binding missing',f=>{f.after=(method,input,result)=>method==='binding.get'?null:undefined;}],
  ['renewed anchor disagrees with the fresh binding',f=>{f.after=(method,input,result)=>method==='binding.get'?{...result,workspace_id:CODER}:undefined;}],
  ['renewal reused the old native anchor',f=>{f.after=(method,input,result)=>method==='binding.get'?{...result,workspace_id:ANCHOR}:undefined;}],
  ['renewal reused the old target root',f=>{f.after=(method,input,result)=>method==='binding.get'?{...result,target_root:'/workspace/fixture-one-v4'}:undefined;}],
  ['renewed session wrong version',f=>{f.after=(method,input,result)=>method==='session.get'?{...result,version:4}:undefined;}],
  ['renewed session missing',f=>{f.after=(method,input,result)=>method==='session.get'?null:undefined;}],
  ['renewed session not ready',f=>{f.after=(method,input,result)=>method==='session.get'?{...result,state:'invalid'}:undefined;}],
  ['stale renewed workspace observation',f=>{f.after=(method,input,result)=>method==='environment.open'&&input.renew?(f.workspace.stale=true,undefined):undefined;}],
  ['connected/running workspace contains an error',f=>{f.workspace.status.error_code='environment-blocked';}],
])test('restore rejects '+name+' without writing a demo',async()=>{
  const f=fixture();mutate(f);await rejectsAcceptance(f.restore(),f);assert.equal(f.writes.length,0);
});
test('restore final cross-binding channel loss cannot pass after two apparently successful renewals',async()=>{
  const f=fixture(['one','two']);
  f.before=(method,input,s)=>{if(method==='environment.open'&&input.renew&&input.binding_id==='two')s.workspace.bindings.filter(row=>row.binding_id==='one').sort((a,b)=>b.version-a.version)[0].channel.connected=false;};
  await rejectsAcceptance(f.restore(),f,report=>assert.equal(report.results.length,2));
});
