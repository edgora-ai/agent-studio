import {readFile,lstat} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fields,requireThat,StudioError} from './store.mjs';
import {ACP_POLICIES,acpOperationContext} from './acp-state.mjs';
import {validAcpRef} from './credentials.mjs';

const tickets=new WeakMap();
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const hash=value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const text=(value,max=8192)=>typeof value==='string' && value.length>0 && value.length<=max && !value.includes('\0');
const executable=value=>text(value,4096) && isAbsolute(value) && !value.split('/').some(p=>p==='.'||p==='..');
const envName=value=>/^[A-Z][A-Z0-9_]{1,79}$/.test(value) && !/^(?:PATH$|HOME$|LANG$|LC_ALL$|TMPDIR$|XDG_|LD_|DYLD_|PYTHON|NODE_|CODER_|SSH_|DSH_|BASH_ENV$|ENV$)/.test(value);
export function validateBackend(row) {
  fields(row,['id','name','version','protocol','kinds','policies','executable','executable_sha256','argv','credential_refs','environment','offline_fixture','bootstrap','assets'],['id','name','version','protocol','kinds','policies','executable','executable_sha256','argv','credential_refs','environment','offline_fixture','bootstrap','assets']);
  requireThat(/^[a-z][a-z0-9-]{0,70}$/.test(row.id) && text(row.name,256) && text(row.version,100) && row.protocol==='acp' && typeof row.offline_fixture==='boolean','acp-backend-invalid');
  requireThat(Array.isArray(row.kinds) && row.kinds.length>0 && row.kinds.every(kind=>['local','coder'].includes(kind)) && Array.isArray(row.policies) && row.policies.length>0 && row.policies.every(policy=>ACP_POLICIES.includes(policy)),'acp-backend-policy-invalid');
  requireThat(executable(row.executable) && hash(row.executable_sha256),'acp-backend-executable-invalid');
  fields(row.bootstrap,['executable','sha256'],['executable','sha256']);
  requireThat(executable(row.bootstrap.executable) && hash(row.bootstrap.sha256),'acp-bootstrap-invalid');
  requireThat(Array.isArray(row.argv) && row.argv.length<=48 && row.argv.every(value=>typeof value==='string' && value.length<=4096 && !value.includes('\0')),'acp-backend-argv-invalid');
  for(const key of ['credential_refs','environment']) requireThat(row[key] && typeof row[key]==='object' && !Array.isArray(row[key]) && Object.keys(row[key]).length<=8,'acp-backend-env-invalid');
  requireThat(Object.entries(row.credential_refs).every(([name,ref])=>envName(name) && validAcpRef(ref) && !Object.hasOwn(row.environment,name)),'acp-dedicated-credential-required');
  requireThat(Object.entries(row.environment).every(([name,value])=>envName(name) && !/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY/.test(name) && text(value)),'acp-backend-env-invalid');
  requireThat(Array.isArray(row.assets) && row.assets.length<=4,'acp-backend-assets-invalid');
  for(const asset of row.assets) {
    fields(asset,['name','sha256'],['name','sha256']);
    requireThat(/^[a-z0-9][a-z0-9.-]{0,100}$/.test(asset.name) && hash(asset.sha256),'acp-backend-asset-invalid');
  }
  return row;
}

// Only an in-process registry can mint this object-identity capability. Neither
// JSON RPC nor a model tool can put credentials into a provider's persisted input.
export function consumeAcpLaunch(input,context) {
  const ticket=tickets.get(input);if(!ticket) return undefined;
  tickets.delete(input);
  const active=acpOperationContext.getStore();
  requireThat(active && active.task_id===ticket.task_id && active.cli_instance_id===ticket.instance_id &&
    active.principal===context.session.principal_id && active.session_id===context.session.session_id &&
    input.binding_id===context.binding.binding_id && input.version===context.binding.version &&
    Date.now()<ticket.deadline && ACP_POLICIES.includes(context.binding.policy_version),'acp-launch-capability-invalid');
  return ticket;
}

export class AcpBackends {
  constructor(studio) {this.studio=studio;this.rows=[];}
  async load() {
    const file=join(this.studio.root,'acp-backends.json');
    try {
      const info=await lstat(file);
      requireThat(info.isFile() && !info.isSymbolicLink() && (info.mode&0o077)===0 && info.size<=131072,'acp-catalog-permissions');
      const doc=JSON.parse(await readFile(file,'utf8'));
      fields(doc,['version','backends'],['version','backends']);
      requireThat(doc.version===1 && Array.isArray(doc.backends) && doc.backends.length<=16,'acp-catalog-invalid');
      this.rows=doc.backends.map(validateBackend);
      requireThat(new Set(this.rows.map(row=>row.id)).size===this.rows.length,'acp-backend-duplicate');
    } catch(error) {
      if(error.code==='ENOENT') {this.rows=[];return;}
      if(error instanceof StudioError) throw error;
      throw new StudioError('acp-catalog-invalid');
    }
  }
  permitted(context,row) {return context.spec.acp_execution===true && row.kinds.includes(context.environment.kind) && row.policies.includes(context.binding.policy_version);}
  async describe(context) {
    const backends=[];
    for(const row of this.rows.filter(row=>this.permitted(context,row))) {
      const missing=[];
      for(const ref of Object.values(row.credential_refs)) if(!(await this.studio.ctx.credentials.resolve(ref))) missing.push(ref);
      backends.push({id:row.id,name:row.name,version:row.version,protocol:row.protocol,offline_fixture:row.offline_fixture,credential_refs:row.credential_refs,configured:missing.length===0,missing_credentials:missing});
    }
    return {backends,configured:backends.some(row=>row.configured),policy:context.binding.policy_version,real_cli_verified:false};
  }
  resolve(context,id) {
    const row=this.rows.find(row=>row.id===id);requireThat(row && this.permitted(context,row),'acp-backend-not-configured');return row;
  }
  async install(context,name,bytes,expectedHash) {
    requireThat(digest(bytes)===expectedHash,'acp-asset-changed');
    const input={session_id:context.session.session_id,binding_id:context.binding.binding_id,version:context.binding.version,path:name};
    let current;
    try {current=await this.studio.provider.file(context.session.principal_id,'read',input);}
    catch(error) {if(!['E_NOT_FOUND','ENOENT'].includes(error.code)) throw error;}
    if(!current) await this.studio.provider.file(context.session.principal_id,'write',{...input,operation_id:randomUUID(),encoding:'base64',data:bytes.toString('base64'),expected_version:null});
    const stored=await this.studio.provider.file(context.session.principal_id,'read',input);
    requireThat(stored.sha256===expectedHash && Buffer.from(stored.data,'base64').equals(bytes),'acp-installed-asset-mismatch');
    return join(context.binding.target_root,name);
  }
  async prepare(context,backend,task) {
    const secrets={};
    for(const [name,ref] of Object.entries(backend.credential_refs)) {
      const result=await this.studio.ctx.credentials.resolve(ref);
      requireThat(result && typeof result.value==='string' && result.value.length>0 && result.value.length<=16384 && !/[\u0000-\u001f]/.test(result.value),'acp-credential-not-configured');
      secrets[name]=result.value;
    }
    const launcher=await readFile(new URL('./adapters/acp-launch-v1.py',import.meta.url)),launcherHash=digest(launcher);
    const launchPath=await this.install(context,`.studio-acp-launch-v1-${launcherHash}.py`,launcher,launcherHash),files=[];
    for(const asset of backend.assets) {
      const bytes=await readFile(join(this.studio.root,'runtime/acp-assets',asset.name));
      const path=await this.install(context,asset.name,bytes,asset.sha256);files.push({path,sha256:asset.sha256});
    }
    const privateHome=context.environment.kind==='local'
      ? join(this.studio.root,'local/d06-acp-v1/home')
      : `/workspace/.agent-studio-helper-${context.binding.binding_id}-v${context.binding.version}/home`;
    const manifest={version:1,binding_id:context.binding.binding_id,binding_version:context.binding.version,task_id:task.task_id,instance_id:task.cli_instance_id,root:context.binding.target_root,backend_id:backend.id,executable:backend.executable,executable_sha256:backend.executable_sha256,argv:[backend.executable,...backend.argv.map(value=>value.replaceAll('{root}',context.binding.target_root))],files,private_home:privateHome,environment:backend.environment,credential_names:Object.keys(secrets),bootstrap_sha256:backend.bootstrap.sha256};
    const bytes=Buffer.from(JSON.stringify(manifest));requireThat(bytes.length<=12000,'acp-launch-manifest-limit');
    const input={session_id:context.session.session_id,binding_id:context.binding.binding_id,version:context.binding.version,operation_id:randomUUID(),argv:[backend.bootstrap.executable,'-I',launchPath,bytes.toString('base64')],cwd:''};
    const ticket={task_id:task.task_id,instance_id:task.cli_instance_id,credential_names:Object.keys(secrets),secrets,privateHome,manifest,manifest_sha256:digest(bytes),deadline:Math.min(task.deadline_ms,Date.now()+60000)};
    tickets.set(input,ticket);return {input,ticket};
  }
}
