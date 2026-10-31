// Offline contracts only. These doubles are NOT runtime/remote evidence.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BoundProvider, BoundWorkspace, RemoteProcess, relativePath, validateCommand, DISABLED_CHANNELS, sha256 } from './t106_provider.mjs';
const token = '1234567890abcdef12345678';
class RemoteHelperRpcClient {
  constructor(reply = async () => ({})) {
    this.sessionId = 'offline-session'; this.hello = { helperVersion: '0.13.1' };
    this.closed = new Promise(() => {}); this.calls = []; this.reply = reply;
  }
  async call(method, params, options) { this.calls.push({ method, params, options }); return this.reply(method, params); }
}
function fixture(reply) {
  const raw = new RemoteHelperRpcClient(reply), audit = [], provider = new BoundProvider(raw, token, audit);
  const workspace = new BoundWorkspace(provider, 'offline-workspace', provider.base + '/project'); workspace.state = 'open';
  return { raw, provider, workspace, audit };
}
const rejectsCode = code => error => error.code === code;

test('24-hex run token, exact owned root and fixed raw-session version', async () => {
  const { raw, provider } = fixture();
  assert.throws(() => new BoundProvider(raw, 'a'.repeat(12)), rejectsCode('T106_INVALID_RUN_TOKEN'));
  for (const root of ['/workspace', provider.base + '/../other', provider.base + 'f/project']) {
    await assert.rejects(() => provider.open(root), rejectsCode('T106_ROOT_OUTSIDE_SYNTHETIC_SCOPE'));
  }
  assert.equal(raw.calls.length, 0);
  raw.hello.helperVersion = '0.0.0'; assert.throws(() => new BoundProvider(raw, token));
});
test('strict relative paths with explicit empty-directory allowance', () => {
  for (const path of ['/a', '../a', 'a/../../b', 'a//b', 'a/./b', 'a/', 'a\\b', 'a\0b', '', 1]) assert.throws(() => relativePath(path));
  assert.equal(relativePath('', true), ''); assert.equal(relativePath('目录/space name'), '目录/space name');
});
test('structured argv/cwd/env/dimensions validation prevents dispatch', async () => {
  const { raw, workspace } = fixture();
  const invalid = [[[], {}], [[''], {}], [['x\0'], {}], [['x'], { cwd: '../x' }],
    [['x'], { env: { 'a=b': 'x' } }], [['x'], { env: { x: 1 } }], [['x'], { tty: { rows: 0, cols: 2 } }]];
  for (const [argv, options] of invalid) await assert.rejects(() => workspace.start(argv, options));
  assert.equal(raw.calls.length, 0);
  assert.doesNotThrow(() => validateCommand(['x', '', '; literal', '中文'], 'space cwd', { X: 'value' }, { rows: 27, cols: 91 }));
});
test('Buffer writes check count; complete Buffer readback rejects truncated data', async () => {
  const bytes = Buffer.from([0, 255, 42]);
  const { workspace, raw } = fixture(async method => method === 'fs/read'
    ? { encoding: 'base64', data: bytes.toString('base64'), metadata: { size: 3 } } : { written: 3 });
  await workspace.write('bin', bytes); assert.deepEqual(await workspace.read('bin'), bytes);
  assert.equal(raw.calls[0].params.encoding, 'base64'); assert.equal(raw.calls[0].params.intent.kind, 'create-if-absent');
  raw.reply = async () => ({ encoding: 'base64', data: 'AA==', metadata: { size: 3 } });
  await assert.rejects(() => workspace.read('bin'), /T106_INCOMPLETE_READ/);
});
test('single dispatch, original operation ID and no replay after uncertainty', async () => {
  const interrupted = Object.assign(new Error('offline lost ACK'), { mutationMayHaveStarted: true });
  const { workspace, raw, provider, audit } = fixture(async () => { throw interrupted; });
  await assert.rejects(() => workspace.start(['x'], { processId: 'process-one', operationId: 'op-one' }), error => error === interrupted);
  assert.equal([...workspace.processes][0].id, 'process-one');
  await assert.rejects(() => workspace.start(['x']), rejectsCode('T106_UNKNOWN_OUTCOME'));
  await assert.rejects(() => workspace.write('x', Buffer.from('x')), rejectsCode('T106_UNKNOWN_OUTCOME'));
  assert.equal(raw.calls.length, 1); assert.equal(audit[0].dispatchCount, 1);
  assert.equal(provider.uncertain, true);
});
test('read failure does not poison mutations; operation IDs still cannot replay', async () => {
  const { raw, provider } = fixture(async () => ({}));
  await provider.call('fs/mkdir', { path: 'x', operationId: 'one' });
  await assert.rejects(() => provider.call('fs/mkdir', { path: 'x', operationId: 'one' }), rejectsCode('T106_REPLAY_DISABLED'));
  raw.reply = async () => { throw Object.assign(new Error('offline read failure'), { mutationMayHaveStarted: false }); };
  await assert.rejects(() => provider.call('fs/read'));
  assert.equal(provider.uncertain, false);
});
test('closed transport and changed session reject without reacquisition', async () => {
  const { raw, provider } = fixture(); raw.closeReason = new Error('offline closed');
  await assert.rejects(() => provider.call('fs/read'), /offline closed/); assert.equal(raw.calls.length, 0);
  raw.sessionId = 'replacement';
  await assert.rejects(() => provider.call('fs/read'), rejectsCode('T106_SESSION_REPLACED'));
});
test('unsupported channels and methods are explicit unsent rejections', async () => {
  const { provider, raw } = fixture();
  for (const channel of DISABLED_CHANNELS) assert.throws(() => provider.compatibility(channel), rejectsCode('T106_CHANNEL_DISABLED'));
  await assert.rejects(() => provider.call('local/spawn'), rejectsCode('T106_METHOD_DISABLED'));
  assert.equal(raw.calls.length, 0);
});
test('bootstrap creates only owned run, closes handle and never exposes /workspace', async () => {
  const { provider, raw } = fixture(async (method, p) => method === 'workspace/open'
    ? { workspaceId: p.workspaceId, path: p.path, access: p.access }
    : method === 'workspace/close' ? { closed: true } : { created: true });
  const handles = await provider.createRun();
  assert.equal(handles.project.root, provider.base + '/project');
  assert.equal(raw.calls[1].params.path, 't106-' + token);
  assert.equal(raw.calls[2].method, 'workspace/close');
  await assert.rejects(() => provider.createRun(), rejectsCode('T106_RUN_ALREADY_CREATED'));
  await handles.owner.close();
  await assert.rejects(() => handles.owner.read('x'), rejectsCode('T106_WORKSPACE_CLOSED'));
});
test('byte chunks preserve UTF-8 spanning RPC frames', async () => {
  const text = Buffer.from('中文'), chunks = [text.subarray(0, 2), text.subarray(2)]; let seq = 0;
  const { workspace } = fixture(async () => ({ truncated: false, nextSeq: String(++seq),
    chunks: [{ stream: 'pty', data: chunks.shift().toString('base64') }], exited: false }));
  const p = new RemoteProcess(workspace, 'process'); await p.read(); await p.read();
  assert.equal(p.text('pty'), '中文');
});
test('input/resize lanes serialize and validate sequence receipts', async () => {
  let reply;
  const { workspace, raw } = fixture(() => new Promise(resolve => { reply = resolve; }));
  const p = new RemoteProcess(workspace, 'process');
  const first = p.input('x'); await Promise.resolve();
  await assert.rejects(() => p.input('y'), rejectsCode('T106_LANE_BUSY'));
  reply({ written: 1, nextSeq: '1' }); await first;
  assert.equal(p.writeSeq, '1'); assert.equal(raw.calls.length, 1);
  await assert.rejects(() => p.resize(-1, 80), rejectsCode('T106_INVALID_DIMENSIONS'));
});
test('discovery closes resource after negative dependency result', async () => {
  const { workspace, raw } = fixture(async method => method === 'fs/discoverRead'
    ? { entries: [], cursor: 0, eof: true, complete: false, error: { code: 'E_EXECUTABLE_NOT_FOUND' } } : { closed: true });
  const result = await workspace.searchNames('missing');
  assert.equal(result.complete, false); assert.equal(result.candidates.length, 0);
  assert.deepEqual(raw.calls.map(c => c.method), ['fs/discoverOpen', 'fs/discoverRead', 'fs/discoverClose']);
});
test('private tool HOME is derived from run token, never a caller-supplied root', async () => {
  const { provider, raw } = fixture(async (method, p) => ({ workspaceId: p.workspaceId, path: p.path, access: p.access }));
  const home = await provider.openToolHome();
  assert.equal(home.root, `/tmp/t105-${token}/home`);
  await assert.rejects(() => provider.open('/tmp/t105-other/home'), rejectsCode('T106_ROOT_OUTSIDE_SYNTHETIC_SCOPE'));
  assert.equal(raw.calls.length, 1);
});
test('chunked upload and version-bound complete range read preserve all bytes', async () => {
  const bytes = Buffer.alloc(400001, 165), received = []; let sequence = 0, total = 0;
  const { workspace, raw } = fixture(async (method, p) => {
    if (method === 'fs/writeOpen') return { handleId: p.handleId, seq: '0', maxChunkBytes: 262144, maxBytes: 64 * 1024 ** 2 };
    if (method === 'fs/writeChunk') {
      assert.equal(p.afterSeq, String(sequence));
      const chunk = Buffer.from(p.data, 'base64'); received.push(chunk); total += chunk.length;
      return { seq: String(++sequence), written: chunk.length, totalBytes: total };
    }
    if (method === 'fs/writeCommit') return { written: total, sha256: sha256(Buffer.concat(received)) };
    if (method === 'fs/readRange') {
      if (p.offset > 0) assert.equal(p.expectedStatVersion, 'stat-v1:offline');
      return { offset: p.offset, encoding: 'base64', data: bytes.subarray(p.offset, p.offset + p.length).toString('base64'),
        statVersion: 'stat-v1:offline', eof: p.offset + p.length === bytes.length };
    }
    throw new Error('Unexpected offline method');
  });
  await workspace.writeLarge('rg', bytes, 0o700); assert.deepEqual(Buffer.concat(received), bytes);
  assert.equal(raw.calls[0].params.mode, 0o700); assert.equal(raw.calls[0].params.intent.kind, 'create-if-absent');
  assert.deepEqual(await workspace.readLarge('rg', bytes.length), bytes);
  const mutations = raw.calls.filter(c => c.options.mutation);
  assert.equal(new Set(mutations.map(c => c.params.operationId)).size, mutations.length);
  assert.equal(raw.calls.filter(c => c.method === 'fs/writeAbort').length, 0);
  const count = raw.calls.length;
  await assert.rejects(() => workspace.writeLarge('rg', Buffer.alloc(6 * 1024 ** 2 + 1)), rejectsCode('T106_TOOL_SIZE_OR_MODE'));
  await assert.rejects(() => workspace.writeLarge('rg', bytes, 0o777), rejectsCode('T106_TOOL_SIZE_OR_MODE'));
  await assert.rejects(() => workspace.readLarge('rg', 0), rejectsCode('T106_TOOL_SIZE_OR_MODE'));
  assert.equal(raw.calls.length, count);
});
test('range reads reject changed versions, short pages and false EOF', async () => {
  const bytes = Buffer.alloc(196609, 1);
  for (const fault of ['version', 'short', 'eof']) {
    const { workspace } = fixture(async (_, p) => ({ offset: p.offset, encoding: 'base64',
      data: bytes.subarray(p.offset, p.offset + p.length - (fault === 'short' ? 1 : 0)).toString('base64'),
      statVersion: fault === 'version' && p.offset ? 'changed' : 'same',
      eof: fault === 'eof' || p.offset + p.length === bytes.length }));
    await assert.rejects(() => workspace.readLarge('rg', bytes.length));
  }
});
test('unknown upload commits retain original failure, abort receipt and mutation fence', async () => {
  for (const abortFails of [false, true]) {
    const interrupted = Object.assign(new Error('offline lost commit ACK'), { mutationMayHaveStarted: true });
    const { workspace, provider, raw } = fixture(async (method, p) => {
      if (method === 'fs/writeOpen') return { handleId: p.handleId, seq: '0', maxChunkBytes: 262144, maxBytes: 1000000 };
      if (method === 'fs/writeChunk') return { seq: '1', written: 1, totalBytes: 1 };
      if (method === 'fs/writeCommit') throw interrupted;
      if (abortFails) throw new Error('offline cleanup disconnected');
      return { aborted: false, committed: true };
    });
    await assert.rejects(() => workspace.writeLarge('rg', Buffer.from([1])), error => error === interrupted);
    assert.equal(provider.uncertain, true);
    assert.equal(raw.calls.filter(c => c.method === 'fs/writeCommit').length, 1);
    assert.equal(raw.calls.filter(c => c.method === 'fs/writeAbort').length, 1);
    if (abortFails) assert.equal(interrupted.uploadCleanupError.type, 'Error');
    else assert.deepEqual(interrupted.uploadCleanup, { aborted: false, committed: true });
    await assert.rejects(() => workspace.write('other', Buffer.from('x')), rejectsCode('T106_UNKNOWN_OUTCOME'));
    assert.equal(raw.calls.length, 4);
  }
});
