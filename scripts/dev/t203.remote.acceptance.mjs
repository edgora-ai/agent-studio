#!/usr/bin/env node
// T-203 remote acceptance on the single connected D02 v4 channel.
// Uses product RPC only; bounded writes inside the binding root; no lifecycle.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {authenticate,requestRpc,DEFAULT_ROOT as root,repo} from './preview.mjs';
const ids=JSON.parse(await readFile(join(root,'remote-demo.json'),'utf8'));
assert.equal(ids.version,4,'expected D02 v4 remote demo');
const auth=await authenticate(root),rpc=(m,p={})=>requestRpc(auth,m,p);
const sha=b=>createHash('sha256').update(b).digest('hex');
const checks=[],pass=(name,facts={})=>{checks.push({name,...facts});console.log('PASS '+name);};
const run=randomUUID(),dir='t203-remote-'+run,path=dir+'/中文 file.txt',marker='T203_REMOTE_'+run;
try{
 const mkdirResult=await rpc('fs.mkdir',{session_id:ids.session_id,path:dir,operation_id:randomUUID()});
 const first=await rpc('fs.write',{session_id:ids.session_id,path,operation_id:randomUUID(),encoding:'utf8',data:marker+'\nline2\n',expected_version:null});
 const read1=await rpc('fs.read',{session_id:ids.session_id,path});
 assert.equal(Buffer.from(read1.data,'base64').toString(),marker+'\nline2\n');
 assert.equal(read1.sha256,sha(marker+'\nline2\n'));
 pass('remote write -> readback bytes/hash inside the v4 binding root',{dir,path,sha256:read1.sha256});
 const second=await rpc('fs.write',{session_id:ids.session_id,path,operation_id:randomUUID(),encoding:'utf8',data:marker+' v2\n',expected_version:read1.version});
 assert.equal(second.version>read1.version,true);
 let staleCode=null;
 try{await rpc('fs.write',{session_id:ids.session_id,path,operation_id:randomUUID(),encoding:'utf8',data:'lost',expected_version:read1.version});}catch(error){staleCode=error.code;}
 assert.ok(staleCode&&/E_STALE_VERSION/.test(staleCode),'stale version not rejected: '+staleCode);
 const read2=await rpc('fs.read',{session_id:ids.session_id,path});
 assert.equal(Buffer.from(read2.data,'base64').toString(),marker+' v2\n');
 pass('remote strong version CAS rejects a stale expected_version and keeps the current bytes',{staleCode,version:second.version});
 const list=await rpc('fs.list',{session_id:ids.session_id,path:dir});
 assert.ok(JSON.stringify(list.entries).includes('中文 file.txt'));
 const search=await rpc('fs.search',{session_id:ids.session_id,query:'content:'+marker,paginate:false});
 assert.ok(search.hits.some(hit=>hit.path.endsWith(path)));
 assert.equal(search.identity.kind,'remote');
 const reference=await rpc('reference.create',{session_id:ids.session_id,path:dir+'/'+path.split('/').at(-1)});
 assert.equal(reference.identity.kind,'remote');
 pass('remote list/search/reference keep binding identity and see the bound bytes',{identity:search.identity,reference:reference.text.slice(0,80)});
}catch(error){console.error(JSON.stringify({result:'fail',code:error.code??error.name,message:String(error.message).slice(0,300)}));process.exitCode=1;}
finally{
 await mkdir(join(repo,'artifacts/t203'),{recursive:true});
 const artifact=join(repo,'artifacts/t203/t203-remote-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
 await writeFile(artifact,JSON.stringify({scope:'T-203 remote acceptance on the D02 v4 single channel; product RPC only, no lifecycle',ids,run,checks,result:process.exitCode?'fail':'pass'},null,2)+'\n');
 console.log(JSON.stringify({result:process.exitCode?'fail':'pass',checks:checks.length,artifact}));
}
