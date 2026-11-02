#!/usr/bin/env node
// Read-only provenance audit and UNVERIFIED candidate generation. Never installs,
// writes the active lock, imports upstream code, or invokes prepare/start/RPC.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join,resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

const sourceFile=fileURLToPath(import.meta.url);
export const DEFAULT_ROOTS=Object.freeze({
 repo:resolve(dirname(sourceFile),'../..'),
 sdk:'/home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh',
 sidebar:'/home/ubuntu/.dsh/profiles/web/node_modules/dsh-better-sidebar',
});
const GROUPS=['gateway','sidebar','native_terminal','local_sdk','model_sdk','acp_sdk','remote_helper'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function within(root,file) {
 if(typeof file!=='string'||!file||isAbsolute(file)||file.includes('\\')||file.includes('\0')||file.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('Unsafe source-relative path');
 return join(resolve(root),file);
}
function validHash(hash) {
 if(typeof hash!=='string'||!/^[0-9a-f]{64}$/.test(hash))throw new Error('Invalid source SHA256');
}
function packageIdentity(bytes,expectedPackage) {
 const manifest=JSON.parse(bytes.toString('utf8'));
 const actual=manifest?.version??null,actualPackage=manifest?.name??null;
 const valid=typeof expectedPackage==='string'&&expectedPackage.trim()&&actualPackage===expectedPackage&&typeof actual==='string'&&actual.trim();
 return {actual,actualPackage,...valid?{}:{error:'manifest-identity-invalid'}};
}
function packageFromFile(lock,group,file) {
 if(file==='package.json')return lock[group].package;
 const parts=file.slice(0,-'/package.json'.length).split('/');
 const name=parts.slice(parts.lastIndexOf('node_modules')+1).join('/');
 return /^(@[^/]+\/)?[^/]+$/.test(name)?name:undefined;
}

export async function inspectSourceLock(lock,options={}) {
 const {repo,sdk,sidebar}={...DEFAULT_ROOTS,...options};
 const readBytes=options.readBytes??readFile;
 // One immutable byte snapshot per absolute path, shared by manifest identity,
 // version and hash checks. This is not an atomic snapshot across all files.
 const snapshots=new Map();
 const readSnapshot=path=>{
  const key=resolve(path);
  if(!snapshots.has(key))snapshots.set(key,Promise.resolve().then(()=>readBytes(key)).then(bytes=>Buffer.from(bytes)));
  return snapshots.get(key);
 };
 if(!lock.sdk?.package||!lock.sdk.version||Object.keys(lock).some(key=>key!=='sdk'&&!GROUPS.includes(key))||GROUPS.some(key=>!lock[key]?.files))throw new Error('Unrecognized source-lock inventory');
 const modules=join(sdk,'node_modules');
 const roots={sdk,gateway:within(modules,lock.gateway.package),sidebar,native_terminal:within(modules,lock.native_terminal.package),local_sdk:modules,model_sdk:modules,acp_sdk:modules,remote_helper:within(repo,lock.remote_helper.source)};
 const candidate=structuredClone(lock),versions=[],assets=[];
 const manifests=[['sdk',lock.sdk.package,sdk],['gateway',lock.gateway.package,roots.gateway],['sidebar',lock.sidebar.package,sidebar],['native_terminal',lock.native_terminal.package,roots.native_terminal],['acp_sdk','@agentclientprotocol/sdk',within(modules,'@agentclientprotocol/sdk')],['remote_helper',lock.remote_helper.package,roots.remote_helper]];
 for(const [group,expectedPackage,root] of manifests) {
  let actual=null,actualPackage=null,error;
  try {
   ({actual,actualPackage,error}=packageIdentity(await readSnapshot(join(root,'package.json')),expectedPackage));
   if(!error)candidate[group].version=actual;
  } catch(failure) {error=failure.code??'manifest-read-invalid';}
  versions.push({group,package:expectedPackage,expected:lock[group].version,actual,actualPackage,match:!error&&actual===lock[group].version,...error?{error}:{}});
 }
 async function inspectFile(group,file,expected,root) {
  validHash(expected);const path=within(root,file);
  let bytes;
  try {bytes=await readSnapshot(path);}
  catch(failure) {return {group,file,expected,actual:null,match:false,error:failure.code??'source-read-failed'};}
  const actual=sha(bytes);let manifest,error;
  if(file==='package.json'||file.endsWith('/package.json')) {
   const expectedPackage=packageFromFile(lock,group,file);
   try {manifest={package:expectedPackage,...packageIdentity(bytes,expectedPackage)};error=manifest.error;}
   catch {error='manifest-read-invalid';}
  }
  return {group,file,expected,actual,match:actual===expected&&!error,...manifest?{manifest}:{},...error?{error}:{}};
 }
 for(const group of GROUPS) {
  const files={...lock[group].files};
  if(group==='gateway') {
   if(Object.hasOwn(files,lock.gateway.source)&&files[lock.gateway.source]!==lock.gateway.sha256)throw new Error('Conflicting Gateway source hashes');
   files[lock.gateway.source]=lock.gateway.sha256;
  }
  for(const [file,expected] of Object.entries(files)) {
   const row=await inspectFile(group,file,expected,roots[group]);assets.push(row);
   if(!row.error) {
    if(Object.hasOwn(lock[group].files,file))candidate[group].files[file]=row.actual;
    if(group==='gateway'&&file===lock.gateway.source)candidate.gateway.sha256=row.actual;
   }
  }
 }
 const stock=lock.native_terminal.stock_patch;
 const stockPatch=await inspectFile('native_terminal',stock.file,stock.sha256,modules);
 if(!stockPatch.error)candidate.native_terminal.stock_patch.sha256=stockPatch.actual;
 const checks=[...versions,...assets,stockPatch];
 return {report:{ok:checks.every(row=>row.match),versions,assets,stockPatch,scope:'Provenance only; not compatibility, deployment, or recovery acceptance.'},candidate};
}

export function sourceCandidate(inspection,expectedSdkVersion) {
 if(typeof expectedSdkVersion!=='string'||!expectedSdkVersion.trim())throw new Error('Candidate generation requires --sdk-version VERSION');
 if(inspection.report.versions.find(row=>row.group==='sdk')?.actual!==expectedSdkVersion)throw new Error('Installed SDK does not match the explicit candidate target');
 if([...inspection.report.versions,...inspection.report.assets,inspection.report.stockPatch].some(row=>row.error))throw new Error('Cannot generate a candidate with missing, unreadable, or misidentified sources');
 // A candidate records bytes, not trust. Retain source inventories and helper
 // artifact identity; changed seams or helper bundles still need adaptation.
 return structuredClone(inspection.candidate);
}

export function parseSourceArgs(args) {
 if(args.length===1&&args[0]==='--help')return {mode:'help'};
 const result={mode:'check',json:false};let explicitMode=false;const seen=new Set();
 for(let i=0;i<args.length;i++) {
  const arg=args[i];if(seen.has(arg))throw new Error('Duplicate source-lock option: '+arg);seen.add(arg);
  if(arg==='--check'||arg==='--candidate') {
   if(explicitMode)throw new Error('Choose --check or --candidate, not both');
   result.mode=arg.slice(2);explicitMode=true;
  } else if(arg==='--json')result.json=true;
  else if(arg==='--sdk-version') {
   const value=args[++i];if(!value||value.startsWith('--'))throw new Error('--sdk-version requires VERSION');result.sdkVersion=value;
  } else throw new Error('Unknown source-lock option: '+arg);
 }
 if(result.mode==='candidate'&&(!result.sdkVersion||result.json))throw new Error('--candidate requires --sdk-version VERSION and already outputs JSON');
 if(result.mode==='check'&&result.sdkVersion)throw new Error('--sdk-version is only valid with --candidate');
 return result;
}

export function formatSourceReport(report) {
 const lines=[`Source lock: ${report.ok?'MATCH':'DRIFT'}; ${report.assets.filter(row=>row.match).length}/${report.assets.length} assets match`];
 for(const row of report.versions)lines.push(`${row.group}: recorded ${row.expected}, installed ${row.actual??'unavailable'} (${row.match?'match':row.error??'drift'})`);
 for(const row of [...report.assets,report.stockPatch].filter(row=>!row.match))lines.push(`${row.group}/${row.file}: ${row.error??`recorded ${row.expected}, installed ${row.actual}`}`);
 lines.push(`Native stock patch: ${report.stockPatch.match?'match':'drift'}`,report.scope);
 return lines.join('\n')+'\n';
}

async function main(args) {
 const options=parseSourceArgs(args);
 if(options.mode==='help') {
  process.stdout.write('Usage: node scripts/dev/source-lock.mjs [--check] [--json]\n       node scripts/dev/source-lock.mjs --candidate --sdk-version VERSION\nDefault: read-only audit; drift exits 1. Candidate: UNVERIFIED JSON to stdout only.\nNever writes the active lock, installs dependencies, or starts/deploys services.\nReview the diff and run compatibility/projection regressions before adopting a candidate.\n');return;
 }
 const lock=JSON.parse(await readFile(join(DEFAULT_ROOTS.repo,'profiles/agent-studio-preview/sources.lock.json'),'utf8'));
 const inspection=await inspectSourceLock(lock);
 if(options.mode==='candidate') {
  const candidate=sourceCandidate(inspection,options.sdkVersion);
  process.stderr.write('UNVERIFIED candidate only; review code/manifest changes and rerun compatibility/projection tests. No active lock or runtime was modified.\n'+formatSourceReport(inspection.report));
  process.stdout.write(JSON.stringify(candidate,null,2)+'\n');
 } else {
  process.stdout.write(options.json?JSON.stringify(inspection.report,null,2)+'\n':formatSourceReport(inspection.report));
  if(!inspection.report.ok)process.exitCode=1;
 }
}
if(process.argv[1]&&resolve(process.argv[1])===sourceFile)main(process.argv.slice(2)).catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
