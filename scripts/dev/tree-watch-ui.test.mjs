import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import {studioDirectoryWatch} from '../../packages/dsh-agent-studio/tree-watch-sidebar.mjs';
import {projectSidebar} from './sidebar-projection.mjs';

const root='/home/ubuntu/.dsh/profiles/web/node_modules/dsh-better-sidebar/lib/';
const files=['client.js','client-registry.js'];
const sources=Object.fromEntries(files.map(file=>[file,readFileSync(root+file)]));
const identity={session_id:'A',binding_id:'bound-A',version:1,kind:'remote'};
const ack=(dir='/root',extra={})=>({dir,ok:true,complete:true,mode:'poll',intervalMs:2500,limit:1000,identity,...extra});
const notice=(dir='/root',extra={})=>({dir,complete:true,mode:'poll',identity,...extra});
const jsx={jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'};
function harness() {
  const slots=[];let cursor=0, pending=[];
  const same=(a,b)=>a?.length===b?.length&&a.every((value,i)=>Object.is(value,b[i]));
  const React={useRef(initial){let index=cursor++;return slots[index]??= {current:initial};},useState(initial){let index=cursor++;let slot=slots[index]??={value:initial};return [slot.value,value=>{slot.value=typeof value==='function'?value(slot.value):value;}];},useEffect(fn,deps){let index=cursor++,previous=slots[index];if(!previous||!same(previous.deps,deps)){slots[index]={deps,cleanup:previous?.cleanup};pending.push(()=>{previous?.cleanup?.();slots[index].cleanup=fn();});}}};
  const sockets=[],timers=new Map(),stales=[];let next=0;
   class Socket {static OPEN=1;constructor(url){this.url=url;this.readyState=0;this.sent=[];sockets.push(this);}send(message){if(this.failSend?.(JSON.parse(message)))throw Error('send refused');this.sent.push(JSON.parse(message));}close(){this.readyState=3;}open(){this.readyState=1;this.onopen?.();}message(value){this.onmessage?.({data:typeof value==='string'?value:JSON.stringify(value)});}drop(){this.readyState=3;this.onclose?.();}error(){this.onerror?.();}}
  const timersApi={setTimeout(fn,delay){let id=++next;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);}};
  const url=path=>new URL('https://offline.invalid/'+path);
  let props={sessionId:'A',root:'/root',dirs:[],visible:true,onStale:paths=>stales.push(paths)};
  let component=(value)=>studioDirectoryWatch(value,React,url,Socket,timersApi);
   return {sockets,timers,stales,props,React,Socket,timersApi,url,setComponent(fn){component=fn;},renderOnly(){cursor=0;pending=[];return component(props);},commit(){const effects=pending;pending=[];for(const fn of effects)fn();},render(){const value=this.renderOnly();this.commit();return value;},status(){return this.render();},tick(){const tasks=[...timers.values()];timers.clear();for(const task of tasks)task.fn();},unmount(){for(const slot of slots)slot?.cleanup?.();}};
}

test('both installed hash-locked originals project, execute hook seam and render original Notice status; drift fails closed',()=>{
  for(const file of files){
    const bytes=sources[file],projected=projectSidebar('lib/'+file,bytes).toString();
    assert.equal(spawnSync(process.execPath,['--check','--input-type=module'],{input:projected,encoding:'utf8'}).status,0);
    assert.throws(()=>projectSidebar('lib/'+file,Buffer.concat([bytes,Buffer.from(' ')])),/hash mismatch/);
    const start=projected.indexOf('function useDirectoryWatch(options) {'),end=projected.indexOf('\n\t\t//#endregion',start);
    assert.ok(start>0&&end>start);
   const f=harness();
    const projectedHook=vm.runInNewContext(projected.slice(start,end)+';useDirectoryWatch',{react:f.React,hostWebSocketUrl:f.url,WebSocket:f.Socket,window:f.timersApi,URLSearchParams});
    f.setComponent(projectedHook);
    assert.match(f.render(),/connecting/);
    f.sockets[0].open();f.sockets[0].message(ack());assert.match(f.status(),/Remote tree polling active/);
    const seam='root === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {';
     const at=projected.indexOf('"data-studio-tree-watch": true');assert.ok(at>0);
     const snippet=projected.slice(projected.lastIndexOf('(0, react_jsx_runtime.jsx)("span"',at),projected.indexOf('})}),',at)+4);
     const original=bytes.toString(),startNotice=original.indexOf('function Notice(props) {'),endNotice=original.indexOf('\n\t\t}',startNotice)+4;
     const context={react_jsx_runtime:jsx,studioTreeWatch:f.status(),clsx:(...parts)=>parts.filter(Boolean).join(' '),kit_module_css_default:{notice:'notice',noticeInline:'inline',noticeWarn:'warn'}};
     const Notice=vm.runInNewContext(original.slice(startNotice,endNotice)+';Notice',context);
     const node=vm.runInNewContext(snippet,{...context,Notice});
     assert.equal(node.type,'span');assert.equal(node.props['data-studio-tree-watch'],true);
     const dom=node.props.children.type(node.props.children.props);assert.equal(dom.type,'div');assert.equal(dom.props.role,'status');assert.match(dom.props.children,/cached rows may be stale/);
     assert.ok(projected.includes('loadError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Notice, {'));
     assert.match(projected.slice(projected.indexOf('const studioTreeWatch = useDirectoryWatch({'),projected.indexOf('onStale: retryDirs')),/visible: visible !== false && hidden !== true/);
    assert.equal(bytes.toString().includes('data-studio-tree-watch'),false);assert.ok(bytes.toString().includes(seam));
    f.unmount();
  }
});
test('subscription is not reload completion; errors, no-dir failure and incomplete frames expose unknown freshness',()=>{
  const f=harness();assert.match(f.render(),/connecting/);const ws=f.sockets[0];ws.open();assert.match(f.status(),/subscribing/);
   ws.message(ack());assert.match(f.status(),/active \(subscription confirmed; listing freshness unknown\)/);assert.deepEqual(f.stales,[['/root']]);
   ws.message(notice());assert.deepEqual(f.stales,[['/root'],['/root']]);
  ws.message({ok:false,complete:false,code:'watch-directory-incomplete',mode:'poll',identity});assert.match(f.status(),/unavailable \(freshness unknown\).*watch-directory-incomplete/);assert.equal(f.timers.size,1);
  f.tick();const next=f.sockets[1];next.open();next.message(ack('/root',{complete:false}));assert.match(f.status(),/unavailable.*incomplete/);f.unmount();assert.equal(f.timers.size,0);
});
test('malformed, foreign, stale version and stale owned sockets cannot trigger reload or erase status',()=>{
  const f=harness();f.render();const ws=f.sockets[0];ws.open();ws.message(ack());
   ws.message(notice('/foreign'));ws.message(notice('/root',{identity:{...identity,session_id:'B'}}));ws.message(notice('/root',{identity:{...identity,version:2}}));assert.deepEqual(f.stales,[['/root']]);
  ws.message('{broken');assert.match(f.status(),/invalid watch frame/);f.tick();const next=f.sockets[1];next.open();next.message(ack());const current=f.status();
  ws.message({ok:false,code:'old',identity});ws.drop();assert.equal(f.status(),current);assert.equal(f.timers.size,0);
   next.message(notice());assert.deepEqual(f.stales,[['/root'],['/root'],['/root']]);f.unmount();
});
test('close/error backoff deduplicates retries; expanded changes, parked navigation and unmount own callbacks',()=>{
  const f=harness();f.render();let ws=f.sockets[0];ws.open();ws.message(ack());
  f.props.dirs=['/root/sub','/root/sub'];assert.match(f.render(),/watch set changed/);assert.deepEqual(ws.sent.map(value=>value.path),['/root','/root/sub']);
    ws.message(ack('/root/sub'));ws.message(notice('/root/sub'));assert.deepEqual(f.stales,[['/root'],['/root/sub'],['/root/sub']]);
    f.props.dirs=[];f.render();assert.equal(ws.sent.at(-1).op,'unwatch');ws.message(notice('/root/sub'));assert.equal(f.stales.length,3);
  ws.drop();ws.drop();assert.match(f.status(),/disconnected/);assert.equal(f.timers.size,1);f.tick();ws=f.sockets[1];ws.open();ws.message(ack());ws.error();ws.drop();assert.match(f.status(),/unavailable/);assert.equal(f.timers.size,1);
  f.props.visible=false;assert.match(f.render(),/parked \(hidden; not updating\)/);assert.equal(f.timers.size,0);const count=f.sockets.length;f.tick();assert.equal(f.sockets.length,count);
  f.props.visible=true;f.props.sessionId='B';f.props.root='/other';f.render();const owned=f.sockets.at(-1);owned.open();owned.message(ack('/other',{identity:{...identity,session_id:'B',version:2}}));assert.match(f.status(),/active/);
   ws.message(notice());const before=f.stales.length;
   f.unmount();owned.message(notice('/other',{identity:{...identity,session_id:'B',version:2}}));assert.equal(f.stales.length,before);assert.equal(f.timers.size,0);
});
test('ACK-only reconnect forces current root and expanded set once per owned socket',()=>{
  const f=harness();f.props.dirs=['/root/sub'];f.render();let ws=f.sockets[0];ws.open();ws.message(ack());ws.message(ack('/root/sub'));
  assert.deepEqual(f.stales,[['/root','/root/sub']]);ws.message(ack('/root/sub'));assert.equal(f.stales.length,1);
  ws.drop();f.tick();ws=f.sockets[1];ws.open();assert.deepEqual(ws.sent.map(x=>x.path),['/root','/root/sub']);ws.message(ack('/root/sub'));ws.message(ack());
  assert.deepEqual(f.stales,[['/root','/root/sub'],['/root','/root/sub']]);f.unmount();
});
test('exact backend ACK shape is valid; incomplete change is refused',()=>{
  const f=harness();f.render();const ws=f.sockets[0];ws.open();ws.message(ack('/root',{complete:undefined,limit:undefined}));
  assert.match(f.status(),/active/);assert.equal(f.timers.size,0);assert.deepEqual(ws.sent.map(x=>x.op),['watch']);
  ws.message(notice('/root',{complete:false}));assert.match(f.status(),/unavailable.*incomplete/);f.unmount();
  for(const extra of [{complete:false},{truncated:true},{limit:999}]){
    const invalid=harness();invalid.render();const socket=invalid.sockets[0];socket.open();socket.message(ack('/root',extra));
    assert.match(invalid.status(),/unavailable/);assert.deepEqual(invalid.stales,[]);assert.equal(invalid.timers.size,1);invalid.unmount();
  }
});
test('collapse confirmed and pending subs settles current snapshot without another ACK',()=>{
  for(const confirmSub of [true,false]){
    const f=harness();f.props.dirs=['/root/sub'];f.render();const ws=f.sockets[0];ws.open();ws.message(ack());if(confirmSub)ws.message(ack('/root/sub'));
    const before=f.stales.length;f.props.dirs=[];f.render();assert.match(f.status(),/active \(subscription confirmed/);
    assert.deepEqual(f.stales.slice(before),confirmSub?[]:[['/root']]);
    ws.message(ack('/root/sub'));ws.message(ack());f.status();assert.equal(f.stales.length,before+(confirmSub?0:1));
    assert.deepEqual(ws.sent.map(x=>x.op),['watch','watch','unwatch']);f.unmount();
  }
});
test('actionable cause survives reconnect and partial send failure cannot overwrite unavailable',()=>{
  const f=harness();f.render();let ws=f.sockets[0];ws.open();ws.message({ok:false,code:'watch-directory-limit',mode:'poll',identity});
  assert.match(f.status(),/watch-directory-limit/);f.props.dirs=['/root/sub'];assert.match(f.render(),/watch-directory-limit/);
  f.tick();ws=f.sockets[1];assert.match(f.status(),/connecting.*watch-directory-limit/);ws.open();assert.match(f.status(),/subscribing.*watch-directory-limit/);
  ws.message(ack());assert.match(f.status(),/subscribing.*watch-directory-limit/);
  ws.message(ack('/root/sub'));assert.doesNotMatch(f.status(),/watch-directory-limit/);f.unmount();
  const g=harness();g.props.dirs=['/root/sub'];g.render();ws=g.sockets[0];ws.failSend=x=>x.path==='/root/sub';ws.open();assert.match(g.status(),/unavailable.*watch send failed/);
  assert.deepEqual(ws.sent.map(x=>x.path),['/root']);assert.equal(g.timers.size,1);g.unmount();
});
test('hidden projected invocation parks socket and drops late events; show re-arms ACK reload',()=>{
  const projected=projectSidebar('lib/client.js',sources['client.js']).toString();
  const match=projected.match(/const studioTreeWatch = useDirectoryWatch\(\{([\s\S]*?)\}\);/);assert.ok(match);
  const invoke=vm.runInNewContext('(args,hook)=>{const {sessionId,cwd,expanded,visible,hidden,retryDirs}=args;return hook({'+match[1]+'});}',{});
  const f=harness();const args={sessionId:'A',cwd:'/root',expanded:[],visible:true,hidden:false,retryDirs:paths=>f.stales.push(paths)};
  f.setComponent(()=>invoke(args,options=>studioDirectoryWatch(options,f.React,f.url,f.Socket,f.timersApi)));
  f.render();let ws=f.sockets[0];ws.open();ws.message(ack());assert.deepEqual(f.stales,[['/root']]);ws.drop();
  args.hidden=true;assert.match(f.render(),/parked/);assert.equal(f.timers.size,0);ws.message(notice());assert.equal(f.stales.length,1);
  args.hidden=false;f.render();ws=f.sockets.at(-1);ws.open();ws.message(ack());assert.deepEqual(f.stales,[['/root'],['/root']]);f.unmount();
});
test('ACK-only outage re-list uses actual projected native retryDirs/loadLevels; failed read keeps rows and loadError',async()=>{
  const projected=projectSidebar('lib/client.js',sources['client.js']).toString();
  const start=projected.indexOf('const loadLevels = (0, react.useCallback)(');
  const end=projected.indexOf('\n\t\t\t/**',start);
  const retryStart=projected.indexOf('const retryDirs = (0, react.useCallback)(',end);
  const retryEnd=projected.indexOf('\n\t\t\t/**',retryStart);
  assert.ok(start>0&&end>start&&retryStart>end&&retryEnd>retryStart);
  const dataRef={current:{'/root':{entries:['old-root']},'/root/sub':{entries:['old-sub']}}};
  let loadError=null,fail=false;
  const listing={'/root':['new-root'],'/root/sub':['new-sub']},calls=[];
  const api={fsTrees:async(scope,paths)=>{calls.push([...paths]);if(fail)throw Error('offline listing');return {levels:paths.map(path=>({path,entries:[...listing[path]],truncated:false}))};}};
  const context={react:{useCallback:fn=>fn},api,sessionId:'A',cwd:'/root',excludeKey:'',visibleRef:{current:true},dataRef,generationRef:{current:0},pendingRef:{current:new Map()},
    storeLevel:(path,level)=>{dataRef.current={...dataRef.current,[path]:level};},releasePlaceholders:()=>[],setLoadError:value=>{loadError=value;},Error,Promise,Set};
  const retryDirs=vm.runInNewContext(projected.slice(start,end)+'\n'+projected.slice(retryStart,retryEnd)+'\nretryDirs',context);
  const f=harness();f.props.dirs=['/root/sub'];f.props.onStale=retryDirs;
  f.render();let ws=f.sockets[0];ws.open();ws.message(ack());ws.message(ack('/root/sub'));
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,[['/root','/root/sub']]);assert.deepEqual(dataRef.current['/root'].entries,['new-root']);
  ws.drop();listing['/root']=['outage-root'];listing['/root/sub']=['outage-sub'];f.tick();ws=f.sockets[1];ws.open();ws.message(ack());
  f.props.dirs=[];f.render();assert.deepEqual(ws.sent.map(x=>x.op),['watch','watch','unwatch']);
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls.at(-1),['/root']);assert.deepEqual(dataRef.current['/root'].entries,['outage-root']);assert.equal(calls.length,2);
  ws.message(ack('/root/sub'));ws.message(ack());await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,2);
  ws.drop();fail=true;f.tick();ws=f.sockets[2];ws.open();ws.message(ack());
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(dataRef.current['/root'].entries,['outage-root']);assert.deepEqual(dataRef.current['/root/sub'].entries,['new-sub']);assert.equal(loadError,'offline listing');
  assert.match(f.status(),/listing freshness unknown/);f.unmount();
});
test('re-expanded cached directory re-lists on its new ACK without a change notice or redundant root read',async()=>{
  const projected=projectSidebar('lib/client.js',sources['client.js']).toString();
  const start=projected.indexOf('const loadLevels = (0, react.useCallback)(');
  const end=projected.indexOf('\n\t\t\t/**',start);
  const retryStart=projected.indexOf('const retryDirs = (0, react.useCallback)(',end);
  const retryEnd=projected.indexOf('\n\t\t\t/**',retryStart);
  assert.ok(start>0&&end>start&&retryStart>end&&retryEnd>retryStart);
  const dataRef={current:{'/root':{entries:['old-root']},'/root/sub':{entries:['old-sub']}}};
  const listing={'/root':['current-root'],'/root/sub':['initial-sub']},calls=[];
  const api={fsTrees:async(_scope,paths)=>{calls.push([...paths]);return {levels:paths.map(path=>({path,entries:[...listing[path]],truncated:false}))};}};
  const context={react:{useCallback:fn=>fn},api,sessionId:'A',cwd:'/root',excludeKey:'',visibleRef:{current:true},dataRef,generationRef:{current:0},pendingRef:{current:new Map()},
    storeLevel:(path,level)=>{dataRef.current={...dataRef.current,[path]:level};},releasePlaceholders:()=>[],setLoadError:()=>{},Error,Promise,Set};
  const {loadLevels,retryDirs}=vm.runInNewContext(projected.slice(start,end)+'\n'+projected.slice(retryStart,retryEnd)+'\n({loadLevels,retryDirs})',context);
  const f=harness();f.props.dirs=['/root/sub'];f.props.onStale=retryDirs;
  f.render();const ws=f.sockets[0];ws.open();ws.message(ack());ws.message(ack('/root/sub'));
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,[['/root','/root/sub']]);assert.deepEqual(dataRef.current['/root/sub'].entries,['initial-sub']);
  f.props.dirs=[];f.render();assert.deepEqual(ws.sent.at(-1),{op:'unwatch',path:'/root/sub'});
  listing['/root/sub']=['changed-while-unwatched'];
   f.props.dirs=['/root/sub'];f.renderOnly();
   ws.message(ack());
   await new Promise(resolve=>setImmediate(resolve));
   assert.equal(calls.length,1,'duplicate root ACK before passive reconcile cannot read unconfirmed sub');
   assert.deepEqual(dataRef.current['/root/sub'].entries,['initial-sub']);
   assert.deepEqual(ws.sent.at(-1),{op:'unwatch',path:'/root/sub'});
   f.commit();assert.deepEqual(ws.sent.at(-1),{op:'watch',path:'/root/sub'});
   loadLevels(['/root','/root/sub'],{force:false});
   await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,1,'actual normal expansion skips healthy cached levels');
   assert.deepEqual(dataRef.current['/root/sub'].entries,['initial-sub']);
   listing['/root/sub']=['changed-between-early-read-and-ACK'];
   ws.message(ack('/root/sub'));
   await new Promise(resolve=>setImmediate(resolve));
   assert.deepEqual(calls,[['/root','/root/sub'],['/root/sub']]);
   assert.deepEqual(dataRef.current['/root/sub'].entries,['changed-between-early-read-and-ACK']);
  ws.message(ack('/root/sub'));ws.message(ack());
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,2);f.unmount();
});
