// One actual same-instance recovery. Installed raw RPC + installer, frozen T105 gate.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { installNetworkGuard } from './network_guard.mjs';
import { sha256, safeError } from './t106_provider.mjs';
import { RecoveringProvider } from './t107_repair_recovery.mjs';
import { DeadlinePolicy, POLICY, DISCOVERY_CONTRACT } from './t107_repair_policy.mjs';
const [candidate, dsh, run, alias] = process.argv.slice(2);
const { token } = JSON.parse(readFileSync(join(run, 'plan.json')));
const binding = JSON.parse(readFileSync(join(run, 'current-records.json')))['m1-a'];
assert.ok(process.permission); assert.equal(process.env.HOME, join(run, 'home'));
const url = p => pathToFileURL(p).href, attempts = installNetworkGuard();
const hook = registerHooks({ resolve(s, c, next) { return next(s === 'dsh-ssh-remote' ? url(join(candidate, 'lib/index.js')) : s, c); } });
const { Context } = await import(url(join(dsh, 'node_modules/@deepseek-ai/cordis/lib/index.js')));
const { default: LocalFileSystem } = await import(url(join(dsh, 'node_modules/@deepseek-ai/dsh-fs-local/lib/index.js')));
const { default: LocalSubprocessRuntime } = await import(url(join(dsh, 'node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js')));
const entry = await import('./ssh_remote_entry.mjs');
const { RemoteHelperRpcClient } = await import(url(join(candidate, 'lib/helper/rpc-client.js')));
const { buildHelperConnectCommand, buildSystemSshArgs } = await import(url(join(candidate, 'lib/helper/installer.js')));
const report = { task: 'T-107-repair1', calls: [], cases: [], observations: [], storedFiles: [], cleanupErrors: [],
  policy: POLICY, discovery: DISCOVERY_CONTRACT, mutationReplayEnabled: false,
  scope: 'healthy same-instance retained helper session; non-PTY original task status/cancel only; no output-cursor/PTY recovery or M3 claim' };
const ctx = new Context(); ctx.logger.exporter({ levels: { default: 4 }, export: () => {} });
let fsFiber, subFiber, pluginFiber, provider, project, task, policyTask;
const transports = [];
async function connect(session, budget = 20000) {
  const child = spawn(join(run, 'bin/ssh'), buildSystemSshArgs(alias, buildHelperConnectCommand('c853353b330d790813fdd2a2d641c9a4738c6b96f50b53c2f4aa53acec31901f')), { stdio: ['pipe', 'pipe', 'pipe'] });
  const transport = { child, stderrBytes: 0, ended: false }; transports.push(transport);
  transport.closed = new Promise(resolve => child.once('close', (code, signal) => { transport.ended = true; transport.exit = { code, signal }; resolve(); }));
  child.stderr.on('data', b => { transport.stderrBytes += b.length; });
  const raw = new RemoteHelperRpcClient({ readable: child.stdout, writable: child.stdin,
    closeTransport: () => { if (!transport.ended) child.kill('SIGTERM'); }, helloTimeoutMs: budget });
  transport.raw = raw;
  child.once('error', e => raw.transportClosed(e)); child.once('close', () => raw.transportClosed(new Error('owned transport closed')));
  try {
    await raw.initialize({ clientId: session?.clientId ?? randomUUID(), clientName: 't107-repair1', clientVersion: '1',
      ...(session ? { resumeToken: session.resumeToken } : {}), retentionMs: 600000 },
      { timeoutMs: Math.min(15000, budget), signal: AbortSignal.timeout(Math.max(1, Math.floor(budget))) });
    return raw;
  } catch (error) { raw.close('connect failed'); throw error; }
}
async function close(raw) {
  const row = transports.find(t => t.raw === raw); raw.close('intentional owned transport disconnect');
  await Promise.race([row.closed, delay(7000).then(() => { if (!row.ended) throw new Error('T107_TRANSPORT_EXIT_DEADLINE'); })]);
  assert.ok(row.ended);
}
async function observe(label, request = {}) {
  const path = join(run, 'observe-' + label + '.request.json');
  writeFileSync(path, JSON.stringify({ label, ...request }), { flag: 'wx' });
  const response = path.replace('.request.', '.response.'); const end = performance.now() + 18000;
  while (!existsSync(response) && performance.now() < end) await delay(25);
  const value = JSON.parse(readFileSync(response)); assert.ok(!value.error);
  report.observations.push({ label, path: response }); return value;
}
function workload(observation) { const rows = observation.remote.processes.filter(p => p.kind === 'workload'); assert.equal(rows.length, 1); return rows[0]; }
try {
  fsFiber = ctx.plugin(LocalFileSystem, { cwd: join(run, 'workspace') }); await fsFiber;
  subFiber = ctx.plugin(LocalSubprocessRuntime); await subFiber;
  pluginFiber = ctx.plugin(entry, { hosts: [] }); await pluginFiber;
  const helpers = ctx.get('sshRemote').helpers;
  // Do not call manager.connectHost: its fallback may create a replacement session.
  await helpers.installer.install(alias);
  const raw = await connect();
  provider = new RecoveringProvider(raw, token, binding, { audit: report.calls });
  ({ project } = await provider.createRun());
  const bytes = Buffer.from('import sys,signal,time,json,os\nsignal.alarm(50)\nmode,token,op=sys.argv[1:]\nf=os.open("effect.jsonl",os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)\nos.write(f,(json.dumps({"token":token,"operationId":op,"pid":os.getpid()})+"\\n").encode());os.fsync(f);os.close(f)\nprint("READY",flush=True)\ntime.sleep(45)\n');
  await project.write('probe.py', bytes);
  const operationId = randomUUID(), argv = ['python3', '-I', project.root + '/probe.py', 'recovery', token, operationId];
  const policy = new DeadlinePolicy({ taskMs: 20000, approvalMs: 20 });
  let original;
  // Admission precedes dispatch, not a later read/wait. Identity unavailable at
  // expiry is unknown, never assumed cancelled or automatically restarted.
  policyTask = policy.task(() => provider.cancelOriginal(original));
  task = await project.start(argv, { operationId }); await task.until(p => p.text().includes('READY'));
  const first = await observe('before-disconnect', { waitFor: 'project/effect.jsonl' });
  original = provider.saveOriginal(task, operationId, argv, workload(first)); report.original = original;
  const approval = policy.approval(); await delay(30);
  assert.equal(approval.state, 'expired-denied'); assert.throws(() => approval.decide(true), { code: 'T107_APPROVAL_CLOSED' });
  report.cases.push({ id: 'APPROVAL-EXPIRY', state: approval.state, autoApproved: false });
  const privateSession = raw.session; // Memory only; never serialize resumeToken/session object.
  const started = performance.now();
  await provider.disconnect(() => close(raw));
  const disconnected = await observe('disconnected');
  assert.equal(workload(disconnected).startTick, original.startTick);
  assert.equal(workload(disconnected).pid, original.pid);
  assert.ok(!disconnected.remote.processes.some(p => p.kind === 'connector'));
  const recovered = await provider.recover(original, remaining => connect(privateSession, remaining), async saved => {
    const value = await observe('reconnected'); return { binding: value.binding, process: workload(value) };
  });
  report.cases.push({ id: 'ORIGINAL-RECOVERY', ...recovered, elapsedMs: Math.round(performance.now() - started), windowMs: provider.recoveryWindowMs });
  // Actual data flow: independent bytes first, full helper readback second, name/ID lookup third.
  const stored = first.remote.files.filter(f => f.kind === 'file');
  for (const row of stored) {
    const path = row.path.slice('project/'.length); const actual = await project.read(path);
    assert.equal(sha256(actual), row.sha256); assert.deepEqual(actual, Buffer.from(row.base64, 'base64'));
    report.storedFiles.push({ path, bytes: actual.length, sha256: sha256(actual) });
  }
  const effect = (await project.read('effect.jsonl')).toString().trim().split('\n').map(JSON.parse);
  assert.equal(effect.length, 1); assert.equal(effect[0].operationId, original.operationId); assert.equal(effect[0].pid, original.pid);
  const names = await project.list(); for (const row of report.storedFiles) assert.ok(names.some(n => n.name === row.path));
  report.dataFlow = { directStorageFirst: true, fullReadback: true, nameLookup: report.storedFiles.map(f => f.path), operationLookup: effect[0].operationId, effects: effect.length };
  assert.equal(await policyTask.expired, 'expired-cancelled');
  assert.equal(provider.recoveryState, 'cancelled');
  const final = await observe('cancelled', { tracked: [workload(first)], waitGone: true });
  assert.ok(final.remote.tracked.every(p => ['gone', 'reused'].includes(p.state)));
  const effectAfter = final.remote.files.find(f => f.path === 'project/effect.jsonl');
  assert.equal(effectAfter.sha256, stored.find(f => f.path === 'project/effect.jsonl').sha256);
  report.cases.push({ id: 'ORIGINAL-CANCEL', state: policyTask.state, configuredTaskMs: policy.taskMs, final: await task.status(), tracked: final.remote.tracked, effects: 1 });
  assert.equal(report.calls.filter(c => c.method === 'process/start').length, 1);
  assert.equal(report.calls.find(c => c.method === 'process/start').operationId, original.operationId);
  await task.release(); await provider.close();
  report.helper = { version: raw.hello.helperVersion, retainedMs: privateSession.retentionMs, sessionResumed: true,
    managerEntries: helpers.entries.size, automaticReconnect: false, automaticReplay: false };
} catch (error) { report.failure = safeError(error); report.failure.message = String(error.message).slice(0, 240); }
finally {
  policyTask?.dispose();
  // Administrative cleanup is separate and never changes the recovery verdict.
  if (task && !task.released && provider?.client.closeReason === undefined) {
    try { await task.terminate(); await task.release(); } catch (e) { report.cleanupErrors.push(safeError(e)); }
  }
  if (provider && provider.client.closeReason === undefined) { try { await provider.close(); } catch (e) { report.cleanupErrors.push(safeError(e)); } }
  for (const t of transports) { try { if (!t.ended) await close(t.raw); } catch (e) { report.cleanupErrors.push(safeError(e)); } }
  for (const fiber of [pluginFiber, subFiber, fsFiber]) { if (fiber) { try { await fiber.dispose(); } catch (e) { report.cleanupErrors.push(safeError(e)); } } }
  hook.deregister(); report.networkAttempts = attempts;
  report.transports = transports.map(t => ({ pid: t.child.pid, ended: t.ended, exit: t.exit, stderrBytes: t.stderrBytes }));
  report.passed = !report.failure && !report.cleanupErrors.length && !attempts.length && report.cases.length === 3;
  writeFileSync(join(run, 'recovery.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.map(c => c.id), failure: report.failure }));
process.exitCode = report.passed ? 0 : 1;
