import test from 'node:test';
import assert from 'node:assert/strict';
import { RecoveringProvider } from './t107_repair_recovery.mjs';
import { DeadlinePolicy, duration, DISCOVERY_CONTRACT } from './t107_repair_policy.mjs';
import { ContextAuthority } from './t107_repair_guard.mjs';
import { Readable } from 'node:stream';
// Repair2 ordinary local route regressions; no network or installed actions here.
function routeFixture() {
  const guard = new ContextAuthority(() => 10); const calls = [];
  const handle = realm => guard.register({ id: realm, realm, generation: 1, principal: 'fixture', expiresAt: 20 });
  const local = handle('local'), remote = handle('remote');
  const route = guard.route({ path: '/sidebar/api', async handler(req, res) { calls.push(req.url); res.end(); } });
  async function invoke(context, target, payload = {}) {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(payload))]), { url: target, method: 'POST', headers: {} });
    const res = { status: 200, body: '', writeHead(status) { this.status = status; }, end(body = '') { this.body += body; } };
    await guard.inject(context, () => route.handler(req, res)); return res;
  }
  return { local, remote, calls, invoke };
}
for (const target of ['/sidebar/api/open.external', '/sidebar/api/./open.external', '/sidebar/api/%2e/open.external'])
  test('sidebar classification agrees with downstream for ' + target, async () => {
    const f = routeFixture();
    for (const context of [f.remote, undefined, {}]) {
      const result = await f.invoke(context, target, { realm: 'local', sessionId: 'local', binding: { realm: 'local' } });
      assert.equal(result.status, 403); assert.equal(f.calls.length, 0);
    }
    assert.equal((await f.invoke(f.local, target)).status, 200); assert.deepEqual(f.calls, [target]);
  });
test('unparseable target is rejected without delegating', async () => {
  const f = routeFixture(); const result = await f.invoke(f.local, 'http://[');
  assert.equal(result.status, 403); assert.equal(JSON.parse(result.body).error, 'T107_CONTEXT_TARGET_INVALID');
  assert.equal(f.calls.length, 0);
});
test('non-action sidebar directory request still delegates', async () => {
  const f = routeFixture(); assert.equal((await f.invoke(undefined, '/sidebar/api/fs.tree')).status, 200);
  assert.deepEqual(f.calls, ['/sidebar/api/fs.tree']);
});
// Offline boundary tests, not the actual remote experiment.
class RemoteHelperRpcClient {
  constructor() { this.sessionId = 'session'; this.session = { sessionId: 'session', clientId: 'client', serverEpoch: 'epoch', retentionMs: 600000, resumed: true };
    this.capabilities = { session: { resume: true } }; this.hello = { helperVersion: '0.13.1' }; this.closed = Promise.resolve(); this.calls = []; }
  async call(method, params) { this.calls.push({ method, params }); return { processId: 'task', pid: 42, pgid: 42, running: method !== 'process/terminate' }; }
  close() { this.closeReason = new Error('closed'); }
}
function fixture() {
  let clock = 0;
  const binding = { workspaceId: 'binding', buildId: 'build', marker: { generation: 1 } };
  const raw = new RemoteHelperRpcClient(), argv = ['synthetic'], audit = [{ method: 'process/start', operationId: 'operation', processId: 'task', dispatchCount: 1, result: 'response', argv }];
  const p = new RecoveringProvider(raw, 'a'.repeat(24), binding, { audit, now: () => clock });
  const observed = { pid: 42, pgid: 42, sid: 42, uid: 1000, startTick: '123', kind: 'workload', belongsToRun: true, cwd: p.base + '/project' };
  const task = { workspace: { provider: p, id: 'workspace', root: observed.cwd }, id: 'task', started: { pid: 42 } };
  const saved = p.saveOriginal(task, 'operation', argv, observed);
  return { p, raw, saved, observed, binding, setClock: v => { clock = v; },
    disconnect: () => p.disconnect(async () => raw.close()), observe: async () => ({ binding, process: observed }) };
}
test('within-window same-session original task is requeried without mutation replay', async () => {
  const f = fixture(); await f.disconnect(); const next = new RemoteHelperRpcClient();
  await f.p.recover(f.saved, async remaining => { assert.equal(remaining, 30000); return next; }, f.observe);
  assert.deepEqual(next.calls.map(c => c.method), ['process/status']); assert.equal(f.p.recoveryState, 'recovered');
});
for (const key of ['operationId', 'processId', 'workspaceId', 'pid', 'startTick', 'root', 'argvSha256', 'binding'])
  test('reject altered saved ' + key + ' before connector', async () => {
    const f = fixture(); await f.disconnect(); let calls = 0;
    await assert.rejects(f.p.recover({ ...f.saved, [key]: 'wrong' }, async () => { calls++; }, f.observe), { code: 'T107_TASK_IDENTITY' });
    assert.equal(calls, 0);
  });
test('expired recovery remains unknown and does not connect', async () => {
  const f = fixture(); await f.disconnect(); f.setClock(30000);
  await assert.rejects(f.p.recover(f.saved, () => assert.fail('connector called'), f.observe), { code: 'T107_RECOVERY_WINDOW_EXPIRED' });
  assert.equal(f.p.recoveryState, 'unknown');
  await assert.rejects(f.p.cancelOriginal(f.saved), { code: 'T107_CANCEL_OUTCOME_UNKNOWN' });
});
for (const key of ['serverEpoch', 'clientId', 'resumed']) test('reject changed server ' + key, async () => {
  const f = fixture(); await f.disconnect(); const next = new RemoteHelperRpcClient(); next.session[key] = 'wrong';
  await assert.rejects(f.p.recover(f.saved, async () => next, f.observe), { code: 'T107_SERVER_SESSION_CHANGED' });
  assert.equal(next.calls.length, 0); assert.ok(next.closeReason); assert.equal(f.p.recoveryState, 'unknown');
});
test('reject new server session', async () => {
  const f = fixture(); await f.disconnect(); const next = new RemoteHelperRpcClient(); next.sessionId = 'new';
  await assert.rejects(f.p.recover(f.saved, async () => next, f.observe), { code: 'T107_SERVER_SESSION_CHANGED' });
});
for (const key of ['binding', 'startTick']) test('reject independently observed changed ' + key, async () => {
  const f = fixture(); await f.disconnect();
  await assert.rejects(f.p.recover(f.saved, async () => new RemoteHelperRpcClient(), async () => ({
    binding: key === 'binding' ? { ...f.binding, marker: { generation: 2 } } : f.binding,
    process: key === 'startTick' ? { ...f.observed, startTick: '124' } : f.observed,
  })), { code: key === 'binding' ? 'T107_BINDING_CHANGED' : 'T107_TASK_IDENTITY' });
  assert.equal(f.p.recoveryState, 'unknown');
});
test('recovery window is checked again after authentication', async () => {
  const f = fixture(); await f.disconnect(); const next = new RemoteHelperRpcClient();
  await assert.rejects(f.p.recover(f.saved, async () => { f.setClock(30000); return next; }, f.observe), { code: 'T107_RECOVERY_WINDOW_EXPIRED' });
  assert.ok(next.closeReason); assert.equal(next.calls.length, 0); assert.equal(f.p.recoveryState, 'unknown');
});
test('recovery does not clear unknown mutation outcome or enable replay', async () => {
  const f = fixture(); f.p.uncertain = true; await f.disconnect();
  await f.p.recover(f.saved, async () => new RemoteHelperRpcClient(), f.observe);
  await assert.rejects(f.p.call('fs/write', { operationId: 'new' }), { code: 'T106_UNKNOWN_OUTCOME' });
  f.p.uncertain = false; f.p.usedOperations.add('old');
  await assert.rejects(f.p.call('fs/write', { operationId: 'old' }), { code: 'T106_REPLAY_DISABLED' });
});
test('finite configurable policy bounds and discovery correction', () => {
  assert.equal(duration('task'), 60000); assert.equal(duration('approval'), 30000);
  for (const kind of ['task', 'approval', 'recovery']) for (const n of [0, -1, Infinity, 1.5, 300001])
    assert.throws(() => duration(kind, n), { code: 'T107_INVALID_DEADLINE' });
  assert.equal(DISCOVERY_CONTRACT.hardEndToEndDeadlineMs, null);
  assert.equal(DISCOVERY_CONTRACT.postOpenLoopBudgetMs, 18000);
});
test('approval expiry denies and late approve rejects; local explicit approve works', async () => {
  const p = new DeadlinePolicy({ approvalMs: 5 }); const a = p.approval();
  await new Promise(r => setTimeout(r, 15)); assert.equal(a.state, 'expired-denied');
  assert.throws(() => a.decide(true), { code: 'T107_APPROVAL_CLOSED' });
  const b = p.approval(); assert.equal(b.decide(true), 'approved');
});
test('task expiry invokes original cancel; unsuccessful cancellation stays unknown', async () => {
  const p = new DeadlinePolicy({ taskMs: 5 }); let count = 0;
  const a = p.task(async () => { count++; return { running: false }; });
  assert.equal(await a.expired, 'expired-cancelled'); assert.equal(count, 1);
  const b = p.task(async () => { throw new Error('transport lost'); });
  assert.equal(await b.expired, 'unknown'); assert.equal(b.error.name, 'Error');
});
test('registered run cannot be reused under another local capability or changed selection', () => {
  const g = new ContextAuthority(() => 10); let effects = 0, selected = 'one';
  const one = g.register({ id: 'one', realm: 'local', generation: 1, principal: 'p', expiresAt: 20 });
  const two = g.register({ id: 'two', realm: 'local', generation: 1, principal: 'p', expiresAt: 20 });
  const spec = g.shortcut({ resolve: () => ({ status: 'handled', run: () => ++effects }) }, () => ({ sessionId: selected }));
  const ready = g.inject(one, () => spec.resolve()); selected = 'two';
  assert.throws(() => g.inject(two, () => ready.run()), { code: 'T107_CONTEXT_MISMATCH' });
  assert.throws(() => g.inject(one, () => ready.run()), { code: 'T107_CONTEXT_MISMATCH' });
  selected = 'one'; assert.equal(g.inject(one, () => ready.run()), 1); assert.equal(effects, 1);
});
test('trusted capability is required; request realm and local cwd cannot authorize', () => {
  const g = new ContextAuthority(() => 10); let effects = 0;
  const action = g.wrap(() => ++effects);
  const local = g.register({ id: 's', realm: 'local', generation: 1, principal: 'p', expiresAt: 20 });
  const remote = g.register({ id: 'r', realm: 'remote', generation: 1, principal: 'p', expiresAt: 20 });
  for (const h of [undefined, {}, remote]) assert.throws(() => g.inject(h, () => action({ realm: 'local', cwd: '/local' })));
  assert.equal(effects, 0); assert.equal(g.inject(local, () => action({ sessionId: 's' })), 1);
  assert.throws(() => g.inject(local, () => action({ sessionId: 'other' })), { code: 'T107_CONTEXT_MISMATCH' });
  g.register({ id: 's', realm: 'local', generation: 2, principal: 'p', expiresAt: 20 });
  assert.throws(() => g.inject(local, () => action({})), { code: 'T107_CONTEXT_STALE' });
  assert.equal(effects, 1);
});
