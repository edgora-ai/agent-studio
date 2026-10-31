import {readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {EnvironmentState,validateEnvironmentPolicy,canonical,digest,uuid} from './environment-state.mjs';
import {EnvironmentBroker} from './adapters/environment-broker.mjs';
import {fields,requireThat,StudioError,now,id} from './store.mjs';

const safe=error=>error instanceof StudioError?error.code:'environment-observation-failed';
const ready=status=>!status.error_code && status.lifecycle==='running' && status.job?.status==='succeeded' && status.agent?.status==='connected' && status.identity?.verified===true;
const plain=row=>row?{...row}:undefined;

export class EnvironmentManager {
 constructor(studio,{transport=new EnvironmentBroker(),policy,clock=Date.now}={}) {
  this.studio=studio;this.store=studio.store;this.db=this.store.db;this.transport=transport;this.fixedPolicy=policy;this.clock=clock;
  this.state=new EnvironmentState(this.store,process.env.AGENT_STUDIO_RUN_ID??'offline-fixture',clock);this.pending=new Map();this.lastRefresh=0;this.closed=false;this.expiredHeads=new Set();
 }
 async policy() {
  if(this.fixedPolicy) return validateEnvironmentPolicy(structuredClone(this.fixedPolicy));
  const file=join(this.studio.root,'environment-policy.json'),info=await lstat(file);
  requireThat(info.isFile() && !info.isSymbolicLink() && (info.mode&0o077)===0 && info.size<=65536,'environment-policy-file');
  return validateEnvironmentPolicy(JSON.parse(await readFile(file,'utf8')));
 }
 async initialize({schedule=true}={}) {
  this.state.restart();try {this.currentPolicy=await this.policy();} catch(error) {if(error.code!=='ENOENT') throw error;return;}
  this.store.environmentGate=(principal,session,kind)=>{
   const binding=this.store.binding(principal,session.binding_id,session.version);this.assertCached(binding);
  };
  if(schedule) {this.timer=setInterval(()=>{void this.tick();},1000);this.timer.unref();}
 }
 bindings(workspaceId) {return this.db.prepare('SELECT b.* FROM project_bindings b JOIN instance_records i USING(record_id) WHERE i.workspace_id=? AND b.principal_id=?').all(workspaceId,this.store.principal).map(plain);}
 managed(binding) {const environment=this.store.get('environments','environment_id',binding.environment_id,binding.principal_id);return environment.provider==='coder-helper' && Boolean(this.currentPolicy);}
 assertCached(binding) {if(this.managed(binding)) {
  requireThat(this.store.binding(binding.principal_id,binding.binding_id,binding.version).state==='ready','environment-binding-revoked');
  const workspaceId=this.instance(binding).workspace_id;
  requireThat(!this.db.prepare("SELECT 1 FROM environment_requests WHERE principal_id=? AND COALESCE(workspace_id,submitted_workspace_id)=? AND state IN ('submitting','accepted','unknown','timed-out')").get(binding.principal_id,workspaceId),'environment-lifecycle-pending');
  this.state.assertDispatch(binding);this.assertPolicy(binding,JSON.parse(this.state.latest(binding.principal_id,workspaceId).status_json));
 }}
 effectiveSpec(binding,spec) {
  if(!spec || !this.managed(binding)) return spec;
  const record=this.instance(binding);requireThat(record.environment_id===binding.environment_id && record.instance_generation===binding.instance_generation && record.policy_version===binding.policy_version,'environment-instance-snapshot-mismatch');
  return {...spec,generation:record.instance_generation,roots:JSON.parse(record.allowed_roots_json),policy_version:record.policy_version};
 }
 instance(binding) {return plain(this.db.prepare('SELECT * FROM instance_records WHERE record_id=?').get(binding.record_id));}
 assertPolicy(binding,status) {
  const instance=this.instance(binding),environment=this.store.get('environments','environment_id',binding.environment_id,binding.principal_id),spec=this.studio.catalog.find(item=>item.key===environment.catalog_key),marker=status.identity?.record?.marker;
  const p=this.currentPolicy,allowed=p.templates.find(template=>template.version_id===status.template_version_id && template.template_id===status.template_id);
  requireThat(status.owner_id===p.owner_id && status.organization_id===p.organization_id && (p.workspace_ids.includes(status.workspace_id) || this.db.prepare("SELECT 1 FROM environment_requests WHERE principal_id=? AND action='create' AND state='succeeded' AND submitted_workspace_id=?").get(binding.principal_id,status.workspace_id)) && allowed,'environment-operator-policy-revoked');
  requireThat(allowed.roots.includes(marker?.root) && allowed.image_id===marker?.imageId,'environment-operator-policy-revoked');
  requireThat(spec && status.template_version_id===spec.expected?.templateVersionId && instance.template_version===spec.template_version && binding.policy_version===spec.policy_version,'environment-policy-changed');
  requireThat(marker && JSON.parse(instance.allowed_roots_json).includes(marker.root) && marker.policyVersion===spec.expected.marker.policyVersion && marker.imageId===spec.expected.marker.imageId && marker.uid===spec.expected.marker.uid,'environment-instance-policy-changed');
 }
 async admit(binding) {
  if(!this.managed(binding)) return;
  const instance=this.instance(binding),row=this.state.latest(binding.principal_id,instance.workspace_id);
  // Do not admit a new dispatch on a nearly expired directory observation:
  // current-channel identity checks themselves take time on the real broker.
  if(!row || row.expires_at_ms-this.clock()<=this.currentPolicy.observation_ttl_ms/2) await this.refresh(binding.principal_id,{});
  this.assertCached(binding);
 }
 unavailable(binding,reason,{revoke=false}={}) {
  // Transient loss does not erase channel/process identities or invalidate an
  // immutable binding. Original task recovery is a separate explicit operation.
  if(revoke && ['ready','pending'].includes(binding.state)) this.store.failBinding(binding,reason);
  this.studio.models?.bindingUnavailable(binding,reason);
  this.studio.acp?.channelLost(binding,new StudioError(reason));
  this.db.prepare("UPDATE operation_records SET state='unknown',error_code=?,updated_at=? WHERE binding_id=? AND version=? AND state IN ('pending','running')").run(reason,now(),binding.binding_id,binding.version);
  this.studio.provider?.suspend(binding,reason);
  if(revoke) this.studio.recovery?.revoke(binding,reason);
  this.store.audit(binding.principal_id,'environment.unavailable',`${binding.binding_id}@${binding.version}`,revoke?'revoked':'paused',{reason,recovery_identity_preserved:!revoke});
 }
 headRevision(workspaceId) {return this.db.prepare('SELECT revision FROM environment_heads WHERE principal_id=? AND workspace_id=?').get(this.store.principal,workspaceId)?.revision??0;}
 ingest(status,source,{expectedRevision}={}) {
  if(this.closed) return null;
  const principal=this.store.principal,p=this.currentPolicy;
  if(expectedRevision!==undefined && this.headRevision(status.workspace_id)!==expectedRevision) {
   this.store.audit(principal,'environment.observation-discarded',status.workspace_id,'newer-observation-preserved',{source,expectedRevision,currentRevision:this.headRevision(status.workspace_id)});return null;
  }
  requireThat(uuid(status.workspace_id) && (p.workspace_ids.includes(status.workspace_id) || this.db.prepare("SELECT 1 FROM environment_requests WHERE principal_id=? AND submitted_workspace_id=?").get(principal,status.workspace_id)),'environment-observation-target-denied');
  requireThat(status.owner_id===p.owner_id,'environment-observation-owner-denied');
  const previous=this.state.latest(principal,status.workspace_id),row=this.state.observe(principal,status,source,status.error_code??null,p.observation_ttl_ms);
  for(const binding of this.bindings(status.workspace_id).filter(item=>item.state==='ready')) {
   let reason,revoke=false;
   if(['environment-template-denied','D07_INSTANCE_POLICY_CHANGED','D07_FROZEN_TEMPLATE_CHANGED'].includes(status.error_code)) {reason=status.error_code;revoke=true;}
   if(status.identity?.verified && status.identity.generation!==binding.instance_generation) {reason='environment-generation-changed';revoke=true;}
   else if(status.identity?.verified) {try {this.assertPolicy(binding,status);} catch(error) {reason=safe(error);revoke=true;}}
   if(!reason && !ready(status)) reason=status.error_code??'environment-suspended';
   const channel=this.studio.provider?.channels.get(`${binding.binding_id}@${binding.version}`);
   if(!reason && channel?.connected && channel.proof.agent_id!==status.agent.id) reason='environment-agent-reauthentication-required';
   if(reason && (revoke || channel?.connected || !previous || digest(JSON.parse(previous.status_json))!==digest(status))) this.unavailable(binding,reason,{revoke});
  }
  return row;
 }
 async refresh(principal,input) {
  this.state.owner(principal);fields(input,[]);requireThat(!this.closed,'environment-manager-closed');requireThat(this.currentPolicy,'environment-not-configured');
  if(!this.refreshing) this.refreshing=(async()=>{
   const policy=await this.policy();this.currentPolicy=policy;
   const revisions=new Map(this.db.prepare('SELECT workspace_id,revision FROM environment_heads WHERE principal_id=?').all(principal).map(row=>[row.workspace_id,row.revision]));
   for(const binding of this.store.list('project_bindings',principal).filter(row=>row.state==='ready' && this.managed(row))) {
    const old=this.state.latest(principal,this.instance(binding).workspace_id);
    if(old && JSON.parse(old.status_json).identity?.verified) {try {this.assertPolicy(binding,JSON.parse(old.status_json));} catch(error) {if(safe(error)==='environment-operator-policy-revoked') this.unavailable(binding,safe(error),{revoke:true});}}
   }
   try {
    const response=await this.transport.discover();if(this.closed) return;
    requireThat(response.complete===true && response.policy_sha256===digest(policy) && digest(this.currentPolicy)===digest(policy) && response.workspaces.length<=100,'environment-directory-invalid');
    for(const status of response.workspaces) this.ingest(status,response.source,{expectedRevision:revisions.get(status.workspace_id)??0});
    this.server=response.server;this.templates=response.templates;this.lastError=null;this.lastRefresh=this.clock();
   } catch(error) {
    if(this.closed) return;
    this.lastError=safe(error);this.lastRefresh=this.clock();
    for(const workspaceId of policy.workspace_ids) {
     const old=this.state.latest(principal,workspaceId),status=old?JSON.parse(old.status_json):{workspace_id:workspaceId,owner_id:policy.owner_id,name:'Unavailable approved workspace'};
     this.ingest({...status,error_code:this.lastError,identity:{verified:false,generation:status.identity?.generation??null}},'control-plane-query-failed',{expectedRevision:revisions.get(workspaceId)??0});
    }
   }
  })().finally(()=>{this.refreshing=null;});
  await this.refreshing;return this.describe(principal,{});
 }
 describe(principal,input) {
  this.state.owner(principal);fields(input,[]);const p=this.currentPolicy;
  const rows=this.db.prepare('SELECT o.*,h.revision FROM environment_heads h JOIN environment_observations o USING(observation_id) WHERE h.principal_id=? ORDER BY o.workspace_id').all(principal).map(row=>{
   const status=JSON.parse(row.status_json),bindings=this.bindings(row.workspace_id),environments=this.store.list('environments',principal).filter(env=>this.studio.catalog.some(spec=>spec.key===env.catalog_key && spec.workspace_id===row.workspace_id));
   return {...plain(row),status,stale:row.expires_at_ms<=this.clock(),registrations:environments.map(env=>({...env,registration_not_live_status:true})),bindings:bindings.map(binding=>({...binding,channel:this.studio.provider?.status(binding)??{connected:false},sessions:this.store.list('session_bindings',principal).filter(session=>session.binding_id===binding.binding_id && session.version===binding.version)}))};
  });
  return {configured:Boolean(p),read_only:p?.read_only??true,actions:p?.actions??[],templates:this.templates??p?.templates??[],server:this.server??null,workspaces:rows,error:this.lastError??null,requests:this.state.requests(principal),recovery:'Original task recovery not implemented; connect starts a newly authenticated channel, never replays a task.'};
 }
 observations(principal,input) {fields(input,['workspace_id'],['workspace_id']);requireThat(uuid(input.workspace_id),'environment-target-denied');return this.state.observations(principal,input.workspace_id);}
 async prepare(principal,input) {this.currentPolicy=await this.policy();return this.state.prepare(principal,input,this.currentPolicy);}
 async confirm(principal,input) {
  const policy=await this.policy();this.currentPolicy=policy;const row=this.state.confirm(principal,input,policy);
  const work=this.execute(principal,row).finally(()=>this.pending.delete(row.request_id));this.pending.set(row.request_id,work);return row;
 }
 async execute(principal,row) {
  try {
   // A confirmed stop pauses new work and invalidates decisions immediately.
   // Unobserved remote processes remain unknown, never reported as cancelled.
   if(row.action==='stop') for(const binding of this.bindings(row.workspace_id)) this.unavailable(binding,'environment-stop-confirmed');
   const result=await this.transport.submit(row.request_id);
   requireThat(['accepted','unknown'].includes(result.outcome),'environment-submission-response-invalid');
   if(result.outcome==='unknown') return this.state.update(principal,row.request_id,{state:'unknown',error_code:result.error_code??'environment-submission-unknown'});
   requireThat(uuid(result.workspace_id) && uuid(result.build_id) && (!row.workspace_id || result.workspace_id===row.workspace_id),'environment-submission-target-mismatch');
   return this.state.update(principal,row.request_id,{state:'accepted',submitted_workspace_id:result.workspace_id,build_id:result.build_id,result_json:canonical(result),error_code:null});
  } catch(error) {
   const attempted=this.state.request(principal,row.request_id).attempted_at;
   return this.state.update(principal,row.request_id,{state:attempted?'unknown':'failed',error_code:safe(error)});
  }
 }
 async poll(principal,input) {
  this.state.owner(principal);fields(input,['request_id'],['request_id']);const row=this.state.request(principal,input.request_id);
  if(!['accepted','unknown','timed-out'].includes(row.state) || !row.build_id) return row;
  if(row.deadline_ms<=this.clock()) return this.state.update(principal,row.request_id,{state:'timed-out',error_code:'environment-action-deadline'});
  try {
   const expectedRevision=this.headRevision(row.submitted_workspace_id),result=await this.transport.poll(row.request_id);
   if(this.closed) return this.state.request(principal,row.request_id);
   const latest=this.state.request(principal,row.request_id);if(!['accepted','unknown','timed-out'].includes(latest.state)) return latest;
   requireThat(result.build.id===row.build_id && result.workspace.workspace_id===row.submitted_workspace_id,'environment-job-mismatch');
   requireThat(this.ingest(result.workspace,'coder-build-poll',{expectedRevision}),'environment-observation-superseded');let state='accepted',error=null;
   if(!result.current_build) {state='unknown';error='environment-build-superseded';}
   else if(['failed','canceled'].includes(result.build.job?.status)) {state='failed';error='environment-build-failed';}
   else if(row.action==='stop'?result.build.job?.status==='succeeded' && result.workspace.lifecycle==='stopped':ready(result.workspace)) state='succeeded';
   return this.state.update(principal,row.request_id,{state,result_json:canonical(result),error_code:error});
  } catch(error) {const latest=this.state.request(principal,row.request_id);if(this.closed || !['accepted','unknown','timed-out'].includes(latest.state)) return latest;return this.state.update(principal,row.request_id,{state:'unknown',error_code:safe(error)});}
 }
 request(principal,input) {fields(input,['request_id'],['request_id']);return this.state.request(principal,input.request_id);}
 registerObservation(principal,observation,environmentId) {
  const status=JSON.parse(observation.status_json),specs=this.studio.catalog.filter(spec=>spec.provider==='coder-helper' && spec.workspace_id===status.workspace_id);
  const existing=environmentId?this.store.get('environments','environment_id',environmentId,principal):null;
  const spec=existing?specs.find(item=>item.key===existing.catalog_key):specs[0];requireThat(spec,'environment-connection-catalog-unavailable');
  const environment=existing??this.store.environment(principal,spec),latest=this.db.prepare('SELECT * FROM instance_records WHERE environment_id=? ORDER BY rowid DESC LIMIT 1').get(environment.environment_id);
  const marker=status.identity.record.marker;
  requireThat(spec.expected.templateVersionId===status.template_version_id && spec.roots.includes(marker.root) && spec.expected.marker.imageId===marker.imageId && spec.expected.marker.policyVersion===marker.policyVersion,'environment-connection-policy-changed');
  if(latest.instance_generation!==status.identity.generation || latest.policy_version!==spec.policy_version || latest.allowed_roots_json!==JSON.stringify(spec.roots)) this.store.transaction(()=>{
   this.db.prepare('INSERT INTO instance_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id('instance'),environment.environment_id,principal,status.workspace_id,status.agent.id,status.identity.generation,null,spec.template_version,JSON.stringify(spec.roots),spec.policy_version,'environment-observation:'+observation.observation_id,'control-plane-verified-channel-required',now());
   this.store.audit(principal,'environment.instance-appended',environment.environment_id,'channel-verification-required',{observation_id:observation.observation_id,generation:status.identity.generation});
  });
  return environment;
 }
 async open(principal,input) {
  this.state.owner(principal);fields(input,['request_id','workspace_id','observation_id','environment_id','binding_id','expected_version','session_id','renew','project_name'],['request_id','workspace_id','observation_id']);
  requireThat(/^[A-Za-z0-9_-]{8,128}$/.test(input.request_id) && uuid(input.workspace_id) && (input.renew===undefined || typeof input.renew==='boolean'),'environment-link-input');
  const previous=this.db.prepare('SELECT * FROM environment_links WHERE request_id=?').get(input.request_id),serialized=canonical(input);
  if(previous) {requireThat(previous.principal_id===principal && previous.input_json===serialized,'environment-link-conflict');return plain(previous);}
  requireThat(!this.db.prepare("SELECT 1 FROM environment_links WHERE principal_id=? AND state='opening'").get(principal),'environment-link-busy');
  await this.refresh(principal,{});const selected=this.state.observation(principal,input.observation_id),current=this.state.fresh(principal,input.workspace_id);
  requireThat(selected.workspace_id===input.workspace_id && !selected.error_code && selected.expires_at_ms>this.clock(),'environment-selection-expired');
  const selectedStatus=JSON.parse(selected.status_json);requireThat(ready(current.status) && ready(selectedStatus) && digest(selectedStatus.identity)===digest(current.status.identity),'environment-selection-changed');
  const stamp=now();this.db.prepare('INSERT INTO environment_links VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(input.request_id,principal,serialized,current.row.observation_id,'opening',null,null,null,null,null,null,stamp,stamp);
  const update=changes=>{const entries=Object.entries(changes);this.db.prepare('UPDATE environment_links SET '+entries.map(([key])=>key+'=?').join(',')+',updated_at=? WHERE request_id=?').run(...entries.map(([,value])=>value),now(),input.request_id);};
  try {
   let binding,session;const old=input.binding_id?this.store.binding(principal,input.binding_id,input.expected_version):null;
   requireThat(!input.session_id || old && input.renew!==true,'environment-session-binding-required');
   const environment=this.registerObservation(principal,current.row,input.environment_id??old?.environment_id);update({environment_id:environment.environment_id});
   if(old && input.renew!==true) {requireThat(old.environment_id===environment.environment_id && old.state==='ready' && old.instance_generation===current.status.identity.generation,'environment-new-binding-version-required');binding=old;}
   else {
    requireThat(!old || old.environment_id===environment.environment_id,'environment-binding-mismatch');
    const project=old?this.store.get('projects','project_id',old.project_id,principal):this.store.project(principal,{name:input.project_name??current.status.name+' project'});update({project_id:project.project_id});
    binding=await this.studio.createBinding(principal,{project_id:project.project_id,environment_id:environment.environment_id,...(old?{binding_id:old.binding_id,expected_version:old.version}:{})});
   }
   update({binding_id:binding.binding_id,version:binding.version,project_id:binding.project_id});
   if(input.session_id) {session=this.studio.session(principal,input.session_id);requireThat(session.binding_id===binding.binding_id && session.version===binding.version && session.state==='ready','environment-session-mismatch');}
   else session=await this.studio.createSession(principal,{binding_id:binding.binding_id,version:binding.version,title:current.status.name+' · environment'});
   update({session_id:session.session_id});await this.studio.provider.connect(principal,{session_id:session.session_id});update({state:'ready'});
  } catch(error) {update({state:'failed',error_code:safe(error)});}
  return this.link(principal,{request_id:input.request_id});
 }
 link(principal,input) {this.state.owner(principal);fields(input,['request_id'],['request_id']);const row=plain(this.db.prepare('SELECT * FROM environment_links WHERE request_id=? AND principal_id=?').get(input.request_id,principal));requireThat(row,'environment-link-not-found');return row;}
 async tick() {
  if(this.closed || !this.currentPolicy) return;
  for(const row of this.db.prepare('SELECT o.* FROM environment_heads h JOIN environment_observations o USING(observation_id) WHERE h.principal_id=? AND o.expires_at_ms<=?').all(this.store.principal,this.clock())) {
   if(this.expiredHeads.has(row.observation_id)) continue;this.expiredHeads.add(row.observation_id);
   for(const binding of this.bindings(row.workspace_id).filter(item=>item.state==='ready')) this.unavailable(binding,'environment-observation-stale');
  }
  if(this.ticking) return;this.ticking=true;
  try {
   const active=this.db.prepare("SELECT 1 FROM operation_records WHERE state IN ('pending','running') AND channel_id IS NOT NULL UNION ALL SELECT 1 FROM model_requests WHERE state IN ('admitting','queued','running') LIMIT 1").get();
   const connected=[...(this.studio.provider?.channels.values()??[])].some(channel=>channel.connected);
   if((active || connected) && this.clock()-this.lastRefresh>=this.currentPolicy.observation_ttl_ms/2) await this.refresh(this.store.principal,{});
   if(this.closed) return;
   for(const row of this.state.requests(this.store.principal)) if(row.state==='accepted') await this.poll(this.store.principal,{request_id:row.request_id});
  } catch(error) {this.lastError=safe(error);} finally {this.ticking=false;}
 }
 async dispose() {this.closed=true;clearInterval(this.timer);await Promise.allSettled([...this.pending.values(),...(this.refreshing?[this.refreshing]:[])]);}
}
