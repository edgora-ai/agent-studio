#!/usr/bin/env node
import { readFile, writeFile, mkdir, chmod, stat, lstat, readdir, realpath, copyFile, symlink, unlink, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {projectSidebar,projectNativeTerminal} from './sidebar-projection.mjs';

export const repo = resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const DEFAULT_ROOT = join(repo,'.preview/agent-studio');
const template = join(repo,'profiles/agent-studio-preview');
const SDK = '/home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh';
const SIDEBAR = '/home/ubuntu/.dsh/profiles/web/node_modules/dsh-better-sidebar';
const digest = data => createHash('sha256').update(data).digest('hex');
const json = async file => JSON.parse(await readFile(file,'utf8'));
async function absent(file) { try { await lstat(file); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } }
async function privateWrite(file, content) {
  await mkdir(dirname(file),{ recursive: true, mode: 0o700 });
  if (!await absent(file) && (await lstat(file)).isSymbolicLink()) throw new Error('Refusing symlink output');
  await writeFile(file,content,{ mode: 0o600 }); await chmod(file,0o600);
}
async function rootDirectory(root) {
  if (!root.startsWith(`${join(repo,'.preview')}/`) && !/^\/tmp\/agent-studio-test-[^/]+$/.test(root)) throw new Error('Root must be inside repository .preview or a fresh /tmp/agent-studio-test-* directory');
  await mkdir(root,{ recursive: true, mode: 0o700 });
  if (await realpath(root) !== root) throw new Error('Preview root must not contain symlinks');
  const marker = join(root,'.agent-studio-root');
  if (await absent(marker)) {
    if ((await readdir(root)).length) throw new Error('Refusing nonempty unowned runtime root');
    await privateWrite(marker,'agent-studio-preview-v1\n');
  }
  if ((await readFile(marker,'utf8')).trim() !== 'agent-studio-preview-v1') throw new Error('Unrecognized preview root');
  await chmod(root,0o700);
}
async function startTicks(pid) {
  try { return (await readFile(`/proc/${pid}/stat`,'utf8')).split(') ')[1].split(' ')[19]; }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function ownedProcess(root) {
  if (await absent(join(root,'process.json'))) return undefined;
  const processInfo = await json(join(root,'process.json'));
  try {
    if (await startTicks(processInfo.pid) !== processInfo.start_ticks) return undefined;
    if ((await readFile(`/proc/${processInfo.pid}/stat`,'utf8')).split(') ')[1].split(' ')[0] === 'Z') return undefined;
    const cmd = (await readFile(`/proc/${processInfo.pid}/cmdline`,'utf8')).split('\0');
    if (!cmd.includes(join(root,'runtime/fence.mjs')) || !cmd.includes(join(SDK,'lib/bin.js')) || !cmd.includes('agent-studio-preview')) {
      // Linux clears cmdline during exit, between the preceding two proc reads.
      if (await startTicks(processInfo.pid) !== processInfo.start_ticks || (await readFile(`/proc/${processInfo.pid}/stat`,'utf8')).split(') ')[1].split(' ')[0] === 'Z') return undefined;
      throw new Error('PID ownership check failed; refusing to signal');
    }
    return processInfo;
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
// Pure admission checks, also exercised without invoking prepare or starting DSH.
export function verifySdkVersion(manifest,lock) {
  if(manifest.name!==lock.sdk.package)throw new Error('Unexpected dsh package: expected '+lock.sdk.package+', installed '+manifest.name);
  if(manifest.version!==lock.sdk.version)throw new Error('Unverified dsh baseline: recorded '+lock.sdk.version+', installed '+manifest.version+'. Run node scripts/dev/source-lock.mjs and review an updated compatibility snapshot; the historical release is not a permanent version requirement.');
}
export function verifyNativeTerminalPatch(stockBytes,patchBytes,lock) {
  if(digest(stockBytes)!==lock.stock_patch.sha256)throw new Error('Native stock patch hash mismatch');
  const {parse}=createRequire(join(SDK,'package.json'))('yaml');
  const parsePatch=bytes=>parse(bytes.toString(),{customTags:[{tag:'tag:yaml.org,2002:js',resolve:value=>value}]});
  const rows=value=>Array.isArray(value)?value.flatMap(rows):value&&typeof value==='object'?[value,...Object.values(value).flatMap(rows)]:[];
  const stock=rows(parsePatch(stockBytes)).filter(row=>row.id===lock.stock_plugin_id);
  if(stock.length!==1||stock[0].name!==lock.package)throw new Error('Native stock plugin identity mismatch');
  const patch=rows(parsePatch(patchBytes)),disabled=patch.filter(row=>row.id===lock.stock_plugin_id),replacement=patch.filter(row=>row.id==='studio-native-terminal');
  if(disabled.length!==1||disabled[0].disabled!==true||disabled[0].name!==undefined||replacement.length!==1||replacement[0].name!=='./native-terminal/lib/index.js'||replacement[0].disabled||patch.some(row=>row.name===lock.package)||patch.filter(row=>row.name==='./native-terminal/lib/index.js').length!==1)throw new Error('Native private plugin replacement mismatch');
}

// This target is outside node_modules/@deepseek-ai, which remains an untouched
// SDK namespace symlink. Refuse unfamiliar paths, symlinks and hardlinked files.
export async function writeNativeTerminalProjection(profile,assets) {
  async function directory(path,create=false) {
    if(create&&await absent(path))await mkdir(path,{mode:0o700});
    const info=await lstat(path);
    if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid()||await realpath(path)!==path)throw new Error('Unsafe native projection directory: '+path);
  }
  profile=resolve(profile);await directory(profile);
  const target=join(profile,'native-terminal'),marker=join(target,'.agent-studio-native-terminal');
  if(await absent(target)) {await directory(target,true);await privateWrite(marker,'agent-studio-native-terminal-v1\n');}
  else {
    await directory(target);
    if(await absent(marker)||!(await lstat(marker)).isFile()||(await lstat(marker)).isSymbolicLink()||(await lstat(marker)).nlink!==1||(await lstat(marker)).uid!==process.getuid()||await readFile(marker,'utf8')!=='agent-studio-native-terminal-v1\n')throw new Error('Unrecognized native projection directory');
  }
  const allowed=new Set(['package.json','LICENSE','README.i18n.yaml','README.md','README.zh.md','lib/index.js','lib/client.js','lib/client.terminal.js','locale/en.json','locale/zh.json','lib/types/index.d.ts',...'face index LazyTerminalBody locales terminal-cursor terminal-theme terminal TerminalCleanup TerminalGuide TerminalIcon TerminalRecovery TerminalTitle'.split(' ').map(name=>'lib/types/client/'+name+'.d.ts')]);
  const entries=Object.entries(assets),hashes={};
  if(entries.length!==allowed.size||entries.some(([file])=>!allowed.has(file)))throw new Error('Unexpected native projection assets');
  // Validate every existing destination before replacing any package bytes.
  for(const [file] of entries) {
    let parent=target;for(const part of file.split('/').slice(0,-1)){parent=join(parent,part);await directory(parent,true);}
    const output=join(target,file);
    if(!await absent(output)) {const info=await lstat(output);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.uid!==process.getuid())throw new Error('Unsafe native projection output');}
  }
  for(const [file,bytes] of entries) {await privateWrite(join(target,file),bytes);hashes[file]=digest(bytes);}
  return hashes;
}

export async function prepare(root) {
  await rootDirectory(root);
  const lock = await json(join(template,'sources.lock.json'));
  verifySdkVersion(await json(join(SDK,'package.json')),lock);
  const nativeSource=join(SDK,'node_modules',lock.native_terminal.package),nativeAssets={};
  if((await json(join(nativeSource,'package.json'))).version!==lock.native_terminal.version)throw new Error('Unsupported native terminal UI version');
  verifyNativeTerminalPatch(await readFile(join(SDK,'node_modules',lock.native_terminal.stock_patch.file)),await readFile(join(template,'cordis.patch.yml')),lock.native_terminal);
  // Validate every source and seam before any private native-terminal file write.
  for(const file of Object.keys(lock.native_terminal.files))nativeAssets[file]=projectNativeTerminal(file,await readFile(join(nativeSource,file)));
  const profile = join(root,'dsh/profiles/agent-studio-preview');
  for (const dir of ['home','cwd','xdg/config','xdg/cache','xdg/data','tmp','anchors','projects/local','runtime', 'dsh/profiles/agent-studio-preview/node_modules']) await mkdir(join(root,dir),{ recursive: true, mode: 0o700 });
  await privateWrite(join(profile,'package.json'),await readFile(join(template,'package.json')));
  const patchFile = join(profile,'cordis.patch.yml');
  let acknowledgement = '';
  if (!await absent(patchFile)) {
    const { parse } = createRequire(join(SDK,'package.json'))('yaml');
    const previous = parse(await readFile(patchFile,'utf8'),{ customTags: [{ tag:'tag:yaml.org,2002:js', resolve:value=>value }] });
    if (previous?.some(row => row.id === 'ui-settings-general' && row.config?.welcomeNoticeVersion === '2026-09-28.1'))
      acknowledgement = '\n- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: "2026-09-28.1"\n';
    const {stringify}=createRequire(join(SDK,'package.json'))('yaml');
    for(const id of ['llm-pi-ai','agent-default-model']) {
      const entries=previous?.filter(row=>row.id===id && row.config);
      if(entries?.length) acknowledgement+='\n'+stringify([{id,config:entries.at(-1).config}]);
    }
  }
  // Reconcile deployment-owned code; retain the only user-mutable metadata field.
  // Binding DB, native logs, workspace registry, auth keys and operator catalog are never reset.
  await privateWrite(patchFile,(await readFile(join(template,'cordis.patch.yml'),'utf8')) + acknowledgement);
  await privateWrite(join(root,'runtime/fence.mjs'),await readFile(join(repo,'scripts/dev/fence.mjs')));
  const studioSource = join(repo,'packages/dsh-agent-studio');
  for (const file of ['index.mjs','store.mjs','bindings.mjs','adapters/host.mjs','adapters/helper-channel.mjs','adapters/child-boundary.mjs','adapters/bound-provider.mjs','adapters/host-files.mjs','adapters/agent-terminal.mjs','adapters/bound-reads.mjs','adapters/bound-watch.mjs','adapters/remote-read.py','adapters/local-provider.mjs','model-state.mjs','model-session.mjs','credentials.mjs','adapters/agent-tools.mjs','acp-state.mjs','acp-protocol.mjs','acp-backends.mjs','acp-session.mjs','acp-sidebar.mjs','environment-state.mjs','environment-manager.mjs','environment-sidebar.mjs','adapters/environment-broker.mjs','adapters/acp-stdio.mjs','adapters/acp-launch-v1.py','recovery-state.mjs','task-recovery.mjs','recovery-sidebar.mjs']) await privateWrite(join(profile,'studio',file),await readFile(join(studioSource,file)));
  for(const [file,hash] of Object.entries({...lock.local_sdk.files,...lock.model_sdk.files,...lock.acp_sdk.files})) {
    if(digest(await readFile(join(SDK,'node_modules',file)))!==hash) throw new Error(`Installed SDK source mismatch: ${file}`);
  }
  const helperSources={};
  for(const [file,hash] of Object.entries(lock.remote_helper.files)) {
    const source=join(repo,lock.remote_helper.source,file);
    if(digest(await readFile(source))!==hash) throw new Error(`Remote helper source mismatch: ${file}`);
    helperSources[source]=hash;
  }
  await privateWrite(join(root,'helper-sources.json'),JSON.stringify(helperSources,null,2));
  const gatewaySource = join(SDK,'node_modules/@deepseek-ai/dsh-api-gateway');
  const gateway = await readFile(join(gatewaySource,lock.gateway.source),'utf8');
  if (digest(gateway) !== lock.gateway.sha256) throw new Error('Gateway source hash mismatch');
  const seam = '\t\tconst validated = validateArguments(descriptor, request.args, endpoint);';
  if (gateway.split(seam).length !== 2) throw new Error('Gateway seam is not unique');
  const methodSeam = '\t\tconst method = Reflect.get(callReceiver, implementation);';
  if (gateway.split(methodSeam).length !== 2) throw new Error('Gateway receiver seam is not unique');
  const eventSeam='\t\t\tconst projected = projectRemoteEventRequest(source.request, source.context.subject);';
  const eventIdSeam='\t\t\twhile (this.pendingRemoteEvents.has(id)) id = randomUUID();';
  const replySeam='\t\tif (pending === void 0 || !pending.deliveries.has(client)) return;';
  for(const text of [eventSeam,eventIdSeam,replySeam]) if(gateway.split(text).length!==2) throw new Error('Gateway model-control seam is not unique');
  const patched = 'import { guardGateway } from "../../studio/adapters/host.mjs";\nimport {prepareRemoteEvent,guardRemoteReply} from "../../studio/model-session.mjs";\n' + gateway
    .replace(seam,`${seam}\n\t\tconst studioMethod = await guardGateway(this.ctx, request, descriptor, validated, RemoteError);`)
    .replace(methodSeam,'\t\tconst method = studioMethod ?? Reflect.get(callReceiver, implementation);')
    .replace(eventSeam,'')
    .replace(eventIdSeam,eventIdSeam+'\n\t\t\tprepareRemoteEvent(this.ctx,source,id);\n'+eventSeam)
    .replace(replySeam,'\t\tif (pending === void 0 || !pending.deliveries.has(client)) throw new RemoteError("agent-studio/control-not-pending","Control is not pending for this client",{});\n\t\tguardRemoteReply(this.ctx,pending,client,result);');
  await privateWrite(join(profile,'gateway/lib/index.js'),patched);
  // Preserve the Gateway's dual-face manifest: browser Remotes require its client factory.
  for (const [file, hash] of Object.entries(lock.gateway.files)) {
    const bytes = await readFile(join(gatewaySource,file));
    if (digest(bytes) !== hash) throw new Error(`Gateway asset hash mismatch: ${file}`);
    await privateWrite(join(profile,'gateway',file),bytes);
  }
  // A one-package projection; never copy the production profile or its node_modules tree.
  const sidebarTarget = join(profile,'node_modules/dsh-better-sidebar'), projectedSidebar={};
  for (const [file, hash] of Object.entries(lock.sidebar.files)) {
    const bytes = await readFile(join(SIDEBAR,file));
    if (digest(bytes) !== hash) throw new Error(`Sidebar source hash mismatch: ${file}`);
    const projected=projectSidebar(file,bytes);projectedSidebar[file]=digest(projected);
    await privateWrite(join(sidebarTarget,file === 'lib/index.js' ? 'lib/upstream-host.js' : file),projected);
  }
  const wrapper = `import * as upstream from './upstream-host.js';\nimport { mountSidebar } from '../../../studio/adapters/host.mjs';\nexport { Config, name } from './upstream-host.js';\nexport const inject = [...upstream.inject, 'agentStudio'];\nexport function apply(ctx, config) { mountSidebar(ctx, upstream, config); }\n`;
  await privateWrite(join(sidebarTarget,'lib/index.js'),wrapper);
  const projectedNativeTerminal=await writeNativeTerminalProjection(profile,nativeAssets);
  // Resolve installed SDK dependencies without copying or modifying them.
  // Symlinks are NOT OS-enforced read-only mounts: this trusted-code preview only
  // disables runtime package mutation and fences process/network APIs.
  const deps = join(profile,'node_modules/@deepseek-ai');
  if (await absent(deps)) await symlink(join(SDK,'node_modules/@deepseek-ai'),deps);
  for (const name of ['ws','yaml']) {
    const dest = join(profile,'node_modules',name);
    if (await absent(dest)) await symlink(join(SDK,'node_modules',name),dest);
  }
  const catalogFile = join(root,'catalog.json');
  if (await absent(catalogFile)) {
    const info = await stat(join(root,'projects/local'),{ bigint: true });
    await privateWrite(catalogFile,JSON.stringify([
      { key: 'local-preview', kind: 'local', name: 'Isolated local preview', roots: [join(root,'projects/local')],
        workspace_id: randomUUID(), agent_id: randomUUID(), generation: randomUUID(), policy_version: 'd01-metadata-only-v1',
        template_version: 'preview-v1', device: String(info.dev), inode: String(info.ino), credential_ref: null },
      { key: 'remote-unverified', kind: 'coder', name: 'Pre-registered synthetic remote (not connected)', roots: ['/workspace/preview'],
        workspace_id: 'synthetic-workspace', agent_id: 'synthetic-agent', generation: 'unverified-generation',
        policy_version: 'd01-remote-disabled-v1', template_version: 'synthetic-v1', credential_ref: null },
    ],null,2));
  }
  await privateWrite(join(root,'projection.json'),JSON.stringify({ sdk: lock.sdk, gateway: { source: lock.gateway.sha256, projected: digest(patched), change: lock.gateway.change }, native_terminal: {...lock.native_terminal,projected_files:projectedNativeTerminal}, sidebar: {...lock.sidebar,projected_files:projectedSidebar,projector_sha256:digest(await readFile(join(repo,'scripts/dev/sidebar-projection.mjs')))} },null,2));
  return profile;
}
export async function start(root = DEFAULT_ROOT, host) {
  if (!['127.0.0.1','::1'].includes(host)) throw new Error('Pass explicit --host 127.0.0.1 or --host ::1 (loopback only)');
  await rootDirectory(root);
  const running = await ownedProcess(root);
  if (running) return { ...await json(join(root,'ready.json')), running: true };
  const lockPath = join(root,'launch.lock');
  let lock;
  try { lock = await open(lockPath,'wx',0o600); }
  catch (error) { throw new Error('Launch lock exists; inspect the private root before retrying', { cause: error }); }
  try {
    await prepare(root);
    const runId = randomUUID();
    const log = await open(join(root,'preview.log'),'a',0o600);
    const child = spawn(process.execPath,['--import',join(root,'runtime/fence.mjs'),join(SDK,'lib/bin.js'),
      '--profile','agent-studio-preview','--host',host,'--port','0','--no-open'], {
      cwd: join(root,'cwd'), detached: true, stdio: ['ignore',log.fd,log.fd],
      env: { PATH: '/usr/bin:/bin', HOME: join(root,'home'), DSH_HOME: join(root,'dsh'),
        XDG_CONFIG_HOME: join(root,'xdg/config'), XDG_CACHE_HOME: join(root,'xdg/cache'), XDG_DATA_HOME: join(root,'xdg/data'),
        TMPDIR: join(root,'tmp'), TMP: join(root,'tmp'), TEMP: join(root,'tmp'), LANG: 'C.UTF-8',
        DSH_TELEMETRY_DISABLED: '1', AGENT_STUDIO_ROOT: root, AGENT_STUDIO_RUN_ID: runId, AGENT_STUDIO_REPO: repo },
    });
    await new Promise((resolve,reject) => { child.once('spawn',resolve); child.once('error',reject); });
    const processInfo = { pid: child.pid, run_id: runId, start_ticks: await startTicks(child.pid) };
    await privateWrite(join(root,'process.json'),JSON.stringify(processInfo,null,2));
    child.unref(); await log.close();
    for (let i = 0; i < 240; i++) {
      if (!await absent(join(root,'ready.json'))) {
        const ready = await json(join(root,'ready.json'));
        if (ready.run_id === runId) {
          const response = await fetch(`${ready.origin}/agent-studio/health`);
          if (response.ok) return { ...ready, running: true };
        }
      }
      if (!await ownedProcess(root)) throw new Error(`Preview exited before readiness; inspect ${join(root,'preview.log')}`);
      await delay(125);
    }
    throw new Error(`Readiness timeout; inspect ${join(root,'preview.log')}; stop only this root with the stop command`);
  } finally { await lock.close(); await unlink(lockPath); }
}
export async function stop(root = DEFAULT_ROOT) {
  const owner = await ownedProcess(root);
  if (!owner) return { running: false, stopped: false };
  process.kill(owner.pid,'SIGTERM');
  for (let i = 0; i < 120; i++) {
    // Signal only after full ownership proof; once signalled, observe lifetime rather
    // than cmdline (Linux clears argv before the process is fully reaped).
    try {
      const fields = (await readFile(`/proc/${owner.pid}/stat`,'utf8')).split(') ')[1].split(' ');
      if (fields[19] !== owner.start_ticks || fields[0] === 'Z') return { running: false, stopped: true, pid: owner.pid };
    } catch (error) { if (error.code === 'ENOENT') return { running: false, stopped: true, pid: owner.pid }; throw error; }
    await delay(125);
  }
  throw new Error('Owned preview did not stop within 15 seconds; no other process was signalled');
}
export async function authenticate(root = DEFAULT_ROOT) {
  const ready = await json(join(root,'ready.json'));
  const url = (await readFile(join(root,'login.url'),'utf8')).trim();
  const response = await fetch(url,{ redirect: 'manual' });
  if (response.status !== 303) throw new Error(`Preview authentication failed (${response.status})`);
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  if (!cookie) throw new Error('Preview did not issue an authentication cookie');
  return { origin: ready.origin, cookie };
}
export async function requestRpc(auth, method, payload = {}, channel = '/agent-studio-rpc') {
  const response = await fetch(`${auth.origin}${channel}/${method}`,{ method: 'POST', headers: { 'content-type': 'application/json', cookie: auth.cookie, origin: auth.origin },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }) });
  if (!response.ok) throw new Error(`RPC HTTP status ${response.status}`);
  const envelope = await response.json();
  if (!envelope.result?.ok) throw Object.assign(new Error(envelope.result?.error?.message ?? 'Invalid RPC envelope'), { code: envelope.result?.error?.code });
  return envelope.result.value;
}
export async function registerRemote(root=DEFAULT_ROOT) {
  if(await ownedProcess(root)) throw new Error('Stop this preview before registering its immutable operator catalog; then start and remote-demo');
  await prepare(root);
  const child=spawn('/usr/bin/python3',['-I',join(repo,'packages/dsh-agent-studio/adapters/coder_broker.py'),root,'register'],{
    cwd:join(root,'cwd'),env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['ignore','pipe','pipe'],timeout:90000});
  let output='';child.stdout.on('data',data=>{output+=data.toString();});child.stderr.resume();
  const status=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  if(status!==0) throw new Error('Existing m1-a registration failed; broker diagnostics withheld');
  return JSON.parse(output);
}
export async function registerLocal(root=DEFAULT_ROOT) {
  if(await ownedProcess(root)) throw new Error('Stop this preview before registering a new immutable local catalog target');
  await prepare(root);
  const catalog=await json(join(root,'catalog.json')),key='local-managed-d04-v1';
  const target=join(root,'projects/d04-local-v1'),existing=catalog.find(item=>item.key===key);
  if(existing) {
    const info=await lstat(target,{bigint:true});
    if(existing.kind!=='local' || existing.provider!=='local-managed' || existing.policy_version!=='d04-trusted-local-v1' || existing.local_execution!==true || JSON.stringify(existing.roots)!==JSON.stringify([target]) || String(info.dev)!==existing.device || String(info.ino)!==existing.inode || await realpath(target)!==target)
      throw new Error('Immutable local catalog changed; register a new target instead');
    return {catalog_key:key,provider:existing.provider,target_root:target,generation:existing.generation,reused:true};
  }
  if(!await absent(target)) throw new Error('Refusing an existing unregistered local project');
  await mkdir(target,{mode:0o700});
  const info=await lstat(target,{bigint:true});
  const spec={key,kind:'local',provider:'local-managed',name:'Managed synthetic local project',roots:[target],workspace_id:randomUUID(),agent_id:randomUUID(),generation:randomUUID(),policy_version:'d04-trusted-local-v1',template_version:'local-v1',local_execution:true,device:String(info.dev),inode:String(info.ino),credential_ref:null};
  for(const dir of ['local/d04-local-v1/home','local/d04-local-v1/tmp']) await mkdir(join(root,dir),{recursive:true,mode:0o700});
  await privateWrite(join(target,'.agent-studio-binding.json'),JSON.stringify({catalog_key:key,generation:spec.generation,synthetic:true}));
  await privateWrite(join(root,'catalog.json'),JSON.stringify([...catalog,spec],null,2));
  return {catalog_key:key,provider:spec.provider,target_root:target,generation:spec.generation,reused:false};
}
export async function registerModel(root=DEFAULT_ROOT,remote=false) {
  if(await ownedProcess(root)) throw new Error('Stop this preview before registering a new D05 policy');
  await prepare(root);
  if(remote) await registerRemote(root);
  const catalog=await json(join(root,'catalog.json')),key=remote?'coder-lab-m1-a-d05-v1':'local-managed-d05-v1';
  const existing=catalog.find(item=>item.key===key);
  if(existing) {
    if(existing.model_execution!==true || existing.policy_version!==(remote?'d05-model-helper-v1':'d05-model-local-v1')) throw new Error('D05 immutable policy mismatch');
    return {catalog_key:key,reused:true};
  }
  let spec;
  if(remote) {
    const source=catalog.find(item=>item.key==='coder-lab-m1-a');
    if(!source || source.workspace_id!=='ff136352-6a92-41d4-9c2c-6cc783cb989b') throw new Error('Authorized m1-a snapshot absent');
    spec={...source,key,name:'D05 model tools · existing m1-a',policy_version:'d05-model-helper-v1',model_execution:true};
  } else {
    const target=join(root,'projects/d05-local-v1');
    if(!await absent(target)) throw new Error('Refusing unregistered existing D05 project');
    await mkdir(target,{mode:0o700});const info=await lstat(target,{bigint:true});
    for(const path of ['local/d05-local-v1/home','local/d05-local-v1/tmp']) await mkdir(join(root,path),{recursive:true,mode:0o700});
    spec={key,kind:'local',provider:'local-managed',name:'D05 model tools · synthetic local',roots:[target],workspace_id:randomUUID(),agent_id:randomUUID(),generation:randomUUID(),policy_version:'d05-model-local-v1',template_version:'local-v1',local_execution:true,model_execution:true,device:String(info.dev),inode:String(info.ino),credential_ref:null};
    await privateWrite(join(target,'.agent-studio-binding.json'),JSON.stringify({catalog_key:key,generation:spec.generation,synthetic:true}));
  }
  await privateWrite(join(root,'catalog.json'),JSON.stringify([...catalog,spec],null,2));return {catalog_key:key,reused:false};
}
export async function registerAcp(root=DEFAULT_ROOT,remote=false) {
  if(await ownedProcess(root)) throw new Error('Stop this preview before registering a new D06 policy');
  await prepare(root);if(remote) await registerRemote(root);
  const catalog=await json(join(root,'catalog.json')),key=remote?'coder-lab-m1-a-d06-v1':'local-managed-d06-v1';
  const existing=catalog.find(item=>item.key===key),policy=remote?'d06-acp-helper-v1':'d06-acp-local-v1';
  if(existing) {
    if(existing.acp_execution!==true || existing.policy_version!==policy || existing.model_execution===true) throw new Error('D06 immutable policy mismatch');
    return {catalog_key:key,reused:true};
  }
  let spec;
  if(remote) {
    const source=catalog.find(item=>item.key==='coder-lab-m1-a');
    if(!source || source.workspace_id!=='ff136352-6a92-41d4-9c2c-6cc783cb989b') throw new Error('Authorized m1-a snapshot absent');
    spec={...source,key,name:'D06 ACP · existing m1-a',policy_version:policy,acp_execution:true};
  } else {
    const target=join(root,'projects/d06-acp-v1');
    if(!await absent(target)) throw new Error('Refusing unregistered existing D06 project');
    await mkdir(target,{mode:0o700});const info=await lstat(target,{bigint:true});
    for(const path of ['local/d06-acp-v1/home','local/d06-acp-v1/tmp']) await mkdir(join(root,path),{recursive:true,mode:0o700});
    spec={key,kind:'local',provider:'local-managed',name:'D06 ACP · owned local',roots:[target],workspace_id:randomUUID(),agent_id:randomUUID(),generation:randomUUID(),policy_version:policy,template_version:'local-v1',local_execution:true,acp_execution:true,device:String(info.dev),inode:String(info.ino),credential_ref:null};
    await privateWrite(join(target,'.agent-studio-binding.json'),JSON.stringify({catalog_key:key,generation:spec.generation,synthetic:true}));
  }
  await privateWrite(join(root,'catalog.json'),JSON.stringify([...catalog,spec],null,2));return {catalog_key:key,reused:false};
}
export async function enableAcpPeer(root=DEFAULT_ROOT,remote=false) {
  await registerAcp(root,remote);
  const bytes=await readFile(join(repo,'scripts/dev/acp.peer.py')),sha256=digest(bytes),asset='acp-peer-v1-'+sha256+'.py';
  const executable=remote?'/usr/local/bin/python3.13':await realpath('/usr/bin/python3');
  const executableHash=remote?'037790041b8d9793336e9c1884b85cf3252bd3f41e06b040e222f52fedcae65c':digest(await readFile(executable));
  const row={id:remote?'offline-acp-peer-m1-a-v1':'offline-acp-peer-local-v1',name:'OFFLINE ACP PROTOCOL PEER — NOT A CODING CLI',version:'protocol-peer-1.0.0',protocol:'acp',kinds:[remote?'coder':'local'],policies:[remote?'d06-acp-helper-v1':'d06-acp-local-v1'],executable,executable_sha256:executableHash,argv:['-I','{root}/'+asset],credential_refs:{ACP_TEST_KEY:'STUDIO_ACP_OFFLINE_PEER'},environment:{},offline_fixture:true,bootstrap:{executable,sha256:executableHash},assets:[{name:asset,sha256}]};
  const file=join(root,'acp-backends.json'),catalog=await absent(file)?{version:1,backends:[]}:await json(file);
  const previous=catalog.backends.find(item=>item.id===row.id);
  if(previous && JSON.stringify(previous)!==JSON.stringify(row)) throw new Error('Registered ACP peer changed; use a new backend id/version, never replace its manifest');
  await privateWrite(join(root,'runtime/acp-assets',asset),bytes);
  if(!previous) {catalog.backends.push(row);await privateWrite(file,JSON.stringify(catalog,null,2));}
  return {backend_id:row.id,offline_fixture:true,real_cli:false,credential_ref:'STUDIO_ACP_OFFLINE_PEER',reused:Boolean(previous)};
}
export async function acpDemo(root=DEFAULT_ROOT,remote=false) {
  const auth=await authenticate(root),name=remote?'D06 ACP Remote':'D06 ACP Local',projects=await requestRpc(auth,'project.list');
  const project=projects.find(row=>row.name===name)??await requestRpc(auth,'project.create',{name});
  const environment=await requestRpc(auth,'environment.register',{catalog_key:remote?'coder-lab-m1-a-d06-v1':'local-managed-d06-v1'});
  const binding=(await requestRpc(auth,'binding.list')).find(row=>row.project_id===project.project_id && row.environment_id===environment.environment_id && row.state==='ready')??await requestRpc(auth,'binding.create',{project_id:project.project_id,environment_id:environment.environment_id});
  const session=(await requestRpc(auth,'session.list')).find(row=>row.binding_id===binding.binding_id && row.version===binding.version && row.state==='ready')??await requestRpc(auth,'session.create',{binding_id:binding.binding_id,version:binding.version,title:name});
  const result={project_id:project.project_id,environment_id:environment.environment_id,binding_id:binding.binding_id,version:binding.version,session_id:session.session_id,workspace_id:binding.workspace_id,target_root:binding.target_root};
  if(remote) await requestRpc(auth,'remote.connect',{session_id:session.session_id});
  await privateWrite(join(root,remote?'acp-remote-demo.json':'acp-local-demo.json'),JSON.stringify(result,null,2));return result;
}
export async function modelDemo(root=DEFAULT_ROOT,remote=false) {
  const auth=await authenticate(root),name=remote?'D05 Model Remote':'D05 Model Local',projects=await requestRpc(auth,'project.list');
  const project=projects.find(row=>row.name===name)??await requestRpc(auth,'project.create',{name});
  const environment=await requestRpc(auth,'environment.register',{catalog_key:remote?'coder-lab-m1-a-d05-v1':'local-managed-d05-v1'});
  const binding=(await requestRpc(auth,'binding.list')).find(row=>row.project_id===project.project_id && row.environment_id===environment.environment_id && row.state==='ready')??await requestRpc(auth,'binding.create',{project_id:project.project_id,environment_id:environment.environment_id});
  const session=(await requestRpc(auth,'session.list')).find(row=>row.binding_id===binding.binding_id && row.version===binding.version && row.state==='ready')??await requestRpc(auth,'session.create',{binding_id:binding.binding_id,version:binding.version,title:name});
  const result={project_id:project.project_id,environment_id:environment.environment_id,binding_id:binding.binding_id,version:binding.version,session_id:session.session_id,workspace_id:binding.workspace_id,target_root:binding.target_root};
  if(remote) await requestRpc(auth,'remote.connect',{session_id:session.session_id});
  await privateWrite(join(root,remote?'model-remote-demo.json':'model-local-demo.json'),JSON.stringify(result,null,2));return result;
}
export async function demo(root = DEFAULT_ROOT,remote=false,local=false) {
  const auth = await authenticate(root),name=local?'D04 Local Project':remote?'D02 Remote Project':'D01 Preview Project';
  const projects = await requestRpc(auth,'project.list');
  let project = projects.find(row => row.name === name);
  if (!project) project = await requestRpc(auth,'project.create',{ name });
  const environment = await requestRpc(auth,'environment.register',{ catalog_key: local?'local-managed-d04-v1':remote?'coder-lab-m1-a':'local-preview' });
  let binding = (await requestRpc(auth,'binding.list')).find(row => row.project_id === project.project_id && row.environment_id === environment.environment_id && row.state === 'ready');
  if (!binding) binding = await requestRpc(auth,'binding.create',{ project_id: project.project_id, environment_id: environment.environment_id });
  let session = (await requestRpc(auth,'session.list')).find(row => row.binding_id === binding.binding_id && row.version === binding.version && row.state === 'ready');
  if (!session) session = await requestRpc(auth,'session.create',{ binding_id: binding.binding_id, version: binding.version, title: local?'D04 Local Session':remote?'D02 Remote Session':'D01 Native Session' });
  const ids={project_id:project.project_id,environment_id:environment.environment_id,binding_id:binding.binding_id,version:binding.version,session_id:session.session_id,workspace_id:binding.workspace_id};
  if(remote) {
    ids.target_root=binding.target_root;
    await requestRpc(auth,'remote.connect',{session_id:session.session_id});
    await privateWrite(join(root,'remote-demo.json'),JSON.stringify(ids,null,2));
  }
  if(local) {
    ids.target_root=binding.target_root;
    await requestRpc(auth,'dispatch.check',{session_id:session.session_id,operation:'command.exec'});
    await privateWrite(join(root,'local-demo.json'),JSON.stringify(ids,null,2));
  }
  return {...ids,origin:auth.origin};
}
async function main() {
  const [command,...args] = process.argv.slice(2); const options = {};
  for (let i=0;i<args.length;i+=2) {
    if (!['--root','--host'].includes(args[i]) || !args[i+1]) throw new Error('Unknown or incomplete option');
    options[args[i].slice(2)] = args[i+1];
  }
  const root = options.root ? resolve(options.root) : DEFAULT_ROOT;
  let output;
  switch (command) {
    case 'start': output = await start(root,options.host); break;
    case 'stop': output = await stop(root); break;
    case 'restart': await stop(root); output = await start(root,options.host); break;
    case 'status': output = { running: Boolean(await ownedProcess(root)), ...(!await absent(join(root,'ready.json')) ? await json(join(root,'ready.json')) : {}) }; break;
    case 'demo': output = await demo(root); break;
    case 'register-remote': output=await registerRemote(root);break;
    case 'remote-demo': output=await demo(root,true);break;
    case 'register-local': output=await registerLocal(root);break;
    case 'local-demo': output=await demo(root,false,true);break;
    case 'register-model-local': output=await registerModel(root);break;
    case 'register-model-remote': output=await registerModel(root,true);break;
    case 'model-local-demo': output=await modelDemo(root);break;
    case 'model-remote-demo': output=await modelDemo(root,true);break;
    case 'register-acp-local': output=await registerAcp(root);break;
    case 'register-acp-remote': output=await registerAcp(root,true);break;
    case 'enable-acp-peer-local': output=await enableAcpPeer(root);break;
    case 'enable-acp-peer-remote': output=await enableAcpPeer(root,true);break;
    case 'acp-local-demo': output=await acpDemo(root);break;
    case 'acp-remote-demo': output=await acpDemo(root,true);break;
    default: console.log('Usage: node scripts/dev/preview.mjs start|restart --host <loopback> [--root <private-root>]\n       node scripts/dev/preview.mjs status|stop|demo|register-local|local-demo|register-remote|remote-demo [--root <private-root>]\n       node scripts/dev/preview.mjs register-model-local|register-model-remote|model-local-demo|model-remote-demo [--root <private-root>]\n       node scripts/dev/preview.mjs register-acp-local|register-acp-remote|enable-acp-peer-local|enable-acp-peer-remote|acp-local-demo|acp-remote-demo [--root <private-root>]'); return;
  }
  console.log(JSON.stringify(output,null,2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
