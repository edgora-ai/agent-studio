// Invoke installed entrypoints; substitute only UI carriers and final OS actions.
// This is a routing probe, NOT a product binding, authentication or desktop test.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { installNetworkGuard } from './network_guard.mjs';

const [sidebar, dsh, run] = process.argv.slice(2);
assert.ok(sidebar && dsh && run && process.permission);
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.PATH, join(run, 'bin'));
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const file = p => pathToFileURL(p).href;
const host = name => join(dsh, 'node_modules/@deepseek-ai', name, 'lib/index.js');
const network = installNetworkGuard();
// Like the isolated T-103 assembly, resolve installed SDK peers explicitly.
// Do not widen reads to a profile or let Node search ancestor account folders.
const peerHook = registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier, specifier.startsWith('@deepseek-ai/')
    ? { ...context, parentURL: file(join(dsh, 'package.json')) } : context);
}, load(url, context, nextLoad) {
  if (url.startsWith(file(join(sidebar, 'src')) + '/') && url.endsWith('.ts')) {
    return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }) };
  }
  return nextLoad(url, context);
} });
const sources = [join(sidebar, 'lib/index.js'), join(sidebar, 'src/client/api.ts'),
  join(sidebar, 'src/client/open-with.ts'), host('dsh-api-session-controller'), host('dsh-host-open-in-app'),
  join(dsh, 'node_modules/@deepseek-ai/dsh-client-ui-open-in-app/lib/client.js')];
const report = { task: 'T-107', kind: 'installed-entrypoint-runtime', sourceSha256: Object.fromEntries(sources.map(p => [p, sha(p)])),
  productBindingImplemented: false, authenticationTested: false, desktopLaunched: false,
  fixture: 'Synthetic remote session + central empty anchor; actual callbacks, in-process HTTP carrier, executable action recorder.',
  cases: [], actions: [], cleanupErrors: [] };
const disposers = [], routes = new Map(), events = new EventEmitter();
const anchor = join(run, 'anchor');
const remote = { id: 't107-remote-fixture', cwd: anchor, publicCwd: '/workspace/t107-synthetic',
  binding: { realm: 'remote', workspace: 'm1-a', version: 1 }, retainedBy: { mainView: 1 } };
mkdirSync(anchor); mkdirSync(join(run, 'actions'));
// A harmless real executable, not an always-deny route. The installed code must
// actually spawn it; its exact argv is independently read from this directory.
for (const command of ['xdg-open', 'code']) {
  const path = join(run, 'bin', command);
  writeFileSync(path, `#!${process.execPath}\nconst fs=require('node:fs'),crypto=require('node:crypto');fs.writeFileSync(${JSON.stringify(join(run, 'actions'))}+'/'+crypto.randomUUID()+'.json',JSON.stringify({pid:process.pid,command:${JSON.stringify(command)},args:process.argv.slice(2)}),{flag:'wx'});`, { flag: 'wx', mode: 0o700 });
  chmodSync(path, 0o700);
}
const ctx = {
  effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
  inject: () => { /* Optional settings service is absent; never load a profile. */ },
  on: (name, fn) => { events.on(name, fn); return () => events.off(name, fn); },
  get: name => name === 'connection' ? ctx.connection : undefined,
  sessions: { get: id => id === remote.id ? { id, header: remote } : undefined },
  connection: { requestRejection: req => req.fixtureAdmission === 'accepted' ? undefined : 403 },
  webServer: {
    register: route => { assert.ok(!routes.has(route.path)); routes.set(route.path, route); return () => routes.delete(route.path); },
    registerUpgrade: route => { routes.set(route.path, route); return () => routes.delete(route.path); },
  },
  subprocess: { resolveExecutable: async name => name === 'code' ? join(run, 'bin/code') : null },
};
async function dispatch(path, payload, admission = 'accepted', method = 'POST') {
  const route = routes.get(path.startsWith('/sidebar/api/') ? '/sidebar/api' : path);
  assert.ok(route, `missing actual route ${path}`);
  const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]);
  Object.assign(req, { url: path, method, headers: { 'content-type': 'application/json' }, fixtureAdmission: admission });
  let text = '';
  const res = Object.assign(new EventEmitter(), { statusCode: 200,
    writeHead(status) { this.statusCode = status; return this; },
    setHeader() {}, end(chunk) { if (chunk) text += chunk; },
  });
  await route.handler(req, res);
  return { status: res.statusCode, body: text ? JSON.parse(text) : null };
}
async function actionsAfter(count) {
  const deadline = performance.now() + 4000;
  while (readdirSync(join(run, 'actions')).length < count && performance.now() < deadline) await delay(20);
  const rows = readdirSync(join(run, 'actions')).map(n => JSON.parse(readFileSync(join(run, 'actions', n), 'utf8')));
  assert.equal(rows.length, count);
  return rows;
}
try {
  const installed = await import(file(join(sidebar, 'lib/index.js')));
  installed.apply(ctx, {});
  report.registeredSidebarRoutes = [...routes.keys()];
  const admission = await dispatch('/sidebar/api/open.external', { action: 'reveal', path: anchor }, 'rejected');
  assert.equal(admission.status, 403); assert.equal(readdirSync(join(run, 'actions')).length, 0);
  report.cases.push({ id: 'EP-00', observed: admission, meaning: 'Actual route honors supplied admission rejection; no claim to test authentication.' });
  for (const [id, payload] of [
    ['EP-01', { action: 'reveal', path: join(anchor, 'remote.txt') }],
    ['EP-02', { action: 'url', url: 'vscode://file/' + join(anchor, 'remote.txt') }],
  ]) {
    const response = await dispatch('/sidebar/api/open.external', { ...payload, sessionId: remote.id, cwd: remote.cwd, binding: remote.binding });
    assert.equal(response.status, 200); assert.equal(response.body.value?.started ?? response.body.result?.started ?? response.body.data?.started, true);
    report.cases.push({ id, response, payload, safetyStatus: 'fail', reason: 'Installed route launches a central opener despite remote-context fields; no binding lookup.' });
  }
  await actionsAfter(2);
  const invalid = [];
  for (const payload of [{ action: 'reveal', path: '' }, { action: 'reveal', path: 'relative.txt' }, { action: 'url', url: 'https://invalid.example/' }]) {
    const response = await dispatch('/sidebar/api/open.external', payload);
    assert.equal(response.status, 400); invalid.push({ payload, response });
  }
  assert.equal(readdirSync(join(run, 'actions')).length, 2);
  report.cases.push({ id: 'EP-06', safetyStatus: 'pass', invalid, meaning: 'Actual validation rejects empty/relative paths and HTTP URLs; these controls do not reject valid-shaped remote-context requests.' });
  // Installed TypeScript is transformed by Node, not reimplemented or edited.
  const clientApi = await import(file(join(sidebar, 'src/client/api.ts')));
  const openWith = await import(file(join(sidebar, 'src/client/open-with.ts')));
  const config = { sshHost: 't107-synthetic-alias', customEditors: [], pinned: [] };
  const targets = openWith.resolveOpenWithTargets(config);
  const scheme = openWith.openWithUrl(targets.find(t => t.id === 'vscode'), remote.publicCwd + '/remote.txt', config);
  const navigations = [];
  globalThis.window = { location: { assign: url => navigations.push(url) } };
  await clientApi.api.openExternal({ action: 'url', url: scheme });
  assert.deepEqual(navigations, [scheme]);
  assert.ok(targets.some(t => t.id === 'explorer'));
  report.cases.push({ id: 'EP-03', safetyStatus: 'fail', navigations, explorerStillOffered: true,
    meaning: 'Actual API sends SSH scheme to browser navigation; no real browser handler launched or authorized remote binding proven.' });

  const hostPlugin = await import(file(host('dsh-host-open-in-app')));
  hostPlugin.apply(ctx, { probeTimeoutMs: 100, iconTimeoutMs: 100, launchWatchMs: 100 });
  const catalog = await dispatch('/open-in-app/apps', undefined, 'accepted', 'GET');
  assert.ok(catalog.body.apps.includes('vscode'));
  // The full installed client module registers its actual shortcut. Only the
  // snapshot store/React UI shells are fixtures; no route or resolve/run body is replaced.
  let client;
  const pending = [], fetched = [];
  const snapshot = value => ({ getSnapshot: () => value, set: next => { value = next; }, subscribe: () => () => {} });
  const fetcher = (url, init = {}) => {
    const promise = dispatch('/' + url.replace(/^\//, ''), init.body ? JSON.parse(init.body) : undefined, 'accepted', init.method ?? 'GET')
      .then(value => { fetched.push({ url, body: init.body ? JSON.parse(init.body) : null, status: value.status });
        return { ok: value.status === 200, status: value.status, json: async () => value.body }; });
    pending.push(promise); return promise;
  };
  const vmWindow = { __ModuleLoader__: { load: descriptor => { client = descriptor.factory(name => {
    if (name === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: snapshot };
    if (['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'].includes(name)) return {};
    throw new Error(`T107_UNEXPECTED_CLIENT_DEPENDENCY:${name}`);
  }); } } };
  runInNewContext(readFileSync(sources[5], 'utf8'), { window: vmWindow, fetch: fetcher, console, AbortController, URL, setTimeout, clearTimeout }, { filename: sources[5], timeout: 2000 });
  const shortcuts = [];
  client.apply({ effect: ctx.effect, remote: { session: {} },
    locale: { register: () => () => {}, bind: () => key => key },
    layout: { panelInfo: { getSnapshot: () => ({ activePanelId: null }) } },
    sessions: { list: { getSnapshot: () => ({ byId: { [remote.id]: remote } }) } },
    shortcuts: { register: spec => { shortcuts.push(spec); return () => shortcuts.splice(shortcuts.indexOf(spec), 1); } },
    slots: { inject: () => {} },
  });
  await Promise.all(pending); await delay(0);
  const shortcut = shortcuts.find(s => s.id === 'workspace.openLocal'); assert.ok(shortcut);
  const resolved = shortcut.resolve(); assert.equal(resolved.status, 'handled'); resolved.run();
  await Promise.all(pending); const actions = await actionsAfter(3);
  assert.ok(actions.some(a => a.command === 'code' && a.args.includes(anchor)));
  report.cases.push({ id: 'EP-04', safetyStatus: 'fail', registeredId: shortcut.id, defaults: shortcut.defaults,
    resolved: resolved.status, fetched, remoteContext: remote,
    meaning: 'Actual registered shortcut -> actual host route -> real recorder spawn on central empty anchor. No DOM key-dispatch or product binding implementation claimed.' });
  report.actions = actions;
  // Exercise genuine Host API methods with actual LocalFileSystem composition;
  // the safe final callback observes dispatch but does not open a desktop.
  const { Context } = await import(file(host('cordis')));
  const { default: LocalFileSystem } = await import(file(host('dsh-fs-local')));
  const { SessionController } = await import(file(host('dsh-api-session-controller')));
  const local = new Context(); const fiber = local.plugin(LocalFileSystem, { cwd: anchor }); await fiber;
  try {
    const api = Object.create(SessionController.prototype), calls = [];
    api.ctx = { fs: local.get('fs') };
    api.revealPath = async path => { calls.push({ action: 'reveal', path }); };
    api.openPath = async path => { calls.push({ action: 'open', path }); };
    const signal = new AbortController().signal;
    const result = await api.openWorkspacePath({ path: anchor, action: 'reveal', sessionId: remote.id, binding: remote.binding }, signal);
    assert.deepEqual(result, { opened: true }); assert.equal(calls[0].path, anchor);
    await assert.rejects(api.openWorkspacePath({ path: '', binding: remote.binding }, signal));
    report.cases.push({ id: 'EP-05', safetyStatus: 'fail', result, calls,
      meaning: 'Actual Host API + actual local FS maps central anchor and calls native action seam. No session binding check; empty-path rejection is validation, not remote routing.' });
  } finally { await fiber.dispose(); }
} catch (error) {
  report.failure = { name: error.name, code: error.code ?? null, resource: error.resource ?? null, message: String(error.message).slice(0, 600) };
} finally {
  for (const dispose of disposers.reverse()) { try { await dispose(); } catch (error) { report.cleanupErrors.push(error.name); } }
  report.networkAttempts = network;
  report.routesRemaining = routes.size;
  report.eventListenersRemaining = events.eventNames().reduce((n, name) => n + events.listenerCount(name), 0);
  report.sourceUnchanged = sources.every(p => sha(p) === report.sourceSha256[p]);
  report.probePassed = !report.failure && report.cases.length === 7 && !report.cleanupErrors.length && !network.length && report.sourceUnchanged && routes.size === 0 && report.eventListenersRemaining === 0;
  writeFileSync(join(run, 'entrypoints.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
console.log(JSON.stringify({ probePassed: report.probePassed, cases: report.cases.map(c => ({ id: c.id, safetyStatus: c.safetyStatus })), failure: report.failure }));
process.exitCode = report.probePassed ? 0 : 1;
