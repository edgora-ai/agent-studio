import { lstat, realpath, readdir, mkdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { StudioError, fields, requireThat, text, now } from './store.mjs';
import {installTerminal} from './adapters/agent-terminal.mjs';
import {MODEL_POLICIES} from './model-state.mjs';
import {boundToolServices,installAgentTools} from './adapters/agent-tools.mjs';

export const OPERATIONS = Object.freeze(['metadata.read','fs.read','fs.write','command.exec','pty.open']);
const PENDING_TTL_MS = 10 * 60 * 1000;

export class Bindings {
  constructor(ctx, store, root, catalog) {
    this.ctx = ctx; this.store = store; this.root = root; this.catalog = catalog;
    this.anchors = join(root, 'anchors');
    this.handles = new Map();this.activating=new Map();
  }
  principal(peer) {
    requireThat(peer?.principal?.kind === 'owner', 'unauthorized');
    return this.store.principal;
  }
  async anchor(row) {
    requireThat(row.anchor_path === join(this.anchors, `${row.binding_id}-v${row.version}`), 'anchor-invalid');
    try {
      const info = await lstat(row.anchor_path, { bigint: true });
      requireThat(info.isDirectory() && !info.isSymbolicLink() && await realpath(row.anchor_path) === row.anchor_path, 'anchor-invalid');
      requireThat(row.anchor_dev === String(info.dev) && row.anchor_ino === String(info.ino), 'anchor-invalid');
      requireThat((await readdir(row.anchor_path)).length === 0, 'anchor-not-empty');
      return info;
    } catch (error) {
      this.store.failBinding(row, 'anchor-invalid');
      throw new StudioError('anchor-invalid');
    }
  }
  async materializeBinding(row) {
    requireThat(row.state === 'pending', 'binding-not-pending');
    // Only pending, never-before-registered anchors may be materialized. Ready anchors are never recreated.
    requireThat(row.anchor_ino === null && row.workspace_id === null, 'anchor-already-registered');
    try { await mkdir(row.anchor_path, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(row.anchor_path, { bigint: true });
    requireThat(info.isDirectory() && !info.isSymbolicLink() && await realpath(row.anchor_path) === row.anchor_path && (await readdir(row.anchor_path)).length === 0, 'anchor-invalid');
    const project = this.store.get('projects','project_id',row.project_id,row.principal_id);
    const workspace = await this.ctx.workspaceRegistry.create(row.anchor_path, `${project.name} · v${row.version}`);
    this.store.transaction(() => {
      const current = this.store.binding(row.principal_id,row.binding_id,row.version);
      requireThat(current.state === 'pending', 'binding-not-pending');
      this.store.db.prepare("UPDATE project_bindings SET anchor_dev=?,anchor_ino=?,workspace_id=?,state='ready',ready_at=? WHERE binding_id=? AND version=?").run(String(info.dev),String(info.ino),workspace.id,now(),row.binding_id,row.version);
      this.store.audit(row.principal_id,'binding.ready',`${row.binding_id}@${row.version}`,'ready',{ workspace_id: workspace.id });
    });
    return this.store.binding(row.principal_id,row.binding_id,row.version);
  }
  async createBinding(principal, input) {
    const row = this.store.newBinding(principal,input,this.anchors);
    try { return await this.materializeBinding(row); }
    catch (error) { this.store.failBinding(row,error.code ?? 'binding-materialization-failed'); throw error; }
  }
  setupAgent(row,binding) {
    return async (agentCtx,agent)=>{
      const modelEnabled=MODEL_POLICIES.includes(binding.policy_version);
      if(!modelEnabled) agentCtx.on('agent/pre-step',()=>{throw new StudioError('generation-disabled');});
      const environment=this.store.get('environments','environment_id',binding.environment_id,row.principal_id);
      let localFs;
      if(environment.kind==='local' && environment.provider==='local-managed') {
        const spec=this.catalog.find(item=>item.key===environment.catalog_key);
        localFs=await this.provider.local.install(agentCtx,agent,row,binding,environment,spec);
      }
      if(modelEnabled) {
        const services=boundToolServices(this,agent,row,binding);
        installTerminal(this,agentCtx,agent,row,binding,{fs:services.fs,shell:services.shell,shellEnv:services.shellEnv});
        await installAgentTools(this,agentCtx,agent,row,binding,services);
      } else if(localFs || environment.provider==='coder-helper') installTerminal(this,agentCtx,agent,row,binding,localFs?{fs:localFs}:{});
    };
  }
  async ensureAgent(principal,sessionId) {
    const {session,binding}=await this.resolve(principal,{session_id:sessionId});
    if(this.handles.has(sessionId)) return this.handles.get(sessionId).agent;
    if(!this.activating.has(sessionId)) {
      const work=this.ctx.agents.resume({resumeSessionId:sessionId,setup:this.setupAgent(session,binding)})
        .then(handle=>{this.handles.set(sessionId,handle);return handle.agent;}).finally(()=>this.activating.delete(sessionId));
      this.activating.set(sessionId,work);
    }
    return this.activating.get(sessionId);
  }
  async finishSession(row) {
    const binding = this.store.binding(row.principal_id,row.binding_id,row.version);
    requireThat(binding.state === 'ready', 'binding-not-ready');
    await this.anchor(binding);
    const existing = await this.ctx.sessionPersistence.stat(row.session_id);
    if (existing) requireThat(existing.header.cwd === binding.anchor_path, 'native-session-mismatch');
    let session = this.ctx.sessions.get(row.session_id);
    if (!session) {
      // Factory setup composes no preset, tools or model work. We never drive the Agent.
      const options = { setup:this.setupAgent(row,binding) };
      const handle = existing
        ? await this.ctx.agents.resume({ ...options, resumeSessionId: row.session_id })
        : await this.ctx.agents.create({ ...options, sessionId: row.session_id, meta: { cwd: binding.anchor_path } });
      this.handles.set(row.session_id, handle);
      session = handle.agent.session;
    }
    requireThat(session, 'native-session-missing');
    this.ctx.sessionTitle.rename(session,row.title);
    await this.ctx.sessions.flush(session);
    const snapshot = await this.ctx.sessionPersistence.stat(row.session_id);
    requireThat(snapshot?.header.cwd === binding.anchor_path && snapshot.sizeBytes > 0, 'native-session-not-durable');
    const inspected = await this.ctx.sessionController.inspect(row.session_id);
    requireThat(inspected.meta.cwd === binding.anchor_path, 'native-session-mismatch');
    const workspace = this.ctx.workspaceRegistry.get(binding.workspace_id);
    requireThat(workspace?.path === binding.anchor_path, 'workspace-mismatch');
    await workspace.attachSession(row.session_id);
    requireThat(workspace.sessionIds.includes(row.session_id), 'session-not-attached');
    this.store.transaction(() => {
      requireThat(this.store.binding(row.principal_id,row.binding_id,row.version).state === 'ready', 'binding-not-ready');
      this.store.db.prepare("UPDATE session_bindings SET state='ready',ready_at=?,error_code=NULL WHERE session_id=? AND state='pending'").run(now(),row.session_id);
      this.store.audit(row.principal_id,'session.ready',row.session_id,'ready',{ workspace_id: workspace.id });
    });
    return this.store.get('session_bindings','session_id',row.session_id,row.principal_id);
  }
  async createSession(principal, input) {
    fields(input,['binding_id','version','title'],['binding_id','version']);
    requireThat(Number.isSafeInteger(input.version) && input.version > 0, 'invalid-version');
    const binding = this.store.binding(principal,text(input.binding_id,'binding_id'),input.version);
    requireThat(binding.state === 'ready','binding-not-ready');
    await this.anchor(binding);
    const row = this.store.newSession(principal,binding,text(input.title ?? 'Agent Studio preview','title',80));
    // A failed boundary remains pending, with the original ID, for restart reconciliation.
    try { return await this.finishSession(row); }
    catch (error) {
      this.store.audit(principal,'session.materialize',row.session_id,'pending',{ code: error.code ?? 'native-session-failed' });
      throw new StudioError('session-pending', `Session ${row.session_id} requires reconciliation`);
    }
  }
  async openUiSession(principal, input) {
    fields(input,['workspaceId','sessionId','agentPreset'],['workspaceId']);
    requireThat(input.agentPreset === undefined || input.agentPreset === 'preview','disabled');
    const binding = this.store.list('project_bindings',principal).find(row => row.workspace_id === input.workspaceId && row.state === 'ready');
    requireThat(binding,'workspace-not-owned');
    await this.anchor(binding);
    if (input.sessionId !== undefined) {
      const session = this.session(principal,input.sessionId);
      requireThat(session.state === 'ready' && session.binding_id === binding.binding_id && session.version === binding.version,'binding-mismatch');
      const native = await this.readSession(principal,session.session_id);
      requireThat(native.native?.inspection.meta.cwd === binding.anchor_path,'native-session-mismatch');
      requireThat(this.ctx.workspaceRegistry.get(binding.workspace_id)?.sessionIds.includes(session.session_id),'session-not-attached');
      const environment=this.store.get('environments','environment_id',binding.environment_id,principal);
      if(environment.provider==='coder-helper' || environment.kind==='local' && environment.provider==='local-managed') await this.ensureAgent(principal,session.session_id);
      return { sessionId: session.session_id, agentPreset: 'preview' };
    }
    const session = await this.createSession(principal,{ binding_id: binding.binding_id,version: binding.version });
    return { sessionId: session.session_id, agentPreset: 'preview' };
  }
  session(principal, sessionId) {
    return this.store.get('session_bindings','session_id',text(sessionId,'session_id'),principal);
  }
  async readSession(principal, sessionId) {
    const row = this.session(principal,sessionId);
    const snapshot = await this.ctx.sessionPersistence.stat(sessionId);
    const inspection = snapshot ? await this.ctx.sessionController.inspect(sessionId) : null;
    return { ...row, native: snapshot ? { snapshot, inspection } : null };
  }
  async reconcile() {
    await mkdir(this.anchors,{ recursive: true, mode: 0o700 });
    const summary = { bindings_ready: 0, sessions_ready: 0, failed: 0 };
    for (const row of this.store.list('project_bindings',this.store.principal)) {
      if (row.state === 'pending') {
        try {
          requireThat(Date.now() - Date.parse(row.created_at) < PENDING_TTL_MS, 'pending-expired');
          await this.materializeBinding(row); summary.bindings_ready++;
        } catch (error) { this.store.failBinding(row,error.code ?? 'reconciliation-failed'); summary.failed++; }
      } else if (row.state === 'ready') {
        try { await this.anchor(row); }
        catch (error) { summary.failed++; }
      }
    }
    for (const row of this.store.list('session_bindings',this.store.principal)) {
      if (row.state === 'pending') {
        try {
          requireThat(Date.now() - Date.parse(row.created_at) < PENDING_TTL_MS, 'pending-expired');
          await this.finishSession(row); summary.sessions_ready++;
        } catch (error) { this.store.failSession(row,error.code ?? 'reconciliation-failed'); summary.failed++; }
      } else if (row.state === 'ready') {
        const binding = this.store.binding(row.principal_id,row.binding_id,row.version);
        const snapshot = await this.ctx.sessionPersistence.stat(row.session_id);
        const workspace = this.ctx.workspaceRegistry.get(binding.workspace_id);
        if (!snapshot || snapshot.header.cwd !== binding.anchor_path || !workspace?.sessionIds.includes(row.session_id)) {
          this.store.failSession(row,'native-session-mismatch'); summary.failed++;
        }
      }
    }
    return summary;
  }
  async resolve(principal, input) {
    fields(input,['session_id','binding_id','version','cwd','operation'],['session_id']);
    const session = this.session(principal,input.session_id);
    requireThat(session.state === 'ready', 'session-not-ready');
    const binding = this.store.binding(principal,session.binding_id,session.version);
    requireThat(input.binding_id === undefined || input.binding_id === binding.binding_id, 'binding-mismatch');
    requireThat(input.version === undefined || input.version === binding.version, 'version-mismatch');
    requireThat(binding.state === 'ready', binding.state === 'superseded' ? 'stale-binding' : 'binding-not-ready');
    await this.anchor(binding);
    const snapshot = await this.ctx.sessionPersistence.stat(session.session_id);
    const workspace = this.ctx.workspaceRegistry.get(binding.workspace_id);
    requireThat(snapshot?.header.cwd === binding.anchor_path && workspace?.sessionIds.includes(session.session_id), 'native-session-mismatch');
    const environment = this.store.get('environments','environment_id',binding.environment_id,principal);
    const catalogSpec = this.catalog.find(item => item.key === environment.catalog_key);
    const spec = this.environments?.effectiveSpec(binding,catalogSpec)??catalogSpec;
    await this.environments?.admit(binding);
    // Trusted operator record plus CURRENT local channel facts, not verifiedGeneration == generation alone.
    const rootAllowed=spec?.provider==='coder-helper'
      ? spec.roots.some(root=>binding.target_root===posix.join(root,`agent-studio-${binding.binding_id}-v${binding.version}`))
      : spec?.roots.includes(binding.target_root);
    requireThat(spec && spec.generation === binding.instance_generation && spec.policy_version === binding.policy_version && rootAllowed, 'instance-changed');
    if(environment.kind==='local') {
      const info = await lstat(spec.roots[0], { bigint: true });
      requireThat(info.isDirectory() && !info.isSymbolicLink() && String(info.dev) === spec.device && String(info.ino) === spec.inode, 'instance-changed');
    }
    const cwd = input.cwd === undefined ? binding.target_root : posix.resolve(binding.target_root,text(input.cwd,'cwd',4096));
    requireThat(cwd === binding.target_root || cwd.startsWith(`${binding.target_root}/`), 'cwd-outside-binding');
    return {session,binding,environment,spec,cwd};
  }
  async check(principal,input) {
    fields(input,['session_id','binding_id','version','cwd','operation'],['session_id','operation']);
    const {session,binding,environment,spec,cwd}=await this.resolve(principal,input);
    requireThat(OPERATIONS.includes(input.operation),'unknown-operation');
    let execution=false;
    if(environment.provider==='coder-helper' && spec.provider==='coder-helper') {
      requireThat(this.provider,'provider-unavailable');
      await this.provider.verify(binding); execution=true;
    } else if(environment.kind==='local' && environment.provider==='local-managed' && spec.kind==='local' && spec.provider==='local-managed') {
      await this.provider.local.verify({session,binding,environment,spec,cwd});execution=true;
    } else {
      requireThat(environment.kind==='local' && environment.connection_state==='metadata-only','remote-unverified');
      requireThat(input.operation==='metadata.read','provider-unavailable','Local file, command and PTY providers are not enabled');
    }
    return {eligible:true,executed:false,operation:input.operation,session_id:session.session_id,
      binding_id:binding.binding_id,version:binding.version,environment_id:binding.environment_id,
      instance_generation:binding.instance_generation,cwd,provider:environment.provider,execution_available:execution};
  }
  async dispose() {
    const errors=[];
    try {
      await this.environments?.dispose();
      this.models?.dispose();
      try {await this.acp?.dispose();} catch(error) {errors.push(error);}
      try {await this.watch?.dispose();} catch(error) {errors.push(error);}
      try {await this.provider?.local.dispose();} catch(error) {errors.push(error);}
      for (const handle of this.handles.values()) {
        try {await handle.dispose();} catch(error) {errors.push(error);}
      }
      try {await this.provider?.dispose();} catch(error) {errors.push(error);}
      try {await this.recovery?.dispose();} catch(error) {errors.push(error);}
      if(errors.length) throw new AggregateError(errors,'Bound session cleanup unconfirmed');
    } finally {this.store.close();}
  }
}
