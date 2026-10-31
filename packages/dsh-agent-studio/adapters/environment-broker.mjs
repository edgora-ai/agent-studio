import {requireThat,StudioError} from '../store.mjs';

// Only fixed server-owned modes and durable request IDs cross this boundary.
// There is no browser-provided URL, executable, credentials, argv or policy.
export class EnvironmentBroker {
 call(mode,requestId) {
  const spawn=globalThis[Symbol.for('agent-studio.environment-broker')];requireThat(typeof spawn==='function','environment-broker-disabled');
  return new Promise((resolve,reject)=>{
   const child=spawn(mode,requestId);let output='',errors='',failure;
   const stop=code=>{failure=new StudioError(code);child.kill('SIGTERM');};
   const timer=setTimeout(()=>stop('environment-broker-timeout'),80000);
   child.stdin.end();child.stdout.on('data',data=>{output+=data.toString();if(Buffer.byteLength(output)>1048576) stop('environment-broker-output-limit');});
   child.stderr.on('data',data=>{errors=(errors+data.toString()).slice(-4096);});
   child.once('error',()=>{clearTimeout(timer);reject(new StudioError('environment-broker-start-failed'));});
   child.once('close',code=>{clearTimeout(timer);if(failure) return reject(failure);if(code!==0) {
    let reason;try {reason=JSON.parse(errors).error;} catch(error) {reason='environment-broker-failed';}
    return reject(new StudioError(typeof reason==='string' && /^D07_[A-Z_]+$/.test(reason)?reason:'environment-broker-failed'));
   }try {resolve(JSON.parse(output));} catch(error) {reject(new StudioError('environment-broker-response-invalid'));}});
  });
 }
 discover() {return this.call('environment-discover');}
 submit(requestId) {return this.call('environment-submit',requestId);}
 poll(requestId) {return this.call('environment-poll',requestId);}
}
