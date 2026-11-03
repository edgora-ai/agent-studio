import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import {projectSidebar} from './sidebar-projection.mjs';

const root='/home/ubuntu/.dsh/profiles/web/node_modules/dsh-better-sidebar/lib/';
const files=['client.js','client-registry.js'];
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const chunk=(text,start,end)=>{const a=text.indexOf(start),b=text.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,'native seam: '+start);return text.slice(a,b);};
const jsx={jsx:(type,props)=>typeof type==='function'?type(props):({type,props}),jsxs:(type,props)=>typeof type==='function'?type(props):({type,props})};
const nodes=(tree,predicate)=>!tree?[]:Array.isArray(tree)?tree.flatMap(n=>nodes(n,predicate)):typeof tree==='object'?[...(predicate(tree)?[tree]:[]),...nodes(tree.props?.children,predicate)]:[];
const content=tree=>typeof tree==='string'?tree:Array.isArray(tree)?tree.map(content).join(''):tree&&typeof tree==='object'?content(tree.props?.children):'';
function projected(file) {
  const bytes=readFileSync(root+file);
  assert.throws(()=>projectSidebar('lib/'+file,Buffer.concat([bytes,Buffer.from(' ')])),/hash mismatch/);
  const source=projectSidebar('lib/'+file,bytes).toString();
  const check=spawnSync(process.execPath,['--check','--input-type=module'],{input:source,encoding:'utf8'});
  assert.equal(check.status,0,check.stderr);
  assert.match(source,/const studioGitReadOnly = true/);
  assert.match(source,/if\(studioGitReadOnly\) \{setActionError/);
  assert.match(source,/disabled: studioGitReadOnly \|\| busy/);
  return source;
}
function store(source) {
  const calls=[];let response=()=>Promise.resolve({isRepo:true,root:'/repo',entries:[],branch:'main'});
  const api={gitStatus:(scope,target)=>{calls.push({scope,target});return response(scope,target);}};
  const react={useCallback:fn=>fn,useSyncExternalStore:()=>{},useEffect:()=>{}};
  const ctx={api,react,window:{setInterval:()=>1,clearInterval:()=>{}},Date,Map,Set,normPath:x=>x};
  const js=chunk(source,'function sameStatus(a, b) {','//#endregion');
  const data=vm.runInNewContext(js+';({slotOf$1,fetchSlot$1,useGitStatus,slots$1})',ctx);
  return {...data,calls,setResponse:fn=>{response=fn;}};
}
function branch(source) {
  const calls=[];let response=()=>Promise.resolve({current:'',names:[]});
  const api={gitBranch:(scope,target)=>{calls.push({scope,target});return response(scope,target);}};
  const state={names:[],error:null,loaded:false};
  const scopeGen={current:1},branchRequest={current:0},chosenPathRef={current:'/repo'};
  let scope={sessionId:'A',cwd:'/root',repoRoot:'/repo'};
  const ctx={api,studioGitErrorCode:vm.runInNewContext(chunk(source,'const studioGitErrorCode = ','function slotOf$1(scope, worktree) {')+';studioGitErrorCode'),react:{useCallback:fn=>fn},scopeGen,branchRequest,chosenPathRef,gitScopeNow:()=>({...scope}),setBranchNames:value=>{state.names=value;},setBranchLoaded:value=>{state.loaded=value;},setBranchError:value=>{state.error=value;}};
  const js=chunk(source,'const loadTarget = (0, react.useCallback)(','/** One listing pass:');
  const loadTarget=vm.runInNewContext(js+';loadTarget',ctx);
  return {state,calls,scopeGen,branchRequest,chosenPathRef,loadTarget,setResponse:fn=>{response=fn;},setScope:value=>{scope=value;}};
}
function surface(source,values) {
  // These are the actual native render expressions, cut at adjacent JSX siblings.
  const start='status.error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Notice, {';
  const end='snapshot?.truncated === true &&';
  const notices=chunk(source,start,end).trim().replace(/,\s*$/,'');
  const menu=chunk(source,'items: branchError !== null || !branchLoaded','selectedId: branch,');
  const ctx={...values,react_jsx_runtime:jsx,clsx:(...names)=>names.filter(Boolean).join(' '),kit_module_css_default:{notice:'notice',noticeWell:'well',noticePage:'page',noticeInline:'inline',noticeError:'error',noticeWarn:'warn',noticeHint:'hint'},t:key=>key};
  vm.runInNewContext(chunk(source,'function Notice(props) {','function ConfirmDialog(props) {')+';this.Notice=Notice',ctx);
  const result=vm.runInNewContext('['+notices+']',ctx);
  const items=vm.runInNewContext('({'+menu+'}).items',ctx);
  return {result,items};
}

function composed(source) {
  // Native store, lens scope/selection, branch owner and refresh chain share one VM
  // and one fake API; only React state setters and effects are fixture boundaries.
  const calls=[];
  const state={sessionId:'A',cwd:'/root',repoRoot:undefined,selectedWorktree:undefined,worktrees:[],names:[],error:null,loaded:false};
  let statusRead=()=>Promise.reject({code:'network'}),inventoryRead=()=>Promise.resolve([]),branchRead=()=>Promise.reject({code:'network'});
  const api=new Proxy({gitStatus:(scope,target)=>{calls.push({kind:'status',scope:{...scope},target});return statusRead(scope,target);},gitWorktrees:(scope)=>{calls.push({kind:'inventory',scope:{...scope}});return inventoryRead(scope);},gitBranch:(scope,target)=>{calls.push({kind:'branch',scope:{...scope},target});return branchRead(scope,target);}}, {get(target,key){if(!(key in target))throw Error('unexpected mutation API: '+String(key));return target[key];}});
  const scopeRef={current:{sessionId:state.sessionId,cwd:state.cwd}},repoRootRef={current:undefined},chosenPathRef={current:undefined};
  const scopeGen={current:1},branchRequest={current:0},autoSelectDone={current:true},gate={current:{inFlight:false,queued:false,queuedSilent:true}},actionLock={current:null};
  const set=(key)=>(value)=>{state[key]=typeof value==='function'?value(state[key]):value;};
  const ctx={api,Map,Set,Date,window:{setInterval:()=>1,clearInterval:()=>{}},normPath:x=>x,
    react:{useCallback:fn=>fn,useSyncExternalStore:()=>{},useEffect:()=>{}},react_jsx_runtime:jsx,
    scopeRef,repoRootRef,chosenPathRef,scopeGen,branchRequest,autoSelectDone,gate,actionLock,
    setSelectedWorktree:set('selectedWorktree'),setRepoRoot:set('repoRoot'),setWorktrees:set('worktrees'),setBranchNames:set('names'),setBranchError:set('error'),setBranchLoaded:set('loaded'),
    setBusy:()=>{},setSuggesting:()=>{},setCommitting:()=>{},setGraphRefresh:()=>{},setActionError:()=>{},setFileMenu:()=>{},setHistoryMenu:()=>{},setConfirm:()=>{},setMoreOpen:()=>{},setBranchOpen:()=>{},setViewError:()=>{},
    sameWorktrees:(a,b)=>a===b,errorMessage:()=>{throw Error('unexpected inventory failure');},repoRoot:undefined};
  const code=[
    chunk(source,'const POLL_BASE_MS = ','const studioGitErrorCode = '),
    chunk(source,'const studioGitErrorCode = ','//#endregion'),
    chunk(source,'const gitScopeNow = (0, react.useCallback)(','/** Label the generate button'),
    chunk(source,'const selectWorktree = (target) => {','/** Load the branch choices'),
    chunk(source,'const loadTarget = (0, react.useCallback)(','/** One listing pass:'),
    chunk(source,'const runOnce = (0, react.useCallback)(','(0, react.useEffect)(() => {\n\t\t\t\tscopeGen.current += 1;'),
    chunk(source,'const chooseWorktree = (target) => {','const checkout = async (branch) => {')
  ].join('\n');
  const native=vm.runInNewContext(code+';({useGitStatus,slotOf$1,gitScopeNow,chooseRepo,chooseWorktree,refresh})',ctx);
  const derived=chunk(source,'const snapshot = status.snapshot ?? lastStatus.current.value;','(0, react.useEffect)(() => {\n\t\t\t\tconst repositories');
  const classification=chunk(source,'const isRepo = snapshot?.isRepo === true;','const canCommit =');
  const lastStatus={current:{value:null}};
  const view=()=>{
    const scope={...scopeRef.current,...state.repoRoot===undefined?{}:{repoRoot:state.repoRoot}};
    const primary=state.worktrees.find(entry=>entry.current)?.path;
    const worktree=state.selectedWorktree!==undefined&&state.selectedWorktree!==primary?state.selectedWorktree:undefined;
    const status=native.useGitStatus(scope,{worktree,visible:false});
    const values=vm.runInNewContext(derived+';'+classification+';({snapshot,statusUnconfirmed,isRepo,clean})',{status,lastStatus,entries:status.snapshot?.entries??lastStatus.current.value?.entries??[]});
    const rendered=surface(source,{...values,status,branchError:state.error,branchLoaded:state.loaded,branchNames:state.names,branch:values.snapshot?.branch??'',refresh:native.refresh,busy:false,suggesting:false});
    return {...rendered,...values,status};
  };
  return {calls,state,native,view,scopeRef,repoRootRef,chosenPathRef,gate,setStatus:fn=>{statusRead=fn;},setInventory:fn=>{inventoryRead=fn;},setBranch:fn=>{branchRead=fn;}};
}

for(const file of files) test(file+' actual projected store: distinct failures, cached rows, same-status recovery and native scope',async()=>{
  const source=projected(file),s=store(source),scope={sessionId:'A',cwd:'/root',repoRoot:'/repo'};
  const slot=s.slotOf$1(scope,'/repo');
  slot.visible=1; // A retained native consumer keeps its shared slot across reads.
  assert.equal(s.slotOf$1(scope,'/repo'),slot);
  assert.notEqual(s.slotOf$1({...scope,cwd:'/other'},'/repo'),slot);
  for(const code of ['PermissionError','agent-studio/provider-unavailable','network','read-deadline','git-command-failed']) {
    s.setResponse(()=>Promise.reject({code,message:'/private/secret'}));s.fetchSlot$1(slot);await settle();
    assert.equal(slot.error,true);assert.equal(slot.errorCode,code);assert.equal(slot.snapshot,null);
  }
  const clean={isRepo:true,root:'/repo',entries:[],branch:'main',unborn:true,head:null};
  s.setResponse(()=>Promise.resolve({...clean}));s.fetchSlot$1(slot);await settle();
  assert.equal(slot.error,false);assert.equal(slot.errorCode,null);assert.equal(slot.snapshot.unborn,true);
  s.setResponse(()=>Promise.reject({code:'network',message:'/secret'}));s.fetchSlot$1(slot);await settle();
  assert.equal(slot.snapshot.isRepo,true);assert.equal(slot.errorCode,'network');
  const retry=deferred();s.setResponse(()=>retry.promise);s.fetchSlot$1(slot);
  assert.equal(slot.errorCode,'network','retry start cannot certify cached rows');
  retry.reject({code:'read-deadline'});await settle();assert.equal(slot.errorCode,'read-deadline');
  s.setResponse(()=>Promise.resolve({...clean}));s.fetchSlot$1(slot);await settle();
  assert.equal(slot.errorCode,null,'sameStatus recovery clears reason');
  s.setResponse(()=>Promise.resolve({isRepo:false,entries:[],repositories:[],complete:true}));s.fetchSlot$1(slot);await settle();
  assert.equal(slot.snapshot.isRepo,false);assert.equal(slot.error,false);
  const pending=deferred();s.setResponse(()=>pending.promise);s.fetchSlot$1(slot);assert.equal(slot.error,false);
  s.fetchSlot$1(slot);assert.equal(slot.pending,true,'native queue retained');pending.resolve(clean);await settle();
  assert.deepEqual({...s.calls.at(-1).scope},scope);assert.equal(s.calls.at(-1).target,'/repo');
  const hook=s.useGitStatus(scope,{worktree:'/repo',visible:false});assert.equal(hook.errorCode,null);assert.equal(hook.snapshot.isRepo,true);
  const late=deferred();s.setResponse(()=>late.promise);s.fetchSlot$1(slot);slot.generation++;
  late.reject({code:'network'});await settle();assert.equal(slot.errorCode,null,'obsolete native generation cannot publish failure');
});

for(const file of files) test(file+' serialized error code validation has bounded fallback',()=>{
  const source=projected(file);
  const helper=vm.runInNewContext(chunk(source,'const studioGitErrorCode = ','function slotOf$1(scope, worktree) {')+';studioGitErrorCode');
  for(const reason of [{},{code:17},{code:'x'.repeat(81)},{code:' network'},{code:'network '},{code:'bad\tcode'},{code:'/private/secret'},{code:''}])assert.equal(helper(reason),'read-failed');
  // Syntax validation, not a semantic allowlist of provider namespaces.
  for(const code of ['network','agent-studio/provider-unavailable','future-provider/read-failed'])assert.equal(helper({code,message:'/private/secret'}),code);
});

for(const file of files) test(file+' actual branch request ownership and rendered notices/menu/retry',async()=>{
  const source=projected(file),b=branch(source);
  await b.loadTarget('/repo');assert.equal(b.state.error,null);assert.equal(b.state.loaded,true);assert.equal(b.state.names.length,0);
  for(const code of ['PermissionError','agent-studio/provider-unavailable','network']) {
    b.setResponse(()=>Promise.reject({code,message:'/private/secret'}));await b.loadTarget('/repo');
    assert.equal(b.state.error,code);assert.equal(b.state.loaded,true);
    const calls=[];const view=surface(source,{status:{error:false,refresh:()=>calls.push('status')},snapshot:null,statusUnconfirmed:false,isRepo:false,branchError:b.state.error,branchLoaded:b.state.loaded,branchNames:b.state.names,refresh:()=>calls.push('native'),branch:'',busy:false,suggesting:false});
    assert.match(content(view.result),new RegExp(code));assert.doesNotMatch(content(view.result),/private|secret/);
    const warning=nodes(view.result,n=>n.type==='div'&&n.props?.['data-kind']==='warn')[0];
    assert.equal(warning.props.role,'alert');assert.match(content(warning),/Branch list unavailable/);
    assert.match(view.items[0].label,/Branch list unavailable/);
    nodes(view.result,n=>n.props?.['data-studio-git-retry'])[0].props.onClick();assert.deepEqual(calls,['status','native']);
  }
  const retry=deferred();b.setResponse(()=>retry.promise);const waiting=b.loadTarget('/repo');
  assert.equal(b.state.error,'network','branch warning remains while retry is pending');
  retry.reject({code:'read-deadline'});await waiting;assert.equal(b.state.error,'read-deadline');
  const late=deferred(),fresh=deferred();let index=0;b.setResponse(()=>(++index===1?late.promise:fresh.promise));
  const old=b.loadTarget('/repo'),next=b.loadTarget('/repo');fresh.resolve({names:['new'],current:'new'});await next;
  late.reject({code:'network'});await old;assert.equal(b.state.error,null);assert.deepEqual(b.state.names,['new']);
  const oldSuccess=deferred(),newFailure=deferred();index=0;b.setResponse(()=>(++index===1?oldSuccess.promise:newFailure.promise));
  const older=b.loadTarget('/repo'),newer=b.loadTarget('/repo');newFailure.reject({code:'read-deadline'});await newer;
  oldSuccess.resolve({names:['obsolete'],current:'obsolete'});await older;
  assert.equal(b.state.error,'read-deadline');assert.deepEqual(b.state.names,['new']);
  const stale=deferred();b.setResponse(()=>stale.promise);const previous=b.loadTarget('/repo');b.scopeGen.current++;stale.reject({code:'PermissionError'});await previous;assert.equal(b.state.error,'read-deadline');
  b.chosenPathRef.current='/other';b.setResponse(()=>Promise.reject({code:'network'}));await b.loadTarget('/repo');assert.equal(b.state.error,'read-deadline');
  b.chosenPathRef.current='/repo';b.setScope({sessionId:'B',cwd:'/other',repoRoot:'/other'});await b.loadTarget('/repo');assert.equal(b.calls.at(-1).scope.sessionId,'B');assert.equal(b.state.error,'network');
  b.setResponse(()=>Promise.resolve({names:[],current:''}));await b.loadTarget('/repo');assert.equal(b.state.error,null);assert.equal(b.state.loaded,true);
  const empty=surface(source,{status:{error:false},snapshot:null,statusUnconfirmed:false,isRepo:false,branchError:null,branchLoaded:true,branchNames:[],branch:'',busy:false,suggesting:false});assert.equal(empty.items[0].label,'gitBranchesUnavailable');
});

for(const file of files) test(file+' actual status render distinguishes initial failure, stale clean/rows and confirmed notRepo',()=>{
  const source=projected(file);
  const base={branchError:null,branchLoaded:false,branchNames:[],branch:'',busy:false,suggesting:false,refresh:()=>{}};
  const render=(status,snapshot,statusUnconfirmed,isRepo)=>surface(source,{...base,status,snapshot,statusUnconfirmed,isRepo});
  let view=render({error:true,errorCode:'PermissionError',loading:false,refresh:()=>{}},null,true,false);
  assert.match(content(view.result),/PermissionError.*no confirmed status/);
  const warning=nodes(view.result,n=>n.type==='div'&&n.props?.['data-kind']==='error')[0];
  assert.equal(warning.props.role,'alert');assert.match(content(warning),/no confirmed status/);
  assert.ok(nodes(view.result,n=>n.props?.['data-studio-git-retry']).length);
  view=render({error:true,errorCode:'network',loading:false,refresh:()=>{}},{isRepo:true,entries:[]},true,true);
  assert.match(content(view.result),/cached rows may be stale/);
  assert.doesNotMatch(content(view.result),/notRepo/);
  view=render({error:true,errorCode:'network',loading:false,refresh:()=>{}},{isRepo:false,entries:[]},true,false);
  assert.doesNotMatch(content(view.result),/notRepo/);
  view=render({error:false,loading:false},{isRepo:false,entries:[]},false,false);
  assert.match(content(view.result),/notRepo/);
  view=render({error:false,loading:true,snapshot:null},{isRepo:true,entries:[]},true,true);
  assert.match(content(view.result),/Cached Git status; freshness unconfirmed/);
  assert.match(source,/const clean = isRepo && !statusUnconfirmed && entries.length === 0/);
  assert.match(source,/const statusUnconfirmed = status.error \|\| status.snapshot === null && snapshot !== null/);
});

for(const file of files) test(file+' rendered Retry composes native selection, status slot and queued lens reads',async()=>{
  const source=projected(file),c=composed(source);
  const inventory=[{path:'/checkout',current:true,changes:0},{path:'/linked',current:false,changes:0}];
  c.setInventory(()=>Promise.resolve(inventory));
  c.setStatus(()=>Promise.resolve({isRepo:true,root:'/repo',entries:[],branch:'main'}));
  c.setBranch(()=>Promise.resolve({names:['main'],current:'main'}));
  c.native.chooseRepo('/repo');await settle();
  assert.equal(c.state.repoRoot,'/repo');assert.equal(c.state.selectedWorktree,'/checkout');
  c.native.chooseWorktree('/linked');await settle();
  assert.equal(c.chosenPathRef.current,'/linked');
  const scope={sessionId:'A',cwd:'/root',repoRoot:'/repo'};
  const statusScope={...scope};
  let view=c.view();const slot=c.native.slotOf$1(statusScope,'/linked');slot.visible=1;
  view.status.refresh();await settle();assert.equal(slot.error,false);
  c.setStatus(()=>Promise.reject({code:'network',message:'/private/secret'}));view=c.view();view.status.refresh();await settle();
  c.setBranch(()=>Promise.reject({code:'PermissionError',message:'/private/secret'}));await c.native.refresh(false);
  view=c.view();assert.equal(view.clean,false);assert.equal(view.statusUnconfirmed,true);
  assert.match(content(view.result),/cached rows may be stale/);assert.match(content(view.result),/Branch list unavailable/);
  assert.doesNotMatch(content(view.result),/private|secret/);
  const statusPending=deferred(),inventoryPending=deferred();let inventoryCount=0;
  c.setStatus(()=>statusPending.promise);
  c.setInventory(()=>++inventoryCount===1?inventoryPending.promise:Promise.resolve(inventory));
  const click=()=>{const retry=nodes(c.view().result,n=>n.type==='button'&&n.props?.['data-studio-git-retry'])[0];assert.equal(retry.props.type,'button');retry.props.onClick();};
  const before=c.calls.length;click();await settle();click();await settle();
  assert.equal(slot.pending,true);assert.equal(c.gate.current.queued,true);
  assert.equal(inventoryCount,1);
  view=c.view();assert.equal(view.status.errorCode,'network');assert.equal(c.state.error,'PermissionError');
  assert.match(content(view.result),/cached rows may be stale/);assert.match(content(view.result),/Branch list unavailable/);
  statusPending.reject({code:'read-deadline'});inventoryPending.resolve(inventory);await settle();
  view=c.view();assert.equal(view.status.errorCode,'read-deadline');assert.equal(c.state.error,'PermissionError');
  assert.equal(inventoryCount,2);assert.equal(c.calls.slice(before).filter(call=>call.kind==='status').length,2);
  assert.equal(c.calls.slice(before).filter(call=>call.kind==='branch').length,2);
  for(const call of c.calls.slice(before)){
    assert.deepEqual(call.scope,scope);
    if(call.kind!=='inventory')assert.equal(call.target,'/linked');
  }
  // Another explicit repo selection changes the synchronous refs before React
  // renders; Retry uses the newly selected scope and checkout, not the old slot.
  const nextInventory=[{path:'/next',current:true,changes:0}];
  c.setInventory(()=>Promise.resolve(nextInventory));c.native.chooseRepo('/other');await settle();
  assert.equal(c.state.selectedWorktree,'/next');assert.equal(c.native.gitScopeNow().repoRoot,'/other');
  const after=c.calls.length;const next=c.view();assert.equal(next.status.snapshot,null);
  c.native.slotOf$1({sessionId:'A',cwd:'/root',repoRoot:'/other'},undefined).visible=1;
  c.setStatus(()=>Promise.reject({code:'network'}));next.status.refresh();await settle();
  click();await settle();
  for(const call of c.calls.slice(after)){
    assert.deepEqual(call.scope,{sessionId:'A',cwd:'/root',repoRoot:'/other'});
    if(call.kind==='status')assert.equal(call.target,undefined);
    if(call.kind==='branch')assert.equal(call.target,'/next');
  }
  assert.equal(c.view().status.errorCode,'network');
});

for(const file of files) test(file+' actual native refresh retains current scope, target and queued retry',async()=>{
  const source=projected(file),branches=branch(source),calls=[];
  const gate={current:{inFlight:false,queued:false,queuedSilent:true}};
  const scopeGen=branches.scopeGen,chosenPathRef=branches.chosenPathRef;
  const autoSelectDone={current:true};
  const inventory=deferred();let inventoryReads=0;
  const ctx={react:{useCallback:fn=>fn},api:{gitWorktrees:(scope)=>{calls.push(scope);return ++inventoryReads===1?inventory.promise:Promise.resolve([{path:'/repo',current:true,changes:0}]);}},
    scopeGen,gate,chosenPathRef,autoSelectDone,gitScopeNow:()=>({sessionId:'A',cwd:'/root',repoRoot:'/repo'}),
    setWorktrees:()=>{},sameWorktrees:()=>false,selectWorktree:target=>{chosenPathRef.current=target;},clearDerived:()=>{scopeGen.current++;branches.branchRequest.current++;},
    setGraphRefresh:()=>{},loadTarget:branches.loadTarget,setViewError:()=>{},errorMessage:()=>{throw Error('unexpected native failure');}};
  const code=chunk(source,'const runOnce = (0, react.useCallback)(','(0, react.useEffect)(() => {\n\t\t\t\tscopeGen.current += 1;');
  const refresh=vm.runInNewContext(code+';refresh',ctx);
  branches.setResponse(()=>Promise.reject({code:'agent-studio/provider-unavailable'}));
  const first=refresh(false);await settle();await refresh(false);assert.equal(gate.current.queued,true);
  inventory.resolve([{path:'/repo',current:true,changes:0}]);await first;await settle();
  assert.equal(inventoryReads,2);assert.equal(branches.calls.length,2);
  for(const call of calls)assert.deepEqual({...call},{sessionId:'A',cwd:'/root',repoRoot:'/repo'});
  for(const call of branches.calls){assert.deepEqual({...call.scope},{sessionId:'A',cwd:'/root',repoRoot:'/repo'});assert.equal(call.target,'/repo');}
  assert.equal(branches.state.error,'agent-studio/provider-unavailable');
});
