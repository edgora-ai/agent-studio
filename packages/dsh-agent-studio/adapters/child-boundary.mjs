import {requireThat,StudioError} from '../store.mjs';

const owned=new WeakMap(),ignoreLateError=()=>{};
const duration=value=>Number.isSafeInteger(value)&&value>=0&&value<=2147483647;

// This is a lifetime boundary, not a spawn capability. Call only with the fixed,
// server-owned broker launcher. Never adopt a PID, a remote task or a daemon.
export function spawnBrokerChild(spawn,args,{termGraceMs=15000,killWaitMs=1000,startCode='broker-start-failed',ioCode='broker-stdio-failed'}={}) {
 requireThat(duration(termGraceMs)&&duration(killWaitMs)&&duration(termGraceMs+killWaitMs),'broker-deadline-invalid');
 let child;try {child=spawn(...args);} catch(error) {throw new StudioError(startCode);}
 requireThat(!owned.has(child),'broker-child-already-owned');
 const nativeKill=child.kill.bind(child),pipes=[...new Set([child.stdin,child.stdout,child.stderr,...(child.stdio??[])].filter(pipe=>pipe?.on))];
 const listeners=new Set(),timers=new Set(),observers=new Set();
 let pid=child.pid,exitSeen=false,finished=false,stopping=false,failure,result,resolve;
 const settled=new Promise(done=>{resolve=done;});
 const listen=(emitter,event,fn)=>{
  if(finished) return ()=>{};
  emitter.on(event,fn);const remove=()=>{emitter.removeListener(event,fn);listeners.delete(remove);};listeners.add(remove);return remove;
 };
 const later=(ms,fn)=>{
  if(finished) return ()=>{};
  const timer=setTimeout(()=>{timers.delete(timer);fn();},ms);timers.add(timer);
  return ()=>{clearTimeout(timer);timers.delete(timer);};
 };
 const signal=name=>{
  // killed is not exit evidence. Conversely, exit before inherited-pipe close
  // must prohibit another signal. Use only this spawn's original child handle.
  if(finished||exitSeen||child.exitCode!=null||child.signalCode!=null||!Number.isSafeInteger(pid)||pid<=1||pid===process.pid||child.pid!==pid) return;
  try {nativeKill(name);} catch(error) { /* final close deadline still applies */ }
 };
 const finish=(code,signal,closeObserved)=>{
  if(finished) return;finished=true;result={code,signal,closeObserved,failure};
  for(const timer of timers) clearTimeout(timer);timers.clear();
  for(const notify of observers) {try {notify(result);} catch(error) { /* observers cannot prevent settlement */ }}observers.clear();
  // Exactly one inert, shared sink per terminal emitter consumes already-queued
  // errors. It retains no task/transport closure and disappears with the emitter.
  for(const emitter of [child,...pipes]) emitter.on('error',ignoreLateError);
  for(const remove of [...listeners]) remove();
  // Destroy only our local pipe ends, never synthesize exit/close. An unclosed
  // broker remains unconfirmed even if KILL was sent or exitCode is populated.
  for(const pipe of pipes) if(!pipe.destroyed) pipe.destroy();
  if(!closeObserved) child.unref?.();
  resolve(result);
 };
 const stop=(error,{graceMs=0}={})=>{
  requireThat(duration(graceMs)&&duration(graceMs+termGraceMs+killWaitMs),'broker-deadline-invalid');
  if(finished) return settled;
  failure??=error;
  if(stopping) return settled;stopping=true;
  // Arm both deadlines BEFORE TERM, even when kill throws/returns false or no
  // pid/exit/close exists. KILL precedes final settlement even with zero wait.
  if(graceMs) later(graceMs,()=>signal('SIGTERM'));
  later(graceMs+termGraceMs,()=>signal('SIGKILL'));
  later(graceMs+termGraceMs+killWaitMs,()=>finish(child.exitCode??null,child.signalCode??null,false));
  if(!graceMs) signal('SIGTERM');
  return settled;
 };
 const boundary={child,settled,listen,stop,
  get stopping() {return stopping;},get finished() {return finished;},get failure() {return failure;},
  deadline(ms,code) {requireThat(duration(ms)&&ms>0,'broker-deadline-invalid');return later(ms,()=>stop(new StudioError(code)));},
  onSettled(fn) {if(finished) {try {fn(result);} catch(error) { /* same isolation for late observers */ }}else observers.add(fn);return ()=>observers.delete(fn);},
 };
 owned.set(child,boundary);
 listen(child,'spawn',()=>{pid??=child.pid;});
 listen(child,'exit',()=>{exitSeen=true;});
 listen(child,'error',()=>stop(new StudioError(startCode)));
 listen(child,'close',(code,signal)=>finish(code,signal,true));
 for(const pipe of pipes) listen(pipe,'error',()=>stop(new StudioError(ioCode)));
 return boundary;
}

export const brokerChildBoundary=child=>owned.get(child);
export function requireBrokerClose(result,code='broker-close-unconfirmed') {
 if(!result.closeObserved) {const error=new StudioError(code);error.uncertain=true;error.cause=result.failure;throw error;}
 if(result.failure) throw result.failure;
 return result;
}

// Byte-count before decoding; split UTF-8 chunks and a single oversized chunk
// cannot bypass the limit. Overflow freezes a stdout/proof collector permanently.
export function boundedBytes(limit,{tail=false}={}) {
 requireThat(Number.isSafeInteger(limit)&&limit>0,'broker-output-limit-invalid');
 const buffer=Buffer.alloc(limit);let length=0,overflow=false;
 return {
  push(data) {
   if(overflow) return false;
   const bytes=Buffer.isBuffer(data)?data:Buffer.from(data);
   if(!tail&&bytes.length>limit-length) {overflow=true;return false;}
   if(tail&&bytes.length>=limit) {bytes.copy(buffer,0,bytes.length-limit);length=limit;return true;}
   if(length+bytes.length>limit) {const discard=length+bytes.length-limit;buffer.copy(buffer,0,discard,length);length-=discard;}
   bytes.copy(buffer,length);length+=bytes.length;return true;
  },
  text:()=>buffer.toString('utf8',0,length),
  get bytes() {return length;},get overflow() {return overflow;},
 };
}
