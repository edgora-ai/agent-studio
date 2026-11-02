import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../../packages/dsh-agent-studio/store.mjs';
import {EnvironmentState,validateEnvironmentPolicy,canonical,digest} from '../../packages/dsh-agent-studio/environment-state.mjs';
import {EnvironmentManager} from '../../packages/dsh-agent-studio/environment-manager.mjs';
import {StudioError} from '../../packages/dsh-agent-studio/store.mjs';

// Explicit in-process protocol/state fixtures. Never contacts Coder or a model.
export const ids={workspace:'11111111-1111-4111-8111-111111111111',owner:'22222222-2222-4222-8222-222222222222',org:'33333333-3333-4333-8333-333333333333',template:'44444444-4444-4444-8444-444444444444',version:'55555555-5555-4555-8555-555555555555',agent:'66666666-6666-4666-8666-666666666666'};
export const policy=()=>validateEnvironmentPolicy({version:1,transport:'coder-lab-v1',read_only:false,owner_id:ids.owner,owner_name:'lab-owner',organization_id:ids.org,workspace_ids:[ids.workspace],actions:['create','start','stop'],templates:[{template_id:ids.template,version_id:ids.version,name:'OFFLINE ENVIRONMENT FIXTURE',template_version:'fixture-v1',roots:['/workspace'],image_id:'sha256:'+'a'.repeat(64),parameters:[],create_names:['fixture-owned']}],observation_ttl_ms:30000,action_timeout_ms:180000});
export const observation=(changes={})=>({workspace_id:ids.workspace,name:'fixture-owned',owner_id:ids.owner,organization_id:ids.org,template_id:ids.template,template_version_id:ids.version,lifecycle:'running',build:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',transition:'start'},job:{status:'succeeded'},agent:{id:ids.agent,status:'connected'},identity:{verified:true,generation:'fixture-generation-a'},...changes});
async function fixture(fn) {const root=await mkdtemp(join(tmpdir(),'agent-studio-test-d07-unit-')),store=new Store(root);let clock=10000;const state=new EnvironmentState(store,'fixture-run',()=>clock);try {await fn({root,store,state,principal:store.principal,advance:ms=>{clock+=ms;}});}finally{store.close();}}

test('D07 schema7 immutable observations write -> independent SQL -> full read/history -> restart',()=>fixture(({root,store,state,principal})=>{
 assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,8);
 const first=state.observe(principal,observation(),'OFFLINE-in-process');
 assert.deepEqual({...store.db.prepare('SELECT * FROM environment_observations WHERE observation_id=?').get(first.observation_id)},first);
 assert.deepEqual(state.observation(principal,first.observation_id),first);assert.deepEqual(state.observations(principal,ids.workspace),[first]);
 assert.throws(()=>store.db.prepare('UPDATE environment_observations SET error_code=?').run('changed'));
 const second=state.observe(principal,observation({lifecycle:'stopped'}),'OFFLINE-in-process');assert.deepEqual(state.latest(principal,ids.workspace),second);assert.deepEqual(state.observations(principal,ids.workspace),[first,second]);
 const other=new Store(root);try {assert.deepEqual(new EnvironmentState(other,'new-run').observations(principal,ids.workspace),[first,second]);}finally{other.close();}
}));

test('D07 read-only/owner/template/target/extra fields rejected without any lifecycle record',()=>fixture(({store,state,principal})=>{
 state.observe(principal,observation(),'OFFLINE-in-process');const p=policy(),input={request_id:'fixture-request-01',action:'stop',workspace_id:ids.workspace,template_version_id:ids.version};
 assert.throws(()=>state.prepare('wrong-owner',input,p),{code:'environment-owner-denied'});
 assert.throws(()=>state.prepare(principal,input,{...p,read_only:true,actions:[]}),{code:'environment-read-only'});
 assert.throws(()=>state.prepare(principal,{...input,approved:true},p),{code:'unknown-field'});
 assert.throws(()=>state.prepare(principal,{...input,template_version_id:ids.agent},p),{code:'environment-template-denied'});
 assert.throws(()=>state.prepare(principal,{...input,workspace_id:ids.agent},p),{code:'environment-target-denied'});
 assert.throws(()=>state.prepare(principal,{...input,action:'delete'},p),{code:'environment-action-unsupported'});
 assert.equal(store.db.prepare('SELECT count(*) n FROM environment_requests').get().n,0);
}));

test('D07 confirmation identity/deadline/one consumption, same/different id and target concurrency',()=>fixture(({state,principal,advance})=>{
 state.observe(principal,observation(),'OFFLINE-in-process');const p=policy(),input={request_id:'fixture-request-02',action:'stop',workspace_id:ids.workspace,template_version_id:ids.version};
 const row=state.prepare(principal,input,p);assert.deepEqual(state.prepare(principal,input,p),row);
 assert.throws(()=>state.prepare(principal,{...input,action:'start'},p),{code:'environment-request-conflict'});
 assert.throws(()=>state.prepare(principal,{...input,request_id:'fixture-request-other'},p),{code:'environment-target-busy'});
 const confirm={request_id:row.request_id,parameters_sha256:row.parameters_sha256,phrase:JSON.parse(row.confirmation_json).phrase};
 assert.throws(()=>state.confirm(principal,{...confirm,phrase:'approved'},p),{code:'environment-confirmation-mismatch'});
 assert.throws(()=>state.confirm(principal,confirm,{...p,read_only:true,actions:[]}),{code:'environment-read-only-or-policy-changed'});
 assert.equal(state.confirm(principal,confirm,p).state,'submitting');assert.throws(()=>state.confirm(principal,confirm,p),{code:'environment-confirmation-expired-or-consumed'});
 state.update(principal,row.request_id,{state:'unknown',error_code:'submission-response-lost'});advance(360000);
 assert.throws(()=>state.prepare(principal,{...input,request_id:'fixture-request-late'},p));assert.equal(state.request(principal,row.request_id).state,'unknown');
}));

test('D07 restart does not resubmit accepted/unknown jobs and invalidates pending confirmations',()=>fixture(({store,state,principal})=>{
 const p=policy(),first=state.prepare(principal,{request_id:'fixture-create-01',action:'create',name:'fixture-owned',template_version_id:ids.version},p);
 state.confirm(principal,{request_id:first.request_id,parameters_sha256:first.parameters_sha256,phrase:'CREATE fixture-owned'},p);
 state.update(principal,first.request_id,{state:'accepted',submitted_workspace_id:ids.agent,build_id:ids.workspace});
 const second=new EnvironmentState(store,'restart');second.restart();const saved=second.request(principal,first.request_id);
 assert.equal(saved.state,'unknown');assert.equal(saved.build_id,ids.workspace);assert.equal(saved.error_code,'preview-restarted-no-replay');
 assert.deepEqual(second.prepare(principal,JSON.parse(first.parameters_json),p),saved);
 assert.throws(()=>state.update(principal,first.request_id,{build_id:ids.owner}));
}));

test('D07 temporary stop/same generation preserves dispatch identity; new generation or stale source rejects',()=>fixture(({store,state,principal,advance})=>{
 const spec={key:'fixture-coder',kind:'coder',name:'OFFLINE fixture',provider:'coder-helper',roots:['/workspace'],workspace_id:ids.workspace,agent_id:ids.agent,generation:'fixture-generation-a',policy_version:'fixture-policy',template_version:'fixture-v1'};
 const environment=store.environment(principal,spec),project=store.project(principal,{name:'OFFLINE fixture'}),binding=store.newBinding(principal,{project_id:project.project_id,environment_id:environment.environment_id},'/unused-fixture-anchors');
 state.observe(principal,observation(),'OFFLINE-in-process');assert.equal(state.assertDispatch(binding).identity.generation,binding.instance_generation);
 state.observe(principal,observation({lifecycle:'stopped'}),'OFFLINE-in-process');assert.throws(()=>state.assertDispatch(binding),{code:'environment-suspended'});
 state.observe(principal,observation({build:{id:ids.owner,transition:'start'}}),'OFFLINE-in-process');assert.equal(state.assertDispatch(binding).identity.generation,binding.instance_generation);
 state.observe(principal,observation({identity:{verified:true,generation:'fixture-generation-b'}}),'OFFLINE-in-process');assert.throws(()=>state.assertDispatch(binding),{code:'environment-generation-changed'});
 state.observe(principal,observation(),'OFFLINE-in-process');advance(30001);assert.throws(()=>state.assertDispatch(binding),{code:'environment-observation-stale'});
 assert.equal(store.db.prepare('SELECT count(*) n FROM instance_records').get().n,1);
}));

test('D07 durable submit attempt is consumed once, survives restart, and cannot pass deadline',()=>fixture(({store,state,principal,advance})=>{
 const p=policy(),row=state.prepare(principal,{request_id:'fixture-attempt-01',action:'create',name:'fixture-owned',template_version_id:ids.version},p);
 assert.throws(()=>state.claimAttempt(principal,row.request_id),{code:'environment-request-not-submitting'});
 state.confirm(principal,{request_id:row.request_id,parameters_sha256:row.parameters_sha256,phrase:'CREATE fixture-owned'},p);
 const claimed=state.claimAttempt(principal,row.request_id);assert.ok(claimed.attempted_at);
 assert.throws(()=>state.claimAttempt(principal,row.request_id),{code:'environment-already-attempted'});
 assert.throws(()=>store.db.prepare('UPDATE environment_requests SET attempted_at=NULL WHERE request_id=?').run(row.request_id));
 state.restart();assert.equal(state.request(principal,row.request_id).attempted_at,claimed.attempted_at);assert.equal(state.request(principal,row.request_id).state,'unknown');
 state.observe(principal,observation(),'OFFLINE-in-process');const stop=state.prepare(principal,{request_id:'fixture-attempt-02',action:'stop',workspace_id:ids.workspace,template_version_id:ids.version},p);
 state.confirm(principal,{request_id:stop.request_id,parameters_sha256:stop.parameters_sha256,phrase:'STOP fixture-owned'},p);advance(180001);
 assert.throws(()=>state.claimAttempt(principal,stop.request_id),{code:'environment-request-not-submitting'});assert.equal(state.request(principal,stop.request_id).attempted_at,null);
 assert.deepEqual({...store.db.prepare('SELECT * FROM environment_requests WHERE request_id=?').get(row.request_id)},state.request(principal,row.request_id));
 assert.ok(state.requests(principal).some(item=>item.request_id===row.request_id && item.attempted_at===claimed.attempted_at));
}));

test('D07 start prepare accepts a fresh stopped observation whose agent identity is unavailable',()=>fixture(({state,principal})=>{
 const p=policy();
 const stopped={...observation(),lifecycle:'stopped',identity:{verified:false,generation:'fixture-generation-a'},agent:{id:ids.agent,status:'not-observed'}};
 state.observe(principal,stopped,'OFFLINE-in-process','environment-identity-unavailable');
 const start=state.prepare(principal,{request_id:'fixture-start-stopped-01',action:'start',workspace_id:ids.workspace,template_version_id:ids.version},p);
 assert.equal(start.state,'prepared');assert.equal(start.action,'start');
 assert.throws(()=>state.prepare(principal,{request_id:'fixture-stop-stopped-01',action:'stop',workspace_id:ids.workspace,template_version_id:ids.version},p),{code:'environment-observation-stale'});
}));

test('D07 policies have bounded fixed templates/parameters, no browser-configurable privilege escalation',()=>{
 const p=policy();assert.equal(digest(p),digest(JSON.parse(canonical(p))));
 assert.throws(()=>validateEnvironmentPolicy({...p,transport:'http://untrusted'}));
 assert.throws(()=>validateEnvironmentPolicy({...p,read_only:true}));
 assert.throws(()=>validateEnvironmentPolicy({...p,templates:[{...p.templates[0],parameters:[{name:'api_token',value:'not-allowed'}]}]}));
 assert.throws(()=>validateEnvironmentPolicy({...p,templates:[{...p.templates[0],roots:['/']}]}));
});

async function managerFixture(context,fn) {
 const {store,root,principal}=context,p=policy(),calls=[];let clock=Date.now(),current=observation(),behavior='success',buildId=ids.org;
 const studio={store,root,catalog:[],provider:{channels:new Map(),suspend:(...args)=>calls.push(['suspend',...args]),status:()=>({connected:false})},models:{bindingUnavailable:(...args)=>calls.push(['model',...args])},acp:{channelLost:(...args)=>calls.push(['acp',...args])}};
 let manager;const transport={
  discover:async()=>{if(behavior==='directory-loss') throw new StudioError('offline-directory-loss');return {complete:true,source:'OFFLINE-in-process',server:{version:'FIXTURE'},templates:p.templates,policy_sha256:digest(p),workspaces:[current]};},
  submit:async requestId=>{const row=manager.state.claimAttempt(principal,requestId);calls.push(['POST',row.action,requestId]);if(behavior==='lost-response') throw new StudioError('offline-response-lost');return {outcome:'accepted',workspace_id:ids.workspace,build_id:buildId,ready:false};},
  poll:async requestId=>{const row=manager.state.request(principal,requestId);calls.push(['GET',row.build_id]);current={...current,lifecycle:row.action==='stop'?'stopped':'running',build:{id:row.build_id,transition:row.action==='stop'?'stop':'start'},job:{status:behavior==='build-failed'?'failed':behavior==='pending'?'running':'succeeded'},agent:{id:ids.agent,status:behavior==='agent-wait'?'connecting':'connected'}};return {build:{id:row.build_id,job:current.job},current_build:behavior!=='superseded',workspace:current};},
 };
 manager=new EnvironmentManager(studio,{transport,policy:p,clock:()=>clock});studio.environments=manager;await manager.initialize({schedule:false});
 try {await fn({...context,manager,studio,p,calls,setBehavior:value=>{behavior=value;},setCurrent:value=>{current=value;},advance:ms=>{clock+=ms;},setBuild:value=>{buildId=value;}});} finally {await manager.dispose();}
}
async function confirmed(manager,principal,input) {const row=await manager.prepare(principal,input);const submitting=await manager.confirm(principal,{request_id:row.request_id,parameters_sha256:row.parameters_sha256,phrase:JSON.parse(row.confirmation_json).phrase});assert.equal(submitting.state,'submitting');await manager.pending.get(row.request_id);return manager.state.request(principal,row.request_id);}

test('D07 OFFLINE idle authenticated channels refresh before TTL, but overdue observations still expire during a stalled refresh',()=>fixture(context=>managerFixture(context,async({manager,studio,principal,store,advance})=>{
 await manager.refresh(principal,{});const first=manager.state.latest(principal,ids.workspace);
 const channel={connected:true};studio.provider.channels.set('fixture-idle-channel',channel);
 advance(15001);await manager.tick();const next=manager.state.latest(principal,ids.workspace);assert.notEqual(next.observation_id,first.observation_id);assert.equal(store.db.prepare('SELECT count(*) n FROM operation_records').get().n,0);assert.equal(store.db.prepare('SELECT count(*) n FROM environment_observations').get().n,2);
 manager.ticking=true;advance(30001);await manager.tick();assert.ok(manager.expiredHeads.has(next.observation_id));assert.equal(manager.describe(principal,{}).workspaces[0].stale,true);manager.ticking=false;channel.connected=false;
 await manager.tick();assert.equal(store.db.prepare('SELECT count(*) n FROM environment_observations').get().n,2);
})));

test('D07 OFFLINE dispose stops scheduled refresh and discards an in-flight late response',()=>fixture(context=>managerFixture(context,async({manager,studio,principal,store,advance})=>{
 await manager.refresh(principal,{});const before=manager.state.latest(principal,ids.workspace),result=await manager.transport.discover(),started=Promise.withResolvers(),gate=Promise.withResolvers();let queries=0;
 manager.transport.discover=async()=>{queries++;started.resolve();await gate.promise;return result;};studio.provider.channels.set('fixture-dispose-channel',{connected:true});await manager.initialize({schedule:true});
 const refreshing=manager.refresh(principal,{});await started.promise;const disposed=manager.dispose();gate.resolve();await Promise.all([refreshing,disposed]);advance(60000);await manager.tick();await new Promise(resolve=>setTimeout(resolve,1100));
 assert.equal(queries,1);assert.equal(manager.state.latest(principal,ids.workspace).observation_id,before.observation_id);assert.equal(store.db.prepare('SELECT count(*) n FROM environment_observations').get().n,1);await assert.rejects(manager.refresh(principal,{}),{code:'environment-manager-closed'});
})));

test('D07 OFFLINE manager create/start/stop uses durable attempt -> accepted -> build/agent ready, direct SQL/read/list',()=>fixture(context=>managerFixture(context,async({manager,principal,store,calls,setBehavior})=>{
 await manager.refresh(principal,{});
 let row=await confirmed(manager,principal,{request_id:'manager-create-01',action:'create',name:'fixture-owned',template_version_id:ids.version});assert.equal(row.state,'accepted');assert.ok(row.attempted_at);
 setBehavior('agent-wait');assert.equal((await manager.poll(principal,{request_id:row.request_id})).state,'accepted');setBehavior('success');assert.equal((await manager.poll(principal,{request_id:row.request_id})).state,'succeeded');
 for(const action of ['stop','start']) {row=await confirmed(manager,principal,{request_id:'manager-'+action+'-01',action,workspace_id:ids.workspace,template_version_id:ids.version});assert.equal(row.state,'accepted');row=await manager.poll(principal,{request_id:row.request_id});assert.equal(row.state,'succeeded');}
 assert.deepEqual(calls.filter(call=>call[0]==='POST').map(call=>call[1]),['create','stop','start']);
 assert.deepEqual({...store.db.prepare('SELECT * FROM environment_requests WHERE request_id=?').get(row.request_id)},manager.request(principal,{request_id:row.request_id}));assert.equal(manager.describe(principal,{}).requests.length,3);
 const restart=new EnvironmentState(store,'fixture-restart');restart.restart();assert.equal(restart.requests(principal).length,3);assert.equal(restart.request(principal,row.request_id).state,'succeeded');
})));

test('D07 OFFLINE response loss never resubmits, same target locks persist after restart and unknown is not ready',()=>fixture(context=>managerFixture(context,async({manager,principal,store,setBehavior,calls})=>{
 setBehavior('lost-response');const input={request_id:'manager-lost-01',action:'create',name:'fixture-owned',template_version_id:ids.version};const row=await confirmed(manager,principal,input);assert.equal(row.state,'unknown');assert.ok(row.attempted_at);
 assert.deepEqual(await manager.prepare(principal,input),row);await assert.rejects(()=>manager.prepare(principal,{...input,request_id:'manager-lost-02'}),{code:'environment-target-busy'});
 await assert.rejects(()=>manager.confirm(principal,{request_id:row.request_id,parameters_sha256:row.parameters_sha256,phrase:'CREATE fixture-owned'}));manager.state.restart();await manager.tick();assert.equal(calls.filter(call=>call[0]==='POST').length,1);assert.equal(store.db.prepare('SELECT state FROM environment_requests').get().state,'unknown');
})));

test('D07 OFFLINE build failure, deadline, and state race are distinct; accepted is never reported ready',()=>fixture(context=>managerFixture(context,async({manager,principal,setBehavior,advance})=>{
 let row=await confirmed(manager,principal,{request_id:'manager-failure-01',action:'create',name:'fixture-owned',template_version_id:ids.version});setBehavior('build-failed');row=await manager.poll(principal,{request_id:row.request_id});assert.equal(row.state,'failed');assert.equal(row.error_code,'environment-build-failed');
 setBehavior('pending');row=await confirmed(manager,principal,{request_id:'manager-timeout-01',action:'create',name:'fixture-owned',template_version_id:ids.version});assert.equal((await manager.poll(principal,{request_id:row.request_id})).state,'accepted');advance(180001);assert.equal((await manager.poll(principal,{request_id:row.request_id})).state,'timed-out');
 await assert.rejects(()=>manager.prepare(principal,{request_id:'manager-timeout-02',action:'create',name:'fixture-owned',template_version_id:ids.version}),{code:'environment-target-busy'});
})));

test('D07 OFFLINE directory loss and same/new generation cascade across model, ACP and tasks without erasing identity',()=>fixture(context=>managerFixture(context,async({manager,studio,principal,store,calls,setCurrent,setBehavior,advance})=>{
 const marker={root:'/workspace',imageId:'sha256:'+'a'.repeat(64),uid:1000,policyVersion:'fixture-policy'};
 const live=observation({identity:{verified:true,generation:'fixture-generation-a',record:{marker}}});setCurrent(live);
 const spec={key:'fixture-coder',kind:'coder',name:'OFFLINE fixture',provider:'coder-helper',roots:['/workspace'],workspace_id:ids.workspace,agent_id:ids.agent,generation:'fixture-generation-a',policy_version:'fixture-policy',template_version:'fixture-v1',expected:{templateVersionId:ids.version,marker}};studio.catalog.push(spec);
 const env=store.environment(principal,spec),project=store.project(principal,{name:'Fixture project'}),binding=store.newBinding(principal,{project_id:project.project_id,environment_id:env.environment_id},'/fixture-only');store.db.prepare("UPDATE project_bindings SET state='ready' WHERE binding_id=?").run(binding.binding_id);binding.state='ready';
 const session=store.newSession(principal,binding,'Fixture session');store.db.prepare("UPDATE session_bindings SET state='ready' WHERE session_id=?").run(session.session_id);
 await manager.refresh(principal,{});const operation=store.beginOperation(principal,session,'command.exec',{operation_id:'fixture-task-original-01'});store.updateOperation(principal,operation.operation_id,{state:'running',channel_id:'original-channel',helper_session_id:'original-helper-session',remote_process_id:'original-process',remote_pid:777});
 setCurrent({...live,lifecycle:'stopped'});await manager.refresh(principal,{});assert.throws(()=>manager.assertCached(binding),{code:'environment-suspended'});assert.equal(store.binding(principal,binding.binding_id,1).state,'ready');
 assert.equal(store.operation(principal,operation.operation_id).state,'unknown');assert.equal(store.operation(principal,operation.operation_id).remote_process_id,'original-process');assert.ok(calls.some(call=>call[0]==='model'));assert.ok(calls.some(call=>call[0]==='acp'));
 setCurrent({...live,build:{id:ids.owner,transition:'start'}});await manager.refresh(principal,{});manager.assertCached(binding);
 advance(30001);await manager.tick();assert.equal(store.binding(principal,binding.binding_id,1).state,'ready');assert.throws(()=>manager.assertCached(binding),{code:'environment-observation-stale'});await manager.refresh(principal,{});manager.assertCached(binding);
 advance(15001);setBehavior('directory-loss');await assert.rejects(manager.admit(binding));assert.equal(manager.describe(principal,{}).workspaces[0].error_code,'offline-directory-loss');assert.throws(()=>manager.assertCached(binding));assert.equal(store.db.prepare('SELECT count(*) n FROM operation_records').get().n,1);
 setBehavior('success');await manager.refresh(principal,{});
 const otherProject=store.project(principal,{name:'Second same-workspace binding'}),other=store.newBinding(principal,{project_id:otherProject.project_id,environment_id:env.environment_id},'/fixture-only-b');store.db.prepare("UPDATE project_bindings SET state='ready' WHERE binding_id=?").run(other.binding_id);other.state='ready';
 const originalDiscover=manager.transport.discover,captured=await originalDiscover(),started=Promise.withResolvers(),gate=Promise.withResolvers();let queries=0;
 manager.transport.discover=async()=>{queries++;started.resolve();await gate.promise;return captured;};advance(15001);
 const pending=Promise.allSettled([manager.admit(binding),manager.admit(other)]);await started.promise;assert.equal(queries,1);
 const newer=manager.ingest({...live,identity:{...live.identity,generation:'fixture-generation-b'}},'OFFLINE newer generation');const invalidations=calls.length;gate.resolve();const outcomes=await pending;manager.transport.discover=originalDiscover;
 assert.ok(outcomes.every(outcome=>outcome.status==='rejected'));assert.equal(manager.state.latest(principal,ids.workspace).observation_id,newer.observation_id);assert.equal(calls.length,invalidations);assert.equal(store.db.prepare("SELECT count(*) n FROM audit_events WHERE action='environment.observation-discarded'").get().n,1);
 assert.equal(store.binding(principal,binding.binding_id,1).state,'invalid');assert.equal(store.binding(principal,other.binding_id,1).state,'invalid');assert.equal(store.operation(principal,operation.operation_id).remote_process_id,'original-process');
 assert.equal(store.db.prepare('SELECT count(*) n FROM instance_records').get().n,1);
 assert.throws(()=>manager.assertCached(binding),{code:'environment-binding-revoked'});
 const selected=manager.state.latest(principal,ids.workspace);manager.registerObservation(principal,selected,env.environment_id);
 const next=store.newBinding(principal,{project_id:project.project_id,environment_id:env.environment_id,binding_id:binding.binding_id,expected_version:binding.version},'/fixture-only');
 assert.equal(next.version,2);assert.equal(next.instance_generation,'fixture-generation-b');assert.notEqual(next.record_id,binding.record_id);assert.notEqual(next.anchor_path,binding.anchor_path);assert.equal(store.db.prepare('SELECT count(*) n FROM instance_records').get().n,2);assert.equal(store.binding(principal,binding.binding_id,1).instance_generation,'fixture-generation-a');
 assert.equal(manager.effectiveSpec(next,spec).generation,'fixture-generation-b');assert.equal(store.operation(principal,operation.operation_id).remote_process_id,'original-process');
})));
