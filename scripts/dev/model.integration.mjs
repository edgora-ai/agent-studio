#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,lstat} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {authenticate,requestRpc,start,stop,modelDemo,repo} from './preview.mjs';

const root=process.argv[2];if(!root) throw new Error('Pass the explicitly enabled offline fixture root');
const run=randomUUID(),output=repo+'/artifacts/d05/integration-'+run+'.json';
const report={scope:'D05 offline protocol fixture through installed adapter/native Agent; NOT real LLM acceptance',run,root,checks:[],failures:[]};
let auth,ids;const rpc=(m,p={})=>requestRpc(auth,m,p),native=(m,args={})=>requestRpc(auth,m,{args},'/api');
const sql=(query,...values)=>{const db=new DatabaseSync(root+'/bindings.sqlite',{readOnly:true});try{return db.prepare(query).all(...values).map(row=>({...row}));}finally{db.close();}};
const hash=value=>createHash('sha256').update(value).digest('hex');
const pass=(name,facts={})=>{report.checks.push({name,...facts});console.log('PASS '+name);};
const snapshot=async(session_id=ids.session_id)=>(await rpc('session.get',{session_id})).native.inspection.events;
async function absent(path) {try {await lstat(path);return false;}catch(error){if(error.code==='ENOENT')return true;throw error;}}
async function wait(check,timeout=45000) {const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await check();if(value)return value;await delay(100);}throw new Error('D05_WAIT_DEADLINE');}
async function select(sessionId) {await native('session/selectModel',{request:{sessionId,provider:'studio-model-offline',model:'offline-protocol-v1'}});}
async function submit(scenario,path,sessionId=ids.session_id) {
 const requestId=randomUUID(),text=`[D05 scenario:${scenario}]${path?' [D05 path:'+path+']':''} Explicit synthetic offline protocol test ${run}.`;
 assert.deepEqual(await native('session/prompt',{request:{requestId,sessionId,mode:'queue',content:[{type:'text',text}]}}),{accepted:true});return requestId;
}
async function done(requestId,sessionId=ids.session_id,answer) {
 await wait(async()=>{
  const row=(await rpc('model.requests',{session_id:sessionId})).find(r=>r.request_id===requestId);assert.ok(row);
  if(answer) for(const control of await rpc('model.controls',{session_id:sessionId})) if(control.request_id===requestId && control.state==='pending') await answer(control);
  return !['admitting','queued','running'].includes(row.state)&&row;
 });
 const row=sql('SELECT * FROM model_requests WHERE request_id=?',requestId)[0],events=await snapshot(sessionId),selected=events.filter(e=>e.data?.turn===row.turn);
 return {row,events:selected,results:selected.filter(e=>e.type==='tool/result')};
}
const reply=(control,answer)=>rpc('model.reply',{control_id:control.control_id,session_id:control.session_id,binding_id:control.binding_id,version:control.version,answer});
async function approve(control) {return reply(control,control.kind==='approval'?'allowed-once':{answers:[{id:'synthetic-choice',selected:['Synthetic A']}]});}
try {
 await mkdir(repo+'/artifacts/d05',{recursive:true});
 await stop(root);report.runtime=await start(root,'127.0.0.1');auth=await authenticate(root);ids=await modelDemo(root);
 const fixture=JSON.parse(await readFile(root+'/offline-model-fixture.json','utf8')),info=await rpc('model.describe');assert.equal(fixture.kind,'offline-protocol-fixture');
 const configured=await rpc('model.configure',{providers:{...info.providers,'studio-model-offline':{api:'openai-completions',apiKeyEnv:'STUDIO_MODEL_OFFLINE_API_KEY',baseURL:fixture.baseURL,models:[{id:'offline-protocol-v1',name:'Offline protocol fixture — NOT LLM',contextWindow:16000,maxTokens:2048,input:['text'],reasoningEfforts:false}]}},expected_revision:info.revision,expected_settings_revision:info.settings_revision});
 const key=await readFile(root+'/offline-fixture-credential.txt','utf8');await native('credentials/set',{ref:'STUDIO_MODEL_OFFLINE_API_KEY',value:key});
 const configRow=sql("SELECT * FROM model_configurations WHERE revision=?",configured.revision)[0];assert.equal(configRow.state,'active');assert.equal(configRow.config_sha256,hash(configRow.config_json));assert.deepEqual(JSON.parse(configRow.config_json).providers,(await rpc('model.describe')).providers);
 assert.equal((await native('credentials/describe',{refs:['STUDIO_MODEL_OFFLINE_API_KEY']})).STUDIO_MODEL_OFFLINE_API_KEY.configured,true);
 assert.ok(!JSON.stringify(configRow).includes(key));await select(ids.session_id);
 const catalog=await native('session/modelCatalog');assert.ok(JSON.stringify(catalog).includes('offline-protocol-v1'));
 pass('settings revision -> SQL metadata -> full descriptor -> original model catalog and selection',{revision:configured.revision,ids});
 for(const path of ['/agent-studio-rpc/model.describe','/agent-studio-rpc/model.reply','/api/session/prompt','/api/session/selectModel','/api/credentials/set']) {
  for(const cookie of [undefined,'invalid=synthetic']) {const response=await fetch(auth.origin+path,{method:'POST',headers:{'content-type':'application/json',origin:auth.origin,...(cookie?{cookie}:{})},body:'{}'});assert.equal(response.status,401);}
 }
 assert.equal((await fetch(auth.origin+'/agent-studio/health')).status,200);pass('public health 200; missing/wrong auth 401 on model and reply endpoints');
 const basic=await done(await submit('basic'));assert.equal(basic.row.state,'completed');const assistant=basic.events.find(e=>e.type==='assistant/message');assert.ok(JSON.stringify(assistant).includes('OFFLINE PROTOCOL FIXTURE COMPLETE'));assert.ok(assistant.data.stream.length>1);pass('accepted is followed by actual streamed native completion',{request_id:basic.row.request_id,stream_records:assistant.data.stream.length});
 const path='d05-'+run+'.txt';await rpc('fs.write',{session_id:ids.session_id,path,operation_id:randomUUID(),encoding:'utf8',data:'D05_ALPHA synthetic native input\n',expected_version:null});
 let approvals=0,questions=0;
 const toolRun=await done(await submit('tools',path),ids.session_id,async c=>{
  if(c.kind==='approval') {
   approvals++;assert.equal(sql('SELECT state FROM model_tool_calls WHERE session_id=? AND call_id=?',c.session_id,c.call_id)[0].state,'pending');
   const payload=JSON.parse(c.payload_json);if(payload.toolName==='write') assert.equal(await absent(ids.target_root+'/'+path+'.written'),true);
   await assert.rejects(rpc('model.reply',{control_id:c.control_id,session_id:c.session_id,binding_id:c.binding_id,version:c.version+1,answer:'allowed-once'}),e=>e.code==='agent-studio/control-binding-mismatch');
  } else questions++;
  await approve(c);await assert.rejects(approve(c),e=>e.code==='agent-studio/control-not-pending');
 });
 assert.equal(toolRun.row.state,'completed');assert.equal(toolRun.results.length,6);
 assert.deepEqual(toolRun.results.filter(e=>e.data.message.isError).map(e=>e.data),[]);
 assert.equal(approvals,3);assert.equal(questions,1);
 const physical=await readFile(ids.target_root+'/'+path,'utf8'),api=await rpc('fs.read',{session_id:ids.session_id,path});assert.equal(physical,'D05_BETA synthetic native input\n');assert.equal(Buffer.from(api.data,'base64').toString(),physical);assert.equal(api.sha256,hash(physical));
 assert.equal(await readFile(ids.target_root+'/'+path+'.written','utf8'),'D05_WRITTEN synthetic model tool bytes\n');
 assert.ok((await rpc('fs.search',{session_id:ids.session_id,query:'content:D05_BETA'})).hits.some(h=>h.path.endsWith(path)));
 const calls=sql('SELECT * FROM model_tool_calls WHERE request_id=?',toolRun.row.request_id),operations=sql('SELECT o.* FROM operation_records o JOIN model_tool_operations m USING(operation_id) JOIN model_tool_calls c ON c.session_id=m.session_id AND c.call_id=m.call_id WHERE c.request_id=?',toolRun.row.request_id);
 assert.equal(calls.length,6);assert.ok(calls.every(c=>c.state==='completed'));assert.ok(operations.some(o=>o.local_process_id));assert.ok(operations.some(o=>o.kind==='fs.write'));assert.ok(operations.every(o=>o.session_id===ids.session_id && o.binding_id===ids.binding_id));
 pass('native local read/edit/write/literal search/bash/questions; actual bytes, one-time approval and durable operation lineage',{request_id:toolRun.row.request_id,approvals,questions,operations:operations.length,path,sha256:api.sha256});
 const expiredPath='expired-'+run+'.txt',expiredId=await submit('write',expiredPath);
 const pending=await wait(async()=>(await rpc('model.controls',{session_id:ids.session_id})).find(c=>c.request_id===expiredId && c.state==='pending'));
 assert.equal(await absent(ids.target_root+'/'+expiredPath),true);
 const expired=await done(expiredId);assert.equal(expired.results[0].data.message.isError,true);assert.equal(sql('SELECT state FROM model_controls WHERE control_id=?',pending.control_id)[0].state,'expired');
 await assert.rejects(approve(pending),e=>e.code==='agent-studio/control-not-pending');assert.equal(await absent(ids.target_root+'/'+expiredPath),true);
 pass('server deadline denies unapproved write and late answer with no side effect',{control_id:pending.control_id});
 for(const scenario of ['error','truncated']) {const result=await done(await submit(scenario));assert.notEqual(result.row.state,'completed');assert.ok(!result.events.some(e=>e.type==='assistant/message' && JSON.stringify(e).includes('COMPLETE')));pass('native '+scenario+' is not successful completion',{request_id:result.row.request_id,state:result.row.state,error_code:result.row.error_code});}
 const cancelId=await submit('cancel');await wait(async()=>{
  const row=sql('SELECT * FROM model_requests WHERE request_id=?',cancelId)[0],events=(await readFile(root+'/offline-fixture-events.jsonl','utf8')).trim().split('\n').map(JSON.parse);
  return row.state==='running' && events.some(e=>e.kind==='request' && e.scenario==='cancel' && Date.parse(e.time)>=Date.parse(row.created_at));
 });await native('session/cancel',{request:{sessionId:ids.session_id}});const cancelled=await done(cancelId);assert.equal(cancelled.row.state,'cancelled');pass('native cancellation closes actual in-flight adapter stream',{request_id:cancelId});
 for(const content of [[{type:'file',receiptId:'synthetic-unbound'}],[{type:'image',mediaType:'image/png',data:'eA=='}],[{type:'unknown',text:'synthetic'}]]) await assert.rejects(native('session/prompt',{request:{requestId:randomUUID(),sessionId:ids.session_id,mode:'queue',content}}));
 const reference=await rpc('reference.create',{session_id:ids.session_id,path}),other=await rpc('session.create',{binding_id:ids.binding_id,version:ids.version,title:'D05 isolated same binding'});await select(other.session_id);
 const tampered=reference.text.replace(ids.binding_id,'binding-'+randomUUID());await assert.rejects(native('session/prompt',{request:{requestId:randomUUID(),sessionId:other.session_id,mode:'queue',content:[{type:'text',text:tampered}]}}),e=>e.code==='agent-studio/cross-binding-reference');
 pass('native attachment and unknown branches fail closed; cross-binding snapshot rejected before admission');
 const restartPath='restart-denied-'+run+'.txt',restartId=await submit('write',restartPath),oldControl=await wait(async()=>(await rpc('model.controls',{session_id:ids.session_id})).find(c=>c.request_id===restartId && c.state==='pending'));
 const counts=sql('SELECT count(*) n FROM model_tool_operations')[0].n,oldRequest=sql('SELECT * FROM model_requests WHERE request_id=?',toolRun.row.request_id)[0];
 await stop(root);report.restart=await start(root,'127.0.0.1');auth=await authenticate(root);await modelDemo(root);
 assert.equal((await rpc('model.describe')).revision,configured.revision);assert.deepEqual(sql('SELECT * FROM model_requests WHERE request_id=?',oldRequest.request_id)[0],oldRequest);
 await assert.rejects(approve(oldControl),e=>e.code==='agent-studio/control-not-pending');assert.equal(await absent(ids.target_root+'/'+restartPath),true);assert.equal(sql('SELECT count(*) n FROM model_tool_operations')[0].n,counts);
 const reopened=await snapshot();assert.ok(reopened.some(e=>e.type==='tool/result' && JSON.stringify(e).includes('D05_COMMAND_CWD')));
 assert.ok(JSON.stringify(await native('session/list',{_request:{}})).includes(ids.session_id));
 assert.equal(sql('PRAGMA integrity_check')[0].integrity_check,'ok');
 pass('restart keeps settings/selection/native history and SQL; old pending decisions never regain permission',{old_control:oldControl.control_id,old_state:sql('SELECT state FROM model_controls WHERE control_id=?',oldControl.control_id)[0].state,operations:counts});
 report.fixture={baseURL:fixture.baseURL,kind:fixture.kind};report.test_credentials_excluded=true;
} catch(error) {report.failures.push({name:'D05_NATIVE_INTEGRATION',code:error.code??null,message:error.message,stack:error.stack});process.exitCode=1;console.error(error);}
finally {await mkdir(repo+'/artifacts/d05',{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(output);}
