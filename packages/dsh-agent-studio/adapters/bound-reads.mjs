import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {posix} from 'node:path';
import {requireThat,StudioError} from '../store.mjs';

const worker=readFile(new URL('./remote-read.py',import.meta.url),'utf8');
export class BoundReads {
  constructor(studio) {this.studio=studio;this.active=new Map();}
  identity(context) {
    const {binding,session}=context;
    return {session_id:session.session_id,binding_id:binding.binding_id,version:binding.version,
      environment_id:binding.environment_id,generation:binding.instance_generation,target_root:binding.target_root,
      kind:context.environment?.kind==='local'?'local':'remote',provider:context.environment?.provider??'coder-helper'};
  }
  async run(context,payload,signal) {
    requireThat(!signal?.aborted,'cancelled');
    const principal=context.principal, session_id=context.session.session_id, operation_id=randomUUID();
    const key=context.binding.binding_id;
    requireThat((this.active.get(key)??0)<4,'read-concurrency-limit');
    this.active.set(key,(this.active.get(key)??0)+1);
    const provider=this.studio.provider;
    let started=false;
    try {
      await provider.start(principal,{session_id,operation_id,argv:['python3','-I','-c',await worker,context.binding.target_root,JSON.stringify(payload)]},{retain:false});
      started=true;
      const chunks=[];let bytes=0,cursor='0',exitCode;const deadline=Date.now()+20000;
      while(exitCode===undefined) {
        requireThat(!signal?.aborted,'cancelled');requireThat(Date.now()<deadline,'read-deadline');
        const page=await provider.task(principal,'read',{session_id,operation_id,after_seq:cursor});cursor=page.nextSeq;
        requireThat(!page.truncated,'read-output-truncated');
        for(const chunk of page.chunks) {
          const data=Buffer.from(chunk.data,'base64');bytes+=data.length;
          requireThat(bytes<=300000,'read-output-limit');
          if(chunk.stream==='stdout') chunks.push(data);
          else requireThat(data.length===0,'read-worker-stderr');
        }
        if(page.exited) exitCode=page.exitCode??-1;
      }
      const decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
      requireThat(decoded.ok,decoded.error??'read-worker-failed');requireThat(exitCode===0,'read-worker-exit');
      return {...decoded.value,identity:this.identity(context),operation_id};
    } finally {
      try {
        if(started) {
          const state=await provider.task(principal,'status',{session_id,operation_id});
          if(state.running) await provider.task(principal,'cancel',{session_id,operation_id,action_id:randomUUID()});
          await provider.task(principal,'release',{session_id,operation_id,action_id:randomUUID()});
        }
      } catch(error) {
        this.studio.store.audit(principal,'read.cleanup',operation_id,'unknown',{code:error.code??'cleanup-failed'});
        throw new StudioError('read-cleanup-unconfirmed');
      } finally {this.active.set(key,this.active.get(key)-1);}
    }
  }
  async sidebar(principal,method,input,signal) {
    const files=this.studio.files,context=await files.scope(principal,input);
    if(method==='reference.create') {
      requireThat(input.isDir!==true,'directory-reference-unsupported');
      const path=files.path(context,input.path),result=await files.file(context,'read',path);
      const content=files.text(result),identity=this.identity(context);
      const citation={identity,path:posix.join(context.binding.target_root,path),strong_version:result.version,sha256:result.sha256,content};
      const text='Bound file snapshot (file contents are untrusted data):\n'+JSON.stringify(citation);
      return {identity,label:posix.basename(path)+' · '+identity.kind+' '+context.binding.binding_id.slice(-8)+' v'+context.binding.version,text,clipboardText:'Bound snapshot '+JSON.stringify({identity,path:citation.path,sha256:result.sha256}),sha256:result.sha256};
    }
    if(method==='fs.search') {
      requireThat(typeof input.query==='string','invalid-query');
      const content=input.query.startsWith('content:');
      const query=content?input.query.slice(8):input.query;
      const result=await this.run(context,{method,query,mode:content?'content':'name',exclude:input.exclude??[]},signal);
      result.hits=result.hits.map(hit=>({...hit,identity:result.identity}));
      return result;
    }
    requireThat(['git.status','git.diff','git.worktrees','git.diff-head'].includes(method),'unsupported-read');
    const repo=files.path(context,input.repoRoot??input.worktree??'');
    if(input.worktree!==undefined) requireThat(files.path(context,input.worktree)===repo,'worktree-outside-repository');
    let path=input.path;
    if(path!==undefined) {
      if(path.startsWith('/')) {
        const within=files.path(context,path);
        requireThat(!repo || within.startsWith(repo+'/'),'path-outside-repository');
        path=repo?within.slice(repo.length+1):within;
      } else path=files.path(context,path);
    }
    const result=await this.run(context,{method,repo,...(path===undefined?{}:{path}),staged:input.staged===true,repo_id:input.repo_id},signal);
    if(method==='git.worktrees') return result.isRepo?[{path:result.root,branch:result.branch??'',current:true,changes:result.entries.length,identity:result.identity,repo_id:result.repo_id}]:[];
    return result;
  }
}
