import {createHash} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {requireThat} from '../store.mjs';

// Helper 0.13.1 has no native watch capability. Share one bounded, non-recursive
// directory poll per binding/path across clients; never inspect an anchor.
export class BoundWatch {
  constructor(studio) {
    this.studio=studio;this.groups=new Map();this.sockets=new Set();this.pending=new Set();this.closed=false;
    this.wss=new WebSocketServer({noServer:true,maxPayload:8192});
  }
  async upgrade(principal,req,socket,head) {
    const sessionId=new URL(req.url,'http://preview.invalid').searchParams.get('sessionId');
    const context=await this.studio.files.scope(principal,{sessionId});
    await this.studio.provider.authorized(principal,{session_id:sessionId},'fs.read');
    requireThat(!this.closed && this.sockets.size<16,'watch-client-limit');
    this.wss.handleUpgrade(req,socket,head,ws=>this.attach(context,ws));
  }
  send(ws,value) {if(ws.readyState===1) ws.send(JSON.stringify(value));}
  attach(context,ws) {
    this.sockets.add(ws);const owned=new Map();let queue=Promise.resolve();
    const identity=this.studio.reads.identity(context);
    const remove=path=>{
      const group=owned.get(path);if(!group) return;
      owned.delete(path);group.clients.delete(ws);
      if(!group.clients.size) {group.closed=true;clearTimeout(group.timer);this.groups.delete(group.key);}
    };
    ws.on('message',bytes=>{
      queue=queue.then(async()=>{
        requireThat(ws.readyState===1 && !this.closed,'watch-closed');
        const input=JSON.parse(bytes.toString());
        requireThat(['watch','unwatch'].includes(input.op) && typeof input.path==='string','invalid-watch');
        const path=this.studio.files.path(context,input.path);
        if(input.op==='unwatch') {remove(path);return;}
        if(owned.has(path)) {this.send(ws,{dir:input.path,ok:true,mode:'poll',intervalMs:2500,identity});return;}
        requireThat(owned.size<16,'watch-directory-limit');
        const key=context.binding.binding_id+'@'+context.binding.version+'\0'+path;
        let group=this.groups.get(key);
        if(!group) {
          requireThat(this.groups.size<32,'watch-global-limit');
          group={key,path,context,clients:new Map(),closed:false};this.groups.set(key,group);
        }
        owned.set(path,group);group.clients.set(ws,{dir:input.path,identity});
        if(!group.work && !group.timer) this.schedule(group,0);
      }).catch(error=>{
        this.send(ws,{ok:false,code:error.code??'invalid-watch',mode:'poll',identity});
        ws.close(1008,'Watch refused');
      });
    });
    ws.on('close',()=>{for(const path of owned.keys()) remove(path);this.sockets.delete(ws);});
    ws.on('error',error=>this.studio.store.audit(context.principal,'watch.socket',context.session.session_id,'failed',{code:error.code??'socket-error'}));
  }
  schedule(group,ms) {
    if(group.closed || this.closed) return;
    group.timer=setTimeout(()=>{
      group.timer=undefined;
      const work=this.poll(group).finally(()=>{this.pending.delete(work);group.work=undefined;this.schedule(group,2500);});
      group.work=work;this.pending.add(work);
    },ms);
    group.timer.unref();
  }
  async poll(group) {
    try {
      const clients=[...group.clients.entries()];
      if(!clients.length) return;
      for(const [,client] of clients) await this.studio.resolve(group.context.principal,{session_id:client.identity.session_id,binding_id:client.identity.binding_id,version:client.identity.version});
      const result=await this.studio.provider.file(group.context.principal,'list',{session_id:clients[0][1].identity.session_id,path:group.path});
      requireThat(!result.truncated,'watch-directory-incomplete');
      const fingerprint=createHash('sha256').update(JSON.stringify(result.entries.sort((a,b)=>a.name.localeCompare(b.name)))).digest('hex');
      if(group.closed || this.closed) return;
      for(const [ws,client] of clients) {
        if(!client.confirmed) {
          this.send(ws,{dir:client.dir,ok:true,mode:'poll',intervalMs:2500,complete:true,limit:1000,identity:client.identity});client.confirmed=true;
        } else if(group.fingerprint!==fingerprint) this.send(ws,{dir:client.dir,mode:'poll',complete:true,identity:client.identity});
      }
      group.fingerprint=fingerprint;
    } catch(error) {
      if(group.closed || this.closed) return;
      this.studio.store.audit(group.context.principal,'watch.poll',group.context.session.session_id,'failed',{code:error.code??'watch-error'});
      for(const [ws,client] of group.clients) {
        this.send(ws,{dir:client.dir,ok:false,code:error.code??'watch-error',complete:false,mode:'poll',identity:client.identity});
        ws.close(1011,'Bound watch unavailable');
      }
      group.closed=true;this.groups.delete(group.key);
    }
  }
  status() {return {mode:'poll',intervalMs:2500,directories:this.groups.size,clients:this.sockets.size,limit:1000,maxDirectories:32};}
  async dispose() {
    this.closed=true;
    for(const group of this.groups.values()) {group.closed=true;clearTimeout(group.timer);}
    for(const ws of this.sockets) ws.terminate();
    this.groups.clear();this.wss.close();await Promise.all([...this.pending]);
  }
}
