// Serialized into the hash-locked original sidebar. Dependencies are supplied by
// the projection so the installed package and its original tree remain intact.
export function studioDirectoryWatch(options, React, websocketUrl, Socket, timers) {
  const {sessionId, root, dirs, visible = true, onStale} = options;
  const paths = [...new Set([root, ...dirs].filter(path => typeof path === 'string' && path.length > 0))];
  const scope = JSON.stringify([sessionId, root, visible]);
  const live = React.useRef({scope, paths, onStale});
  live.current = {scope, paths, onStale};
  const [status, setStatus] = React.useState(null);
  const armed = visible && typeof sessionId === 'string' && sessionId.length > 0 && paths.length > 0;
  const pathsKey = JSON.stringify(paths);
  const reconcileRef = React.useRef(() => {});
  React.useEffect(() => {
    if (!armed) return;
    let stopped = false, socket = null, retry = null, failures = 0, owner = 0;
    let identity = null, kind = 'Bound', lastCause = '';
    const requested = new Set(), confirmed = new Set(), reloaded = new Set();
    const current = () => !stopped && live.current.scope === scope;
    const publish = (phase, detail = lastCause) => {
      if (current()) setStatus({scope, pathsKey: JSON.stringify(live.current.paths), phase, cause: detail, text: `${kind} tree polling ${phase}${detail ? ': ' + detail : ''} · non-recursive 2.5s · max 1000 entries/directory · reloads managed separately; cached rows may be stale`});
    };
    const send = (op, path) => {
      if (socket?.readyState !== Socket.OPEN) return false;
      try {socket.send(JSON.stringify({op, path})); return true;} catch {fail('watch send failed'); return false;}
    };
    const settled = () => {
      if (requested.size !== confirmed.size || requested.size === 0) {publish('subscribing'); return;}
      failures = 0;
      lastCause = '';
      publish('active (subscription confirmed; listing freshness unknown)');
      if (current() && socket?.readyState === Socket.OPEN) {
         const pendingPaths = live.current.paths.filter(path => confirmed.has(path) && !reloaded.has(path));
        if (pendingPaths.length > 0) {
          for (const path of pendingPaths) reloaded.add(path); // Mark before callback: duplicate ACKs cannot repeat it.
          live.current.onStale(pendingPaths);
        }
      }
    };
    const reconcile = () => {
      if (!current() || socket?.readyState !== Socket.OPEN) return;
      const wanted = new Set(live.current.paths);
      for (const path of [...requested]) if (!wanted.has(path)) {
        if (!send('unwatch', path)) return;
        requested.delete(path); confirmed.delete(path); reloaded.delete(path);
      }
      for (const path of wanted) if (!requested.has(path)) {
        if (!send('watch', path)) return;
        requested.add(path);
      }
      settled();
    };
    reconcileRef.current = reconcile;
    const schedule = () => {
      if (stopped || retry !== null) return;
      const delay = Math.min(1000 * 2 ** Math.min(failures++, 4), 15000);
      retry = timers.setTimeout(() => {retry = null; connect();}, delay);
    };
    const fail = (reason) => {
      if (!current()) return;
      lastCause = reason;
      publish('unavailable (freshness unknown)', reason);
      const old = socket;
      if (old) {socket = null; old.close();}
      schedule();
    };
    const connect = () => {
      if (!current()) return;
      const generation = ++owner;
      identity = null; kind = 'Bound'; requested.clear(); confirmed.clear(); reloaded.clear();
      publish('connecting');
      try {
        const url = websocketUrl('sidebar/ws/fs-watch');
        url.search = new URLSearchParams({sessionId}).toString();
        const ws = new Socket(url.toString()); socket = ws;
        const owns = () => current() && socket === ws && owner === generation;
        ws.onopen = () => {if (owns()) {publish('subscribing'); reconcile();}};
        ws.onmessage = event => {
          if (!owns()) return;
          let frame;
          try {frame = JSON.parse(event.data);} catch {fail('invalid watch frame'); return;}
          if (!frame || typeof frame !== 'object' || Array.isArray(frame) || !frame.identity || typeof frame.identity !== 'object') {fail('invalid watch frame'); return;}
          const id = frame.identity;
          if (id.session_id !== sessionId) return;
          if (typeof id.binding_id !== 'string' || !id.binding_id || !Number.isSafeInteger(id.version) || id.version < 1 || !['local','remote'].includes(id.kind)) {fail('invalid watch identity'); return;}
          if (identity && (id.binding_id !== identity.binding_id || id.version !== identity.version || id.kind !== identity.kind)) return;
          if (frame.mode !== 'poll' || (frame.dir !== undefined && typeof frame.dir !== 'string')) {fail('invalid watch frame'); return;}
          if (frame.dir !== undefined && (!requested.has(frame.dir) || !live.current.paths.includes(frame.dir))) return;
          if (frame.ok !== true && frame.ok !== false && frame.ok !== undefined) {fail('invalid watch frame'); return;}
          if (frame.ok !== true && frame.ok !== false && frame.complete !== true) {fail('incomplete watch frame'); return;}
          identity = id; kind = id.kind === 'local' ? 'Local' : 'Remote';
          if (frame.ok === false || frame.complete === false || frame.truncated === true) {fail(typeof frame.code === 'string' ? frame.code : 'incomplete watch'); return;}
          if (frame.ok === true) {
            if (frame.dir === undefined || frame.intervalMs !== 2500 || (frame.limit !== undefined && frame.limit !== 1000) || (frame.complete !== undefined && frame.complete !== true) || (frame.truncated !== undefined && frame.truncated !== false)) {fail('invalid watch confirmation'); return;}
            confirmed.add(frame.dir);
             settled();
          } else if (frame.dir !== undefined && confirmed.has(frame.dir)) {
            // Only a currently owned directory is eligible for the original
            // batched re-list. The notice does not itself prove reload success.
            live.current.onStale([frame.dir]);
          }
        };
        ws.onerror = () => {if (owns()) fail('socket error');};
        ws.onclose = () => {if (owns()) {socket = null; publish('disconnected (freshness unknown)'); schedule();}};
      } catch {fail('connection failed');}
    };
    connect();
    return () => {
      stopped = true; owner++; reconcileRef.current = () => {};
      if (retry !== null) timers.clearTimeout(retry);
      socket?.close(); socket = null;
    };
  }, [scope, armed]);
  React.useEffect(() => {reconcileRef.current();}, [pathsKey]);
  if (!visible) return 'Bound tree polling parked (hidden; not updating) · cached rows may be stale';
  if (!armed) return 'Bound tree polling unavailable (no bound session/root; freshness unknown) · cached rows may be stale';
  if (status?.scope === scope && status.pathsKey !== pathsKey) return `Bound tree polling subscribing (watch set changed; freshness unknown${status.cause ? ': ' + status.cause : ''}) · cached rows may be stale`;
  return status?.scope === scope ? status.text : 'Bound tree polling connecting · cached rows may be stale';
}
