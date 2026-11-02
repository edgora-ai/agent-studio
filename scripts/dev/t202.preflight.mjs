#!/usr/bin/env node
// T-202 authorization preflight. Reads the private environment policy and
// validates proposed scopes offline; NEVER contacts Coder/SSH/network.
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {validateEnvironmentPolicy} from '../../packages/dsh-agent-studio/environment-state.mjs';

const root=new URL('../../.preview/agent-studio/',import.meta.url).pathname;
const policy=JSON.parse(await readFile(root+'environment-policy.json','utf8'));
const db=new DatabaseSync(root+'bindings.sqlite',{readOnly:true});
const requested=db.prepare('SELECT count(*) n FROM environment_requests').get().n;
db.close();
const minimal={...policy,read_only:false,actions:['start','stop']};
let minimalValid=false,error=null;
try {validateEnvironmentPolicy(minimal);minimalValid=true;} catch(failure) {error=failure.code??failure.name;}
const current={version:policy.version,transport:policy.transport,read_only:policy.read_only,actions:policy.actions,workspace_ids:policy.workspace_ids,
  template_version:(policy.templates??[])[0]?.template_version??null,template_version_id:(policy.templates??[])[0]?.version_id??null,
  observation_ttl_ms:policy.observation_ttl_ms,action_timeout_ms:policy.action_timeout_ms};
const report={kind:'t202-authorization-preflight',current,environment_requests:requested,
  proposals:{
    s_start_stop_existing:{description:'authorize start/stop for the existing m1-a workspace only; no create/rebuild/delete/credential action',
      policyPatch:{read_only:false,actions:['start','stop']},valid:minimalValid,error},
    c_one_controlled_create:{description:'separately authorize one create from the frozen lab-v3 template with fixed name and resource bounds, then a stop; no delete/rebuild',
      policyPatch:{read_only:false,actions:['create','start','stop']},requires:'additional explicit create authorization and target name/resource confirmation'}},
  offlineChecks:{currentReadOnly:policy.read_only===true,currentActionsEmpty:Array.isArray(policy.actions)&&policy.actions.length===0,
    noPendingEnvironmentRequests:requested===0,minimalPolicyValid:minimalValid},
  execution:{blocked:true,reason:'Coder lifecycle actions require explicit human authorization; current policy remains read-only and was not modified'},
  nonActions:['no policy file write','no Coder/SSH connection','no workspace create/start/stop','no credential read','no service restart']};
console.log(JSON.stringify(report,null,2));
