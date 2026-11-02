#!/usr/bin/env node
// T-201 first offline acceptance slice. New temp root, no preview, no remote,
// no network, no writes outside the temporary root and the evidence artifact.
import assert from 'node:assert/strict';
import {mkdtemp, rm, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdir, writeFile} from 'node:fs/promises';
import {Store, StudioError} from '../../packages/dsh-agent-studio/store.mjs';
import {Bindings} from '../../packages/dsh-agent-studio/bindings.mjs';

const repo = new URL('../..', import.meta.url).pathname;
const root = await mkdtemp(join(tmpdir(), 'agent-studio-test-t201-'));
const checks = [];
const pass = (name, facts = {}) => { checks.push({name, ...facts}); console.log('PASS ' + name); };

function fakeContext() {
  const workspaces = new Map(), sessions = new Map(), snapshots = new Map();
  const ctx = {
    workspaceRegistry: {
      async create(path, name) {
        const workspace = {id: 'workspace-' + randomUUID(), path, name, sessionIds: [], async attachSession(id) { this.sessionIds.push(id); }};
        workspaces.set(workspace.id, workspace); return workspace;
      },
      get: id => workspaces.get(id),
    },
    sessionPersistence: {async stat(id) { return snapshots.get(id) ?? null; }},
    sessions: {get: id => sessions.get(id), async flush(session) { snapshots.set(session.id, {header: {cwd: session.header.cwd}, sizeBytes: 1}); }},
    agents: {async create({sessionId, meta}) {
      const session = {id: sessionId, header: {cwd: meta.cwd}, title: ''};
      sessions.set(sessionId, session); return {agent: {session}};
    }},
    sessionTitle: {rename(session, title) { session.title = title; }},
    sessionController: {async inspect(id) { return {meta: {cwd: snapshots.get(id).header.cwd}}; }},
  };
  return {ctx, workspaces, sessions};
}

function directRows(path, table, key, value) {
  const db = new DatabaseSync(path, {readOnly: true});
  try { const row = db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(value); return row ? {...row} : null; }
  finally { db.close(); }
}

const uuid = () => randomUUID();
const spec = {
  key: 't201-coder', kind: 'coder', name: 'OFFLINE T-201 fixture', provider: 'coder-helper',
  policy_version: 't201-policy', generation: 't201-generation-a', workspace_id: uuid(), agent_id: uuid(),
  template_version: 't201-v1', roots: ['/workspace'],
};
let store;
try {
  store = new Store(root);
  await mkdir(join(root, 'anchors'), {recursive: true, mode: 0o700});
  const principal = store.principal;
  const project = store.project(principal, {name: 'T-201 offline project'});
  const environment = store.environment(principal, spec);
  const {ctx} = fakeContext();
  const bindings = new Bindings(ctx, store, root, [spec]);

  const binding = await bindings.createBinding(principal, {project_id: project.project_id, environment_id: environment.environment_id});
  assert.equal(binding.state, 'ready');
  assert.ok(binding.anchor_dev && binding.anchor_ino && binding.workspace_id);
  assert.deepEqual(await readdir(binding.anchor_path), []);
  assert.deepEqual({...binding}, {...directRows(store.path, 'project_bindings', 'binding_id', binding.binding_id), version: binding.version});
  pass('project/environment/binding persistence and internal anchor registration', {binding_id: binding.binding_id, version: binding.version, anchor_path: binding.anchor_path, anchor_dev: binding.anchor_dev, anchor_ino: binding.anchor_ino, workspace_id: binding.workspace_id});

  const session = await bindings.createSession(principal, {binding_id: binding.binding_id, version: binding.version, title: 'T-201 session'});
  assert.equal(session.state, 'ready');
  assert.equal(session.binding_id, binding.binding_id);
  assert.equal(session.version, binding.version);
  const readSession = await bindings.readSession(principal, session.session_id);
  assert.equal(readSession.native.snapshot.header.cwd, binding.anchor_path);
  assert.equal(readSession.native.inspection.meta.cwd, binding.anchor_path);
  assert.ok(ctx.workspaceRegistry.get(binding.workspace_id).sessionIds.includes(session.session_id));
  assert.deepEqual({...session}, directRows(store.path, 'session_bindings', 'session_id', session.session_id));
  pass('session binds to ready binding version, native cwd follows the anchor and is attached to the workspace', {session_id: session.session_id, cwd: binding.anchor_path});

  const operation = store.beginOperation(principal, session, 'command.exec', {operation_id: 't201-operation-' + uuid(), argv: ['/usr/bin/true']});
  const running = store.updateOperation(principal, operation.operation_id, {state: 'running', remote_process_id: 't201-process', remote_pid: 4242, helper_session_id: 't201-helper', channel_id: 't201-channel'});
  assert.deepEqual(directRows(store.path, 'operation_records', 'operation_id', running.operation_id), running);
  assert.deepEqual(store.operation(principal, running.operation_id), running);
  assert.ok(store.operations(principal, session.session_id).some(row => row.operation_id === running.operation_id));
  assert.throws(() => store.operation('other-owner', running.operation_id), {code: 'operation-not-found'});
  pass('write -> direct read-only SQL -> API by ID -> session list keeps the full operation identity', {operation_id: running.operation_id, remote_pid: running.remote_pid, helper_session_id: running.helper_session_id, channel_id: running.channel_id});

  assert.throws(() => store.db.prepare('UPDATE project_bindings SET target_root=? WHERE binding_id=?').run('/other', binding.binding_id), /immutable/);
  store.close();
  store = new Store(root);
  const ctx2 = fakeContext().ctx;
  const reopenedBindings = new Bindings(ctx2, store, root, [spec]);
  assert.deepEqual(store.binding(principal, binding.binding_id, binding.version), binding);
  assert.deepEqual(store.get('session_bindings', 'session_id', session.session_id, principal), session);
  assert.deepEqual(store.operation(principal, running.operation_id), running);
  assert.deepEqual(await readdir(binding.anchor_path), []);
  store.markInterrupted();
  const interrupted = store.operation(principal, running.operation_id);
  assert.equal(interrupted.state, 'unknown');
  assert.equal(interrupted.error_code, 'preview-restarted');
  for (const key of ['request_json', 'remote_pid', 'remote_process_id', 'helper_session_id', 'channel_id']) assert.equal(interrupted[key], running[key]);
  pass('restart/readback keeps immutable binding, session, anchor and operation identity; running becomes unknown preview-restarted without replay', {operation_state: interrupted.state});

  const next = await reopenedBindings.createBinding(principal, {project_id: project.project_id, environment_id: environment.environment_id, binding_id: binding.binding_id, expected_version: binding.version});
  const previous = store.binding(principal, binding.binding_id, binding.version);
  assert.equal(next.version, binding.version + 1);
  assert.equal(previous.state, 'superseded');
  assert.notEqual(next.anchor_path, binding.anchor_path);
  assert.equal(previous.target_root, binding.target_root);
  const nextSession = await reopenedBindings.createSession(principal, {binding_id: next.binding_id, version: next.version, title: 'T-201 session v2'});
  assert.equal(nextSession.version, next.version);
  assert.equal(store.get('session_bindings', 'session_id', session.session_id, principal).version, binding.version);
  pass('version CAS opens a new immutable binding version and session while the old version/session stay readable', {old_version: binding.version, new_version: next.version, old_state: previous.state, new_anchor: next.anchor_path});

  const guard = new Bindings(ctx2, store, root, [spec]);
  let verifications = 0, failChannel = true;
  guard.provider = {async verify() { verifications += 1; if (failChannel) throw new StudioError('channel-disconnected'); }};
  const request = {session_id: nextSession.session_id, operation: 'fs.read'};
  await assert.rejects(() => guard.check(principal, request), {code: 'channel-disconnected'});
  assert.equal(verifications, 1);
  assert.equal(store.binding(principal, next.binding_id, next.version).state, 'ready');
  failChannel = false;
  const allowed = await guard.check(principal, request);
  assert.equal(allowed.execution_available, true);
  assert.equal(verifications, 2);
  await assert.rejects(() => guard.check(principal, {session_id: session.session_id, operation: 'fs.read'}), {code: 'stale-binding'});
  pass('cached ready-binding equality cannot authorize a new channel: every dispatch verifies the live channel and a superseded version is refused', {verifications, stale_code: 'stale-binding'});
} catch (error) {
  console.error(JSON.stringify({result: 'fail', error: error.code ?? error.name, message: String(error.message).slice(0, 300)}));
  process.exitCode = 1;
} finally {
  if (store) store.close();
  const resolved = await import('node:fs/promises').then(fs => fs.realpath(root)).catch(() => null);
  if (resolved && resolved.startsWith(join(tmpdir(), 'agent-studio-test-t201-'))) await rm(resolved, {recursive: true, force: true});
  await mkdir(join(repo, 'artifacts/t201'), {recursive: true});
  const artifact = join(repo, 'artifacts/t201/t201-slice-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  await writeFile(artifact, JSON.stringify({scope: 'T-201 offline acceptance slice; temp root only; no preview/remote/network/model', checks, result: process.exitCode ? 'fail' : 'pass'}, null, 2) + '\n');
  console.log(JSON.stringify({result: process.exitCode ? 'fail' : 'pass', checks: checks.length, artifact}));
}
