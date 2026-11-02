#!/usr/bin/env node
// Import-safe, capability-injected renewal/connect runner. No lifecycle action.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {WORKSPACE_ID, isMain, sleep, workspaceFrom, assertAgentConnected, assertBindingIds, assertConnectedBinding, acceptanceReport, cliReport} from './acceptance-contracts.mjs';
import {runT202ConnectBindings,latestBinding} from './t202.connect.bindings.mjs';

export async function runT202RestoreRemaining({rpc,bindings,coderWorkspaceId=WORKSPACE_ID,writeDemo,pause=sleep,onPass}={}) {
  const results=[],restored=[];
  try {
    return await acceptanceReport('T202 selected bindings renewed and connected; no lifecycle or original-task recovery claim',null,null,async pass=>{
      assert.equal(typeof rpc,'function','RPC capability required');
      assert.ok(Array.isArray(bindings)&&bindings.length>0,'no requested bindings; restoration incomplete');
      assert.ok(bindings.every(row=>typeof row.id==='string'&&row.id.length>0),'invalid requested binding');
      assert.equal(new Set(bindings.map(row=>row.id)).size,bindings.length,'duplicate requested binding');
      for(const row of bindings)if(row.file!=null)assert.match(row.file,/^[a-z][a-z0-9-]*\.json$/,'unsafe demo filename');
      const currentWorkspace=async(method='environment.describe')=>{
        const row=workspaceFrom(await rpc(method),coderWorkspaceId);assertAgentConnected(row);
        assert.ok(!row.error_code&&!row.status?.error_code,'workspace has an error code');return row;
      };
      for(const requested of bindings) {
        try {
          let workspace;
          try {workspace=await currentWorkspace('environment.discover');}
          catch(error) {results.push({binding_id:requested.id,status:'skipped',reason:String(error.message).slice(0,300)});continue;}
          assert.ok(Array.isArray(workspace.bindings),'workspace bindings missing');
          const before=latestBinding(workspace,requested.id);
          assert.ok(typeof workspace.observation_id==='string'&&workspace.observation_id.length>0,'fresh observation missing');
          const link=await rpc('environment.open',{request_id:'restore-'+requested.id+'-'+randomUUID(),workspace_id:coderWorkspaceId,observation_id:workspace.observation_id,environment_id:before.environment_id,binding_id:requested.id,expected_version:before.version,renew:true});
          assert.equal(link?.state,'ready',link?.error_code??'renewal failed');
          assert.equal(link.binding_id,requested.id,'renewal binding mismatch');
          assert.ok(Number.isSafeInteger(link.version)&&link.version>before.version,'renewal did not advance binding version');
          assert.equal(link.environment_id,before.environment_id,'renewal environment mismatch');
          const row=await rpc('binding.get',{binding_id:requested.id,version:link.version});
          for(const key of ['binding_id','version','environment_id','project_id'])assert.equal(row?.[key],link[key],'renewed binding mismatch: '+key);
          assert.equal(row.project_id,before.project_id,'renewal changed project selection');
          assert.notEqual(row.workspace_id,before.workspace_id,'renewal did not create a new native workspace anchor');
          assert.notEqual(row.target_root,before.target_root,'renewal did not create a new target root');
          assert.equal(row.state,'ready','renewed binding is not ready');
          assert.ok(typeof row.project_id==='string'&&row.project_id.length>0,'renewed project missing');
          const ids=assertBindingIds({project_id:row.project_id,environment_id:row.environment_id,binding_id:row.binding_id,version:row.version,session_id:link.session_id,workspace_id:row.workspace_id,target_root:row.target_root},link.version,requested.id);
          const session=await rpc('session.get',{session_id:ids.session_id});
          for(const key of ['session_id','binding_id','version'])assert.equal(session?.[key],ids[key],'renewed session mismatch: '+key);
          assert.equal(session.state,'ready','renewed session is not ready');
          await runT202ConnectBindings({rpc,coderWorkspaceId,bindingIds:[requested.id],expectedVersions:{[requested.id]:ids.version},pause});
          await pause(5000);
          assertConnectedBinding(await currentWorkspace('environment.discover'),ids);
          if(requested.file!=null) {
            assert.equal(typeof writeDemo,'function','demo writer capability required');
            await writeDemo(requested.file,ids);
          }
          restored.push(ids);results.push({binding_id:ids.binding_id,old_version:before.version,version:ids.version,session_id:ids.session_id,file:requested.file??null,status:'restored',connected:true});
        } catch(error) {results.push({binding_id:requested.id,status:'failed',code:error.code??error.name,message:String(error.message).slice(0,300)});}
      }
      assert.equal(restored.length,bindings.length,'restoration incomplete: skipped or failed requested bindings');
      assert.equal(new Set(restored.map(row=>row.session_id)).size,restored.length,'renewed bindings share a session');
      const final=await currentWorkspace('environment.discover');
      for(const ids of restored)assertConnectedBinding(final,ids);
      pass('every requested binding renewed to a newer exact connected version',{restored:restored.length});
      return {coder_workspace_id:coderWorkspaceId,results,agent_final:final.status.agent.status};
    },onPass);
  } catch(error) {if(error.acceptanceReport)error.acceptanceReport.results=results;throw error;}
}

async function main() {
  const {authenticate,requestRpc,DEFAULT_ROOT:root,repo}=await import('./preview.mjs');
  const {writeFile,chmod}=await import('node:fs/promises');const {join}=await import('node:path');
  const defaults=[
    {id:'binding-1dfc57ad-ea10-4432-91f4-d017baf52c90',file:'model-remote-demo.json'},
    {id:'binding-7b85475c-6da8-47e1-8c5d-80e5fd0aa9cc',file:'acp-remote-demo.json'},
    {id:'binding-6113005c-b396-4807-b48a-90f697c1395e',file:null},
    {id:'binding-47f844e0-172f-4e60-a97c-15bd4a712290',file:null}];
  await cliReport({repo,folder:'t202',prefix:'t202-restore-remaining-'},async()=>{
    const only=process.argv.slice(2);assert.ok(only.every(id=>defaults.some(row=>row.id===id)),'unknown requested binding');
    const auth=await authenticate(root);
    return runT202RestoreRemaining({rpc:(method,payload={})=>requestRpc(auth,method,payload),bindings:only.length?only.map(id=>defaults.find(row=>row.id===id)):defaults,
      writeDemo:async(file,ids)=>{const path=join(root,file);await writeFile(path,JSON.stringify(ids,null,2)+'\n',{mode:0o600});await chmod(path,0o600);},onPass:name=>console.log('PASS '+name)});
  });
}
if(isMain(import.meta.url))main().catch(error=>{console.error(String(error.message));process.exitCode=1;});
