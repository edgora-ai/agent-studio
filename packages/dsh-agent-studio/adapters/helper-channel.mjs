import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireThat, StudioError } from '../store.mjs';
import {spawnBrokerChild,brokerChildBoundary,boundedBytes,requireBrokerClose} from './child-boundary.mjs';

export const HELPER_SHA='c853353b330d790813fdd2a2d641c9a4738c6b96f50b53c2f4aa53acec31901f';
const alias='t105.m1-a';
const candidate=()=>join(process.env.AGENT_STUDIO_REPO,'artifacts/m1/t103/fixture-9teakpr5/runtime/node_modules/dsh-ssh-remote');
export function transportCode(error) {
  if(typeof error?.code==='string' && /^[A-Za-z0-9_/-]{1,100}$/.test(error.code)) return error.code;
  if(error?.name==='RemoteHelperCallInterruptedError' && ['timeout','abort','disconnect'].includes(error.kind)) return 'helper-call-'+error.kind;
  if(error?.name==='DshRpcProtocolError') return 'helper-protocol-error';
  if(['remote helper stdout ended','remote helper stdout closed'].includes(error?.message)) return 'helper-stdout-ended';
  return 'transport-error';
}
let modules;
async function loadModules(root) {
  if (!modules) {
    const lock=JSON.parse(await readFile(join(root,'helper-sources.json'),'utf8'));
    for(const [file,hash] of Object.entries(lock)) requireThat(createHash('sha256').update(await readFile(file)).digest('hex')===hash,'helper-source-changed');
    const installer=await import(pathToFileURL(join(candidate(),'lib/helper/installer.js')));
    const rpc=await import(pathToFileURL(join(candidate(),'lib/helper/rpc-client.js')));
    requireThat(installer.loadHelperAsset().sha256===HELPER_SHA,'helper-digest-mismatch');
    modules={...installer,...rpc};
  }
  return modules;
}
const validTimeout=ms=>requireThat(Number.isSafeInteger(ms)&&ms>0&&ms<=2147483647,'broker-deadline-invalid');
const diagnostic=(fn,data)=>{try {fn?.(data);} catch(error) { /* diagnostics cannot strand a broker */ }};
function spawnBroker(mode,binding,operationId,onDiagnostic,childBoundary) {
  const spawn=globalThis[Symbol.for('agent-studio.broker-spawn')];
  requireThat(typeof spawn==='function','broker-not-enabled');
  const boundary=spawnBrokerChild(spawn,[mode,binding.binding_id,binding.version,operationId],childBoundary),{child}=boundary,started=Date.now();
  const hash=createHash('sha256');let bytes=0;
  boundary.listen(child.stderr,'data',data=>{hash.update(data);bytes+=data.length;});
  child.exited=boundary.settled;
  boundary.onSettled(result=>diagnostic(onDiagnostic,{layer:'broker',mode,started_at_ms:started,finished_at_ms:Date.now(),duration_ms:Date.now()-started,broker_pid:child.pid,exit_code:result.code,signal:result.signal,close_observed:result.closeObserved,stderr_bytes:bytes,stderr_sha256:hash.digest('hex'),...(!result.closeObserved?{error_code:'broker-close-unconfirmed'}:result.failure?{error_code:transportCode(result.failure)}:{})}));
  child.verified=new Promise((resolve,reject)=>{
    const buffer=boundedBytes(8192);let done=false,remove=()=>{};
    const fail=error=>{if(done) return;done=true;remove();reject(error);boundary.stop(error);};
    if(!child.stdio?.[3]) {fail(new StudioError('broker-proof-unavailable'));return;}
    remove=boundary.listen(child.stdio[3],'data',data=>{
      if(done) return;
      if(!buffer.push(data)) {fail(new StudioError('broker-proof-too-large'));return;}
      if(buffer.text().includes('\n')) {
        try {const proof=JSON.parse(buffer.text().trim());
          requireThat(proof.dispatch===true && proof.binding_id===binding.binding_id && proof.version===binding.version && proof.generation===binding.instance_generation,'channel-identity-mismatch');
          done=true;remove();diagnostic(onDiagnostic,{layer:'ssh',mode,stage:'same-channel-proof',channel_id:proof.channel_id,started_at_ms:started,finished_at_ms:Date.now(),duration_ms:Date.now()-started});resolve(proof);
        } catch(error) {fail(error instanceof StudioError?error:new StudioError('broker-proof-invalid'));}
      }
    });
    boundary.onSettled(result=>{if(!done) {done=true;remove();reject(result.failure??new StudioError(result.closeObserved?'broker-closed-before-verification':'broker-close-unconfirmed'));}});
  });
  child.verified.catch(error=>{child.proofError=transportCode(error);});
  return boundary;
}
async function brokerRead(mode,binding,{operationId,timeoutMs=20000,onDiagnostic,childBoundary}={}) {
  validTimeout(timeoutMs);
  const boundary=spawnBroker(mode,binding,operationId,onDiagnostic,childBoundary),{child}=boundary,output=boundedBytes(65536);
  boundary.deadline(timeoutMs,'broker-read-timeout');
  boundary.listen(child.stdout,'data',data=>{if(!boundary.stopping&&!output.push(data)) boundary.stop(new StudioError('broker-output-limit'));});
  try {child.stdin.end();} catch(error) {boundary.stop(new StudioError('broker-stdio-failed'));}
  const result=requireBrokerClose(await child.exited);
  requireThat(result.code===0,mode==='check'?'channel-current-identity-unavailable':'task-identity-probe-unavailable');
  let observed;try {observed=JSON.parse(output.text());} catch(error) {throw new StudioError('broker-response-invalid');}
  requireThat(observed.generation===binding.instance_generation,'instance-changed');
  if(mode==='observe-task') await child.verified;
  return observed;
}
export function checkCurrent(binding,options={}) {return brokerRead('check',binding,options);}
export function observeTask(binding,operationId,options={}) {return brokerRead('observe-task',binding,{...options,operationId});}
export async function openChannel(root,binding,{resume,install=true,retentionMs=30000,timeoutMs=60000,onDiagnostic,childBoundary}={}) {
  validTimeout(timeoutMs);const mod=await loadModules(root);
  if(install && !resume) {
    let boundary;
    try {
      // The fixed broker owns the install command. Only the exact hash-checked
      // asset bytes cross stdin; avoid a second uploader's timers/signals.
      const asset=mod.loadHelperAsset();
      requireThat(Buffer.isBuffer(asset.content)&&asset.content.length<=2097152&&asset.sha256===HELPER_SHA&&createHash('sha256').update(asset.content).digest('hex')===HELPER_SHA,'helper-digest-mismatch');
      boundary=spawnBroker('install',binding,undefined,onDiagnostic,childBoundary);const {child}=boundary;
      boundary.deadline(120000,'helper-install-timeout');
      boundary.listen(child.stdout,'data',()=>{});
      try {child.stdin.end(asset.content);} catch(error) {boundary.stop(new StudioError('broker-stdio-failed'));}
      requireThat(requireBrokerClose(await child.exited).code===0,'helper-install-broker-failed');
      await child.verified;
    } catch(error) {
      let uncertain=false;
      if(boundary) {const result=await boundary.stop(error);uncertain=!result.closeObserved;if(uncertain) error=new StudioError('broker-close-unconfirmed');}
      const failure=new StudioError('helper-install-failed',`Bound helper installation failed (${transportCode(error)})`);
      if(uncertain) failure.uncertain=true;throw failure;
    }
  }
  const args=mod.buildSystemSshArgs(alias,mod.buildHelperConnectCommand(HELPER_SHA));requireThat(args.at(-2)===alias,'broker-alias-mismatch');
  const boundary=spawnBroker('connect',binding,undefined,onDiagnostic,childBoundary),{child}=boundary,started=Date.now();
  const clearDeadline=boundary.deadline(timeoutMs,'helper-initialize-timeout');let client;
  try {
    client=new mod.RemoteHelperRpcClient({readable:child.stdout,writable:child.stdin,closeTransport:()=>child.stdin.end(),helloTimeoutMs:timeoutMs});
    boundary.onSettled(result=>client.transportClosed(new StudioError(result.closeObserved?'helper-transport-closed':'broker-close-unconfirmed')));
    client.onClose(()=>boundary.stop(undefined,{graceMs:1000}));
    const [_,proof]=await Promise.race([
      Promise.all([client.initialize({clientId:resume?.clientId??randomUUID(),clientName:'agent-studio-bound-preview',clientVersion:'d08',retentionMs,...(resume?{resumeToken:resume.token}:{})},{timeoutMs}),child.verified]),
      child.exited.then(result=>{requireBrokerClose(result);throw new StudioError('helper-transport-closed');}),
    ]);
    if(boundary.stopping||boundary.finished) throw boundary.failure??new StudioError('helper-transport-closed');
    requireThat(client.hello.helperVersion==='0.13.1' && client.sessionId,'helper-protocol-mismatch');
    diagnostic(onDiagnostic,{layer:'helper-rpc',stage:'initialize',channel_id:proof.channel_id,started_at_ms:started,finished_at_ms:Date.now(),duration_ms:Date.now()-started,resumed:client.session.resumed,retention_ms:client.session.retentionMs});
    return {client,child,proof,connected:true};
  } catch(error) {
    const stopped=boundary.stop(error);
    try {client?.close('initialize failed');} catch(closeError) { /* bounded stop is already armed */ }
    const result=await stopped;
    error=result.closeObserved?(result.failure??error):new StudioError('broker-close-unconfirmed');
    diagnostic(onDiagnostic,{layer:'helper-rpc',stage:'initialize',started_at_ms:started,finished_at_ms:Date.now(),duration_ms:Date.now()-started,error_code:transportCode(error)});
    const failure=new StudioError(transportCode(error));if(!result.closeObserved) failure.uncertain=true;throw failure;
  } finally {clearDeadline();}
}
const closing=new WeakMap();
// Transport-only detach. No session/workspace close, task signals or release.
// Unknown children are never adopted, and absent close never means success.
export function closeChannel(channel,{graceMs=1000}={}) {
  requireThat(Number.isSafeInteger(graceMs)&&graceMs>=0,'broker-deadline-invalid');
  const boundary=brokerChildBoundary(channel.child);requireThat(boundary,'transport-child-not-owned');
  channel.connected=false;
  if(!closing.has(channel.child)) closing.set(channel.child,Promise.resolve().then(async()=>{
    const stopped=boundary.stop(undefined,{graceMs});let closeFailed=false;
    try {channel.client.close('bound transport detached');} catch(error) {closeFailed=true;}
    const result=requireBrokerClose(await stopped,'transport-close-unconfirmed');
    requireThat(!closeFailed&&(result.code===0||result.code===78||['SIGTERM','SIGKILL'].includes(result.signal)),'transport-close-unconfirmed');
    return result;
  }));
  return closing.get(channel.child);
}
