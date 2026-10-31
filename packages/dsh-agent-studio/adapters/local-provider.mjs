import {lstat,realpath,mkdir,opendir,readFile,readlink} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {requireThat,StudioError} from '../store.mjs';
import {relativePath,dimensions} from './bound-provider.mjs';

const SDK='file:///home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/';
const MAX_FILE=196608, MAX_OUTPUT=1048576;
const LOCAL_DIRECTORIES=Object.freeze({'d04-trusted-local-v1':'d04-local-v1','d05-model-local-v1':'d05-local-v1','d06-acp-local-v1':'d06-acp-v1'});
const errorCode=error=>({FS_STALE_VERSION:'E_STALE_VERSION',FS_NOT_OBSERVED:'E_STALE_VERSION',FS_NOT_FOUND:'E_NOT_FOUND',FS_TOO_LARGE:'file-too-large'}[error.code]??error.code??'local-provider-error');
export async function localProcessIdentity(pid) {
  try {
    const parts=(await readFile(`/proc/${pid}/stat`,'utf8')).split(') ')[1].split(' ');
    return {pid,start_ticks:parts[19],state:parts[0],pgrp:Number(parts[2]),session:Number(parts[3]),uid:(await lstat(`/proc/${pid}`)).uid,cwd:await readlink(`/proc/${pid}/cwd`)};
  } catch(error) {if(error.code==='ENOENT') return null;throw error;}
}

// SDK mechanics live in a child scope of the REAL factory Agent. Only these
// guarded, session-authorized consumers can reach them; Host ctx.fs is unused.
export class LocalProvider {
  constructor(studio) {
    this.studio=studio;this.store=studio.store;this.realms=new Map();this.tasks=new Map();this.locks=new Map();
    this.runtimeId=process.env.AGENT_STUDIO_RUN_ID??randomUUID();this.closed=false;this.stopping=false;this.starting=new Set();
  }
  assertLocal(context) {
    const {environment,spec,binding}=context;
    requireThat(!this.closed && environment.kind==='local' && spec.kind==='local' && environment.provider==='local-managed' && spec.provider==='local-managed','provider-unavailable');
    const directory=LOCAL_DIRECTORIES[spec.policy_version];
    requireThat(directory && spec.local_execution===true && binding.target_root===join(this.studio.root,'projects',directory) && spec.roots.length===1,'local-policy-denied');
  }
  async verify(context) {
    this.assertLocal(context);
    const {binding,spec}=context,info=await lstat(binding.target_root,{bigint:true});
    requireThat(info.isDirectory() && !info.isSymbolicLink() && await realpath(binding.target_root)===binding.target_root && String(info.dev)===spec.device && String(info.ino)===spec.inode,'instance-changed');
  }
  async install(agentCtx,agent,row,binding,environment,spec) {
    requireThat(agent.ctx===agentCtx && !this.realms.has(row.session_id),'agent-context-mismatch');
    const context={binding,environment,spec};await this.verify(context);
    const [{LocalFileSystem},{LocalSubprocessRuntime}]=await Promise.all([import(SDK+'dsh-fs-local/lib/index.js'),import(SDK+'dsh-subprocess-local/lib/index.js')]);
    const scoped=agentCtx.isolate('fs').isolate('subprocess');
    const fs=new LocalFileSystem(scoped,{cwd:binding.target_root,diffBasisMaxBytes:MAX_FILE});
    const runtime=new LocalSubprocessRuntime(scoped);
    const directory=LOCAL_DIRECTORIES[spec.policy_version];
    requireThat(directory,'local-policy-denied');
    const home=join(this.studio.root,'local',directory,'home'),tmp=join(this.studio.root,'local',directory,'tmp');
    for(const path of [home,tmp]) {
      const info=await lstat(path);
      requireThat(info.isDirectory() && !info.isSymbolicLink() && await realpath(path)===path && (info.mode&0o077)===0,'local-private-directory-invalid');
    }
    const realm={fs,runtime,agent,binding,home,tmp};this.realms.set(row.session_id,realm);
    this.store.audit(row.principal_id,'local.realm',row.session_id,'ready',{binding_id:binding.binding_id,version:binding.version,provider:'local-managed',actual_agent_id:agent.id??row.session_id});
    const authorize=async()=>{
      const current=await this.studio.provider.authorized(row.principal_id,{session_id:row.session_id},'fs.read');
      return current;
    };
    // The original model/tools remain disabled. Even a future Agent FS consumer
    // must use an owned target and cannot use resolve(cwd) to choose a world.
    const target=async(value)=>{
      await authorize();const path=typeof value==='string'?value:value?.displayPath;
      requireThat(typeof path==='string','invalid-path');
      const rel=path===binding.target_root?'':path.startsWith(binding.target_root+'/')?path.slice(binding.target_root.length+1):path;
      return this.target(context,realm,rel);
    };
    const facade={
      async resolve(path,options) {options?.signal?.throwIfAborted();requireThat(options?.cwd===undefined || options.cwd===binding.target_root,'cwd-outside-binding');return target(path);},
      async stat(value,signal) {return fs.stat(await target(value),signal);},
      async readBytes(value,signal,maxBytes) {requireThat(maxBytes<=MAX_FILE,'file-too-large');return fs.readBytes(await target(value),signal,maxBytes);},
      async readText(value,signal) {const bytes=await fs.readBytes(await target(value),signal,MAX_FILE);requireThat(!bytes.includes(0),'not-text');return new TextDecoder('utf-8',{fatal:true}).decode(bytes);},
      processPath(value) {requireThat(value?.targetKey===value?.displayPath && (value?.displayPath===binding.target_root || value?.displayPath?.startsWith(binding.target_root+'/')),'path-outside-binding');return value.displayPath;},
    };
    return new Proxy(facade,{get(object,key){if(key in object) return object[key];if(typeof key==='symbol' || key==='then') return undefined;return ()=>{throw new StudioError('agent-fs-operation-disabled');};}});
  }
  async realm(context) {
    await this.verify(context);
    await this.studio.ensureAgent(context.session.principal_id,context.session.session_id);
    const realm=this.realms.get(context.session.session_id);
    requireThat(realm && realm.binding.binding_id===context.binding.binding_id && realm.binding.version===context.binding.version,'local-realm-unavailable');return realm;
  }
  async target(context,realm,value,missing=false) {
    await this.verify(context);const path=relativePath(value),absolute=join(context.binding.target_root,path);
    let cursor=context.binding.target_root;
    const parts=path?path.split('/'):[];
    for(let i=0;i<parts.length;i++) {
      cursor=join(cursor,parts[i]);
      let info;
      try {info=await lstat(cursor);} catch(error) {if(error.code==='ENOENT' && missing && i===parts.length-1) break;throw error;}
      requireThat(!info.isSymbolicLink() && (info.isFile() || info.isDirectory()),'path-outside-binding');
      requireThat(i===parts.length-1 || info.isDirectory(),'path-outside-binding');
    }
    const target=await realm.fs.resolve(absolute);
    requireThat(String(target.targetKey)===absolute,'path-outside-binding');return target;
  }
  async serialized(key,action) {
    const work=(this.locks.get(key)??Promise.resolve()).then(action,action);
    const tail=work.then(()=>undefined,()=>undefined);this.locks.set(key,tail);
    try {return await work;} finally {if(this.locks.get(key)===tail) this.locks.delete(key);}
  }
  async metadata(path) {
    const info=await lstat(path,{bigint:true});
    return {type:info.isDirectory()?'directory':info.isFile()?'file':info.isSymbolicLink()?'symlink':'other',size:Number(info.size),mtimeNs:Number(info.mtimeNs),ctimeNs:Number(info.ctimeNs),mode:Number(info.mode&0o777n)};
  }
  async mutation(context,kind,input,action) {
    const principal=context.session.principal_id,row=this.store.beginOperation(principal,context.session,kind,input);
    this.store.updateOperation(principal,row.operation_id,{execution_kind:'local',local_runtime_id:this.runtimeId});
    try {
      const result=await action(row.operation_id);
      this.store.updateOperation(principal,row.operation_id,{state:'completed',result_json:JSON.stringify(result)});
      return {...result,operation_id:row.operation_id};
    } catch(error) {
      this.store.updateOperation(principal,row.operation_id,{state:error.uncertain?'unknown':'failed',error_code:errorCode(error)});
      throw new StudioError(errorCode(error));
    }
  }
  async file(context,method,input) {
    const realm=await this.realm(context),path=relativePath(input.path,method==='list');
    const perform=async()=>{
      const target=await this.target(context,realm,path,['write','mkdir'].includes(method));
      if(method==='list') {
        const entries=[];
        // LocalFileSystem.listDir follows child symlinks. Use its no-follow seam
        // instead, with bounded iteration, so even metadata never follows them.
        for await(const entry of await opendir(target.displayPath)) {
          if(entry.name==='.agent-studio-binding.json') continue;
          requireThat(entries.length<1000,'directory-limit');
          const info=await realm.fs.lstat(join(target.displayPath,entry.name));
          if(info) entries.push({name:entry.name,metadata:await this.metadata(join(target.displayPath,entry.name)),version:info.version});
        }
        return {entries:entries.sort((a,b)=>a.name.localeCompare(b.name)),truncated:false};
      }
      if(method==='mkdir') {await mkdir(target.displayPath,{mode:0o700});return {metadata:await this.metadata(target.displayPath)};}
      if(method==='read') {
        const before=await realm.fs.stat(target),bytes=Buffer.from(await realm.fs.readBytes(target,undefined,MAX_FILE)),after=await realm.fs.stat(target);
        requireThat(before?.version===after?.version && bytes.length===after.size,'incomplete-read');
        await this.target(context,realm,path);
        return {encoding:'base64',data:bytes.toString('base64'),version:after.version,metadata:await this.metadata(target.displayPath),sha256:createHash('sha256').update(bytes).digest('hex')};
      }
      requireThat(method==='write','unknown-method');
      requireThat(['utf8','base64'].includes(input.encoding) && typeof input.data==='string','invalid-data');
      const bytes=Buffer.from(input.data,input.encoding);
      requireThat(bytes.length<=MAX_FILE && (input.encoding!=='base64' || bytes.toString('base64')===input.data),'data-limit-or-encoding');
      requireThat(!bytes.includes(0),'not-text');
      let content;try {content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);} catch(error) {throw new StudioError('not-text');}
      requireThat(input.expected_version===null || typeof input.expected_version==='string' && input.expected_version.length>0,'version-required');
      // Do not let the SDK's recursive parent creation enlarge this API contract.
      requireThat((await lstat(dirname(target.displayPath))).isDirectory(),'parent-not-directory');
      const intent=input.expected_version===null?{kind:'createIfAbsent'}:{kind:'replaceIfVersion',version:input.expected_version};
      const written=await realm.fs.writeText(target,content,intent);
      await this.target(context,realm,path);
      return {version:written.version,metadata:await this.metadata(target.displayPath),sha256:createHash('sha256').update(bytes).digest('hex')};
    };
    try {
      if(['write','mkdir'].includes(method)) return await this.mutation(context,'fs.'+method,input,()=>this.serialized(context.binding.binding_id+'@'+context.binding.version+'\0'+path,perform));
      return await perform();
    } catch(error) {throw new StudioError(errorCode(error));}
  }
  environment(realm,input={}) {
    requireThat(Object.entries(input).every(([k,v])=>['TERM','COLORTERM'].includes(k) && typeof v==='string' && /^[A-Za-z0-9_.+-]{1,80}$/.test(v)),'local-env-denied');
    return {PATH:'/usr/bin:/bin',HOME:realm.home,LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TMPDIR:realm.tmp,...input};
  }
  async terminalEnvironment(context) {await this.realm(context);return {platform:'posix',defaultShell:'/bin/bash'};}
  async resolveExecutable(context,command) {const realm=await this.realm(context);return realm.runtime.resolveExecutable(command,this.environment(realm));}
  append(task,stream,data) {
    for(let offset=0;offset<data.length;offset+=32768) {
      const bytes=Buffer.from(data.subarray(offset,offset+32768));
      task.chunks.push({seq:++task.seq,stream,bytes});task.bytes+=bytes.length;
      while(task.bytes>MAX_OUTPUT) task.bytes-=task.chunks.shift().bytes.length;
    }
  }
  async start(context,input,acp) {
    requireThat(!this.stopping,'provider-closed');
    const same=entry=>entry.binding_id===context.binding.binding_id;
    requireThat(this.tasks.size+this.starting.size<32 && [...this.tasks.values(),...this.starting].filter(same).length<8,'local-task-limit');
    const pending={binding_id:context.binding.binding_id};this.starting.add(pending);
    pending.work=this.startOwned(context,input,acp);
    try {return await pending.work;} finally {this.starting.delete(pending);}
  }
  async startOwned(context,input,acp) {
    const realm=await this.realm(context),cwd=(await this.target(context,realm,input.cwd??'')).displayPath;
    requireThat((await lstat(cwd)).isDirectory(),'cwd-not-directory');
    if(acp) requireThat(acp.privateHome===realm.home && !input.tty,'acp-launch-home-mismatch');
    const env={...this.environment(realm,input.env),...acp?.secrets},argv=[await realm.runtime.resolveExecutable(input.argv[0],env),...input.argv.slice(1)];
    const launch=globalThis[Symbol.for('agent-studio.local-run')];requireThat(typeof launch==='function','local-capability-unavailable');
    const row=this.store.beginOperation(context.session.principal_id,context.session,input.tty?'pty.open':'command.exec',input);
    const principal=row.principal_id,operationId=row.operation_id;
    this.store.updateOperation(principal,operationId,{execution_kind:'local',local_runtime_id:this.runtimeId});
    // Tombstones remove ALL ambient variables, including harness/profile paths.
    const sdkEnv={...Object.fromEntries(Object.keys(process.env).map(k=>[k,undefined])),...env};
    const task={operationId,principal,session_id:row.session_id,binding_id:row.binding_id,version:row.version,tty:Boolean(input.tty),seq:0,bytes:0,chunks:[],finished:false,exited:false};
    try {
      await launch({binding_id:row.binding_id,version:row.version,root:context.binding.target_root,cwd,argv,env,...(acp?{acp:{task_id:acp.task_id,instance_id:acp.instance_id,credential_names:acp.credential_names}}:{})},async permit=>{
        if(input.tty) {
          task.handle=await realm.runtime.spawnTerminal({argv,cwd,env:sdkEnv,...input.tty,terminalType:env.TERM??'xterm-256color',graceMs:1000});
          task.pid=task.handle.pid;task.startTicks=(await localProcessIdentity(task.pid))?.start_ticks;
        } else {
          task.handle=realm.runtime.spawn({argv,cwd,env:sdkEnv,stdio:{stdin:'pipe',stdout:'pipe',stderr:'pipe'},graceMs:1000});
          task.pid=permit.pid;task.startTicks=permit.startTicks;
        }
      });
      this.tasks.set(operationId,task);
      const drain=async(stream,name)=>{for await(const bytes of stream) this.append(task,name,Buffer.from(bytes));};
      task.drain=Promise.all(input.tty?[drain(task.handle.output,'stdout')]:[drain(task.handle.stdout,'stdout'),drain(task.handle.stderr,'stderr')]);
      task.completion=Promise.all([task.handle.done,task.drain]).then(([outcome])=>{
        Object.assign(task,outcome,{exited:true});
        if(this.store.operation(principal,operationId).state==='running') this.store.updateOperation(principal,operationId,{state:'completed',result_json:JSON.stringify({pid:task.pid,start_ticks:task.startTicks,execution_kind:'local',...outcome})});
      },error=>{task.error=error;task.exited=true;this.store.updateOperation(principal,operationId,{state:'unknown',error_code:'local-output-failed'});});
      requireThat(Number.isSafeInteger(task.pid) && task.pid>1 && /^\d+$/.test(task.startTicks??''),'local-process-identity-unavailable');
      const result={pid:task.pid,start_ticks:task.startTicks,execution_kind:'local',local_process_id:randomUUID(),runtime_id:this.runtimeId};
      this.store.updateOperation(principal,operationId,{state:'running',local_process_id:result.local_process_id,local_pid:task.pid,local_start_ticks:task.startTicks,result_json:JSON.stringify(result)});
      return {...result,operation_id:operationId};
    } catch(error) {
      let uncertain=Boolean(task.handle);
      if(task.handle) try {await this.stop(task);uncertain=false;} catch(cleanup) {this.store.audit(principal,'local.start.cleanup',operationId,'unknown',{code:errorCode(cleanup)});}
      this.store.updateOperation(principal,operationId,{state:uncertain?'unknown':'failed',error_code:errorCode(error)});
      if(!uncertain) this.tasks.delete(operationId);
      throw new StudioError(errorCode(error));
    }
  }
  async stop(task) {
    await task.handle.terminate();
    if(!task.tty) requireThat(await task.handle.waitForExit(AbortSignal.timeout(10000)),'cancellation-unconfirmed');
    await task.completion;
    const identity=await localProcessIdentity(task.pid);
    requireThat(!identity || identity.start_ticks!==task.startTicks || identity.state==='Z','cancellation-unconfirmed');
    task.finished=true;
  }
  async task(context,method,input,row) {
    const task=this.tasks.get(row.operation_id);
    requireThat(row.local_runtime_id===this.runtimeId && row.execution_kind==='local' && task && row.state!=='unknown' && row.state!=='released','task-runtime-lost');
    requireThat(task.session_id===context.session.session_id && task.binding_id===context.binding.binding_id && task.version===context.binding.version,'task-not-owned');
    if(task.error) throw new StudioError('local-output-failed');
    if(method==='read') {
      requireThat(input.after_seq===undefined || /^\d{1,15}$/.test(input.after_seq),'invalid-cursor');
      const cursor=Number(input.after_seq??0);requireThat(cursor<=task.seq,'invalid-cursor');
      if(cursor===task.seq && !task.exited) await delay(100);
      const chunks=[];let bytes=0,next=cursor;
      for(const entry of task.chunks) if(entry.seq>cursor) {if(bytes+entry.bytes.length>65536) break;bytes+=entry.bytes.length;next=entry.seq;chunks.push({seq:String(entry.seq),stream:entry.stream,data:entry.bytes.toString('base64')});}
      return {chunks,earliestSeq:String(task.chunks[0]?.seq??task.seq+1),nextSeq:String(next),truncated:cursor<(task.chunks[0]?.seq??task.seq+1)-1,exited:task.exited && next===task.seq,exitCode:task.exitCode,signal:task.signal};
    }
    if(method==='status') return {running:!task.exited,pid:task.pid,exitCode:task.exitCode??null,signal:task.signal??null,execution_kind:'local',start_ticks:task.startTicks};
    if(method==='foreground') {requireThat(task.tty && !task.finished,'not-live-terminal');const fg=await task.handle.inspectForeground();return {verified:Boolean(fg),pgid:fg?.processGroupId};}
    requireThat(['input','resize','signal','cancel','release'].includes(method),'unknown-method');
    return this.serialized(row.operation_id,()=>this.mutation(context,'task.'+method,{...input,operation_id:input.action_id,task_id:row.operation_id},async()=>{
      if(this.store.operation(row.principal_id,row.operation_id).state==='released') {
        requireThat(['cancel','release'].includes(method),'task-runtime-lost');
        return method==='release'?{released:true}:{running:false,exitCode:task.exitCode??null,signal:task.signal??null};
      }
      if(['input','resize','signal'].includes(method)) requireThat(!task.finished && !task.exited,'process-not-running');
      if(method==='input') {
        requireThat(typeof input.data==='string' && Buffer.byteLength(input.data)<=65536,'input-limit');
        requireThat(!input.eof || !task.tty,'terminal-eof-unsupported');
        if(task.tty) await task.handle.write(input.data);
        else if(input.eof) await new Promise((resolve,reject)=>{task.handle.stdin.once('error',reject);task.handle.stdin.end(input.data,()=>{task.handle.stdin.removeListener('error',reject);resolve();});});
        else await new Promise((resolve,reject)=>task.handle.stdin.write(input.data,error=>error?reject(error):resolve()));
        return {written:Buffer.byteLength(input.data)};
      }
      if(method==='resize') {requireThat(task.tty,'not-terminal');dimensions(input.rows,input.cols);await task.handle.resize(input.cols,input.rows);return {rows:input.rows,cols:input.cols};}
      if(method==='signal') {
        requireThat(task.tty && ['SIGINT','SIGTERM','SIGHUP','SIGTSTP'].includes(input.signal),'invalid-signal');
        const pgid=await task.handle.signalForeground(input.signal);return {delivered:true,verified:true,targetPgid:pgid};
      }
      if(method==='release') requireThat(task.exited,'process-still-running');
      try {await this.stop(task);} catch(error) {error.uncertain=true;this.store.updateOperation(row.principal_id,row.operation_id,{state:'unknown',error_code:'cleanup-unconfirmed'});throw error;}
      const released=method==='release';
      requireThat(this.store.operation(row.principal_id,row.operation_id).state!=='unknown','outcome-unknown');
      this.store.updateOperation(row.principal_id,row.operation_id,{state:released?'released':'cancelled'});
      if(released) this.tasks.delete(row.operation_id);
      return released?{released:true}:{running:false,exitCode:task.exitCode??null,signal:task.signal??null};
    }));
  }
  async dispose() {
    this.stopping=true;
    await Promise.allSettled([...this.starting].map(entry=>entry.work));
    const errors=[];
    for(const task of [...this.tasks.values()]) try {
      // Native TerminalController disposal can already be cancelling this same
      // task. Share its mutation queue: a late cancel must never demote release.
      await this.serialized(task.operationId,async()=>{
        if(!this.tasks.has(task.operationId)) return;
        await this.stop(task);this.store.updateOperation(task.principal,task.operationId,{state:'released'});this.tasks.delete(task.operationId);
      });
    } catch(error) {errors.push(error);this.store.updateOperation(task.principal,task.operationId,{state:'unknown',error_code:'shutdown-cleanup-unconfirmed'});}
    this.closed=true;
    if(errors.length) throw new AggregateError(errors,'Local shutdown cleanup unconfirmed');
  }
}
