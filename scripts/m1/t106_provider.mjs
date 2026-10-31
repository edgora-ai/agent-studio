// T-106 experiment only: an explicit binding over the already identity-gated
// candidate raw client. No product/main-session integration or OS sandbox.
// Never reacquire a session, replay a mutation or use a local execution fallback.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
export function safeError(error) {
  return { type: error.name, code: error.code ?? null, kind: error.kind ?? null,
    mutationMayHaveStarted: error.mutationMayHaveStarted ?? null,
    ...(error.uploadCleanup ? { uploadCleanup: error.uploadCleanup } : {}),
    ...(error.uploadCleanupError ? { uploadCleanupError: error.uploadCleanupError } : {}) };
}
export function relativePath(path, empty = false) {
  if (typeof path !== 'string' || path.includes('\0') || path.startsWith('/') || path.includes('\\')
      || (path !== '' && path.split('/').some(p => !p || p === '.' || p === '..')) || (!empty && !path)) {
    throw fail('T106_PATH_OUTSIDE_BINDING');
  }
  return path;
}
export function validateCommand(argv, cwd, env, tty) {
  relativePath(cwd, true);
  if (!Array.isArray(argv) || !argv.length || !argv[0]
      || argv.some(v => typeof v !== 'string' || v.includes('\0'))) throw fail('T106_INVALID_ARGV');
  if (!env || Array.isArray(env) || typeof env !== 'object'
      || Object.entries(env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string' || v.includes('\0'))) {
    throw fail('T106_INVALID_ENV');
  }
  if (tty !== undefined) validateDimensions(tty.rows, tty.cols);
}
function validateDimensions(rows, cols) {
  if (![rows, cols].every(n => Number.isInteger(n) && n > 0 && n <= 10000)) throw fail('T106_INVALID_DIMENSIONS');
}
const READS = new Set(['fs/read', 'fs/readRange', 'fs/list', 'fs/discoverRead', 'environment/check',
  'process/read', 'process/status', 'process/inspectForeground']);
const CLEANUP = new Set(['workspace/close', 'fs/discoverClose', 'fs/writeAbort', 'process/terminate', 'process/release']);
const METHODS = new Set([...READS, ...CLEANUP, 'workspace/open', 'fs/mkdir', 'fs/write', 'fs/discoverOpen',
  'fs/writeOpen', 'fs/writeChunk', 'fs/writeCommit', 'process/start', 'process/write', 'process/resize', 'process/signal']);
export const DISABLED_CHANNELS = Object.freeze(['stock-SSH-subprocess', 'product-content-search', 'mutation-replay', 'recovery']);

export class BoundProvider {
  constructor(rawClient, token, audit = []) {
    assert.ok(rawClient?.sessionId && rawClient?.call && rawClient?.closed);
    assert.equal(rawClient.constructor.name, 'RemoteHelperRpcClient');
    assert.equal(rawClient.hello.helperVersion, '0.13.1');
    if (!/^[a-f0-9]{24}$/.test(token)) throw fail('T106_INVALID_RUN_TOKEN');
    this.client = rawClient;
    this.sessionId = rawClient.sessionId;
    this.base = `/workspace/t106-${token}`;
    this.token = token;
    this.audit = audit;
    this.usedOperations = new Set();
    this.workspaces = new Set();
    this.uncertain = false;
    this.created = false;
  }
  compatibility(channel) {
    throw fail(DISABLED_CHANNELS.includes(channel) ? 'T106_CHANNEL_DISABLED' : 'T106_CHANNEL_UNKNOWN');
  }
  async call(method, params = {}, timeoutMs = 5000) {
    if (!METHODS.has(method)) throw fail('T106_METHOD_DISABLED');
    if (this.client.sessionId !== this.sessionId) throw fail('T106_SESSION_REPLACED');
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10000) throw fail('T106_INVALID_TIMEOUT');
    const mutation = !READS.has(method);
    if (mutation && this.uncertain && !CLEANUP.has(method)) throw fail('T106_UNKNOWN_OUTCOME');
    if (mutation) {
      assert.equal(typeof params.operationId, 'string');
      if (this.usedOperations.has(params.operationId)) throw fail('T106_REPLAY_DISABLED');
      this.usedOperations.add(params.operationId);
    }
    const row = { method, mutation, operationId: params.operationId ?? null,
      workspaceId: params.workspaceId ?? null, processId: params.processId ?? null,
      path: params.path ?? params.cwd ?? null, paramsSha256: sha256(JSON.stringify(params)), dispatchCount: 0 };
    if (params.argv) row.argv = params.argv; // Only this harness's synthetic argv.
    this.audit.push(row);
    const start = performance.now();
    try {
      if (this.client.closeReason !== undefined) throw this.client.closeReason;
      row.dispatchCount++;
      const result = await this.client.call(method, params, { timeoutMs, mutation });
      row.result = 'response';
      return result;
    } catch (error) {
      row.result = 'error'; row.error = safeError(error);
      if (mutation && error.mutationMayHaveStarted === true) this.uncertain = true;
      throw error;
    } finally { row.elapsedMs = Math.round(performance.now() - start); }
  }
  async open(root) {
    if (![this.base, this.base + '/project'].includes(root)) throw fail('T106_ROOT_OUTSIDE_SYNTHETIC_SCOPE');
    return this.#openExact(root);
  }
  // No arbitrary HOME argument: exactly the HOME produced by unchanged T-105
  // configure() for this 24-hex run. Only experimental tools/profile live here.
  openToolHome() { return this.#openExact(`/tmp/t105-${this.token}/home`); }
  environment() { return this.call('environment/check', {}, 8000); }
  async #openExact(root) {
    const id = randomUUID(), workspace = new BoundWorkspace(this, id, root);
    this.workspaces.add(workspace); // Retain identity before a possibly lost ACK.
    const result = await this.call('workspace/open', { path: root, access: 'danger-full-access', workspaceId: id, operationId: id });
    assert.deepEqual(result, { workspaceId: id, path: root, access: 'danger-full-access' });
    workspace.state = 'open';
    return workspace;
  }
  async createRun() {
    if (this.created) throw fail('T106_RUN_ALREADY_CREATED');
    this.created = true;
    // The only /workspace operation is creation of this prechecked random run.
    // Never expose the bootstrap handle to the caller.
    const boot = await this.#openExact('/workspace');
    try { await boot.mkdir(`t106-${this.token}`); } finally { await boot.close(); }
    const owner = await this.open(this.base);
    await owner.mkdir('project');
    return { owner, project: await this.open(this.base + '/project') };
  }
  async close() {
    const errors = [];
    for (const workspace of this.workspaces) {
      try { await workspace.close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'T106_CLEANUP_UNCONFIRMED');
  }
}
export class BoundWorkspace {
  constructor(provider, id, root) {
    this.provider = provider; this.id = id; this.root = root; this.state = 'opening'; this.processes = new Set();
  }
  // Low-level method used only by explicit helper-boundary negative probes.
  call(method, params = {}, timeout) {
    if (this.state !== 'open' && method !== 'workspace/close') throw fail('T106_WORKSPACE_CLOSED');
    if (params.workspaceId !== undefined && params.workspaceId !== this.id) throw fail('T106_BINDING_CHANGED');
    return this.provider.call(method, { ...params, workspaceId: this.id }, timeout);
  }
  mkdir(path) { return this.call('fs/mkdir', { path: relativePath(path), recursive: false, operationId: randomUUID() }); }
  async write(path, bytes) {
    path = relativePath(path);
    if (!Buffer.isBuffer(bytes) || bytes.length > 65536) throw fail('T106_INLINE_FIXTURE_LIMIT');
    const result = await this.call('fs/write', { path, encoding: 'base64', data: bytes.toString('base64'),
      intent: { kind: 'create-if-absent' }, operationId: randomUUID() });
    assert.equal(result.written, bytes.length);
    return result;
  }
  async writeLarge(path, bytes, mode = 0o600) {
    path = relativePath(path);
    if (!Buffer.isBuffer(bytes) || bytes.length > 6 * 1024 ** 2 || ![0o600, 0o700].includes(mode)) throw fail('T106_TOOL_SIZE_OR_MODE');
    const handleId = randomUUID();
    let seq = '0';
    try {
      const opened = await this.call('fs/writeOpen', { path, handleId, mode,
        intent: { kind: 'create-if-absent' }, operationId: randomUUID() });
      assert.equal(opened.handleId, handleId); assert.equal(opened.seq, seq);
      assert.ok(opened.maxChunkBytes >= 196608 && opened.maxBytes >= bytes.length);
      for (let offset = 0; offset < bytes.length; offset += 196608) {
        const chunk = bytes.subarray(offset, offset + 196608);
        const result = await this.call('fs/writeChunk', { handleId, afterSeq: seq,
          data: chunk.toString('base64'), operationId: randomUUID() });
        assert.equal(result.seq, (BigInt(seq) + 1n).toString());
        assert.equal(result.written, chunk.length); assert.equal(result.totalBytes, offset + chunk.length);
        seq = result.seq;
      }
      const result = await this.call('fs/writeCommit', { handleId, operationId: randomUUID() }, 10000);
      assert.equal(result.written, bytes.length); assert.equal(result.sha256, sha256(bytes));
      return result;
    } catch (error) {
      // Preserve the original failure even when abort cannot be confirmed.
      // An abort receipt is NOT evidence that an uncertain commit had no effect.
      try { error.uploadCleanup = await this.call('fs/writeAbort', { handleId, operationId: randomUUID() }); }
      catch (cleanupError) { error.uploadCleanupError = safeError(cleanupError); }
      throw error;
    }
  }
  async readLarge(path, expectedBytes) {
    path = relativePath(path);
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > 6 * 1024 ** 2) throw fail('T106_TOOL_SIZE_OR_MODE');
    const chunks = [];
    let offset = 0, version;
    while (offset < expectedBytes) {
      const page = await this.call('fs/readRange', { path, offset, length: Math.min(196608, expectedBytes - offset),
        ...(version ? { expectedStatVersion: version } : {}) });
      assert.equal(page.offset, offset); assert.equal(page.encoding, 'base64');
      assert.equal(typeof page.statVersion, 'string'); assert.ok(page.statVersion.length > 0);
      if (version) assert.equal(page.statVersion, version);
      version = page.statVersion;
      const bytes = Buffer.from(page.data, 'base64');
      assert.equal(bytes.length, Math.min(196608, expectedBytes - offset));
      chunks.push(bytes); offset += bytes.length;
      assert.equal(page.eof, offset === expectedBytes);
    }
    return Buffer.concat(chunks);
  }
  async read(path) {
    const result = await this.call('fs/read', { path: relativePath(path), maxBytes: 196608 });
    assert.equal(result.encoding, 'base64');
    const bytes = Buffer.from(result.data, 'base64');
    assert.equal(bytes.length, result.metadata.size, 'T106_INCOMPLETE_READ');
    return bytes;
  }
  async list(path = '') {
    const result = await this.call('fs/list', { path: relativePath(path, true), limit: 1000, allowTruncated: false });
    assert.equal(result.truncated, false);
    return result.entries;
  }
  async discover() {
    const discoveryId = randomUUID(), entries = [];
    let cursor = 0;
    try {
      await this.call('fs/discoverOpen', { discoveryId, operationId: discoveryId, includeIgnored: false });
      const deadline = performance.now() + 18000;
      while (performance.now() < deadline) {
        const page = await this.call('fs/discoverRead', { discoveryId, cursor, limit: 500 });
        assert.equal(page.cursor, cursor + page.entries.length);
        for (const entry of page.entries) relativePath(entry.path);
        entries.push(...page.entries); cursor = page.cursor;
        if (entries.length > 1000) throw fail('T106_DISCOVERY_LIMIT');
        if (page.eof) return { ...page, entries };
        await delay(40);
      }
      throw fail('T106_DISCOVERY_DEADLINE');
    } finally {
      await this.call('fs/discoverClose', { discoveryId, operationId: randomUUID() });
    }
  }
  async searchNames(query) {
    if (typeof query !== 'string' || query.length > 256) throw fail('T106_INVALID_QUERY');
    const found = await this.discover();
    return { ...found, candidates: found.entries.filter(e => e.path.includes(query)) };
  }
  async start(argv, { cwd = '', env = {}, tty, processId = randomUUID(), operationId = processId } = {}) {
    validateCommand(argv, cwd, env, tty);
    const handle = new RemoteProcess(this, processId);
    this.processes.add(handle);
    handle.started = await this.call('process/start', { processId, operationId, argv, cwd, env, stdin: 'pipe', ...(tty ? { tty } : {}) }, 8000);
    assert.equal(handle.started.processId, processId);
    assert.ok(Number.isSafeInteger(handle.started.pid) && handle.started.pid > 1);
    return handle;
  }
  async close() {
    if (this.state === 'closed') return;
    for (const process of this.processes) if (process.started) await process.release();
    const result = await this.call('workspace/close', { operationId: randomUUID() });
    assert.ok(result.closed || result.cancelled);
    this.state = 'closed';
    return result;
  }
}
export class RemoteProcess {
  constructor(workspace, id) {
    this.workspace = workspace; this.id = id;
    this.cursor = '0'; this.writeSeq = '0'; this.resizeSeq = '0'; this.chunks = []; this.last = {};
    this.released = false; this.lanes = new Set(); this.outputBytes = 0;
  }
  call(method, params = {}, timeout) {
    if (this.released) throw fail('T106_PROCESS_RELEASED');
    return this.workspace.call(method, { ...params, processId: this.id }, timeout);
  }
  status() { return this.call('process/status'); }
  async read() {
    const page = await this.call('process/read', { afterSeq: this.cursor, maxBytes: 65536, waitMs: 100 });
    assert.equal(page.truncated, false, 'T106_OUTPUT_TRUNCATED');
    assert.ok(BigInt(page.nextSeq) >= BigInt(this.cursor));
    this.cursor = page.nextSeq; this.last = page;
    for (const chunk of page.chunks) {
      assert.ok(['stdout', 'stderr', 'pty'].includes(chunk.stream));
      const bytes = Buffer.from(chunk.data, 'base64');
      this.chunks.push({ stream: chunk.stream, data: chunk.data });
      this.outputBytes += bytes.length;
    }
    if (this.outputBytes > 131072) throw fail('T106_OUTPUT_LIMIT');
    return page;
  }
  // Decode AFTER concatenation so UTF-8 split across RPC chunks is lossless.
  text(stream = 'stdout') { return Buffer.concat(this.chunks.filter(c => c.stream === stream).map(c => Buffer.from(c.data, 'base64'))).toString('utf8'); }
  async until(predicate, timeoutMs = 8000) {
    const deadline = performance.now() + timeoutMs;
    do {
      await this.read();
      if (predicate(this)) return this.last;
      if (this.last.exited) throw fail('T106_EXITED_BEFORE_EXPECTED_OUTPUT');
    } while (performance.now() < deadline);
    throw fail('T106_PROCESS_DEADLINE');
  }
  async lane(name, method, params) {
    if (this.lanes.has(name)) throw fail('T106_LANE_BUSY');
    this.lanes.add(name);
    try {
      const result = await this.call(method, { ...params, operationId: randomUUID(), afterSeq: this[name] });
      assert.equal(result.nextSeq, (BigInt(this[name]) + 1n).toString());
      this[name] = result.nextSeq;
      return result;
    } finally { this.lanes.delete(name); }
  }
  async input(text) {
    const data = Buffer.from(text);
    if (data.length > 65536) throw fail('T106_INPUT_LIMIT');
    const result = await this.lane('writeSeq', 'process/write', { data: data.toString('base64'), encoding: 'base64' });
    assert.equal(result.written, data.length);
    return result;
  }
  async resize(rows, cols) {
    validateDimensions(rows, cols);
    const result = await this.lane('resizeSeq', 'process/resize', { rows, cols });
    assert.equal(result.resized, true);
    return result;
  }
  foreground() { return this.call('process/inspectForeground'); }
  signalForeground(signal) {
    if (!['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL', 'SIGQUIT', 'SIGTSTP'].includes(signal)) throw fail('T106_INVALID_SIGNAL');
    return this.call('process/signal', { operationId: randomUUID(), signal, target: 'foreground', denyOwnShellKill: true });
  }
  async terminate() {
    const graceful = await this.call('process/terminate', { operationId: randomUUID(), force: false, graceMs: 1500 });
    let status; const deadline = performance.now() + 3000;
    do { status = await this.status(); if (!status.running) break; await delay(50); } while (performance.now() < deadline);
    let forced = null;
    if (status.running) forced = await this.call('process/terminate', { operationId: randomUUID(), force: true });
    await this.until(p => p.last.exited, 5000);
    return { graceful, forced, final: await this.status() };
  }
  async release() {
    if (this.released) return;
    const result = await this.call('process/release', { operationId: randomUUID() }, 8000);
    assert.equal(result.released, true);
    this.released = true;
    return result;
  }
}
