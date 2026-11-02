import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,statSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {agentTransitions,outageWindows,channelLosses,brokerFailures,unknownOperations,incidentReport,formatReport} from './remote-diagnostics.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const observation=(at,agent,lifecycle='running',build='running')=>({observed_at:at,status_json:JSON.stringify({agent,lifecycle,build:{status:build}})});
const event=(at,action,outcome,details)=>({created_at:at,action,outcome,details_json:JSON.stringify(details),resource_id:details.resource_id});
const operation=(id,state,session,error,at)=>({operation_id:id,kind:'command.exec',session_id:session,state,error_code:error,created_at:at});

function fixtureRows() {
  const observations=[
    observation('2026-11-02T12:50:00.000Z',{status:'connected',disconnected_at:'2026-10-31T03:02:20.084Z',last_connected_at:'2026-11-02T12:49:59.000Z'}),
    observation('2026-11-02T12:50:15.000Z',{status:'connected',disconnected_at:'2026-10-31T03:02:20.084Z',last_connected_at:'2026-11-02T12:50:14.000Z'}),
    observation('2026-11-02T12:54:35.000Z',{status:'connected',disconnected_at:'2026-11-02T12:54:20.435Z',last_connected_at:'2026-11-02T12:54:24.994Z'}),
    observation('2026-11-02T13:18:00.000Z',{status:'connected',disconnected_at:'2026-11-02T12:54:20.435Z',last_connected_at:'2026-11-02T13:17:59.997Z'}),
    observation('2026-11-02T13:50:29.000Z',{status:'connected',disconnected_at:'2026-11-02T13:19:25.011Z',last_connected_at:'2026-11-02T13:50:27.556Z'}),
  ];
  const events=[
    event('2026-11-02T13:19:15.201Z','channel.lost','unknown',{reason:'helper-call-timeout',stage:'helper-rpc-close',channel_id:'chan-a',helper_session_id:'helper-a'}),
    event('2026-11-02T13:19:18.817Z','channel.lost','unknown',{reason:'helper-stdout-ended',stage:'helper-rpc-close',channel_id:'chan-a',helper_session_id:'helper-a'}),
    event('2026-11-02T13:19:18.828Z','environment.unavailable','paused',{reason:'helper-stdout-ended'}),
    event('2026-11-02T13:19:18.864Z','transport.diagnostic','observed',{layer:'broker',mode:'connect',exit_code:255,signal:null,close_observed:true,duration_ms:26755,stderr_bytes:0,stderr_sha256:'e3b0',broker_pid:1}),
    event('2026-11-02T13:19:19.000Z','transport.diagnostic','observed',{layer:'broker',mode:'check',exit_code:0,signal:null,duration_ms:365}),
    event('2026-11-02T13:19:19.100Z','transport.diagnostic','observed',{layer:'helper-rpc',method:'fs/list'}),
    event('2026-11-02T13:54:22.357Z','transport.diagnostic','observed',{layer:'broker',mode:'connect',exit_code:0,signal:null,duration_ms:17987}),
  ];
  const operations=[operation('op-1','unknown','session-a','helper-stdout-ended','2026-11-02T12:52:41.258Z'),
    operation('op-2','unknown','session-a','helper-call-timeout','2026-11-02T13:19:05.188Z'),
    operation('op-3','released','session-b',null,'2026-11-02T13:54:31.000Z')];
  return {observations,events,operations};
}

test('agent transitions collapse repeated observations and keep disconnect changes',()=>{
  const transitions=agentTransitions(fixtureRows().observations);
  assert.equal(transitions.length,3);
  assert.deepEqual(transitions.map(t=>t.disconnected_at),
    ['2026-10-31T03:02:20.084Z','2026-11-02T12:54:20.435Z','2026-11-02T13:19:25.011Z']);
  assert.equal(transitions[1].agent_status,'connected');
  assert.equal(transitions[1].workspace_lifecycle,'running');
});

test('outage windows separate a brief blip from the long disconnect',()=>{
  const windows=outageWindows(fixtureRows().observations);
  assert.equal(windows.length,2);
  const short=windows.find(w=>w.disconnected_at==='2026-11-02T12:54:20.435Z');
  const long=windows.find(w=>w.disconnected_at==='2026-11-02T13:19:25.011Z');
  assert.equal(short.recovered_at,'2026-11-02T12:54:24.994Z');
  assert.equal(short.duration_ms,4559);
  assert.equal(short.recovered,true);
  assert.equal(long.recovered_at,'2026-11-02T13:50:27.556Z');
  assert.equal(long.duration_ms,1862545);
  assert.equal(long.lifecycle,'running');
});

test('unresolved outage has no fabricated recovery time',()=>{
  const windows=outageWindows([observation('2026-11-02T14:00:00.000Z',{status:'disconnected',disconnected_at:'2026-11-02T13:59:00.000Z',last_connected_at:'2026-11-02T13:58:58.000Z'})]);
  assert.equal(windows[0].recovered,false);
  assert.equal(windows[0].recovered_at,null);
  assert.equal(windows[0].duration_ms,60000);
});

test('channel loss and broker failure extraction ignores unrelated actions and successful connects',()=>{
  const rows=fixtureRows();
  const losses=channelLosses(rows.events);
  assert.deepEqual(losses.map(l=>l.action),['channel.lost','channel.lost','environment.unavailable']);
  assert.equal(losses[0].reason,'helper-call-timeout');
  assert.equal(losses[2].reason,'helper-stdout-ended');
  const failures=brokerFailures(rows.events);
  assert.equal(failures.length,1);
  assert.equal(failures[0].mode,'connect');
  assert.equal(failures[0].exit_code,255);
  assert.equal(failures[0].stderr_bytes,0);
});

test('unknown operations stay counted and grouped without rewriting',()=>{
  const unknown=unknownOperations(fixtureRows().operations);
  assert.equal(unknown.count,2);
  assert.deepEqual(unknown.by_day,[{day:'2026-11-02',count:2}]);
  assert.deepEqual(unknown.by_session,[{session_id:'session-a',count:2}]);
  assert.deepEqual(unknown.operations.map(o=>o.operation_id),['op-1','op-2']);
});

test('incident report correlates channel losses and broker failures inside the outage window',()=>{
  const report=incidentReport(fixtureRows());
  const long=report.correlation.find(item=>item.disconnected_at==='2026-11-02T13:19:25.011Z');
  assert.equal(long.recovered,true);
  assert.equal(long.precursor_losses,3);
  assert.equal(long.losses_in_window,0);
  assert.equal(long.precursor_broker_failures,1);
  assert.equal(long.broker_failures_in_window,0);
  assert.match(formatReport(report),/Agent outage: disconnect 2026-11-02T13:19:25.011Z/);
  assert.match(formatReport(report),/Unknown operations: 2/);
  assert.match(report.scope,/Read-only correlation/);
});

test('actual private store is only read and reproduces today\'s agent outage',async t=>{
  const db='.preview/agent-studio/bindings.sqlite';
  if(!existsSync(db)){t.skip('private preview store absent');return;}
  const before=statSync(db);
  const bytesBefore=sha(await readFile(db));
  const script=resolve('scripts/dev/remote-diagnostics.mjs');
  const run=spawnSync(process.execPath,[script,'--json'],{encoding:'utf8',timeout:60000});
  assert.equal(run.status,0,run.stderr);
  const report=JSON.parse(run.stdout);
  const after=statSync(db);
  assert.equal(sha(await readFile(db)),bytesBefore,'read-only diagnostics must not modify the store');
  assert.equal(after.mtimeMs,before.mtimeMs,'read-only diagnostics must not touch mtime');
  const outage=report.outages.find(item=>item.disconnected_at==='2026-11-02T13:19:25.011609Z');
  assert.ok(outage,'current store should retain the 2026-11-02 agent outage');
  assert.equal(outage.recovered,true);
  assert.ok(outage.duration_ms>1800000);
  assert.ok(report.unknown_operations.count>=13);
  assert.ok(report.broker_failures.some(item=>item.exit_code===255));
  assert.match(formatReport(report),/Agent outage/);
});

test('CLI rejects unknown options and documents the read-only contract',()=>{
  const script=resolve('scripts/dev/remote-diagnostics.mjs');
  const bad=spawnSync(process.execPath,[script,'--bogus'],{encoding:'utf8',timeout:30000});
  assert.equal(bad.status,1);
  assert.match(bad.stderr,/Unknown remote-diagnostics option/);
  const help=spawnSync(process.execPath,[script,'--help'],{encoding:'utf8',timeout:30000});
  assert.equal(help.status,0);
  assert.match(help.stdout,/Never connects to Coder\/SSH/);
});
