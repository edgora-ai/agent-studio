import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {AcpPanel} from '../../packages/dsh-agent-studio/acp-sidebar.mjs';
import {projectSidebar} from './sidebar-projection.mjs';

const settle=async()=>{for(let i=0;i<40;i++) await Promise.resolve();};
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const node=(type,props,...children)=>({type,props:{...props,...(children.length?{children:children.length===1?children[0]:children}:{})}});
function nodes(tree,predicate) {
  if(Array.isArray(tree))return tree.flatMap(item=>nodes(item,predicate));
  if(!tree || typeof tree!=='object')return [];
  return [...(predicate(tree)?[tree]:[]),...nodes(tree.props?.children,predicate)];
}
function content(tree) {return typeof tree==='string'?tree:Array.isArray(tree)?tree.map(content).join(''):tree&&typeof tree==='object'?content(tree.props?.children):'';}
function hooks() {
  const slots=[];let cursor=0,queue=[],mounted=true;
  const same=(a,b)=>a&&b&&a.length===b.length&&a.every((value,i)=>Object.is(value,b[i]));
   const React={createElement:node,useState(initial){const at=cursor++;if(!slots[at])slots[at]={value:initial};return [slots[at].value,value=>{slots[at].value=typeof value==='function'?value(slots[at].value):value;}];},useRef(initial){const at=cursor++;if(!slots[at])slots[at]={current:initial};return slots[at];},useEffect(body,deps){const at=cursor++,old=slots[at];if(!old||!same(old.deps,deps)){slots[at]={deps,cleanup:old?.cleanup};queue=queue.filter(entry=>entry.at!==at);queue.push({at,run:()=>{old?.cleanup?.();slots[at].cleanup=body();}});}}};
   return {React,render(Component,props){cursor=0;return Component(props);},commit(){const effects=queue;queue=[];for(const effect of effects)effect.run();},unmount(){mounted=false;queue=[];for(const slot of slots)slot?.cleanup?.();},get mounted(){return mounted;}};
}
function task(id='A',session='S',overrides={}) {return {task_id:id,request_id:'request-'+id,principal_id:'principal',session_id:session,binding_id:'binding-'+session,version:2,backend_id:'backend',backend_version:'v3',protocol:'acp',run_id:'run',cli_instance_id:'instance-'+id,cli_session_id:'cli-'+id,operation_id:'operation-'+id,prompt_json:JSON.stringify([{type:'text',text:'Original prompt '+id}]),state:'completed',result_json:JSON.stringify({stopReason:'end_turn',result:'actual result'}),deadline_ms:1800000000000,exit_code:0,error_code:null,...overrides};}
function control(row,overrides={}) {return {control_id:'control-'+row.task_id,request_id:row.request_id,principal_id:row.principal_id,run_id:row.run_id,session_id:row.session_id,binding_id:row.binding_id,version:row.version,cli_instance_id:row.cli_instance_id,cli_session_id:row.cli_session_id,kind:'approval',state:'rejected',deadline_ms:1800000000000,delivery:'stdio-written-unconfirmed',call_id:'call-1',rpc_request_id:'"rpc-1"',payload_json:'{"action":"inspect"}',answer_json:'"rejected"',...overrides};}
function event(seq,update,taskId='A') {return {task_id:taskId,seq,kind:'session/update',payload_json:JSON.stringify({update})};}
function binding(session='S',overrides={}) {return {binding_id:'binding-'+session,version:2,principal_id:'principal',target_root:'/workspace',...overrides};}
function fixture(options={}) {
  const host=hooks(),calls=[],timers=new Map();let timerId=0;
   const props={scope:{sessionId:'S'},visible:true,React:host.React,routeUrl:value=>'/offline/'+value};
  let response=options.response??(call=>{
    const rows=options.tasks??[task()];
      switch(call.method){case 'session.get':return {session_id:call.payload.session_id,principal_id:'principal',binding_id:'binding-'+call.payload.session_id,version:2};case 'binding.get':return binding(call.payload.binding_id.slice('binding-'.length));case 'acp.describe':return {backends:options.backends??[{id:'backend',name:'Backend',version:'v3',configured:true}]};case 'acp.tasks':return rows.filter(row=>row.session_id===call.payload.session_id);case 'acp.controls':return options.controls??[];case 'acp.events':return options.events?.[call.payload.task_id]??[];default:throw new Error('Unexpected RPC '+call.method);}
  });
  const Component=vm.runInNewContext('('+AcpPanel.toString()+')',{fetch:async(_url,init)=>{const call=JSON.parse(init.body);calls.push(call);const value=await response(call);return {ok:true,json:async()=>({result:{ok:true,value}})};},crypto:{randomUUID},AbortController,AbortSignal,setTimeout:fn=>{const id=++timerId;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)});
   return {props,host,calls,timers,setResponse(fn){response=fn;},renderOnly(){return host.render(Component,props);},commit(){host.commit();},render(){const tree=this.renderOnly();this.commit();return tree;},async ready(){this.render();await settle();return this.render();},async tick(){const callbacks=[...timers.values()];timers.clear();for(const fn of callbacks)fn();await settle();return this.render();}};
}

test('reload keeps original prompt and verbatim contiguous role chunks across 41+ ordered events',async()=>{
  const updates=Array.from({length:45},(_,i)=>event(i+1,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:i===0?'Hello':String(i)}}));
  const instance=fixture({events:{A:updates}}),first=await instance.ready();
  for(const tree of [first,instance.render()]) {
    assert.match(content(nodes(tree,n=>n.props?.['aria-label']==='Selected ACP task details')[0]),/Original prompt A/);
    const journal=nodes(tree,n=>n.props?.['aria-label']==='ACP protocol journal')[0];
    assert.equal(nodes(journal,n=>n.type==='pre').length,1);
    assert.equal(content(nodes(journal,n=>n.type==='pre')[0]),'Hello'+Array.from({length:44},(_,i)=>String(i+1)).join(''));
  }
  instance.host.unmount();assert.equal(instance.timers.size,0);
  const reloaded=fixture({events:{A:updates}});assert.match(content(await reloaded.ready()),/Original prompt A/);reloaded.host.unmount();
  assert.ok(instance.calls.every(call=>!['acp.start','acp.cancel','acp.reply'].includes(call.method)));
});

test('mixed typed updates remain separate, malformed stored JSON warns, explicit display bounds',async()=>{
   const events=[event(1,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'one'}}),event(2,{sessionUpdate:'tool_call',toolCallId:'tool-A'}),event(3,{sessionUpdate:'user_message_chunk',content:{type:'text',text:'user'}}),{task_id:'A',seq:4,kind:'session/update',payload_json:'{broken'},event(5,{sessionUpdate:'agent_message_chunk',content:{type:'image',data:'metadata'}}),...Array.from({length:510},(_,i)=>({task_id:'A',seq:6+i,kind:'other',payload_json:'{"n":'+i+'}'}))];
  const instance=fixture({events:{A:events},tasks:[task('A','S',{prompt_json:'{broken',result_json:'{broken',identity_json:'{broken'})]}),tree=await instance.ready();
  const journal=nodes(tree,n=>n.props?.['aria-label']==='ACP protocol journal')[0],shown=content(journal);
  assert.match(shown,/tool-A/);assert.match(shown,/user/);assert.match(shown,/Malformed stored event #4 JSON/);assert.match(shown,/Display limit reached: \d+ event/);
  assert.match(content(tree),/Malformed stored prompt JSON/);assert.match(content(tree),/Malformed stored result JSON/);assert.match(content(tree),/Malformed stored identity JSON/);
  instance.host.unmount();
});

test('selected task control ownership and written-unconfirmed delivery distinguish decision from peer consumption',async()=>{
  const a=task(),b=task('B'),strict=control(a),unrelated=[control(a,{control_id:'other-request',request_id:'other'}),control(a,{control_id:'other-session',session_id:'other'}),control(a,{control_id:'other-binding',binding_id:'other'}),control(a,{control_id:'other-version',version:3}),control(a,{control_id:'other-instance',cli_instance_id:'other'}),control(a,{control_id:'other-cli-session',cli_session_id:'other'})];
  const instance=fixture({tasks:[b,a],controls:[strict,...unrelated,control(b)]});let tree=await instance.ready();
  let history=nodes(tree,n=>n.props?.['aria-label']==='Selected ACP task controls')[0];
  assert.match(content(history),/rejected/);assert.match(content(history),/stdio-written-unconfirmed/);assert.match(content(history),/peer consumption unconfirmed/);
  assert.doesNotMatch(content(history),/other-request|other-session|other-binding|other-version|other-instance|other-cli-session/);
  nodes(tree,n=>n.type==='button'&&n.props?.key==='B')[0].props.onClick();tree=instance.render();await settle();tree=instance.render();history=nodes(tree,n=>n.props?.['aria-label']==='Selected ACP task controls')[0];
  assert.match(content(history),/control-B/);assert.doesNotMatch(content(history),/control-A/);
  assert.ok(instance.calls.every(call=>!['acp.start','acp.cancel','acp.reply'].includes(call.method)));instance.host.unmount();
});

test('terminal history with zero backends preserves refused, unknown, interrupted and typed stopReason',async()=>{
  const rows=[task('R','S',{state:'refused',result_json:'{"stopReason":"refusal"}'}),task('U','S',{state:'unknown',error_code:'channel-lost',result_json:null}),task('I','S',{state:'interrupted',error_code:'preview-restarted-no-replay',result_json:null,cli_session_id:null,operation_id:null})];
  const instance=fixture({tasks:rows,backends:[]});let tree=await instance.ready();assert.match(content(tree),/No backend configured/);assert.match(content(tree),/interrupted/);assert.match(content(tree),/No final protocol result recorded/);
  for(const [id,state,result] of [['R','refused','refusal'],['U','unknown','No final protocol result recorded']]) {nodes(tree,n=>n.type==='button'&&n.props?.key===id)[0].props.onClick();instance.render();await settle();tree=instance.render();assert.match(content(tree),new RegExp(state));assert.match(content(tree),new RegExp(result));}
  instance.host.unmount();
});

test('late fetch cannot show another selected task/session; hidden and unmount clean timers',async()=>{
  const late=deferred(),a=task(),b=task('B'),instance=fixture({tasks:[a,b]});let tree=await instance.ready();
   instance.setResponse(call=>call.method==='acp.events'&&call.payload.task_id==='A'?late.promise:call.method==='acp.tasks'?[a,b]:call.method==='acp.controls'?[]:call.method==='session.get'?{session_id:'S',principal_id:'principal',binding_id:'binding-S',version:2}:call.method==='binding.get'?binding():{backends:[]});
  nodes(tree,n=>n.type==='button'&&n.props?.key==='A')[0].props.onClick();instance.render();await settle();
  nodes(instance.render(),n=>n.type==='button'&&n.props?.key==='B')[0].props.onClick();instance.render();await settle();tree=instance.render();
  late.resolve([event(1,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'STALE-A'}})]);await settle();assert.doesNotMatch(content(instance.render()),/STALE-A/);
  instance.props.scope={sessionId:'other'};tree=instance.render();assert.doesNotMatch(content(tree),/Original prompt B/);await settle();instance.render();
  instance.props.visible=false;assert.equal(instance.render(),null);assert.equal(instance.timers.size,0);instance.host.unmount();assert.equal(instance.timers.size,0);
});

test('same-session A→B→A and hidden in-flight responses never replace the latest journal',async()=>{
  const old=deferred(),fresh=deferred(),a=task(),b=task('B');let reads=0;
  const instance=fixture({tasks:[a,b]});let tree=await instance.ready();
   instance.setResponse(call=>call.method==='acp.events'&&call.payload.task_id==='A'?(++reads===1?old.promise:fresh.promise):call.method==='acp.events'?[]:call.method==='acp.tasks'?[a,b]:call.method==='acp.controls'?[]:call.method==='session.get'?{session_id:'S',principal_id:'principal',binding_id:'binding-S',version:2}:call.method==='binding.get'?binding():{backends:[]});
  for(const id of ['A','B','A']) {nodes(tree,n=>n.type==='button'&&n.props?.key===id)[0].props.onClick();tree=instance.render();await settle();tree=instance.render();}
  old.resolve([event(1,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OLD'}})]);await settle();assert.doesNotMatch(content(instance.render()),/OLD/);
  fresh.resolve([event(1,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'FRESH'}})]);await settle();assert.match(content(instance.render()),/FRESH/);
   const hidden=deferred();instance.setResponse(call=>call.method==='acp.events'?hidden.promise:call.method==='acp.tasks'?[a,b]:call.method==='acp.controls'?[]:call.method==='session.get'?{session_id:'S',principal_id:'principal',binding_id:'binding-S',version:2}:call.method==='binding.get'?binding():{backends:[]});
  await instance.tick();instance.props.visible=false;assert.equal(instance.render(),null);hidden.resolve([event(2,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'HIDDEN'}})]);await settle();assert.equal(instance.render(),null);assert.equal(instance.timers.size,0);
   instance.setResponse(call=>call.method==='acp.events'?[]:call.method==='acp.tasks'?[a,b]:call.method==='acp.controls'?[]:call.method==='session.get'?{session_id:'S',principal_id:'principal',binding_id:'binding-S',version:2}:call.method==='binding.get'?binding():{backends:[]});
  instance.props.visible=true;instance.render();await settle();assert.doesNotMatch(content(instance.render()),/HIDDEN/);instance.host.unmount();assert.equal(instance.timers.size,0);
});

test('durable history survives optional readiness rejection and journal failure without automatic mutation',async()=>{
  const a=task(),instance=fixture({tasks:[a],controls:[control(a)]});
  instance.setResponse(call=>{
    if(['session.get','acp.describe','binding.get','acp.events'].includes(call.method))throw new Error(call.method+' unavailable');
    if(call.method==='acp.tasks')return [a];
    if(call.method==='acp.controls')return [control(a)];
  });
  let tree=await instance.ready();
  assert.match(content(tree),/Original prompt A/);assert.match(content(tree),/actual result/);
  assert.match(content(tree),/control-A/);assert.match(content(tree),/readiness|unavailable/i);
  assert.match(content(nodes(tree,n=>n.props?.['aria-label']==='ACP protocol journal')[0]),/journal.*unavailable|unavailable.*journal/i);
  assert.equal(nodes(tree,n=>n.type==='button'&&content(n)==='Start ACP task')[0]?.props.disabled,true);
  assert.equal(instance.calls.filter(call=>call.method==='acp.start').length,0);
  instance.host.unmount();
});

test('journal rejects foreign, missing, null and malformed event rows and owns selected section',async()=>{
  const a=task(),b=task('B');const instance=fixture({tasks:[a,b],events:{A:[event(1,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OWN-A'}}),event(2,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'FOREIGN-B'}},'B'),{seq:3,kind:'other',payload_json:'"MISSING"'},null,{task_id:'A',seq:0,kind:'other',payload_json:'"BAD-SEQ"'},{task_id:'A',seq:4,kind:null,payload_json:'"BAD-KIND"'}],B:[event(1,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OWN-B'}},'B')]}});
  let tree=await instance.ready();let journal=nodes(tree,n=>n.props?.['aria-label']==='ACP protocol journal')[0];
  assert.equal(journal.props['data-acp-journal'],'B');assert.match(content(journal),/OWN-B/);
  nodes(tree,n=>n.type==='button'&&n.props?.key==='A')[0].props.onClick();instance.render();await settle();tree=instance.render();journal=nodes(tree,n=>n.props?.['aria-label']==='ACP protocol journal')[0];
  assert.equal(journal.props['data-acp-journal'],'A');assert.match(content(journal),/OWN-A/);
  assert.doesNotMatch(content(journal),/FOREIGN-B|MISSING|BAD-SEQ|BAD-KIND/);
  assert.match(content(journal),/rejected.*record/i);instance.host.unmount();
});

test('task and control rows fail closed on missing and foreign identities including active pending',async()=>{
  const a=task('A','S',{state:'running'}),bad=[null,task('foreign','S',{principal_id:'elsewhere'}),task('binding','S',{binding_id:'other'}),task('version','S',{version:3}),task('missing','S',{run_id:null}),task('other-session','T')];
  const valid=control(a,{state:'pending'}),instance=fixture({tasks:[...bad,a],controls:[null,valid,control(a,{control_id:'foreign-principal',principal_id:'elsewhere',state:'pending'}),control(a,{control_id:'foreign-run',run_id:'elsewhere',state:'pending'}),control(a,{control_id:'missing-run',run_id:null,state:'pending'})]});
   instance.setResponse(call=>call.method==='acp.tasks'?[...bad,a]:call.method==='acp.controls'?[null,valid,control(a,{control_id:'foreign-principal',principal_id:'elsewhere',state:'pending'}),control(a,{control_id:'foreign-run',run_id:'elsewhere',state:'pending'}),control(a,{control_id:'missing-run',run_id:null,state:'pending'})]:call.method==='session.get'?{session_id:'S',principal_id:'principal',binding_id:'binding-S',version:2}:call.method==='binding.get'?binding():call.method==='acp.events'?[]:{backends:[]});
  const tree=await instance.ready(),history=nodes(tree,n=>n.props?.['aria-label']==='ACP task history')[0],decisions=nodes(tree,n=>n.props?.['aria-label']==='Selected ACP task controls')[0];
   assert.deepEqual(nodes(history,n=>n.type==='button').map(n=>n.props.key),['A','version','binding']);assert.doesNotMatch(content(history),/foreign|missing/);
  assert.match(content(decisions),/control-A/);assert.doesNotMatch(content(decisions),/foreign-principal|foreign-run|missing-run/);
  assert.match(content(tree),/Waiting for your decision/);instance.host.unmount();
});

test('a selected missing task never falls back to another, and optional session metadata mismatches are excluded',async()=>{
  const a=task(),b=task('B'),instance=fixture({tasks:[a,b]});let tree=await instance.ready();
  nodes(tree,n=>n.type==='button'&&n.props?.key==='A')[0].props.onClick();instance.render();await settle();
   instance.setResponse(call=>call.method==='acp.tasks'?[b]:call.method==='session.get'?{session_id:'S',principal_id:'principal',binding_id:'binding-S',version:2}:call.method==='binding.get'?binding():call.method==='acp.events'?[]:call.method==='acp.controls'?[]:{backends:[]});
  await instance.tick();tree=instance.render();assert.equal(nodes(tree,n=>n.props?.['aria-label']==='Selected ACP task details').length,0);assert.equal(nodes(tree,n=>n.props?.['data-acp-journal']).length,0);
   instance.setResponse(call=>call.method==='acp.tasks'?[a,task('wrong','S',{principal_id:'elsewhere'})]:call.method==='session.get'?{session_id:'S',principal_id:'principal',binding_id:'binding-S',version:2}:call.method==='binding.get'?binding():call.method==='acp.events'?[]:call.method==='acp.controls'?[]:{backends:[]});
  await instance.tick();tree=instance.render();assert.deepEqual(nodes(nodes(tree,n=>n.props?.['aria-label']==='ACP task history')[0],n=>n.type==='button').map(n=>n.props.key),['A']);instance.host.unmount();
});

test('A→B→A stale start cannot select, overwrite or unlock newer action; readiness gates callback',async()=>{
  const old=deferred(),fresh=deferred(),a=task(),b=task('B'),instance=fixture({tasks:[a,b]});let tree=await instance.ready();
   const response=call=>call.method==='acp.start'?(instance.calls.filter(row=>row.method==='acp.start').length===1?old.promise:fresh.promise):call.method==='session.get'?{session_id:call.payload.session_id,principal_id:'principal',binding_id:'binding-'+call.payload.session_id,version:2}:call.method==='binding.get'?binding(call.payload.binding_id.slice('binding-'.length)):call.method==='acp.tasks'?[a,b]:call.method==='acp.controls'?[]:call.method==='acp.events'?[]:{backends:[{id:'backend',name:'Backend',version:'v3',configured:true}]};
  instance.setResponse(response);
  const prompt=nodes(tree,n=>n.type==='textarea')[0];prompt.props.onChange({target:{value:'new prompt'}});tree=instance.render();
  let start=nodes(tree,n=>n.type==='button'&&content(n)==='Start ACP task')[0];start.props.onClick();start.props.onClick();assert.equal(instance.calls.filter(row=>row.method==='acp.start').length,1);
  instance.props.scope={sessionId:'T'};instance.renderOnly();instance.commit();await settle();instance.render();
  instance.props.scope={sessionId:'S'};instance.renderOnly();instance.commit();await settle();tree=instance.render();
  nodes(tree,n=>n.type==='textarea')[0].props.onChange({target:{value:'second prompt'}});tree=instance.render();start=nodes(tree,n=>n.type==='button'&&content(n)==='Start ACP task')[0];start.props.onClick();assert.equal(instance.calls.filter(row=>row.method==='acp.start').length,2);
  old.resolve(task('OLD'));await settle();tree=instance.render();assert.doesNotMatch(content(tree),/Original prompt OLD|selected.*OLD/i);
  assert.equal(nodes(tree,n=>n.type==='button'&&content(n)==='Start ACP task')[0].props.disabled,true);
  fresh.resolve(task('NEW'));await settle();tree=instance.render();assert.match(content(tree),/NEW/);instance.host.unmount();
  const unavailable=fixture({tasks:[a]});unavailable.setResponse(call=>call.method==='binding.get'?Promise.reject(new Error('offline')):response(call));tree=await unavailable.ready();nodes(tree,n=>n.type==='textarea')[0].props.onChange({target:{value:'attempt'}});tree=unavailable.render();nodes(tree,n=>n.type==='button'&&content(n)==='Start ACP task')[0].props.onClick();assert.equal(unavailable.calls.filter(row=>row.method==='acp.start').length,0);unavailable.host.unmount();
});

test('cancel is single-flight, malformed decisions warn, invalid finite timestamp cannot crash',async()=>{
  const a=task('A','S',{state:'running',deadline_ms:1e20}),waiting=deferred(),instance=fixture({tasks:[a],controls:[control(a,{payload_json:'{bad',answer_json:'{bad',deadline_ms:1e20})]});
  let tree=await instance.ready();const decisions=nodes(tree,n=>n.props?.['aria-label']==='Selected ACP task controls')[0];
  assert.match(content(decisions),/Malformed stored control request JSON/);assert.match(content(decisions),/Malformed stored control answer JSON/);
  assert.doesNotMatch(content(decisions),/Answer: rejected/);
   instance.setResponse(call=>call.method==='acp.cancel'?waiting.promise:call.method==='session.get'?{session_id:'S',principal_id:'principal',binding_id:'binding-S',version:2}:call.method==='binding.get'?binding():call.method==='acp.tasks'?[a]:call.method==='acp.controls'?[]:call.method==='acp.events'?[]:{backends:[]});
  const cancel=nodes(tree,n=>n.type==='button'&&content(n)==='Cancel ACP task')[0];cancel.props.onClick();cancel.props.onClick();assert.equal(instance.calls.filter(call=>call.method==='acp.cancel').length,1);
  instance.props.visible=false;instance.renderOnly();instance.commit();waiting.resolve(task('A','S',{state:'interrupted'}));await settle();assert.equal(instance.render(),null);assert.equal(instance.timers.size,0);instance.host.unmount();
});

test('hidden pending Start and Cancel release display lock across same-session reopen without replay',async()=>{
  for(const kind of ['start','cancel']) for(const order of ['before','after']) {
    const active=task('A','S',{state:'running'}),old=deferred(),next=deferred();
    const instance=fixture({tasks:kind==='cancel'?[active]:[]});let tree=await instance.ready();
    instance.setResponse(call=>['acp.start','acp.cancel'].includes(call.method)?(instance.calls.filter(row=>row.method===call.method).length===1?old.promise:next.promise):call.method==='session.get'?{session_id:'S',principal_id:'principal',binding_id:'binding-S',version:2}:call.method==='binding.get'?binding():call.method==='acp.tasks'?kind==='cancel'?[active]:[]:call.method==='acp.controls'||call.method==='acp.events'?[]:{backends:[{id:'backend',name:'Backend',version:'v3',configured:true}]});
    if(kind==='start') {nodes(tree,n=>n.type==='textarea')[0].props.onChange({target:{value:'explicit'}});tree=instance.render();}
    const label=kind==='start'?'Start ACP task':'Cancel ACP task',method=kind==='start'?'acp.start':'acp.cancel';
    nodes(tree,n=>n.type==='button'&&content(n)===label)[0].props.onClick();
    instance.props.visible=false;assert.equal(instance.renderOnly(),null);instance.commit();
    if(order==='before') {old.resolve(task('OLD'));await settle();}
    instance.props.visible=true;tree=instance.renderOnly();
    if(order==='after') {old.resolve(task('OLD'));await settle();tree=instance.renderOnly();}
    assert.doesNotMatch(content(tree),/Original prompt OLD/);
    instance.commit();await settle();tree=instance.render();
    if(kind==='start') {nodes(tree,n=>n.type==='textarea')[0].props.onChange({target:{value:'again'}});tree=instance.render();}
    const button=nodes(tree,n=>n.type==='button'&&content(n)===label)[0];assert.equal(button.props.disabled,false,kind+' '+order+' locked');
    button.props.onClick();button.props.onClick();assert.equal(instance.calls.filter(call=>call.method===method).length,2);
    assert.equal(nodes(instance.render(),n=>n.type==='button'&&content(n)===label)[0].props.disabled,true);
    next.resolve(task('NEW','S',{state:kind==='cancel'?'interrupted':'running'}));await settle();instance.render();instance.host.unmount();
  }
});

test('untrusted optional session and binding identities disable Start without hiding historical tasks',async()=>{
  const old=task('OLD','S',{binding_id:'binding-original',version:1}),cases=[
    ['foreign session',{session_id:'T',principal_id:'principal',binding_id:'binding-S',version:2},binding()],
    ['missing session id',{principal_id:'principal',binding_id:'binding-S',version:2},binding()],
    ...[['binding_id','wrong'],['version',3],['principal_id','wrong'],['binding_id',undefined],['version',undefined],['principal_id',undefined]].map(([key,value])=>['binding '+key+' '+String(value),{session_id:'S',principal_id:'principal',binding_id:'binding-S',version:2},binding('S',{[key]:value})])
  ];
  for(const [name,session,returnedBinding] of cases) {
    const instance=fixture({tasks:[old]});instance.setResponse(call=>call.method==='session.get'?session:call.method==='binding.get'?returnedBinding:call.method==='acp.tasks'?[old]:call.method==='acp.controls'||call.method==='acp.events'?[]:{backends:[{id:'backend',name:'Backend',version:'v3',configured:true}]});
    let tree=await instance.ready();assert.match(content(tree),/Original prompt OLD/,name);assert.doesNotMatch(content(tree),/\/workspace/,name);
    assert.match(content(tree),/readiness unavailable/i,name);
    nodes(tree,n=>n.type==='textarea')[0].props.onChange({target:{value:'try'}});tree=instance.render();const start=nodes(tree,n=>n.type==='button'&&content(n)==='Start ACP task')[0];assert.equal(start.props.disabled,true,name);start.props.onClick();assert.equal(instance.calls.filter(call=>call.method==='acp.start').length,0,name);instance.host.unmount();
  }
});

test('active historical Cancel works without each optional readiness source or a backend list',async()=>{
  for(const unavailable of ['session.get','acp.describe','binding.get','empty backends']) {
    const active=task('ACTIVE','S',{state:'running',binding_id:'binding-original',version:1}),waiting=deferred(),instance=fixture({tasks:[active]});
    instance.setResponse(call=>call.method===unavailable?Promise.reject(new Error('unavailable')):call.method==='session.get'?{session_id:'S',principal_id:'principal',binding_id:'binding-S',version:2}:call.method==='binding.get'?binding():call.method==='acp.describe'?{backends:unavailable==='empty backends'?[]:[{id:'backend',name:'Backend',version:'v3',configured:true}]}:call.method==='acp.tasks'?[active]:call.method==='acp.controls'||call.method==='acp.events'?[]:call.method==='acp.cancel'?waiting.promise:undefined);
    const tree=await instance.ready();assert.match(content(tree),/Original prompt ACTIVE/,unavailable);
    const cancel=nodes(tree,n=>n.type==='button'&&content(n)==='Cancel ACP task')[0];assert.ok(cancel,unavailable);cancel.props.onClick();cancel.props.onClick();
    const calls=instance.calls.filter(call=>call.method==='acp.cancel');assert.equal(calls.length,1,unavailable);assert.deepEqual(calls[0].payload,{session_id:'S',binding_id:'binding-original',version:1,task_id:'ACTIVE'});assert.equal(instance.calls.filter(call=>call.method==='acp.start').length,0);
    waiting.resolve(task('ACTIVE','S',{state:'interrupted',binding_id:'binding-original',version:1}));await settle();instance.render();instance.host.unmount();
  }
});

test('successful Start invalidates older selected poll before passive effect commits',async()=>{
  const late=deferred(),started=deferred(),a=task('A'),newTask=task('NEW','S',{state:'starting',cli_session_id:null}),instance=fixture({tasks:[a]});let tree=await instance.ready(),serverTasks=[a];
  instance.setResponse(call=>call.method==='acp.events'&&call.payload.task_id==='A'?late.promise:call.method==='acp.start'?started.promise:call.method==='acp.tasks'?serverTasks:call.method==='session.get'?{session_id:'S',principal_id:'principal',binding_id:'binding-S',version:2}:call.method==='binding.get'?binding():call.method==='acp.controls'||call.method==='acp.events'?[]:{backends:[{id:'backend',name:'Backend',version:'v3',configured:true}]});
  await instance.tick();nodes(tree,n=>n.type==='textarea')[0].props.onChange({target:{value:'new task'}});tree=instance.render();nodes(tree,n=>n.type==='button'&&content(n)==='Start ACP task')[0].props.onClick();
  serverTasks=[a,newTask];started.resolve(newTask);await settle();tree=instance.renderOnly();assert.equal(nodes(tree,n=>n.props?.['data-acp-journal'])[0]?.props['data-acp-journal'],'NEW');
  late.resolve([event(1,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'STALE-A'}})]);await settle();tree=instance.renderOnly();
  assert.equal(nodes(tree,n=>n.props?.['data-acp-journal'])[0]?.props['data-acp-journal'],'NEW');assert.deepEqual(nodes(nodes(tree,n=>n.props?.['aria-label']==='ACP task history')[0],n=>n.type==='button').map(n=>n.props.key),['NEW','A']);assert.doesNotMatch(content(tree),/STALE-A/);
  instance.commit();await settle();instance.render();assert.ok(instance.calls.some(call=>call.method==='acp.events'&&call.payload.task_id==='NEW'));instance.host.unmount();
});

test('Cancel of explicitly selected active task invalidates old poll and rearms journal timer',async()=>{
  const running=task('A','S',{state:'running'}),interrupted=task('A','S',{state:'interrupted'}),old=deferred(),cancelled=deferred();
  let serverTasks=[running],deferOld=false;
  const instance=fixture({tasks:serverTasks,events:{A:[event(1,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'INITIAL'}})]}});
  let tree=await instance.ready();
  nodes(tree,n=>n.type==='button'&&n.props?.key==='A')[0].props.onClick();instance.render();await settle();tree=instance.render();
  assert.match(content(nodes(tree,n=>n.props?.['aria-label']==='ACP protocol journal')[0]),/INITIAL/);
  instance.setResponse(call=>call.method==='acp.events'?(deferOld?old.promise:[event(2,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'FRESH'}})]):call.method==='acp.cancel'?cancelled.promise:call.method==='acp.tasks'?serverTasks:call.method==='session.get'?{session_id:'S',principal_id:'principal',binding_id:'binding-S',version:2}:call.method==='binding.get'?binding():call.method==='acp.controls'?[]:{backends:[{id:'backend',name:'Backend',version:'v3',configured:true}]});
  deferOld=true;await instance.tick();assert.equal(instance.timers.size,0);
  nodes(instance.render(),n=>n.type==='button'&&content(n)==='Cancel ACP task')[0].props.onClick();
  serverTasks=[interrupted];cancelled.resolve(interrupted);await settle();tree=instance.renderOnly();
  assert.match(content(tree),/Selected task · interrupted/);
  old.resolve([event(3,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'STALE-RUNNING'}})]);await settle();tree=instance.renderOnly();
  assert.match(content(tree),/Selected task · interrupted/);assert.doesNotMatch(content(tree),/STALE-RUNNING|INITIAL/);
  deferOld=false;const before=instance.calls.filter(call=>call.method==='acp.events').length;
  instance.commit();await settle();tree=instance.render();
  assert.ok(instance.calls.filter(call=>call.method==='acp.events').length>before,'new effect must fetch journal after same-task Cancel');
  assert.match(content(nodes(tree,n=>n.props?.['aria-label']==='ACP protocol journal')[0]),/FRESH/);
  assert.equal(instance.timers.size,1,'new effect must schedule its own timer');
  const after=instance.calls.filter(call=>call.method==='acp.events').length;
  await instance.tick();tree=instance.render();
  assert.ok(instance.calls.filter(call=>call.method==='acp.events').length>after,'new scheduled timer must continue journal reads');
  assert.equal(instance.timers.size,1);
  const calls=instance.calls.length;
  nodes(tree,n=>n.type==='button'&&n.props?.key==='A')[0].props.onClick();tree=instance.render();await settle();tree=instance.render();
  assert.equal(instance.calls.length,calls,'clicking already-selected A must not trigger a read or mutation');
  assert.match(content(nodes(tree,n=>n.props?.['aria-label']==='ACP protocol journal')[0]),/FRESH/);
  assert.equal(instance.timers.size,1);instance.host.unmount();assert.equal(instance.timers.size,0);
});

test('serialized panel projects into both hash-locked public clients without running application',async()=>{
  const lock=JSON.parse(await readFile(new URL('../../profiles/agent-studio-preview/sources.lock.json',import.meta.url)));
  const root='/home/ubuntu/.dsh/profiles/web/node_modules/dsh-better-sidebar';
  for(const file of ['lib/client.js','lib/client-registry.js']) {
    const bytes=await readFile(join(root,file));assert.equal(createHash('sha256').update(bytes).digest('hex'),lock.sidebar.files[file]);
    const projected=projectSidebar(file,bytes).toString();assert.ok(projected.includes('function AcpPanel('));
    const check=spawnSync(process.execPath,['--check','--input-type=module'],{input:projected,encoding:'utf8'});assert.equal(check.status,0,check.stderr);
  }
});
