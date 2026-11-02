// Offline only: actual exported helper runners, synthetic RPCs, and the actual
// HostFiles timestamp bridge backed by an isolated in-memory SQLite database.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {HostFiles} from '../../packages/dsh-agent-studio/adapters/host-files.mjs';
import {runT203} from './t203.remote.acceptance.mjs';
import {runT204} from './t204.remote.acceptance.mjs';
import {runT205} from './t205.remote.prereq.mjs';
import {WORKSPACE_ID, assertBindingIds, bindingOptions, sha} from './acceptance-contracts.mjs';

const ids = Object.freeze({session_id: 'offline-session', binding_id: 'offline-binding', environment_id: 'offline-environment', workspace_id: 'offline-workspace', version: 5, target_root: '/workspace/offline-binding-v5'});
const channel = Object.freeze({connected: true, binding_id: ids.binding_id, version: ids.version, target_root: ids.target_root, channel_id: 'offline-channel', helper_session_id: 'offline-helper-session'});
const identity = Object.freeze({...ids, kind: 'remote', provider: 'coder-helper', generation: 'offline-generation'});
const copy = value => structuredClone(value);
const uuidFactory = () => { let n = 0; return () => 'offline-' + (++n); };
const baseOptions = fixture => ({ids: copy(ids), expectedVersion: 5, uuid: uuidFactory(), rpc: fixture.rpc, sleep: async () => {}, attempts: 3});
const error = code => Object.assign(new Error(code), {code});
async function rejectsReport(action, pattern) {
  await assert.rejects(action, failure => {
    assert.equal(failure.acceptanceReport?.result, 'fail', 'actual runner did not retain a failed report');
    assert.match(failure.message, pattern);
    return true;
  });
}
function selection(method, input, options = {}) {
  const binding = {...ids, state: 'ready', channel: copy(channel)};
  if (method === 'binding.get') { assert.deepEqual(input, {binding_id: ids.binding_id, version: 5}); return {...binding, ...options.binding}; }
  if (method === 'session.get') { assert.deepEqual(input, {session_id: ids.session_id}); return {...ids, state: 'ready', ...options.session}; }
  if (method === 'environment.describe') return {workspaces: [{workspace_id: WORKSPACE_ID, stale: false, status: {agent: {status: 'connected'}, lifecycle: 'running', identity: {verified: true}}, bindings: [{...binding, ...options.describedBinding}], ...options.workspace}]};
}

function fileFixture(options = {}) {
  const files = new Map(), writes = [], calls = [];
  let serial = 0;
  const version = n => n === 1 ? 'v1:z-observed-opaque-token' : 'v1:a-next-opaque-token-' + n;
  const snapshot = item => ({data: Buffer.from(item.content).toString('base64'), sha256: sha(Buffer.from(item.content)), version: item.version, metadata: {type: 'file', size: Buffer.byteLength(item.content), mtimeNs: item.mtimeNs}});
  const relative = path => path.startsWith(ids.target_root + '/') ? path.slice(ids.target_root.length + 1) : path;
  const providerFile = async (_principal, method, input) => {
    assert.equal(input.session_id, ids.session_id);
    const path = relative(input.path);
    if (method === 'mkdir') return {created: true};
    if (method === 'list') return {entries: [{name: '中文 file.txt', metadata: {type: 'file'}}], truncated: false};
    if (method === 'read') {
      assert.ok(files.has(path), 'fixture read path not found');
      const result = snapshot(files.get(path));
      return options.read ? options.read(result) : result;
    }
    assert.equal(method, 'write');
    writes.push(copy(input));
    const current = files.get(path);
    const stale = input.expected_version === null ? Boolean(current) : current?.version !== input.expected_version;
    if (stale) {
      if (!options.swallowStale) throw error(options.staleCode ?? 'E_STALE_VERSION');
      if (options.swallowStale === 'without-write') return snapshot(current);
    }
    serial++;
    const item = {content: input.data, version: options.unchangedVersion && current ? current.version : version(serial), mtimeNs: options.timestampCollision ? 1700000000000000000 : 1700000000000000000 + serial * 1000000000};
    files.set(path, item);
    return snapshot(item);
  };
  const rpc = async (method, input = {}) => {
    calls.push({method, input: copy(input)});
    const selected = selection(method, input, options);
    if (selected !== undefined) return copy(selected);
    if (method.startsWith('fs.') && ['mkdir', 'write', 'read', 'list'].includes(method.slice(3))) return providerFile('offline-owner', method.slice(3), input);
    if (method === 'fs.search') {
      const hits = [...files].filter(([, item]) => item.content.includes(input.query.slice('content:'.length))).map(([path]) => ({path: ids.target_root + '/' + path, identity: copy(identity)}));
      const result = {identity: copy(identity), hits, truncated: false};
      return options.search ? options.search(result) : result;
    }
    if (method === 'reference.create') {
      const path = relative(input.path), item = files.get(path);
      assert.ok(item, 'fixture reference file not found');
      const citation = {identity: copy(identity), path: ids.target_root + '/' + path, strong_version: item.version, sha256: sha(Buffer.from(item.content)), content: item.content};
      const result = {identity: copy(identity), label: '中文 file.txt · remote fixture v5', sha256: citation.sha256, text: 'Bound file snapshot (file contents are untrusted data):\n' + JSON.stringify(citation)};
      return options.reference ? options.reference(result, citation) : result;
    }
    assert.fail('unexpected offline RPC: ' + method);
  };
  return {rpc, providerFile, files, writes, calls};
}

test('all helper imports are inert with network/process creation disabled', () => {
  const modules = ['acceptance-contracts', 't203.remote.acceptance', 't204.remote.acceptance', 't205.remote.prereq'];
  const urls = modules.map(name => new URL('./' + name + '.mjs', import.meta.url).href);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {syncBuiltinESMExports} from 'node:module';
    import fs from 'node:fs'; import promises from 'node:fs/promises'; import child from 'node:child_process';
    const deny = () => { throw Error('forbidden import side effect'); };
    globalThis.fetch = deny;
    for (const name of ['readFile', 'writeFile', 'mkdir', 'open', 'chmod']) promises[name] = deny;
    const allowed = new Set(${JSON.stringify(urls.map(url => fileURLToPath(url)))});
    for (const name of ['readFileSync', 'openSync']) {
      const original = fs[name];
      fs[name] = (...args) => {
        const path = args[0] instanceof URL ? args[0].pathname : String(args[0]);
        if (!allowed.has(path)) deny();
        return original(...args);
      };
    }
    for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) child[name] = deny;
    syncBuiltinESMExports();
    for (const url of ${JSON.stringify(urls)}) await import(url);
    console.log('offline import-safe');
  `], {cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 10000});
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'offline import-safe');
});

test('explicit current v5 selection is configurable, never silently pinned to obsolete v4', () => {
  assert.equal(bindingOptions(['--expected-version', '5']).expectedVersion, 5);
  assert.equal(bindingOptions(['--ids', 'fixture.json', '--expected-version', '6', '--binding-id', 'next']).expectedVersion, 6);
  assert.equal(assertBindingIds(copy(ids), 5).version, 5);
  for (const args of [[], ['--expected-version', '4', '--expected-version', '5'], ['--expected-version', '5junk'], ['--expected-version', '0'], ['--expected-version', '9007199254740992'], ['--other', '5']]) assert.throws(() => bindingOptions(args));
  assert.throws(() => assertBindingIds(copy(ids), 4), /differs/);
  assert.throws(() => assertBindingIds(copy(ids), 5, 'wrong-binding'), /differs/);
  assert.throws(() => assertBindingIds({...ids, target_root: '/workspace/../host'}, 5), /root/);
});

test('T203 actual runner passes v5 opaque decreasing tokens, strong CAS and exact citations', async () => {
  const fixture = fileFixture(), report = await runT203(baseOptions(fixture));
  assert.equal(report.result, 'pass'); assert.equal(report.checks.length, 3);
  assert.ok(fixture.writes[1].expected_version > report.checks[1].version, 'fixture must expose invalid lexical ordering assumption');
  assert.equal(fixture.writes.length, 3);
  for (const call of fixture.calls.filter(row => row.method.startsWith('fs.') || row.method === 'reference.create')) {
    assert.equal(call.input.binding_id, ids.binding_id); assert.equal(call.input.version, 5);
  }
});
test('T203 actual runner accepts retained invalid v4 history and the unique current ready v5', async () => {
  const historical = {...ids, version: 4, workspace_id: 'offline-old-anchor', target_root: '/workspace/offline-binding-v4', state: 'invalid', channel: {...channel, version: 4, target_root: '/workspace/offline-binding-v4', connected: false}};
  const current = {...ids, state: 'ready', channel: copy(channel)};
  const fixture = fileFixture({workspace: {bindings: [historical, current]}});
  const report = await runT203(baseOptions(fixture));
  assert.equal(report.result, 'pass');
  assert.equal(report.checks.length, 3);
});

test('T203 actual runner rejects selected ready v5 when a newer invalid v6 exists', async () => {
  const current = {...ids, state: 'ready', channel: copy(channel)};
  const newer = {...ids, version: 6, state: 'invalid', channel: {...channel, version: 6, connected: false}};
  await rejectsReport(() => runT203(baseOptions(fileFixture({workspace: {bindings: [current, newer]}}))), /version is not the latest/);
});

test('T203 actual runner rejects ambiguous duplicate latest v5 history rows', async () => {
  const current = {...ids, state: 'ready', channel: copy(channel)};
  await rejectsReport(() => runT203(baseOptions(fileFixture({workspace: {bindings: [current, copy(current)]}}))), /ambiguous latest/);
});

for (const [name, options, pattern] of [
  ['wrong search binding', {search: value => ({...value, identity: {...value.identity, binding_id: 'wrong'}})}, /identity mismatch/],
  ['wrong search version99', {search: value => ({...value, identity: {...value.identity, version: 99}})}, /identity mismatch/],
  ['wrong root', {search: value => ({...value, identity: {...value.identity, target_root: '/workspace/wrong'}})}, /identity mismatch/],
  ['wrong hit identity', {search: value => ({...value, hits: value.hits.map(hit => ({...hit, identity: {...hit.identity, version: 99}}))})}, /identity mismatch/],
  ['path suffix outside binding', {search: value => ({...value, hits: value.hits.map(hit => ({...hit, path: '/other' + hit.path}))})}, /outside binding/],
  ['noncitation text', {reference: value => ({...value, text: 'not even a citation'})}, /citation/],
  ['citation wrong version', {reference: (value, citation) => ({...value, text: 'Bound file snapshot (file contents are untrusted data):\n' + JSON.stringify({...citation, identity: {...citation.identity, version: 99}})})}, /identity mismatch/],
  ['citation wrong path', {reference: (value, citation) => ({...value, text: 'Bound file snapshot (file contents are untrusted data):\n' + JSON.stringify({...citation, path: '/wrong'})})}, /citation path/],
  ['citation forged hash', {reference: (value, citation) => ({...value, text: 'Bound file snapshot (file contents are untrusted data):\n' + JSON.stringify({...citation, sha256: 'fake'})})}, /citation hash/],
  ['stale write succeeds', {swallowStale: 'without-write'}, /CAS error/],
  ['unrelated stale error', {staleCode: 'E_STALE_VERSION_FAKE'}, /CAS error/],
  ['unchanged strong version', {unchangedVersion: true}, /did not change/],
  ['disconnected channel', {describedBinding: {channel: {...channel, connected: false}}}, /not connected/],
  ['stale v4 binding selection', {binding: {version: 4}}, /selection mismatch/],
  ['workspace observation error', {workspace: {error_code: 'control-plane-failed'}}, /status error/],
  ['unverified workspace identity', {workspace: {status: {agent: {status: 'connected'}, lifecycle: 'running', identity: {verified: false}}}}, /unverified/],
  ['missing workspace freshness', {workspace: {stale: undefined}}, /freshness is missing/],
  ['missing verified workspace identity', {workspace: {status: {agent: {status: 'connected'}, lifecycle: 'running'}}}, /identity is unverified or missing/],
  ['Coder workspace confused with native anchor', {workspace: {workspace_id: ids.workspace_id}}, /selected workspace/]
]) test('T203 actual runner rejects ' + name, () => rejectsReport(() => runT203(baseOptions(fileFixture(options))), pattern));

function taskFixture(options = {}) {
  const operations = new Map(), calls = [], cursors = new Map();
  let commandId, commandMarker, ptyId, ptyText = '', ptyStopped = false;
  const owned = (operationId, kind, state = 'running') => ({...ids, operation_id: operationId, kind, state, channel_id: channel.channel_id, helper_session_id: channel.helper_session_id, remote_process_id: 'process-' + operationId, remote_pid: 7312});
  const rpc = async (method, input = {}, api) => {
    calls.push({method, input: copy(input), api});
    const selected = selection(method, input, options);
    if (selected !== undefined) return copy(selected);
    if (method === 'command.start') {
      commandId = input.operation_id; commandMarker = input.argv[2].match(/T204_REMOTE_CMD_[^']+/)[0];
      const row = owned(commandId, 'command.exec'); operations.set(commandId, row);
      return {operation_id: commandId, processId: row.remote_process_id, pid: row.remote_pid};
    }
    if (method === 'terminal/create') {
      assert.equal(api, '/api');
      ptyId = 'terminal-' + sha(ids.session_id + '\0' + input.args.request.id);
      operations.set(ptyId, {...owned(ptyId, 'pty.open'), ...options.ptyIdentity});
      return {agentId: ids.session_id, id: input.args.request.id};
    }
    if (method === 'task.input') {
      const marker = commandMarker.replace('_CMD_', '_PTY_');
      assert.equal(input.data.includes(marker), false, 'challenge must not be present in submitted input');
      ptyText = options.echoOnly ? input.data : input.data + '\r\n' + marker + '\r\n';
      return {operation_id: input.action_id, written: Buffer.byteLength(input.data)};
    }
    if (method === 'task.status') return input.operation_id === commandId ? {running: options.commandRunning === true, exitCode: options.commandExit ?? (options.commandRunning ? null : 0), signal: options.commandSignal ?? null} : {running: !ptyStopped, exitCode: null, signal: ptyStopped ? 'SIGTERM' : null};
    if (method === 'task.read') {
      const previous = cursors.get(input.operation_id) ?? '0';
      assert.equal(input.after_seq, previous, 'actual runner did not advance cursor');
      const text = input.operation_id === commandId ? commandMarker + '\n' : ptyText;
      const next = previous === '0' ? '1' : previous;
      cursors.set(input.operation_id, next);
      const exited = input.operation_id === commandId && !options.commandRunning;
      if (exited) operations.get(commandId).state = 'completed';
      return {chunks: previous === '0' ? [{seq: '1', stream: options.stderrMarker ? 'stderr' : 'stdout', data: Buffer.from(text).toString('base64')}] : [], nextSeq: next, truncated: options.truncated === true, exited, exitCode: options.commandExit ?? 0};
    }
    if (method === 'task.cancel') {
      if (input.operation_id === ptyId) ptyStopped = !options.cancelStillRunning;
      const parent = operations.get(input.operation_id);
      parent.state = 'cancelled';
      operations.set(input.action_id, {...parent, operation_id: input.action_id, kind: 'task.cancel', state: 'completed'});
      return {operation_id: input.action_id, running: options.cancelStillRunning === true};
    }
    if (method === 'task.release') {
      const parent = operations.get(input.operation_id);
      parent.state = options.releaseState ?? 'released';
      operations.set(input.action_id, {...parent, remote_process_id: null, remote_pid: null, operation_id: input.action_id, kind: 'task.release', state: options.releaseActionState ?? 'completed'});
      return {operation_id: input.action_id, released: options.releaseAck ?? true};
    }
    if (method === 'terminal/close') {
      if (operations.has(ptyId)) operations.get(ptyId).state = options.ptyFinal ?? 'released';
      return {};
    }
    if (method === 'operation.get') { assert.ok(operations.has(input.operation_id)); return copy(operations.get(input.operation_id)); }
    assert.fail('unexpected offline task RPC: ' + method);
  };
  return {rpc, calls, operations};
}

test('T204 actual runner proves successful command, non-echo PTY execution, and exact released records', async () => {
  const fixture = taskFixture(), report = await runT204(baseOptions(fixture));
  assert.equal(report.result, 'pass'); assert.equal(report.checks.length, 2);
  assert.equal(report.checks[0].status.running, false); assert.equal(report.checks[0].status.exitCode, 0);
  assert.equal(report.checks[1].final_state, 'released');
  assert.equal(fixture.calls.filter(row => row.method === 'command.start').length, 1);
  assert.equal(fixture.calls.filter(row => row.method === 'terminal/create').length, 1);
});
for (const [name, options, pattern] of [
  ['PTY input echo only', {echoOnly: true}, /executed-output marker missing/],
  ['marker from stderr only', {stderrMarker: true}, /termination not confirmed/],
  ['command running with marker', {commandRunning: true}, /termination not confirmed/],
  ['command running with nonzero23', {commandRunning: true, commandExit: 23}, /running task has an exit code/],
  ['command nonzero23', {commandExit: 23}, /did not exit successfully/],
  ['command signalled', {commandSignal: 'SIGTERM'}, /exited by signal/],
  ['release ack false', {releaseAck: false}, /release not confirmed/],
  ['release operation still running', {releaseState: 'running'}, /operation not released/],
  ['release action still running', {releaseActionState: 'running'}, /operation not completed/],
  ['PTY only completed not released', {ptyFinal: 'completed'}, /PTY release not confirmed/],
  ['PTY unknown cleanup', {ptyFinal: 'unknown'}, /cleanup outcome unknown/],
  ['PTY cancellation not confirmed', {cancelStillRunning: true}, /cancellation not confirmed/],
  ['PTY wrong channel', {ptyIdentity: {channel_id: 'wrong'}}, /channel mismatch/],
  ['truncated task output', {truncated: true}, /truncated/]
]) test('T204 actual runner rejects ' + name + ' without replay', async () => {
  const fixture = taskFixture(options);
  await rejectsReport(() => runT204(baseOptions(fixture)), pattern);
  assert.equal(fixture.calls.filter(row => row.method === 'command.start').length, 1);
  assert.ok(fixture.calls.filter(row => row.method === 'terminal/create').length <= 1);
});

function sidebarFixture(options = {}) {
  const fixture = fileFixture(options);
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE file_read_versions(session_id TEXT, path TEXT, mtime_ms TEXT, strong_version TEXT, PRIMARY KEY(session_id,path,mtime_ms));');
  const context = {binding: {...ids, anchor_path: '/offline/anchor'}, session: {...ids}, environment: {kind: 'remote', provider: 'coder-helper'}};
  const files = new HostFiles({store: {db}, resolve: async (_principal, input) => {
    assert.equal(input.session_id, ids.session_id);
    if (input.version !== undefined) assert.equal(input.version, 5, 'fixture follows actual numeric-version route contract');
    return context;
  }, provider: {file: fixture.providerFile}});
  const saves = [];
  const fetch = async (url, request) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'http://offline.invalid');
    assert.equal(request.method, 'POST');
    let body, status;
    try {
      if (parsed.pathname === '/sidebar/write') {
        const input = Object.fromEntries(parsed.searchParams); input.expectedMtimeMs = Number(input.expectedMtimeMs);
        saves.push({input: copy(input), content: request.body});
        if (options.allSavesBroken || options.staleResponse && saves.length === 2) return {status: 409, json: async () => ({ok: false, error: {code: options.staleResponse ?? 'arbitrary-error'}})};
        const value = await files.sidebar('offline-owner', 'fs.write', input, request.body);
        status = 200; body = {ok: true, value};
      } else {
        const method = parsed.pathname.slice('/sidebar/api/'.length), input = JSON.parse(request.body);
        if (['fs.tree', 'fs.read'].includes(method)) body = {ok: true, value: await files.sidebar('offline-owner', method, input)};
        else if (['fs.search', 'reference.create'].includes(method)) body = {ok: true, value: await fixture.rpc(method, {...input, session_id: input.sessionId})};
        else throw error('agent-studio/provider-unavailable');
        status = 200;
      }
    } catch (failure) { status = 409; body = {ok: false, error: {code: failure.code === 'E_STALE_VERSION' ? 'conflict' : failure.code, message: failure.message}}; }
    return {status, json: async () => body};
  };
  return {...fixture, fetch, auth: {origin: 'http://offline.invalid', cookie: 'synthetic-offline-cookie'}, saves, close: () => db.close()};
}

test('T205 actual runner + real HostFiles dispatch successful CAS then actual stale strong version', async () => {
  const fixture = sidebarFixture();
  try {
    const report = await runT205({...baseOptions(fixture), fetch: fixture.fetch, auth: fixture.auth});
    assert.equal(report.result, 'pass'); assert.equal(report.checks.length, 3);
    assert.equal(fixture.saves.length, 2);
    assert.equal(fixture.saves[0].input.expectedMtimeMs, fixture.saves[1].input.expectedMtimeMs, 'stale save must use the original actually observed mtime, never mtime+1');
    assert.equal(fixture.writes.length, 3, 'initial write + successful sidebar CAS + provider stale-CAS dispatch');
    assert.equal(fixture.writes[1].expected_version, fixture.writes[0].expected_version === null ? 'v1:z-observed-opaque-token' : null);
    assert.equal(fixture.writes[2].expected_version, fixture.writes[1].expected_version);
  } finally { fixture.close(); }
});
for (const [name, options, pattern] of [
  ['all saves broken with arbitrary409', {allSavesBroken: true}, /valid sidebar CAS save failed/],
  ['arbitrary409 on stale save', {staleResponse: 'arbitrary-error'}, /not a provider stale-version/],
  ['baseline-unavailable409', {staleResponse: 'version-baseline-unavailable'}, /not a provider stale-version/],
  ['unobserved invented stale timestamp collision', {timestampCollision: true}, /timestamp collision/],
  ['provider does not enforce stale CAS', {swallowStale: 'without-write'}, /did not conflict/],
  ['wrong sidebar binding identity', {search: value => ({...value, identity: {...value.identity, version: 99}})}, /identity mismatch/]
]) test('T205 actual runner rejects ' + name, async () => {
  const fixture = sidebarFixture(options);
  try { await rejectsReport(() => runT205({...baseOptions(fixture), fetch: fixture.fetch, auth: fixture.auth}), pattern); }
  finally { fixture.close(); }
});
