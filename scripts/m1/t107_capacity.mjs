// Small genuine samples over the unchanged bound provider and identity-gated helper.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { installNetworkGuard } from './network_guard.mjs';
import { BoundProvider, DISABLED_CHANNELS, sha256, safeError } from './t106_provider.mjs';

const [candidate, dsh, run, alias] = process.argv.slice(2);
const { token } = JSON.parse(readFileSync(join(run, 'plan.json'), 'utf8'));
assert.match(token, /^[a-f0-9]{24}$/);
assert.ok(process.permission);
assert.deepEqual(process.execArgv.filter(a => a.startsWith('--allow-fs-write')), [`--allow-fs-write=${run}`, `--allow-fs-write=${run}/*`]);
assert.equal(process.env.HOME, join(run, 'home'));
const url = path => pathToFileURL(path).href;
const attempts = installNetworkGuard();
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === 'dsh-ssh-remote' ? url(join(candidate, 'lib/index.js')) : specifier, context);
} });
const { Context } = await import(url(join(dsh, 'node_modules/@deepseek-ai/cordis/lib/index.js')));
const { default: LocalFileSystem } = await import(url(join(dsh, 'node_modules/@deepseek-ai/dsh-fs-local/lib/index.js')));
const { default: LocalSubprocessRuntime } = await import(url(join(dsh, 'node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js')));
const entry = await import('./ssh_remote_entry.mjs');
const ctx = new Context();
const report = { task: 'T-107', cases: [], calls: [], storedFiles: [], cleanupErrors: [], timings: {},
  scale: '3 directory entries; files <=65536 bytes; output <=131073 bytes; one owned workload at a time; alarms <=8 seconds',
  limitsNotExercised: ['1000-entry directory/discovery maximum', '6 MiB adapter/64 MiB helper file maximum', 'helper 2 MiB output ring eviction', 'non-Git/content search (accepted T-106 evidence reused)', 'directory cancellation API', 'product recovery and approval timeouts'] };
let fsFiber, subFiber, pluginFiber, helpers, provider, project;
const processes = new Set();
const logs = []; ctx.logger.exporter({ levels: { default: 4 }, export: m => logs.push(m.type) });
async function rejection(fn, code) {
  try { await fn(); } catch (error) { assert.equal(error.code ?? error.kind, code); return safeError(error); }
  throw new Error('T107_EXPECTED_REJECTION');
}
async function store(path, bytes) {
  await project.write(path, bytes);
  assert.deepEqual(await project.read(path), bytes);
  report.storedFiles.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
}
async function start(mode, amount = 0) {
  const p = await project.start(['python3', '-I', project.root + '/probe.py', mode, token, String(amount)]);
  processes.add(p); return p;
}
async function exited(p) {
  const end = performance.now() + 8000;
  let state;
  do { state = await p.status(); if (!state.running) return state; await delay(20); } while (performance.now() < end);
  throw new Error('T107_EXIT_DEADLINE');
}
async function release(p) { await p.release(); processes.delete(p); }
try {
  fsFiber = ctx.plugin(LocalFileSystem, { cwd: join(run, 'workspace') }); await fsFiber;
  subFiber = ctx.plugin(LocalSubprocessRuntime); await subFiber;
  pluginFiber = ctx.plugin(entry, { hosts: [] }); await pluginFiber;
  const service = ctx.get('sshRemote'); helpers = service.helpers;
  const connectStart = performance.now();
  const state = await service.connectHost(alias);
  report.timings.helperConnectMs = Math.round(performance.now() - connectStart);
  const raw = helpers.entries.get(alias).client;
  report.helper = { version: state.version, health: state.status, limits: raw.hello.limits,
    resumeCapability: raw.hello.capabilities?.session?.resume ?? null,
    providerRecovery: 'disabled; no recoverable provider window',
    dedupRetention: 'source-derived max(session retention,600 seconds); not a tested replay guarantee' };
  provider = new BoundProvider(raw, token, report.calls);
  ({ project } = await provider.createRun());
  report.disabledChannelRejections = {};
  for (const name of DISABLED_CHANNELS) report.disabledChannelRejections[name] = await rejection(() => provider.compatibility(name), 'T106_CHANNEL_DISABLED');
  await store('probe.py', Buffer.from('import sys,signal,time\nsignal.alarm(8)\nmode,token,amount=sys.argv[1:]\nif mode=="output":\n sys.stdout.write("x"*int(amount));sys.stdout.flush()\nelif mode=="wait":\n print("READY",flush=True);time.sleep(6)\nelse: raise ValueError("unknown fixture mode")\n'));
  await project.mkdir('small');
  for (let i = 0; i < 3; i++) await store(`small/f${i}.txt`, Buffer.from('needle-' + token));
  const lists = [];
  for (const limit of [2, 3, 4]) {
    const begin = performance.now();
    const value = await project.call('fs/list', { path: 'small', limit, allowTruncated: true });
    assert.equal(value.entries.length, Math.min(limit, 3)); assert.equal(value.truncated, limit < 3);
    lists.push({ requestedLimit: limit, entries: value.entries.map(e => e.name), truncated: value.truncated, elapsedMs: Math.round(performance.now() - begin) });
  }
  const tooMany = await rejection(() => project.call('fs/list', { path: 'small', limit: 2, allowTruncated: false }), 'E_TOO_LARGE');
  report.cases.push({ id: 'CAP-DIR', status: 'pass', lists, tooMany, pagination: 'none; complete list or explicit truncation/rejection', configuredSmallLimit: 2, staticMaximum: 1000 });
  const files = [];
  for (const length of [31, 32, 33]) {
    const path = `bytes-${length}.bin`, bytes = Buffer.alloc(length, length);
    await store(path, bytes);
    if (length <= 32) {
      const value = await project.call('fs/read', { path, maxBytes: 32 });
      assert.deepEqual(Buffer.from(value.data, 'base64'), bytes);
      files.push({ bytes: length, readLimit: 32, outcome: 'complete' });
    } else files.push({ bytes: length, readLimit: 32, error: await rejection(() => project.call('fs/read', { path, maxBytes: 32 }), 'E_TOO_LARGE') });
  }
  for (const length of [65535, 65536]) await store(`inline-${length}.bin`, Buffer.alloc(length, 17));
  const count = report.calls.length;
  const overInline = await rejection(() => project.write('inline-over.bin', Buffer.alloc(65537)), 'T106_INLINE_FIXTURE_LIMIT');
  assert.equal(report.calls.length, count);
  const ranged = await project.call('fs/readRange', { path: 'bytes-33.bin', offset: 30, length: 2 });
  assert.equal(ranged.eof, false); assert.equal(Buffer.from(ranged.data, 'base64').length, 2);
  const finalRange = await project.call('fs/readRange', { path: 'bytes-33.bin', offset: 32, length: 2, expectedStatVersion: ranged.statVersion });
  assert.equal(finalRange.eof, true); assert.equal(Buffer.from(finalRange.data, 'base64').length, 1);
  report.cases.push({ id: 'CAP-FILE', status: 'pass', files, inlineBoundary: [65535, 65536, 65537], overInline, aboveLimitDispatchCount: 0, rangeBytes: [2, 1], rangeEof: [false, true] });
  const init = await project.start(['git', 'init', '-q']); processes.add(init);
  await init.until(p => p.last.exited); assert.equal((await init.status()).exitCode, 0); await release(init);
  const discoveryId = randomUUID(); const pages = [];
  await project.call('fs/discoverOpen', { discoveryId, operationId: discoveryId, includeIgnored: false });
  let cursor = 0, complete, firstResultMs, scanCompleteMs;
  const searchStart = performance.now();
  try {
    const end = performance.now() + 10000;
    do {
      const page = await project.call('fs/discoverRead', { discoveryId, cursor, limit: 2 });
      assert.equal(page.error, null); assert.ok(page.entries.length <= 2);
      assert.equal(page.cursor, cursor + page.entries.length); cursor = page.cursor;
      pages.push({ count: page.entries.length, cursor, eof: page.eof, complete: page.complete, source: page.source, paths: page.entries.map(e => e.path) });
      if (page.entries.length && firstResultMs === undefined) firstResultMs = Math.round(performance.now() - searchStart);
      if (page.eof) { complete = page; scanCompleteMs = Math.round(performance.now() - searchStart); break; }
      await delay(20);
    } while (performance.now() < end);
    assert.ok(complete?.complete); assert.equal(complete.source, 'git');
    await rejection(() => project.call('fs/discoverRead', { discoveryId, cursor: 0, limit: 501 }), 'E_CURSOR');
  } finally { await project.call('fs/discoverClose', { discoveryId, operationId: randomUUID() }); }
  const found = await project.searchNames('bytes-33'); assert.equal(found.candidates.length, 1);
  const cancelledId = randomUUID();
  await project.call('fs/discoverOpen', { discoveryId: cancelledId, operationId: cancelledId, includeIgnored: false });
  const cancelDiscovery = await project.call('fs/discoverClose', { discoveryId: cancelledId, operationId: randomUUID() });
  report.cases.push({ id: 'CAP-SEARCH', status: 'pass', pages, firstResultMs, scanCompleteMs,
    found: found.candidates.map(e => e.path), cancelDiscovery, cancellationMeaning: 'close immediately after open; small scan may already be complete, not proof of mid-scan cancellation',
    source: 'Git filename discovery only; page request limit 2, invalid request 501 rejected, 500 max statically derived' });
  const outputs = [];
  for (const length of [131071, 131072, 131073]) {
    const begin = performance.now(), p = await start('output', length);
    await p.until(v => v.outputBytes > 0);
    const firstOutputMs = Math.round(performance.now() - begin);
    if (length <= 131072) { await p.until(v => v.last.exited); assert.equal(p.outputBytes, length); }
    else await rejection(() => p.until(v => v.last.exited), 'T106_OUTPUT_LIMIT');
    const state = await exited(p); assert.equal(state.exitCode, 0);
    outputs.push({ requestedBytes: length, observedBytes: p.outputBytes, outcome: length <= 131072 ? 'complete' : 'T106_OUTPUT_LIMIT', firstOutputMs, elapsedMs: Math.round(performance.now() - begin) });
    await release(p);
  }
  report.cases.push({ id: 'CAP-OUTPUT', status: 'pass', outputs, helperTruncation: 'not triggered; 2 MiB ring eviction not tested', adapterLimit: 131072 });
  const p = await start('wait'); await p.until(v => v.text().includes('READY'));
  const begin = performance.now();
  const rpcTimeout = await rejection(() => p.call('process/read', { afterSeq: p.cursor, waitMs: 1000, maxBytes: 32 }, 40), 'timeout');
  const elapsedMs = Math.round(performance.now() - begin);
  assert.equal(rpcTimeout.mutationMayHaveStarted, false); assert.equal((await p.status()).running, true);
  const taskBegin = performance.now();
  const waitDeadline = await rejection(() => p.until(() => false, 40), 'T106_PROCESS_DEADLINE');
  const taskElapsedMs = Math.round(performance.now() - taskBegin);
  const cancelBegin = performance.now(), termination = await p.terminate();
  const cancelElapsedMs = Math.round(performance.now() - cancelBegin);
  assert.equal(termination.final.running, false); await release(p);
  report.cases.push({ id: 'CAP-TIMEOUT', status: 'pass', rpcTimeout, requestedRpcTimeoutMs: 40, elapsedMs,
    waitDeadline, requestedTaskWaitMs: 40, taskElapsedMs, afterTimeout: 'task still running; timeout is not terminal success or cancellation',
    termination, cancelElapsedMs, uncertainty: provider.uncertain });
  assert.equal(provider.uncertain, false);
  const listing = await project.list();
  assert.ok(!listing.some(e => e.name === 'inline-over.bin'));
  for (const f of report.storedFiles) assert.equal(sha256(await project.read(f.path)), f.sha256);
  report.finalReadbackAndNameSearch = true;
} catch (error) { report.failure = { ...safeError(error), message: error.code === 'ERR_ASSERTION' ? error.message : null }; }
finally {
  for (const p of processes) {
    try { await p.call('process/terminate', { operationId: randomUUID(), force: false, graceMs: 1000 }); await exited(p); await p.release(); }
    catch (error) { report.cleanupErrors.push(safeError(error)); }
  }
  try { await provider?.close(); } catch (error) { report.cleanupErrors.push(safeError(error)); }
  for (const fiber of [pluginFiber, subFiber, fsFiber]) { try { await fiber?.dispose(); } catch (error) { report.cleanupErrors.push(safeError(error)); } }
  report.cleanup = { helperEntries: helpers?.entries.size, helpersDisposed: helpers?.disposed, registrySize: [...ctx.registry.entries()].length,
    networkAttempts: attempts, centralWorkspaceEntries: readdirSync(join(run, 'workspace')), logTypes: logs };
  report.probePassed = !report.failure && !report.cleanupErrors.length && report.cases.length === 5 && !attempts.length
    && report.cleanup.registrySize === 0 && helpers?.disposed && helpers.entries.size === 0;
  writeFileSync(join(run, 'capacity.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  hook.deregister();
}
console.log(JSON.stringify({ probePassed: report.probePassed, cases: report.cases.map(c => c.id), failure: report.failure, cleanupErrors: report.cleanupErrors }));
process.exitCode = report.probePassed ? 0 : 1;
