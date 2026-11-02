import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {DEFAULT_ROOTS,inspectSourceLock,sourceCandidate,parseSourceArgs,formatSourceReport} from './source-lock.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture() {
 const roots={repo:'/virtual/repo',sdk:'/virtual/sdk',sidebar:'/virtual/sidebar'},files=new Map(),reads=[];
 const lock={sdk:{package:'@fixture/sdk',version:'1.0.0'},gateway:{package:'@fixture/gateway',version:'1.0.0',source:'lib/index.js',files:{}},sidebar:{package:'fixture-sidebar',version:'2.0.0',files:{}},native_terminal:{package:'@fixture/terminal',version:'3.0.0',stock_patch:{file:'@fixture/web/cordis.patch.yml'},files:{}},local_sdk:{files:{}},model_sdk:{files:{}},acp_sdk:{version:'1.4.0',files:{}},remote_helper:{package:'fixture-helper',version:'4.0.0',source:'helper',helper_sha256:'a'.repeat(64),files:{}}};
 const modules=join(roots.sdk,'node_modules');
 const bases={sdk:roots.sdk,gateway:join(modules,lock.gateway.package),sidebar:roots.sidebar,native_terminal:join(modules,lock.native_terminal.package),local_sdk:modules,model_sdk:modules,acp_sdk:modules,remote_helper:join(roots.repo,'helper')};
 const put=(path,bytes)=>{files.set(path,Buffer.from(bytes));return sha(files.get(path));};
 const record=(group,file,bytes)=>{lock[group].files[file]=put(join(bases[group],file),bytes);};
 for(const group of ['sdk','gateway','sidebar','native_terminal','remote_helper']) {
  const bytes=JSON.stringify({name:lock[group].package,version:lock[group].version});
  if(group==='sdk')put(join(bases.sdk,'package.json'),bytes);else record(group,'package.json',bytes);
 }
 record('sidebar','lib/client.js','sidebar code');record('native_terminal','lib/client.terminal.js','native code');
 record('local_sdk','local/lib/index.js',Buffer.from([0,255,254,13,10]));record('model_sdk','model/lib/index.js','model code');
 record('acp_sdk','@agentclientprotocol/sdk/package.json',JSON.stringify({name:'@agentclientprotocol/sdk',version:lock.acp_sdk.version}));
 record('acp_sdk','@agentclientprotocol/sdk/dist/acp.js','acp code');record('remote_helper','helper.py','helper code');
 lock.gateway.sha256=put(join(bases.gateway,lock.gateway.source),'gateway code');
 lock.native_terminal.stock_patch.sha256=put(join(modules,lock.native_terminal.stock_patch.file),'stock patch');
 const options={...roots,async readBytes(path){reads.push(path);if(!files.has(path))throw Object.assign(new Error('missing fixture source'),{code:'ENOENT'});return files.get(path);}};
 return {lock,options,files,reads,bases,put};
}

test('read-only audit covers all groups, independent versions, binary bytes and stock patch',async()=>{
 const f=fixture(),before=structuredClone(f.lock),{report,candidate}=await inspectSourceLock(f.lock,f.options);
 assert.equal(report.ok,true);assert.equal(report.versions.length,6);assert.equal(report.assets.length,12);
 assert.ok(report.assets.every(row=>row.match));assert.equal(report.stockPatch.match,true);
 assert.deepEqual(candidate,before);assert.deepEqual(f.lock,before);
 assert.match(report.scope,/not compatibility, deployment, or recovery acceptance/);
 assert.match(formatSourceReport(report),/12\/12 assets match/);
});

test('future SDK release is version drift, not a permanent unsupported-version assumption',async()=>{
 const f=fixture();f.put(join(f.bases.sdk,'package.json'),JSON.stringify({name:f.lock.sdk.package,version:'1.1.0'}));
 const inspection=await inspectSourceLock(f.lock,f.options);
 assert.equal(inspection.report.ok,false);assert.equal(inspection.report.versions[0].actual,'1.1.0');
 const candidate=sourceCandidate(inspection,'1.1.0');assert.equal(candidate.sdk.version,'1.1.0');
 assert.equal(f.lock.sdk.version,'1.0.0');assert.equal((await inspectSourceLock(candidate,f.options)).report.ok,true);
});

test('candidate captures changed code without claiming compatibility or changing inventories',async()=>{
 const f=fixture(),path=join(f.bases.gateway,f.lock.gateway.source);f.put(path,'new gateway seam, not yet reviewed');
 const inspection=await inspectSourceLock(f.lock,f.options),candidate=sourceCandidate(inspection,'1.0.0');
 assert.equal(inspection.report.ok,false);assert.notEqual(candidate.gateway.sha256,f.lock.gateway.sha256);
 assert.deepEqual(Object.keys(candidate.gateway.files),Object.keys(f.lock.gateway.files));
 assert.equal(candidate.remote_helper.helper_sha256,f.lock.remote_helper.helper_sha256);
 assert.match(inspection.report.scope,/Provenance only/);
});

test('manifest drift updates both independent version metadata and its exact byte hash in candidate',async()=>{
 const f=fixture();f.put(join(f.bases.native_terminal,'package.json'),JSON.stringify({name:f.lock.native_terminal.package,version:'3.1.0'}));
 const inspection=await inspectSourceLock(f.lock,f.options),candidate=sourceCandidate(inspection,'1.0.0');
 assert.equal(candidate.native_terminal.version,'3.1.0');assert.equal(candidate.sdk.version,'1.0.0');
 assert.notEqual(candidate.native_terminal.files['package.json'],f.lock.native_terminal.files['package.json']);
 assert.equal((await inspectSourceLock(candidate,f.options)).report.ok,true);
});

test('stock patch drift is reported separately and requires subsequent seam regression',async()=>{
 const f=fixture();f.put(join(f.options.sdk,'node_modules',f.lock.native_terminal.stock_patch.file),'changed stock patch');
 const inspection=await inspectSourceLock(f.lock,f.options);
 assert.equal(inspection.report.ok,false);assert.equal(inspection.report.stockPatch.match,false);
 assert.match(formatSourceReport(inspection.report),/Native stock patch: drift/);
 assert.notEqual(sourceCandidate(inspection,'1.0.0').native_terminal.stock_patch.sha256,f.lock.native_terminal.stock_patch.sha256);
});

test('wrong package identity refuses candidate generation even when bytes are readable',async()=>{
 const f=fixture();f.put(join(f.bases.gateway,'package.json'),JSON.stringify({name:'wrong-package',version:'1.0.0'}));
 const inspection=await inspectSourceLock(f.lock,f.options);
 assert.equal(inspection.report.ok,false);assert.equal(inspection.report.versions[1].error,'manifest-identity-invalid');
 assert.throws(()=>sourceCandidate(inspection,'1.0.0'),/misidentified sources/);
});

test('missing files and malformed manifests cannot be silently baselined',async()=>{
 const f=fixture();f.files.delete(join(f.bases.gateway,f.lock.gateway.source));
 f.put(join(f.bases.sdk,'package.json'),'not json');const inspection=await inspectSourceLock(f.lock,f.options);
 assert.equal(inspection.report.ok,false);assert.ok(inspection.report.assets.some(row=>row.error==='ENOENT'));
 assert.equal(inspection.report.versions[0].error,'manifest-read-invalid');
 assert.throws(()=>sourceCandidate(inspection,'1.0.0'),/explicit candidate target/);
 f.put(join(f.bases.sdk,'package.json'),JSON.stringify({name:f.lock.sdk.package,version:'1.0.0'}));
 const missing=await inspectSourceLock(f.lock,f.options);
 assert.throws(()=>sourceCandidate(missing,'1.0.0'),/missing, unreadable/);
});

test('candidate requires the explicit installed target and does not share mutable lock references',async()=>{
 const f=fixture(),inspection=await inspectSourceLock(f.lock,f.options);
 assert.throws(()=>sourceCandidate(inspection),/requires --sdk-version/);
 assert.throws(()=>sourceCandidate(inspection,'not-installed'),/explicit candidate target/);
 const candidate=sourceCandidate(inspection,'1.0.0');candidate.gateway.files['package.json']='changed';
 assert.notEqual(inspection.candidate.gateway.files['package.json'],'changed');assert.notEqual(f.lock.gateway.files['package.json'],'changed');
});

test('unsafe relative paths, unrecognized groups and invalid hashes fail rather than reading outside roots',async()=>{
 for(const file of ['../escape','/absolute','lib/../escape','lib\\escape','lib//escape','lib/./escape','bad\0path']) {
  const f=fixture();f.lock.local_sdk.files={[file]:'a'.repeat(64)};
  await assert.rejects(inspectSourceLock(f.lock,f.options),/Unsafe source-relative path/);
  assert.ok(f.reads.every(path=>f.files.has(path)));
 }
 const f=fixture();await assert.rejects(inspectSourceLock({...f.lock,unexpected:{files:{}}},f.options),/inventory/);
 f.lock.gateway.sha256='not a hash';await assert.rejects(inspectSourceLock(f.lock,f.options),/Invalid source SHA256/);
});

test('duplicate Gateway source entries must agree and are audited only once',async()=>{
 const f=fixture();f.lock.gateway.files[f.lock.gateway.source]=f.lock.gateway.sha256;
 const inspection=await inspectSourceLock(f.lock,f.options);assert.equal(inspection.report.assets.length,12);
 f.lock.gateway.files[f.lock.gateway.source]='0'.repeat(64);
 await assert.rejects(inspectSourceLock(f.lock,f.options),/Conflicting Gateway/);
});

test('CLI defaults to check; candidate, target and argument combinations are explicit',()=>{
 assert.deepEqual(parseSourceArgs([]),{mode:'check',json:false});assert.equal(parseSourceArgs(['--help']).mode,'help');
 assert.deepEqual(parseSourceArgs(['--candidate','--sdk-version','1.2.3']),{mode:'candidate',json:false,sdkVersion:'1.2.3'});
 for(const args of [['--candidate'],['--sdk-version','1.2.3'],['--candidate','--sdk-version'],['--check','--candidate'],['--json','--json'],['--unknown'],['--candidate','--sdk-version','1.2.3','--json']])assert.throws(()=>parseSourceArgs(args));
});

test('manifest version and its hash come from one byte snapshot during a concurrent swap',async()=>{
 const f=fixture(),path=join(f.bases.native_terminal,'package.json');let calls=0;
 const options={...f.options,async readBytes(target) {
  if(resolve(target)!==resolve(path))return f.options.readBytes(target);
  calls++;const version=calls===1?f.lock.native_terminal.version:'9.9.9';
  return Buffer.from(JSON.stringify({name:f.lock.native_terminal.package,version}));
 }};
 const inspection=await inspectSourceLock(f.lock,options),candidate=sourceCandidate(inspection,'1.0.0');
 assert.equal(calls,1);assert.equal(inspection.report.versions[3].actual,'3.0.0');
 assert.equal(candidate.native_terminal.version,'3.0.0');
 assert.equal(candidate.native_terminal.files['package.json'],f.lock.native_terminal.files['package.json']);
 assert.equal(inspection.report.ok,true);
});

test('every locked package manifest is identity-checked, not only the six version roots',async()=>{
 const f=fixture(),path=join(f.options.sdk,'node_modules','@fixture/local','package.json');
 const write=value=>{f.files.set(path,Buffer.from(JSON.stringify(value)));f.lock.local_sdk.files['@fixture/local/package.json']=sha(f.files.get(path));};
 write({name:'@fixture/local',version:'0.1.0'});
 const inspection=await inspectSourceLock(f.lock,f.options);
 const row=inspection.report.assets.find(item=>item.file==='@fixture/local/package.json');
 assert.equal(inspection.report.ok,true);assert.equal(row.manifest.actual,'0.1.0');assert.equal(row.manifest.actualPackage,'@fixture/local');
 f.files.set(path,Buffer.from('not json'));f.lock.local_sdk.files['@fixture/local/package.json']=sha(f.files.get(path));
 const broken=await inspectSourceLock(f.lock,f.options);
 assert.equal(broken.report.ok,false);
 assert.equal(broken.report.assets.find(item=>item.file==='@fixture/local/package.json').error,'manifest-read-invalid');
 assert.throws(()=>sourceCandidate(broken,'1.0.0'),/missing, unreadable/);
 write({name:'@fixture/other',version:'0.1.0'});
 const wrong=await inspectSourceLock(f.lock,f.options);
 assert.equal(wrong.report.assets.find(item=>item.file==='@fixture/local/package.json').error,'manifest-identity-invalid');
 assert.throws(()=>sourceCandidate(wrong,'1.0.0'),/missing, unreadable/);
});

test('actual installed baseline passes without hardcoding a release or importing operational entrypoints',async()=>{
 const lock=JSON.parse(await readFile(join(DEFAULT_ROOTS.repo,'profiles/agent-studio-preview/sources.lock.json'),'utf8'));
 const inspection=await inspectSourceLock(lock);assert.equal(inspection.report.ok,true,formatSourceReport(inspection.report));
 assert.deepEqual(sourceCandidate(inspection,lock.sdk.version),lock);
});

test('CLI audit and candidate never write the active lock; candidate is explicitly unverified',async()=>{
 const path=join(DEFAULT_ROOTS.repo,'profiles/agent-studio-preview/sources.lock.json'),before=await readFile(path),lock=JSON.parse(before);
 const script=fileURLToPath(new URL('./source-lock.mjs',import.meta.url));
 const run=args=>spawnSync(process.execPath,[script,...args],{encoding:'utf8',timeout:10000});
 const check=run(['--json']);assert.equal(check.status,0,check.stderr);assert.equal(JSON.parse(check.stdout).ok,true);
 const candidate=run(['--candidate','--sdk-version',lock.sdk.version]);assert.equal(candidate.status,0,candidate.stderr);
 assert.deepEqual(JSON.parse(candidate.stdout),lock);assert.match(candidate.stderr,/UNVERIFIED candidate only/);
 const wrong=run(['--candidate','--sdk-version','not-installed']);assert.equal(wrong.status,1);assert.equal(wrong.stdout,'');
 assert.deepEqual(await readFile(path),before);
});
