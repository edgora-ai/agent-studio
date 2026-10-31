import assert from 'node:assert/strict';
import { constants, openSync, closeSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { installNetworkGuard } from './network_guard.mjs';

const [candidate, dsh, run, alias] = process.argv.slice(2);
assert.ok(candidate && dsh && run && alias);
const url = path => pathToFileURL(path).href;
const report = { task: 'T-105', passed: false, projectOperationsEnabled: false };
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
  const aliasPath = join(candidate, '..', name, 'package.json');
  return [aliasPath, realpathSync(aliasPath)];
})]) {
  assert.equal(process.permission.has('fs.write', path), false);
  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY);
    throw new Error('T105_DEPENDENCY_WRITE_ALLOWED');
  } catch (error) {
    assert.equal(error.code, 'ERR_ACCESS_DENIED');
    denials.push(path);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
report.dependencyWriteDenials = denials.length;
const attempts = installNetworkGuard();
// Resolve only the explicit entry's package name to the frozen candidate.
// No writable dependency symlink and no changes to the verified entry itself.
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === 'dsh-ssh-remote' ? url(join(candidate, 'lib/index.js')) : specifier, context);
} });
const { Context } = await import(url(join(dsh, 'node_modules/@deepseek-ai/cordis/lib/index.js')));
const { default: LocalFileSystem } = await import(url(join(dsh, 'node_modules/@deepseek-ai/dsh-fs-local/lib/index.js')));
const { default: LocalSubprocessRuntime } = await import(url(join(dsh, 'node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js')));
const entry = await import('./ssh_remote_entry.mjs');
const context = new Context();
const logs = [];
context.logger.exporter({ levels: { default: 4 }, export: message => logs.push(message.type) });
const intervals = new Map();
const oldInterval = globalThis.setInterval;
const oldClear = globalThis.clearInterval;
globalThis.setInterval = (fn, delay, ...args) => {
  const handle = oldInterval(fn, delay, ...args);
  intervals.set(handle, { delay, cleared: false });
  return handle;
};
globalThis.clearInterval = handle => {
  if (intervals.has(handle)) intervals.get(handle).cleared = true;
  return oldClear(handle);
};
let fsFiber, subFiber, pluginFiber, helpers;
let entered = 0, completed = 0;
try {
  fsFiber = context.plugin(LocalFileSystem, { cwd: join(run, 'workspace') }); await fsFiber;
  subFiber = context.plugin(LocalSubprocessRuntime); await subFiber;
  pluginFiber = context.plugin({ ...entry, apply: (ctx, config) => {
    const dispose = entry.apply(ctx, config);
    assert.equal(typeof dispose, 'function');
    return async () => { entered++; await dispose(); completed++; };
  } }, { hosts: [] });
  await pluginFiber;
  assert.equal(pluginFiber.state, 2);
  const service = context.get('sshRemote');
  helpers = service.helpers;
  assert.equal(helpers.installer.asset.sha256, 'c853353b330d790813fdd2a2d641c9a4738c6b96f50b53c2f4aa53acec31901f');
  const discovery = await service.config();
  assert.deepEqual(discovery.hosts.map(h => h.alias), [alias]);
  assert.match(discovery.hosts[0].proxyCommand, /t105_connection\.py proxy/);
  report.discovery = discovery.hosts.map(({ alias, user, proxyCommand }) => ({ alias, user, proxyCommand }));
  const status = await service.connectHost(alias);
  assert.equal(status.version, '0.13.1');
  report.helper = { version: status.version, state: status.status, capabilities: status.capabilities,
    environment: status.environment, sha256: helpers.installer.asset.sha256, assetBytes: helpers.installer.asset.content.length };
  // Only handshake/health/environment, not FS/exec/PTY or workspace/open.
  const client = await helpers.client(alias);
  const raw = helpers.entries.get(alias).client;
  const realCall = raw.call.bind(raw);
  raw.call = async (method, ...args) => {
    const result = await realCall(method, ...args);
    if (method === 'session/close') report.remoteSessionClose = { closed: result.closed };
    return result;
  };
  const health = await client.call('health/ping', { nonce: 't105-nonsecret-health' }, { timeoutMs: 5000 });
  report.health = health;
  assert.ok(status.capabilities && Object.keys(status.capabilities).length > 0);
  report.connected = true;
} catch (error) {
  // Candidate diagnostics can contain transport details; only a stable class/code
  // and bounded credential-redacted message are retained, never RPC sessions.
  const { redactHelperDiagnostic } = await import(url(join(candidate, 'lib/helper/installer.js')));
  report.failure = { type: error.name, code: error.code ?? null,
    message: redactHelperDiagnostic(error.message).slice(0, 1500) };
} finally {
  const cleanupErrors = [];
  try { await pluginFiber?.dispose(); } catch (error) { cleanupErrors.push(error.name); }
  report.disposer = { entered, completed, helpersDisposed: helpers?.disposed, helperEntries: helpers?.entries.size };
  for (const fiber of [subFiber, fsFiber]) {
    try { await fiber?.dispose(); } catch (error) { cleanupErrors.push(error.name); }
  }
  report.cleanup = { errors: cleanupErrors, registrySize: [...context.registry.entries()].length,
    intervals: [...intervals.values()], javascriptNetworkAttempts: attempts, cordisLogTypes: logs };
  report.centralWorkspaceEntries = readdirSync(join(run, 'workspace'));
  report.passed = report.connected === true && report.remoteSessionClose?.closed === true
    && report.centralWorkspaceEntries.length === 0 && entered === 1 && completed === 1 && helpers.disposed
    && helpers.entries.size === 0 && report.cleanup.registrySize === 0 && cleanupErrors.length === 0
    && [...intervals.values()].every(v => v.cleared) && attempts.length === 0;
  writeFileSync(join(run, 'candidate.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  globalThis.setInterval = oldInterval;
  globalThis.clearInterval = oldClear;
  hook.deregister();
}
console.log(JSON.stringify({ passed: report.passed, connected: report.connected ?? false,
  disposer: report.disposer, failure: report.failure ?? null }));
process.exitCode = report.passed ? 0 : 1;
