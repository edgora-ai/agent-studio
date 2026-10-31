import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Store,StudioError,requireThat} from '../../packages/dsh-agent-studio/store.mjs';
import {TaskRecovery,RecoveryVault} from '../../packages/dsh-agent-studio/task-recovery.mjs';
import {BoundProvider} from '../../packages/dsh-agent-studio/adapters/bound-provider.mjs';
import {localProcessIdentity} from '../../packages/dsh-agent-studio/adapters/local-provider.mjs';

// Transport-only controlled fixture. Any business start/open during recovery is
// an error, not a successful mock. The product state/manager/task methods run.
async function fixture(run,{local=false,complete=true}={}) {
 const root=await mkdtemp(join(tmpdir(),'agent-studio-test-d08-unit-')),store=new Store(root),p=store.principal;
 const spec={key:'d08-offline',kind:local?'local':'coder',provider:local?'local-managed':'coder-helper',name:'OFFLINE recovery fixture',roots:[root],generation:'generation-original',policy_version:'fixture-v1',workspace_id:'platform-workspace',agent_id:'platform-agent',template_version:'fixture'};
 const env=store.environment(p,spec),project=store.project(p,{name:'OFFLINE D08 中文'}),binding=store.newBinding(p,{project_id:project.project_id,environment_id:env.environment_id},join(root,'anchors'));
 store.db.prepare("UPDATE project_bindings SET state='ready' WHERE binding_id=?").run(binding.binding_id);
 const session=store.newSession(p,binding,'Original session');store.db.prepare("UPDATE session_bindings SET state='ready' WHERE session_id=?").run(session.session_id);
 const studio={store,root,catalog:[spec],session(principal,id){const row=store.get('session_bindings','session_id',id,principal);requireThat(row.state==='ready','session-not-ready');return row;},async resolve(principal,input){const s=this.session(principal,input.session_id),b=store.binding(principal,s.binding_id,s.version);requireThat(b.state==='ready','binding-not-ready');return {session:s,binding:b,environment:env,spec};}};
 studio.provider=new BoundProvider(studio);let clock=10000,running=true,release=false,openCount=0,observedChanges={},resumeChanges={},statusChanges={},closeCount=0;const calls=[];
 const token='fixture-'+randomUUID(),clientId=randomUUID(),helperSession=randomUUID(),epoch=randomUUID(),workspace=randomUUID(),processId=randomUUID();
 const processIdentity={exists:true,pid:24680,start_ticks:'912345',pgid:24680,sid:24680,uid:1000,cwd:binding.target_root,state:'S'};
 const makeChannel=(channelId,resumed)=>{
  const listeners=[];const channel={binding,connected:true,proof:{channel_id:channelId,agent_id:spec.agent_id},workspaceId:workspace,processes:new Set(),child:{exitCode:null,signalCode:null},client:{sessionId:resumeChanges.sessionId??helperSession,session:{clientId,sessionId:helperSession,serverEpoch:epoch,resumeToken:token,retentionMs:30000,resumed,...resumeChanges},capabilities:{session:{resume:true}},hello:{helperVersion:'0.13.1'},onClose(fn){listeners.push(fn);},async call(method,params){calls.push({method,params});requireThat(!['process/start','workspace/open','session/close'].includes(method),'fixture-forbidden-business-replay');assert.equal(params.workspaceId,workspace);const owned=store.db.prepare('SELECT remote_pid FROM operation_records WHERE remote_process_id=? AND principal_id=? AND binding_id=?').get(params.processId,p,binding.binding_id);assert(owned);
   if(method==='process/status')return {processId:params.processId,pid:owned.remote_pid,pgid:owned.remote_pid,running,exitCode:running?null:0,signal:null,latestSeq:'3',...statusChanges};
   if(method==='process/read')return {chunks:[{seq:'3',stream:'stdout',data:Buffer.from('original-output-中文').toString('base64')}],earliestSeq:'3',nextSeq:'3',truncated:params.afterSeq==='0',exited:!running,exitCode:running?null:0,signal:null};
   if(method==='process/terminate'){running=false;return {terminated:true};}
   if(method==='process/release'){assert.equal(running,false);release=true;return {released:true};}
   throw new StudioError('fixture-unexpected-method');
  }},listeners};return channel;
 };
 const original=makeChannel('original-channel',false);studio.provider.channels.set(studio.provider.key(binding),original);
 const recovery=studio.recovery=new TaskRecovery(studio,{clock:()=>clock,open:async(_root,b,options)=>{openCount++;assert.equal(options.install,false);assert.equal(options.resume.clientId,clientId);assert.equal(options.resume.token,token);return makeChannel('resumed-channel-'+openCount,true);},close:async channel=>{closeCount++;channel.connected=false;channel.child.exitCode=0;},current:async()=>({agent_id:spec.agent_id,generation:spec.generation}),observe:async(_b,id)=>({operation_id:id,request_sha256:store.operation(p,id).request_sha256,process:{...processIdentity,pid:store.operation(p,id).remote_pid,pgid:store.operation(p,id).remote_pid,...observedChanges}})});
 studio.check=async(principal,input)=>{const ctx=await studio.resolve(principal,input);requireThat(original.connected,'channel-disconnected');return ctx;};
 const operation_id=randomUUID(),input={session_id:session.session_id,operation_id,argv:['synthetic-no-exec']},base=store.beginOperation(p,session,'command.exec',input);
 let localIdentity;
 if(local){localIdentity=await localProcessIdentity(process.pid);store.updateOperation(p,operation_id,{execution_kind:'local',local_runtime_id:studio.provider.local.runtimeId,local_process_id:randomUUID(),local_pid:process.pid,local_start_ticks:localIdentity.start_ticks,state:'running'});studio.provider.local.tasks.set(operation_id,{handle:{fixture:'memory-only-no-signal'},session_id:session.session_id,binding_id:binding.binding_id,version:binding.version,pid:process.pid,startTicks:localIdentity.start_ticks,exited:false});}
 else store.updateOperation(p,operation_id,{channel_id:original.proof.channel_id,helper_session_id:helperSession,remote_process_id:processId,remote_pid:processIdentity.pid,state:'running'});
 original.processes.add(operation_id);
 await recovery.capture({...await studio.resolve(p,input),channel:original},{operation_id},{deadline:clock+60000,recoverable:complete});
 const task={session_id:session.session_id,operation_id},request=()=>({...task,recovery_id:randomUUID()});
 const addTask=async()=>{const next={session_id:session.session_id,operation_id:randomUUID()};store.beginOperation(p,session,'command.exec',{...next,argv:['synthetic-second-identity-no-exec']});store.updateOperation(p,next.operation_id,{channel_id:original.proof.channel_id,helper_session_id:helperSession,remote_process_id:randomUUID(),remote_pid:processIdentity.pid+1,state:'running'});original.processes.add(next.operation_id);await recovery.capture({...await studio.resolve(p,next),channel:original},next,{deadline:clock+60000});return next;};
 const helpers={root,store,p,studio,recovery,binding,session,task,original,request,calls,processIdentity,addTask,advance:ms=>clock+=ms,setObserved:value=>observedChanges=value,setResume:value=>resumeChanges=value,setStatus:value=>statusChanges=value,finish:()=>running=false,counts:()=>({openCount,closeCount,release}),lose:()=>{original.connected=false;recovery.markLost(operation_id,'fixture-transport-lost');}};
 try{await run(helpers);}finally{await recovery.dispose();store.close();}
}

test('D08 immutable startup snapshot -> independent SQL -> full get/list; protected token never enters records',()=>fixture(async({root,store,p,recovery,task,studio})=>{
 const read=new DatabaseSync(store.path,{readOnly:true}),full=recovery.get(p,task),raw={...read.prepare('SELECT * FROM task_recovery_snapshots WHERE operation_id=?').get(task.operation_id)};
 assert.equal(read.prepare('PRAGMA user_version').get().user_version,8);assert.deepEqual(full.snapshot,raw);assert.deepEqual(recovery.list(p,{session_id:task.session_id}).find(row=>row.operation.operation_id===task.operation_id),full);
 const token=(await new RecoveryVault(root).load()).references[raw.token_ref];assert.equal((await stat(join(root,'recovery-secrets.json'))).mode&0o777,0o600);assert(!JSON.stringify(full).includes(token));assert(!JSON.stringify(read.prepare('SELECT * FROM audit_events').all()).includes(token));
 assert.throws(()=>store.db.prepare('UPDATE task_recovery_snapshots SET identity_json=? WHERE operation_id=?').run('{}',task.operation_id),/immutable/);assert.throws(()=>store.updateOperation(p,task.operation_id,{remote_pid:1}),/immutable/);read.close();
}));

test('D08 same helper session/process explicit recovery reads original cursor, cancels and releases without business replay',()=>fixture(async({store,p,recovery,studio,task,request,lose,calls,counts})=>{
 const original=store.operation(p,task.operation_id);lose();const loss=recovery.state.row(task.operation_id);const result=await recovery.recover(p,request());
 assert.equal(result.state.state,'recovered');assert.equal(result.operation.channel_id,original.channel_id);assert.equal(result.operation.remote_pid,original.remote_pid);assert.equal(result.operation.error_code,'fixture-transport-lost');assert.equal(result.state.recovery_deadline_ms,loss.recovery_deadline_ms);
 const page=await studio.provider.task(p,'read',{...task,after_seq:'0'});assert.equal(Buffer.from(page.chunks[0].data,'base64').toString(),'original-output-中文');assert.equal(page.truncated,true);assert.equal(recovery.state.row(task.operation_id).output_gap,1);
 const cancelled=await studio.provider.task(p,'cancel',{...task,action_id:randomUUID()});assert.equal(cancelled.running,false);await studio.provider.task(p,'release',{...task,action_id:randomUUID()});assert.equal(counts().release,true);assert.equal(recovery.get(p,task).state.state,'released');
 assert(!calls.some(call=>['process/start','workspace/open','process/write'].includes(call.method)));
 const ro=new DatabaseSync(store.path,{readOnly:true}),get=recovery.get(p,task);for(const [table,key] of [['task_recovery_requests','requests'],['task_recovery_events','events']])assert.deepEqual(ro.prepare(`SELECT * FROM ${table} WHERE operation_id=? ORDER BY created_at,rowid`).all(task.operation_id).map(row=>({...row})),get[key]);ro.close();
}));

test('D08 missing identity and historical row cannot be adopted from a current PID',()=>fixture(async({store,p,recovery,task,session})=>{
 const row=store.beginOperation(p,session,'command.exec',{operation_id:randomUUID(),argv:['old']});store.updateOperation(p,row.operation_id,{state:'unknown'});
 await assert.rejects(recovery.recover(p,{session_id:session.session_id,operation_id:row.operation_id,recovery_id:randomUUID()}),{code:'recovery-identity-incomplete'});assert.deepEqual(store.operation(p,row.operation_id).state,'unknown');
}));

test('D08 incomplete new task identity refuses recovery',()=>fixture(async({p,recovery,request,lose,counts})=>{lose();await assert.rejects(recovery.recover(p,request()),{code:'recovery-identity-incomplete'});assert.equal(counts().openCount,0);},{complete:false}));

test('D08 foreign principal and cross-session request refuse before transport',()=>fixture(async({p,recovery,request,lose,counts})=>{lose();await assert.rejects(recovery.recover('foreign-owner',request()),{code:'operation-not-found'});await assert.rejects(recovery.recover(p,{...request(),session_id:'foreign-session'}),{code:'task-not-owned'});assert.equal(counts().openCount,0);}));

test('D08 first loss deadline never extends on a failed attempt or repeated loss',()=>fixture(async({p,recovery,task,request,lose,advance,setResume,counts})=>{lose();const first=recovery.state.row(task.operation_id);setResume({resumed:false});await assert.rejects(recovery.recover(p,request()),{code:'recovery-helper-session-mismatch'});advance(5000);lose();assert.equal(recovery.state.row(task.operation_id).recovery_deadline_ms,first.recovery_deadline_ms);advance(25000);await assert.rejects(recovery.recover(p,request()),{code:'recovery-window-expired'});assert.equal(counts().openCount,1);}));

for(const [name,changes] of [['session',{sessionId:'different-session'}],['epoch',{serverEpoch:'different-epoch'}],['client',{clientId:'different-client'}],['retention',{retentionMs:1000}]])test('D08 mismatched helper '+name+' is rejected without state restoration',()=>fixture(async({p,recovery,task,request,lose,setResume})=>{lose();setResume(changes);await assert.rejects(recovery.recover(p,request()),{code:'recovery-helper-session-mismatch'});assert.equal(recovery.get(p,task).operation.state,'unknown');}));

for(const [name,changes] of [['PID',{pid:999}],['start tick',{start_ticks:'999'}],['PGID',{pgid:999}],['UID',{uid:0}],['SID',{sid:999}],['cwd',{cwd:'/outside'}]])test('D08 mismatched original process '+name+' refuses current PID adoption',()=>fixture(async({p,recovery,task,request,lose,setObserved})=>{lose();setObserved(changes);await assert.rejects(recovery.recover(p,request()),{code:'recovery-process-mismatch'});assert.equal(recovery.get(p,task).operation.state,'unknown');}));

test('D08 ended original process is observed as completed, never started again',()=>fixture(async({p,recovery,task,request,lose,finish,calls})=>{lose();finish();const result=await recovery.recover(p,request());assert.equal(result.operation.state,'completed');assert.equal(result.requests[0].state,'verified');assert(!calls.some(row=>row.method==='process/start'));}));

test('D08 unknown original result rejects rather than inventing completion',()=>fixture(async({p,recovery,task,request,lose,finish,setStatus})=>{lose();finish();setStatus({exitCode:null,signal:null});await assert.rejects(recovery.recover(p,request()),{code:'recovery-outcome-unknown'});assert.equal(recovery.get(p,task).operation.state,'unknown');}));

test('D08 same-operation concurrency is refused; late response cannot undo generation revocation',()=>fixture(async({p,recovery,task,request,lose,binding,store})=>{
 lose();const gate=Promise.withResolvers(),entered=Promise.withResolvers(),real=recovery.observe;recovery.observe=async(...args)=>{entered.resolve();await gate.promise;return real(...args);};const first=recovery.recover(p,request());await entered.promise;
 await assert.rejects(recovery.recover(p,request()),{code:'recovery-in-progress'});store.failBinding(binding,'fixture-generation-changed');recovery.revoke(binding,'fixture-generation-changed');gate.resolve();await assert.rejects(first);assert.equal(recovery.state.row(task.operation_id).state,'revoked');assert.equal(store.operation(p,task.operation_id).state,'unknown');
}));

test('D08 two original tasks sharing one helper session serialize recovery and reuse one verified transport',()=>fixture(async({p,recovery,task,request,original,addTask,counts})=>{
 const second=await addTask();original.connected=false;recovery.channelLost(original,'fixture-shared-session-lost');
 const gate=Promise.withResolvers(),entered=Promise.withResolvers(),observe=recovery.observe;let observations=0;
 recovery.observe=async(...args)=>{observations++;if(observations===1){entered.resolve();await gate.promise;}return observe(...args);};
 const first=recovery.recover(p,request());await entered.promise;const another=recovery.recover(p,{...second,recovery_id:randomUUID()});await Promise.resolve();assert.equal(observations,1);gate.resolve();
 const results=await Promise.all([first,another]);assert(results.every(value=>value.state.state==='recovered'));assert.equal(counts().openCount,1);assert.equal(results[0].state.current_transport_id,results[1].state.current_transport_id);
}));

test('D08 response after fixed deadline cannot commit recovery',()=>fixture(async({p,recovery,task,request,lose,advance})=>{lose();const real=recovery.observe;recovery.observe=async(...args)=>{const value=await real(...args);advance(30001);return value;};await assert.rejects(recovery.recover(p,request()),{code:'recovery-window-expired'});assert.equal(recovery.get(p,task).operation.state,'unknown');}));

test('D08 local same Host only reclaims its retained runtime handle',()=>fixture(async({p,recovery,task,request,studio})=>{await recovery.detach(p,task);const result=await recovery.recover(p,request());assert.equal(result.state.state,'recovered');assert.equal(result.operation.local_pid,process.pid);assert.equal(result.operation.channel_id,null);assert.equal(studio.provider.local.tasks.get(task.operation_id).handle.fixture,'memory-only-no-signal');},{local:true}));

test('D08 local missing stdio handle and Host restart refuse PID-only adoption',()=>fixture(async({p,recovery,task,request,studio})=>{await recovery.detach(p,task);studio.provider.local.tasks.delete(task.operation_id);await assert.rejects(recovery.recover(p,request()),{code:'recovery-host-handle-unavailable'});recovery.state.runId='different-host-run';await assert.rejects(recovery.recover(p,request()),{code:'recovery-host-handle-unavailable'});},{local:true}));

test('D08 corrupt secret vault errors never quote stored secret bytes',async()=>{const root=await mkdtemp(join(tmpdir(),'agent-studio-test-d08-vault-'));const marker='PRIVATE_SYNTHETIC_VAULT_BYTES';await writeFile(join(root,'recovery-secrets.json'),'{"'+marker+'"',{mode:0o600});await assert.rejects(new RecoveryVault(root).load(),error=>error.code==='recovery-vault-unavailable'&&!error.message.includes(marker));});
