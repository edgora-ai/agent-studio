import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {StudioError} from '../../packages/dsh-agent-studio/store.mjs';
import {spawnBrokerChild,brokerChildBoundary,boundedBytes,requireBrokerClose} from '../../packages/dsh-agent-studio/adapters/child-boundary.mjs';
import {EnvironmentBroker} from '../../packages/dsh-agent-studio/adapters/environment-broker.mjs';
import {checkCurrent,observeTask,openChannel,closeChannel,HELPER_SHA} from '../../packages/dsh-agent-studio/adapters/helper-channel.mjs';

// OFFLINE ONLY: fake broker handles plus two short-lived, self-spawned Node
// fixtures. No fence/preview, existing process adoption, DB, remote or model.
const repo=fileURLToPath(new URL('../../',import.meta.url));
const modulePath=join(repo,'artifacts/m1/t103/fixture-9teakpr5/runtime/node_modules/dsh-ssh-remote/lib');
const root=await mkdtemp(join(tmpdir(),'agent-studio-test-child-boundary-'));
const lock={};for(const name of ['helper/installer.js','helper/rpc-client.js','helper/framing.js','helper/protocol.js','ssh-command.js']) {
 const path=join(modulePath,name);lock[path]=createHash('sha256').update(await readFile(path)).digest('hex');
}
await writeFile(join(root,'helper-sources.json'),JSON.stringify(lock));
const installed=await import(pathToFileURL(join(modulePath,'helper/installer.js')));
const fast={termGraceMs:5,killWaitMs:7},binding={binding_id:'fixture-binding',version:1,instance_generation:'fixture-generation'};
const immediate=()=>new Promise(resolve=>setImmediate(resolve));
const flush=async()=>{for(let i=0;i<8;i++) await Promise.resolve();};
const proof=(changes={})=>({dispatch:true,binding_id:binding.binding_id,version:binding.version,generation:binding.instance_generation,channel_id:'fixture-channel',agent_id:'fixture-agent',...changes});
const line=value=>Buffer.from(JSON.stringify(value)+'\n');
const hello={dshRpc:'1',method:'server/hello',params:{protocol:{min:1,max:1},helperVersion:'0.13.1',serverInstanceId:'fixture-helper',serverEpoch:'fixture-epoch',platform:{system:'fixture',release:'fixture',machine:'fixture',python:'fixture'},capabilities:{session:{resume:true}},limits:{}}};
const initialListeners=new WeakMap();
function remember(child) {
 for(const emitter of [child,...new Set(child.stdio)]) initialListeners.set(emitter,new Map(emitter.eventNames().map(event=>[event,new Set(emitter.rawListeners(event))])));
 return child;
}

class FakeChild extends EventEmitter {
 constructor({pid=654321,onSignal,onEnd,onInput}={}) {
  super();Object.assign(this,{pid,exitCode:null,signalCode:null,signals:[],input:[],frames:[],unrefs:0,onSignal,onEnd,onInput});
  this.stdin=new Writable({write:(chunk,_encoding,done)=>{this.input.push(Buffer.from(chunk));try {this.onInput?.(chunk);} catch(error) {done(error);return;}done();},final:done=>{this.onEnd?.();done();}});
  this.stdout=new PassThrough();this.stderr=new PassThrough();this.stdio=[this.stdin,this.stdout,this.stderr,new PassThrough()];remember(this);
 }
 kill(signal) {this.signals.push(signal);return this.onSignal?.(signal)??true;}
 unref() {this.unrefs++;}
 exit(code=0,signal=null) {this.exitCode=code;this.signalCode=signal;this.emit('exit',code,signal);}
 close(code=0,signal=null) {this.exit(code,signal);for(const pipe of this.stdio) pipe.destroy();this.emit('close',code,signal);}
}
function timers(t,{virtual=true}={}) {
 if(virtual) t.mock.timers.enable({apis:['setTimeout']});
 const schedule=globalThis.setTimeout,cancel=globalThis.clearTimeout,active=new Set();
 t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{let timer;timer=schedule(()=>{active.delete(timer);fn(...args);},ms);active.add(timer);return timer;});
 t.mock.method(globalThis,'clearTimeout',timer=>{active.delete(timer);return cancel(timer);});
 return {active,async tick(ms) {t.mock.timers.tick(ms);await flush();}};
}
function capability(t,key,launch) {
 const symbol=Symbol.for(key),previous=Object.getOwnPropertyDescriptor(globalThis,symbol);
 assert(!previous||previous.configurable,'tests must not run inside the preview fence');
 Object.defineProperty(globalThis,symbol,{value:launch,configurable:true});
 t.after(()=>{if(previous) Object.defineProperty(globalThis,symbol,previous);else delete globalThis[symbol];});
}
function repoEnv(t) {
 const previous=process.env.AGENT_STUDIO_REPO;process.env.AGENT_STUDIO_REPO=repo;
 t.after(()=>{if(previous===undefined) delete process.env.AGENT_STUDIO_REPO;else process.env.AGENT_STUDIO_REPO=previous;});
}
async function clean(child,clock) {
 await immediate();assert.equal(clock.active.size,0,'all operation/TERM/KILL/RPC timers cleared');
 let guard;
 for(const emitter of [child,...new Set(child.stdio)]) {
  const baseline=initialListeners.get(emitter);
  const added=event=>emitter.rawListeners(event).filter(listener=>!baseline?.get(event)?.has(listener));
  for(const event of ['data','exit','spawn','close','end']) assert.equal(added(event).length,0,`no boundary/RPC ${event} listener; preserve Node's own listeners`);
  const errors=added('error');assert.equal(errors.length,1,'exactly one shared terminal error guard');
  guard??=errors[0];assert.strictEqual(errors[0],guard,'guard is shared and has no per-child closure');
  assert.doesNotThrow(()=>emitter.emit('error',new Error('late synthetic error')));
 }
 for(const pipe of child.stdio) assert.equal(pipe.destroyed,true);
}
function own(child,timing=fast) {return spawnBrokerChild(()=>child,[],timing);}
function respond(child,{sendHello=true,sendProof=true,proofChanges={},reply=true}={}) {
 let buffer='';child.onInput=chunk=>{
  buffer+=chunk.toString();let end;
  while((end=buffer.indexOf('\n'))>=0) {
   const frame=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);child.frames.push(frame);
   assert.equal(frame.method,'initialize','fixture forbids business start/cancel/release/replay');
   if(reply) child.stdout.write(line({dshRpc:'1',id:frame.id,result:{protocol:1,session:{sessionId:'fixture-session',clientId:frame.params.clientId,resumeToken:'fixture-only-token',resumed:Boolean(frame.params.resumeToken),retentionMs:30000,serverEpoch:'fixture-epoch'},capabilities:{session:{resume:true}},limits:{}}}));
  }
 };
 queueMicrotask(()=>{if(sendProof) child.stdio[3].write(line(proof(proofChanges)));if(sendHello) child.stdout.write(line(hello));});
 return child;
}
function helperLaunch(t,launch) {
 repoEnv(t);let spawned;const ready=new Promise(resolve=>{spawned=resolve;});
 capability(t,'agent-studio.broker-spawn',(...args)=>{const child=launch(...args);spawned(child);return child;});
 return ready;
}
async function openFixture(t,clock,options={}) {
 const child=respond(new FakeChild(),options);
 const ready=helperLaunch(t,mode=>{assert.equal(mode,'connect');return child;});
 const pending=openChannel(root,binding,{install:false,timeoutMs:40,childBoundary:fast});
 await ready;await flush();await immediate();return {child,pending};
}

 test('byte collector freezes on overflow, handles split UTF-8, and bounds stderr tail',()=>{
 const bytes=boundedBytes(6),utf8=Buffer.from('中文');assert(bytes.push(utf8.subarray(0,2)));assert(bytes.push(utf8.subarray(2)));
 assert.equal(bytes.text(),'中文');assert.equal(bytes.bytes,6);assert.equal(bytes.push(Buffer.alloc(1000000)),false);
 for(let i=0;i<100;i++) assert.equal(bytes.push(Buffer.from('x')),false);
 assert.equal(bytes.bytes,6);assert.equal(bytes.text(),'中文');
 const tail=boundedBytes(4,{tail:true});tail.push(Buffer.from('abcdef'));tail.push(Buffer.from('xy'));assert.equal(tail.text(),'efxy');assert.equal(tail.bytes,4);
 });

test('operation timeout starts finite 15s TERM + 1s final budget, not end-to-end timeout',async t=>{
 const clock=timers(t),child=new FakeChild(),boundary=own(child,{});let closes=0;
 child.once('close',()=>closes++);boundary.deadline(80000,'fixture-timeout');
 await clock.tick(79999);assert.deepEqual(child.signals,[]);await clock.tick(1);assert.deepEqual(child.signals,['SIGTERM']);
 await clock.tick(14999);assert.equal(boundary.finished,false);await clock.tick(1);assert.deepEqual(child.signals,['SIGTERM','SIGKILL']);
 await clock.tick(999);assert.equal(boundary.finished,false);await clock.tick(1);
 const result=await boundary.settled;assert.equal(result.closeObserved,false);assert.equal(closes,0,'never synthesize close');
 assert.throws(()=>requireBrokerClose(result),error=>error.code==='broker-close-unconfirmed'&&error.uncertain&&error.cause.code==='fixture-timeout');
 child.removeAllListeners('close');assert.equal(child.unrefs,1);await clean(child,clock);
});

test('stop is idempotent, preserves first failure, and clears timers on confirmed TERM close',async t=>{
 const clock=timers(t),child=new FakeChild();child.onSignal=signal=>child.close(null,signal);
 const boundary=own(child);boundary.deadline(100,'later-timeout');let finished=0;boundary.onSettled(()=>finished++);
 const first=boundary.stop(new StudioError('first-failure')),second=boundary.stop(new StudioError('second-failure'));
 assert.strictEqual(first,second);const result=await first;assert.equal(result.closeObserved,true);assert.equal(result.failure.code,'first-failure');
 boundary.deadline(100,'late-deadline');boundary.listen(child.stdout,'data',()=>assert.fail('late data listener'));await clock.tick(1000);
 child.emit('close',0,null);assert.equal(finished,1);assert.deepEqual(child.signals,['SIGTERM']);await clean(child,clock);
});

for(const behavior of ['false','throws','exited','no-pid','self-pid','changed-pid']) test(`no unbounded wait or unsafe signal: ${behavior}`,async t=>{
 const clock=timers(t),child=new FakeChild(),boundary=own(child);child.onSignal=()=>{if(behavior==='throws') throw new Error('kill failed');return false;};
 if(behavior==='exited') child.exit(0);if(behavior==='no-pid') child.pid=undefined;if(behavior==='self-pid') child.pid=process.pid;if(behavior==='changed-pid') child.pid++;
 const pending=boundary.stop(new StudioError('fixture-failure'));await clock.tick(5);await clock.tick(7);const result=await pending;
 assert.equal(result.closeObserved,false);assert.deepEqual(child.signals,['false','throws'].includes(behavior)?['SIGTERM','SIGKILL']:[]);
 assert.throws(()=>requireBrokerClose(result),{code:'broker-close-unconfirmed'});await clean(child,clock);
});

test('synchronous spawn throw and asynchronous child error use bounded, sanitized failures',async t=>{
 const clock=timers(t);assert.throws(()=>spawnBrokerChild(()=>{throw new Error('PRIVATE');},[]),error=>error.code==='broker-start-failed'&&!error.message.includes('PRIVATE'));
 const child=new FakeChild({pid:undefined});child.pid=undefined;const boundary=own(child);child.emit('error',new Error('PRIVATE'));
 await clock.tick(5);await clock.tick(7);const result=await boundary.settled;assert.equal(result.failure.code,'broker-start-failed');assert.deepEqual(child.signals,[]);await clean(child,clock);
});

test('exit after TERM without pipe close prohibits KILL but remains uncertain',async t=>{
 const clock=timers(t),child=new FakeChild();child.onSignal=signal=>child.exit(null,signal);const boundary=own(child);
 const pending=boundary.stop(new StudioError('fixture-timeout'));await clock.tick(5);await clock.tick(7);
 const result=await pending;assert.equal(result.closeObserved,false);assert.equal(result.signal,'SIGTERM');assert.deepEqual(child.signals,['SIGTERM']);
 assert.throws(()=>requireBrokerClose(result),error=>error.code==='broker-close-unconfirmed'&&error.uncertain);await clean(child,clock);
});

test('initially absent pid can be confirmed by this child spawn event; killed does not imply exit',async t=>{
 const clock=timers(t),child=new FakeChild();child.pid=undefined;const boundary=own(child);
 child.pid=654322;child.emit('spawn');child.killed=true;const pending=boundary.stop();await clock.tick(5);await clock.tick(7);
 assert.equal((await pending).closeObserved,false);assert.deepEqual(child.signals,['SIGTERM','SIGKILL']);await clean(child,clock);
});

test('zero kill wait still attempts TERM then KILL before final unknown, even with EOF grace',async t=>{
 const clock=timers(t);
 for(const graceMs of [0,2]) {
  const child=new FakeChild(),boundary=own(child,{termGraceMs:0,killWaitMs:0});
  assert.throws(()=>own(child),{code:'broker-child-already-owned'});const pending=boundary.stop(undefined,{graceMs});await clock.tick(graceMs);
  assert.equal((await pending).closeObserved,false);assert.deepEqual(child.signals,['SIGTERM','SIGKILL']);await clean(child,clock);
 }
});

test('cleanup preserves pre-existing listeners and late observer throws are isolated',async t=>{
 const clock=timers(t),child=new FakeChild();let data=0,errors=0;
 const externalData=()=>data++,externalError=()=>errors++;
 child.stdout.on('data',externalData);child.stdout.on('error',externalError);remember(child);
 const boundary=own(child);boundary.listen(child.stdout,'data',()=>{});boundary.deadline(100,'fixture-timeout');
 child.stdout.write('fixture');child.close();await boundary.settled;
 assert(child.stdout.listeners('data').includes(externalData));assert(child.stdout.listeners('error').includes(externalError));assert.equal(data,1);
 assert.doesNotThrow(()=>boundary.onSettled(()=>{throw new Error('late observer');}));await clean(child,clock);assert.equal(errors,1);
});

test('real self-spawned ChildProcess preserves stdio and normal exit cleans resources',async t=>{
 const clock=timers(t,{virtual:false});let child,output='';
 const boundary=spawnBrokerChild(()=>{child=spawn(process.execPath,['-e','process.stdout.write(JSON.stringify({ok:true,text:"中文"}))'],{stdio:['pipe','pipe','pipe']});return remember(child);},[],fast);
 boundary.deadline(2000,'fixture-timeout');boundary.listen(child.stdout,'data',data=>{output+=data;});child.stdin.end();
 const result=requireBrokerClose(await boundary.settled);assert.equal(result.code,0);assert.deepEqual(JSON.parse(output),{ok:true,text:'中文'});await clean(child,clock);
});

test('real self-spawned TERM-resistant child confirms KILL close, not remote task cancellation',async t=>{
 const clock=timers(t,{virtual:false});let child;const signals=[];
 const boundary=spawnBrokerChild(()=>{child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)'],{stdio:['pipe','pipe','pipe']});const kill=child.kill.bind(child);child.kill=signal=>{signals.push(signal);return kill(signal);};return remember(child);},[],{termGraceMs:20,killWaitMs:1000});
 boundary.deadline(3000,'fixture-watchdog');await new Promise(resolve=>boundary.listen(child.stdout,'data',resolve));child.stdin.end();
 const pending=boundary.stop();const result=requireBrokerClose(await pending);assert.equal(result.signal,'SIGKILL');assert.deepEqual(signals,['SIGTERM','SIGKILL']);assert.equal(result.closeObserved,true);await clean(child,clock);
});

test('EnvironmentBroker accepts normal byte-exact JSON and forwards only fixed mode/request',async t=>{
 const clock=timers(t),child=new FakeChild(),calls=[];capability(t,'agent-studio.environment-broker',(...args)=>{calls.push(args);return child;});
 const pending=new EnvironmentBroker({timeoutMs:40,...fast}).submit('fixture-request');const bytes=line({ok:true,text:'中文'});
 child.stdout.write(bytes.subarray(0,bytes.length-4));child.stdout.write(bytes.subarray(bytes.length-4));child.close();
 assert.deepEqual(await pending,{ok:true,text:'中文'});assert.deepEqual(calls,[['environment-submit','fixture-request']]);assert.deepEqual(child.signals,[]);await clean(child,clock);
});

test('EnvironmentBroker timeout has confirmed local TERM error but never a submitted result',async t=>{
 const clock=timers(t),child=new FakeChild();child.onSignal=signal=>child.close(null,signal);capability(t,'agent-studio.environment-broker',()=>child);
 const rejected=assert.rejects(new EnvironmentBroker({timeoutMs:10,...fast}).submit('fixture-once'),{code:'environment-broker-timeout'});
 await clock.tick(10);await rejected;assert.deepEqual(child.signals,['SIGTERM']);await clean(child,clock);
});

for(const [configured,budget,deadline] of [[80,7,7],[5,40,5]]) test(`EnvironmentBroker poll budget ${budget} is capped at ${deadline}, with no new spawn authority`,async t=>{
 const clock=timers(t),child=new FakeChild(),calls=[];child.onSignal=signal=>child.close(null,signal);
 capability(t,'agent-studio.environment-broker',(...args)=>{calls.push(args);return child;});
 const rejected=assert.rejects(new EnvironmentBroker({timeoutMs:configured,...fast}).poll('fixture-poll-budget',{timeoutMs:budget}),{code:'environment-broker-timeout'});
 await clock.tick(deadline-1);assert.deepEqual(child.signals,[]);await clock.tick(1);await rejected;
 assert.deepEqual(calls,[['environment-poll','fixture-poll-budget']]);assert.deepEqual(child.signals,['SIGTERM']);await clean(child,clock);
});

test('EnvironmentBroker rejects malformed remaining budgets before spawning',async t=>{
 let calls=0;capability(t,'agent-studio.environment-broker',()=>{calls++;throw new Error('must not spawn');});
 const broker=new EnvironmentBroker();for(const timeoutMs of [0,-1,NaN,Infinity,1.5,'10',2147483648]) await assert.rejects(broker.poll('fixture-denied',{timeoutMs}),{code:'broker-deadline-invalid'});
 assert.equal(calls,0);
});

test('EnvironmentBroker response loss/never-close settles uncertain without submit replay',async t=>{
 const clock=timers(t),child=new FakeChild();let calls=0;capability(t,'agent-studio.environment-broker',()=>{calls++;return child;});
 const rejected=assert.rejects(new EnvironmentBroker({timeoutMs:10,...fast}).submit('fixture-once'),error=>error.code==='environment-broker-close-unconfirmed'&&error.uncertain&&error.cause.code==='environment-broker-timeout');
 await clock.tick(10);child.stdout.write(line({accepted:true}));await clock.tick(5);await clock.tick(7);await rejected;
 assert.equal(calls,1);assert.deepEqual(child.signals,['SIGTERM','SIGKILL']);await clean(child,clock);
});

test('EnvironmentBroker oversized stdout is counted before decoding and stops permanently',async t=>{
 const clock=timers(t),child=new FakeChild();capability(t,'agent-studio.environment-broker',()=>child);
 const rejected=assert.rejects(new EnvironmentBroker({timeoutMs:100,...fast}).discover(),{code:'environment-broker-output-limit'});
 const huge=Buffer.alloc(1048577,65);huge.toString=()=>assert.fail('oversized output must not be decoded');child.stdout.emit('data',huge);
 for(let i=0;i<100;i++) child.stdout.emit('data',huge);assert.deepEqual(child.signals,['SIGTERM']);
 child.close(null,'SIGTERM');await rejected;await clean(child,clock);
});

for(const [stderr,code] of [['{"error":"D07_FIXTURE_DENIED"}','D07_FIXTURE_DENIED'],['{"error":"PRIVATE payload!"}','environment-broker-failed'],['x'.repeat(100000),'environment-broker-failed']]) test(`EnvironmentBroker bounded stderr exposes only safe code ${code}`,async t=>{
 const clock=timers(t),child=new FakeChild();capability(t,'agent-studio.environment-broker',()=>child);
 const rejected=assert.rejects(new EnvironmentBroker({timeoutMs:100,...fast}).discover(),error=>error.code===code&&error.message===code);
 child.stderr.write(Buffer.from(stderr));child.close(1);await rejected;await clean(child,clock);
});

test('brokerRead check normal exit does not require dispatch proof, observe-task does',async t=>{
 const clock=timers(t),children=[],calls=[];helperLaunch(t,(...args)=>{calls.push(args);const child=new FakeChild();children.push(child);return child;});
 const first=checkCurrent(binding,{timeoutMs:30,childBoundary:fast});children[0].stdout.write(line({generation:binding.instance_generation}));children[0].close();
 assert.deepEqual(await first,{generation:binding.instance_generation});
 const second=observeTask(binding,'fixture-operation',{timeoutMs:30,childBoundary:fast});children[1].stdio[3].write(line(proof()));children[1].stdout.write(line({generation:binding.instance_generation,operation_id:'fixture-operation'}));children[1].close();
 assert.equal((await second).operation_id,'fixture-operation');assert.equal(calls[1][3],'fixture-operation');for(const child of children) await clean(child,clock);
});

test('observe-task missing proof fails immediately after actual close, never hangs',async t=>{
 const clock=timers(t),child=new FakeChild();helperLaunch(t,()=>child);
 const rejected=assert.rejects(observeTask(binding,'fixture-operation',{timeoutMs:30,childBoundary:fast}),{code:'broker-closed-before-verification'});
 child.stdout.write(line({generation:binding.instance_generation}));child.close();await rejected;await clean(child,clock);
});

test('brokerRead timeout never-close returns uncertain rather than stale success',async t=>{
 const clock=timers(t),child=new FakeChild();helperLaunch(t,()=>child);
 const rejected=assert.rejects(checkCurrent(binding,{timeoutMs:10,childBoundary:fast}),error=>error.code==='broker-close-unconfirmed'&&error.uncertain);
 await clock.tick(10);await clock.tick(5);await clock.tick(7);await rejected;await clean(child,clock);
});

test('brokerRead UTF-8 output limit uses bytes, not characters',async t=>{
 const clock=timers(t),child=new FakeChild();helperLaunch(t,()=>child);
 const rejected=assert.rejects(checkCurrent(binding,{timeoutMs:100,childBoundary:fast}),{code:'broker-output-limit'});
 child.stdout.write(Buffer.from('中'.repeat(22000)));child.close(null,'SIGTERM');await rejected;assert.deepEqual(child.signals,['SIGTERM']);await clean(child,clock);
});

for(const [data,code] of [[line(proof({generation:'foreign'})),'channel-identity-mismatch'],[Buffer.from('{not JSON}\n'),'broker-proof-invalid'],[Buffer.alloc(8193,65),'broker-proof-too-large']]) test(`proof rejection bounded and fail-closed: ${code}`,async t=>{
 const clock=timers(t),child=new FakeChild();child.onSignal=signal=>child.close(null,signal);helperLaunch(t,()=>child);
 const rejected=assert.rejects(observeTask(binding,'fixture-operation',{timeoutMs:100,childBoundary:fast}),{code});
 child.stdio[3].write(data);await rejected;assert.deepEqual(child.signals,['SIGTERM']);await clean(child,clock);
});

test('fixed install uploads exact bundled hash-checked Buffer and then initializes real installed RPC',async t=>{
 const clock=timers(t),children=[],modes=[];helperLaunch(t,mode=>{
  modes.push(mode);const child=new FakeChild();children.push(child);
  if(mode==='install') child.onEnd=()=>queueMicrotask(()=>{child.stdio[3].write(line(proof()));child.close();});else respond(child);
  return child;
 });
 const channel=await openChannel(root,binding,{timeoutMs:40,childBoundary:fast});
 assert.deepEqual(modes,['install','connect']);const asset=installed.loadHelperAsset(),uploaded=Buffer.concat(children[0].input);
 assert(Buffer.isBuffer(uploaded));assert.deepEqual(uploaded,asset.content);assert.equal(createHash('sha256').update(uploaded).digest('hex'),HELPER_SHA);
 assert.equal(channel.client.options.readable,children[1].stdout);assert.equal(channel.client.options.writable,children[1].stdin);assert.equal(channel.client.sessionId,'fixture-session');
 children[1].onEnd=()=>queueMicrotask(()=>children[1].close());await closeChannel(channel,{graceMs:0});
 assert.deepEqual(children[1].frames.map(frame=>frame.method),['initialize']);for(const child of children) await clean(child,clock);
});

for(const issue of ['epipe','sync-stdin-error','child-error','missing-proof','wrong-proof','nonzero']) test(`install ${issue} never proceeds to connect or business RPC`,async t=>{
 const clock=timers(t),child=new FakeChild(),modes=[];child.onSignal=signal=>child.close(null,signal);
 helperLaunch(t,mode=>{
  modes.push(mode);assert.equal(mode,'install');
  if(issue==='sync-stdin-error') child.stdin.end=()=>{throw new Error('PRIVATE upload failure');};
  else child.onEnd=()=>queueMicrotask(()=>{
   if(issue==='epipe') child.stdin.emit('error',Object.assign(new Error('PRIVATE EPIPE'),{code:'EPIPE'}));
   else if(issue==='child-error') child.emit('error',new Error('PRIVATE spawn failure'));
   else {if(issue!=='missing-proof') child.stdio[3].write(line(proof(issue==='wrong-proof'?{version:999}:{})));if(!child.destroyed&&child.exitCode===null&&child.signalCode===null) child.close(issue==='nonzero'?78:0);}
  });
  return child;
 });
 await assert.rejects(openChannel(root,binding,{timeoutMs:40,childBoundary:fast}),error=>error.code==='helper-install-failed'&&!error.message.includes('PRIVATE'));
 assert.deepEqual(modes,['install']);assert.equal(child.frames.length,0);await clean(child,clock);
});

test('install timeout never-close is uncertain, drains stdout without accumulation, and never connects',async t=>{
 const clock=timers(t),child=new FakeChild(),modes=[];const ready=helperLaunch(t,mode=>{modes.push(mode);return child;});
 const rejected=assert.rejects(openChannel(root,binding,{timeoutMs:40,childBoundary:fast}),error=>error.code==='helper-install-failed'&&error.uncertain&&error.message.includes('broker-close-unconfirmed'));
 await ready;await flush();const chunk=Buffer.alloc(1000000);for(let i=0;i<10;i++) child.stdout.write(chunk);assert.equal(child.stdout.readableLength,0);
 await clock.tick(120000);await clock.tick(5);await clock.tick(7);await rejected;
 assert.deepEqual(modes,['install']);assert.deepEqual(child.signals,['SIGTERM','SIGKILL']);await clean(child,clock);
});

test('install EPIPE without eventual close is uncertain, finite, and never connects',async t=>{
 const clock=timers(t),child=new FakeChild(),modes=[];const ready=helperLaunch(t,mode=>{modes.push(mode);return child;});
 const rejected=assert.rejects(openChannel(root,binding,{timeoutMs:40,childBoundary:fast}),error=>error.code==='helper-install-failed'&&error.uncertain);
 await ready;child.stdin.emit('error',Object.assign(new Error('EPIPE'),{code:'EPIPE'}));await clock.tick(5);await clock.tick(7);await rejected;
 assert.deepEqual(modes,['install']);await clean(child,clock);
});

test('resume connects without install, with original client/token on the actual RPC initialize frame',async t=>{
 const clock=timers(t),child=respond(new FakeChild()),modes=[];helperLaunch(t,mode=>{modes.push(mode);return child;});
 const channel=await openChannel(root,binding,{resume:{clientId:'fixture-original-client',token:'fixture-original-token'},timeoutMs:40,childBoundary:fast});
 assert.deepEqual(modes,['connect']);assert.equal(channel.client.session.resumed,true);assert.equal(child.frames[0].params.clientId,'fixture-original-client');assert.equal(child.frames[0].params.resumeToken,'fixture-original-token');
 child.onEnd=()=>queueMicrotask(()=>child.close());await closeChannel(channel);await clean(child,clock);
});

test('initialize timeout and never-close has independent final deadline and cleans actual RPC listeners',async t=>{
 const clock=timers(t);const {child,pending}=await openFixture(t,clock,{sendHello:false});const rejected=assert.rejects(pending,error=>error.code==='broker-close-unconfirmed'&&error.uncertain);
 await clock.tick(40);await clock.tick(5);await clock.tick(7);await rejected;
 assert.deepEqual(child.signals,['SIGTERM','SIGKILL']);assert.equal(child.frames.length,0);await clean(child,clock);
});

test('initialize timeout with observed TERM close reports timeout, not successful cancellation',async t=>{
 const clock=timers(t);const {child,pending}=await openFixture(t,clock,{sendHello:false});child.onSignal=signal=>child.close(null,signal);
 const rejected=assert.rejects(pending,{code:'helper-initialize-timeout'});await clock.tick(40);await rejected;
 assert.deepEqual(child.signals,['SIGTERM']);assert.equal(child.frames.length,0);await clean(child,clock);
});

test('successful initialize still requires proof by overall deadline',async t=>{
 const clock=timers(t);const {child,pending}=await openFixture(t,clock,{sendProof:false});const rejected=assert.rejects(pending,{code:'broker-close-unconfirmed'});
 assert.deepEqual(child.frames.map(frame=>frame.method),['initialize']);await clock.tick(40);await clock.tick(5);await clock.tick(7);await rejected;await clean(child,clock);
});

test('late hello/proof after operation deadline cannot return a connected channel',async t=>{
 const clock=timers(t);const {child,pending}=await openFixture(t,clock,{sendHello:false,sendProof:false});const rejected=assert.rejects(pending,{code:'broker-close-unconfirmed'});
 await clock.tick(40);child.stdio[3].write(line(proof()));child.stdout.write(line(hello));await flush();await clock.tick(5);await clock.tick(7);await rejected;await clean(child,clock);
});

test('closeChannel graceful close is Promise-idempotent and sends no business cleanup RPC',async t=>{
 const clock=timers(t);const {child,pending}=await openFixture(t,clock);const channel=await pending;child.onEnd=()=>queueMicrotask(()=>child.close());
 const nativeClose=channel.client.close.bind(channel.client);let reentrant;
 const close=t.mock.method(channel.client,'close',reason=>{reentrant=closeChannel(channel);return nativeClose(reason);});
 const first=closeChannel(channel),second=closeChannel(channel);assert.strictEqual(first,second);assert.equal(channel.connected,false);
 const result=await first;assert.equal(result.closeObserved,true);assert.equal(result.code,0);assert.deepEqual(child.signals,[]);assert.strictEqual(reentrant,first);assert.equal(close.mock.callCount(),1);
 assert.strictEqual(closeChannel(channel),first);assert.deepEqual(child.frames.map(frame=>frame.method),['initialize']);assert.equal(channel.client.pending.size,0);await clean(child,clock);
});

for(const observed of [true,false]) test(`closeChannel TERM/KILL transport only; close observed = ${observed}`,async t=>{
 const clock=timers(t);const {child,pending}=await openFixture(t,clock);const channel=await pending;
 child.onSignal=signal=>{if(observed&&signal==='SIGKILL') child.close(null,signal);};
 const first=closeChannel(channel,{graceMs:2}),second=closeChannel(channel,{graceMs:100});assert.strictEqual(first,second);
 const result=observed?first:assert.rejects(first,error=>error.code==='transport-close-unconfirmed'&&error.uncertain);
 await flush();await clock.tick(2);await clock.tick(5);if(!observed) await clock.tick(7);
 if(observed) {assert.equal((await result).signal,'SIGKILL');assert.equal((await result).closeObserved,true);}else await result;
 assert.strictEqual(closeChannel(channel),first);assert.deepEqual(child.signals,['SIGTERM','SIGKILL']);assert.deepEqual(child.frames.map(frame=>frame.method),['initialize']);await clean(child,clock);
});

test('foreign child is not adopted or signalled and client is untouched',()=>{
 const child=new FakeChild(),channel={child,connected:true,client:{close(){assert.fail('must not touch an unowned client');}}};
 assert.equal(brokerChildBoundary(child),undefined);assert.throws(()=>closeChannel(channel),{code:'transport-child-not-owned'});assert.equal(channel.connected,true);assert.deepEqual(child.signals,[]);
 for(const pipe of child.stdio) pipe.destroy();
});

test('throwing diagnostics cannot strand proof, initialize or transport-close',async t=>{
 const clock=timers(t),child=respond(new FakeChild());helperLaunch(t,()=>child);
 const channel=await openChannel(root,binding,{install:false,timeoutMs:40,childBoundary:fast,onDiagnostic(){throw new Error('diagnostic failure');}});
 child.onEnd=()=>queueMicrotask(()=>child.close());await closeChannel(channel);await clean(child,clock);
});

test('invalid operation/termination timing is rejected before spawn',async t=>{
 let count=0;const launch=()=>{count++;return new FakeChild();};capability(t,'agent-studio.environment-broker',launch);capability(t,'agent-studio.broker-spawn',launch);
 for(const timeoutMs of [0,-1,NaN,Infinity,2147483648]) {
  await assert.rejects(new EnvironmentBroker({timeoutMs}).discover(),{code:'broker-deadline-invalid'});
  await assert.rejects(checkCurrent(binding,{timeoutMs}),{code:'broker-deadline-invalid'});
  await assert.rejects(openChannel(root,binding,{timeoutMs}),{code:'broker-deadline-invalid'});
 }
 for(const timing of [{termGraceMs:-1},{termGraceMs:2147483647,killWaitMs:1}]) assert.throws(()=>spawnBrokerChild(launch,[],timing),{code:'broker-deadline-invalid'});
 assert.equal(count,0);
});
