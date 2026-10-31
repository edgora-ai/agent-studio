// Server-owned fixture authority. Never infer realm from request/cwd/path shape.
// This is an isolated composition seam, not persistent product binding/auth.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Readable } from 'node:stream';
import { fault } from './t107_repair_policy.mjs';
export class ContextAuthority {
  #records = new Map(); #handles = new WeakMap(); #scope = new AsyncLocalStorage(); #now;
  constructor(now = () => performance.now()) { this.#now = now; }
  register({ id, realm, generation, expiresAt, principal }) {
    if (!id || !['local', 'remote'].includes(realm) || !principal || !Number.isInteger(generation)
        || !Number.isFinite(expiresAt)) throw fault('T107_CONTEXT_REGISTRATION');
    const record = Object.freeze({ id, realm, generation, expiresAt, principal });
    this.#records.set(id, record);
    const handle = Object.freeze({}); this.#handles.set(handle, record); return handle;
  }
  inject(handle, fn) { return this.#scope.run(handle, fn); }
  authorize(payload) {
    const handle = this.#scope.getStore(), record = handle && this.#handles.get(handle);
    if (!record) throw fault('T107_CONTEXT_UNKNOWN');
    if (this.#records.get(record.id) !== record) throw fault('T107_CONTEXT_STALE');
    if (this.#now() >= record.expiresAt) throw fault('T107_CONTEXT_EXPIRED');
    if (record.realm !== 'local') throw fault('T107_REMOTE_LOCAL_ACTION_DENIED');
    // Optional claims may further restrict, never create authority.
    for (const [claim, expected] of [['sessionId', record.id], ['contextId', record.id], ['generation', record.generation], ['principal', record.principal]])
      if (payload?.[claim] !== undefined && payload[claim] !== expected) throw fault('T107_CONTEXT_MISMATCH');
    if (payload?.binding !== undefined) throw fault('T107_UNTRUSTED_BINDING_CLAIM');
    return handle;
  }
  wrap(fn, payloadOf = args => args[0]) {
    const authority = this;
    return function (...args) { authority.authorize(payloadOf(args)); return fn.apply(this, args); };
  }
  route(route) {
    if (!['/sidebar/api', '/open-in-app/open'].includes(route.path)) return route;
    const authority = this, original = route.handler;
    return { ...route, async handler(req, res) {
      // Match the installed sidebar handler's URL.pathname semantics exactly.
      // Its fixed base is a parsing carrier, not a network destination.
      if (route.path === '/sidebar/api') {
        let pathname;
        try { pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname; }
        catch { return deny(res, fault('T107_CONTEXT_TARGET_INVALID')); }
        if (pathname !== '/sidebar/api/open.external') return original(req, res);
      }
      try { authority.authorize(); } catch (error) { return deny(res, error); }
      let size = 0; const chunks = [];
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > 65536) return deny(res, fault('T107_CONTEXT_BODY_LIMIT'));
        chunks.push(bytes);
      }
      const body = Buffer.concat(chunks);
      try { authority.authorize(body.length ? JSON.parse(body) : undefined); }
      catch (error) { return deny(res, error); }
      const forwarded = Readable.from(body.length ? [body] : []);
      Object.assign(forwarded, { url: req.url, method: req.method, headers: req.headers, fixtureAdmission: req.fixtureAdmission });
      return original(forwarded, res);
    } };
  }
  shortcut(spec, selectedContext) {
    const authority = this;
    return { ...spec, resolve(...args) {
      let captured;
      try { captured = authority.authorize(selectedContext()); } catch (error) { return { status: 'blocked', reason: error.code }; }
      const selected = spec.resolve(...args);
      if (selected.status !== 'handled') return selected;
      return { ...selected, run(...runArgs) {
        if (authority.authorize(selectedContext()) !== captured) throw fault('T107_CONTEXT_MISMATCH');
        return selected.run(...runArgs);
      } };
    } };
  }
}
function deny(res, error) {
  res.writeHead(403, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: error.code ?? 'T107_CONTEXT_BAD_REQUEST' }));
}
