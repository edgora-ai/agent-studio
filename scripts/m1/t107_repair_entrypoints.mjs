// Isolated wrappers around actual installed registrations/functions, no source patch.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { installNetworkGuard } from './network_guard.mjs';
import { ContextAuthority } from './t107_repair_guard.mjs';
const [sidebar, dsh, run] = process.argv.slice(2);
assert.ok(process.permission); assert.equal(process.env.HOME, join(run, 'home')); assert.equal(process.env.PATH, join(run, 'bin'));
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const file = p => pathToFileURL(p).href, host = name => join(dsh, 'node_modules/@deepseek-ai', name, 'lib/index.js');
const network = installNetworkGuard();
const peerHook = registerHooks({ resolve(s, c, next) { return next(s, s.startsWith('@deepseek-ai/') ? { ...c, parentURL: file(join(dsh, 'package.json')) } : c); },
  load(url, c, next) { if (url.startsWith(file(join(sidebar, 'src')) + '/') && url.endsWith('.ts'))
    return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }) };
    return next(url, c); } });
const sources = [join(sidebar, 'lib/index.js'), join(sidebar, 'src/client/api.ts'), join(sidebar, 'src/client/open-with.ts'),
  host('dsh-api-session-controller'), host('dsh-host-open-in-app'), join(dsh, 'node_modules/@deepseek-ai/dsh-client-ui-open-in-app/lib/client.js'),
  join(sidebar, 'src/open-external.ts'), join(sidebar, 'LICENSE')];
const pinned = ['871e8d02a7b37ea487308d8516d839d51fedfe46f1c3ed50d99435acc984c7e1','f04af9246b2f34bc63af2b42e1e3cb6dd39359adf7f1cb43b1e8102a72b4e98c',
  '07eed2621c0182c3753a7d179253b68b6ccf26536260062e9bcf0e99e890edbf','a9801acb577b03053c5d5a3191ff555c5f1d791d0acddec113bea4511e33b386',
  'b1d17a0c2646389b27eefab2e1e22576a693b11c61c76884fc049aff54e00d96','7a3adda611ea8318322e474294cba4c5a36be30f879c98dc52a41b57363cd6dc',
  '535a4d38c5ac2e4c33fc68b83b1c24ef1e1a4dacbbe7541f6098cc86fe0b10bf','f4d265194e0824721af0592462a71fe750c04db3565c23c5d6c65fdee25fb4b0'];
assert.deepEqual(sources.map(sha), pinned);
const report = { task: 'T-107-repair2', kind: 'actual-guarded-entrypoints-local-only', sourceSha256: Object.fromEntries(sources.map(p => [p, sha(p)])),
  upstreamPatched: false, sidebarLicense: 'MIT', productBindingPersistence: false, authenticationTested: false, domKeyboardTested: false,
  cases: [], cleanupErrors: [], authority: 'server fixture registry + opaque captured capability; request realm/cwd never authority' };
let now = 100;
const guard = new ContextAuthority(() => now);
const issue = (id, realm = 'local', generation = 1, expiresAt = 1000) => guard.register({ id, realm, generation, expiresAt, principal: 'fixture-principal' });
const localHandle = issue('local'), remoteHandle = issue('remote', 'remote'), expired = issue('expired', 'local', 1, 99), stale = issue('stale'); issue('stale', 'local', 2);
const badContexts = [['remote', remoteHandle], ['unknown', {}], ['absent', undefined], ['expired', expired], ['stale', stale]];
const routes = new Map(), disposers = [], events = new EventEmitter(), navigations = [], hostActions = [], pending = [], fetched = [];
const anchor = join(run, 'anchor'); mkdirSync(anchor); mkdirSync(join(run, 'actions'));
let active = { id: 'local', cwd: anchor, publicCwd: '/workspace/synthetic', realm: 'remote', retainedBy: { mainView: 1 } };
for (const command of ['xdg-open', 'code']) writeFileSync(join(run, 'bin', command), `#!${process.execPath}\nconst fs=require('node:fs'),crypto=require('node:crypto');fs.writeFileSync(${JSON.stringify(join(run, 'actions'))}+'/'+crypto.randomUUID()+'.json',JSON.stringify({pid:process.pid,command:${JSON.stringify(command)},args:process.argv.slice(2)}),{flag:'wx'});`, { flag: 'wx', mode: 0o700 });
const ctx = { effect: fn => { const d = fn(); if (typeof d === 'function') disposers.push(d); }, inject: () => {},
  on: (n, fn) => { events.on(n, fn); return () => events.off(n, fn); }, get: n => n === 'connection' ? ctx.connection : undefined,
  sessions: { get: id => id === active.id ? { id, header: active } : undefined },
  connection: { requestRejection: req => req.fixtureAdmission === 'accepted' ? undefined : 403 },
  webServer: { register: route => { assert.ok(!routes.has(route.path)); routes.set(route.path, guard.route(route)); return () => routes.delete(route.path); },
    registerUpgrade: route => { routes.set(route.path, route); return () => routes.delete(route.path); } },
  subprocess: { resolveExecutable: async n => n === 'code' ? join(run, 'bin/code') : null } };
async function dispatch(path, payload, admission = 'accepted', method = 'POST') {
  const route = routes.get(path.startsWith('/sidebar/api/') ? '/sidebar/api' : path); assert.ok(route);
  const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]);
  Object.assign(req, { url: path, method, headers: { 'content-type': 'application/json' }, fixtureAdmission: admission });
  let text = ''; const res = Object.assign(new EventEmitter(), { statusCode: 200,
    writeHead(status) { this.statusCode = status; return this; }, setHeader() {}, end(s) { if (s) text += s; } });
  await route.handler(req, res); return { status: res.statusCode, body: text ? JSON.parse(text) : null };
}
const counts = () => ({ executables: readdirSync(join(run, 'actions')).length, navigations: navigations.length, hostActions: hostActions.length, fetches: fetched.length });
async function actionsAfter(n) {
  const end = performance.now() + 4000;
  while (counts().executables < n && performance.now() < end) await delay(20);
  assert.equal(counts().executables, n);
}
async function negative(id, handle, action) {
  const before = counts(); let rejection;
  await guard.inject(handle, async () => {
    try { const result = await action();
      if (result?.status === 403 || result?.status === 'blocked') rejection = result;
    } catch (e) { if (!String(e.code).startsWith('T107_')) throw e; rejection = { code: e.code }; }
  });
  assert.ok(rejection, id); await Promise.all(pending); await delay(40); assert.deepEqual(counts(), before, id);
  report.cases.push({ id, rejected: rejection, zeroEffects: true });
}
let localFiber;
try {
  (await import(file(join(sidebar, 'lib/index.js')))).apply(ctx, {});
  (await import(file(host('dsh-host-open-in-app')))).apply(ctx, { probeTimeoutMs: 100, iconTimeoutMs: 100, launchWatchMs: 100 });
  const catalog = await dispatch('/open-in-app/apps', undefined, 'accepted', 'GET'); assert.ok(catalog.body.apps.includes('vscode'));
  const originalApi = (await import(file(join(sidebar, 'src/client/api.ts')))).api;
  const api = { ...originalApi, openExternal: guard.wrap(originalApi.openExternal) };
  const openWith = await import(file(join(sidebar, 'src/client/open-with.ts')));
  const config = { sshHost: 't107-synthetic-alias', customEditors: [], pinned: [] };
  const scheme = openWith.openWithUrl(openWith.resolveOpenWithTargets(config).find(t => t.id === 'vscode'), active.publicCwd, config);
  globalThis.window = { location: { assign: url => navigations.push(url) } };
  const launch = guard.wrap((await import(file(join(sidebar, 'src/open-external.ts')))).launchExternal, () => undefined);
  const { Context } = await import(file(host('cordis'))), { default: LocalFileSystem } = await import(file(host('dsh-fs-local')));
  const { SessionController } = await import(file(host('dsh-api-session-controller')));
  const local = new Context(); localFiber = local.plugin(LocalFileSystem, { cwd: anchor }); await localFiber;
  const hostApi = Object.create(SessionController.prototype); hostApi.ctx = { fs: local.get('fs') };
  hostApi.revealPath = async path => { hostActions.push({ action: 'reveal', path }); };
  hostApi.openPath = async path => { hostActions.push({ action: 'open', path }); };
  hostApi.openWorkspacePath = guard.wrap(hostApi.openWorkspacePath);
  let client; const shortcuts = [];
  const snapshot = value => ({ getSnapshot: () => value, set: v => { value = v; }, subscribe: () => () => {} });
  const fetcher = (url, init = {}) => {
    const promise = dispatch('/' + url.replace(/^\//, ''), init.body ? JSON.parse(init.body) : undefined, 'accepted', init.method ?? 'GET').then(value => {
      fetched.push({ url, status: value.status }); return { ok: value.status === 200, status: value.status, json: async () => value.body }; });
    pending.push(promise); return promise;
  };
  runInNewContext(readFileSync(sources[5], 'utf8'), { window: { __ModuleLoader__: { load: descriptor => { client = descriptor.factory(name => {
    if (name === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: snapshot };
    if (['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'].includes(name)) return {};
    throw new Error('T107_UNEXPECTED_CLIENT_DEPENDENCY');
  }); } } }, fetch: fetcher, console, AbortController, URL, setTimeout, clearTimeout }, { filename: sources[5], timeout: 2000 });
  client.apply({ effect: ctx.effect, remote: { session: {} }, locale: { register: () => () => {}, bind: () => k => k },
    layout: { panelInfo: { getSnapshot: () => ({ activePanelId: null }) } }, sessions: { list: { getSnapshot: () => ({ byId: { [active.id]: active } }) } },
    shortcuts: { register: spec => { const wrapped = guard.shortcut(spec, () => ({ sessionId: active.id })); shortcuts.push(wrapped); return () => shortcuts.splice(shortcuts.indexOf(wrapped), 1); } },
    slots: { inject: () => {} } });
  await Promise.all(pending); await delay(0);
  const shortcut = shortcuts.find(s => s.id === 'workspace.openLocal'); assert.ok(shortcut);
  const signal = new AbortController().signal;
  const surfaces = [
    ['sidebar-reveal', () => dispatch('/sidebar/api/open.external', { action: 'reveal', path: anchor, realm: 'local' })],
    ['sidebar-url', () => dispatch('/sidebar/api/open.external', { action: 'url', url: 'vscode://file/' + anchor, realm: 'local' })],
    ['host-route', () => dispatch('/open-in-app/open', { app: 'vscode', path: anchor, realm: 'local' })],
    ['host-api', () => hostApi.openWorkspacePath({ path: anchor, action: 'reveal', realm: 'local' }, signal)],
    ['local-opener', () => launch('reveal', anchor)],
    ['client-scheme', () => api.openExternal({ action: 'url', url: scheme, realm: 'local' })],
    ['registered-shortcut', () => shortcut.resolve()],
  ];
  for (const [name, handle] of badContexts) for (const [surface, action] of surfaces) await negative(name + '/' + surface, handle, action);
  for (const [name, invoke] of [
    ['sidebar', () => dispatch('/sidebar/api/open.external', { action: 'reveal', path: anchor, sessionId: 'remote' })],
    ['host-route', () => dispatch('/open-in-app/open', { app: 'vscode', path: anchor, generation: 2 })],
    ['host-api', () => hostApi.openWorkspacePath({ path: anchor, binding: { realm: 'local' } }, signal)],
    ['scheme', () => api.openExternal({ action: 'url', url: scheme, contextId: 'remote' })],
  ]) await negative('mismatch/' + name, localHandle, invoke);
  active = { ...active, id: 'remote', realm: 'local' };
  await negative('mismatch/shortcut-selected-session', localHandle, () => shortcut.resolve()); active = { ...active, id: 'local' };
  const selected = guard.inject(localHandle, () => shortcut.resolve()); assert.equal(selected.status, 'handled');
  await negative('shortcut/run-remote-context', remoteHandle, () => selected.run());
  const short = issue('short', 'local', 1, 101); active = { ...active, id: 'short' };
  const late = guard.inject(short, () => shortcut.resolve()); assert.equal(late.status, 'handled'); now = 102;
  await negative('shortcut/run-expired-context', short, () => late.run()); active = { ...active, id: 'local' };
  // Only the two spellings already identified in review2, plus canonical control.
  const spellings = [['canonical', '/sidebar/api/open.external'], ['dot', '/sidebar/api/./open.external'], ['encoded-dot', '/sidebar/api/%2e/open.external']];
  report.routeSpellings = spellings.map(([id, target]) => ({ id, target }));
  const forged = { action: 'reveal', path: anchor, realm: 'local', sessionId: 'local', binding: { realm: 'local' } };
  for (const [name, target] of spellings) for (const [context, handle] of [['remote', remoteHandle], ['absent', undefined], ['forged', {}]])
    await negative('route-normalization/' + name + '/' + context, handle, () => dispatch(target, forged));
  const directoryBefore = counts();
  const directory = await dispatch('/sidebar/api/fs.tree', { sessionId: 'directory-fixture', cwd: anchor });
  assert.equal(directory.status, 200); assert.deepEqual(directory.body.value.entries, []);
  assert.deepEqual(counts(), directoryBefore); assert.equal(catalog.status, 200);
  report.nonActionControls = [{ id: 'directory-read', target: '/sidebar/api/fs.tree', status: 200, entries: 0 },
    { id: 'application-catalog', target: '/open-in-app/apps', status: catalog.status }];
  await guard.inject(localHandle, async () => {
    const admission = await dispatch('/sidebar/api/open.external', { action: 'reveal', path: anchor }, 'rejected'); assert.equal(admission.status, 403);
    for (const [name, action] of surfaces.slice(0, 6)) {
      const result = await action(); if (name.endsWith('route') || name.startsWith('sidebar')) assert.equal(result.status, 200);
      report.cases.push({ id: 'local-positive/' + name, passed: true });
    }
    const resolved = shortcut.resolve(); assert.equal(resolved.status, 'handled'); resolved.run(); await Promise.all(pending);
    report.cases.push({ id: 'local-positive/registered-shortcut', passed: true, registeredId: shortcut.id, defaults: shortcut.defaults });
  });
  await actionsAfter(5); assert.equal(navigations.length, 1); assert.equal(hostActions.length, 1);
  for (const [name, target] of spellings) {
    const before = new Set(readdirSync(join(run, 'actions')));
    const result = await guard.inject(localHandle, () => dispatch(target, { action: 'reveal', path: anchor }));
    assert.equal(result.status, 200); assert.equal(result.body.value.started, true);
    await actionsAfter(before.size + 1);
    const added = readdirSync(join(run, 'actions')).filter(n => !before.has(n)); assert.equal(added.length, 1);
    const action = JSON.parse(readFileSync(join(run, 'actions', added[0])));
    // Real reveal semantics opens the containing directory, not anchor itself.
    assert.equal(action.command, 'xdg-open'); assert.deepEqual(action.args, [dirname(anchor)]);
    report.cases.push({ id: 'local-positive/route-normalization/' + name, target, status: result.status, passed: true, action });
  }
  await actionsAfter(8);
  report.actions = readdirSync(join(run, 'actions')).map(n => JSON.parse(readFileSync(join(run, 'actions', n))));
  assert.equal(report.actions.filter(a => a.command === 'code').length, 2);
  report.navigations = navigations; report.hostActions = hostActions; report.fetched = fetched;
  report.negativeCases = report.cases.filter(c => c.zeroEffects).length;
  report.positiveCases = report.cases.filter(c => c.passed).length;
} catch (error) { report.failure = { name: error.name, code: error.code ?? null, message: String(error.message).slice(0, 400) }; }
finally {
  if (localFiber) { try { await localFiber.dispose(); } catch (e) { report.cleanupErrors.push(e.name); } }
  for (const dispose of disposers.reverse()) { try { await dispose(); } catch (e) { report.cleanupErrors.push(e.name); } }
  peerHook.deregister(); report.networkAttempts = network; report.routesRemaining = routes.size;
  report.listenersRemaining = events.eventNames().reduce((n, name) => n + events.listenerCount(name), 0);
  report.sourceUnchanged = sources.every((p, i) => sha(p) === pinned[i]);
  report.passed = !report.failure && !report.cleanupErrors.length && report.negativeCases === 51 && report.positiveCases === 10 && report.nonActionControls.length === 2 && !network.length && !routes.size && !report.listenersRemaining && report.sourceUnchanged;
  writeFileSync(join(run, 'entrypoints.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
console.log(JSON.stringify({ passed: report.passed, negatives: report.negativeCases, positives: report.positiveCases, failure: report.failure }));
process.exitCode = report.passed ? 0 : 1;
