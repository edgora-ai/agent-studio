import {randomUUID,createHash} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {Readable} from 'node:stream';
import {requireThat,StudioError} from '../store.mjs';

const allocationContext=new AsyncLocalStorage();
export function nativeTerminalAllocation(sessionId,terminalId,action) {
  return allocationContext.run({sessionId,terminalId},action);
}

// This is installed on a real factory-created Agent before publication, not on
// the Host/root Context. Unsupported subprocess operations never fall back local.
export function installTerminal(studio,agentCtx,agent,row,binding,extraServices={}) {
  requireThat(agent.ctx===agentCtx,'agent-context-mismatch');
  const provider=studio.provider, principal=row.principal_id, session_id=row.session_id;
  const authorize=()=>provider.authorized(principal,{session_id},'pty.open');
  const task=(operation_id,method,input={})=>provider.task(principal,method,{session_id,operation_id,...input});
  const subprocess={
    async terminalEnvironment(signal) {
      signal?.throwIfAborted();return provider.terminalEnvironment(await authorize());
    },
    async resolveExecutable(command,env,signal) {
      signal?.throwIfAborted();requireThat(env===undefined,'terminal-env-override');
      const context=await authorize();
      try {return await provider.resolveExecutable(context,command);}
      catch(error) {
        if(error.code==='E_EXECUTABLE_NOT_FOUND') error.name='SubprocessExecutableNotFoundError';
        throw error;
      }
    },
    async spawnTerminal(options) {
      options.signal?.throwIfAborted();requireThat(options.cwd===binding.target_root,'cwd-outside-binding');
      const allocation=allocationContext.getStore();
      requireThat(allocation?.sessionId===session_id && typeof allocation.terminalId==='string','terminal-allocation-context');
      // A restored native tab keeps its durable identity. Restart must not turn
      // that same tab into a fresh operation and silently rerun its shell.
      const operation_id='terminal-'+createHash('sha256').update(session_id+'\0'+allocation.terminalId).digest('hex');
      const context=await authorize(),env={...options.env,TERM:options.terminalType};
      if(context.environment.kind==='local' && context.environment.provider==='local-managed' && env.DSH_SESSION_ID!==undefined) {
        requireThat(env.DSH_SESSION_ID===session_id,'terminal-session-env-mismatch');
        // Native controller metadata is verified here, not forwarded to a local
        // shell as an ambient harness capability or accepted from public input.
        delete env.DSH_SESSION_ID;
      }
      const started=await provider.start(principal,{session_id,operation_id,argv:options.argv,cwd:'',
        env,tty:{rows:options.rows,cols:options.cols}});
      studio.store.audit(principal,'terminal.identity',operation_id,'running',{session_id,terminal_id:allocation.terminalId,...(started.execution_kind==='local'?{execution_kind:'local',local_pid:started.pid,local_start_ticks:started.start_ticks}:{execution_kind:'remote',remote_pid:started.pid})});
      const completion=Promise.withResolvers();let ended=false,closing,revision=0;
      const done=completion.promise;done.catch(error=>studio.store.audit(principal,'terminal.output',operation_id,'unknown',{code:error.code??'terminal-error'}));
      const output=Readable.from((async function*(){
        let cursor='0';
        try {
          while(!ended) {
            let page;
            try {page=await task(operation_id,'read',{after_seq:cursor});}
            catch(error) {
              if(studio.recovery?.state.row(operation_id)?.state!=='lost')throw error;
              // Keep the native handle and its frame sequence. Wait for an
              // explicit verified recovery, never create a replacement shell.
              await studio.recovery.wait(operation_id);continue;
            }
            if(page.truncated)yield Buffer.from('\r\n[Original output gap; earliest helper chunk '+page.earliestSeq+'; missing bytes are not reconstructed]\r\n');
            cursor=page.nextSeq;
            for(const chunk of page.chunks) yield Buffer.from(chunk.data,'base64');
            if(page.exited) {ended=true;completion.resolve({exitCode:page.exitCode??null,signal:page.signal??null});}
          }
        } catch(error) {completion.reject(error);throw error;}
      })(),{objectMode:false});
      const action=(method,input={})=>task(operation_id,method,{action_id:randomUUID(),...input});
      return {
        pid:started.pid,output,done,
        async write(data) {revision++;await action('input',{data:typeof data==='string'?data:Buffer.from(data).toString('utf8')});},
        async resize(cols,rows) {revision++;await action('resize',{cols,rows});},
        async inspectActivity() {await authorize();return {state:'unknown',revision};},
        async inspectForeground() {
          const result=await task(operation_id,'foreground');
          return result.verified===true && Number.isSafeInteger(result.pgid) && result.pgid>1?{processGroupId:result.pgid,inputWaiting:false}:undefined;
        },
        async signalForeground(signal) {
          revision++;const result=await action('signal',{signal});
          requireThat(result.delivered===true && result.verified===true && result.targetPgid>1,'signal-unconfirmed');return result.targetPgid;
        },
        terminate() {
          if(!closing) closing=(async()=>{
            const record=studio.store.operation(principal,operation_id);
            if(record.state==='released') return;
            if(studio.recovery?.state.row(operation_id)?.state==='lost') {
              // Closing is an explicit cleanup request. It may verify the exact
              // original task to cancel it, never replay input or keep it forever.
              await studio.recovery.recover(principal,{session_id,operation_id,recovery_id:randomUUID()});
            }
            const status=await task(operation_id,'status');
            if(status.running) await action('cancel');
            // Output consumer must observe exit before release invalidates reads.
            if(!ended) {output.resume();await done;}
            await action('release');
          })().catch(error=>{closing=undefined;throw error;});
          return closing;
        },
      };
    },
  };
  const deny=()=>{throw new StudioError('subprocess-operation-disabled');};
  const guarded=new Proxy(subprocess,{get(target,key){if(key in target) return target[key];if(typeof key==='symbol' || key==='then') return undefined;return deny;}});
  const services={...extraServices,subprocess:guarded,workingDirectory:{
    get(session){requireThat(session.id===session_id,'session-not-owned');return binding.target_root;},
    async ensure(actual,signal){signal?.throwIfAborted();requireThat(actual===agent,'agent-context-mismatch');await authorize();return binding.target_root;},
  }};
  const isolation=Symbol.for('cordis.isolate'), shadow=Object.create(agentCtx[isolation]);
  for(const name of Object.keys(services)) shadow[name]=Symbol(`bound-${name}`);
  // The factory's Agent Context already exists here; shadow only that instance.
  Object.defineProperty(agentCtx,isolation,{value:shadow,configurable:true});
  for(const [name,value] of Object.entries(services)) agentCtx.provide(name,value);
  requireThat(agent.ctx.get('subprocess',false)?.spawnTerminal===subprocess.spawnTerminal,'agent-provider-not-installed');
}
