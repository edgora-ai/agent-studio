import {requireThat,StudioError} from '../store.mjs';
import {spawnBrokerChild,boundedBytes,requireBrokerClose} from './child-boundary.mjs';

// Only fixed server-owned modes and durable request IDs cross this boundary.
// Timing overrides are server/test configuration, never browser spawn authority.
export class EnvironmentBroker {
 constructor({timeoutMs=80000,termGraceMs=15000,killWaitMs=1000}={}) {this.timing={timeoutMs,termGraceMs,killWaitMs};}
 async call(mode,requestId,{timeoutMs:budget}={}) {
  const spawn=globalThis[Symbol.for('agent-studio.environment-broker')];requireThat(typeof spawn==='function','environment-broker-disabled');
  requireThat(Number.isSafeInteger(this.timing.timeoutMs)&&this.timing.timeoutMs>0&&this.timing.timeoutMs<=2147483647,'broker-deadline-invalid');
  requireThat(budget===undefined || Number.isSafeInteger(budget)&&budget>0&&budget<=2147483647,'broker-deadline-invalid');
  const timeoutMs=Math.min(this.timing.timeoutMs,budget??this.timing.timeoutMs);
  const boundary=spawnBrokerChild(spawn,[mode,requestId],{...this.timing,timeoutMs,startCode:'environment-broker-start-failed',ioCode:'environment-broker-stdio-failed'}),{child}=boundary;
  const output=boundedBytes(1048576),errors=boundedBytes(4096,{tail:true});
  boundary.deadline(timeoutMs,'environment-broker-timeout');
  boundary.listen(child.stdout,'data',data=>{if(!boundary.stopping&&!output.push(data)) boundary.stop(new StudioError('environment-broker-output-limit'));});
  boundary.listen(child.stderr,'data',data=>errors.push(data));
  try {child.stdin.end();} catch(error) {boundary.stop(new StudioError('environment-broker-stdio-failed'));}
  // The operation timeout starts termination; final settlement has a separate
  // finite TERM/KILL budget. Signal delivery alone never confirms an outcome.
  const result=requireBrokerClose(await boundary.settled,'environment-broker-close-unconfirmed');
  if(result.code!==0) {
   let reason;try {reason=JSON.parse(errors.text()).error;} catch(error) {reason='environment-broker-failed';}
   throw new StudioError(typeof reason==='string'&&/^D07_[A-Z_]+$/.test(reason)?reason:'environment-broker-failed');
  }
  try {return JSON.parse(output.text());} catch(error) {throw new StudioError('environment-broker-response-invalid');}
 }
 discover() {return this.call('environment-discover');}
 submit(requestId) {return this.call('environment-submit',requestId);}
 poll(requestId,options) {return this.call('environment-poll',requestId,options);}
}
