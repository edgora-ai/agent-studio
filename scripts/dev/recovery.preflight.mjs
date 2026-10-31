import assert from 'node:assert/strict';
import {readFile,writeFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {repo,DEFAULT_ROOT,stop,start,authenticate,requestRpc} from './preview.mjs';
import {projectSidebar} from './sidebar-projection.mjs';

const root=DEFAULT_ROOT,run=randomUUID(),out=join(repo,'artifacts/d08/preflight-'+run+'.json'),baselineFile=join(repo,'artifacts/d08/schema7-baseline.json');
const report={scope:'D08 owned deployment + schema7 preservation + read-only connection/capability preflight. No workload, no platform mutation.',run,checks:[]};
const db=new DatabaseSync(join(root,'bindings.sqlite'),{readOnly:true}),sql=(query,...args)=>db.prepare(query).all(...args).map(row=>({...row}));
const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const rows=table=>sql('SELECT * FROM '+table).map(row=>digest(Object.fromEntries(Object.entries(row).sort(([a],[b])=>a.localeCompare(b))))).sort();
const pass=(name,data={})=>{report.checks.push({name,...data});console.log('PASS '+name);};
try{
 let baseline;
 try{baseline=JSON.parse(await readFile(baselineFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;
  assert.equal(sql('PRAGMA user_version')[0].user_version,7);assert.equal(sql("SELECT count(*) n FROM operation_records WHERE state IN ('pending','running')")[0].n,0);
  const tables=sql("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_migrations','deployment','audit_events') ORDER BY name").map(row=>row.name);
  baseline={schema:7,tables:Object.fromEntries(tables.map(table=>[table,rows(table)])),unknown:sql("SELECT * FROM operation_records WHERE state='unknown' ORDER BY operation_id").map(row=>({operation_id:row.operation_id,sha256:digest(row)})),log_bytes:(await lstat(join(root,'preview.log'))).size};
  assert.equal(baseline.unknown.length,13);await writeFile(baselineFile,JSON.stringify(baseline,null,2)+'\n',{flag:'wx',mode:0o600});assert.deepEqual(JSON.parse(await readFile(baselineFile,'utf8')),baseline);
 }
 const files=['store.mjs','recovery-state.mjs','task-recovery.mjs','recovery-sidebar.mjs','index.mjs','bindings.mjs','adapters/helper-channel.mjs','adapters/bound-provider.mjs','adapters/local-provider.mjs','adapters/agent-terminal.mjs','adapters/host.mjs','adapters/bound-reads.mjs'];
 for(const file of files)assert.equal(spawnSync(process.execPath,['--check',join(repo,'packages/dsh-agent-studio',file)],{encoding:'utf8'}).status,0,file);
 for(const file of ['lib/client.js','lib/client-registry.js','lib/client-editor.js','lib/client-terminal.js']){const projected=projectSidebar(file,await readFile('/home/ubuntu/.dsh/profiles/web/node_modules/dsh-better-sidebar/'+file));assert.equal(spawnSync(process.execPath,['--check','--input-type=module'],{input:projected,encoding:'utf8'}).status,0,file);}
 pass('affected ESM and all four original sidebar projection chunks parse',{esm:files.length,chunks:4});
 if(process.argv.includes('--deploy')){const previous=JSON.parse(await readFile(join(root,'ready.json'),'utf8'));await stop(root);report.runtime=await start(root,new URL(previous.origin).hostname);}
 const auth=await authenticate(root),rpc=(method,input={})=>requestRpc(auth,method,input);
 assert.equal(sql('PRAGMA user_version')[0].user_version,8);assert.equal(sql('PRAGMA integrity_check')[0].integrity_check,'ok');
 for(const [table,hashes] of Object.entries(baseline.tables))assert.deepEqual(rows(table),hashes,'Schema7 complete row hashes changed: '+table);
 assert.deepEqual(sql("SELECT * FROM operation_records WHERE state='unknown' ORDER BY operation_id").map(row=>({operation_id:row.operation_id,sha256:digest(row)})),baseline.unknown);
 pass('schema7 old table complete-row multisets and all 13 unknown rows preserved across schema8 migration',{schema:8,tables:Object.fromEntries(Object.entries(baseline.tables).map(([name,value])=>[name,value.length])),unknown:13});
 const endpoints=['task.preflight','task.recovery','task.recoveries','task.recover','task.detach'];
 for(const method of endpoints)for(const cookie of ['', 'invalid']){const response=await fetch(auth.origin+'/agent-studio-rpc/'+method,{method:'POST',headers:{'content-type':'application/json',origin:auth.origin,...(cookie?{cookie}:{})},body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method,payload:{}})});assert.equal(response.status,401);}
 assert.equal((await fetch(auth.origin+'/agent-studio/health')).status,200);assert.equal((await fetch(auth.origin+'/',{redirect:'manual'})).status,401);
 pass('public health 200; protected root and new recovery endpoints absent/wrong authentication 401',{protected_checks:endpoints.length*2});
 const before=sql('SELECT count(*) n FROM operation_records')[0].n;
 const directory=await rpc('environment.discover');assert.equal(directory.read_only,true);assert.deepEqual(directory.actions,[]);
 const session_id='session-e5dea400-7d8d-4f76-8296-4269325fdf30';
 const startMs=Date.now();report.preflight=await rpc('task.preflight',{session_id});assert.equal(report.preflight.processes_started,0);assert.equal(report.preflight.workspace_opened,false);assert(report.preflight.retention_ms>=30000);assert(report.preflight.resume_supported);assert.equal(sql('SELECT count(*) n FROM operation_records')[0].n,before);
 pass('real official transport + same-channel identity + helper resume capability, with no workspace open or business process',{elapsed_ms:Date.now()-startMs,...report.preflight});
 const original='966626f2-738a-4c34-a38d-2b90f8c12072',old=sql('SELECT * FROM operation_records WHERE operation_id=?',original)[0],view=await rpc('task.recovery',{session_id:old.session_id,operation_id:original});
 assert.deepEqual(view.operation,old);assert.equal(view.reason,'recovery-identity-incomplete');assert.equal(view.eligible,false);assert((await rpc('task.recoveries',{session_id:old.session_id})).some(value=>value.operation.operation_id===original&&value.reason==='recovery-identity-incomplete'));
 pass('legacy original operation SQL -> complete recovery API -> searchable list; identity incomplete not adopted',{operation_id:original,eligible:false});
 const profile=join(root,'dsh/profiles/agent-studio-preview/studio');for(const file of files)assert.equal(digest(await readFile(join(profile,file))),digest(await readFile(join(repo,'packages/dsh-agent-studio',file))));
 assert.equal(sql('SELECT count(*) n FROM environment_requests')[0].n,0);
 report.log={previous_bytes:baseline.log_bytes,current_bytes:(await lstat(join(root,'preview.log'))).size};
 pass('affected deployed sources match; real lifecycle requests remain zero',{files:files.length,log:report.log});
 report.status='pass-readonly-no-task-started';
}catch(error){report.status='D08_PREFLIGHT_FAILED';report.error={code:error.code??error.name,message:error.message};process.exitCode=1;}
finally{db.close();await writeFile(out,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({report:out,status:report.status,checks:report.checks.length,error:report.error}));}
