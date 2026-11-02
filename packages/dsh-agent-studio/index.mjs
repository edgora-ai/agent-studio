import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { Store, StudioError, fields, requireThat, text } from './store.mjs';
import { Bindings } from './bindings.mjs';
import { BoundProvider } from './adapters/bound-provider.mjs';
import {HostFiles} from './adapters/host-files.mjs';
import {BoundReads} from './adapters/bound-reads.mjs';
import {BoundWatch} from './adapters/bound-watch.mjs';
import {ModelSessions} from './model-session.mjs';
import {AcpSessions} from './acp-session.mjs';
import {EnvironmentManager} from './environment-manager.mjs';
import {TaskRecovery} from './task-recovery.mjs';

export const name = 'agent-studio-preview';
export const inject = ['connection','webServer','typertGateway','workspaceRegistry','agents','agentLoop','sessions','sessionPersistence','sessionController','sessionTitle','settings','settingsController','credentials','llm'];

export async function apply(ctx) {
  const root = process.env.AGENT_STUDIO_ROOT;
  requireThat(root && process.env.AGENT_STUDIO_RUN_ID, 'isolated-launcher-required');
  const catalog = JSON.parse(await readFile(join(root,'catalog.json'),'utf8'));
  const store = new Store(root);
  const studio = new Bindings(ctx,store,root,catalog);
  store.markInterrupted();
  studio.provider=new BoundProvider(studio);
  studio.recovery=new TaskRecovery(studio);
  studio.files=new HostFiles(studio);
  studio.reads=new BoundReads(studio);
  studio.watch=new BoundWatch(studio);
  studio.models=new ModelSessions(studio);
  await studio.models.initialize();
  studio.acp=new AcpSessions(studio);
  await studio.acp.initialize();
  studio.environments=new EnvironmentManager(studio);
  await studio.environments.initialize();
  const reconciliation = await studio.reconcile();
  ctx.provide('agentStudio',studio);
  ctx.effect(() => () => studio.dispose(),'agent-studio: close native handles and database');
  async function rpc(method, input, signal, peer) {
    let principal;
    try {
      principal = studio.principal(peer);
      requireThat(!signal.aborted,'cancelled');
      let value;
      switch (method) {
        case 'project.create': value = store.project(principal,input); break;
        case 'project.get': fields(input,['project_id'],['project_id']); value = store.get('projects','project_id',text(input.project_id,'project_id'),principal); break;
        case 'project.list': fields(input,[]); value = store.list('projects',principal); break;
        case 'environment.register': {
          fields(input,['catalog_key'],['catalog_key']);
          const spec = catalog.find(item => item.key === input.catalog_key);
          requireThat(spec,'unknown-environment');
          value = store.environment(principal,spec); break;
        }
        case 'environment.get': fields(input,['environment_id'],['environment_id']); value = store.get('environments','environment_id',text(input.environment_id,'environment_id'),principal); break;
        case 'environment.list': fields(input,[]); value = store.list('environments',principal); break;
        case 'environment.describe': value=studio.environments.describe(principal,input);break;
        case 'environment.discover': value=await studio.environments.refresh(principal,input);break;
        case 'environment.observations': value=studio.environments.observations(principal,input);break;
        case 'environment.open': value=await studio.environments.open(principal,input);break;
        case 'environment.link': value=studio.environments.link(principal,input);break;
        case 'environment.prepare': value=await studio.environments.prepare(principal,input);break;
        case 'environment.confirm': value=await studio.environments.confirm(principal,input);break;
        case 'environment.request': value=studio.environments.request(principal,input);break;
        case 'environment.poll': value=await studio.environments.poll(principal,input);break;
        case 'environment.resolve': value=await studio.environments.resolve(principal,input);break;
        case 'binding.create': value = await studio.createBinding(principal,input); break;
        case 'binding.get':
          fields(input,['binding_id','version'],['binding_id','version']);
          requireThat(Number.isSafeInteger(input.version) && input.version > 0,'invalid-version');
          value = store.binding(principal,text(input.binding_id,'binding_id'),input.version); break;
        case 'binding.list': fields(input,[]); value = store.list('project_bindings',principal); break;
        case 'session.create': value = await studio.createSession(principal,input); break;
        case 'session.get': fields(input,['session_id'],['session_id']); value = await studio.readSession(principal,input.session_id); break;
        case 'session.list': fields(input,[]); value = store.list('session_bindings',principal); break;
        case 'dispatch.check': value = await studio.check(principal,input); break;
        case 'remote.connect': value = await studio.provider.connect(principal,input); break;
        case 'remote.status':
        case 'remote.disconnect': {
          fields(input,['session_id'],['session_id']);
          const {binding}=await studio.resolve(principal,input);
          value=method==='remote.status'?studio.provider.status(binding):await studio.provider.disconnect(binding);break;
        }
        case 'fs.list': case 'fs.read': case 'fs.write': case 'fs.mkdir':
          value=await studio.provider.file(principal,method.slice(3),input);break;
        case 'git.status': case 'git.diff': case 'fs.search': case 'reference.create':
          value=await studio.reads.sidebar(principal,method,{...input,sessionId:input.session_id},signal);break;
        case 'watch.status': fields(input,[]);value=studio.watch.status();break;
        case 'task.preflight': value=await studio.recovery.preflight(principal,input);break;
        case 'task.recovery': value=studio.recovery.get(principal,input);break;
        case 'task.recoveries': value=studio.recovery.list(principal,input);break;
        case 'task.recover': value=await studio.recovery.recover(principal,input);break;
        case 'task.detach': value=await studio.recovery.detach(principal,input);break;
        case 'command.start': value=await studio.provider.start(principal,input);break;
        case 'task.status': case 'task.read': case 'task.foreground': case 'task.input': case 'task.resize': case 'task.signal': case 'task.cancel': case 'task.release':
          value=await studio.provider.task(principal,method.slice(5),input);break;
        case 'operation.get':
          fields(input,['operation_id'],['operation_id']);value=store.operation(principal,input.operation_id);break;
        case 'operation.list':
          fields(input,['session_id'],['session_id']);studio.session(principal,input.session_id);value=store.operations(principal,input.session_id);break;
        case 'model.describe': fields(input,[]);value=studio.models.describe();break;
        case 'model.configure': value=await studio.models.configure(principal,input);break;
        case 'model.requests': case 'model.controls':
          fields(input,['session_id'],['session_id']);studio.session(principal,input.session_id);
          value=method==='model.requests'?studio.models.state.requests(principal,input.session_id):studio.models.state.controls(principal,input.session_id);break;
        case 'model.reply': value=studio.models.reply(principal,input);break;
        case 'acp.describe': value=await studio.acp.describe(principal,input);break;
        case 'acp.start': value=await studio.acp.start(principal,input);break;
        case 'acp.cancel': value=await studio.acp.cancel(principal,input);break;
        case 'acp.reply': value=studio.acp.reply(principal,input);break;
        case 'acp.tasks': case 'acp.controls':
          fields(input,['session_id'],['session_id']);studio.session(principal,input.session_id);
          value=method==='acp.tasks'?studio.acp.state.tasks(principal,input.session_id):studio.acp.state.controls(principal,input.session_id);break;
        case 'acp.get': case 'acp.events':
          fields(input,['task_id'],['task_id']);value=method==='acp.get'?studio.acp.state.task(principal,input.task_id):studio.acp.state.events(principal,input.task_id);break;
        case 'preview.status':
          fields(input,[]);
          value = { scope: 'D07-development-only', generation: 'explicit-model-policy-and-route', execution: 'explicit-local-managed-or-coder-helper',
            principal_id: principal, reconciliation, counters: globalThis[Symbol.for('agent-studio.fence')],
            catalog: catalog.map(({ key,kind,name }) => ({ key,kind,name })) }; break;
        default: throw new StudioError('unknown-method');
      }
      return { ok: true, value };
    } catch (error) {
      const code = error instanceof StudioError ? error.code : 'internal';
      store.audit(principal ?? 'unauthenticated','rpc.denied',String(method).slice(0,100),'denied',{ code });
      if (!(error instanceof StudioError)) ctx.logger.error('Agent Studio RPC failed (%s): %s',method,error);
      return { ok: false, error: { code: `agent-studio/${code}`, message: error instanceof StudioError ? error.message : 'Operation failed; inspect private preview log', details: {} } };
    }
  }
  ctx.effect(() => ctx.connection.rpc.handle('/agent-studio-rpc',rpc),'agent-studio: authenticated RPC');
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/agent-studio/health', handler(req,res) {
    const origin = ctx.webServer.getOrigin();
    const valid = req.headers.host === new URL(origin).host && (!req.headers.origin || req.headers.origin === origin);
    res.writeHead(valid ? 200 : 403, { 'content-type': 'application/json','cache-control': 'no-store' });
    res.end(JSON.stringify(valid ? { status: 'ok', scope: 'D07-development-only' } : { error: 'untrusted-origin' }));
  } }),'agent-studio: public health');
  // Exact carrier route wins over Connection's /api prefix, before byte ingestion.
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/session/uploadFileBinary', handler(req,res) {
    const admission = ctx.connection.admit(req);
    res.writeHead('rejection' in admission ? admission.rejection : 409, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { code: 'agent-studio/provider-unavailable', message: 'D01 uploads disabled' } }));
  } }),'agent-studio: raw upload fence');
  // Do not announce readiness before the real dsh tree and sidebar have settled.
  void ctx.loader.await().then(async () => {
    // Fail startup if a later profile edit accidentally restores the owner-bypassing
    // Gateway. The sentinel is deliberately unresolvable, even with stock code.
    let guarded;
    try {
      await ctx.typertGateway.invoke({ namespace: 'workspaceFiles', method: 'read',
        args: { workspaceFileScopeId: 'preview-unbound-sentinel', path: '.', range: {} },
        peer: ctx.connection.browserPeer, signal: new AbortController().signal });
    } catch (error) { guarded = error.code === 'agent-studio/disabled'; }
    requireThat(guarded,'gateway-guard-not-active');
    const origin = ctx.webServer.getOrigin();
    await writeFile(join(root,'login.url'),`${ctx.connection.authenticatedUrl(`${origin}/`)}\n`,{ mode: 0o600 });
    await chmod(join(root,'login.url'),0o600);
    const readiness = { pid: process.pid, run_id: process.env.AGENT_STUDIO_RUN_ID, origin, auth_file: join(root,'login.url'), root, reconciliation };
    await writeFile(join(root,'ready.json.tmp'),JSON.stringify(readiness,null,2),{ mode: 0o600 });
    await rename(join(root,'ready.json.tmp'),join(root,'ready.json'));
  }).catch(error => { ctx.logger.error('Preview readiness failed: %s',error); process.exitCode = 1; });
}
