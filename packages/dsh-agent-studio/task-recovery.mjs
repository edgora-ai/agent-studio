import {readFile,writeFile,rename,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {RecoveryState,hash} from './recovery-state.mjs';
import {requireThat,StudioError,fields,now} from './store.mjs';
import {openChannel,closeChannel,checkCurrent,observeTask,transportCode} from './adapters/helper-channel.mjs';
import {localProcessIdentity} from './adapters/local-provider.mjs';

export class RecoveryVault {
 constructor(root) {this.file=join(root,'recovery-secrets.json');this.queue=Promise.resolve();}
 async load() {
  try {const stat=await lstat(this.file);requireThat(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0&&stat.size<1048576,'recovery-vault-permissions');
   const value=JSON.parse(await readFile(this.file,'utf8'));requireThat(value.version===1&&value.references&&typeof value.references==='object','recovery-vault-format');return value;
  }catch(error){if(error.code==='ENOENT')return {version:1,references:{}};throw new StudioError(error instanceof StudioError?error.code:'recovery-vault-unavailable');}
 }
 async put(token) {
  requireThat(typeof token==='string'&&token.length>=16&&token.length<=2048&&!/[\u0000-\u001f]/.test(token),'recovery-token-invalid');
  const work=this.queue.then(async()=>{const value=await this.load(),ref='resume-'+randomUUID(),temp=this.file+'.'+randomUUID()+'.tmp';value.references[ref]=token;
   await writeFile(temp,JSON.stringify(value),{flag:'wx',mode:0o600});await rename(temp,this.file);requireThat((await this.load()).references[ref]===token,'recovery-vault-write-unconfirmed');return ref;});
  this.queue=work.then(()=>undefined,()=>undefined);return work;
 }
 async get(ref) {requireThat(/^resume-[0-9a-f-]{36}$/.test(ref??''),'recovery-token-reference');const token=(await this.load()).references[ref];requireThat(typeof token==='string'&&token.length>=16,'recovery-token-unavailable');return token;}
}
const sameProcess=(expected,actual)=>['pid','start_ticks','pgid','sid','uid','cwd'].every(key=>actual?.[key]===expected?.[key]);
export class TaskRecovery {
 constructor(studio,{clock=Date.now,windowMs=30000,open=openChannel,close=closeChannel,current=checkCurrent,observe=observeTask,vault=new RecoveryVault(studio.root)}={}) {
  this.studio=studio;this.store=studio.store;this.clock=clock;this.state=new RecoveryState(this.store,process.env.AGENT_STUDIO_RUN_ID??studio.provider.local.runtimeId,{clock,windowMs});
  this.open=open;this.close=close;this.current=current;this.observe=observe;this.vault=vault;this.transports=new Map();this.sessions=new Map();this.locks=new Map();this.deadlines=new Map();this.closed=false;
 }
 diagnostic(binding,details) {
  // Bounded metadata only: no params, output, raw stderr, RPC tokens or project bytes.
  this.traceCounts??=new Map();const key=details.channel_id??`${binding.binding_id}@${binding.version}`,count=this.traceCounts.get(key)??0;
  if(this.closed||count>=256) return;this.traceCounts.set(key,count+1);
  this.store.audit(binding.principal_id,'transport.diagnostic',key,details.error_code?'failed':'observed',details);
 }
 async preflight(principal,input) {
  fields(input,['session_id'],['session_id']);const {binding,environment}=await this.studio.resolve(principal,input);
  requireThat(environment.provider==='coder-helper','remote-unverified');const diagnostic=data=>this.diagnostic(binding,data);
  const current=await this.current(binding,{onDiagnostic:diagnostic});let channel;
  try {channel=await this.open(this.studio.root,binding,{install:false,onDiagnostic:diagnostic});
   requireThat(channel.proof.agent_id===current.agent_id&&channel.client.capabilities.session?.resume===true,'recovery-unsupported');
   return {current,channel_id:channel.proof.channel_id,helper_version:channel.client.hello.helperVersion,helper_session_id:channel.client.sessionId,server_epoch:channel.client.session.serverEpoch,retention_ms:channel.client.session.retentionMs,resume_supported:true,processes_started:0,workspace_opened:false};
  }finally{if(channel){try{await channel.client.call('session/close',{}, {timeoutMs:5000,mutation:true});}finally{await this.close(channel);}}}
 }
 async capture(context,result,{deadline,recoverable=true}={}) {
  const row=this.store.operation(context.session.principal_id,result.operation_id),binding=context.binding;
  const end=deadline??this.clock()+600000;requireThat(Number.isSafeInteger(end)&&end<=this.clock()+600000,'task-deadline-policy');
  const local=row.execution_kind==='local',channel=context.channel;
  const identity={operation_id:row.operation_id,request_sha256:row.request_sha256,principal_id:row.principal_id,session_id:row.session_id,binding_id:row.binding_id,version:row.version,instance_generation:binding.instance_generation,record_id:binding.record_id,target_root:binding.target_root,policy_version:binding.policy_version,execution_kind:local?'local':'remote',start_result:result,operator_policy_sha256:this.studio.environments?.currentPolicy?hash(this.studio.environments.currentPolicy):null,...(local?{runtime_id:row.local_runtime_id,process_id:row.local_process_id,pid:row.local_pid}:{channel_id:row.channel_id,helper_session_id:row.helper_session_id,process_id:row.remote_process_id,pid:row.remote_pid,client_id:channel?.client.session?.clientId,server_epoch:channel?.client.session?.serverEpoch,workspace_id:channel?.workspaceId,platform_agent_id:channel?.proof.agent_id})};
  let complete=false,reason='task-not-retained',tokenRef=null,retention=local?this.state.windowMs:channel?.client.session?.retentionMs??0;
  try {
   if(recoverable) {
    if(local){const proc=await localProcessIdentity(row.local_pid);requireThat(proc&&proc.start_ticks===row.local_start_ticks,'recovery-process-mismatch');identity.process=proc;complete=Boolean(this.studio.provider.local.tasks.get(row.operation_id)?.handle);requireThat(complete,'recovery-host-handle-unavailable');}
    else {
     requireThat(channel.client.capabilities.session?.resume===true&&retention>=this.state.windowMs&&channel.client.session?.clientId&&channel.client.session?.serverEpoch!==undefined,'recovery-unsupported');
     const status=await this.studio.provider.call(channel,'process/status',{workspaceId:channel.workspaceId,processId:row.remote_process_id});
     requireThat(status.processId===row.remote_process_id&&status.pid===row.remote_pid&&status.running===true,'recovery-startup-process-ended');
     const observed=await this.observe(binding,row.operation_id,{onDiagnostic:data=>this.diagnostic(binding,data)});
     requireThat(observed.operation_id===row.operation_id&&observed.request_sha256===row.request_sha256&&observed.process?.exists&&observed.process.pid===row.remote_pid&&observed.process.pgid===status.pgid&&/^\d+$/.test(observed.process.start_ticks),'recovery-process-mismatch');
     requireThat(channel.connected&&this.store.operation(row.principal_id,row.operation_id).state==='running','recovery-startup-interrupted');
     identity.process=observed.process;identity.start_status=status;
     channel.tokenRef??=await this.vault.put(channel.client.session.resumeToken);tokenRef=channel.tokenRef;complete=true;
    }
    reason=null;
   }
  }catch(error){reason=transportCode(error);complete=false;}
  const snapshot=this.state.capture(row,{identity,complete,reason,tokenRef,deadline:end,retention});
  if(complete) {const timer=setTimeout(()=>{this.deadlines.delete(row.operation_id);void this.expireTask(row);},Math.max(1,end-this.clock()));timer.unref();this.deadlines.set(row.operation_id,timer);}
  return snapshot;
 }
 async expireTask(row) {
  if(this.closed||['completed','cancelled','released'].includes(this.store.operation(row.principal_id,row.operation_id).state))return;
  try{await this.studio.provider.task(row.principal_id,'cancel',{session_id:row.session_id,operation_id:row.operation_id,action_id:randomUUID()});this.state.event(row.operation_id,'deadline-cancelled',{});}
  catch(error){this.markLost(row.operation_id,'task-deadline-cleanup-unconfirmed');this.state.event(row.operation_id,'deadline-cleanup-unconfirmed',{code:transportCode(error)});}
 }
 markLost(operationId,reason) {
  this.state.lose(operationId,reason);
  const row=this.state.snapshot(operationId);if(row)this.store.db.prepare("UPDATE operation_records SET state='unknown',error_code=?,updated_at=? WHERE operation_id=? AND state IN ('pending','running')").run(reason,now(),operationId);
 }
 channelLost(channel,reason) {
  for(const row of this.store.db.prepare('SELECT s.operation_id FROM task_recovery_snapshots s JOIN task_recovery_state t USING(operation_id) WHERE t.current_transport_id=?').all(channel.proof.channel_id)) this.markLost(row.operation_id,reason);
 }
 revoke(binding,reason) {this.state.revoke(binding,reason);}
 get(principal,input) {fields(input,['session_id','operation_id'],['session_id','operation_id']);this.studio.session(principal,input.session_id);return this.state.get(principal,input);}
 list(principal,input) {fields(input,['session_id'],['session_id']);this.studio.session(principal,input.session_id);return this.store.operations(principal,input.session_id).filter(row=>['pty.open','command.exec'].includes(row.kind)).map(row=>this.state.get(principal,{session_id:input.session_id,operation_id:row.operation_id}));}
 async context(principal,input,original) {
  const context=await this.studio.resolve(principal,{session_id:input.session_id}),b=context.binding,i=original.identity;
  requireThat(!this.closed&&b.binding_id===i.binding_id&&b.version===i.version&&b.record_id===i.record_id&&b.instance_generation===i.instance_generation&&b.target_root===i.target_root&&b.policy_version===i.policy_version,'recovery-binding-changed');
  const manager=this.studio.environments;
  manager?.assertCached(b);
  if(manager?.managed(b))requireThat(hash(await manager.policy())===i.operator_policy_sha256&&hash(manager.currentPolicy)===i.operator_policy_sha256,'recovery-policy-changed');
  return context;
 }
 async serialized(key,work) {const previous=this.locks.get(key)??Promise.resolve(),current=previous.then(work,work);this.locks.set(key,current);try{return await current;}finally{if(this.locks.get(key)===current)this.locks.delete(key);}}
 async detach(principal,input) {
  fields(input,['session_id','operation_id'],['session_id','operation_id']);const value=this.state.owned(principal,input);requireThat(value.snapshot.complete===1&&value.snapshot.host_run_id===this.state.runId,'recovery-identity-incomplete');
  const context=await this.context(principal,input,value);
  requireThat(['live','recovered'].includes(value.state.state),'recovery-not-live');
  if(value.identity.execution_kind==='local'){requireThat(this.studio.provider.local.tasks.has(input.operation_id),'recovery-host-handle-unavailable');this.markLost(input.operation_id,'explicit-local-handle-detach');return this.get(principal,input);}
  const channel=this.channelFor(value)??this.studio.provider.channels.get(this.studio.provider.key(context.binding));
  requireThat(channel?.connected&&channel.processes?.size===1&&channel.processes.has(input.operation_id),'detach-requires-single-owned-task');
  this.markLost(input.operation_id,'explicit-transport-detach');channel.detachForRecovery=true;channel.connected=false;
  await this.close(channel);this.state.event(input.operation_id,'owned-transport-detached',{transport_id:channel.proof.channel_id,session_closed:false});return this.get(principal,input);
 }
 channelFor(value) {return value.state.current_recovery_id?this.transports.get(value.state.current_transport_id):null;}
 async recover(principal,input) {
  const saved=this.state.begin(principal,input),key=saved.identity.helper_session_id??saved.identity.runtime_id;
  return this.serialized(key,async()=>{
   let channel,newTransport=false;
   try {
    this.state.assertCurrent(principal,input,saved);const context=await this.context(principal,input,saved);
    let status,transportId;
    if(saved.identity.execution_kind==='local') {
     const local=this.studio.provider.local,task=local.tasks.get(input.operation_id);
     requireThat(local.runtimeId===saved.identity.runtime_id&&task?.handle&&task.session_id===input.session_id&&!task.error,'recovery-host-handle-unavailable');
     const identity=await localProcessIdentity(saved.identity.pid);
     requireThat(task.exited || identity?.start_ticks===saved.identity.process.start_ticks&&identity?.pgrp===saved.identity.process.pgrp&&identity?.session===saved.identity.process.session&&identity?.uid===saved.identity.process.uid&&identity?.cwd===saved.identity.process.cwd,'recovery-process-mismatch');
     status={running:!task.exited,pid:task.pid,start_ticks:task.startTicks,exitCode:task.exitCode??null,signal:task.signal??null};transportId=local.runtimeId;
    } else {
     const options=()=>({timeoutMs:Math.max(1,Math.min(15000,saved.state.recovery_deadline_ms-this.clock())),onDiagnostic:data=>this.diagnostic(context.binding,data)});
     const current=await this.current(context.binding,options());this.state.assertCurrent(principal,input,saved);
     requireThat(current.agent_id===saved.identity.platform_agent_id,'recovery-platform-agent-changed');
     channel=this.sessions.get(key);
     if(!channel?.connected||channel.client.closeReason!==undefined) {
      const original=[...this.studio.provider.channels.values(),...this.studio.provider.retiredChannels,...this.transports.values()].find(item=>item.proof.channel_id===saved.state.current_transport_id);
      requireThat(original,'recovery-host-handle-unavailable');
      // A failed current check can leave SSH alive. Detach exactly that owned
      // transport before resume; never session/close or a replacement workspace.
      if(original.child.exitCode===null&&original.child.signalCode===null){original.detachForRecovery=true;await this.close(original);}
      this.state.assertCurrent(principal,input,saved);
      const token=await this.vault.get(saved.snapshot.token_ref);
      channel=await this.open(this.studio.root,context.binding,{...options(),install:false,retentionMs:saved.snapshot.retention_ms,resume:{clientId:saved.identity.client_id,token}});newTransport=true;
      channel.binding=context.binding;channel.workspaceId=saved.identity.workspace_id;channel.processes=original.processes;channel.uncertain=false;channel.recoveryOnly=true;
      const session=channel.client.session;
      requireThat(session.resumed===true&&channel.client.sessionId===saved.identity.helper_session_id&&session.clientId===saved.identity.client_id&&session.serverEpoch===saved.identity.server_epoch&&session.retentionMs>=saved.snapshot.recovery_window_ms&&channel.proof.agent_id===saved.identity.platform_agent_id,'recovery-helper-session-mismatch');
      channel.client.onClose(error=>{if(this.closed)return;channel.connected=false;this.channelLost(channel,transportCode(error));this.studio.acp?.channelLost(context.binding,error);});
     }
     this.state.assertCurrent(principal,input,saved);
     status=await this.studio.provider.call(channel,'process/status',{workspaceId:saved.identity.workspace_id,processId:saved.identity.process_id},{timeoutMs:options().timeoutMs});
     requireThat(status.processId===saved.identity.process_id&&status.pid===saved.identity.pid&&status.pgid===saved.identity.process.pgid&&typeof status.running==='boolean','recovery-process-mismatch');
     if(status.running){const observed=await this.observe(context.binding,input.operation_id,options());requireThat(observed.request_sha256===saved.identity.request_sha256&&observed.operation_id===input.operation_id&&observed.process?.exists&&sameProcess(saved.identity.process,observed.process),'recovery-process-mismatch');}
     else requireThat(Number.isInteger(status.exitCode)||typeof status.signal==='string','recovery-outcome-unknown');
     requireThat(channel.connected&&channel.client.closeReason===undefined,'channel-disconnected');transportId=channel.proof.channel_id;
    }
    await this.context(principal,input,saved);this.state.assertCurrent(principal,input,saved);
    this.state.commit(principal,input,saved,transportId,status);
    if(channel){this.transports.set(transportId,channel);this.sessions.set(key,channel);}
    return this.get(principal,{session_id:input.session_id,operation_id:input.operation_id});
   }catch(error){const code=transportCode(error);this.state.fail(input,code);if(newTransport&&channel){channel.detachForRecovery=true;try{await this.close(channel);}catch(closeError){this.state.event(input.operation_id,'rejected-transport-close',{code:transportCode(closeError)});}}throw new StudioError(code);}
  });
 }
 async taskContext(principal,method,input) {
  const value=this.state.owned(principal,input),context=await this.context(principal,input,value);
  requireThat(value.state.state==='recovered'&&value.state.current_recovery_id,'task-recovery-required');
  requireThat(value.snapshot.host_run_id===this.state.runId,'recovery-host-handle-unavailable');
  const cleanup=['status','read','cancel','release'].includes(method);
  requireThat(cleanup||this.clock()<value.snapshot.task_deadline_ms,'task-deadline-expired');
  const acp=this.store.db.prepare('SELECT 1 FROM acp_task_operations WHERE operation_id=?').get(input.operation_id);
  requireThat(!acp||cleanup,'acp-protocol-resume-unsupported');
  if(value.identity.execution_kind==='local')return {...context,recovered:true};
  const channel=this.channelFor(value);requireThat(channel?.connected&&channel.client.closeReason===undefined,'task-channel-lost');
  let current;
  try {current=await this.current(context.binding,{onDiagnostic:data=>this.diagnostic(context.binding,data)});requireThat(current.agent_id===value.identity.platform_agent_id,'recovery-platform-agent-changed');}
  catch(error){this.studio.provider.lost(channel,error);throw error;}
  const latest=this.state.row(input.operation_id);requireThat(latest.state==='recovered'&&latest.current_recovery_id===value.state.current_recovery_id,'recovery-superseded');
  return {...context,channel,recovered:true};
 }
 async wait(operationId) {
  while(!this.closed) {
   const snapshot=this.state.snapshot(operationId),state=this.state.row(operationId);
   requireThat(snapshot?.complete===1&&snapshot.host_run_id===this.state.runId,'recovery-identity-incomplete');
   if(state.state==='recovered')return;
   requireThat(state.state==='lost'&&this.clock()<state.recovery_deadline_ms,'recovery-window-expired');await delay(100);
  }
  throw new StudioError('recovery-closed');
 }
 released(operationId) {if(!this.state.snapshot(operationId))return;this.store.db.prepare("UPDATE task_recovery_state SET state='released',updated_at=? WHERE operation_id=?").run(now(),operationId);this.state.event(operationId,'released',{});clearTimeout(this.deadlines.get(operationId));this.deadlines.delete(operationId);}
 async dispose() {for(const timer of this.deadlines.values())clearTimeout(timer);this.closed=true;for(const channel of this.transports.values())if(channel.child.exitCode===null&&channel.child.signalCode===null)await this.close(channel);}
}
