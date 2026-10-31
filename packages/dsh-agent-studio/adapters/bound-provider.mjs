import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fields, requireThat, StudioError } from '../store.mjs';
import { openChannel, closeChannel, checkCurrent } from './helper-channel.mjs';
import {LocalProvider} from './local-provider.mjs';
import {consumeAcpLaunch} from '../acp-backends.mjs';

export function relativePath(value='', empty=true) {
  requireThat(typeof value==='string' && value.length<=4096 && !value.includes('\0') && !value.includes('\\') && !value.startsWith('/') &&
    (empty || value!=='') && (value==='' || value.split('/').every(part=>part && part!=='.' && part!=='..')),'path-outside-binding');
  requireThat(!value.split('/').includes('.agent-studio-binding.json'),'reserved-path');
  return value;
}
export function commandInput(input) {
  requireThat(Array.isArray(input.argv) && input.argv.length>0 && input.argv.length<=64 && input.argv.every(v=>typeof v==='string' && v.length<=16384 && !v.includes('\0')) && input.argv[0],'invalid-argv');
  const env=input.env??{};
  requireThat(env && typeof env==='object' && !Array.isArray(env) && Object.keys(env).length<=32 && Object.entries(env).every(([key,value])=>
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !/TOKEN|SECRET|PASSWORD|CREDENTIAL|^CODER_|^SSH_|^LD_|^PYTHON|^NODE_OPTIONS$/.test(key) && typeof value==='string' && value.length<=8192 && !value.includes('\0')),'invalid-env');
  relativePath(input.cwd??'');
  if(input.tty!==undefined) dimensions(input.tty.rows,input.tty.cols);
  return env;
}
export function dimensions(rows,cols) { requireThat([rows,cols].every(n=>Number.isSafeInteger(n) && n>=1 && n<=500),'invalid-dimensions'); }
function code(error) {
  if(typeof error?.code==='string' && /^[A-Za-z0-9_/-]{1,100}$/.test(error.code)) return error.code;
  if(error?.name==='RemoteHelperCallInterruptedError' && ['timeout','abort','disconnect'].includes(error.kind)) return 'helper-call-'+error.kind;
  if(error?.name==='DshRpcProtocolError') return 'helper-protocol-error';
  if(['remote helper stdout ended','remote helper stdout closed'].includes(error?.message)) return 'helper-stdout-ended';
  return 'provider-error';
}
function identity(input,operation) {
  return Object.fromEntries(Object.entries({session_id:input.session_id,binding_id:input.binding_id,version:input.version,operation}).filter(([,v])=>v!==undefined));
}
const READS=new Set(['fs/stat','fs/read','fs/list','process/read','process/status','process/inspectForeground','environment/resolveExecutable']);
const CLEANUP=new Set(['process/terminate','process/release','workspace/close','session/close']);

export class BoundProvider {
  constructor(studio) {this.studio=studio;this.store=studio.store;this.channels=new Map();this.retiredChannels=[];this.connecting=new Map();this.closed=false;this.local=new LocalProvider(studio);}
  key(binding) {return `${binding.binding_id}@${binding.version}`;}
  suspend(binding,reason) {
    const channel=this.channels.get(this.key(binding));if(channel) {channel.connected=false;channel.pauseReason=reason;this.studio.recovery?.channelLost(channel,reason);}
    for(const recovered of this.studio.recovery?.transports.values()??[]) if(recovered.binding.binding_id===binding.binding_id&&recovered.binding.version===binding.version){recovered.connected=false;this.studio.recovery.channelLost(recovered,reason);}
  }
  lost(channel,error) {
    if(channel.intentionalClosing) {
      channel.connected=false;channel.pauseReason='explicit-disconnect';
      this.store.audit(channel.binding.principal_id,'channel.transport-close',this.key(channel.binding),'remote-cleanup-confirmed',{channel_id:channel.proof.channel_id});return;
    }
    channel.connected=false;channel.pauseReason=channel.detachForRecovery?'explicit-transport-detach':code(error);
    this.studio.recovery?.channelLost(channel,channel.pauseReason);
    channel.diagnostic={reason:code(error),stage:'helper-rpc-close',ssh_exit_code:channel.child?.exitCode??null,ssh_signal:channel.child?.signalCode??null};
    this.store.audit(channel.binding.principal_id,'channel.lost',this.key(channel.binding),'unknown',{...channel.diagnostic,channel_id:channel.proof.channel_id,helper_session_id:channel.client.sessionId});
    if(this.studio.environments) this.studio.environments.unavailable(channel.binding,code(error));
    else {this.studio.models?.bindingUnavailable(channel.binding,code(error));this.studio.acp?.channelLost(channel.binding,error);}
    this.store.db.prepare("UPDATE operation_records SET state='unknown',error_code=?,updated_at=? WHERE channel_id=? AND state IN ('pending','running')").run(code(error),new Date().toISOString(),channel.proof.channel_id);
  }
  async verify(binding) {
    const channel=this.channels.get(this.key(binding));
    requireThat(!this.closed && channel?.connected && channel.client.closeReason===undefined,'channel-disconnected');
    try {const current=await checkCurrent(binding);requireThat(current.agent_id===channel.proof.agent_id,'environment-agent-reauthentication-required');} catch(error) {this.lost(channel,error);throw error;}
    requireThat(channel.connected,'channel-disconnected');
    return channel;
  }
  async call(channel,method,params={},options={}) {
    requireThat(channel.connected && channel.client.closeReason===undefined,'channel-disconnected');
    const mutation=!READS.has(method);
    requireThat(!mutation || !channel.uncertain || CLEANUP.has(method),'outcome-unknown');
    const started=Date.now(),requestId=randomUUID();let outcome='response',errorCode;
    try {return await channel.client.call(method,params,{timeoutMs:Math.max(1,Math.min(10000,options.timeoutMs??10000)),mutation});}
    catch(error) {
      outcome='failed';errorCode=code(error);
      if(mutation && error.mutationMayHaveStarted) channel.uncertain=true;
      if(['helper-call-timeout','helper-call-disconnect','helper-stdout-ended','helper-transport-closed'].includes(errorCode))this.lost(channel,error);
      const safe=new StudioError(errorCode);safe.mutationMayHaveStarted=error.mutationMayHaveStarted===true;throw safe;
    } finally {
      this.studio.recovery?.diagnostic(channel.binding,{layer:'helper-rpc',method,request_id:requestId,operation_id:params.operationId??null,process_id:params.processId??null,channel_id:channel.proof.channel_id,helper_session_id:channel.client.sessionId,started_at_ms:started,finished_at_ms:Date.now(),duration_ms:Date.now()-started,outcome,...(errorCode?{error_code:errorCode}:{})});
    }
  }
  async connect(principal,input) {
    fields(input,['session_id','binding_id','version'],['session_id']);
    const context=await this.studio.resolve(principal,input), {binding,environment,spec}=context;
    requireThat(environment.provider==='coder-helper' && spec.provider==='coder-helper','remote-unverified');
    const key=this.key(binding);
    if(this.channels.get(key)?.connected) {await this.verify(binding);return this.status(binding);}
    if(!this.connecting.has(key)) {
      const work=this.open(context).finally(()=>this.connecting.delete(key));this.connecting.set(key,work);
    }
    await this.connecting.get(key);return this.status(binding);
  }
  async open({binding}) {
    requireThat(!this.closed,'provider-closed');
    const previous=this.channels.get(this.key(binding));
    if(previous && !previous.cleanupConfirmed) {
      // Retire only the old transport. Do NOT close its helper session, release
      // processes, erase identities or claim original-task recovery/cancellation.
      try {await closeChannel(previous);} catch(error) {
        requireThat(previous.child.exitCode!==null || previous.child.signalCode!==null,'old-transport-still-live');
        this.store.audit(binding.principal_id,'channel.transport-ended',this.key(binding),'tasks-unknown',{code:code(error),exit_code:previous.child.exitCode,signal:previous.child.signalCode});
      }
      this.retiredChannels.push(previous);
      this.store.audit(binding.principal_id,'channel.retired',this.key(binding),'tasks-unknown',{channel_id:previous.proof.channel_id,helper_session_id:previous.client.sessionId});
    }
    const channel=await openChannel(this.studio.root,binding,{onDiagnostic:data=>this.studio.recovery?.diagnostic(binding,data)});
    channel.binding=binding;channel.uncertain=false;channel.processes=new Set();
    this.channels.set(this.key(binding),channel);
    channel.client.onClose(error=>this.lost(channel,error));
    try {
      const boot=randomUUID();
      await this.call(channel,'workspace/open',{path:'/workspace',access:'danger-full-access',workspaceId:boot,operationId:randomUUID()});
      try {
        const basename=binding.target_root.slice('/workspace/'.length);
        const owner={binding_id:binding.binding_id,version:binding.version,principal_id:binding.principal_id,generation:binding.instance_generation};
        const existing=await this.call(channel,'fs/stat',{workspaceId:boot,path:basename,follow:false});
        if(!existing.exists) {
          await this.call(channel,'fs/mkdir',{workspaceId:boot,path:basename,recursive:false,mode:0o700,operationId:randomUUID()});
          await this.call(channel,'fs/write',{workspaceId:boot,path:basename+'/.agent-studio-binding.json',encoding:'base64',data:Buffer.from(JSON.stringify(owner)).toString('base64'),intent:{kind:'create-if-absent'},operationId:randomUUID()});
        }
        const marker=await this.call(channel,'fs/read',{workspaceId:boot,path:basename+'/.agent-studio-binding.json',maxBytes:4096});
        requireThat(JSON.stringify(JSON.parse(Buffer.from(marker.data,'base64').toString()))===JSON.stringify(owner),'remote-root-not-owned');
      } finally {await this.call(channel,'workspace/close',{workspaceId:boot,operationId:randomUUID()});}
      channel.workspaceId=randomUUID();
      const opened=await this.call(channel,'workspace/open',{path:binding.target_root,access:'danger-full-access',workspaceId:channel.workspaceId,operationId:randomUUID()});
      requireThat(opened.path===binding.target_root && opened.workspaceId===channel.workspaceId,'remote-root-mismatch');
      this.store.audit(binding.principal_id,'channel.connected',this.key(binding),'ready',{channel_id:channel.proof.channel_id,helper_session_id:channel.client.sessionId,generation:binding.instance_generation});
    } catch(error) {
      try {await this.call(channel,'session/close',{});} catch(cleanup) {this.store.audit(binding.principal_id,'channel.cleanup',this.key(binding),'unknown',{code:code(cleanup)});}
      await closeChannel(channel);throw error;
    }
  }
  status(binding) {
    const channel=this.channels.get(this.key(binding));
    return {binding_id:binding.binding_id,version:binding.version,connected:Boolean(channel?.connected && channel.client.closeReason===undefined),
      channel_id:channel?.proof.channel_id??null,helper_session_id:channel?.client.sessionId??null,target_root:binding.target_root,
      generation:binding.instance_generation,pause_reason:channel?.pauseReason??null,diagnostic:channel?.diagnostic??null,mutation_replay:false,original_task_recovery:false};
  }
  async authorized(principal,input,operation) {
    await this.studio.check(principal,identity(input,operation));
    const context=await this.studio.resolve(principal,identity(input,operation));
    if(context.environment.kind==='local' && context.environment.provider==='local-managed') {await this.local.verify(context);return context;}
    requireThat(context.environment.provider==='coder-helper','provider-unavailable');
    return {...context,channel:this.channels.get(this.key(context.binding))};
  }
  async terminalEnvironment(context) {
    if(context.environment.kind==='local' && context.environment.provider==='local-managed') return this.local.terminalEnvironment(context);
    const platform=context.channel.client.hello.platform;
    requireThat(platform.system==='Linux' && typeof platform.shell==='string','unsupported-terminal-environment');
    return {platform:'posix',defaultShell:platform.shell};
  }
  async resolveExecutable(context,command) {
    if(context.environment.kind==='local' && context.environment.provider==='local-managed') return this.local.resolveExecutable(context,command);
    return (await this.call(context.channel,'environment/resolveExecutable',{command})).path;
  }
  async mutation(principal,session,kind,input,channel,action,processId) {
    // Refuse new work before creating an operation if a previous mutation has
    // an unknown outcome. Read-only UI workers must not repeatedly spawn here.
    requireThat(channel.connected && (!channel.uncertain || ['task.cancel','task.release'].includes(kind)),'outcome-unknown');
    const row=this.store.beginOperation(principal,session,kind,input);
    this.store.updateOperation(principal,row.operation_id,{channel_id:channel.proof.channel_id,helper_session_id:channel.client.sessionId,...(processId?{remote_process_id:processId}:{})});
    // Only a newly persisted operation may change process ownership tracking.
    if(processId) channel.processes.add(row.operation_id);
    try {
      const result=await action(row.operation_id),current=this.store.operation(principal,row.operation_id);
      if(current.state==='unknown' || !channel.connected) {
        // A late ACK can add a newly learned PID, never resurrect dispatch or
        // erase the first uncertainty reason. Recovery is a separate operation.
        const learnedPid=processId && Number.isSafeInteger(result.pid) && result.pid>0?result.pid:null;
        this.store.audit(principal,'operation.late-result',row.operation_id,'unknown',{channel_id:channel.proof.channel_id,helper_session_id:channel.client.sessionId,session_id:session.session_id,request_sha256:row.request_sha256,remote_process_id:processId??null,remote_pid:learnedPid,previous_error_code:current.error_code,dispatch_restored:false});
        this.store.updateOperation(principal,row.operation_id,{state:'unknown',...(learnedPid?{remote_pid:learnedPid}:{})});
        throw new StudioError('outcome-unknown');
      }
      this.store.updateOperation(principal,row.operation_id,{state:processId?'running':'completed',result_json:JSON.stringify(result),...(processId?{remote_pid:result.pid}:{})});
      return {...result,operation_id:row.operation_id};
    } catch(error) {
      const uncertain=error.mutationMayHaveStarted || channel.uncertain || !channel.connected;
      if(this.store.operation(principal,row.operation_id).state!=='unknown') this.store.updateOperation(principal,row.operation_id,{state:uncertain?'unknown':'failed',error_code:code(error)});
      if(processId && !uncertain && this.store.operation(principal,row.operation_id).state!=='unknown') channel.processes.delete(row.operation_id);
      throw error;
    }
  }
  async file(principal,method,input) {
    const common=['session_id','binding_id','version','path'];
    fields(input,[...common,...(method==='write'?['operation_id','data','encoding','expected_version']:method==='mkdir'?['operation_id']:[])],['session_id','path',...(['write','mkdir'].includes(method)?['operation_id']:[])]);
    const context=await this.authorized(principal,input,['write','mkdir'].includes(method)?'fs.write':'fs.read');
    if(context.environment.kind==='local' && context.environment.provider==='local-managed') return this.local.file(context,method,input);
    const {session,channel}=context;
    const path=relativePath(input.path,method==='list');
    const base={workspaceId:channel.workspaceId,path};
    if(method==='list') {
      const result=await this.call(channel,'fs/list',{...base,limit:1000,allowTruncated:false});
      return {...result,entries:result.entries.filter(entry=>entry.name!=='.agent-studio-binding.json')};
    }
    if(method==='read') {
      const result=await this.call(channel,'fs/read',{...base,maxBytes:196608});
      requireThat(Buffer.from(result.data,'base64').length===result.metadata.size,'incomplete-read');
      return {...result,sha256:createHash('sha256').update(Buffer.from(result.data,'base64')).digest('hex')};
    }
    requireThat(['write','mkdir'].includes(method),'unknown-method');
    if(method==='mkdir') return this.mutation(principal,session,'fs.mkdir',input,channel,operationId=>this.call(channel,'fs/mkdir',{...base,recursive:false,mode:0o700,operationId}));
    requireThat(['base64','utf8'].includes(input.encoding) && typeof input.data==='string','invalid-data');
    const bytes=Buffer.from(input.data,input.encoding);
    requireThat(bytes.length<=196608 && (input.encoding!=='base64' || bytes.toString('base64')===input.data),'data-limit-or-encoding');
    requireThat(input.expected_version===null || typeof input.expected_version==='string' && input.expected_version.length>0,'version-required');
    const intent=input.expected_version===null?{kind:'create-if-absent'}:{kind:'replace-if-version',version:input.expected_version};
    return this.mutation(principal,session,'fs.write',input,channel,operationId=>this.call(channel,'fs/write',{...base,encoding:'base64',data:bytes.toString('base64'),intent,operationId}));
  }
  async start(principal,input,{retain=true}={}) {
    fields(input,['session_id','binding_id','version','operation_id','argv','cwd','env','tty','deadline_ms'],['session_id','operation_id','argv']);
    const env=commandInput(input),deadline=input.deadline_ms??Date.now()+600000;
    requireThat(Number.isSafeInteger(deadline)&&deadline>Date.now()&&deadline<=Date.now()+600000,'task-deadline-policy');
    const context=await this.authorized(principal,input,input.tty?'pty.open':'command.exec');
    const acp=consumeAcpLaunch(input,context);
    if(context.environment.kind==='local' && context.environment.provider==='local-managed') {
      const result=await this.local.start(context,input,acp);await this.studio.recovery?.capture(context,result,{deadline,recoverable:retain});return result;
    }
    // This ephemeral environment is not part of the operation's stored input.
    if(acp) Object.assign(env,acp.secrets);
    const {session,channel}=context;
    const processId=randomUUID();
    const result=await this.mutation(principal,session,input.tty?'pty.open':'command.exec',input,channel,operationId=>this.call(channel,'process/start',{
      workspaceId:channel.workspaceId,processId,operationId,argv:input.argv,cwd:input.cwd??'',env,stdin:'pipe',...(input.tty?{tty:input.tty}:{})}),processId);
    await this.studio.recovery?.capture(context,result,{deadline,recoverable:retain});return result;
  }
  async task(principal,method,input) {
    fields(input,['session_id','operation_id','action_id','after_seq','data','eof','rows','cols','signal'],['session_id','operation_id']);
    requireThat(input.eof===undefined || typeof input.eof==='boolean','invalid-eof');
    const row=this.store.operation(principal,input.operation_id);
    requireThat(row.session_id===input.session_id && (row.remote_process_id || row.local_process_id),'task-not-owned');
    const recovery=this.studio.recovery?.state.row(row.operation_id);
    requireThat(!recovery || !['lost','revoked'].includes(recovery.state),'task-recovery-required');
    const context=recovery?.current_recovery_id?await this.studio.recovery.taskContext(principal,method,input):await this.authorized(principal,input,row.kind==='pty.open'?'pty.open':'command.exec');
    if(context.environment.kind==='local' && context.environment.provider==='local-managed') {
      const result=await this.local.task(context,method,input,row);
      if(method==='read')this.studio.recovery?.state.cursor(row.operation_id,result);
      if(method==='release')this.studio.recovery?.released(row.operation_id);
      return result;
    }
    const {session,channel}=context;
    requireThat(row.remote_process_id && row.execution_kind!=='local','task-not-owned');
    requireThat((context.recovered || channel.proof.channel_id===row.channel_id) && channel.client.sessionId===row.helper_session_id,'task-channel-lost');
    const params={workspaceId:channel.workspaceId,processId:row.remote_process_id};
    if(method==='status' || method==='foreground') {
      const result=await this.call(channel,method==='status'?'process/status':'process/inspectForeground',params);
      if(method==='status' && this.store.operation(principal,row.operation_id).state==='running') this.store.updateOperation(principal,row.operation_id,{state:result.running?'running':'completed',result_json:JSON.stringify(result)});
      return result;
    }
    if(method==='read') {
      requireThat(input.after_seq===undefined || /^\d{1,20}$/.test(input.after_seq),'invalid-cursor');
      const result=await this.call(channel,'process/read',{...params,afterSeq:input.after_seq??'0',maxBytes:65536,waitMs:100});
      this.studio.recovery?.state.cursor(row.operation_id,result);
      if(result.exited && this.store.operation(principal,row.operation_id).state==='running') this.store.updateOperation(principal,row.operation_id,{state:'completed',result_json:JSON.stringify(result)});
      return result;
    }
    requireThat(['input','resize','signal','cancel','release'].includes(method),'unknown-method');
    const action={...input,operation_id:input.action_id,task_id:row.operation_id};
    return this.mutation(principal,session,`task.${method}`,action,channel,async operationId=>{
      if(method==='input') {
        requireThat(typeof input.data==='string' && Buffer.byteLength(input.data)<=65536,'input-limit');
        requireThat(!input.eof || row.kind!=='pty.open','terminal-eof-unsupported');
        return this.call(channel,'process/write',{...params,operationId,encoding:'base64',data:Buffer.from(input.data).toString('base64'),...(input.eof?{eof:true}:{})});
      }
      if(method==='resize') {dimensions(input.rows,input.cols);return this.call(channel,'process/resize',{...params,operationId,rows:input.rows,cols:input.cols});}
      if(method==='signal') {
        requireThat(['SIGINT','SIGTERM','SIGHUP','SIGQUIT','SIGTSTP'].includes(input.signal),'invalid-signal');
        return this.call(channel,'process/signal',{...params,operationId,signal:input.signal,target:'foreground',denyOwnShellKill:true});
      }
      if(method==='cancel') {
        await this.call(channel,'process/terminate',{...params,operationId,force:false,graceMs:1000});
        let status;
        for(let i=0;i<40;i++) {status=await this.call(channel,'process/status',params);if(!status.running) break;await delay(100);}
        if(status.running) {
          await this.call(channel,'process/terminate',{...params,operationId:randomUUID(),force:true});
          for(let i=0;i<40;i++) {status=await this.call(channel,'process/status',params);if(!status.running) break;await delay(100);}
        }
        requireThat(!status.running,'cancellation-unconfirmed');
        requireThat(channel.connected&&this.store.operation(principal,row.operation_id).state!=='unknown','outcome-unknown');
        this.store.updateOperation(principal,row.operation_id,{state:'cancelled',result_json:JSON.stringify(status)});
        return status;
      }
      const status=await this.call(channel,'process/status',params);
      requireThat(!status.running,'process-still-running');
      const released=await this.call(channel,'process/release',{...params,operationId});
      requireThat(released.released,'release-unconfirmed');
      requireThat(channel.connected&&this.store.operation(principal,row.operation_id).state!=='unknown','outcome-unknown');
      this.store.updateOperation(principal,row.operation_id,{state:'released',result_json:JSON.stringify(released)});
      channel.processes.delete(row.operation_id);this.studio.recovery?.released(row.operation_id);return released;
    });
  }
  async disconnect(binding) {
    const original=this.channels.get(this.key(binding));let channel=original;
    if(!channel) return {connected:false,cleanup:'no-channel'};
    if(channel.cleanupConfirmed) return {connected:false,cleanup:'confirmed'};
    if(!channel.connected&&channel.processes.size===0) channel=[...(this.studio.recovery?.transports.values()??[])].find(item=>item.connected&&item.binding.binding_id===binding.binding_id&&item.binding.version===binding.version&&item.workspaceId===original.workspaceId)??original;
    requireThat(channel.connected,'cleanup-unconfirmed');
    // Verify and stop every precisely recorded remote process BEFORE releasing it.
    for(const operationId of channel.processes) {
      const row=this.store.operation(binding.principal_id,operationId);
      if(!row.remote_process_id) continue;
      const input={session_id:row.session_id,operation_id:operationId};
      const status=await this.task(binding.principal_id,'status',input);
      if(status.running) await this.task(binding.principal_id,'cancel',{...input,action_id:randomUUID()});
      await this.task(binding.principal_id,'release',{...input,action_id:randomUUID()});
    }
    await this.call(channel,'workspace/close',{workspaceId:channel.workspaceId,operationId:randomUUID()});
    const closed=await this.call(channel,'session/close',{});
    requireThat(closed.closed,'session-close-unconfirmed');
    channel.intentionalClosing=true;
    const transport=await closeChannel(channel);
    channel.cleanupConfirmed=true;original.cleanupConfirmed=true;
    return {connected:false,cleanup:'confirmed',transport};
  }
  async dispose() {
    const errors=[];
    for(const channel of this.channels.values()) {
      try {await this.disconnect(channel.binding);} catch(error) {errors.push(code(error));this.store.audit(channel.binding.principal_id,'channel.cleanup',this.key(channel.binding),'unknown',{code:code(error)});await closeChannel(channel).catch(closeError=>errors.push(code(closeError)));}
    }
    this.closed=true;
    if(errors.length) throw new StudioError('cleanup-unconfirmed',errors.join(','));
  }
}
