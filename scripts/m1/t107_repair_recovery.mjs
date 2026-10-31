// New isolated adapter. The frozen provider and installed helper are unchanged.
// Only raw RPC clients: no managed facade, automatic reconnect or mutation replay.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BoundProvider, sha256 } from './t106_provider.mjs';
import { duration, fault } from './t107_repair_policy.mjs';
const same = (a, b, code) => { try { assert.deepEqual(a, b); } catch { throw fault(code); } };
const clone = value => structuredClone(value);
export class RecoveringProvider extends BoundProvider {
  #binding; #identity; #lostAt; #clock; #window; #state = 'connected';
  constructor(raw, token, binding, { audit = [], recoveryMs, now = () => performance.now() } = {}) {
    super(raw, token, audit);
    assert.ok(binding.workspaceId && binding.buildId && binding.marker?.generation);
    this.#binding = clone(binding); this.#clock = now; this.#window = duration('recovery', recoveryMs);
    if (!(raw.session.retentionMs >= this.#window) || raw.capabilities.session?.resume !== true)
      throw fault('T107_RECOVERY_UNSUPPORTED');
  }
  get recoveryState() { return this.#state; }
  get recoveryWindowMs() { return this.#window; }
  saveOriginal(task, operationId, argv, observed) {
    if (this.#identity || task.workspace.provider !== this || !task.started) throw fault('T107_TASK_IDENTITY');
    const start = this.audit.find(r => r.method === 'process/start' && r.operationId === operationId);
    if (!start || start.processId !== task.id || start.dispatchCount !== 1 || start.result !== 'response') throw fault('T107_TASK_IDENTITY');
    same(start.argv, argv, 'T107_TASK_IDENTITY');
    if (observed.pid !== task.started.pid || !/^\d+$/.test(observed.startTick)
        || observed.kind !== 'workload' || !observed.belongsToRun || observed.cwd !== task.workspace.root)
      throw fault('T107_TASK_IDENTITY');
    this.#identity = { binding: clone(this.#binding), sessionId: this.sessionId,
      serverEpoch: this.client.session.serverEpoch, clientId: this.client.session.clientId,
      workspaceId: task.workspace.id, root: task.workspace.root, processId: task.id, operationId,
      argv: clone(argv), argvSha256: sha256(JSON.stringify(argv)), startParamsSha256: start.paramsSha256, pid: observed.pid,
      startTick: observed.startTick, pgid: observed.pgid, sid: observed.sid, uid: observed.uid };
    return clone(this.#identity);
  }
  async disconnect(closeOwnedTransport) {
    if (!this.#identity || this.#state !== 'connected') throw fault('T107_TASK_IDENTITY');
    this.#lostAt = this.#clock(); this.#state = 'disconnected';
    try { await closeOwnedTransport(); if (!this.client.closeReason) throw fault('T107_TRANSPORT_NOT_CLOSED'); }
    catch (error) { this.#state = 'unknown'; throw error; }
  }
  #check(saved) {
    same(saved, this.#identity, 'T107_TASK_IDENTITY');
    if (this.#state !== 'disconnected') throw fault('T107_RECOVERY_STATE');
    if (this.#clock() - this.#lostAt >= this.#window) {
      this.#state = 'unknown'; throw fault('T107_RECOVERY_WINDOW_EXPIRED');
    }
  }
  // authenticate supplies a fresh T-105 gated transport, never a cached pass bit.
  // observe supplies independent controller /proc + current API/SQL identity.
  async recover(saved, authenticate, observe) {
    this.#check(saved);
    let next;
    try {
      next = await authenticate(this.#window - (this.#clock() - this.#lostAt));
      this.#check(saved);
      if (next.constructor.name !== 'RemoteHelperRpcClient' || next.session.resumed !== true
          || next.sessionId !== saved.sessionId || next.session.serverEpoch !== saved.serverEpoch
          || next.session.clientId !== saved.clientId) throw fault('T107_SERVER_SESSION_CHANGED');
      const status = await next.call('process/status', { workspaceId: saved.workspaceId, processId: saved.processId },
        { timeoutMs: Math.max(1, Math.min(5000, Math.floor(this.#window - (this.#clock() - this.#lostAt)))) });
      if (status.processId !== saved.processId || status.pid !== saved.pid || status.pgid !== saved.pgid || !status.running)
        throw fault('T107_TASK_IDENTITY');
      const receipt = await observe(saved);
      same(receipt.binding, saved.binding, 'T107_BINDING_CHANGED');
      const p = receipt.process;
      for (const key of ['pid', 'startTick', 'pgid', 'sid', 'uid'])
        if (p?.[key] !== saved[key]) throw fault('T107_TASK_IDENTITY');
      if (p.kind !== 'workload' || !p.belongsToRun || p.cwd !== saved.root) throw fault('T107_TASK_IDENTITY');
      this.#check(saved); this.client = next; this.#state = 'recovered';
      // Deliberately do not clear inherited uncertain; recovery is not outcome resolution.
      return { status, identity: clone(saved), recovered: true, mutationReplayEnabled: false };
    } catch (error) { this.#state = 'unknown'; next?.close('recovery rejected'); throw error; }
  }
  async cancelOriginal(saved) {
    same(saved, this.#identity, 'T107_TASK_IDENTITY');
    if (!['connected', 'recovered'].includes(this.#state)) throw fault('T107_CANCEL_OUTCOME_UNKNOWN');
    const params = { workspaceId: saved.workspaceId, processId: saved.processId };
    const current = await this.call('process/status', params);
    if (current.pid !== saved.pid || current.processId !== saved.processId || current.pgid !== saved.pgid)
      throw fault('T107_TASK_IDENTITY');
    this.#state = 'cancel-pending';
    try {
      await this.call('process/terminate', { ...params, operationId: randomUUID(), force: false, graceMs: 500 }, 2000);
      const deadline = this.#clock() + 3000;
      do {
        const status = await this.call('process/status', params, 1000);
        if (!status.running) { this.#state = 'cancelled'; return status; }
        await delay(25);
      } while (this.#clock() < deadline);
      throw fault('T107_CANCEL_UNCONFIRMED');
    } catch (error) { this.#state = 'unknown'; throw error; }
  }
}
