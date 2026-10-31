import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {client,ndJsonStream,PROTOCOL_VERSION,RequestError} from 'file:///home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@agentclientprotocol/sdk/dist/acp.js';
import {scopeTarget} from 'file:///home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-scope/lib/index.js';
import {fields,requireThat,StudioError} from './store.mjs';
import {AcpState,ACP_POLICIES,acpOperationContext} from './acp-state.mjs';
import {AcpBackends} from './acp-backends.mjs';
import {permissionProjection,formProjection} from './acp-protocol.mjs';
import {AcpStdio} from './adapters/acp-stdio.mjs';

const bounded=async(promise,ms,code)=>{
  let timer;try {return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new StudioError(code)),ms);})]);}
  finally {clearTimeout(timer);}
};
function withSignal(promise,signal) {
  if(signal.aborted) return Promise.reject(signal.reason);
  let abort;const cancelled=new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});
  return Promise.race([promise,cancelled]).finally(()=>signal.removeEventListener('abort',abort));
}
const safeCode=error=>error instanceof StudioError?error.code:'acp-protocol-error';
const unknownCode=code=>/channel|transport|outcome-unknown|cancellation-unconfirmed|cleanup-unconfirmed|task-runtime-lost|task-channel-lost/.test(code);
const cancelResponse=kind=>kind==='approval'?{outcome:{outcome:'cancelled'}}:{action:'cancel'};

export class AcpSessions {
  constructor(studio) {
    this.studio=studio;this.ctx=studio.ctx;this.store=studio.store;this.runId=process.env.AGENT_STUDIO_RUN_ID;
    this.state=new AcpState(this.store,this.runId);this.backends=new AcpBackends(studio);this.active=new Map();this.requests=new WeakMap();this.sources=new WeakMap();this.closed=false;
  }
  async initialize() {this.state.restart();await this.backends.load();}
  async authorize(principal,input) {
    const context=await this.studio.provider.authorized(principal,input,'command.exec');
    requireThat(ACP_POLICIES.includes(context.binding.policy_version) && context.spec.acp_execution===true,'acp-policy-disabled');return context;
  }
  scope(active,action,control) {
    return acpOperationContext.run({principal:active.task.principal_id,session_id:active.task.session_id,task_id:active.task.task_id,run_id:this.runId,cli_instance_id:active.task.cli_instance_id,signal:active.controller.signal,...(control?{control_id:control.control_id}:{})},action);
  }
  record(active,kind,payload) {return this.state.append(active.task.principal_id,active.task.task_id,kind,payload);}
  async describe(principal,input) {
    fields(input,['session_id','binding_id','version'],['session_id']);
    // Describing an unconfigured/old binding must not connect or execute anything.
    const context=await this.studio.resolve(principal,input);return this.backends.describe(context);
  }
  async start(principal,input) {
    fields(input,['session_id','binding_id','version','backend_id','request_id','prompt'],['session_id','binding_id','version','backend_id','request_id','prompt']);
    requireThat(!this.closed && typeof input.request_id==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(input.request_id) && typeof input.prompt==='string' && input.prompt.trim().length>0 && Buffer.byteLength(input.prompt)<=16384,'acp-start-invalid');
    const context=await this.authorize(principal,input),backend=this.backends.resolve(context,input.backend_id);
    requireThat(!this.active.has(context.session.session_id),'acp-task-active');
    const task=this.state.create(context.session,context.binding,backend,input,Date.now()+180000);
    const active={task,context,backend,controller:new AbortController(),controls:new Set(),cancelRequested:false};
    this.active.set(task.session_id,active);
    active.timer=setTimeout(()=>active.controller.abort(new StudioError('acp-task-deadline')),Math.max(1,task.deadline_ms-Date.now()));
    active.done=this.execute(active).catch(error=>{
      // A controller bug must be observable without logging peer content/secrets.
      this.store.audit(principal,'acp.controller',task.task_id,'unknown',{code:safeCode(error)});
      this.state.update(principal,task.task_id,{state:'unknown',error_code:'acp-controller-failed'});
    }).finally(()=>{clearTimeout(active.timer);this.active.delete(task.session_id);});
    return task;
  }
  async execute(active) {
    const {task,context,backend}=active,principal=task.principal_id;
    let result,failure,finalState='failed';
    try {
      await this.scope(active,async()=>{
        active.agent=await this.studio.ensureAgent(principal,task.session_id);
        const {input,ticket}=await this.backends.prepare(context,backend,task);active.ticket=ticket;
        active.controller.signal.throwIfAborted();
        active.process=await this.studio.provider.start(principal,input);
        this.state.update(principal,task.task_id,{operation_id:active.process.operation_id});
      });
      active.transport=new AcpStdio({provider:this.studio.provider,principal,sessionId:task.session_id,operationId:active.process.operation_id,scope:(action,control)=>this.scope(active,action,control),secrets:Object.values(active.ticket.secrets),
        onIdentity:identity=>this.identity(active,identity),onFrame:(kind,frame)=>this.record(active,kind,frame),onError:error=>active.controller.abort(error),
        beforeWrite:frame=>this.beforeWrite(active,frame),afterWrite:(_frame,control)=>{if(control) this.state.delivered(control.control_id,'stdio-written-unconfirmed');}});
      await withSignal(bounded(active.transport.start(),20000,'acp-launch-deadline'),active.controller.signal);
      const app=client({name:'agent-studio-bound-client'});
      app.onRequest('session/request_permission',request=>this.control(active,'approval',request));
      app.onRequest('elicitation/create',request=>this.control(active,'question',request));
      app.onNotification('session/update',({params})=>{
        try {this.runningSession(active,params.sessionId);this.record(active,'session/update',params);}
        catch(error) {active.controller.abort(error);}
      });
      for(const method of ['fs/read_text_file','fs/write_text_file','terminal/create','terminal/output','terminal/release','terminal/wait_for_exit','terminal/kill']) app.onRequest(method,()=>{this.record(active,'unsupported-callback',{method});throw RequestError.methodNotFound(method);});
      active.connection=app.connect(ndJsonStream(active.transport.output,active.transport.input));
      const capabilities={fs:{readTextFile:false,writeTextFile:false},terminal:false,elicitation:{form:{}}};
      const negotiated=await withSignal(bounded(active.connection.agent.request('initialize',{protocolVersion:PROTOCOL_VERSION,clientCapabilities:capabilities,clientInfo:{name:'agent-studio-bound-client',version:'d06-v1'}}),15000,'acp-initialize-deadline'),active.controller.signal);
      requireThat(negotiated.protocolVersion===PROTOCOL_VERSION,'acp-version-unsupported');
      this.state.update(principal,task.task_id,{negotiated_json:JSON.stringify({clientCapabilities:capabilities,agent:negotiated})});
      const created=await withSignal(bounded(active.connection.agent.request('session/new',{cwd:context.binding.target_root,mcpServers:[]}),15000,'acp-new-session-deadline'),active.controller.signal);
      requireThat(typeof created.sessionId==='string' && created.sessionId.length>0 && created.sessionId.length<=256,'acp-session-invalid');
      active.cliSessionId=created.sessionId;
      this.state.update(principal,task.task_id,{state:'running',cli_session_id:created.sessionId});
      result=await withSignal(active.connection.agent.request('session/prompt',{sessionId:created.sessionId,prompt:JSON.parse(task.prompt_json)}),active.controller.signal);
      requireThat(typeof result.stopReason==='string','acp-prompt-result-invalid');
      finalState=result.stopReason==='cancelled'?'cancelled':result.stopReason==='refusal'?'refused':'completed';
    } catch(error) {failure=safeCode(error);finalState=active.cancelRequested?'cancelled':unknownCode(failure)?'unknown':'failed';}
    finally {
      clearTimeout(active.timer);
      const latest=this.state.task(principal,task.task_id);
      if(['starting','running'].includes(latest.state)) this.state.update(principal,task.task_id,{state:'stopping'});
      this.cancelControls(active,failure??'acp-prompt-finished');
      if(active.connection && (failure || finalState==='cancelled') && active.cliSessionId && !active.connection.signal.aborted) {
        try {await bounded(active.connection.agent.notify('session/cancel',{sessionId:active.cliSessionId}),3000,'acp-cancel-notify-deadline');}
        catch(error) {this.store.audit(principal,'acp.cancel-notify',task.task_id,'unconfirmed',{code:safeCode(error)});}
      }
      active.connection?.close(new StudioError(failure??'acp-prompt-finished'));
      if(active.transport) await active.transport.stop();
      if(active.process) {
        try {
          const operation={session_id:task.session_id,operation_id:active.process.operation_id};
          await this.scope(active,async()=>{
            let status=await this.studio.provider.task(principal,'status',operation);
            if(status.running && !failure && finalState==='completed') {
              await this.studio.provider.task(principal,'input',{...operation,action_id:randomUUID(),data:'',eof:true});
              for(let attempt=0;attempt<8 && status.running;attempt++) {await delay(100);status=await this.studio.provider.task(principal,'status',operation);}
            }
            if(status.running) status=await this.studio.provider.task(principal,'cancel',{...operation,action_id:randomUUID()});
            requireThat(status.running===false,'cancellation-unconfirmed');
            if(!failure && Number.isInteger(status.exitCode) && status.exitCode!==0) {finalState='failed';failure='acp-process-exit';}
            this.state.update(principal,task.task_id,{exit_code:status.exitCode??null});
            this.record(active,'process-stopped',status);
            await this.studio.provider.task(principal,'release',{...operation,action_id:randomUUID()});
          });
        } catch(error) {finalState='unknown';failure=safeCode(error);}
      }
      this.state.update(principal,task.task_id,{state:finalState,error_code:failure??null,result_json:result?JSON.stringify(result):null});
      if(active.ticket) active.ticket.secrets={};
    }
  }
  identity(active,value) {
    const {task,context,process:processInfo,ticket}=active;
    requireThat(value.studio_acp_launch===1 && value.task_id===task.task_id && value.instance_id===task.cli_instance_id && value.binding_id===task.binding_id && value.version===task.version && value.cwd===context.binding.target_root && value.manifest_sha256===ticket.manifest_sha256 && value.executable_sha256===active.backend.executable_sha256 && value.executable===active.backend.executable && value.pid===processInfo.pid && /^\d+$/.test(value.start_ticks) && value.home===ticket.privateHome+'/acp/'+active.backend.id,'acp-process-identity-mismatch');
    if(processInfo.execution_kind==='local') requireThat(value.start_ticks===processInfo.start_ticks,'acp-process-identity-mismatch');
    requireThat(Array.isArray(value.environment_keys) && value.environment_keys.every(key=>['PATH','HOME','LANG','LC_ALL','TMPDIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_STATE_HOME',...Object.keys(active.backend.environment),...ticket.credential_names].includes(key)),'acp-process-environment-mismatch');
    this.state.update(task.principal_id,task.task_id,{identity_json:JSON.stringify({...value,operation_id:processInfo.operation_id})});this.record(active,'launch-identity',value);
  }
  runningSession(active,sessionId) {
    this.studio.environments?.assertCached(active.context.binding);
    const task=this.state.task(active.task.principal_id,active.task.task_id);
    requireThat(task.run_id===this.runId && task.state==='running' && !active.controller.signal.aborted && task.cli_session_id===sessionId && active.cliSessionId===sessionId,'acp-session-instance-mismatch');return task;
  }
  beforeWrite(active,frame) {
    const task=this.state.task(active.task.principal_id,active.task.task_id);
    requireThat(['starting','running','stopping'].includes(task.state) && task.run_id===this.runId,'acp-operation-context-inactive');
    if(frame.method!==undefined || !Object.hasOwn(frame,'id')) return undefined;
    const row=this.store.db.prepare('SELECT * FROM acp_controls WHERE cli_instance_id=? AND rpc_request_id=?').get(task.cli_instance_id,JSON.stringify(frame.id));
    if(!row) return undefined;
    requireThat(row.response_json===JSON.stringify(frame.result),'acp-response-mismatch');
    requireThat(row.delivery!=='stdio-written-unconfirmed','acp-response-already-written');
    const cancellation=JSON.stringify(frame.result)===JSON.stringify(cancelResponse(row.kind));
    requireThat(cancellation || task.state==='running' && !active.controller.signal.aborted && Date.now()<row.deadline_ms && ['answered','rejected'].includes(row.state),'acp-response-expired');
    return row;
  }
  isSource(source) {return this.requests.has(source.request)||this.sources.has(source);}
  async control(active,kind,{params,requestId,signal}) {
    let entry;
    try {
      const task=this.runningSession(active,params.sessionId);
      requireThat(typeof requestId==='string' && requestId.length<=256 || Number.isSafeInteger(requestId),'acp-rpc-id-invalid');
      const projection=kind==='approval'?permissionProjection(params):formProjection(params);
      requireThat(active.controls.size<4,'acp-control-limit');
      const callId=kind==='approval'?params.toolCall.toolCallId:'elicitation-'+String(requestId),controller=new AbortController();
      requireThat(!this.store.db.prepare('SELECT 1 FROM acp_controls WHERE cli_instance_id=? AND (rpc_request_id=? OR (kind=? AND call_id=?))').get(task.cli_instance_id,JSON.stringify(requestId),kind,callId) && ![...active.controls].some(item=>item.requestId===requestId || item.kind===kind && item.callId===callId),'acp-control-duplicate');
      const deadline=Math.min(task.deadline_ms,Date.now()+(active.backend.offline_fixture?15000:60000));
      const request={agent:active.agent,callId,signal:AbortSignal.any([controller.signal,active.controller.signal,signal]),...(kind==='approval'?{toolName:'ACP · '+active.backend.name,reason:projection.title+'\n'+active.context.binding.target_root+'\nOne request, one CLI instance. Always options are not supported.'}:{questions:projection.questions})};
      entry={active,kind,params,requestId,callId,controller,deadline,request};
      this.requests.set(request,entry);active.controls.add(entry);
      entry.timer=setTimeout(()=>{if(entry.row) this.state.endControl(entry.row.control_id,'expired','deadline-expired');controller.abort(new StudioError('control-expired'));},Math.max(1,deadline-Date.now()));
      const answer=await withSignal(this.ctx.waterfall(scopeTarget(active.agent,active.agent),kind==='approval'?'approval/request':'user-questions/request',request,()=>Promise.reject(new StudioError('acp-answerer-unavailable'))),request.signal);
      requireThat(entry.row,'acp-control-not-forwarded');
      const current=this.state.control(task.principal_id,entry.row.control_id);
      requireThat(['answered','rejected'].includes(current.state) && current.delivery==='ui-delivered' && JSON.stringify(answer)===current.answer_json,'acp-control-not-delivered');
      return JSON.parse(current.response_json);
    } catch(error) {
      const code=safeCode(error);this.record(active,'control-refused',{kind,rpc_request_id:requestId,code});
      if(entry) {
        const response=cancelResponse(kind);
        if(entry.row) {
          this.state.endControl(entry.row.control_id,code==='control-expired'?'expired':'cancelled',code);
          const current=this.state.control(active.task.principal_id,entry.row.control_id);
          // A consumed decision is never replaced by another wire response.
          if(current.response_json!==null) throw RequestError.requestCancelled({code});
          this.store.db.prepare('UPDATE acp_controls SET response_json=? WHERE control_id=?').run(JSON.stringify(response),entry.row.control_id);
        }
        return response;
      }
      throw RequestError.invalidParams({code});
    } finally {if(entry) {clearTimeout(entry.timer);active.controls.delete(entry);this.requests.delete(entry.request);}}
  }
  openControl(source,eventId) {
    const entry=this.requests.get(source.request);requireThat(entry && !entry.row,'acp-control-source-invalid');
    const {active,kind}=entry,task=this.runningSession(active,entry.params.sessionId),{session,binding}=active.context;
    requireThat(source.context.agentId===session.session_id && source.request.agent===active.agent && Date.now()<entry.deadline,'acp-control-instance-mismatch');
    const payload={acp_request:entry.params,...(kind==='approval'?{toolName:source.request.toolName,reason:source.request.reason}:{questions:source.request.questions})};
    entry.row=this.state.openControl({eventId,session,binding,request:task,callId:entry.callId,kind,payload,deadline:entry.deadline,extra:{cli_session_id:task.cli_session_id,cli_instance_id:task.cli_instance_id,rpc_request_id:JSON.stringify(entry.requestId)}});
    this.sources.set(source,entry);
    source.request={...source.request,studioControl:{control_id:entry.row.control_id,session_id:session.session_id,binding_id:binding.binding_id,version:binding.version,deadline_ms:entry.deadline}};
    const resolve=source.resolve,reject=source.reject;
    source.resolve=outcome=>{
      const row=this.state.control(task.principal_id,entry.row.control_id);
      if(outcome.kind==='result' && ['answered','rejected'].includes(row.state)) {this.state.delivered(row.control_id,'ui-delivered');resolve(outcome);}
      else {this.state.endControl(row.control_id,'cancelled','no-authenticated-answer');reject(new StudioError('acp-control-not-delivered'));}
    };
    source.reject=error=>{this.state.endControl(entry.row.control_id,'cancelled','request-cancelled');reject(error);};
  }
  guardReply(pending,peer,result) {
    requireThat(peer.principal.kind==='owner' && !peer.signal.aborted,'unauthorized');
    const entry=this.sources.get(pending.source);requireThat(entry?.row && entry.row.event_id===result.eventId,'acp-control-instance-mismatch');
    this.runningSession(entry.active,entry.params.sessionId);
    if(result.outcome.kind!=='result') {this.state.endControl(entry.row.control_id,'cancelled','client-delegated');return;}
    const row=entry.row;this.state.decide(row.principal_id,{control_id:row.control_id,session_id:row.session_id,binding_id:row.binding_id,version:row.version},result.outcome.value);
  }
  reply(principal,input) {
    fields(input,['control_id','session_id','binding_id','version','answer'],['control_id','session_id','binding_id','version','answer']);
    const {answer,...scope}=input,row=this.state.control(principal,input.control_id),pending=this.ctx.typertGateway.pendingRemoteEvents.get(row.event_id);
    requireThat(pending && this.sources.has(pending.source),'control-not-pending');
    const entry=this.sources.get(pending.source);this.runningSession(entry.active,row.cli_session_id);
    this.state.decide(principal,scope,answer);this.ctx.typertGateway.settleRemoteEvent(pending,{kind:'result',value:answer});return {accepted:true,delivery:'ui-delivered'};
  }
  cancelControls(active,reason) {for(const entry of active.controls) {if(entry.row) this.state.endControl(entry.row.control_id,'cancelled',reason);entry.controller.abort(new StudioError(reason));}}
  async cancel(principal,input) {
    fields(input,['session_id','binding_id','version','task_id'],['session_id','binding_id','version','task_id']);
    const row=this.state.task(principal,input.task_id);
    requireThat(row.session_id===input.session_id && row.binding_id===input.binding_id && row.version===input.version,'acp-task-binding-mismatch');
    const active=this.active.get(row.session_id);requireThat(active?.task.task_id===row.task_id && ['starting','running','stopping'].includes(row.state),'acp-task-not-active');
    active.cancelRequested=true;active.controller.abort(new StudioError('acp-user-cancelled'));
    await bounded(active.done,90000,'acp-cancellation-unconfirmed');return this.state.task(principal,row.task_id);
  }
  channelLost(binding,error) {
    for(const active of this.active.values()) if(active.task.binding_id===binding?.binding_id && active.task.version===binding.version) {
      this.cancelControls(active,'acp-channel-lost');active.controller.abort(new StudioError('acp-channel-lost'));
      this.store.db.prepare("UPDATE acp_controls SET delivery='channel-delivery-unknown',updated_at=? WHERE cli_instance_id=? AND delivery IN ('accepted','ui-delivered')").run(new Date().toISOString(),active.task.cli_instance_id);
      this.store.audit(active.task.principal_id,'acp.channel-lost',active.task.task_id,'unknown',{code:safeCode(error)});
    }
  }
  async dispose() {
    this.closed=true;const active=[...this.active.values()];
    for(const entry of active) {entry.cancelRequested=true;entry.controller.abort(new StudioError('preview-stopped'));}
    await bounded(Promise.all(active.map(entry=>entry.done)),90000,'acp-shutdown-unconfirmed');
  }
}
