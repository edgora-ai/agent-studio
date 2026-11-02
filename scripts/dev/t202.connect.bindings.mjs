#!/usr/bin/env node
// Reconnect existing ready m1-a bindings/sessions through environment.open.
// No lifecycle/create/delete action.
import {randomUUID} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {authenticate,requestRpc,DEFAULT_ROOT as root,repo} from './preview.mjs';
const auth=await authenticate(root),rpc=(m,p={})=>requestRpc(auth,m,p);
const workspaceId='ff136352-6a92-41d4-9c2c-6cc783cb989b';
await rpc('environment.discover');
const described=await rpc('environment.describe');
const ws=described.workspaces.find(row=>row.workspace_id===workspaceId);
const observationId=ws.observation_id;
const bindings=described.workspaces.find(row=>row.workspace_id===workspaceId).bindings.filter(row=>row.state==='ready'&&row.target_root.startsWith('/workspace/')&&row.channel?.connected!==true&&(only.length===0||only.includes(row.binding_id)));
const only=process.argv.slice(2);
const sessions=(await rpc('session.list')).filter(row=>row.state==='ready');
const results=[];
try{
 for(const binding of bindings){
  const session=sessions.find(row=>row.binding_id===binding.binding_id&&row.version===binding.version);
  if(!session) throw new Error('no ready session for '+binding.binding_id+' v'+binding.version);
  let link=null,lastError=null;
  for(let attempt=0;attempt<6&&!link;attempt++){
   const fresh=(await rpc('environment.describe')).workspaces.find(row=>row.workspace_id===workspaceId);
   try{link=await rpc('environment.open',{request_id:'connect-'+binding.binding_id+'-'+randomUUID(),workspace_id:workspaceId,observation_id:fresh.observation_id,environment_id:binding.environment_id,binding_id:binding.binding_id,expected_version:binding.version,session_id:session.session_id});}
   catch(error){lastError=error;if(error.code!=='agent-studio/environment-selection-changed'&&error.code!=='environment-selection-changed')throw error;await new Promise(r=>setTimeout(r,1500));}
  }
  if(!link) throw lastError??new Error('connect failed');
  if(link.state!=='ready') throw new Error(link.error_code??'connect failed');
  results.push({binding_id:binding.binding_id,version:binding.version,session_id:session.session_id,link_state:link.state});
  console.log('CONNECTED',binding.binding_id,'v'+binding.version,session.session_id);
 }
 const after=(await rpc('environment.describe')).workspaces.find(row=>row.workspace_id===workspaceId).bindings.map(row=>({binding_id:row.binding_id,version:row.version,state:row.state,connected:row.channel?.connected===true}));
 console.log('CHANNELS',JSON.stringify(after));
}catch(error){console.error(JSON.stringify({result:'fail',code:error.code??error.name,message:String(error.message)}));process.exitCode=1;}
finally{await mkdir(join(repo,'artifacts/t202'),{recursive:true});const artifact=join(repo,'artifacts/t202/t202-connect-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');await writeFile(artifact,JSON.stringify({workspaceId,results,result:process.exitCode?'fail':'pass'},null,2)+'\n');console.log(JSON.stringify({result:process.exitCode?'fail':'pass',connected:results.length,artifact}));}
