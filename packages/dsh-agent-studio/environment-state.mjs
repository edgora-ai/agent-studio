import {createHash,randomUUID} from 'node:crypto';
import {fields,requireThat,text,now,StudioError} from './store.mjs';

export const ENVIRONMENT_SCHEMA=`
CREATE TABLE environment_observations(
 observation_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
 source TEXT NOT NULL, observed_at TEXT NOT NULL, expires_at_ms INTEGER NOT NULL,
 status_json TEXT NOT NULL, error_code TEXT);
CREATE INDEX environment_observation_owner ON environment_observations(principal_id,workspace_id,observed_at);
CREATE TRIGGER environment_observation_immutable BEFORE UPDATE ON environment_observations BEGIN SELECT RAISE(ABORT,'immutable environment observation'); END;
CREATE TABLE environment_heads(
 principal_id TEXT NOT NULL, workspace_id TEXT NOT NULL, observation_id TEXT NOT NULL REFERENCES environment_observations,
 revision INTEGER NOT NULL, PRIMARY KEY(principal_id,workspace_id));
CREATE TABLE environment_requests(
 request_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, run_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('create','start','stop')),
 target_key TEXT NOT NULL, workspace_id TEXT, template_version_id TEXT NOT NULL,
 parameters_json TEXT NOT NULL, parameters_sha256 TEXT NOT NULL, policy_sha256 TEXT NOT NULL,
 confirmation_json TEXT NOT NULL, confirmation_deadline_ms INTEGER NOT NULL, deadline_ms INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('prepared','expired','submitting','accepted','succeeded','failed','unknown','timed-out')),
 submitted_workspace_id TEXT, build_id TEXT, result_json TEXT, error_code TEXT, attempted_at TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX environment_target_lock ON environment_requests(principal_id,target_key)
 WHERE state IN ('prepared','submitting','accepted','unknown','timed-out');
CREATE UNIQUE INDEX environment_workspace_lock ON environment_requests(principal_id,COALESCE(workspace_id,submitted_workspace_id))
 WHERE state IN ('prepared','submitting','accepted','unknown','timed-out');
CREATE TRIGGER environment_request_immutable BEFORE UPDATE OF request_id,principal_id,run_id,action,target_key,workspace_id,template_version_id,parameters_json,parameters_sha256,policy_sha256,confirmation_json,confirmation_deadline_ms,deadline_ms,created_at ON environment_requests BEGIN SELECT RAISE(ABORT,'immutable environment request'); END;
CREATE TRIGGER environment_job_immutable BEFORE UPDATE OF submitted_workspace_id,build_id ON environment_requests
 WHEN OLD.build_id IS NOT NULL AND (NEW.build_id IS NOT OLD.build_id OR NEW.submitted_workspace_id IS NOT OLD.submitted_workspace_id)
 BEGIN SELECT RAISE(ABORT,'immutable environment job'); END;
CREATE TRIGGER environment_attempt_once BEFORE UPDATE OF attempted_at ON environment_requests
 WHEN OLD.attempted_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'environment submission already attempted'); END;
CREATE TABLE environment_links(
 request_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, input_json TEXT NOT NULL,
 observation_id TEXT NOT NULL REFERENCES environment_observations,
 state TEXT NOT NULL CHECK(state IN ('opening','ready','failed','interrupted')),
 project_id TEXT, environment_id TEXT, binding_id TEXT, version INTEGER, session_id TEXT,
 error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TRIGGER environment_link_identity BEFORE UPDATE OF request_id,principal_id,input_json,observation_id,created_at ON environment_links BEGIN SELECT RAISE(ABORT,'immutable environment link'); END;
`;
export const canonical=value=>JSON.stringify(value && typeof value==='object' && !Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,JSON.parse(canonical(value[key]))])):Array.isArray(value)?value.map(item=>JSON.parse(canonical(item))):value);
export const digest=value=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
export const uuid=value=>typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const plain=row=>row?{...row}:undefined;
export const liveRequest=row=>['prepared','submitting','accepted','unknown','timed-out'].includes(row.state);

export function validateEnvironmentPolicy(policy) {
 fields(policy,['version','transport','read_only','owner_id','owner_name','organization_id','workspace_ids','actions','templates','observation_ttl_ms','action_timeout_ms'],['version','transport','read_only','owner_id','owner_name','organization_id','workspace_ids','actions','templates','observation_ttl_ms','action_timeout_ms']);
 requireThat(policy.version===1 && policy.transport==='coder-lab-v1' && typeof policy.read_only==='boolean' && uuid(policy.owner_id) && uuid(policy.organization_id) && policy.owner_name==='lab-owner','environment-policy-invalid');
 requireThat(Array.isArray(policy.workspace_ids) && policy.workspace_ids.length<=16 && policy.workspace_ids.every(uuid),'environment-policy-targets');
 requireThat(Array.isArray(policy.actions) && policy.actions.every(action=>['create','start','stop'].includes(action)) && (!policy.read_only || policy.actions.length===0),'environment-policy-actions');
 requireThat(Number.isInteger(policy.observation_ttl_ms) && policy.observation_ttl_ms>=1000 && policy.observation_ttl_ms<=60000 && Number.isInteger(policy.action_timeout_ms) && policy.action_timeout_ms>=1000 && policy.action_timeout_ms<=300000,'environment-policy-deadline');
 requireThat(Array.isArray(policy.templates) && policy.templates.length>0 && policy.templates.length<=8,'environment-policy-templates');
 for(const template of policy.templates) {
  fields(template,['template_id','version_id','name','template_version','roots','image_id','parameters','create_names'],['template_id','version_id','name','template_version','roots','image_id','parameters','create_names']);
  requireThat(uuid(template.template_id) && uuid(template.version_id) && text(template.name,'template-name',80) && text(template.template_version,'template-version',80) && /^sha256:[a-f0-9]{64}$/.test(template.image_id),'environment-policy-template');
  requireThat(canonical(template.roots)==='["/workspace"]' && Array.isArray(template.parameters) && template.parameters.length<=16,'environment-policy-roots-or-parameters');
  for(const parameter of template.parameters) {fields(parameter,['name','value'],['name','value']);requireThat(/^[a-z][a-z0-9_]{0,63}$/.test(parameter.name) && !/secret|token|password|credential|key/i.test(parameter.name) && typeof parameter.value==='string' && parameter.value.length<=1024,'environment-policy-parameter');}
  requireThat(Array.isArray(template.create_names) && template.create_names.length<=4 && template.create_names.every(name=>typeof name==='string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(name) && !['new','create'].includes(name)),'environment-policy-names');
 }
 requireThat(new Set(policy.templates.map(template=>template.version_id)).size===policy.templates.length,'environment-policy-duplicate');return policy;
}

export class EnvironmentState {
 constructor(store,runId,clock=Date.now) {this.store=store;this.db=store.db;this.runId=runId;this.clock=clock;}
 owner(principal) {requireThat(principal===this.store.principal,'environment-owner-denied');}
 restart() {
  this.db.prepare("UPDATE environment_requests SET state='unknown',error_code='preview-restarted-no-replay',updated_at=? WHERE state IN ('submitting','accepted')").run(now());
  this.db.prepare("UPDATE environment_requests SET state='expired',error_code='preview-restarted',updated_at=? WHERE state='prepared'").run(now());
  this.db.prepare("UPDATE environment_links SET state='interrupted',error_code='preview-restarted-no-replay',updated_at=? WHERE state='opening'").run(now());
 }
 observe(principal,status,source='coder-control-plane',error=null,ttl=30000) {
  this.owner(principal);requireThat(uuid(status.workspace_id),'environment-observation-target');
  const row={observation_id:'observation-'+randomUUID(),principal_id:principal,workspace_id:status.workspace_id,source,observed_at:now(),expires_at_ms:this.clock()+ttl,status_json:canonical(status),error_code:error};
  requireThat(Buffer.byteLength(row.status_json)<=65536,'environment-observation-limit');
  this.store.transaction(()=>{this.db.prepare('INSERT INTO environment_observations VALUES(?,?,?,?,?,?,?,?)').run(...Object.values(row));this.db.prepare('INSERT INTO environment_heads VALUES(?,?,?,1) ON CONFLICT(principal_id,workspace_id) DO UPDATE SET observation_id=excluded.observation_id,revision=revision+1').run(principal,status.workspace_id,row.observation_id);});return row;
 }
 observation(principal,id) {this.owner(principal);const row=plain(this.db.prepare('SELECT * FROM environment_observations WHERE observation_id=? AND principal_id=?').get(text(id,'observation_id'),principal));requireThat(row,'environment-observation-not-found');return row;}
 latest(principal,workspaceId) {this.owner(principal);return plain(this.db.prepare('SELECT o.* FROM environment_heads h JOIN environment_observations o USING(observation_id) WHERE h.principal_id=? AND h.workspace_id=?').get(principal,workspaceId));}
 observations(principal,workspaceId) {this.owner(principal);return this.db.prepare('SELECT * FROM environment_observations WHERE principal_id=? AND workspace_id=? ORDER BY rowid').all(principal,workspaceId).map(plain);}
 fresh(principal,workspaceId) {const row=this.latest(principal,workspaceId);requireThat(row && !row.error_code && row.expires_at_ms>this.clock(),'environment-observation-stale');return {row,status:JSON.parse(row.status_json)};}
 request(principal,requestId) {this.owner(principal);const row=plain(this.db.prepare('SELECT * FROM environment_requests WHERE request_id=? AND principal_id=?').get(text(requestId,'request_id',128),principal));requireThat(row,'environment-request-not-found');return row;}
 requests(principal) {this.owner(principal);this.expire();return this.db.prepare('SELECT * FROM environment_requests WHERE principal_id=? ORDER BY created_at,rowid').all(principal).map(plain);}
 expire() {this.db.prepare("UPDATE environment_requests SET state='expired',error_code='confirmation-expired',updated_at=? WHERE state='prepared' AND confirmation_deadline_ms<=?").run(now(),this.clock());}
 prepare(principal,input,policy) {
  this.owner(principal);fields(input,['request_id','action','workspace_id','template_version_id','name'],['request_id','action','template_version_id']);
  requireThat(/^[A-Za-z0-9_-]{8,128}$/.test(input.request_id),'environment-request-id');requireThat(['create','start','stop'].includes(input.action),'environment-action-unsupported');
  const serialized=canonical(input),hash=digest(serialized),previous=this.db.prepare('SELECT * FROM environment_requests WHERE request_id=?').get(input.request_id);
  if(previous) {requireThat(previous.principal_id===principal && previous.parameters_sha256===hash,'environment-request-conflict');return plain(previous);}
  requireThat(!policy.read_only && policy.actions.includes(input.action),'environment-read-only');
  const template=policy.templates.find(row=>row.version_id===input.template_version_id);requireThat(template,'environment-template-denied');
  let target,name,workspaceId=null;
  if(input.action==='create') {requireThat(input.workspace_id===undefined && template.create_names.includes(input.name),'environment-create-target-denied');name=input.name;target='name:'+policy.owner_id+':'+name;}
  else {
   requireThat(uuid(input.workspace_id) && input.name===undefined && (policy.workspace_ids.includes(input.workspace_id) || this.db.prepare("SELECT 1 FROM environment_requests WHERE principal_id=? AND action='create' AND state='succeeded' AND submitted_workspace_id=?").get(principal,input.workspace_id)),'environment-target-denied');
   const {status}=this.fresh(principal,input.workspace_id);
   requireThat(status.owner_id===policy.owner_id && status.template_id===template.template_id && status.template_version_id===template.version_id,'environment-target-changed');
   requireThat(input.action==='start'?status.lifecycle==='stopped':status.lifecycle==='running','environment-action-state');
   workspaceId=input.workspace_id;name=status.name;target='workspace:'+workspaceId;
  }
  this.expire();requireThat(!this.db.prepare("SELECT 1 FROM environment_requests WHERE principal_id=? AND (target_key=? OR COALESCE(workspace_id,submitted_workspace_id)=?) AND state IN ('prepared','submitting','accepted','unknown','timed-out')").get(principal,target,workspaceId),'environment-target-busy');
  const timestamp=now(),deadline=this.clock()+Math.min(60000,policy.action_timeout_ms);
  const confirmation={action:input.action,target:name,workspace_id:workspaceId,template_version_id:template.version_id,parameters_sha256:hash,expires_at_ms:deadline,phrase:input.action.toUpperCase()+' '+name,effects:input.action==='create'?'Create one approved workspace and its persistent resources.':input.action==='start'?'Start the named workspace; resources may be allocated.':'Stop the named workspace and its running tasks. Do not delete its persistent volume or workspace record.'};
  const row={request_id:input.request_id,principal_id:principal,run_id:this.runId,action:input.action,target_key:target,workspace_id:workspaceId,template_version_id:template.version_id,parameters_json:serialized,parameters_sha256:hash,policy_sha256:digest(policy),confirmation_json:canonical(confirmation),confirmation_deadline_ms:deadline,deadline_ms:this.clock()+policy.action_timeout_ms,state:'prepared',submitted_workspace_id:null,build_id:null,result_json:null,error_code:null,attempted_at:null,created_at:timestamp,updated_at:timestamp};
  this.store.transaction(()=>{this.db.prepare('INSERT INTO environment_requests VALUES('+Object.keys(row).map(()=>'?').join(',')+')').run(...Object.values(row));this.store.audit(principal,'environment.prepare',row.request_id,'prepared',{action:row.action,target:row.target_key});});return row;
 }
 confirm(principal,input,policy) {
  this.owner(principal);fields(input,['request_id','parameters_sha256','phrase'],['request_id','parameters_sha256','phrase']);this.expire();const row=this.request(principal,input.request_id),confirmation=JSON.parse(row.confirmation_json);
  requireThat(!policy.read_only && policy.actions.includes(row.action) && row.policy_sha256===digest(policy),'environment-read-only-or-policy-changed');
  requireThat(row.run_id===this.runId && row.state==='prepared' && this.clock()<row.confirmation_deadline_ms,'environment-confirmation-expired-or-consumed');
  requireThat(input.parameters_sha256===row.parameters_sha256 && input.phrase===confirmation.phrase,'environment-confirmation-mismatch');
  const changed=this.db.prepare("UPDATE environment_requests SET state='submitting',updated_at=? WHERE request_id=? AND state='prepared'").run(now(),row.request_id);requireThat(changed.changes===1,'environment-confirmation-consumed');return this.request(principal,row.request_id);
 }
 claimAttempt(principal,requestId) {
  const row=this.request(principal,requestId);requireThat(row.state==='submitting' && row.deadline_ms>this.clock(),'environment-request-not-submitting');
  const changed=this.db.prepare("UPDATE environment_requests SET attempted_at=? WHERE request_id=? AND attempted_at IS NULL AND state='submitting'").run(now(),requestId);requireThat(changed.changes===1,'environment-already-attempted');return this.request(principal,requestId);
 }
 update(principal,requestId,changes) {
  this.owner(principal);fields(changes,['state','submitted_workspace_id','build_id','result_json','error_code']);const entries=Object.entries(changes);requireThat(entries.length>0,'environment-empty-update');
  this.db.prepare('UPDATE environment_requests SET '+entries.map(([key])=>key+'=?').join(',')+',updated_at=? WHERE request_id=? AND principal_id=?').run(...entries.map(([,value])=>value),now(),requestId,principal);return this.request(principal,requestId);
 }
 assertDispatch(binding) {
  const instance=this.db.prepare('SELECT workspace_id FROM instance_records WHERE record_id=?').get(binding.record_id);if(!instance) throw new StudioError('environment-instance-missing');
  const row=this.latest(binding.principal_id,instance.workspace_id);requireThat(row && !row.error_code && row.expires_at_ms>this.clock(),'environment-observation-stale');
  const status=JSON.parse(row.status_json);requireThat(status.lifecycle==='running' && status.job.status==='succeeded' && status.agent.status==='connected' && status.identity?.verified===true,'environment-suspended');
  requireThat(status.identity.generation===binding.instance_generation,'environment-generation-changed');return status;
 }
}
