import {randomUUID} from 'node:crypto';
import {requireThat,StudioError} from '../store.mjs';

// Byte transport only. The installed ACP SDK owns JSON-RPC dispatch, schemas,
// request ids, negotiation, and response matching; this is not a second client.
export class AcpStdio {
  constructor({provider,principal,sessionId,operationId,scope,onIdentity,onFrame,onError,beforeWrite,afterWrite,secrets=[]}) {
    Object.assign(this,{provider,principal,sessionId,operationId,scope,onIdentity,onFrame,onError,beforeWrite,afterWrite,secrets});
    this.cursor='0';this.total=0;this.stdout=Buffer.alloc(0);this.stderr=Buffer.alloc(0);this.stopped=false;this.inputClosed=false;this.sawIdentity=false;
    this.identity=Promise.withResolvers();this.identity.promise.catch(error=>{this.identityError=error;});
    this.input=new ReadableStream({start:controller=>{this.controller=controller;},cancel:()=>{this.inputClosed=true;}});
    this.output=new WritableStream({write:bytes=>this.write(bytes)});
  }
  parameters(extra={}) {return {session_id:this.sessionId,operation_id:this.operationId,...extra};}
  async call(method,extra={}) {return this.scope(()=>this.provider.task(this.principal,method,this.parameters(extra)));}
  safeText(bytes) {
    const value=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    requireThat(!this.secrets.some(secret=>value.includes(secret)),'acp-credential-output-rejected');return value;
  }
  decode(bytes) {
    requireThat(bytes.length<=65536,'acp-frame-limit');
    let frame;try {frame=JSON.parse(this.safeText(bytes));} catch(error) {if(error instanceof StudioError) throw error;throw new StudioError('acp-invalid-frame');}
    requireThat(frame && typeof frame==='object' && !Array.isArray(frame),'acp-invalid-frame');return frame;
  }
  async write(bytes) {
    requireThat(!this.stopped && bytes.length<=65536,'acp-transport-closed');
    const text=this.safeText(bytes),lines=text.split('\n');
    requireThat(lines.at(-1)==='' && lines.length===2,'acp-output-framing');
    const frame=this.decode(Buffer.from(lines[0])),control=await this.beforeWrite(frame);
    try {await this.scope(()=>this.provider.task(this.principal,'input',this.parameters({action_id:randomUUID(),data:text})),control);}
    catch(error) {this.onError(error instanceof StudioError?error:new StudioError('acp-transport-write-failed'));throw error;}
    this.afterWrite(frame,control);this.onFrame('wire-out',frame);
  }
  start() {
    this.pump=this.readLoop().catch(error=>{
      const failure=error instanceof StudioError?error:new StudioError('acp-stdio-failed');
      this.identity.reject(failure);if(!this.inputClosed) {this.inputClosed=true;this.controller.error(failure);}
      this.onError(failure);
    });return this.identity.promise;
  }
  async readLoop() {
    while(!this.stopped) {
      const result=await this.call('read',{after_seq:this.cursor});if(this.stopped) break;
      requireThat(!result.truncated,'acp-output-truncated');
      for(const chunk of result.chunks) {
        requireThat(BigInt(chunk.seq)===BigInt(this.cursor)+1n && ['stdout','stderr'].includes(chunk.stream),'acp-output-sequence');
        const bytes=Buffer.from(chunk.data,'base64');requireThat(bytes.toString('base64')===chunk.data,'acp-invalid-output-encoding');
        this.cursor=String(chunk.seq);this.total+=bytes.length;requireThat(this.total<=1048576,'acp-output-limit');
        if(chunk.stream==='stderr') {
          this.stderr=Buffer.concat([this.stderr,bytes]);requireThat(this.stderr.length<=16384,'acp-stderr-limit');continue;
        }
        this.stdout=Buffer.concat([this.stdout,bytes]);
        let at;
        while((at=this.stdout.indexOf(10))!==-1) {
          const line=this.stdout.subarray(0,at);this.stdout=this.stdout.subarray(at+1);
          requireThat(line.length>0,'acp-empty-frame');const frame=this.decode(line);
          if(!this.sawIdentity) {await this.onIdentity(frame);this.sawIdentity=true;this.identity.resolve(frame);}
          else {
            requireThat(frame.jsonrpc==='2.0','acp-invalid-frame');this.onFrame('wire-in',frame);
            if(!this.inputClosed) this.controller.enqueue(Buffer.concat([line,Buffer.from('\n')]));
          }
        }
        requireThat(this.stdout.length<=65536,'acp-frame-limit');
      }
      requireThat(String(result.nextSeq)===this.cursor,'acp-output-sequence');
      if(result.exited || result.closed) {
        requireThat(this.stdout.length===0,'acp-incomplete-frame');
        if(this.stderr.length) this.onFrame('stderr',{text:this.safeText(this.stderr)});
        this.exit={exitCode:result.exitCode,signal:result.signal};
        if(!this.sawIdentity) throw new StudioError('acp-launch-failed');
        if(!this.inputClosed) {this.inputClosed=true;this.controller.close();}break;
      }
    }
  }
  async stop() {this.stopped=true;if(!this.inputClosed) {this.inputClosed=true;this.controller.close();}await this.pump;}
}
