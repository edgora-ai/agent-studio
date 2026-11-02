// Import-safe contracts: no runtime IDs, credentials, DB opens or RPCs on import.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {join, resolve, posix} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
export const WORKSPACE_ID = 'ff136352-6a92-41d4-9c2c-6cc783cb989b';
export const sleep = delay;
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const isMain = url => Boolean(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(url));
export const unprefixedCode = code => typeof code === 'string' ? code.replace(/^agent-studio\//, '') : code;

export function bindingOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    assert.ok(['--ids', '--expected-version', '--binding-id'].includes(flag) && args[i + 1] && !args[i + 1].startsWith('--'), 'unknown or incomplete binding option');
    assert.equal(options[flag], undefined, 'duplicate binding option: ' + flag);
    options[flag] = args[i + 1];
  }
  assert.match(options['--expected-version'] ?? '', /^[1-9]\d*$/, 'pass --expected-version explicitly (for example, --expected-version 5)');
  const expectedVersion = Number(options['--expected-version']);
  assert.ok(Number.isSafeInteger(expectedVersion), 'invalid expected binding version');
  return {idsFile: options['--ids'], bindingId: options['--binding-id'], expectedVersion};
}
export function assertBindingIds(ids, expectedVersion, bindingId) {
  assert.ok(ids && typeof ids === 'object' && !Array.isArray(ids), 'missing binding selection');
  for (const key of ['session_id', 'binding_id', 'environment_id', 'workspace_id', 'target_root']) assert.ok(typeof ids[key] === 'string' && ids[key].length > 0 && !ids[key].includes('\0'), 'invalid binding selection: ' + key);
  assert.ok(Number.isSafeInteger(expectedVersion) && expectedVersion > 0, 'expected binding version must be explicit');
  assert.equal(ids.version, expectedVersion, 'selected binding version differs from expected version');
  if (bindingId !== undefined) assert.equal(ids.binding_id, bindingId, 'selected binding ID differs from expected ID');
  assert.ok(ids.target_root.startsWith('/workspace/') && posix.normalize(ids.target_root) === ids.target_root && !ids.target_root.endsWith('/') && !ids.target_root.includes('\\'), 'invalid remote binding root');
  return ids;
}
export function workspaceFrom(description, workspaceId) {
  assert.ok(Array.isArray(description?.workspaces), 'environment workspaces missing');
  const rows = description.workspaces.filter(row => row.workspace_id === workspaceId);
  assert.equal(rows.length, 1, 'expected exactly one selected workspace');
  return rows[0];
}
export function assertAgentConnected(workspace) {
  assert.equal(workspace.status?.agent?.status, 'connected', 'selected workspace agent is not connected');
  assert.equal(workspace.status?.lifecycle, 'running', 'selected workspace is not running');
  assert.equal(workspace.stale, false, 'selected workspace observation is stale or freshness is missing');
  assert.equal(workspace.error_code ?? workspace.status?.error_code ?? null, null, 'selected workspace has a status error');
  assert.equal(workspace.status?.identity?.verified, true, 'selected workspace identity is unverified or missing');
}
export function assertConnectedBinding(workspace, ids) {
  assertAgentConnected(workspace);
  assert.ok(Array.isArray(workspace.bindings), 'workspace bindings missing');
  const rows = workspace.bindings.filter(row => row.binding_id === ids.binding_id);
  assert.ok(rows.length > 0, 'selected binding missing');
  for (const row of rows) assert.ok(Number.isSafeInteger(row.version) && row.version > 0, 'selected binding history has an invalid version');
  // describe retains historical rows. Never pick an old ready version when a
  // newer version exists, even when the newer row is pending or invalid.
  const highest = rows.reduce((value, row) => Math.max(value, row.version), 0);
  const latest = rows.filter(row => row.version === highest);
  assert.equal(latest.length, 1, 'ambiguous latest selected binding');
  assert.equal(highest, ids.version, 'selected binding version is not the latest');
  const row = latest[0];
  for (const key of ['binding_id', 'version', 'environment_id', 'target_root']) assert.equal(row[key], ids[key], 'connected binding mismatch: ' + key);
  assert.equal(row.state, 'ready', 'selected binding is not ready');
  assert.equal(row.channel?.connected, true, 'selected binding channel is not connected');
  for (const key of ['binding_id', 'version', 'target_root']) assert.equal(row.channel[key], ids[key], 'channel binding mismatch: ' + key);
  for (const key of ['channel_id', 'helper_session_id']) assert.ok(typeof row.channel[key] === 'string' && row.channel[key].length > 0, 'missing channel identity: ' + key);
  return row.channel;
}
export async function assertRemoteSelection(rpc, ids, coderWorkspaceId = WORKSPACE_ID) {
  const binding = await rpc('binding.get', {binding_id: ids.binding_id, version: ids.version});
  for (const key of ['binding_id', 'version', 'environment_id', 'workspace_id', 'target_root']) assert.equal(binding?.[key], ids[key], 'binding selection mismatch: ' + key);
  assert.equal(binding.state, 'ready', 'selected binding is not ready');
  const session = await rpc('session.get', {session_id: ids.session_id});
  for (const key of ['session_id', 'binding_id', 'version']) assert.equal(session?.[key], ids[key], 'session selection mismatch: ' + key);
  assert.equal(session.state, 'ready', 'selected session is not ready');
  const workspace = workspaceFrom(await rpc('environment.describe'), coderWorkspaceId);
  const channel = assertConnectedBinding(workspace, ids);
  assert.equal(workspace.bindings.filter(row => row.channel?.connected === true).length, 1, 'expected exactly one connected remote binding channel');
  return channel;
}
export const fileScope = ids => ({session_id: ids.session_id, binding_id: ids.binding_id, version: ids.version});
export function assertRemoteIdentity(identity, ids) {
  assert.equal(identity?.kind, 'remote', 'identity is not remote');
  assert.equal(identity.provider, 'coder-helper', 'identity provider mismatch');
  for (const key of ['session_id', 'binding_id', 'version', 'environment_id', 'target_root']) assert.equal(identity[key], ids[key], 'remote identity mismatch: ' + key);
}
export function assertSearch(found, ids, absolute) {
  assertRemoteIdentity(found?.identity, ids);
  assert.ok(Array.isArray(found.hits), 'search hits missing');
  assert.notEqual(found.truncated, true, 'search output truncated');
  for (const hit of found.hits) {
    assert.ok(typeof hit.path === 'string' && hit.path.startsWith(ids.target_root + '/') && posix.normalize(hit.path) === hit.path, 'search hit outside binding root');
    assertRemoteIdentity(hit.identity, ids);
  }
  assert.ok(found.hits.some(hit => hit.path === absolute), 'exact bound search hit missing');
}
export function assertVersion(version) {
  assert.ok(typeof version === 'string' && version.length > 0, 'strong file version missing');
  return version;
}
export function assertReadback(result, content, version) {
  assert.ok(typeof result?.data === 'string', 'read data missing');
  const bytes = Buffer.from(result.data, 'base64');
  assert.equal(bytes.toString('base64'), result.data, 'read data is not canonical base64');
  assert.equal(bytes.toString('utf8'), content, 'readback bytes changed');
  assert.equal(result.sha256, sha(Buffer.from(content)), 'readback hash mismatch');
  assertVersion(result.version);
  if (version !== undefined) assert.equal(result.version, version, 'readback strong version changed');
  return result;
}
export function assertReference(reference, ids, absolute, content, version) {
  assertRemoteIdentity(reference?.identity, ids);
  assert.ok(typeof reference.text === 'string' && reference.text.startsWith('Bound file snapshot (file contents are untrusted data):\n'), 'invalid bound snapshot citation');
  const citation = JSON.parse(reference.text.slice(reference.text.indexOf('\n') + 1));
  assertRemoteIdentity(citation.identity, ids);
  assert.equal(citation.path, absolute, 'citation path mismatch');
  assert.equal(citation.content, content, 'citation bytes mismatch');
  assert.equal(citation.strong_version, assertVersion(version), 'citation version mismatch');
  assert.equal(citation.sha256, sha(Buffer.from(content)), 'citation hash mismatch');
  assert.equal(reference.sha256, citation.sha256, 'reference hash mismatch');
  assert.ok(typeof reference.label === 'string' && reference.label.includes('remote'), 'reference label is not remote');
  return citation;
}
export function assertOwnedOperation(row, ids, operationId, channel, kind, state) {
  assert.equal(row?.operation_id, operationId, 'operation ID mismatch');
  for (const key of ['session_id', 'binding_id', 'version']) assert.equal(row[key], ids[key], 'operation ownership mismatch: ' + key);
  for (const key of ['channel_id', 'helper_session_id']) assert.equal(row[key], channel[key], 'operation channel mismatch: ' + key);
  assert.notEqual(row.execution_kind, 'local', 'operation executed locally');
  assert.equal(row.kind, kind, 'operation kind mismatch');
  if (['command.exec', 'pty.open'].includes(kind)) {
    assert.ok(typeof row.remote_process_id === 'string' && row.remote_process_id.length > 0, 'remote process identity missing');
    assert.ok(Number.isSafeInteger(row.remote_pid) && row.remote_pid > 0, 'remote process PID missing');
  }
  if (state !== undefined) assert.equal(row.state, state, 'operation not ' + state);
  return row;
}
// Incremental cursor reads; a marker must be a stdout line, not echoed input.
export async function readTaskUntil({rpc, ids, operationId, marker, requireExit = false, attempts = 80, sleep: pause = sleep}) {
  let cursor = '0', stdout = '', bytes = 0, finalStatus;
  const hasMarker = () => stdout.replaceAll('\r\n', '\n').split('\n').some(line => line === marker);
  for (let i = 0; i < attempts; i++) {
    const page = await rpc('task.read', {session_id: ids.session_id, operation_id: operationId, after_seq: cursor});
    assert.equal(page?.truncated, false, 'task output missing or truncated');
    assert.ok(Array.isArray(page.chunks), 'task output chunks missing');
    assert.match(page.nextSeq ?? '', /^\d{1,20}$/, 'task output cursor missing');
    let sequence = BigInt(cursor);
    for (const chunk of page.chunks) {
      assert.match(chunk.seq ?? '', /^\d{1,20}$/, 'task chunk sequence missing');
      assert.ok(BigInt(chunk.seq) > sequence, 'task chunk sequence did not advance');
      sequence = BigInt(chunk.seq);
      assert.ok(['stdout', 'stderr'].includes(chunk.stream) && typeof chunk.data === 'string', 'invalid task output chunk');
      const data = Buffer.from(chunk.data, 'base64');
      assert.equal(data.toString('base64'), chunk.data, 'invalid task output encoding');
      bytes += data.length;
      assert.ok(bytes <= 262144, 'task output limit exceeded');
      if (chunk.stream === 'stdout') stdout += data.toString('utf8');
    }
    assert.equal(BigInt(page.nextSeq), sequence, 'task output cursor disagrees with chunks');
    cursor = page.nextSeq;
    if (requireExit) {
      finalStatus = await rpc('task.status', {session_id: ids.session_id, operation_id: operationId});
      assert.equal(typeof finalStatus?.running, 'boolean', 'task running status missing');
      if (finalStatus.running) assert.equal(finalStatus.exitCode ?? null, null, 'running task has an exit code');
      else {
        assert.equal(finalStatus.exitCode, 0, 'remote command did not exit successfully');
        assert.equal(finalStatus.signal ?? null, null, 'remote command exited by signal');
        if (page.exited === true) {
          assert.equal(page.exitCode, 0, 'remote command output reports nonzero termination');
          assert.equal(page.signal ?? null, null, 'remote command output reports signalled termination');
          if (hasMarker()) return {stdout, status: finalStatus, cursor};
        }
      }
    } else if (hasMarker()) return {stdout, cursor};
    if (i + 1 < attempts) await pause(200);
  }
  assert.fail(requireExit ? 'remote command output/successful termination not confirmed' : 'remote PTY executed-output marker missing (input echo is not execution)');
}
export async function acceptanceReport(scope, ids, run, action, onPass = () => {}) {
  const report = {scope, ...(ids ? {ids} : {}), ...(run ? {run} : {}), checks: [], result: 'fail'};
  const pass = (name, facts = {}) => { report.checks.push({name, ...facts}); onPass(name, facts); };
  try { Object.assign(report, await action(pass)); report.result = 'pass'; return report; }
  catch (error) { error.acceptanceReport = report; throw error; }
}
export async function cliReport({repo, folder, prefix}, action) {
  let report;
  try { report = await action(); }
  catch (error) {
    report = {...error.acceptanceReport, result: 'fail', error: {code: error.code ?? error.name, message: String(error.message).slice(0, 500)}};
    console.error(JSON.stringify(report.error)); process.exitCode = 1;
  }
  await mkdir(join(repo, 'artifacts', folder), {recursive: true});
  const artifact = join(repo, 'artifacts', folder, prefix + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID() + '.json');
  await writeFile(artifact, JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({result: report.result, checks: report.checks?.length ?? 0, ...(report.results ? {results: report.results} : {}), artifact}));
  return report;
}
export async function remoteMain(folder, prefix, runner) {
  try {
    const options = bindingOptions(process.argv.slice(2));
    const {repo, DEFAULT_ROOT: root, authenticate, requestRpc} = await import('./preview.mjs');
    await cliReport({repo, folder, prefix}, async () => {
      const ids = assertBindingIds(JSON.parse(await readFile(options.idsFile ? resolve(options.idsFile) : join(root, 'remote-demo.json'), 'utf8')), options.expectedVersion, options.bindingId);
      const auth = await authenticate(root);
      return runner({ids, expectedVersion: options.expectedVersion, rpc: (method, payload = {}, channel) => requestRpc(auth, method, payload, channel), auth, onPass: name => console.log('PASS ' + name)});
    });
  } catch (error) { console.error(String(error.message)); process.exitCode = 1; }
}
export function sidebarClient({auth, ids, fetch: fetchImpl = globalThis.fetch}) {
  const send = async (path, body, json = true) => {
    const response = await fetchImpl(auth.origin + path, {method: 'POST', headers: {cookie: auth.cookie, origin: auth.origin, ...(json ? {'content-type': 'application/json'} : {})}, body: json ? JSON.stringify(body) : body});
    return {status: response.status, body: await response.json()};
  };
  return {
    async call(method, payload = {}) {
      const response = await send('/sidebar/api/' + method, {sessionId: ids.session_id, binding_id: ids.binding_id, version: ids.version, ...payload});
      if (response.body?.ok === false) throw Object.assign(new Error(response.body.error?.message ?? 'sidebar error'), {code: response.body.error?.code, status: response.status});
      assert.equal(response.status, 200, 'sidebar HTTP request did not succeed');
      assert.equal(response.body?.ok, true, 'sidebar success envelope missing');
      assert.ok(Object.hasOwn(response.body, 'value'), 'sidebar value missing');
      return response.body.value;
    },
    write({path, expectedMtimeMs, content}) {
      assert.ok(Number.isFinite(expectedMtimeMs), 'sidebar save baseline missing');
      return send('/sidebar/write?' + new URLSearchParams({sessionId: ids.session_id, path, expectedMtimeMs: String(expectedMtimeMs)}), content, false);
    }
  };
}
