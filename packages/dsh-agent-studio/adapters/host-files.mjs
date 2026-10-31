import {randomUUID} from 'node:crypto';
import {posix} from 'node:path';
import {requireThat} from '../store.mjs';
import {relativePath} from './bound-provider.mjs';

export class HostFiles {
  constructor(studio) {this.studio=studio;}
  async scope(principal,input) {
    const context=await this.studio.resolve(principal,{session_id:input.sessionId,...(input.binding_id===undefined?{}:{binding_id:input.binding_id}),...(input.version===undefined?{}:{version:input.version})});
    requireThat(context.environment.provider==='coder-helper' || context.environment.kind==='local' && context.environment.provider==='local-managed','provider-unavailable');
    // cwd is only an assertion; a selected repo is a path INSIDE this binding.
    requireThat(input.cwd===undefined || [context.binding.target_root,context.binding.anchor_path].includes(input.cwd),'cwd-outside-binding');
    if(input.repoRoot!==undefined) this.path(context,input.repoRoot);
    return {...context,principal};
  }
  path(context,value='') {
    requireThat(typeof value==='string','invalid-path');
    // The native header initially advertises its empty anchor. Only AFTER
    // resolving this session may that exact owned alias map to the remote root.
    if(value==='.') value='';
    for(const root of [context.binding.target_root,context.binding.anchor_path]) {
      if(value===root) {value='';break;}
      if(value.startsWith(root+'/')) {value=value.slice(root.length+1);break;}
    }
    return relativePath(value);
  }
  async file(context,method,path,extra={}) {
    return this.studio.provider.file(context.principal,method,{session_id:context.session.session_id,path,...extra});
  }
  baseline(context,path,result) {
    const mtimeMs=result.metadata.mtimeNs/1e6;
    requireThat(Number.isFinite(mtimeMs) && typeof result.version==='string','missing-file-version');
    // Persist every observed timestamp/version association. A timestamp collision
    // is permanently ambiguous, even across restart: never overwrite its baseline.
    this.studio.store.db.prepare(`INSERT INTO file_read_versions VALUES(?,?,?,?)
      ON CONFLICT(session_id,path,mtime_ms) DO UPDATE SET strong_version=
      CASE WHEN file_read_versions.strong_version=excluded.strong_version THEN excluded.strong_version ELSE NULL END`)
      .run(context.session.session_id,path,String(mtimeMs),result.version);
    return mtimeMs;
  }
  text(result) {
    const data=Buffer.from(result.data,'base64');
    requireThat(!data.includes(0),'not-text');
    try {return new TextDecoder('utf-8',{fatal:true}).decode(data);}
    catch(error) {requireThat(false,'not-text');}
  }
  async listing(context,value) {
    const path=this.path(context,value), result=await this.file(context,'list',path);
    return {path:posix.join(context.binding.target_root,path),truncated:result.truncated===true,entries:result.entries.map(entry=>({
      name:entry.name,path:posix.join(context.binding.target_root,path,entry.name),isDir:entry.metadata.type==='directory',
      hidden:entry.name.startsWith('.'),isSymlink:entry.metadata.type==='symlink',broken:false}))};
  }
  async sidebar(principal,method,input,content) {
    const context=await this.scope(principal,input);
    if(method==='fs.tree') return this.listing(context,input.path??'');
    if(method==='fs.trees') {
      requireThat(Array.isArray(input.paths) && input.paths.length>0 && input.paths.length<=64,'invalid-paths');
      const levels=[];
      for(const path of input.paths) levels.push(await this.listing(context,path));
      return {levels};
    }
    if(input.path && !input.path.startsWith('/')) relativePath(input.path,false);
    const requested=input.repoRoot && input.path && !input.path.startsWith('/')?posix.join(input.repoRoot,input.path):input.path;
    const path=this.path(context,requested);requireThat(path,'invalid-path');
    if(method==='fs.read') {
      const result=await this.file(context,'read',path), text=this.text(result);
      return {kind:'text',content:text,size:result.metadata.size,mtimeMs:this.baseline(context,path,result)};
    }
    requireThat(method==='fs.write','unknown-method');
    requireThat(typeof content==='string' && Number.isFinite(input.expectedMtimeMs),'version-required');
    const row=this.studio.store.db.prepare('SELECT strong_version FROM file_read_versions WHERE session_id=? AND path=? AND mtime_ms=?')
      .get(context.session.session_id,path,String(input.expectedMtimeMs));
    requireThat(row?.strong_version,'version-baseline-unavailable');
    const saved=await this.file(context,'write',path,{operation_id:randomUUID(),encoding:'utf8',data:content,expected_version:row.strong_version});
    return {ok:true,mtimeMs:this.baseline(context,path,saved)};
  }
  async workspace(principal,method,input) {
    const context=await this.scope(principal,{sessionId:input.workspaceFileScopeId});
    const path=this.path(context,input.path);
    if(method==='list') {
      const result=await this.file(context,'list',path);
      return {path:path||'.',entries:result.entries.map(entry=>({name:entry.name,type:entry.metadata.type,size:entry.metadata.size})),truncated:result.truncated===true};
    }
    requireThat(input.options?.baseFile===undefined,'base-file-unsupported');
    const result=await this.file(context,'read',path);
    const metadata={absolutePath:posix.join(context.binding.target_root,path),version:result.version,bytes:result.metadata.size};
    if(method==='stat') return metadata;
    if(method==='readBytes') {
      const bytes=Buffer.from(result.data,'base64'),offset=input.options?.range?.offset??0,length=input.options?.range?.length??bytes.length;
      requireThat(Number.isSafeInteger(offset) && offset>=0 && Number.isSafeInteger(length) && length>0 && length<=196608,'invalid-range');
      return {...metadata,offset,data:new Uint8Array(bytes.subarray(offset,offset+length)),eof:offset+length>=bytes.length};
    }
    requireThat(method==='read','unknown-method');
    const text=this.text(result),lines=text.split('\n');
    if(text.endsWith('\n') || text==='') lines.pop();
    const offset=input.range?.offset??1,limit=input.range?.limit??200;
    requireThat(Number.isSafeInteger(offset) && offset>=1 && Number.isSafeInteger(limit) && limit>=1 && limit<=2000,'invalid-range');
    const page=lines.slice(offset-1,offset-1+limit);
    return {...metadata,offset,text:page.join('\n'),lines:page.length,eof:offset-1+limit>=lines.length};
  }
}
