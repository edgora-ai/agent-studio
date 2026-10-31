// Isolated initial policy; not a product approval UI or a task-execution SLA.
export const POLICY = Object.freeze({ task: { defaultMs: 60000, maximumMs: 300000 },
  approval: { defaultMs: 30000, maximumMs: 120000 }, recovery: { defaultMs: 30000, maximumMs: 120000 } });
export const fault = code => Object.assign(new Error(code), { code });
export function duration(kind, value = POLICY[kind]?.defaultMs) {
  if (!POLICY[kind] || !Number.isInteger(value) || value <= 0 || value > POLICY[kind].maximumMs)
    throw fault('T107_INVALID_DEADLINE');
  return value;
}
export class DeadlinePolicy {
  constructor({ taskMs, approvalMs, now = () => performance.now(), schedule = setTimeout, unschedule = clearTimeout } = {}) {
    this.taskMs = duration('task', taskMs); this.approvalMs = duration('approval', approvalMs);
    this.now = now; this.schedule = schedule; this.unschedule = unschedule;
  }
  approval() {
    const deadline = this.now() + this.approvalMs;
    let state = 'pending';
    const expire = () => { if (state === 'pending' && this.now() >= deadline) state = 'expired-denied'; };
    const timer = this.schedule(expire, this.approvalMs);
    return { deadline, get state() { expire(); return state; },
      decide: approved => { expire(); if (state !== 'pending') throw fault('T107_APPROVAL_CLOSED');
        if (typeof approved !== 'boolean') throw fault('T107_INVALID_APPROVAL');
        state = approved ? 'approved' : 'denied'; this.unschedule(timer); return state; },
      dispose: () => { this.unschedule(timer); if (state === 'pending') state = 'cancelled-denied'; } };
  }
  task(cancelOriginal) {
    const deadline = this.now() + this.taskMs;
    let state = 'running', error;
    let settle;
    const expired = new Promise(resolve => { settle = resolve; });
    const expire = async () => {
      if (state !== 'running') return;
      state = 'cancel-pending';
      try {
        const status = await cancelOriginal();
        if (status.running !== false) throw fault('T107_CANCEL_UNCONFIRMED');
        state = 'expired-cancelled';
      } catch (e) { state = 'unknown'; error = { code: e.code ?? null, name: e.name }; }
      settle(state);
    };
    const timer = this.schedule(expire, this.taskMs);
    return { deadline, expired, get state() { return state; }, get error() { return error; },
      finish: () => { this.unschedule(timer); if (state === 'running') state = 'completed'; },
      dispose: () => { this.unschedule(timer); if (state === 'running') state = 'unknown'; } };
  }
}
// Correction to the historical matrix, not a changed frozen implementation.
export const DISCOVERY_CONTRACT = Object.freeze({ owner: 'frozen BoundWorkspace.discover',
  postOpenLoopBudgetMs: 18000, openRpcDefaultMs: 5000, readRpcDefaultMs: 5000,
  closeRpcDefaultMs: 5000, rpcPermittedMaximumMs: 10000,
  cleanup: 'separately awaited close in finally; close error propagates',
  hardEndToEndDeadlineMs: null, lateEofCanReturnComplete: true,
  offlineCounterexampleMs: 28800, remoteLatencyMeasurement: false });
