import { StudioError, requireThat } from '../store.mjs';
import {nativeTerminalAllocation} from './agent-terminal.mjs';

// Explicit reviewed allowlist. Unknown methods fail closed, including future stock methods.
const GLOBAL_READS = new Set([
  'session/list','session/search','session/control','session/modelCatalog','session/canOpenWorkspacePath',
  'workspace/follow','settings/describe','pluginInventory/list','pluginManager/list',
  'commands/list','agentPresets/list','account/status','credentials/describe',
  'remoteAccess/follow','permissionPresets/catalog','llm/listProviders','llm/listConfigurableProviders',
  'dynamicCordisRunner/inventory','dynamicCordisRunner/syncInspectManifest',
]);
const SESSION_READS = new Set(['session/page','session/follow','session/projections','session/cancel']);
const WORKSPACE_METADATA = new Set(['workspace/rename','workspace/insertBefore','workspace/insertSessionBefore',
  'workspace/archiveSession','workspace/unarchiveSession','workspace/pinSession','workspace/unpinSession']);

export async function guardGateway(ctx, request, descriptor, args, RemoteError) {
  const endpoint = `${descriptor.namespace}/${descriptor.method}`;
  const studio = ctx.get('agentStudio');
  const deny = code => {
    studio?.store.audit(studio.store.principal,'stock.denied',endpoint,'denied',{ code, mode: descriptor.mode });
    throw new RemoteError(`agent-studio/${code}`, `D01 preview: ${endpoint} is not enabled`, {});
  };
  if (!studio) deny('not-ready');
  if (request.peer.principal.kind !== 'owner') deny('unauthorized');
  const principal = studio.principal(request.peer);
  if (GLOBAL_READS.has(endpoint)) return;
  const nativeError=error=>{throw new RemoteError(`agent-studio/${error.code??'model-operation-failed'}`,error instanceof StudioError?error.message:'Model operation failed',{});};
  if(endpoint==='settings/mutate' && args.ns==='llm-pi-ai') return async()=>{
    try {return await studio.models.settingsMutation(principal,args);} catch(error) {nativeError(error);}
  };
  if(endpoint==='credentials/set' || endpoint==='credentials/unset') return async function(...nativeArgs) {
    try {
      requireThat(!studio.store.db.prepare("SELECT 1 FROM model_requests WHERE state IN ('admitting','queued','running')").get(),'model-turn-active');
      requireThat(!studio.store.db.prepare("SELECT 1 FROM acp_tasks WHERE state IN ('starting','running','stopping')").get(),'acp-task-active');
      return await this[descriptor.method](...nativeArgs);
    } catch(error) {nativeError(error);}
  };
  if(['session/selectModel','session/prompt','session/cancel'].includes(endpoint)) {
    const input=args.request??args;
    if(endpoint==='session/cancel') {
      const session=studio.session(principal,input.sessionId),binding=studio.store.binding(principal,session.binding_id,session.version);
      if(!binding.policy_version.startsWith('d05-model-')) return;
    }
    return async function(...nativeArgs) {
      try {
        const native=()=>this[descriptor.method](...nativeArgs);
        if(descriptor.method==='selectModel') return await studio.models.select(principal,input,native);
        if(descriptor.method==='prompt') return await studio.models.prompt(principal,input,request.signal,native);
        return await studio.models.cancel(principal,input,native);
      } catch(error) {nativeError(error);}
    };
  }
  // This single native UI acknowledgement is not a plugin/configuration editor.
  // No other namespace, path, operation, or value is admitted.
  if (endpoint === 'settings/mutate' && args.ns === 'ui-settings-general' &&
      Array.isArray(args.ops) && args.ops.length === 1 && args.ops[0].op === 'set' &&
      JSON.stringify(args.ops[0].path) === '["welcomeNoticeVersion"]' && args.ops[0].value === '2026-09-28.1') return;
  const input = args.request ?? args;
  if((descriptor.namespace==='workspaceFiles' && ['read','readBytes','stat','list'].includes(descriptor.method)) ||
     (descriptor.namespace==='terminal' && ['environment','shells','list','create','attach','retain','rename','close'].includes(descriptor.method))) {
    const sessionId=args.workspaceFileScopeId??args.agentId??args.sessionId;
    let context;
    try {context=await studio.resolve(principal,{session_id:sessionId});} catch(error) {deny('disabled');}
    if(!(context.environment.provider==='coder-helper' || context.environment.kind==='local' && context.environment.provider==='local-managed')) deny('disabled');
    try {
      if(descriptor.namespace!=='terminal'||['environment','shells','create'].includes(descriptor.method))
        await studio.check(principal,{session_id:sessionId,operation:descriptor.namespace==='terminal'?'pty.open':'fs.read'});
      if(descriptor.namespace==='terminal') {
        await studio.ensureAgent(principal,sessionId);
        if(descriptor.method==='create') return async function(...nativeArgs) {
          try {return await nativeTerminalAllocation(sessionId,args.request.id,()=>this.create(...nativeArgs));}
          catch(error) {if(error instanceof StudioError) throw new RemoteError(`agent-studio/${error.code}`,error.message,{});throw error;}
        };
        return;
      }
      // Replace the Host service call: never let its ctx.fs touch the anchor.
      return async()=>{
        try {return await studio.files.workspace(principal,descriptor.method,args);}
        catch(error) {throw new RemoteError(`agent-studio/${error.code??'internal'}`,error.message,{});}
      };
    } catch(error) {throw new RemoteError(`agent-studio/${error.code??'internal'}`,error.message,{});}
  }
  if (endpoint === 'session/create') {
    // The original UI reopens even an existing blank through create(). Do not let
    // that path reach stock's cwd/default-directory creator: use our durable binding
    // service for both selection and creation, returning the real native identity.
    if (input.cwd !== undefined || typeof input.workspaceId !== 'string') deny('disabled');
    return async () => {
      try { return await studio.openUiSession(principal,input); }
      catch (error) { throw new RemoteError(`agent-studio/${error.code ?? 'internal'}`,error.message,{}); }
    };
  }
  if (SESSION_READS.has(endpoint)) {
    try {
      if (input.address) requireThat(input.address.kind === 'session','unbound-subagent');
      const session=studio.session(principal,input.sessionId ?? input.address?.sessionId);
      const binding=studio.store.binding(principal,session.binding_id,session.version);
      const environment=studio.store.get('environments','environment_id',binding.environment_id,principal);
      // Native history.follow promotes cold sessions in the background. Publish
      // our bound Agent first so stock preset activation cannot win that race.
      if(environment.provider==='coder-helper' || environment.kind==='local' && environment.provider==='local-managed') await studio.ensureAgent(principal,session.session_id);
    } catch (error) { deny('session-not-owned'); }
    return;
  }
  if (WORKSPACE_METADATA.has(endpoint)) {
    if (input.sessionId !== undefined) {
      try { studio.session(principal,input.sessionId); }
      catch (error) { deny('session-not-owned'); }
    }
    const workspaceId = input.workspaceId ?? input.id;
    if (workspaceId !== undefined && !studio.store.list('project_bindings',principal).some(row => row.workspace_id === workspaceId)) deny('workspace-not-owned');
    return;
  }
  deny('disabled');
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req,raw=false) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length; requireThat(size <= (raw?196608:16384),'body-too-large'); chunks.push(chunk);
  }
  const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
  return raw?text:JSON.parse(text);
}

// Called by the projected original package's host wrapper, never by a root monkey-patch.
export function mountSidebar(ctx, upstream, config) {
  const server = ctx.webServer;
  const scope = ctx.isolate('webServer');
  scope.provide('webServer', {
    register(route) {
      return server.register({ ...route, handler: async (req,res) => {
        const admission = ctx.connection.admit(req);
        if ('rejection' in admission) return json(res,admission.rejection,{ ok: false, error: { code: 'unauthorized' } });
        if (admission.peer.principal.kind !== 'owner') return json(res,403,{ ok: false, error: { code: 'unauthorized' } });
        const path = new URL(req.url,'http://preview.invalid').pathname;
        if (route.path === '/sidebar/bundle') return route.handler(req,res);
        if (path === '/sidebar/api/settings.get' && req.method === 'POST') return route.handler(req,res);
        const studio = ctx.get('agentStudio');
        if(studio && req.method==='POST' && ['git.status','git.diff','git.worktrees','git.diff-head','fs.search','reference.create'].some(method=>path==='/sidebar/api/'+method)) {
          const controller=new AbortController();
          const cancel=()=>{if(!res.writableEnded) controller.abort();};res.on('close',cancel);
          try {
            const value=await studio.reads.sidebar(studio.principal(admission.peer),path.slice('/sidebar/api/'.length),await body(req),controller.signal);
            if(!controller.signal.aborted) return json(res,200,{ok:true,value});
          } catch(error) {
            if(!controller.signal.aborted) return json(res,409,{ok:false,error:{code:error.code??'read-failed',message:error.code??'Read failed'}});
          } finally {res.off('close',cancel);}
          return;
        }
        if(studio && req.method==='POST' && ['/sidebar/api/fs.tree','/sidebar/api/fs.trees','/sidebar/api/fs.read','/sidebar/write'].includes(path)) {
          try {
            const principal=studio.principal(admission.peer),write=path==='/sidebar/write';
            const input=write?Object.fromEntries(new URL(req.url,'http://preview.invalid').searchParams):await body(req);
            if(write && input.expectedMtimeMs!==undefined) input.expectedMtimeMs=Number(input.expectedMtimeMs);
            const value=await studio.files.sidebar(principal,write?'fs.write':path.slice('/sidebar/api/'.length),input,write?await body(req,true):undefined);
            return json(res,200,{ok:true,value});
          } catch(error) {
            const code=error.code==='E_STALE_VERSION'?'conflict':error.code??'invalid-input';
            return json(res,409,{ok:false,error:{code,message:code}});
          }
        }
        if (studio && req.method === 'POST' && ['/sidebar/api/session.phase','/sidebar/api/session.cwd'].includes(path)) {
          try {
            const input = await body(req);
            const principal = studio.principal(admission.peer);
            const session = studio.session(principal,input.sessionId);
            const binding = studio.store.binding(principal,session.binding_id,session.version);
            if (path.endsWith('session.cwd')) return json(res,200,{ ok: true, value: { sessionId: session.session_id, cwd: binding.target_root, root: binding.target_root, parent: null } });
            const native = (await studio.readSession(principal,session.session_id)).native;
            requireThat(native,'native-session-missing');
            return json(res,200,{ ok: true, value: { blank: !native.inspection.events.some(e => ['user/message','assistant/message'].includes(e.type)) } });
          } catch (error) { return json(res,400,{ ok: false, error: { code: error.code ?? 'invalid-input', message: 'Session metadata unavailable' } }); }
        }
        studio?.store.audit(studio.store.principal,'sidebar.denied',path,'denied');
        return json(res,409,{ ok: false, error: { code: 'agent-studio/provider-unavailable', message: 'Bound preview: this operation is disabled (Git writes/history, session-change history, uploads, generation and local openers are not enabled)' } });
      } });
    },
    registerUpgrade(route) {
      return server.registerUpgrade({ ...route, handler(req,socket,head) {
        const admission = ctx.connection.admit(req);
        const studio = ctx.get('agentStudio');
        if (!('rejection' in admission) && admission.peer.principal.kind==='owner' && route.path==='/sidebar/ws/fs-watch') {
          void studio.watch.upgrade(studio.principal(admission.peer),req,socket,head).catch(error=>{
            studio.store.audit(studio.store.principal,'watch.denied',route.path,'denied',{code:error.code??'watch-error'});
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          });
          return;
        }
        if (!('rejection' in admission) && admission.peer.principal.kind === 'owner' && route.path === '/sidebar/ws/agent-opens') {
          try {
            studio.session(studio.principal(admission.peer),new URL(req.url,'http://preview.invalid').searchParams.get('sessionId'));
            return route.handler(req,socket,head); // UI notification registry only; no project filesystem or generation.
          } catch (error) { studio?.store.audit(studio.store.principal,'sidebar.metadata-denied',route.path,'denied'); }
        }
        const status = 'rejection' in admission ? admission.rejection : 403;
        studio?.store.audit(studio.store.principal,'sidebar.upgrade-denied',route.path,'denied');
        socket.end(`HTTP/1.1 ${status} Forbidden\r\nConnection: close\r\n\r\n`);
      } });
    },
  });
  upstream.apply(scope,config);
}
