#!/usr/bin/env node
// Seed minimal fixtures inside each renewed m1-a v2 binding root through the
// product fs RPC. Requires the renewed sessions to be connected; no lifecycle.
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {authenticate,requestRpc,DEFAULT_ROOT as root} from './preview.mjs';
const auth=await authenticate(root),rpc=(m,p={})=>requestRpc(auth,m,p);
const files=['remote-demo.json','model-remote-demo.json','acp-remote-demo.json'];
const results=[];
for(const file of files){
 const ids=JSON.parse(await readFile(join(root,file),'utf8'));
 const run=randomUUID(),relative='t202-seed-'+run+'.txt',data='T202_REMOTE_SEED '+run+'\n';
 const written=await rpc('fs.write',{session_id:ids.session_id,path:relative,operation_id:randomUUID(),encoding:'utf8',data,expected_version:null});
 const read=await rpc('fs.read',{session_id:ids.session_id,path:relative});
 const decoded=Buffer.from(read.data,'base64').toString('utf8');
 if(decoded!==data) throw new Error('remote seed readback mismatch for '+file);
 results.push({file,binding_id:ids.binding_id,version:ids.version,session_id:ids.session_id,path:relative,sha256:read.sha256??null,bytes:Buffer.byteLength(data),write_operation:written.operation_id??null});
 console.log('SEEDED',file,relative);
}
console.log(JSON.stringify({result:'pass',results},null,2));
