import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireThat, StudioError } from '../store.mjs';

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
function spawnBroker(mode,binding,operationId,onDiagnostic=()=>{}) {
  const spawn=globalThis[Symbol.for('agent-studio.broker-spawn')];
  requireThat(typeof spawn==='function','broker-not-enabled');
  const child=spawn(mode,binding.binding_id,binding.version,operationId),started=Date.now();
  const hash=createHash('sha256');let bytes=0;
  child.stderr.on('data',data=>{hash.update(data);bytes+=data.length;});
  child.exited=new Promise(resolve=>child.once('close',(exit,signal)=>{
    onDiagnostic({layer:'broker',mode,started_at_ms:started,finished_at_ms:Date.now(),duration_ms:Date.now()-started,broker_pid:child.pid,exit_code:exit,signal,stderr_bytes:bytes,stderr_sha256:hash.digest('hex')});resolve({code:exit,signal});
  }));
  child.verified=new Promise((resolve,reject)=>{
    let buffer='',done=false;
    child.once('error',()=>reject(new StudioError('broker-start-failed')));
    child.stdio[3].on('data',data=>{
      if(done) return;buffer+=data.toString();
      if(buffer.length>8192) {done=true;reject(new StudioError('broker-proof-too-large'));child.kill('SIGTERM');return;}
      if(buffer.includes('\n')) {
        done=true;
        try {const proof=JSON.parse(buffer.trim());
          requireThat(proof.dispatch===true && proof.binding_id===binding.binding_id && proof.version===binding.version && proof.generation===binding.instance_generation,'channel-identity-mismatch');
          onDiagnostic({layer:'ssh',mode,stage:'same-channel-proof',channel_id:proof.channel_id,started_at_ms:started,finished_at_ms:Date.now(),duration_ms:Date.now()-started});resolve(proof);
        } catch(error) {reject(error instanceof StudioError?error:new StudioError('broker-proof-invalid'));}
      }
    });
    child.once('close',()=>reject(new StudioError('broker-closed-before-verification')));
  });
  child.verified.catch(error=>{child.proofError=transportCode(error);});
  return child;
}
async function brokerRead(mode,binding,{operationId,timeoutMs=20000,onDiagnostic}={}) {
  const child=spawnBroker(mode,binding,operationId,onDiagnostic);let output='',overflow=false;
  child.stdin.end();child.stdout.on('data',data=>{if(output.length+data.length>65536){overflow=true;child.kill('SIGTERM');}else output+=data.toString();});
  const timer=setTimeout(()=>child.kill('SIGTERM'),timeoutMs);
  try {const result=await child.exited;requireThat(!overflow && result.code===0,mode==='check'?'channel-current-identity-unavailable':'task-identity-probe-unavailable');
    let observed;try{observed=JSON.parse(output);}catch(error){throw new StudioError('broker-response-invalid');}
    requireThat(observed.generation===binding.instance_generation,'instance-changed');
    if(mode==='observe-task') await child.verified;
    return observed;
  } finally {clearTimeout(timer);}
}
export function checkCurrent(binding,options={}) {return brokerRead('check',binding,options);}
export function observeTask(binding,operationId,options={}) {return brokerRead('observe-task',binding,{...options,operationId});}
export async function openChannel(root,binding,{resume,install=true,retentionMs=30000,timeoutMs=60000,onDiagnostic=()=>{}}={}) {
  const mod=await loadModules(root);let installChild;
  if(install && !resume) {
    const installer=new mod.RemoteHelperInstaller({sshBinary:'d02-bound-broker',timeoutMs:120000,capabilities:mod.MODERN_SSH_CAPABILITIES,
      spawnProcess(_binary,args){requireThat(args.at(-2)===alias,'broker-alias-mismatch');installChild=spawnBroker('install',binding,undefined,onDiagnostic);return installChild;}});
    try {await installer.install(alias);await installChild.verified;}
    catch(error){throw new StudioError('helper-install-failed',`Bound helper installation failed (${transportCode(error)})`);}
  }
  const args=mod.buildSystemSshArgs(alias,mod.buildHelperConnectCommand(HELPER_SHA));requireThat(args.at(-2)===alias,'broker-alias-mismatch');
  const child=spawnBroker('connect',binding,undefined,onDiagnostic),started=Date.now();
  const client=new mod.RemoteHelperRpcClient({readable:child.stdout,writable:child.stdin,closeTransport:()=>child.stdin.end(),helloTimeoutMs:timeoutMs});
  child.once('close',()=>client.transportClosed(new StudioError('helper-transport-closed')));
  try {
    await client.initialize({clientId:resume?.clientId??randomUUID(),clientName:'agent-studio-bound-preview',clientVersion:'d08',retentionMs,...(resume?{resumeToken:resume.token}:{})},{timeoutMs});
    const proof=await child.verified;
    requireThat(client.hello.helperVersion==='0.13.1' && client.sessionId,'helper-protocol-mismatch');
    onDiagnostic({layer:'helper-rpc',stage:'initialize',channel_id:proof.channel_id,started_at_ms:started,finished_at_ms:Date.now(),duration_ms:Date.now()-started,resumed:client.session.resumed,retention_ms:client.session.retentionMs});
    return {client,child,proof,connected:true};
  } catch(error) {
    onDiagnostic({layer:'helper-rpc',stage:'initialize',started_at_ms:started,finished_at_ms:Date.now(),duration_ms:Date.now()-started,error_code:transportCode(error)});
    client.close('initialize failed');child.kill('SIGTERM');await child.exited;
    throw new StudioError(transportCode(error));
  }
}
// Transport-only detach. Never session/close, workspace/close, or daemon signals.
export async function closeChannel(channel) {
  channel.connected=false;channel.client.close('bound transport detached');
  const timer=setTimeout(()=>{if(channel.child.exitCode===null) channel.child.kill('SIGTERM');},1000);
  try {const result=await channel.child.exited;requireThat(result.code===0 || result.signal==='SIGTERM' || result.code===78,'transport-close-unconfirmed');return result;}
  finally {clearTimeout(timer);}
}
