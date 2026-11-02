#!/usr/bin/env node
// Restore remaining m1-a bindings one at a time (renew -> connect -> demo file),
// checking the agent stays connected after each step. No lifecycle action.
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,chmod,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {authenticate,requestRpc,DEFAULT_ROOT as root,repo} from './preview.mjs';
const bindings=[
 {id:'binding-1dfc57ad-ea10-4432-91f4-d017baf52c90',file:'model-remote-demo.json'},
 {id:'binding-7b85475c-6da8-47e1-8c5d-80e5fd0aa9cc',file:'acp-remote-demo.json'},
 {id:'binding-6113005c-b396-4807-b48a-90f697c1395e',file:null},
 {id:'binding-47f844e0-172f-4e60-a97c-15bd4a712290',file:null}];
const auth=await authenticate(root),rpc=(m,p={})=>requestRpc(auth,m,p);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const agent=async()=>{const d=await rpc('environment.discover');return d.workspaces?.[0]?.status?.agent?.status??null;};
const results=[];
for(const binding of bindings){
 const state=await agent();
 if(state!=='connected'){results.push({binding_id:binding.id,skipped:'agent '+state});continue;}
 try{
  execFileSync(process.execPath,['scripts/dev/t202.renew.bindings.mjs',binding.id],{cwd:repo,stdio:'pipe',timeout:240000});
  execFileSync(process.execPath,['scripts/dev/t202.connect.bindings.mjs',binding.id],{cwd:repo,stdio:'pipe',timeout:240000});
  const db=new DatabaseSync(join(root,'bindings.sqlite'),{readOnly:true});
  const row=db.prepare('SELECT * FROM project_bindings WHERE binding_id=? ORDER BY version DESC LIMIT 1').get(binding.id);
  const session=db.prepare("SELECT * FROM session_bindings WHERE binding_id=? AND version=? AND state='ready'").get(binding.id,row.version);
  db.close();
  if(binding.file){
   const payload={project_id:row.project_id,environment_id:row.environment_id,binding_id:row.binding_id,version:row.version,session_id:session.session_id,workspace_id:row.workspace_id,target_root:row.target_root};
   await writeFile(join(root,binding.file),JSON.stringify(payload,null,2)+'\n',{mode:0o600});await chmod(join(root,binding.file),0o600);
  }
  await sleep(5000);
  results.push({binding_id:binding.id,version:row.version,session_id:session.session_id,file:binding.file,agent_after:await agent()});
  console.log('RESTORED',binding.id,'v'+row.version,'agent',results.at(-1).agent_after);
 }catch(error){results.push({binding_id:binding.id,error:error.code??error.name,message:String(error.stderr??error.message).slice(-300)});}
 await sleep(4000);
}
await mkdir(join(repo,'artifacts/t202'),{recursive:true});
const artifact=join(repo,'artifacts/t202/t202-restore-remaining-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
await writeFile(artifact,JSON.stringify({scope:'restore remaining m1-a bindings one at a time',results,result:results.some(r=>r.error)?'partial':'pass',agent_final:await agent()},null,2)+'\n');
console.log(JSON.stringify({results,artifact}));
