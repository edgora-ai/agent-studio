import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installNetworkGuard } from './network_guard.mjs';
import { prepareIsolation } from './isolation.mjs';

const [mode, candidateRoot, installedDsh, testRoot] = process.argv.slice(2);
if (!['native', 'adapter'].includes(mode) || !candidateRoot || !installedDsh || !testRoot) {
  throw new Error('Usage: activate_candidate.mjs native|adapter CANDIDATE_ROOT INSTALLED_DSH NEW_TEST_ROOT');
}
const isolation = prepareIsolation(candidateRoot, installedDsh, testRoot);
const networkAttempts = installNetworkGuard();
const moduleUrl = path => pathToFileURL(path).href;
const { Context } = await import(moduleUrl(join(installedDsh, 'node_modules/@deepseek-ai/cordis/lib/index.js')));
const { default: LocalFileSystem } = await import(moduleUrl(join(installedDsh, 'node_modules/@deepseek-ai/dsh-fs-local/lib/index.js')));
const { default: LocalSubprocessRuntime } = await import(moduleUrl(join(installedDsh, 'node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js')));
const candidate = await import(moduleUrl(join(candidateRoot, 'lib/index.js')));
const exitListenerBaseline = process.listenerCount('exit');
const workspace = join(testRoot, 'workspace');
const markerName = `marker-${randomUUID()}.txt`;
const marker = `T-103 ${randomUUID()} 中文🙂\nsecond line\n`;
writeFileSync(join(workspace, markerName), marker, { flag: 'wx' });
assert.equal(readFileSync(join(workspace, markerName), 'utf8'), marker);
const ctx = new Context();
const logs = [];
ctx.logger.exporter({ levels: { default: 4 }, export: message => logs.push(message) });
const timers = new Map();
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
globalThis.setInterval = (callback, delay, ...args) => {
  const handle = originalSetInterval(callback, delay, ...args);
  timers.set(handle, { delay, cleared: false });
  return handle;
};
globalThis.clearInterval = handle => {
  const entry = timers.get(handle);
  if (entry) entry.cleared = true;
  return originalClearInterval(handle);
};
const cleanup = { entered: 0, completed: 0 };
const report = { task: 'T-103', mode, nodeVersion: process.versions.node, isolation, passed: false };
let fsFiber;
let subprocessFiber;
let candidateFiber;
let helpers;
let providerRegistryBaseline;
const forcedCleanup = [];
async function verifyLocalRead() {
  const target = await ctx.fs.resolve(markerName);
  const bytes = await ctx.fs.readBytes(target, undefined, 4096);
  assert.equal(Buffer.from(bytes).toString('utf8'), marker);
  const listing = await ctx.fs.listDir(await ctx.fs.resolve(workspace));
  assert.equal(listing.filter(entry => entry.name === markerName).length, 1);
}
try {
  fsFiber = ctx.plugin(LocalFileSystem, { cwd: workspace });
  await fsFiber;
  subprocessFiber = ctx.plugin(LocalSubprocessRuntime);
  await subprocessFiber;
  assert.equal(fsFiber.state, 2);
  assert.equal(subprocessFiber.state, 2);
  assert.equal(typeof ctx.subprocess.spawn, 'function');
  assert.equal(typeof ctx.subprocess.spawnTerminal, 'function');
  await verifyLocalRead();
  providerRegistryBaseline = [...ctx.registry.entries()].length;
  const adapted = {
    name: candidate.name,
    inject: candidate.inject,
    Config: candidate.Config,
    apply: (scope, config) => {
      const dispose = candidate.apply(scope, config);
      assert.equal(typeof dispose, 'function');
      return async () => {
        cleanup.entered++;
        await dispose();
        cleanup.completed++;
      };
    },
  };
  candidateFiber = ctx.plugin(mode === 'native' ? candidate : adapted, { hosts: [] });
  await candidateFiber;
  assert.equal(candidateFiber.state, 2);
  const service = ctx.get('sshRemote');
  assert.ok(service);
  assert.deepEqual(service.legacyConfig.hosts, []);
  helpers = service.helpers;
  assert.equal(helpers.entries.size, 0);
  assert.equal(helpers.disposed, false);
  await verifyLocalRead();
  report.activation = {
    candidateState: candidateFiber.state,
    fsState: fsFiber.state,
    subprocessState: subprocessFiber.state,
    sshRemoteRegistered: Boolean(service),
    helperEntries: helpers.entries.size,
    intervals: [...timers.values()].map(entry => ({ ...entry })),
    localFsReadAndLookup: true,
  };
  await candidateFiber.dispose();
  await verifyLocalRead();
  report.teardown = {
    candidateState: candidateFiber.state,
    candidateUid: candidateFiber.uid,
    sshRemoteRegistered: Boolean(ctx.get('sshRemote')),
    helpersDisposed: helpers.disposed,
    providerRegistryBaseline,
    registryCount: [...ctx.registry.entries()].length,
    intervals: [...timers.values()].map(entry => ({ ...entry })),
    adapterDisposer: { ...cleanup },
    localFsReadAndLookup: true,
  };
  const errors = logs.filter(message => message.type === 'error');
  report.cordisErrors = errors.map(message => message.args.map(arg => arg instanceof Error ? arg.message : String(arg)).join(' '));
  report.checks = {
    candidateDisposed: candidateFiber.uid === null && candidateFiber.state === 4,
    serviceRemoved: !ctx.get('sshRemote'),
    helpersDisposed: helpers.disposed === true,
    intervalsCleared: timers.size > 0 && [...timers.values()].every(entry => entry.cleared),
    registryRestored: [...ctx.registry.entries()].length === providerRegistryBaseline,
    noCordisErrors: errors.length === 0,
    noNetworkAttempts: networkAttempts.length === 0,
    isolatedHomeUnchanged: readdirSync(join(testRoot, 'home')).length === 0 && readdirSync(join(testRoot, 'dsh-home')).length === 0,
    workspaceOnlyContainsMarker: readdirSync(workspace).length === 1 && readFileSync(join(workspace, markerName), 'utf8') === marker,
  };
  if (mode === 'adapter') report.checks.disposerCalledExactlyOnce = cleanup.entered === 1 && cleanup.completed === 1;
  report.passed = Object.values(report.checks).every(value => value === true);
} catch (error) {
  report.error = { code: error.code ?? null, message: error.message, stack: error.stack };
} finally {
  // Observe native leaks before repairing this isolated process for clean shutdown.
  if (candidateFiber?.uid !== null) {
    try { await candidateFiber?.dispose(); } catch (error) { forcedCleanup.push(`candidate cleanup: ${error.message}`); }
  }
  if (helpers && !helpers.disposed) {
    forcedCleanup.push('explicit helper disposal after observation');
    try { await helpers.dispose(); } catch (error) { forcedCleanup.push(`helper cleanup: ${error.message}`); }
  }
  for (const [handle, entry] of timers) {
    if (!entry.cleared) {
      forcedCleanup.push(`explicit clearing of leaked ${entry.delay}ms interval after observation`);
      globalThis.clearInterval(handle);
    }
  }
  for (const [name, fiber] of [['subprocess', subprocessFiber], ['fs', fsFiber]]) {
    try { await fiber?.dispose(); } catch (error) { forcedCleanup.push(`${name} cleanup: ${error.message}`); }
  }
  report.providerCleanup = {
    registryCount: [...ctx.registry.entries()].length,
    exitListenerBaseline,
    exitListenersAfter: process.listenerCount('exit'),
  };
  const cleanupErrors = logs.filter(message => message.type === 'error');
  if (cleanupErrors.length) {
    report.allCordisErrors = cleanupErrors.map(message => message.args.map(arg => arg instanceof Error ? arg.message : String(arg)).join(' '));
    report.passed = false;
  }
  try { await ctx.fiber.dispose(); } catch (error) { forcedCleanup.push(`root cleanup: ${error.message}`); report.passed = false; }
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
}
report.networkAttempts = [...networkAttempts];
report.forcedCleanup = forcedCleanup;
if (report.providerCleanup.registryCount !== 0 || report.providerCleanup.exitListenersAfter !== exitListenerBaseline) report.passed = false;
if (mode === 'adapter' && forcedCleanup.length) report.passed = false;
const output = join(testRoot, 'activation.json');
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), report);
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
