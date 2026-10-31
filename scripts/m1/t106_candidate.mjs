import assert from 'node:assert/strict';
import { constants, openSync, closeSync, readFileSync, existsSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { installNetworkGuard } from './network_guard.mjs';
import { BoundProvider, DISABLED_CHANNELS, sha256, safeError } from './t106_provider.mjs';

const [candidate, dsh, run, alias] = process.argv.slice(2);
assert.ok(candidate && dsh && run && alias);
const plan = JSON.parse(readFileSync(join(run, 'plan.json'), 'utf8'));
assert.match(plan.token, /^[a-f0-9]{24}$/);
const token = plan.token, base = `/workspace/t106-${token}`, root = `${base}/project`;
const url = path => pathToFileURL(path).href;
const report = { task: 'T-106', acceptance: 'awaiting-independent-verification', m1Passed: false,
  cases: [], enabledChannels: [], disabledChannels: [...DISABLED_CHANNELS],
  rpc: [], providerCalls: [], observations: [], cleanup: {} };
assert.ok(process.permission);
assert.deepEqual(process.execArgv.filter(v => v.startsWith('--allow-fs-write')),
  [`--allow-fs-write=${run}`, `--allow-fs-write=${run}/*`]);
assert.equal(process.env.HOME, join(run, 'home'));
const allowedEnv = ['PATH', 'LANG', 'HOME', 'DSH_HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'CI'];
assert.ok(Object.keys(process.env).every(k => allowedEnv.includes(k)));
const manifest = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'));
assert.equal(manifest.version, '0.13.3');
const denials = [];
for (const path of [join(candidate, 'package.json'), ...Object.keys(manifest.peerDependencies).flatMap(name => {
  const p = join(candidate, '..', name, 'package.json'); return [p, realpathSync(p)];
})]) {
  let fd;
  assert.equal(process.permission.has('fs.write', path), false);
  try { fd = openSync(path, constants.O_WRONLY); throw new Error('T106_DEPENDENCY_WRITE_ALLOWED'); }
  catch (error) { assert.equal(error.code, 'ERR_ACCESS_DENIED'); denials.push(path); }
  finally { if (fd !== undefined) closeSync(fd); }
}
report.dependencyWriteDenials = denials.length;
const attempts = installNetworkGuard();
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === 'dsh-ssh-remote' ? url(join(candidate, 'lib/index.js')) : specifier, context);
} });
const { Context } = await import(url(join(dsh, 'node_modules/@deepseek-ai/cordis/lib/index.js')));
const { default: LocalFileSystem } = await import(url(join(dsh, 'node_modules/@deepseek-ai/dsh-fs-local/lib/index.js')));
const { default: LocalSubprocessRuntime } = await import(url(join(dsh, 'node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js')));
// Filename discovery is routed through the same adapter, never a managed
// reconnecting facade. No second execution or search transport is introduced.
const entry = await import('./ssh_remote_entry.mjs');
const context = new Context();
const logs = []; context.logger.exporter({ levels: { default: 4 }, export: m => logs.push(m.type) });
let fsFiber, subFiber, pluginFiber, helpers, raw, provider, project, owner;
const processes = new Set();
let entered = 0, completed = 0, seq = 0;
async function observe(label, extra = {}) {
  const id = String(++seq).padStart(3, '0');
  const output = join(run, `observe-${id}.response.json`);
  writeFileSync(join(run, `observe-${id}.request.json`), JSON.stringify({ label, ...extra }), { flag: 'wx' });
  const deadline = Date.now() + 18000;
  while (!existsSync(output)) { assert.ok(Date.now() < deadline, 'T106_OBSERVER_DEADLINE'); await delay(30); }
  const value = JSON.parse(readFileSync(output, 'utf8'));
  assert.ok(!value.error, 'T106_INDEPENDENT_OBSERVER_FAILED');
  report.observations.push({ label, path: output });
  return value;
}
async function test(name, fn, channel) {
  const row = { case: name, status: 'running' }; report.cases.push(row);
  if (plan.focus === 'fault' && !name.startsWith('E-')) { row.status = 'not-executed-focused-run'; return; }
  const existing = new Set(processes);
  try {
    row.facts = await fn(); row.status = 'observed-pass-awaiting-review';
    row.capabilityStatus = row.facts.outcome === 'blocked-dependency-not-search-pass' ? 'blocked-missing-dependency' : 'awaiting-independent-review';
    if (channel) report.enabledChannels.push(channel);
  } catch (error) {
    row.status = 'blocked'; row.error = safeError(error);
    row.diagnostic = error.code === 'ERR_ASSERTION' ? String(error.message).slice(0, 500) : null;
  } finally {
    if (raw?.closeReason === undefined) {
      for (const p of processes) if (!existing.has(p)) {
        try { await p.terminate(); await p.release(); processes.delete(p); }
        catch (error) { row.status = 'blocked'; (row.cleanupErrors ??= []).push(safeError(error)); }
      }
    }
  }
}
async function reject(operation, allowed) {
  try { await operation(); } catch (error) {
    if (allowed) assert.ok(allowed.includes(error.code), `Unexpected provider error ${error.code}`);
    return safeError(error);
  }
  throw new Error('T106_EXPECTED_REJECTION');
}
async function start(argv, options) { const p = await project.start(argv, options); processes.add(p); return p; }
async function finish(p) {
  await p.until(v => v.last.exited); const status = await p.status();
  assert.equal(status.running, false);
  assert.equal(p.last.exitCode, status.exitCode);
  assert.equal(p.last.signal, status.signal);
  const output = { argv: report.providerCalls.find(v => v.method === 'process/start' && v.processId === p.id)?.argv,
    status, chunks: p.chunks, stdout: p.text(), stderr: p.text('stderr') };
  await p.release(); processes.delete(p); return output;
}
function event(p, name) {
  const values = (p.text('stdout') + p.text('pty')).split(/\r?\n/).flatMap(line => {
    try { return [JSON.parse(line)]; } catch (error) { if (error instanceof SyntaxError) return []; throw error; }
  });
  return values.find(v => v.event === name);
}
async function readback(observation) {
  const values = [];
  for (const f of observation.remote.files.filter(f => f.path.startsWith('project/') && f.base64 !== undefined)) {
    const path = f.path.slice(8); const bytes = await project.read(path);
    assert.equal(bytes.toString('base64'), f.base64);
    values.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return values;
}
try {
  fsFiber = context.plugin(LocalFileSystem, { cwd: join(run, 'workspace') }); await fsFiber;
  subFiber = context.plugin(LocalSubprocessRuntime); await subFiber;
  pluginFiber = context.plugin({ ...entry, apply: (ctx, config) => {
    const dispose = entry.apply(ctx, config); assert.equal(typeof dispose, 'function');
    return async () => { entered++; await dispose(); completed++; };
  } }, { hosts: [] }); await pluginFiber;
  assert.equal(pluginFiber.state, 2);
  const service = context.get('sshRemote'); helpers = service.helpers;
  const discovery = await service.config(); assert.deepEqual(discovery.hosts.map(h => h.alias), [alias]);
  const status = await service.connectHost(alias);
  assert.equal(status.version, '0.13.1');
  assert.equal(helpers.installer.asset.sha256, 'c853353b330d790813fdd2a2d641c9a4738c6b96f50b53c2f4aa53acec31901f');
  report.helper = { version: status.version, state: status.status, environment: status.environment,
    sha256: helpers.installer.asset.sha256, bytes: helpers.installer.asset.content.length };
  raw = helpers.entries.get(alias).client;
  const actualCall = raw.call.bind(raw);
  raw.call = async (method, params = {}, options) => {
    // Whitelist evidence fields; never log initialize/session secrets or payloads.
    const row = { method, operationId: params.operationId ?? null, processId: params.processId ?? null };
    report.rpc.push(row);
    try { const result = await actualCall(method, params, options); row.result = 'response'; return result; }
    catch (error) { row.result = 'error'; row.error = safeError(error); throw error; }
  };
  provider = new BoundProvider(raw, token, report.providerCalls);
  ({ owner, project } = await provider.createRun());
  await owner.write('outside.txt', Buffer.from(`OUTSIDE-ROOT-${token}\n`));
  report.disabledChannelRejections = {};
  for (const channel of DISABLED_CHANNELS) {
    report.disabledChannelRejections[channel] = await reject(() => provider.compatibility(channel), ['T106_CHANNEL_DISABLED']);
  }
  await project.mkdir('cwd space');
  await project.write('probe.py', readFileSync(new URL('./t106_payload.py', import.meta.url)));
  const text = `Remote UTF-8 中文 café\nquotes '\" spaces\n${token}\n`;
  const binary = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from(token.repeat(20))]);
  await test('A-filesystem-bytes-and-boundaries', async () => {
    const writes = [await project.write('utf8 文件.txt', Buffer.from(text)), await project.write('binary fixture.bin', binary)];
    const setup = await start(['python3', '-I', '-c', "import os;os.symlink('../outside.txt','escape');os.symlink('utf8 文件.txt','internal-link');os.symlink('..','escape-dir')"]);
    assert.equal((await finish(setup)).status.exitCode, 0);
    const observed = await observe('fs-direct-storage');
    const reads = await readback(observed);
    assert.equal((await project.read('utf8 文件.txt')).toString(), text);
    assert.deepEqual(await project.read('binary fixture.bin'), binary);
    const listing = await project.list();
    assert.ok(listing.some(e => e.name === 'utf8 文件.txt') && listing.some(e => e.name === 'binary fixture.bin'));
    const errors = { missing: await reject(() => project.read('missing.txt'), ['E_NOT_FOUND']) };
    for (const path of ['../outside.txt', `${base}/outside.txt`, 'cwd space/../../outside.txt']) {
      const count = report.providerCalls.length;
      errors[path] = await reject(() => project.read(path), ['T106_PATH_OUTSIDE_BINDING']);
      assert.equal(report.providerCalls.length, count);
      errors[`native:${path}`] = await reject(() => project.call('fs/read', { path, maxBytes: 1000 }), ['E_OUTSIDE_ROOT', 'E_INVALID_PATH']);
    }
    for (const path of ['escape', 'internal-link', 'escape-dir/outside.txt']) {
      errors[path] = await reject(() => project.read(path), ['E_SYMLINK', 'E_NOT_DIRECTORY']);
      errors[`write:${path}`] = await reject(() => project.write(path, Buffer.from('must-not-write')), ['E_SYMLINK', 'E_NOT_DIRECTORY']);
    }
    const after = await observe('fs-boundary-after');
    assert.deepEqual(after.remote.files, observed.remote.files);
    assert.equal((await owner.read('outside.txt')).toString(), `OUTSIDE-ROOT-${token}\n`);
    return { writes, reads, listing, errors, independentObservation: 'fs-direct-storage', outsideCanaryUnchanged: true };
  }, 'bound-helper-filesystem');
  await test('A-non-Git-search-known-dependency-gap', async () => {
    const result = await project.searchNames('utf8');
    assert.equal(result.complete, false); assert.equal(result.candidates.length, 0);
    assert.equal(result.error.code, 'E_EXECUTABLE_NOT_FOUND');
    return { outcome: 'blocked-dependency-not-search-pass', complete: result.complete, error: result.error,
      reason: 'Frozen image lacks ripgrep; no tool installed or capability spoofed.' };
  });
  await test('A-pinned-private-rg-storage-and-runtime', async () => {
    assert.equal(plan.tool.path, 'dependency/rg');
    const bytes = readFileSync(join(run, plan.tool.path));
    assert.equal(bytes.length, plan.tool.bytes); assert.equal(sha256(bytes), plan.tool.sha256);
    const toolHome = await provider.openToolHome();
    try {
      await toolHome.mkdir('.t106-tools'); await toolHome.mkdir('.t106-tools/bin');
      const committed = await toolHome.writeLarge('.t106-tools/bin/rg', bytes, 0o700);
      const profile = Buffer.from('export PATH="$HOME/.t106-tools/bin:/usr/local/bin:/usr/bin:/bin"\n');
      await toolHome.write('.profile', profile);
      const observed = await observe('private-tool-direct-storage');
      const direct = observed.remote.privateTools;
      assert.equal(direct.binary.sha256, plan.tool.sha256); assert.equal(direct.binary.bytes, bytes.length);
      assert.equal(direct.binary.mode, 0o700); assert.equal(direct.binary.uid, 1000);
      assert.equal(direct.profile.base64, profile.toString('base64'));
      const read = await toolHome.readLarge('.t106-tools/bin/rg', bytes.length);
      assert.deepEqual(read, bytes); assert.deepEqual(await toolHome.read('.profile'), profile);
      const listing = await toolHome.list('.t106-tools/bin'); assert.ok(listing.some(e => e.name === 'rg'));
      const executable = `${toolHome.root}/.t106-tools/bin/rg`;
      const version = await finish(await start([executable, '--version']));
      assert.equal(version.status.exitCode, 0); assert.equal(version.stderr, '');
      assert.ok(version.stdout.startsWith('ripgrep 14.1.0\n'));
      const environment = await provider.environment();
      assert.equal(environment.search.available, true); assert.equal(environment.search.path, executable);
      assert.equal(environment.search.version, 'ripgrep 14.1.0');
      report.privateToolEnvironment = environment;
      return { committed, direct, readback: { bytes: read.length, sha256: sha256(read), byteEqual: true },
        listing, version, environment, profileScope: 'Only exact run helper HOME; no global PATH or image change' };
    } finally { await toolHome.close(); }
  }, 'private-pinned-rg-experiment');
  await test('A-native-non-Git-filename-search-private-rg', async () => {
    const before = await observe('non-Git-search-before');
    assert.ok(!before.remote.files.some(f => f.path === 'project/.git'));
    const textResult = await project.searchNames('utf8');
    const binaryResult = await project.searchNames('binary');
    for (const result of [textResult, binaryResult]) {
      assert.equal(result.source, 'rg'); assert.equal(result.complete, true); assert.equal(result.error, null);
    }
    assert.ok(textResult.candidates.some(c => c.path === 'utf8 文件.txt'));
    assert.ok(binaryResult.candidates.some(c => c.path === 'binary fixture.bin'));
    return { text: textResult, binary: binaryResult, noGitRepository: true,
      dependency: 'Pinned per-run private rg; frozen image remains missing rg' };
  }, 'native-non-Git-filename-discovery-private-rg');
  await test('A-content-search-private-rg-bound-command', async () => {
    const env = { PATH: `/tmp/t105-${token}/home/.t106-tools/bin:/usr/local/bin:/usr/bin:/bin` };
    const query = 'Remote UTF-8 中文 café';
    const found = await finish(await start(['rg', '--json', '--fixed-strings', '--no-config', '--', query, 'utf8 文件.txt'], { env }));
    assert.equal(found.status.exitCode, 0); assert.equal(found.stderr, '');
    const matches = found.stdout.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'match');
    assert.equal(matches.length, 1); assert.equal(matches[0].data.path.text, 'utf8 文件.txt');
    assert.equal(matches[0].data.line_number, 1); assert.equal(matches[0].data.lines.text, query + '\n');
    assert.equal(matches[0].data.submatches[0].match.text, query);
    const missing = await finish(await start(['rg', '--json', '--fixed-strings', '--no-config', '--', 'ABSENT-CONTENT-' + token, 'utf8 文件.txt'], { env }));
    assert.equal(missing.status.exitCode, 1); assert.equal(missing.stderr, '');
    assert.ok(missing.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).every(row => row.type !== 'match'));
    return { found, missing, matches, scope: 'Explicit pinned rg via bound command; NOT product search/index integration or filename evidence' };
  }, 'explicit-private-rg-content-command');
  await test('A-native-Git-filename-search', async () => {
    const p = await start(['git', '-c', 'init.defaultBranch=t106', 'init', '--quiet', '--template=']);
    const initialized = await finish(p); assert.equal(initialized.status.exitCode, 0);
    const textResult = await project.searchNames('utf8');
    const binaryResult = await project.searchNames('binary');
    assert.equal(textResult.source, 'git'); assert.equal(textResult.complete, true);
    assert.ok(textResult.candidates.some(c => c.path === 'utf8 文件.txt'));
    assert.ok(binaryResult.candidates.some(c => c.path === 'binary fixture.bin'));
    const native = await project.discover(); assert.equal(native.source, 'git'); assert.equal(native.complete, true);
    return { initialized, text: textResult.candidates, binary: binaryResult.candidates, native,
      scope: 'Native Git-backed filename index only; no content-search or arbitrary non-Git search acceptance.' };
  }, 'native-Git-filename-index');
  await test('B-structured-command', async () => {
    const args = ['space arg', "single'quote", 'double"quote', '$(must-not-run)', '; not a shell', '', '中文'];
    const p = await start(['python3', '-I', `${root}/probe.py`, 'command', token, ...args],
      { cwd: 'cwd space', env: { T106_VALUE: 'remote env with spaces \'" 中文' } });
    await p.until(v => v.text().includes('command-ready'));
    const ready = event(p, 'command-ready');
    assert.equal(ready.pid, p.started.pid); assert.equal(ready.cwd, `${root}/cwd space`);
    assert.equal(ready.uid, 1000); assert.deepEqual(ready.argv, args); assert.deepEqual(ready.isatty, [false, false, false]);
    assert.equal(ready.env, 'remote env with spaces \'" 中文');
    const observed = await observe('command-running', { pids: [ready.pid] });
    const actual = observed.remote.processes.find(v => v.pid === ready.pid);
    assert.ok(actual); assert.equal(actual.uid, 1000); assert.equal(actual.cwd, ready.cwd);
    assert.equal(actual.pgid, ready.pgid); assert.equal(actual.ownerTokenPresent, false); assert.equal(actual.agentTokenPresent, false);
    await readback(observed);
    await p.input('finish\n'); const result = await finish(p);
    assert.equal(result.status.exitCode, 17); assert.equal(result.status.signal, null);
    assert.equal(result.stderr, 'stderr exact: quotes \'" and UTF-8 中文\n'); assert.ok(result.stdout.endsWith('stdout finished\n'));
    const after = await observe('command-reaped', { tracked: [actual], waitGone: true });
    assert.ok(after.remote.tracked.every(p => p.state === 'gone' || p.state === 'reused'));
    return { ready, actual, ...result, after: after.remote.tracked };
  }, 'bound-helper-command');
  await test('C-real-PTY-foreground', async () => {
    const p = await start(['python3', '-I', `${root}/probe.py`, 'pty', token], { tty: { rows: 27, cols: 91, term: 'xterm-256color' } });
    await p.until(v => !!event(v, 'pty-ready'));
    const ready = event(p, 'pty-ready');
    assert.deepEqual(ready.isatty, [true, true, true]); assert.equal(ready.rows, 27); assert.equal(ready.cols, 91);
    assert.equal(ready.parent, p.started.pid); assert.notEqual(ready.pgid, p.started.pgid); assert.equal(ready.foreground, ready.pgid);
    const fg = await p.foreground(); assert.equal(fg.verified, true); assert.equal(fg.pgid, ready.pgid);
    const observed = await observe('pty-running', { pids: [p.started.pid, ready.pid] });
    const actual = observed.remote.processes.filter(v => [p.started.pid, ready.pid].includes(v.pid));
    assert.equal(actual.length, 2); assert.ok(actual.every(v => v.tpgid === ready.pgid));
    await p.input('input spaces and 中文\n');
    await p.until(v => !!event(v, 'pty-input')); assert.equal(event(p, 'pty-input').text, 'spaces and 中文');
    await p.resize(41, 123); await p.input('size\n'); await p.until(v => !!event(v, 'pty-resize'));
    assert.equal(event(p, 'pty-resize').rows, 41); assert.equal(event(p, 'pty-resize').cols, 123);
    const signal = await p.signalForeground('SIGINT');
    assert.equal(signal.delivered, true); assert.equal(signal.verified, true); assert.equal(signal.targetPgid, ready.pgid);
    const result = await finish(p); assert.equal(result.status.exitCode, 0);
    assert.equal(event(p, 'pty-child-signal').signal, 2); assert.equal(event(p, 'pty-parent-reaped').childExit, 23);
    const after = await observe('pty-reaped', { tracked: actual, waitGone: true });
    assert.ok(after.remote.tracked.every(v => v.state === 'gone' || v.state === 'reused'));
    return { ready, fg, actual, signal, ...result, readback: await readback(after), after: after.remote.tracked };
  }, 'bound-helper-PTY');
  await test('D-cancel-owned-parent-child-group', async () => {
    const p = await start(['python3', '-I', `${root}/probe.py`, 'cancel', token]);
    await p.until(v => v.text().includes('cancel-parent-ready'));
    const ready = event(p, 'cancel-parent-ready');
    const observed = await observe('cancel-running', { pids: [ready.pid, ready.child], groups: [ready.pgid] });
    const members = observed.remote.processes.filter(v => v.pgid === ready.pgid);
    assert.ok(members.some(v => v.pid === ready.pid) && members.some(v => v.pid === ready.child));
    assert.equal(members.filter(v => v.kind === 'workload').length, 2);
    assert.equal(members.filter(v => v.kind === 'supervisor-or-guardian').length, 1);
    assert.ok(members.every(v => v.belongsToRun));
    const cancelled = await p.terminate(); assert.equal(cancelled.final.running, false);
    assert.equal(event(p, 'cancel-parent-reaped').childExit, 0);
    await p.release(); processes.delete(p);
    const after = await observe('cancel-group-reaped', { tracked: members, groups: [ready.pgid], waitGone: true });
    assert.equal(after.remote.processes.filter(v => v.pgid === ready.pgid).length, 0);
    assert.ok(after.remote.tracked.every(v => v.state === 'gone' || v.state === 'reused'));
    const parent = JSON.parse((await project.read('cancel-parent-reaped.json')).toString());
    const child = JSON.parse((await project.read('cancel-child-term.json')).toString());
    assert.ok(parent.signals.includes(15)); assert.equal(child.signal, 15);
    assert.equal(parent.forwardedSignal, false);
    assert.equal(cancelled.forced, null);
    return { ready, members, cancelled, parent, child, output: p.chunks, after: after.remote.tracked, readback: await readback(after) };
  }, 'bound-helper-group-cancellation');
  await test('D-healthy-resource-cleanup', async () => {
    const observed = await observe('healthy-files-before-fault');
    const reads = await readback(observed);
    const query = await project.searchNames('');
    assert.equal(query.complete, true);
    const listing = await project.discover();
    assert.equal(listing.complete, true);
    for (const f of reads) assert.ok(listing.entries.some(e => e.path === f.path));
    await owner.close(); owner = undefined;
    const health = await raw.call('health/status', {}, { timeoutMs: 4000 });
    assert.equal(health.processes, 0); assert.equal(health.discoveries, 0); assert.equal(health.readHandles, 0);
    assert.equal(health.writeHandles, 0); assert.equal(health.workspaces, 1);
    return { reads, listing, health };
  });
  if (plan.focus === 'fault') {
    await project.write('utf8 文件.txt', Buffer.from(text));
    const baseline = await observe('focused-fault-before');
    report.focusedPrerequisiteReadback = await readback(baseline);
    assert.equal((await owner.read('outside.txt')).toString(), `OUTSIDE-ROOT-${token}\n`);
    await owner.close(); owner = undefined;
  }
  await test('E-unavailable-and-in-flight-unknown-no-fallback', async () => {
    // Fault only this test-owned broker's receive lane. The remote mutation runs
    // but its ACK is deliberately not consumed. No agent/service is interrupted.
    const managedEntry = helpers.entries.get(alias);
    managedEntry.wanted = false; // Disable acquisition retries, not a success stub.
    const childPid = managedEntry.child.pid;
    raw.options.readable.pause();
    const operationId = randomUUID();
    const pending = project.start(['python3', '-I', `${root}/probe.py`, 'uncertain', token], { processId: operationId, operationId });
    const outcome = pending.then(() => ({ unexpectedSuccess: true }), error => safeError(error));
    const actual = await observe('fault-side-effect-before-ACK', { waitFor: 'project/uncertain-effect.json' });
    assert.ok(actual.remote.files.some(f => f.path === 'project/uncertain-effect.json'));
    raw.close('T106_TEST_OWNED_TRANSPORT_FAILURE');
    const error = await outcome;
    assert.equal(error.type, 'RemoteHelperCallInterruptedError'); assert.equal(error.mutationMayHaveStarted, true);
    const readError = await reject(() => project.read('utf8 文件.txt'));
    const writeError = await reject(() => project.write('unavailable-write.txt', Buffer.from('must not be local')));
    const commandError = await reject(() => project.start(['python3', '-I', '-c', "from pathlib import Path;Path('unavailable-command.txt').write_text('must not be local')"]));
    const tracked = actual.remote.processes.filter(p => p.mode === 'uncertain');
    assert.ok(tracked.length >= 1);
    const after = await observe('fault-bounded-process-exited', { tracked, waitGone: true });
    const counter = after.remote.files.find(f => f.path === 'project/uncertain-count.txt');
    assert.equal(Buffer.from(counter.base64, 'base64').toString(), token + '\n');
    assert.ok(after.remote.files.some(f => f.path === 'project/uncertain-finished.json'));
    assert.ok(after.remote.tracked.every(v => v.state === 'gone' || v.state === 'reused'));
    assert.ok(!after.remote.files.some(f => /unavailable-(write|command)\.txt$/.test(f.path)));
    assert.equal(report.rpc.filter(v => v.operationId === operationId).length, 1);
    // attempt is a backoff counter reset to zero after success, NOT a
    // connection count. The controller verifies exactly two actual SSH gates
    // (installer + connector); RPC dispatch and side-effect count prove no replay.
    assert.equal(managedEntry.retryTimer, undefined);
    assert.equal(provider.uncertain, true);
    assert.equal(writeError.code, 'T106_UNKNOWN_OUTCOME');
    assert.equal(commandError.code, 'T106_UNKNOWN_OUTCOME');
    return { operationId, providerError: error, mutationOutcome: 'unknown-to-provider; independently observed once; not retried',
      childPidIsLocalTransportOnly: childPid, actualRemote: tracked, readError, writeError, commandError,
      exactOperationDispatchCount: report.rpc.filter(v => v.operationId === operationId).length,
      backoffAttemptCounter: managedEntry.attempt, counterSha256: counter.sha256, after: after.remote.tracked,
      retainedSupervisorsRequireAuthenticatedCleanup: after.remote.processes.filter(v => v.kind === 'supervisor-or-guardian'),
      providerReadbackAfterFault: 'unavailable-not-claimed', centralCanariesUnchanged: after.centralCanariesUnchanged };
  }, 'single-session-fail-closed');
} catch (error) { report.failure = safeError(error); }
finally {
  const errors = [];
  if (raw?.closeReason === undefined) {
    for (const p of processes) {
      try { await p.terminate(); await p.release(); } catch (error) { errors.push({ stage: 'owned-process', ...safeError(error) }); }
    }
    for (const [name, resource] of [['provider', provider]]) {
      try { await resource?.close(); }
      catch (error) { errors.push({ stage: name, ...safeError(error) }); }
    }
  }
  try { await pluginFiber?.dispose(); } catch (error) { errors.push({ stage: 'plugin', ...safeError(error) }); }
  for (const f of [subFiber, fsFiber]) { try { await f?.dispose(); } catch (error) { errors.push({ stage: 'host-provider', ...safeError(error) }); } }
  report.cleanup = { errors, disposer: { entered, completed }, helpersDisposed: helpers?.disposed,
    helperEntries: helpers?.entries.size, registrySize: [...context.registry.entries()].length,
    javascriptNetworkAttempts: attempts, logTypes: logs,
    centralEntries: readdirSync(join(run, 'workspace')),
    remoteCleanup: 'Independent /proc and authenticated per-run helper shutdown required by Python controller; transport exit is not proof.' };
  report.focus = plan.focus ?? 'all';
  const executed = report.cases.filter(c => c.status !== 'not-executed-focused-run');
  report.runtimePassed = executed.length === (report.focus === 'fault' ? 1 : 11) && executed.every(c => c.status === 'observed-pass-awaiting-review')
    && !report.failure && errors.length === 0 && entered === 1 && completed === 1 && helpers?.disposed
    && helpers.entries.size === 0 && report.cleanup.registrySize === 0 && attempts.length === 0;
  writeFileSync(join(run, 'candidate.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  hook.deregister();
}
console.log(JSON.stringify({ runtimePassed: report.runtimePassed, cases: report.cases.map(c => ({ case: c.case, status: c.status, error: c.error })), failure: report.failure }));
process.exitCode = report.runtimePassed ? 0 : 1;
