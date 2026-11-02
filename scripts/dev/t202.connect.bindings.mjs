#!/usr/bin/env node
// Import-safe runner. RPC is an explicit capability; only the guarded CLI authenticates.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {WORKSPACE_ID, isMain, sleep, workspaceFrom, assertAgentConnected, assertBindingIds, assertConnectedBinding, acceptanceReport, cliReport, unprefixedCode} from './acceptance-contracts.mjs';

const sameSelection=(row,ids,keys)=>{for(const key of keys)assert.equal(row?.[key],ids[key],'selection mismatch: '+key);};
async function verifySelection(rpc,ids) {
  const binding=await rpc('binding.get',{binding_id:ids.binding_id,version:ids.version});
  sameSelection(binding,ids,['binding_id','version','environment_id','workspace_id','target_root']);
  assert.equal(binding.state,'ready','selected binding is not ready');
  const session=await rpc('session.get',{session_id:ids.session_id});
  sameSelection(session,ids,['session_id','binding_id','version']);
  assert.equal(session.state,'ready','selected session is not ready');
}
export function latestBinding(workspace,id) {
  assert.ok(Array.isArray(workspace.bindings),'workspace bindings missing');
  const rows=workspace.bindings.filter(row=>row.binding_id===id);
  assert.ok(rows.length>0,'missing requested binding: '+id);
  assert.ok(rows.every(row=>Number.isSafeInteger(row.version)&&row.version>0),'invalid binding history version');
  const version=Math.max(...rows.map(row=>row.version)),latest=rows.filter(row=>row.version===version);
  assert.equal(latest.length,1,'ambiguous latest requested binding: '+id);return latest[0];
}

export async function runT202ConnectBindings({rpc,coderWorkspaceId=WORKSPACE_ID,bindingIds=[],expectedVersions={},pause=sleep,onPass}={}) {
  const results=[],selected=[];
  try {
    return await acceptanceReport('T202 selected ready bindings: exact connected-channel verification',null,null,async pass=>{
      assert.equal(typeof rpc,'function','RPC capability required');
      assert.ok(Array.isArray(bindingIds)&&bindingIds.every(id=>typeof id==='string'&&id.length>0),'invalid requested bindings');
      assert.equal(new Set(bindingIds).size,bindingIds.length,'duplicate requested binding');
      const currentWorkspace=async(method='environment.describe')=>{
        const row=workspaceFrom(await rpc(method),coderWorkspaceId);assertAgentConnected(row);
        assert.ok(!row.error_code&&!row.status?.error_code,'workspace has an error code');return row;
      };
      await currentWorkspace('environment.discover');
      const workspace=await currentWorkspace();
      assert.ok(Array.isArray(workspace.bindings),'workspace bindings missing');
      const requested=bindingIds.length?bindingIds:[...new Set(workspace.bindings.filter(row=>typeof row.target_root==='string'&&row.target_root.startsWith('/workspace/')).map(row=>row.binding_id))];
      const bindings=requested.map(id=>latestBinding(workspace,id));
      assert.ok(bindings.length>0,'no requested ready bindings; connection acceptance incomplete');
      const sessions=await rpc('session.list');assert.ok(Array.isArray(sessions),'session list missing');
      for(const binding of bindings) {
        assert.equal(binding.state,'ready','requested binding is not ready');
        if(Object.hasOwn(expectedVersions,binding.binding_id))assert.equal(binding.version,expectedVersions[binding.binding_id],'stale selected binding version');
        const matches=sessions.filter(row=>row.binding_id===binding.binding_id&&row.version===binding.version&&row.state==='ready');
        assert.equal(matches.length,1,'missing or ambiguous ready session');
        const ids=assertBindingIds({...binding,session_id:matches[0].session_id},binding.version,binding.binding_id);selected.push(ids);
        await verifySelection(rpc,ids);
        let opened=false;
        for(let attempt=0;attempt<6&&!opened;attempt++) {
          const fresh=await currentWorkspace();
          const current=latestBinding(fresh,ids.binding_id);sameSelection(current,ids,['binding_id','version','environment_id','workspace_id','target_root']);
          assert.equal(current.state,'ready','binding became unavailable');
          if(current.channel?.connected===true) {assertConnectedBinding(fresh,ids);opened=true;break;}
          assert.ok(typeof fresh.observation_id==='string'&&fresh.observation_id.length>0,'fresh observation missing');
          try {
            const link=await rpc('environment.open',{request_id:'connect-'+ids.binding_id+'-'+randomUUID(),workspace_id:coderWorkspaceId,observation_id:fresh.observation_id,environment_id:ids.environment_id,binding_id:ids.binding_id,expected_version:ids.version,session_id:ids.session_id});
            assert.equal(link?.state,'ready',link?.error_code??'connect failed');
            sameSelection(link,ids,['binding_id','version','environment_id','session_id']);opened=true;
          } catch(error) {
            if(unprefixedCode(error.code)!=='environment-selection-changed'||attempt===5)throw error;
            await pause(1500);
          }
        }
        assert.ok(opened,'connect not confirmed');
        assertConnectedBinding(await currentWorkspace(),ids);
        await verifySelection(rpc,ids);
        results.push({binding_id:ids.binding_id,version:ids.version,session_id:ids.session_id,connected:true});
      }
      const final=await currentWorkspace();
      for(const ids of selected)assertConnectedBinding(final,ids);
      pass('all selected binding versions have exact connected channel identities',{connected:results.length});
      return {workspace_id:coderWorkspaceId,results};
    },onPass);
  } catch(error) {if(error.acceptanceReport)error.acceptanceReport.results=results;throw error;}
}

async function main() {
  const {authenticate,requestRpc,DEFAULT_ROOT:root,repo}=await import('./preview.mjs');
  await cliReport({repo,folder:'t202',prefix:'t202-connect-'},async()=>{
    const auth=await authenticate(root);
    return runT202ConnectBindings({rpc:(method,payload={})=>requestRpc(auth,method,payload),bindingIds:process.argv.slice(2),onPass:name=>console.log('PASS '+name)});
  });
}
if(isMain(import.meta.url))main().catch(error=>{console.error(String(error.message));process.exitCode=1;});
