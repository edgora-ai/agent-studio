import {readFile,writeFile,rename,lstat,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CredentialProvider} from 'file:///home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-credentials/lib/index.js';
import {requireThat,StudioError} from './store.mjs';

export const validModelRef=ref=>typeof ref==='string' && /^STUDIO_MODEL_[A-Z0-9_]{1,100}$/.test(ref);
export const validAcpRef=ref=>typeof ref==='string' && /^STUDIO_ACP_[A-Z0-9_]{1,100}$/.test(ref);
const validRef=ref=>validModelRef(ref)||validAcpRef(ref);
// One launcher-owned vault, never environment/project/.env/OAuth discovery. Its
// MODEL references stay central; only dedicated ACP references can enter the
// explicitly registered CLI's private, non-persisted launch environment.
export class StudioCredentials extends CredentialProvider {
  constructor(ctx) {super(ctx);this.file=join(process.env.AGENT_STUDIO_ROOT,'model-credentials.json');this.queue=Promise.resolve();}
  async load() {
    try {
      const info=await lstat(this.file);requireThat(info.isFile() && !info.isSymbolicLink() && (info.mode&0o077)===0,'credential-vault-permissions');
      const doc=JSON.parse(await readFile(this.file,'utf8'));
      requireThat(doc.version===1 && doc.references && doc.records,'credential-vault-format');return doc;
    } catch(error) {
      if(error.code==='ENOENT') return {version:1,references:{},records:{}};
      if(error instanceof StudioError) throw error;
      // JSON parser diagnostics can quote vault bytes. Never forward them to
      // native credential errors or logs, even for a corrupted private store.
      throw new StudioError('credential-vault-unavailable');
    }
  }
  async change(update) {
    const work=this.queue.then(async()=>{
      const doc=await this.load(),result=await update(doc),temp=this.file+'.'+randomUUID()+'.tmp';
      await writeFile(temp,JSON.stringify(doc),{flag:'wx',mode:0o600});await rename(temp,this.file);await chmod(this.file,0o600);return result;
    });
    this.queue=work.then(()=>undefined,()=>undefined);return work;
  }
  async resolve(ref) {
    if(!validRef(ref)) return undefined;
    const value=(await this.load()).references[ref];
    return typeof value==='string' && value.length?{value,source:'studio-private-vault'}:undefined;
  }
  async describe(ref) {const hit=await this.resolve(ref);return {configured:hit!==undefined,...(hit?{source:hit.source}:{}),writable:validRef(ref)};}
  async set(ref,value) {
    requireThat(validRef(ref) && typeof value==='string' && value.length>0 && value.length<=16384 && !/[\u0000-\u001f]/.test(value),'invalid-model-credential');
    await this.change(doc=>{doc.references[ref]=value;});this.notifyUpdated(ref);
  }
  async unset(ref) {requireThat(validRef(ref),'invalid-model-credential');await this.change(doc=>{delete doc.references[ref];});this.notifyUpdated(ref);}
  async readRecord(key) {return (await this.load()).records[String(key)];}
  async listRecords() {return Object.entries((await this.load()).records).map(([key,record])=>({key,kind:record.kind}));}
  async describeRecord(key) {const record=await this.readRecord(key);return {configured:record!==undefined,writable:false,...(record?{kind:record.kind}:{})};}
  async modifyRecord(key,mutate) {
    requireThat(String(key)==='client-connection/browser-session','credential-record-not-enabled');
    const result=await this.change(async doc=>{
      const current=doc.records[String(key)],next=await mutate(current===undefined?undefined:structuredClone(current));
      if(next!==undefined) {requireThat(next.kind==='grant' && next.payload && JSON.stringify(next).length<=8192,'invalid-browser-auth-record');doc.records[String(key)]=JSON.parse(JSON.stringify(next));}
      return doc.records[String(key)];
    });this.notifyRecordUpdated(key);return result;
  }
  async deleteRecord() {throw new Error('Studio credential records are not writable');}
}
export function apply(ctx) {new StudioCredentials(ctx);}
