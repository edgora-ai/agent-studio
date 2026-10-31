// Preview guard: only the exact bound broker may spawn; no direct network/model clients.
// This is defense in depth for this trusted-code profile, NOT an OS sandbox.
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {readFileSync,realpathSync} from 'node:fs';

const nativeSpawn = childProcess.spawn, nativeSpawnSync=childProcess.spawnSync;
const localLaunch=new AsyncLocalStorage(),modelNetwork=new AsyncLocalStorage();
const nativeFetch=globalThis.fetch,nativeConnect=net.Socket.prototype.connect,nativeTls=tls.connect;
Object.defineProperty(globalThis,Symbol.for('agent-studio.model-request'),{value(spec,action) {
  const url=new URL(spec.url);
  if(!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/chat/completions') ||
     typeof spec.session_id!=='string' || typeof spec.request_id!=='string' || !Number.isInteger(spec.revision) || spec.revision<1 || !(spec.signal instanceof AbortSignal)) throw new Error('Model network capability rejected');
  spec.signal.throwIfAborted();const permit={url,signal:spec.signal,closed:false,fetching:false};
  return modelNetwork.run(permit,async()=>{try {return await action();} finally {permit.closed=true;}});
}});
// This capability is consumed only AFTER authoritative local session/policy checks.
// It grants one exact SDK launch, never a generic ambient spawn permission.
Object.defineProperty(globalThis,Symbol.for('agent-studio.local-run'),{value(spec,action) {
  const root=process.env.AGENT_STUDIO_ROOT;
  const directory=['d04-local-v1','d05-local-v1','d06-acp-v1'].find(value=>spec.root===join(root??'','projects',value));
  let credentialNames=[];
  if(spec.acp) {
    const manifest=JSON.parse(Buffer.from(spec.argv[3]??'','base64').toString('utf8'));
    if(directory!=='d06-acp-v1' || spec.argv.length!==4 || spec.argv[1]!=='-I' ||
      !spec.argv[2]?.startsWith(spec.root+'/.studio-acp-launch-v1-') || !/\/\.studio-acp-launch-v1-[a-f0-9]{64}\.py$/.test(spec.argv[2]) ||
      manifest.task_id!==spec.acp.task_id || manifest.instance_id!==spec.acp.instance_id || manifest.root!==spec.root ||
      manifest.binding_id!==spec.binding_id || manifest.binding_version!==spec.version || manifest.private_home!==spec.env.HOME ||
      JSON.stringify(manifest.credential_names)!==JSON.stringify(spec.acp.credential_names) || !Array.isArray(spec.acp.credential_names) ||
      spec.acp.credential_names.some(key=>!/^[A-Z][A-Z0-9_]{1,79}$/.test(key) || /^(?:PATH$|HOME$|LANG$|LC_ALL$|TMPDIR$|XDG_|LD_|DYLD_|PYTHON|NODE_|CODER_|SSH_|DSH_|BASH_ENV$|ENV$)/.test(key))) throw new Error('ACP local capability rejected');
    credentialNames=spec.acp.credential_names;
  }
  if(!root || !directory ||
     !/^binding-[a-f0-9-]{36}$/.test(spec.binding_id) || !Number.isSafeInteger(spec.version) || spec.version<1 ||
     !(spec.cwd===spec.root || spec.cwd.startsWith(spec.root+'/')) || realpathSync(spec.cwd)!==spec.cwd ||
     spec.env.HOME!==join(root,'local',directory,'home') || spec.env.PATH!=='/usr/bin:/bin' ||
     Object.keys(spec.env).some(key=>!['PATH','HOME','LANG','LC_ALL','TERM','COLORTERM','TMPDIR',...credentialNames].includes(key)))
    throw new Error('Local launch capability rejected');
  const permit={...spec,spawned:false,closed:false};
  return localLaunch.run(permit,async()=>{try {return await action(permit);} finally {permit.closed=true;}});
}});
// The sole subprocess capability is a fixed central broker with a server-owned
// binding reference. No executable, command, target, environment or cwd override.
Object.defineProperty(globalThis, Symbol.for('agent-studio.broker-spawn'), { value(mode, bindingId, version, operationId) {
  if (!['check','install','connect','observe-task'].includes(mode) || (mode==='observe-task' ? typeof operationId!=='string' || !/^[A-Za-z0-9_-]{8,128}$/.test(operationId) : operationId!==undefined) || !/^binding-[a-f0-9-]{36}$/.test(bindingId) || !Number.isSafeInteger(version) || version < 1)
    throw new Error('D02 broker reference rejected');
  const root=process.env.AGENT_STUDIO_ROOT, repo=process.env.AGENT_STUDIO_REPO;
  if (!root || !repo) throw new Error('D02 broker launcher configuration absent');
  return nativeSpawn('/usr/bin/python3',['-I',join(repo,'packages/dsh-agent-studio/adapters/coder_broker.py'),root,mode,bindingId,String(version),...(operationId?[operationId]:[])], {
    cwd:join(root,'cwd'), stdio:['pipe','pipe','pipe','pipe'],
    env:{PATH:'/usr/bin:/bin',HOME:join(root,'home'),LANG:'C.UTF-8'},
  });
} });

Object.defineProperty(globalThis,Symbol.for('agent-studio.environment-broker'),{value(mode,requestId) {
  if(!['environment-discover','environment-submit','environment-poll'].includes(mode) || (mode==='environment-discover'?requestId!==undefined:typeof requestId!=='string' || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId))) throw new Error('D07 broker reference rejected');
  const root=process.env.AGENT_STUDIO_ROOT,repo=process.env.AGENT_STUDIO_REPO;
  if(!root || !repo) throw new Error('D07 broker launcher configuration absent');
  return nativeSpawn('/usr/bin/python3',['-I',join(repo,'packages/dsh-agent-studio/adapters/coder_broker.py'),root,mode,...(requestId?[requestId]:[])],{
    cwd:join(root,'cwd'),stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',HOME:join(root,'home'),LANG:'C.UTF-8'},
  });
}});

process.umask(0o077);
const counters = { networkBlocked: 0, subprocessBlocked: 0, generationBlocked: 0 };
globalThis[Symbol.for('agent-studio.fence')] = counters;
const block = kind => function () {
  counters[kind]++;
  throw Object.assign(new Error(`Bound preview: ${kind} (direct networking and generic subprocesses disabled)`),{ code: 'PREVIEW_UNAVAILABLE' });
};
const connectionAllowed=args=>{
  const permit=modelNetwork.getStore(),first=Array.isArray(args[0])?args[0][0]:args[0];
  if(!permit || permit.closed || !permit.fetching || permit.signal.aborted || !first || typeof first!=='object') return false;
  const host=first.hostname??first.host,port=Number(first.port);
  return host===permit.url.hostname.replace(/^\[|\]$/g,'') && port===Number(permit.url.port || (permit.url.protocol==='https:'?443:80));
};
net.Socket.prototype.connect=function(...args) {if(!connectionAllowed(args)) return block('networkBlocked')();return nativeConnect.apply(this,args);};
tls.connect=function(...args) {if(!connectionAllowed(args)) return block('networkBlocked')();return nativeTls.apply(this,args);};
const lookup = dns.lookup;
dns.lookup = function (hostname, ...args) {
  const permit=modelNetwork.getStore();
  if (net.isIP(hostname) || permit && !permit.closed && permit.fetching && hostname===permit.url.hostname && !permit.signal.aborted) return lookup.call(dns,hostname,...args);
  return block('networkBlocked')();
};
dns.resolve = block('networkBlocked');
dns.promises.lookup = block('networkBlocked');
dns.promises.resolve = block('networkBlocked');
globalThis.fetch = function(input,init={}) {
  const permit=modelNetwork.getStore(),url=typeof input==='string'?input:input instanceof URL?input.href:input?.url,method=init.method??input?.method??'GET';
  if(!permit || permit.closed || permit.signal.aborted || new URL(url).href!==permit.url.href || method.toUpperCase()!=='POST') return block('networkBlocked')();
  const signal=init.signal??input?.signal;
  return modelNetwork.run({...permit,fetching:true},()=>nativeFetch(input,{...init,redirect:'error',signal:signal?AbortSignal.any([permit.signal,signal]):permit.signal}));
};
for (const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) childProcess[key] = block('subprocessBlocked');
childProcess.spawn=function(file,args,options) {
  const permit=localLaunch.getStore();
  const env=Object.fromEntries(Object.entries(options?.env??{}).filter(([,v])=>v!==undefined));
  const sameEnv=permit && Object.keys(env).length===Object.keys(permit.env).length && Object.entries(env).every(([k,v])=>permit.env[k]===v);
  if(!permit || permit.closed || permit.spawned || file!==permit.argv[0] || JSON.stringify(args)!==JSON.stringify(permit.argv.slice(1)) ||
     options.cwd!==permit.cwd || !sameEnv || options.detached!==true || JSON.stringify(options.stdio)!=='["pipe","pipe","pipe"]') return block('subprocessBlocked')();
  permit.spawned=true;
  const child=nativeSpawn(file,args,options);permit.pid=child.pid;
  if(child.pid) {
    try {permit.startTicks=readFileSync(`/proc/${child.pid}/stat`,'utf8').split(') ')[1].split(' ')[19];}
    catch(error) {if(error.code!=='ENOENT') throw error;}
  }
  return child;
};
childProcess.spawnSync=function(file,args,options) {
  const permit=localLaunch.getStore();
  // Only the SDK's literal, short-lived native-containment probe. No manager
  // environment is inherited. Any non-probe systemd launch still fails closed.
  const prefix=['--user','--scope','--quiet','--collect'];
  const index=args?.[4]==='--expand-environment=no'?5:4;
  const unit=args?.[index];
  if(!permit || permit.closed || file!=='systemd-run' || JSON.stringify(args.slice(0,4))!==JSON.stringify(prefix) ||
     !new RegExp(`^--unit=dsh-subprocess-probe-${process.pid}-[a-f0-9]{12}$`).test(unit??'') ||
     JSON.stringify(args.slice(index+1))!==JSON.stringify(['--','systemctl','--user','show',unit.slice(7)+'.scope','--property=ActiveState','--value'])) return block('subprocessBlocked')();
  return nativeSpawnSync('/usr/bin/systemd-run',args,{encoding:'utf8',timeout:5000,stdio:['ignore','ignore','pipe'],
    env:{PATH:'/usr/bin:/bin',HOME:permit.env.HOME,LANG:'C.UTF-8',LC_ALL:'C',SYSTEMD_LOG_TARGET:'null'}});
};
syncBuiltinESMExports();
