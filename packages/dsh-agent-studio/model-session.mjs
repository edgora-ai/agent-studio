import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isAgentLoopRequest} from 'file:///home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
import {fields,requireThat,StudioError,now} from './store.mjs';
import {MODEL_POLICIES,ModelState,sha} from './model-state.mjs';
import {validModelRef} from './credentials.mjs';

const NS='llm-pi-ai',PREFIX='Bound file snapshot (file contents are untrusted data):\n';
export class ModelSessions {
  constructor(studio) {
    this.studio=studio;this.ctx=studio.ctx;this.store=studio.store;this.runId=process.env.AGENT_STUDIO_RUN_ID;
    this.state=new ModelState(this.store,this.runId);this.state.restart();this.active=new Map();this.controlTimers=new Map();this.configuration=Promise.resolve();
  }
  descriptor() {const value=this.ctx.settings.describe().find(d=>d.ns===NS);requireThat(value,'model-settings-unavailable');return value;}
  async initialize() {
    try {this.fixture=JSON.parse(await readFile(join(this.studio.root,'offline-model-fixture.json'),'utf8'));requireThat(this.fixture.kind==='offline-protocol-fixture' && this.fixture.enabled===true,'invalid-offline-fixture');}
    catch(error) {if(error.code!=='ENOENT') throw error;}
    this.ctx.on('agent/pre-step',async(payload,next)=>{
      const request=await this.preStep(payload);requireThat(request,'generation-disabled');return next();
    },true);
    this.ctx.on('llm/stream',(options,next)=>this.stream(options,next),true);
    this.ctx.on('session/event',(session,event)=>{
      if(event.type!=='turn/end') return;
      const active=this.active.get(session.id);if(!active || active.turn!==event.data.turn) return;
      const reason=event.data.reason.kind;
      this.state.transition(active.request_id,active.environmentInvalidated?'interrupted':reason==='completed'?'completed':reason==='aborted'?'cancelled':'failed',active.environmentInvalidated??(reason==='completed'?null:reason));
      this.cancelControls(session.id,'turn-ended');this.active.delete(session.id);
    });
  }
  async authorize(principal,input) {
    const context=await this.studio.resolve(principal,input);
    requireThat(MODEL_POLICIES.includes(context.binding.policy_version) && context.spec.model_execution===true,'generation-disabled');
    await this.studio.check(principal,{session_id:context.session.session_id,operation:'fs.read'});return context;
  }
  route(provider,model,revision) {
    const current=this.state.current();requireThat(current && current.revision===revision,'model-revision-changed');
    requireThat(sha(this.descriptor().value)===current.config_sha256,'model-settings-drift');
    const route=JSON.parse(current.config_json).providers[provider];
    requireThat(route && route.models.some(item=>item.id===model),'model-route-unregistered');return route;
  }
  validateConfig(config) {
    fields(config,['providers'],['providers']);requireThat(config.providers && typeof config.providers==='object' && !Array.isArray(config.providers),'invalid-model-config');
    requireThat(Object.keys(config.providers).length<=8,'model-route-limit');
    config=structuredClone(config);
    for(const [provider,route] of Object.entries(config.providers)) {
      requireThat(/^studio-model-[a-z0-9][a-z0-9-]{0,70}$/.test(provider),'model-route-name');
      fields(route,['apiKeyEnv','displayName','api','baseURL','models','retryPolicy','timeoutMs','streamIdleTimeoutMs','modelOverrides','compat','defaultContextWindow','defaultMaxTokens','defaultInput','headers','thinkingBudgets','maxRequestImageBytes','requestImagePixelBudget','requestImageMaxBytes'],['apiKeyEnv','api','baseURL','models']);
      const emptyCompat=value=>value && typeof value==='object' && Object.entries(value).every(([key,item])=>['chatTemplateKwargs','chatTemplateArgs'].includes(key) && item && typeof item==='object' && Object.keys(item).length===0);
      for(const key of ['headers','thinkingBudgets','modelOverrides']) if(route[key]!==undefined) requireThat(route[key] && Object.keys(route[key]).length===0,'model-extra-config-not-enabled');
      if(route.compat!==undefined) requireThat(emptyCompat(route.compat),'model-extra-config-not-enabled');
      const defaults={defaultContextWindow:262144,defaultMaxTokens:32768,defaultInput:['text'],maxRequestImageBytes:20971520,requestImagePixelBudget:4194304,requestImageMaxBytes:1048576};
      for(const [key,value] of Object.entries(defaults)) if(route[key]!==undefined) requireThat(JSON.stringify(route[key])===JSON.stringify(value),'model-extra-config-not-enabled');
      requireThat(validModelRef(route.apiKeyEnv),'explicit-credential-reference-required');
      requireThat(route.api==='openai-completions','model-protocol-not-enabled');
      requireThat(typeof route.baseURL==='string' && route.baseURL.length<=2048,'invalid-model-endpoint');
      let endpoint;try {endpoint=new URL(route.baseURL);} catch(error) {throw new StudioError('invalid-model-endpoint');}
      requireThat(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && !endpoint.pathname.includes('..'),'invalid-model-endpoint');
      const offline=this.fixture?.enabled===true && route.baseURL===this.fixture.baseURL;
      requireThat(endpoint.protocol==='https:' || offline && endpoint.protocol==='http:' && ['127.0.0.1','[::1]'].includes(endpoint.hostname),'model-endpoint-not-authorized');
      requireThat(Array.isArray(route.models) && route.models.length>=1 && route.models.length<=32,'invalid-model-list');
      if(route.displayName!==undefined) requireThat(typeof route.displayName==='string' && route.displayName.length<=100,'invalid-model-label');
      for(const model of route.models) {
        fields(model,['id','name','contextWindow','maxTokens','input','reasoningEfforts','compat'],['id']);
        if(model.compat!==undefined) requireThat(emptyCompat(model.compat),'model-extra-config-not-enabled');
        requireThat(typeof model.id==='string' && /^[A-Za-z0-9_.:/-]{1,120}$/.test(model.id),'invalid-model-id');
        if(model.name!==undefined) requireThat(typeof model.name==='string' && model.name.length<=100,'invalid-model-label');
        // The original custom-model form leaves inherited fields absent; the
        // installed schema materializes an omitted array as []. Pin this slice's
        // text-only/no-reasoning policy explicitly rather than inheriting catalog
        // capabilities (or failing only after a native settings write).
        if(model.input===undefined || Array.isArray(model.input) && model.input.length===0) model.input=['text'];
        if(model.reasoningEfforts===undefined) model.reasoningEfforts=false;
        requireThat(JSON.stringify(model.input)==='["text"]','model-modality-not-enabled');
        requireThat(model.reasoningEfforts===false,'model-reasoning-not-enabled');
        for(const key of ['contextWindow','maxTokens']) if(model[key]!==undefined) requireThat(Number.isInteger(model[key]) && model[key]>0 && model[key]<=200000,'invalid-model-limit');
      }
      for(const key of ['timeoutMs','streamIdleTimeoutMs']) if(route[key]!==undefined) requireThat(Number.isInteger(route[key]) && route[key]>=100 && route[key]<=300000,'invalid-model-timeout');
      requireThat(route.retryPolicy===undefined,'model-retries-not-enabled');
    }
    return structuredClone(config);
  }
  async configure(principal,input) {
    fields(input,['providers','expected_revision','expected_settings_revision'],['providers','expected_revision','expected_settings_revision']);
    const work=this.configuration.then(async()=>{
      requireThat(!this.store.db.prepare("SELECT 1 FROM model_requests WHERE state IN ('admitting','queued','running')").get(),'model-turn-active');
      const current=this.state.current(),descriptor=this.descriptor();
      requireThat((current?.revision??0)===input.expected_revision && descriptor.revision===input.expected_settings_revision,'model-revision-conflict');
      const config=this.validateConfig({providers:input.providers}),revision=(this.store.db.prepare('SELECT max(revision) n FROM model_configurations').get().n??0)+1;
      this.store.db.prepare('INSERT INTO model_configurations VALUES(?,?,?,?,?,?,?)').run(revision,principal,descriptor.revision,JSON.stringify(config),sha(config),'pending',now());
      try {
        await this.ctx.settings.replace(NS,config,descriptor.revision);
        const saved=this.descriptor();this.validateConfig(saved.value);
        // Settings owns schema normalization and disk persistence. Pin its actual
        // resolved non-secret value, not a guessed projection of defaults.
        this.store.db.prepare("UPDATE model_configurations SET state='active',settings_revision=?,config_json=?,config_sha256=? WHERE revision=?").run(saved.revision,JSON.stringify(saved.value),sha(saved.value),revision);
        return this.describe();
      } catch(error) {this.store.db.prepare("UPDATE model_configurations SET state='failed' WHERE revision=?").run(revision);throw new StudioError(error.code??'model-configuration-failed');}
    });this.configuration=work.then(()=>undefined,()=>undefined);return work;
  }
  describe() {const current=this.state.current();return {revision:current?.revision??0,settings_revision:this.descriptor().revision,providers:current?JSON.parse(current.config_json).providers:{},protocols:['openai-completions'],credential_prefix:'STUDIO_MODEL_',offline_fixture:this.fixture?{kind:this.fixture.kind,baseURL:this.fixture.baseURL}:null};}
  async settingsMutation(principal,args) {
    requireThat(args.ns===NS && Number.isInteger(args.expectedRevision),'model-settings-revision-required');
    const providers=structuredClone(this.descriptor().value.providers??{});
    requireThat(Array.isArray(args.ops) && args.ops.length>=1 && args.ops.length<=32,'invalid-model-settings');
    for(const op of args.ops) {
      requireThat(Array.isArray(op.path) && op.path.length>=2 && op.path.length<=3 && op.path[0]==='providers' && /^studio-model-[a-z0-9-]+$/.test(op.path[1]),'invalid-model-settings');
      const destination=op.path.length===2?providers:providers[op.path[1]],key=op.path.at(-1);
      requireThat(destination && !['__proto__','constructor','prototype'].includes(key),'invalid-model-settings');
      if(op.op==='set') destination[key]=op.value;else if(op.op==='unset') delete destination[key];else throw new StudioError('invalid-model-settings');
    }
    await this.configure(principal,{providers,expected_revision:this.state.current()?.revision??0,expected_settings_revision:args.expectedRevision});
    // Preserve the original settings Remote's redacted namespace-view contract.
    return this.ctx.settingsController.describe().namespaces.find(view=>view.ns===NS);
  }
  content(content,binding) {
    requireThat(Array.isArray(content) && content.length>=1 && content.length<=32,'invalid-prompt');
    for(const part of content) {
      fields(part,['type','text'],['type','text']);requireThat(part.type==='text' && typeof part.text==='string' && part.text.length<=65536,'attachment-not-adapted');
      // D03/D04 snapshot bytes are data, never a current-cwd file reference.
      // Validate every embedded snapshot (including history) before dispatch.
      let offset=0;
      while((offset=part.text.indexOf(PREFIX,offset))!==-1) {
        const start=offset+PREFIX.length;let citation;
        try {const rest=part.text.slice(start);const line=rest.split('\n')[0];citation=JSON.parse(line);} catch(error) {throw new StudioError('invalid-bound-reference');}
        const identity=citation.identity;
        requireThat(identity?.binding_id===binding.binding_id && identity.version===binding.version && identity.generation===binding.instance_generation && identity.target_root===binding.target_root,'cross-binding-reference');
        requireThat(typeof citation.content==='string' && sha(citation.content)===citation.sha256 && typeof citation.strong_version==='string','invalid-bound-reference');offset=start;
      }
      requireThat(!/<file-reference\b|\[file-upload:|"receiptId"\s*:/.test(part.text),'native-reference-not-adapted');
    }
  }
  async admission(sessionId,work) {
    const pending=this.admissions??=new Map(),previous=pending.get(sessionId)??Promise.resolve(),current=previous.then(work,work);
    pending.set(sessionId,current);
    try {return await current;} finally {if(pending.get(sessionId)===current) pending.delete(sessionId);}
  }
  select(principal,input,native) {return this.admission(input.sessionId,()=>this.selectAdmitted(principal,input,native));}
  async selectAdmitted(principal,input,native) {
    const {session}=await this.authorize(principal,{session_id:input.sessionId});
    requireThat(!this.active.has(session.session_id) && !this.store.db.prepare("SELECT 1 FROM model_requests WHERE session_id=? AND state IN ('admitting','queued','running')").get(session.session_id),'model-turn-active');
    const revision=this.state.current()?.revision;this.route(input.provider,input.model,revision);
    requireThat(input.reasoningEffort===undefined,'model-reasoning-not-enabled');
    await this.studio.ensureAgent(principal,session.session_id);const result=await native();
    this.store.db.prepare('INSERT INTO model_selections VALUES(?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET provider=excluded.provider,model=excluded.model,revision=excluded.revision,updated_at=excluded.updated_at').run(session.session_id,principal,input.provider,input.model,revision,now());
    await this.ctx.sessions.flush(this.ctx.sessions.get(session.session_id));return result;
  }
  prompt(principal,input,signal,native) {return this.admission(input.sessionId,()=>this.promptAdmitted(principal,input,signal,native));}
  async promptAdmitted(principal,input,signal,native) {
    const {session,binding}=await this.authorize(principal,{session_id:input.sessionId});signal.throwIfAborted();this.content(input.content,binding);
    requireThat(input.mode==='queue','steering-not-enabled');
    let selection=this.store.db.prepare('SELECT * FROM model_selections WHERE session_id=? AND principal_id=?').get(session.session_id,principal);
    const revision=this.state.current()?.revision;
    if(!selection) {
      const agent=await this.studio.ensureAgent(principal,session.session_id);
      requireThat(!agent.session.requestHeader(),'explicit-model-selection-required');
      // The original picker displays the native saved default and does not send
      // selectModel when that same item is clicked. The authenticated Send is the
      // explicit admission: snapshot exactly that native default, never invent it.
      const nativeDefault=this.ctx.get('agentDefaultModel')?.currentSelection();
      requireThat(nativeDefault,'explicit-model-selection-required');selection={...nativeDefault,revision};
      this.route(selection.provider,selection.model,revision);
      // Native prompt assembly consumes the Agent's selected call configuration,
      // not our SQL projection. Install through the real controller before Send.
      const installed=await this.ctx.sessionController.selectModel({sessionId:session.session_id,provider:selection.provider,model:selection.model});
      requireThat(installed.selected.provider===selection.provider && installed.selected.model===selection.model,'model-request-mismatch');
      this.store.db.prepare('INSERT INTO model_selections VALUES(?,?,?,?,?,?)').run(session.session_id,principal,selection.provider,selection.model,revision,now());
      this.store.audit(principal,'model.native-default-selected',session.session_id,'selected',{revision,provider:selection.provider,model:selection.model});
    }
    // Configuration writes cannot overlap admitted work. A NEW authenticated
    // prompt snapshots the current revision; an already admitted request never moves.
    this.route(selection.provider,selection.model,revision);
    selection={...selection,revision};
    this.store.db.prepare('UPDATE model_selections SET revision=?,updated_at=? WHERE session_id=?').run(revision,now(),session.session_id);
    requireThat(typeof input.requestId==='string' && input.requestId.length<=128,'invalid-request-id');
    requireThat(!this.store.db.prepare('SELECT 1 FROM model_requests WHERE request_id=?').get(input.requestId),'prompt-replay-disabled');
    requireThat(!this.store.db.prepare("SELECT 1 FROM model_requests WHERE session_id=? AND state IN ('admitting','queued','running')").get(session.session_id),'model-turn-active');
    await this.studio.ensureAgent(principal,session.session_id);
    // Cold resume restores history, not the controller's Agent-scoped selection.
    // A NEW authenticated Send installs exactly the authorized saved route; this
    // is neither an automatic prompt replay nor a change to model configuration.
    const route=this.route(selection.provider,selection.model,revision);
    requireThat(validModelRef(route.apiKeyEnv) && (await this.ctx.credentials.resolve(route.apiKeyEnv))?.value,'model-credential-unconfigured');
    const installed=await this.ctx.sessionController.selectModel({sessionId:session.session_id,provider:selection.provider,model:selection.model});
    requireThat(installed.selected.provider===selection.provider && installed.selected.model===selection.model,'model-request-mismatch');
    this.route(selection.provider,selection.model,revision);
    signal.throwIfAborted();const stamp=now();
    this.store.db.prepare('INSERT INTO model_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(input.requestId,principal,session.session_id,binding.binding_id,binding.version,selection.revision,selection.provider,selection.model,sha(input.content),this.runId,'admitting',null,null,stamp,stamp);
    try {
      const result=await native();requireThat(result.accepted===true,'prompt-not-accepted');
      this.store.db.prepare("UPDATE model_requests SET state='queued',updated_at=? WHERE request_id=? AND state='admitting'").run(now(),input.requestId);
      await this.ctx.sessions.flush(this.ctx.sessions.get(session.session_id));return result;
    } catch(error) {this.state.transition(input.requestId,'failed',error.code??'prompt-rejected');throw error;}
  }
  async preStep({agent,messages,turn,signal}) {
    signal.throwIfAborted();const {binding}=await this.authorize(this.store.principal,{session_id:agent.session.id});
    requireThat(this.ctx.agents.get(agent.id)===agent,'native-agent-mismatch');
    if(messages.length) {
      requireThat(messages.length===1,'multiple-prompt-batch-disabled');const message=messages[0];
      requireThat(message.source?.kind==='user' && typeof message.source.rpcId==='string','unattributed-model-send');
      const request=this.state.request(this.store.principal,message.source.rpcId);
      requireThat(request.session_id===agent.session.id && request.binding_id===binding.binding_id && request.version===binding.version && request.run_id===this.runId && ['admitting','queued'].includes(request.state),'unattributed-model-send');
      this.content(message.content,binding);requireThat(sha(message.content)===request.content_sha256,'prompt-content-changed');
      this.state.transition(request.request_id,'running');this.store.db.prepare('UPDATE model_requests SET turn=? WHERE request_id=?').run(turn,request.request_id);
      this.active.set(agent.session.id,{...request,state:'running',turn,signal});
    }
    const request=await this.activeRequest(agent.session.id);requireThat(request.turn===turn,'unattributed-model-send');return request;
  }
  async activeRequest(sessionId) {
    const active=this.active.get(sessionId);requireThat(active && !active.signal.aborted,'model-turn-inactive');
    const request=this.state.request(this.store.principal,active.request_id);requireThat(request.state==='running' && request.run_id===this.runId,'model-turn-inactive');
    this.route(request.provider,request.model,request.revision);return {...request,signal:active.signal};
  }
  async *stream(options,next) {
    requireThat(isAgentLoopRequest(options) && typeof options.sessionId==='string','unattributed-model-send');
    const request=await this.activeRequest(options.sessionId),{binding}=await this.authorize(request.principal_id,{session_id:options.sessionId});
    requireThat(options.provider===request.provider && options.model===request.model && options.signal===request.signal,'model-request-mismatch');
    for(const message of options.messages) {
      if(message.role==='user') this.content(message.content,binding);
      else requireThat(message.content?.every(part=>['text','thinking','tool-call','tool-result'].includes(part.type))??true,'unknown-model-content');
    }
    const route=this.route(request.provider,request.model,request.revision),credential=await this.ctx.credentials.resolve(route.apiKeyEnv);
    requireThat(credential?.value,'model-credential-unconfigured');
    const capability=globalThis[Symbol.for('agent-studio.model-request')];requireThat(typeof capability==='function','model-network-capability-unavailable');
    const endpoint=new URL(route.baseURL.replace(/\/$/,'')+'/chat/completions');
    const iterator=next()[Symbol.asyncIterator]();let complete=false;
    try {
      while(true) {
        // A capability spans each pull, not unrelated tasks. No caller-supplied
        // endpoint, credential, redirect, retry or arbitrary network operation.
        const item=await capability({url:endpoint.href,session_id:options.sessionId,request_id:request.request_id,revision:request.revision,signal:options.signal},()=>iterator.next());
        if(item.done) {complete=true;break;}yield item.value;
      }
    } finally {if(!complete && iterator.return) await iterator.return();}
  }
  bindingUnavailable(binding,reason) {
    for(const session of this.store.list('session_bindings',binding.principal_id).filter(row=>row.binding_id===binding.binding_id && row.version===binding.version)) {
      this.cancelControls(session.session_id,reason);
      const active=this.active.get(session.session_id);if(active) active.environmentInvalidated=reason;
      this.store.db.prepare("UPDATE model_requests SET state='interrupted',error_code=?,updated_at=? WHERE session_id=? AND state IN ('admitting','queued','running')").run(reason,now(),session.session_id);
      this.ctx.agents.get(session.session_id)?.cancel({kind:'hook',reason},{keepInbox:false});
    }
  }
  cancelControls(sessionId,reason) {
    for(const [id,entry] of this.controlTimers) if(entry.session_id===sessionId) {this.state.endControl(id,'cancelled',reason);entry.controller.abort(new StudioError(reason));clearTimeout(entry.timer);this.controlTimers.delete(id);}
  }
  async cancel(principal,input,native) {
    // Stopping an already-owned native turn must remain possible after the
    // execution channel disappears. This admits no new provider operation.
    const session=this.studio.session(principal,input.sessionId),binding=this.store.binding(principal,session.binding_id,session.version);
    requireThat(MODEL_POLICIES.includes(binding.policy_version),'generation-disabled');
    this.cancelControls(input.sessionId,'session-cancelled');return native();
  }
  openControl(source,eventId) {
    const sessionId=source.context.agentId,session=this.studio.session(this.store.principal,sessionId),binding=this.store.binding(session.principal_id,session.binding_id,session.version);
    requireThat(MODEL_POLICIES.includes(binding.policy_version) && this.ctx.agents.get(sessionId)===source.request.agent,'control-agent-mismatch');
    const active=this.active.get(sessionId);requireThat(active && !active.signal.aborted,'control-turn-inactive');
    const request=this.state.request(session.principal_id,active.request_id),kind=source.event==='approval/request'?'approval':'question';
    const callId=source.request.callId??source.request.studioCallId;
    const call=this.store.db.prepare('SELECT * FROM model_tool_calls WHERE session_id=? AND call_id=? AND request_id=?').get(sessionId,callId,request.request_id);
    requireThat(call && ['pending','running'].includes(call.state),'control-call-mismatch');
    const payload=kind==='approval'?{toolName:source.request.toolName,reason:source.request.reason??''}:{questions:source.request.questions};
    const deadline=Date.now()+(this.fixture?.controlTimeoutMs??60000),controller=new AbortController();
    const control=this.state.openControl({eventId,session,binding,request,callId,kind,payload,deadline});
    const timer=setTimeout(()=>{this.state.endControl(control.control_id,'expired','deadline-expired');controller.abort(new StudioError('control-expired'));this.controlTimers.delete(control.control_id);},Math.max(1,deadline-Date.now()));timer.unref();
    this.controlTimers.set(control.control_id,{controller,timer,session_id:sessionId});
    source.request={...source.request,studioControl:{control_id:control.control_id,session_id:sessionId,binding_id:binding.binding_id,version:binding.version,deadline_ms:deadline},signal:AbortSignal.any([controller.signal,active.signal,...(source.request.signal?[source.request.signal]:[])])};
    const resolve=source.resolve,reject=source.reject;
    const finish=()=>{clearTimeout(timer);this.controlTimers.delete(control.control_id);};
    source.resolve=outcome=>{
      finish();const current=this.state.control(session.principal_id,control.control_id);
      if(outcome.kind==='result' && current.state==='answered' || outcome.kind==='result' && current.state==='rejected') {this.state.delivered(control.control_id,'delivered');resolve(outcome);}
      else {this.state.endControl(control.control_id,'cancelled','no-authenticated-answer');reject(new StudioError('control-not-delivered'));}
    };
    source.reject=error=>{finish();this.state.endControl(control.control_id,'cancelled','request-cancelled');reject(error);};
  }
  guardReply(pending,client,result) {
    requireThat(client.principal.kind==='owner' && !client.signal.aborted,'unauthorized');
    const scope=pending.source.request.studioControl;requireThat(scope && pending.source.context.agentId===scope.session_id,'control-binding-mismatch');
    this.studio.environments?.assertCached(this.store.binding(this.store.principal,scope.binding_id,scope.version));
    const row=this.state.control(this.store.principal,scope.control_id);requireThat(row.event_id===result.eventId && row.call_id===(pending.source.request.callId??pending.source.request.studioCallId),'control-instance-mismatch');
    if(result.outcome.kind!=='result') {this.state.endControl(row.control_id,'cancelled','client-delegated');return;}
    this.state.decide(this.store.principal,{control_id:row.control_id,session_id:scope.session_id,binding_id:scope.binding_id,version:scope.version},result.outcome.value);
  }
  reply(principal,input) {
    fields(input,['control_id','session_id','binding_id','version','answer'],['control_id','session_id','binding_id','version','answer']);
    this.studio.environments?.assertCached(this.store.binding(principal,input.binding_id,input.version));
    const {answer,...scope}=input,row=this.state.control(principal,scope.control_id),gateway=this.ctx.typertGateway;
    const pending=gateway.pendingRemoteEvents.get(row.event_id);requireThat(pending,'control-not-pending');
    this.state.decide(principal,scope,answer);gateway.settleRemoteEvent(pending,{kind:'result',value:answer});return {delivered:true};
  }
  dispose() {for(const sessionId of this.active.keys()) this.cancelControls(sessionId,'preview-stopped');}
}

export function prepareRemoteEvent(ctx,source,id) {
  requireThat(['approval/request','user-questions/request'].includes(source.event),'remote-event-not-enabled');
  const studio=ctx.get('agentStudio');
  if(studio?.acp?.isSource(source)) {studio.acp.openControl(source,id);return;}
  const models=studio?.models;requireThat(models,'model-not-ready');models.openControl(source,id);
}
export function guardRemoteReply(ctx,pending,client,result) {
  const studio=ctx.get('agentStudio');
  if(studio?.acp?.isSource(pending.source)) {studio.acp.guardReply(pending,client,result);return;}
  const models=studio?.models;requireThat(models,'model-not-ready');models.guardReply(pending,client,result);
}
