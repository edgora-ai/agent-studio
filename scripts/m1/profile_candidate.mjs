import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { constants, copyFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installNetworkGuard } from './network_guard.mjs';
import { prepareIsolation } from './isolation.mjs';

const [candidateRoot, installedDsh, testRoot] = process.argv.slice(2);
if (!candidateRoot || !installedDsh || !testRoot) {
  throw new Error('Usage: profile_candidate.mjs CANDIDATE_ROOT INSTALLED_DSH NEW_TEST_ROOT');
}
const isolation = prepareIsolation(candidateRoot, installedDsh, testRoot);
mkdirSync(join(testRoot, 'profile'));
const networkAttempts = installNetworkGuard();
const candidatePackage = JSON.parse(readFileSync(join(candidateRoot, 'package.json'), 'utf8'));
assert.equal(candidatePackage.name, 'dsh-ssh-remote');
assert.equal(candidatePackage.version, '0.13.3');
const profile = join(testRoot, 'profile');
const workspace = join(testRoot, 'workspace');
const entrySource = fileURLToPath(new URL('./ssh_remote_entry.mjs', import.meta.url));
copyFileSync(entrySource, join(profile, 'ssh_remote_entry.mjs'), constants.COPYFILE_EXCL);
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'agent-studio-t103-profile', version: '0.0.0', private: true, type: 'module',
  dsh: { profile: { bundles: [] } },
}, null, 2) + '\n', { flag: 'wx' });
const profileRequire = createRequire(join(profile, 'package.json'));
assert.equal(realpathSync(profileRequire.resolve('dsh-ssh-remote/package.json')), realpathSync(join(candidateRoot, 'package.json')));
const providerEntry = name => pathToFileURL(join(installedDsh, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href;
const entries = [
  { id: 't103-fs', name: providerEntry('dsh-fs-local'), config: { cwd: workspace } },
  { id: 't103-subprocess', name: providerEntry('dsh-subprocess-local'), config: {} },
  { id: 't103-ssh-remote', name: './ssh_remote_entry.mjs', config: { hosts: [] } },
];
const configPath = join(profile, 'cordis.json');
writeFileSync(configPath, JSON.stringify(entries, null, 2) + '\n', { flag: 'wx' });
assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), entries);
const markerName = `marker-${randomUUID()}.txt`;
const marker = `T-103 profile ${randomUUID()} 中文🙂\nsecond line\n`;
writeFileSync(join(workspace, markerName), marker, { flag: 'wx' });
assert.equal(readFileSync(join(workspace, markerName), 'utf8'), marker);
const moduleUrl = path => pathToFileURL(path).href;
const { Context, isConstructor } = await import(moduleUrl(join(installedDsh, 'node_modules/@deepseek-ai/cordis/lib/index.js')));
// Establish import-lifetime listener baselines without constructing any provider.
await import(providerEntry('dsh-fs-local'));
await import(providerEntry('dsh-subprocess-local'));
const { boot, loadProfileDirectory } = await import(moduleUrl(join(installedDsh, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')));
const exitListenerBaseline = process.listenerCount('exit');
const profileDescription = loadProfileDirectory('agent-studio-t103', profile, join(installedDsh, 'package.json'));
assert.equal(profileDescription.dir, profile);
assert.deepEqual(profileDescription.skippedBundles, []);
const observer = new Context();
const logs = [];
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
const report = { task: 'T-103', stage: 'file-backed-profile-boot', nodeVersion: process.versions.node, isolation, passed: false };
const helpers = [];
const repairs = [];
let ctx;
let rootDisposed = false;
const timerSnapshot = () => [...timers.values()].map(entry => ({ ...entry }));
const errorMessages = () => logs.filter(message => message.type === 'error').map(message => message.args.map(arg => arg instanceof Error ? arg.message : String(arg)).join(' '));
const readStoredEntry = () => JSON.parse(readFileSync(configPath, 'utf8')).find(entry => entry.id === 't103-ssh-remote');
function verifyStoredConfig(disabled) {
  const expected = entries.map(entry => entry.id === 't103-ssh-remote' ? { ...entry, disabled } : entry);
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), expected);
}
async function verifyLocalRead() {
  const target = await ctx.fs.resolve(markerName);
  assert.equal(Buffer.from(await ctx.fs.readBytes(target, undefined, 4096)).toString('utf8'), marker);
  const found = (await ctx.fs.listDir(await ctx.fs.resolve(workspace))).filter(entry => entry.name === markerName);
  assert.equal(found.length, 1);
}
function observeHelper() {
  const service = ctx.get('sshRemote');
  assert.ok(service);
  assert.deepEqual(service.legacyConfig.hosts, []);
  const helper = service.helpers;
  assert.equal(helper.entries.size, 0);
  assert.equal(helper.disposed, false);
  const state = { helper, disposeCalls: 0 };
  const dispose = helper.dispose;
  helper.dispose = async (...args) => {
    state.disposeCalls++;
    return Reflect.apply(dispose, helper, args);
  };
  helpers.push(state);
  return state;
}
try {
  ctx = await boot('agent-studio-t103', configPath, [], scope => {
    ctx = scope;
    // Keep diagnostics owned outside the booted root so teardown errors remain visible.
    observer.logger = scope.logger;
    observer.logger.exporter({ levels: { default: 4 }, export: message => logs.push(message) });
  });
  const loader = ctx.loader;
  const configured = [...loader.entries()].filter(entry => entries.some(config => config.id === entry.options.id));
  assert.equal(configured.length, 3);
  for (const entry of configured) assert.equal(entry.fiber.state, 2);
  const remote = configured.find(entry => entry.options.id === 't103-ssh-remote');
  assert.equal(isConstructor(remote.fiber.runtime.callback), false);
  assert.equal(remote.options.name, './ssh_remote_entry.mjs');
  assert.equal(typeof ctx.subprocess.spawn, 'function');
  assert.equal(typeof ctx.subprocess.spawnTerminal, 'function');
  const first = observeHelper();
  await verifyLocalRead();
  report.startup = {
    configuredEntries: configured.map(entry => ({ id: entry.options.id, state: entry.fiber.state })),
    entryIsConstructor: isConstructor(remote.fiber.runtime.callback),
    helperEntries: first.helper.entries.size,
    intervals: timerSnapshot(),
    localFsReadAndLookup: true,
  };
  await loader.update(remote.id, { disabled: true });
  await loader.await();
  await remote.parent.tree.flushWrite();
  verifyStoredConfig(true);
  assert.equal(remote.options.disabled, true);
  assert.equal(remote.fiber.state, 4);
  assert.equal(ctx.get('sshRemote'), undefined);
  assert.equal(first.helper.disposed, true);
  assert.equal(first.disposeCalls, 1);
  assert.ok(timers.size > 0);
  assert.ok([...timers.values()].every(entry => entry.cleared));
  await verifyLocalRead();
  report.disabled = {
    persistedDisabled: readStoredEntry().disabled,
    serviceAbsent: ctx.get('sshRemote') === undefined,
    helperDisposed: first.helper.disposed,
    helperDisposeCalls: first.disposeCalls,
    intervals: timerSnapshot(),
    localFsReadAndLookup: true,
  };
  await loader.update(remote.id, { disabled: false });
  await loader.await();
  await remote.parent.tree.flushWrite();
  verifyStoredConfig(false);
  assert.equal(remote.fiber.state, 2);
  const second = observeHelper();
  assert.notEqual(second.helper, first.helper);
  await verifyLocalRead();
  report.reenabled = {
    persistedDisabled: readStoredEntry().disabled,
    state: remote.fiber.state,
    freshHelper: second.helper !== first.helper,
    localFsReadAndLookup: true,
  };
  await ctx.fiber.dispose();
  rootDisposed = true;
  const registryCount = [...ctx.registry.entries()].length;
  verifyStoredConfig(false);
  const errors = errorMessages();
  report.shutdown = {
    helperStates: helpers.map(state => ({ disposed: state.helper.disposed, disposeCalls: state.disposeCalls })),
    intervals: timerSnapshot(),
    registryCount,
    exitListenerBaseline,
    exitListenersAfter: process.listenerCount('exit'),
    configRemainsEnabled: readStoredEntry().disabled === false,
    configFullReadback: true,
  };
  report.checks = {
    allHelpersDisposedExactlyOnce: helpers.length === 2 && helpers.every(state => state.helper.disposed && state.disposeCalls === 1),
    allIntervalsCleared: timers.size >= 2 && [...timers.values()].every(entry => entry.cleared),
    registryEmpty: registryCount === 0,
    providerExitListenerRemoved: process.listenerCount('exit') === exitListenerBaseline,
    configWriteReadbackIntact: readStoredEntry().disabled === false && readStoredEntry().name === './ssh_remote_entry.mjs',
    entrySourceUnchanged: readFileSync(entrySource).equals(readFileSync(join(profile, 'ssh_remote_entry.mjs'))),
    noNetworkAttempts: networkAttempts.length === 0,
    noCordisErrors: errors.length === 0,
    isolatedHomeUnchanged: readdirSync(join(testRoot, 'home')).length === 0 && readdirSync(join(testRoot, 'dsh-home')).length === 0,
    workspaceOnlyContainsMarker: readdirSync(workspace).length === 1 && readFileSync(join(workspace, markerName), 'utf8') === marker,
  };
  report.passed = Object.values(report.checks).every(value => value === true);
} catch (error) {
  report.error = { code: error.code ?? null, message: error.message, stack: error.stack };
} finally {
  if (ctx && !rootDisposed) {
    try { await ctx.fiber.dispose(); } catch (error) { repairs.push(`root cleanup: ${error.message}`); }
  }
  for (const state of helpers) {
    if (!state.helper.disposed) {
      repairs.push('explicit helper cleanup after failed profile test');
      try { await state.helper.dispose(); } catch (error) { repairs.push(`helper cleanup: ${error.message}`); }
    }
  }
  for (const [handle, entry] of timers) {
    if (!entry.cleared) {
      repairs.push(`explicit clearing of ${entry.delay}ms interval after failed profile test`);
      globalThis.clearInterval(handle);
    }
  }
  report.cordisErrors = errorMessages();
  report.cordisWarnings = logs.filter(message => message.type === 'warn').map(message => message.args.map(String).join(' '));
  await observer.fiber.dispose();
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
}
report.networkAttempts = [...networkAttempts];
report.forcedCleanup = repairs;
report.profileEntrySha256 = createHash('sha256').update(readFileSync(entrySource)).digest('hex');
if (repairs.length || report.cordisErrors.length || report.cordisWarnings.length) report.passed = false;
const output = join(testRoot, 'profile-result.json');
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), report);
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
