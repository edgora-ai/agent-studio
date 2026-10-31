import {posix} from 'node:path';
import {randomUUID} from 'node:crypto';
import {requireThat,StudioError,now} from '../store.mjs';
import {modelCallContext,sha} from '../model-state.mjs';
import {relativePath} from './bound-provider.mjs';
const SDK='file:///home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/';
const LIMIT=196608;
const enabled=['read','write','edit','bash','search','ask_user_question'];
const mutating=new Set(['write','edit','bash']);

export function boundToolServices(studio,agent,row,binding) {
  const principal=row.principal_id,session_id=row.session_id,provider=studio.provider;
  const targets=new WeakSet(),observed=new Map();
  const authorize=async(operation='fs.read')=>{
    const call=modelCallContext.getStore();
    requireThat(call?.session_id===session_id && call.agent===agent && !call.signal.aborted,'native-tool-context-required');
    await studio.models.authorize(principal,{session_id});
    return provider.authorized(principal,{session_id},operation);
  };
  const relative=value=>{
    requireThat(typeof value==='string','invalid-path');
    const path=value===binding.target_root || value==='.'?'':value.startsWith(binding.target_root+'/')?value.slice(binding.target_root.length+1):value;
    return relativePath(path);
  };
  const mint=path=>{const value=Object.freeze({targetKey:session_id+'\0'+path,displayPath:posix.join(binding.target_root,path)});targets.add(value);return value;};
  const target=value=>{requireThat(targets.has(value),'unowned-fs-target');return relative(value.displayPath);};
  const file=(method,path,extra={})=>provider.file(principal,method,{session_id,path,...extra});
  const read=async value=>{
    const context=await authorize(),path=target(value),operation_id=randomUUID();
    studio.store.beginOperation(principal,context.session,'agent.fs.read',{operation_id,path});
    try {
      const result=await file('read',path),content=studio.files.text(result);observed.set(path,{version:result.version,content});
      studio.store.updateOperation(principal,operation_id,{state:'completed',result_json:JSON.stringify({version:result.version,sha256:result.sha256,bytes:result.metadata.size})});
      return {result,content};
    } catch(error) {studio.store.updateOperation(principal,operation_id,{state:'failed',error_code:error.code??'read-failed'});throw error;}
  };
  const write=async(value,content,expected,signal)=>{
    signal?.throwIfAborted();await authorize('fs.write');const path=target(value),prior=observed.get(path);
    requireThat(typeof content==='string' && Buffer.byteLength(content)<=LIMIT,'file-too-large');
    if(expected) requireThat(expected.kind==='createIfAbsent'?prior===undefined:prior?.version===expected.version,'FS_STALE_VERSION');
    // No prior read means create-if-absent, NEVER blind replacement. The provider
    // checks the target again and atomically compares the observed version.
    const result=await file('write',path,{operation_id:randomUUID(),encoding:'utf8',data:content,expected_version:prior?.version??null});
    observed.set(path,{version:result.version,content});
    return {operation:prior?'update':'create',version:result.version,before:prior?.content??null,after:content};
  };
  const fs={
    sandboxMode:undefined,
    async resolve(path,options={}) {options.signal?.throwIfAborted();await authorize();requireThat(options.cwd===undefined || options.cwd===binding.target_root,'cwd-outside-binding');return mint(relative(path));},
    processPath(value) {target(value);return value.displayPath;},
    processPathFromHostPath() {return undefined;},
    fileUrl() {throw new StudioError('file-url-disabled');},
    contains(parent,child) {const p=target(parent),c=target(child);return p==='' || p===c || c.startsWith(p+'/');},
    async stat(value,signal) {
      signal?.throwIfAborted();await authorize();const path=target(value);
      if(path==='') {await file('list','');return {type:'directory',version:binding.instance_generation};}
      const parent=posix.dirname(path),listing=await file('list',parent==='.'?'':parent),entry=listing.entries.find(e=>e.name===posix.basename(path));
      if(!entry) return undefined;
      requireThat(['file','directory'].includes(entry.metadata.type),'path-outside-binding');
      // The helper lists s1 metadata tokens but reads return content-bound v1
      // tokens. Native fs observations must use the token the mutation CAS accepts.
      if(entry.metadata.type==='file') {const full=await file('read',path);return {version:full.version,type:'file',size:full.metadata.size};}
      return {version:entry.version??entry.metadata.version,type:'directory',size:entry.metadata.size};
    },
    async lstat(path,options,signal) {return this.stat(await this.resolve(path,options),signal);},
    async readText(value,signal) {signal?.throwIfAborted();return (await read(value)).content;},
    async streamText(value,signal) {const content=await this.readText(value,signal);return (async function*(){signal?.throwIfAborted();yield content;})();},
    async readBytes(value,signal,maxBytes) {signal?.throwIfAborted();requireThat(maxBytes<=LIMIT,'file-too-large');const data=Buffer.from((await read(value)).result.data,'base64');requireThat(data.length<=maxBytes,'file-too-large');return data;},
    async listDir(value,signal) {signal?.throwIfAborted();await authorize();const path=target(value),listing=await file('list',path);return listing.entries.map(e=>({name:e.name,type:e.metadata.type,target:mint(path?path+'/'+e.name:e.name),version:e.version,size:e.metadata.size}));},
    writeText:write,
    async editText(value,edit,expected,signal) {
      signal?.throwIfAborted();await authorize('fs.write');const prior=observed.get(target(value));
      requireThat(prior && (!expected || expected.version===prior.version),'FS_NOT_OBSERVED');
      requireThat(typeof edit.oldString==='string' && edit.oldString.length>0 && typeof edit.newString==='string' && edit.oldString!==edit.newString,'invalid-edit');
      const count=prior.content.split(edit.oldString).length-1;
      requireThat(count>0,'FS_EDIT_NOT_FOUND');requireThat(edit.replaceAll || count===1,'FS_AMBIGUOUS_EDIT');
      const after=edit.replaceAll?prior.content.split(edit.oldString).join(edit.newString):prior.content.replace(edit.oldString,()=>edit.newString);
      const result=await write(value,after,{kind:'replaceIfVersion',version:prior.version},signal);
      return {version:result.version,before:prior.content,after};
    },
  };
  const specs=new WeakSet();
  const shell={
    sandboxMode:undefined,
    resolve(request) {
      requireThat(typeof request.command==='string' && request.command.length>0 && request.command.length<=16384,'invalid-command');
      requireThat(request.env===undefined && request.stdin===undefined && request.sandboxPolicy===undefined && request.onExpiry!=='none','shell-option-disabled');
      requireThat(Object.entries(request.dshEnv??{}).every(([k,v])=>k==='DSH_SESSION_ID' && v===session_id),'shell-env-denied');
      const workdir=request.workdir??binding.target_root;relative(workdir);
      const timeoutMs=request.timeoutMs??20000;requireThat(Number.isInteger(timeoutMs) && timeoutMs>=1 && timeoutMs<=60000,'invalid-timeout');
      const spec=Object.freeze({command:request.command,workdir,timeoutMs,onExpiry:'kill',stdoutMaxBytes:LIMIT,signal:request.signal,sandboxPolicy:undefined});specs.add(spec);return spec;
    },
    async execute(spec) {
      requireThat(specs.has(spec),'unowned-shell-spec');specs.delete(spec);spec.signal?.throwIfAborted();await authorize('command.exec');
      const operation_id=randomUUID(),task=(method,extra={})=>provider.task(principal,method,{session_id,operation_id,...extra});
      await provider.start(principal,{session_id,operation_id,argv:['/bin/bash','--noprofile','--norc','-c',spec.command],cwd:relative(spec.workdir),env:{}});
      let stopped,firstCause;const timer=setTimeout(()=>{firstCause??='timeout';},spec.timeoutMs);timer.unref();
      const abort=()=>{firstCause??='abort';};spec.signal?.addEventListener('abort',abort,{once:true});if(spec.signal?.aborted) abort();
      const run=(async()=>{
        const buffers={stdout:[],stderr:[]};let size=0,cursor='0',exit;
        try {
          do {
            if(firstCause && !stopped) {await task('cancel',{action_id:randomUUID()});stopped=true;}
            const page=await task('read',{after_seq:cursor});cursor=page.nextSeq;requireThat(!page.truncated,'command-output-truncated');
            for(const chunk of page.chunks) {const bytes=Buffer.from(chunk.data,'base64');size+=bytes.length;requireThat(size<=LIMIT,'command-output-limit');requireThat(chunk.stream in buffers,'unknown-command-stream');buffers[chunk.stream].push(bytes);}
            if(page.exited) exit=page;
          } while(!exit);
          const collected=chunks=>{const bytes=Buffer.concat(chunks);return {text:new TextDecoder('utf-8',{fatal:true}).decode(bytes),totalBytes:bytes.length,truncated:false};};
          return {exitCode:exit.exitCode??null,signal:exit.signal??null,timedOut:firstCause==='timeout',aborted:firstCause==='abort',timeoutMs:spec.timeoutMs,stdout:collected(buffers.stdout),stderr:collected(buffers.stderr)};
        } finally {
          clearTimeout(timer);spec.signal?.removeEventListener('abort',abort);
          const status=await task('status');if(status.running) await task('cancel',{action_id:randomUUID()});await task('release',{action_id:randomUUID()});
        }
      })();
      // The composed native bash tool is foreground-only. Background entry points
      // fail explicitly rather than creating untracked jobs or fabricated handles.
      return {result:()=>run};
    },
    start() {throw new StudioError('background-command-disabled');},
  };
  const shellEnv={collect(exec){requireThat(exec.agent===agent && exec.agent.session.id===session_id,'shell-agent-mismatch');return Object.freeze({DSH_SESSION_ID:session_id});}};
  return {fs,shell,shellEnv,clearObservations:()=>observed.clear()};
}

export async function installAgentTools(studio,ctx,agent,row,binding,services) {
  const [{defineTool},fsTools,bashTools,questions]=await Promise.all([import(SDK+'dsh-tools/lib/index.js'),import(SDK+'dsh-tool-fs/lib/index.js'),import(SDK+'dsh-tool-bash/lib/index.js'),import(SDK+'dsh-tool-ask-user/lib/index.js')]);
  ctx.tools.restrict({allow:[]});
  ctx.tools.guard(exec=>exec.agent!==agent || !enabled.includes(exec.name)?'Bound session: tool is not adapted':undefined);
  ctx.on('tools/pre-execute',async(exec)=>{
    requireThat(exec.agent===agent && enabled.includes(exec.name),'tool-not-adapted');exec.signal.throwIfAborted();
    const request=await studio.models.activeRequest(row.session_id);
    await studio.models.authorize(row.principal_id,{session_id:row.session_id});
    const stamp=now();
    studio.store.db.prepare('INSERT INTO model_tool_calls VALUES(?,?,?,?,?,?,?,?)').run(exec.callId,row.session_id,request.request_id,exec.name,sha(exec.arguments),'pending',stamp,stamp);
    return mutating.has(exec.name)?{kind:'ask',reason:'D05 bound '+exec.name+' on '+binding.target_root+'; approval applies to this call only.'}:{kind:'allow'};
  },true);
  ctx.on('tools/execute',async(exec,next)=>{
    exec.signal.throwIfAborted();await studio.models.authorize(row.principal_id,{session_id:row.session_id});
    const request=await studio.models.activeRequest(row.session_id);
    if(mutating.has(exec.name)) requireThat(studio.store.db.prepare("SELECT 1 FROM model_controls WHERE session_id=? AND call_id=? AND request_id=? AND state='answered' AND answer_json=? AND delivery='delivered' AND run_id=?").get(row.session_id,exec.callId,request.request_id,JSON.stringify('allowed-once'),studio.models.runId),'approval-not-delivered');
    studio.store.db.prepare("UPDATE model_tool_calls SET state='running',updated_at=? WHERE session_id=? AND call_id=? AND state='pending'").run(now(),row.session_id,exec.callId);
    return modelCallContext.run({principal:row.principal_id,session_id:row.session_id,call_id:exec.callId,agent,signal:exec.signal},next);
  },true);
  ctx.on('tools/result',(exec,result)=>studio.store.db.prepare('UPDATE model_tool_calls SET state=?,updated_at=? WHERE session_id=? AND call_id=?').run(result.isError?'failed':'completed',now(),row.session_id,exec.callId));
  ctx.on('user-questions/request',(request,next)=>{const call=modelCallContext.getStore();requireThat(call?.agent===agent,'native-tool-context-required');request.studioCallId=call.call_id;return next();},true);
  ctx.plugin(fsTools,{read:true,readImage:false,write:true,edit:true,readLimit:500,readMaxLineLength:2000,readMaxBytes:LIMIT,readStreamMinSize:LIMIT+1});
  ctx.plugin(bashTools,{enableRunInBackground:false,promoteOnTimeout:false});
  ctx.plugin(questions,{mode:'legacy'});
  ctx.tools.register(defineTool({name:'search',description:'Search the bound project for literal text or filename substrings. Bounded, no regex; unavailable tools glob/grep are not emulated.',parameters:{query:{type:'string',required:true},mode:{type:'string',enum:['content','name'],required:true}},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},async execute(args,exec){
    const result=await studio.reads.sidebar(row.principal_id,'fs.search',{sessionId:row.session_id,query:args.mode==='content'?'content:'+args.query:args.query},exec.signal);return JSON.stringify(result);
  }}));
  let observedTurn;
  ctx.on('agent/pre-step',(payload,next)=>{if(observedTurn!==payload.turn) {services.clearObservations();observedTurn=payload.turn;}return next();},true);
}
