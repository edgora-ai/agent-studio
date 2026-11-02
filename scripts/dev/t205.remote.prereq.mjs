#!/usr/bin/env node
// T-205 remote sidebar prerequisites over the single D02 v5 channel:
// original sidebar routes for tree/search/reference/save-CAS, plus remote
// local-opener rejection. Server routes only; no browser, no lifecycle.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {authenticate,requestRpc,DEFAULT_ROOT as root,repo} from './preview.mjs';
const ids=JSON.parse(await readFile(join(root,'remote-demo.json'),'utf8'));
assert.equal(ids.version,5,'expected D02 v5');
const auth=await authenticate(root),rpc=(m,p={})=>requestRpc(auth,m,p);
const sha=b=>createHash('sha256').update(b).digest('hex');
const checks=[],pass=(name,facts={})=>{checks.push({name,...facts});console.log('PASS '+name);};
async function side(method,payload={},query='') {
 const url=auth.origin+'/sidebar/api/'+method+(query?'?'+query:'');
 const response=await fetch(url,{method:'POST',headers:{cookie:auth.cookie,origin:auth.origin,'content-type':'application/json'},body:JSON.stringify({sessionId:ids.session_id,...payload})});
 const body=await response.json();
 if(body.ok===false) throw Object.assign(new Error(body.error?.message??'sidebar error'),{code:body.error?.code,status:response.status});
 return body.value;
}
const run=randomUUID(),dir='t205-remote-'+run,relative=dir+'/中文 file.txt',marker='T205_REMOTE_'+run;
try{
 await rpc('fs.mkdir',{session_id:ids.session_id,path:dir,operation_id:randomUUID()});
 const write=await rpc('fs.write',{session_id:ids.session_id,path:relative,operation_id:randomUUID(),encoding:'utf8',data:'remote original\n'+marker+'\n',expected_version:null});
 const absolute=ids.target_root+'/'+relative;
 const found=await side('fs.search',{query:'content:'+marker});
 assert.ok(found.hits.some(hit=>hit.path===absolute));
 assert.equal(found.identity.kind,'remote');
 const reference=await side('reference.create',{path:absolute});
 assert.match(reference.label,/remote/);
 const citation=JSON.parse(reference.text.split('\n').slice(1).join('\n'));
 assert.equal(citation.identity.kind,'remote');
 assert.equal(citation.identity.binding_id,ids.binding_id);
 pass('remote sidebar search/reference act on the bound v5 root with remote identity',{dir,identity:found.identity,binding_id:ids.binding_id});
 // Save path through the original sidebar timestamp bridge.
 const read=await side('fs.read',{path:absolute});
 const conflict=await fetch(auth.origin+'/sidebar/write?'+new URLSearchParams({sessionId:ids.session_id,path:absolute,expectedMtimeMs:String(read.mtimeMs+1)}),{method:'POST',headers:{cookie:auth.cookie,origin:auth.origin},body:'lost'});
 assert.equal(conflict.status,409);
 const current=await rpc('fs.read',{session_id:ids.session_id,path:relative});
 assert.equal(Buffer.from(current.data,'base64').toString(),'remote original\n'+marker+'\n');
 pass('original sidebar save bridge rejects a stale mtime with 409 and keeps remote bytes',{status:409,sha256:current.sha256});
 // Remote context must not be able to use the local opener route.
 let opener=null;
 try{await side('open.external',{action:'reveal',path:absolute,realm:'local'});}catch(error){opener=error.code;}
 assert.ok(opener&&/provider-unavailable|denied|not-enabled/.test(opener),'opener not rejected: '+opener);
 pass('remote session local-opener route is rejected instead of dispatching on the central host',{code:opener});
}catch(error){console.error(JSON.stringify({result:'fail',code:error.code??error.name,message:String(error.message).slice(0,300)}));process.exitCode=1;}
finally{await mkdir(join(repo,'artifacts/t205'),{recursive:true});const artifact=join(repo,'artifacts/t205/t205-remote-prereq-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');await writeFile(artifact,JSON.stringify({scope:'T-205 remote sidebar prerequisites over single D02 v5 channel; server routes only',ids,run,checks,result:process.exitCode?'fail':'pass'},null,2)+'\n');console.log(JSON.stringify({result:process.exitCode?'fail':'pass',checks:checks.length,artifact}));}
