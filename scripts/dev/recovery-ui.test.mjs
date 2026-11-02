import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,mkdtemp,mkdir,writeFile,symlink,realpath,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import {RecoveryPanel,terminalRecoveryIdentity,terminalRecoveryWritable} from '../../packages/dsh-agent-studio/recovery-sidebar.mjs';
import {projectSidebar,projectNativeTerminal} from './sidebar-projection.mjs';
import {verifySdkVersion,verifyNativeTerminalPatch,writeNativeTerminalProjection} from './preview.mjs';

// Offline only: no prepare/start, Playwright, real RPC, service or plugin activation.
const SDK='/home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh';
const SIDEBAR='/home/ubuntu/.dsh/profiles/web/node_modules/dsh-better-sidebar';
const lock=JSON.parse(await readFile(new URL('../../profiles/agent-studio-preview/sources.lock.json',import.meta.url)));
const nativeRoot=join(SDK,'node_modules',lock.native_terminal.package);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const operationId=(session,terminal)=>'terminal-'+sha(session+'\0'+terminal);
const bottom=(await readFile(join(SIDEBAR,'lib/client-terminal.js')));
const native=(await readFile(join(nativeRoot,'lib/client.terminal.js')));
const projected={bottom:projectSidebar('lib/client-terminal.js',bottom).toString(),native:projectNativeTerminal('lib/client.terminal.js',native).toString()};
const plain=value=>JSON.parse(JSON.stringify(value));
const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const h=(type,props,...children)=>({type,props:{...props,...(children.length?{children:children.length===1?children[0]:children}:{})}});
const jsx={jsx:(type,props,key)=>({type,props,key}),jsxs:(type,props,key)=>({type,props,key}),Fragment:'Fragment'};
function nodes(tree,predicate) {
 if(Array.isArray(tree))return tree.flatMap(value=>nodes(value,predicate));
 if(!tree||typeof tree!=='object')return [];
 return [...(predicate(tree)?[tree]:[]),...nodes(tree.props?.children,predicate)];
}
function hooks() {
 const slots=[];let cursor=0,effects=[];
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((value,i)=>Object.is(value,b[i]));
 const memo=(value,deps)=>{const at=cursor++;if(!slots[at]||!same(slots[at].deps,deps))slots[at]={value:value(),deps};return slots[at].value;};
 const effect=(body,deps)=>{const at=cursor++,old=slots[at];if(!old||!same(old.deps,deps)){slots[at]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();slots[at].cleanup=body();});}};
 const React={createElement:h,Fragment:'Fragment',useState(initial){const at=cursor++;if(!slots[at])slots[at]={value:typeof initial==='function'?initial():initial};return [slots[at].value,value=>{slots[at].value=typeof value==='function'?value(slots[at].value):value;}];},useRef(initial){const at=cursor++;if(!slots[at])slots[at]={current:initial};return slots[at];},useMemo:memo,useCallback:(value,deps)=>memo(()=>value,deps),useEffect:effect,useLayoutEffect:effect,useSyncExternalStore:(_subscribe,snapshot)=>snapshot()};
 return {React,render(Component,props,commit=true){cursor=0;effects=[];const tree=Component(props);for(const node of nodes(tree,value=>typeof value.type==='string'&&value.props?.ref))node.props.ref.current={clientWidth:320,clientHeight:160};if(commit)this.commit();return tree;},commit(){const batch=effects;effects=[];for(const run of batch)run();},unmount(){for(const slot of slots)slot?.cleanup?.();}};
}
function evaluate(source,context={}) {return vm.runInNewContext(source,{console,TextEncoder,Uint8Array,URL,Date,AbortController,AbortSignal:{timeout:()=>undefined},...context});}
function row(session='session-A',terminal='host-terminal-A',state='live') {
 return {operation:{session_id:session,operation_id:operationId(session,terminal),kind:'pty.open',state:'running',remote_pid:42},state:{state,output_cursor:'7'},snapshot:{complete:1,identity_json:'{"pid":42}'},eligible:true};
}
function panelFixture(options={}) {
 const host=hooks(),calls=[],notices=[],timers=new Map();let nextTimer=0;
 let response=options.response??(()=>row());
 const context={crypto:{randomUUID,subtle:{digest:async(_algorithm,bytes)=>createHash('sha256').update(bytes).digest()}},setTimeout:callback=>{timers.set(++nextTimer,callback);return nextTimer;},clearTimeout:id=>timers.delete(id),fetch:async(_url,init)=>{const call=JSON.parse(init.body);calls.push(call);const value=await response(call);if(value instanceof Error)throw value;return {ok:true,json:async()=>({result:{ok:true,value}})};}};
 const Component=evaluate('('+RecoveryPanel.toString()+')',context);
 const props={scope:{sessionId:'session-A'},terminalId:'host-terminal-A',visible:true,React:host.React,onState:value=>notices.push(value),routeUrl:path=>'https://offline.invalid/'+path,...options.props};
 return {calls,notices,timers,props,host,setResponse(value){response=value;},render(commit=true){return host.render(Component,props,commit);},async tick(){const callbacks=[...timers.values()];timers.clear();for(const callback of callbacks)callback();await settle();},async ready(){this.render();await settle();return this.render();},last(){return notices.at(-1);}};
}
async function temporary(run) {
 const directory=await mkdtemp(join(tmpdir(),'agent-studio-recovery-ui-'));
 try{return await run(directory);}finally {assert.equal(resolve(directory),directory);assert.ok(directory.startsWith(join(tmpdir(),'agent-studio-recovery-ui-')));await rm(directory,{recursive:true,force:true});}
}

test('upgradeable root/native baselines match installation; unreviewed drift and wrong package are refused',async()=>{
 assert.equal(lock.sdk.package,'@deepseek-ai/dsh');assert.equal(lock.native_terminal.package,'@deepseek-ai/dsh-client-ui-sidebar-terminal');
 const installed=JSON.parse(await readFile(join(SDK,'package.json')));
 verifySdkVersion(installed,lock);
 assert.throws(()=>verifySdkVersion({...installed,version:installed.version+'-unreviewed'},lock),/Unverified dsh baseline/);
 assert.throws(()=>verifySdkVersion({...installed,name:'not-dsh'},lock),/Unexpected dsh package/);
 const manifest=JSON.parse(await readFile(join(nativeRoot,'package.json')));assert.equal(manifest.name,lock.native_terminal.package);assert.equal(manifest.version,lock.native_terminal.version);
 for(const [file,hash] of Object.entries(lock.native_terminal.files)) {const source=await readFile(join(nativeRoot,file));assert.equal(sha(source),hash);const output=projectNativeTerminal(file,source);if(file!=='lib/client.terminal.js')assert.deepEqual(output,source);assert.throws(()=>projectNativeTerminal(file,Buffer.concat([source,Buffer.from(' ')])),/hash mismatch/);}
 for(const file of ['lib/client-terminal.js','lib/client.terminal.js']) {const output=file.includes('.terminal.')?projected.native:projected.bottom;const result=spawnSync(process.execPath,['--check','--input-type=module'],{input:output,encoding:'utf8'});assert.equal(result.status,0,result.stderr);}
 assert.throws(()=>projectSidebar('unknown',bottom),/hash mismatch/);assert.throws(()=>projectNativeTerminal('unknown',native),/hash mismatch/);
 const projector=await readFile(new URL('./sidebar-projection.mjs',import.meta.url),'utf8');
 const once=evaluate('('+projector.slice(projector.indexOf('function once('),projector.indexOf('function section('))+')');
 assert.throws(()=>once('missing','seam','new'),/seam mismatch/);assert.throws(()=>once('seam seam','seam','new'),/seam mismatch/);
});

test('actual stock ID is disabled exactly once and only one private replacement is selected',async()=>{
 const stock=await readFile(join(SDK,'node_modules',lock.native_terminal.stock_patch.file));
 const patch=await readFile(new URL('../../profiles/agent-studio-preview/cordis.patch.yml',import.meta.url));
 verifyNativeTerminalPatch(stock,patch,lock.native_terminal);
 assert.throws(()=>verifyNativeTerminalPatch(Buffer.concat([stock,Buffer.from(' ')]),patch,lock.native_terminal),/hash mismatch/);
 assert.throws(()=>verifyNativeTerminalPatch(stock,Buffer.from(patch.toString().replace('- id: ui-sidebar-terminal\n  disabled: true','- id: wrong-terminal-id\n  disabled: true')),lock.native_terminal),/replacement mismatch/);
 assert.throws(()=>verifyNativeTerminalPatch(stock,Buffer.concat([patch,Buffer.from("\n- insert:\n    - id: duplicate-native\n      name: './native-terminal/lib/index.js'\n")]),lock.native_terminal),/replacement mismatch/);
});

test('owned private writer and actual installed loader resolve host → local manifest → client → projected lazy chunk',async()=>{
 const assets={};for(const file of Object.keys(lock.native_terminal.files))assets[file]=projectNativeTerminal(file,await readFile(join(nativeRoot,file)));
 await temporary(async directory=>{
  const profile=join(directory,'profile'),namespace=join(directory,'installed-namespace');await mkdir(profile);await mkdir(namespace);await writeFile(join(namespace,'sentinel'),'unchanged');await mkdir(join(profile,'node_modules'));await symlink(namespace,join(profile,'node_modules/@deepseek-ai'));
  const hashes=await writeNativeTerminalProjection(profile,assets),target=join(profile,'native-terminal');
  assert.equal(await realpath(join(profile,'node_modules/@deepseek-ai')),namespace);assert.equal(await readFile(join(namespace,'sentinel'),'utf8'),'unchanged');
  for(const [file,bytes] of Object.entries(assets)){assert.equal(hashes[file],sha(bytes));assert.deepEqual(await readFile(join(target,file)),bytes);}
  // Import only empty host exports, never call apply or construct/activate a service.
  assert.equal(typeof (await import(pathToFileURL(join(target,'lib/index.js')))).apply,'function');
  const {ClientModuleRegistry}=await import(pathToFileURL(join(SDK,'node_modules/@deepseek-ai/dsh-client-modules/lib/index.js')));
  const registry=Object.create(ClientModuleRegistry.prototype);Object.defineProperty(registry,'ctx',{value:{loader:{internal:undefined}}});registry.pkgMeta=new Map();
  const base=pathToFileURL(join(profile,'cordis.patch.yml')).href;
  const meta=await registry.resolveMeta('./native-terminal/lib/index.js',base);
  assert.equal(meta.meta.clientPath,join(target,'lib/client.js'));assert.equal(meta.packageName,lock.native_terminal.package);
  const registrations=[],lazy=[];let chunkPath;
  const React={lazy:load=>{lazy.push(load);return 'LazyNativeBody';},createElement:h};
  const requireClient=name=>name==='react'?React:name==='react/jsx-runtime'?jsx:{};
  registry.table=new Map([[meta.packageName,{entry:{id:meta.packageName,rev:'offline-revision'},meta:meta.meta}]]);registry.responses=new Map();registry.previousBatchResponses=new Map();
  requireClient.async=async relative=>{chunkPath=resolve(join(target,'lib'),relative);const response=await registry.bundleResource('GET','/plugins/'+meta.packageName+'/'+relative.replace(/^\.\//,'')+'?rev=offline-revision');assert.equal(response.status,200);const registration=[];evaluate(response.body.toString(),{document:{querySelector:()=>({})},queueMicrotask,navigator:{userAgent:'offline-test Linux',platform:'Linux',language:'en',maxTouchPoints:0},window:{__ModuleLoader__:{load:value=>registration.push(value)}}});assert.equal(registration.length,1);assert.equal(registration[0].chunk,'client.terminal.js');return registration[0].factory(requireClient);};
  evaluate(await readFile(meta.meta.clientPath,'utf8'),{window:{__ModuleLoader__:{load:value=>registrations.push(value)}}});
  assert.equal(registrations.length,1);registrations[0].factory(requireClient);assert.equal(lazy.length,1);
  const loaded=await lazy[0]();assert.equal(typeof loaded.default,'function');assert.equal(loaded.default.name,'TerminalBody');assert.equal(chunkPath,join(target,'lib/client.terminal.js'));assert.equal(sha(await readFile(chunkPath)),hashes['lib/client.terminal.js']);
  // Subsequent writes to the same owned projection are supported, never namespace migration.
  assert.deepEqual(await writeNativeTerminalProjection(profile,assets),hashes);
 });
 for(const unsafe of ['target-symlink','unfamiliar-directory','nested-symlink','file-hardlink'])await temporary(async directory=>{
  const profile=join(directory,'profile'),outside=join(directory,'outside');await mkdir(profile);await mkdir(outside);await writeFile(join(outside,'sentinel'),'unchanged');
  if(unsafe==='target-symlink')await symlink(outside,join(profile,'native-terminal'));
  else {await mkdir(join(profile,'native-terminal'));if(unsafe!=='unfamiliar-directory')await writeFile(join(profile,'native-terminal/.agent-studio-native-terminal'),'agent-studio-native-terminal-v1\n');if(unsafe==='nested-symlink')await symlink(outside,join(profile,'native-terminal/lib'));if(unsafe==='file-hardlink'){const {link}=await import('node:fs/promises');await link(join(outside,'sentinel'),join(profile,'native-terminal/package.json'));}}
  await assert.rejects(writeNativeTerminalProjection(profile,assets),/Unsafe|Unrecognized/);assert.equal(await readFile(join(outside,'sentinel'),'utf8'),'unchanged');
 });
});

test('actual TerminalView allocation sends model.sessionId and model.id as remote request identity',async()=>{
 const controller=await readFile(join(SDK,'node_modules/@deepseek-ai/dsh-api-terminal-controller/lib/client.js'),'utf8');
 const start=controller.indexOf('async create(environment, shellPath) {'),end=controller.indexOf('\n\t\t\tadopt(info)',start);
 assert.ok(start>0&&end>start);const method=evaluate('({'+controller.slice(start,end)+'}).create',{valueOf:value=>value});
 const requests=[],view={sessionId:'model-session',id:'host-terminal-id',lifetime:{signal:{aborted:false}},remote:{create:async(...args)=>{requests.push(args);return {id:'host-terminal-id'};}},patch(){},inventory:{update(){}},adopt(){},fail(error){throw error;}};
 await method.call(view,{maxCols:120,maxRows:40});assert.equal(requests.length,1);assert.equal(requests[0][0],view.sessionId);assert.equal(requests[0][1].id,view.id);
});

test('identity helpers reject mismatched/malformed IDs without throwing',()=>{
 const model={sessionId:'S',id:'T'};assert.deepEqual(terminalRecoveryIdentity('S',model,{info:{id:'T'}}),{sessionId:'S',terminalId:'T'});
 for(const state of [{info:null},{info:{}},{info:{id:'other'}}])assert.equal(terminalRecoveryIdentity('S',model,state).terminalId,'');
 for(const bad of [undefined,null,{}, {sessionId:'other',id:'T'},{sessionId:'S',id:''}])assert.equal(terminalRecoveryIdentity('S',bad,{}).terminalId,'');
 for(const identity of [null,undefined,{}, {sessionId:'S',terminalId:''}])assert.equal(terminalRecoveryWritable({writable:true},identity),false);
 assert.equal(terminalRecoveryWritable({sessionId:'S',terminalId:'T',writable:true},{sessionId:'S',terminalId:'T'}),true);
 assert.equal(terminalRecoveryWritable({sessionId:'S',terminalId:'tab-id',writable:true},{sessionId:'S',terminalId:'T'}),false);
});

function wrapperFixture(kind) {
 const host=hooks(),state={phase:'connected',info:{id:'host-terminal-A',state:'running',cols:80,rows:24},writable:true};let mounts=0,available=true;
 const model={sessionId:'session-A',id:'host-terminal-A',state:{getSnapshot:()=>state,subscribe:()=>()=>{}},mount:()=>{mounts++;return ()=>{};}};
 const tab={id:'tab-is-not-the-terminal',visible:true,actions:{openTab(){throw new Error('no replacement tab should be opened');}}};
 const source=projected[kind],functionName=kind==='native'?'TerminalBody':'TerminalBottomView';
 const start=source.indexOf('const StudioTerminalRecovery ='),end=source.indexOf(kind==='native'?'function TerminalScreen(':'function statusOf(',start);
 const Screen=()=>{};
 const context={react:host.React,react_jsx_runtime:jsx,TerminalScreen:Screen,terminal_module_css_default:{},_deepseek_ai_dsh_client_ui_primitives:{Button:'NativeButton'},webTerminals:()=>({view:(_session,content)=>{assert.equal(content,'content-is-not-the-terminal');return available?model:undefined;}}),terminalRunOf:()=>1,terminalInstanceOf:()=>1,bottomTerminalContentId:()=>'content-is-not-the-terminal',subscribeColorScheme:()=>()=>{},isDarkScheme:()=>false,statusOf:()=>undefined,reconnectable:()=>false,t:value=>value};
 const Component=evaluate(source.slice(start,end)+';'+functionName,context);
 const props=kind==='native'?{useTabInfo:()=>({tab}),useTerminal:()=>state,useTheme:()=>({}),view:id=>{assert.equal(id,tab.id);return model;},t:value=>value}:{ctx:{get:()=>undefined},scope:{sessionId:'session-A'},tab,visible:true};
 return {host,state,model,tab,props,mounts:()=>mounts,setAvailable(value){available=value;},render(){const tree=host.render(Component,props);const panel=nodes(tree,value=>typeof value.type==='function'&&value.props?.onState)[0];const screen=nodes(tree,value=>value.type===Screen)[0];return {tree,panel,screen};}};
}
for(const kind of ['bottom','native'])test(`${kind} actual projected wrapper gates exact model identity, visibility and generation`,()=>{
 const fixture=wrapperFixture(kind);let view=fixture.render();assert.ok(view.panel);assert.equal(view.panel.props.terminalId,fixture.model.id);assert.equal(view.panel.props.scope.sessionId,fixture.model.sessionId);assert.notEqual(view.panel.props.terminalId,fixture.tab.id);assert.equal(view.screen.props.state.writable,false);assert.equal(fixture.mounts(),1);
 const proof={sessionId:fixture.model.sessionId,terminalId:fixture.model.id,writable:true};
 view.panel.props.onState({...proof,terminalId:fixture.tab.id});assert.equal(fixture.render().screen.props.state.writable,false);
 view.panel.props.onState(proof);view=fixture.render();assert.equal(view.screen.props.state.writable,true);
 const oldNotify=view.panel.props.onState;
 if(kind==='native')fixture.tab.visible=false;else fixture.props.visible=false;
 view=fixture.render();assert.equal(view.screen.props.state.writable,false);
 if(kind==='native')fixture.tab.visible=true;else fixture.props.visible=true;
 view=fixture.render();assert.equal(view.screen.props.state.writable,false);oldNotify(proof);assert.equal(fixture.render().screen.props.state.writable,false);
 view.panel.props.onState(proof);assert.equal(fixture.render().screen.props.state.writable,true);
 fixture.model.id='host-terminal-B';fixture.state.info.id=fixture.model.id;view=fixture.render();assert.equal(view.screen.props.state.writable,false);oldNotify(proof);assert.equal(fixture.render().screen.props.state.writable,false);
 fixture.model.id='host-terminal-A';fixture.state.info.id=fixture.model.id;view=fixture.render();assert.equal(view.screen.props.state.writable,false);oldNotify(proof);assert.equal(fixture.render().screen.props.state.writable,false);
 fixture.state.info.id='mismatched-info';view=fixture.render();assert.equal(view.panel.props.terminalId,'');assert.equal(view.screen.props.state.writable,false);
 fixture.host.unmount();
});

for(const kind of ['bottom','native'])test(`${kind} actual projected Screen refuses onData while gated but preserves rendering ACKs`,()=>{
 const host=hooks(),writes=[],acks=[],instances=[];let input;
 class Xterm {constructor(options){this.initial={...options};this.options=options;this.textarea={setAttribute(){}};instances.push(this);}loadAddon(){}open(){}onData(callback){input=callback;callback('during-registration');return {dispose(){}};}reset(){}resize(){}write(_data,callback){callback();}focus(){}dispose(){}}
 const source=projected[kind],start=source.indexOf('function TerminalScreen('),end=source.indexOf('//#endregion',start);
 const Component=evaluate(source.slice(start,end)+';TerminalScreen',{react:host.React,react_jsx_runtime:jsx,terminal_module_css_default:{},import_xterm:{Terminal:Xterm},import_addon_fit:{FitAddon:class {proposeDimensions(){return {cols:80,rows:24};}}},TerminalTheme:class{update(){}dispose(){}},observeTerminalCursor:()=>({dispose(){}}),ResizeObserver:class{observe(){}disconnect(){}},getComputedStyle:()=>({fontFamily:'monospace',backgroundColor:'#000',color:'#fff'})});
 const model={write:value=>writes.push(value),acknowledge:value=>acks.push(value),resize(){}};
 const props={model,state:{writable:false,phase:'connected',environment:{maxCols:100,maxRows:30},info:{cols:80,rows:24},render:{revision:1,frame:{type:'snapshot',info:{cols:80,rows:24},screen:'original-output'}}},visible:true,label:'Terminal',scheme:false,theme:{fontFamilies:{terminal:''},fontSizes:{terminal:13}}};
 host.render(Component,props);assert.equal(instances.length,1);assert.equal(instances[0].initial.disableStdin,true);assert.deepEqual(writes,[]);assert.deepEqual(acks,[1]);input('denied');assert.deepEqual(writes,[]);
 props.state={...props.state,writable:true};host.render(Component,props);input('one-explicit-input');assert.deepEqual(writes,['one-explicit-input']);
 props.visible=false;host.render(Component,props);input('hidden');assert.deepEqual(writes,['one-explicit-input']);
 props.visible=true;props.state={...props.state,writable:false,render:{revision:2,frame:{type:'data',data:'next-original-output'}}};host.render(Component,props);input('denied-again');assert.deepEqual(writes,['one-explicit-input']);assert.deepEqual(acks,[1,2]);assert.equal(instances.length,1);host.unmount();
});

test('terminal panel derives the exact operation and never falls back to global task lists',async()=>{
 const fixture=panelFixture();await fixture.ready();assert.equal(fixture.calls.length,1);assert.equal(fixture.calls[0].method,'task.recovery');assert.deepEqual(fixture.calls[0].payload,{session_id:'session-A',operation_id:operationId('session-A','host-terminal-A')});assert.equal(fixture.last().writable,true);
 for(const wrong of [row('wrong-session'),row('session-A','wrong-terminal'),{...row(),operation:{...row().operation,kind:'command.exec'}},null]) {fixture.setResponse(()=>wrong);await fixture.tick();assert.equal(fixture.last().writable,false);assert.ok(nodes(fixture.render(),node=>node.props?.['data-recovery-error']).length);}
 fixture.host.unmount();
 for(const terminalId of ['',undefined]) {const invalid=panelFixture({props:{terminalId}});await invalid.ready();if(terminalId===''){assert.equal(invalid.calls.length,0);assert.equal(invalid.last().writable,false);}else assert.equal(invalid.calls[0].method,'task.recoveries');invalid.host.unmount();}
});

test('late polls cannot unlock switched terminal, session, hidden view or A→B→A generation',async()=>{
 for(const change of ['session','terminal','hidden','cycle']) {
  const waiting=deferred(),fixture=panelFixture({response:()=>waiting.promise});fixture.render();await settle();assert.equal(fixture.calls.length,1);
  if(change==='session')fixture.props.scope={sessionId:'session-B'};
  else if(change==='terminal'||change==='cycle')fixture.props.terminalId='host-terminal-B';
  else fixture.props.visible=false;
  fixture.render();await settle();if(change==='cycle'){fixture.props.terminalId='host-terminal-A';fixture.render();await settle();}
  waiting.resolve(row());await settle();fixture.render();
  if(change==='cycle')assert.equal(fixture.last().writable,true); // Only the NEW A read may verify A.
  else assert.equal(fixture.last().writable,false);
  assert.ok(fixture.notices.filter(value=>value.writable).every(value=>value.sessionId===fixture.props.scope.sessionId&&value.terminalId===fixture.props.terminalId));fixture.host.unmount();
 }
 // A→B→A with independent delayed reads: old A cannot authorize new A.
 const old=deferred(),fresh=deferred();let count=0;
 const fixture=panelFixture({response:()=>++count===1?old.promise:fresh.promise});fixture.render();await settle();fixture.props.terminalId='B';fixture.render();await settle();fixture.props.terminalId='host-terminal-A';fixture.render();await settle();old.resolve(row());await settle();assert.equal(fixture.last().writable,false);fresh.resolve(row());await settle();assert.equal(fixture.last().writable,true);fixture.host.unmount();
});

test('double-click sends one explicit recovery; in-flight polls and late actions cannot unlock another owner',async()=>{
 for(const change of ['session','terminal','hidden','cycle']) {
  const action=deferred(),fixture=panelFixture({response:call=>call.method==='task.recover'?action.promise:row('session-A','host-terminal-A','lost')});
  let tree=await fixture.ready();const recover=nodes(tree,node=>node.type==='button'&&node.props.children==='Recover original task')[0];assert.ok(recover);
  recover.props.onClick();recover.props.onClick();await settle();assert.equal(fixture.calls.filter(call=>call.method==='task.recover').length,1);assert.equal(fixture.last().writable,false);
  const originalRecovery=fixture.calls.find(call=>call.method==='task.recover');assert.equal(originalRecovery.payload.operation_id,operationId('session-A','host-terminal-A'));assert.ok(originalRecovery.payload.recovery_id);
  const before=fixture.calls.length;await fixture.tick();assert.equal(fixture.calls.length,before);
  if(change==='session')fixture.props.scope={sessionId:'session-B'};else if(change==='hidden')fixture.props.visible=false;else fixture.props.terminalId='host-terminal-B';fixture.render();await settle();if(change==='cycle'){fixture.props.terminalId='host-terminal-A';fixture.render();await settle();}
  fixture.setResponse(call=>call.method==='task.recovery'?row():action.promise);action.resolve({recovered:true});await settle();assert.equal(fixture.last().writable,false);assert.equal(fixture.calls.filter(call=>['task.recover','task.cancel','task.release'].includes(call.method)).length,1);fixture.host.unmount();
 }
});

test('actual wrappers reset proof across readonly readiness, missing state, and session A→B→A',()=>{
 for(const kind of ['bottom','native']) {
  const fixture=wrapperFixture(kind),proof={sessionId:'session-A',terminalId:'host-terminal-A',writable:true};let view=fixture.render();
  view.panel.props.onState(proof);view=fixture.render();assert.equal(view.screen.props.state.writable,true);const original=view.panel.props.onState;
  fixture.state.writable=false;view=fixture.render();assert.equal(view.screen.props.state.writable,false);
  fixture.state.writable=true;view=fixture.render();assert.equal(view.screen.props.state.writable,false);original(proof);assert.equal(fixture.render().screen.props.state.writable,false);
  view.panel.props.onState(proof);assert.equal(fixture.render().screen.props.state.writable,true);
  if(kind==='bottom'){fixture.props.scope={sessionId:'session-B'};fixture.setAvailable(false);view=fixture.render();assert.equal(view.screen,undefined);fixture.props.scope={sessionId:'session-A'};fixture.setAvailable(true);}
  else {fixture.model.sessionId='session-B';view=fixture.render();assert.equal(view.panel.props.scope.sessionId,'session-B');assert.equal(view.screen.props.state.writable,false);fixture.model.sessionId='session-A';}
  view=fixture.render();assert.equal(view.screen.props.state.writable,false);original(proof);assert.equal(fixture.render().screen.props.state.writable,false);
  if(kind==='native'){fixture.state.writable=false;fixture.state.issue='missingTerminal';view=fixture.render();assert.ok(view.panel,'Recovery is also available in native missing-terminal UI');assert.equal(view.screen,undefined);delete fixture.state.issue;fixture.state.writable=true;}
  if(kind==='native')fixture.tab.visible=undefined;else fixture.props.visible=undefined;
  view=fixture.render();view.panel.props.onState(proof);assert.equal(fixture.render().screen.props.state.writable,false);fixture.host.unmount();
 }
});

test('parent readiness generations reject late same-identity recovery reads',async()=>{
 const old=deferred(),fresh=deferred();let count=0;
 const fixture=panelFixture({response:()=>++count===1?old.promise:fresh.promise});fixture.props.generation={};fixture.render();await settle();fixture.props.generation={};fixture.render();await settle();old.resolve(row());await settle();assert.equal(fixture.last().writable,false);fresh.resolve(row());await settle();assert.equal(fixture.last().writable,true);fixture.host.unmount();
});

test('poll already in flight before recovery cannot reopen input during the action',async()=>{
 const poll=deferred(),action=deferred(),authority=deferred();let reads=0;
 const fixture=panelFixture({response:call=>call.method==='task.recover'?action.promise:++reads===1?row('session-A','host-terminal-A','lost'):reads===2?poll.promise:authority.promise});
 const tree=await fixture.ready(),button=nodes(tree,node=>node.type==='button'&&node.props.children==='Recover original task')[0];
 await fixture.tick();assert.equal(reads,2);button.props.onClick();await settle();assert.equal(fixture.last().writable,false);poll.resolve(row());await settle();assert.equal(fixture.last().writable,false);
 action.resolve({});await settle();assert.equal(reads,3);assert.equal(fixture.last().writable,false);authority.resolve(row('session-A','host-terminal-A','recovered'));await settle();assert.equal(fixture.last().writable,true);assert.equal(fixture.calls.filter(call=>call.method==='task.recover').length,1);fixture.host.unmount();
});

test('cancel and release remain exact one-shot original-task actions with no automatic replacement',async()=>{
 const cancel=deferred(),release=deferred();let cancelled=false,released=false;
 const fixture=panelFixture({response:call=>call.method==='task.cancel'?cancel.promise:call.method==='task.release'?release.promise:released?null:cancelled?{...row(),operation:{...row().operation,state:'cancelled'}}:row()});
 let tree=await fixture.ready(),button=nodes(tree,node=>node.type==='button'&&node.props.children==='Cancel original task')[0];assert.ok(button);button.props.onClick();button.props.onClick();await settle();assert.equal(fixture.last().writable,false);assert.equal(fixture.calls.filter(call=>call.method==='task.cancel').length,1);
 cancelled=true;cancel.resolve({});await settle();tree=fixture.render();button=nodes(tree,node=>node.type==='button'&&node.props.children==='Release original task')[0];assert.ok(button);button.props.onClick();button.props.onClick();await settle();assert.equal(fixture.calls.filter(call=>call.method==='task.release').length,1);
 released=true;release.resolve({});await settle();assert.equal(fixture.last().writable,false);assert.deepEqual(fixture.calls.map(call=>call.method),['task.recovery','task.cancel','task.recovery','task.release','task.recovery']);for(const call of fixture.calls)assert.equal(call.payload.operation_id,operationId('session-A','host-terminal-A'));fixture.host.unmount();
});

test('successful explicit recovery needs authoritative read; failure never retries or replays input',async()=>{
 const action=deferred();let restored=false;
 const fixture=panelFixture({response:call=>call.method==='task.recover'?action.promise:row('session-A','host-terminal-A',restored?'recovered':'lost')});
 let tree=await fixture.ready();nodes(tree,node=>node.type==='button'&&node.props.children==='Recover original task')[0].props.onClick();await settle();assert.equal(fixture.last().writable,false);restored=true;action.resolve({});await settle();assert.equal(fixture.last().writable,true);assert.deepEqual(fixture.calls.map(call=>call.method),['task.recovery','task.recover','task.recovery']);fixture.host.unmount();
 const broken=panelFixture({response:call=>call.method==='task.recover'?Promise.reject(new Error('verification failed')):row('session-A','host-terminal-A','lost')});tree=await broken.ready();nodes(tree,node=>node.type==='button'&&node.props.children==='Recover original task')[0].props.onClick();await settle();tree=broken.render();assert.equal(broken.last().writable,false);assert.equal(broken.calls.filter(call=>call.method==='task.recover').length,1);assert.ok(nodes(tree,node=>node.props?.['data-recovery-error']).length);assert.ok(broken.calls.every(call=>!['task.start','task.write','task.open','task.approve'].includes(call.method)));broken.host.unmount();
});
