#!/usr/bin/env node
// Read-only correlation of remote-channel incidents from the private preview DB.
// Never opens a channel, contacts Coder/SSH, writes the DB, or replays a task.
import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';

const ACTIONS = new Set(['channel.lost', 'environment.unavailable', 'transport.diagnostic']);

function parse(value) { try { return JSON.parse(value); } catch { return null; } }
function byTime(a, b) { return String(a.observed_at ?? a.created_at).localeCompare(String(b.observed_at ?? b.created_at)); }

export function agentTransitions(observations) {
  const rows = [...observations].sort(byTime);
  const transitions = []; let previous = null;
  for (const row of rows) {
    const status = parse(row.status_json) ?? {};
    const agent = status.agent ?? {};
    // last_connected_at advances continuously while connected; keep it out of
    // the transition key so a long healthy stretch stays one transition.
    const key = JSON.stringify([agent.status ?? null, agent.disconnected_at ?? null,
      status.lifecycle ?? null, status.build?.status ?? null]);
    if (key === previous) continue;
    previous = key;
    transitions.push({observed_at: row.observed_at, agent_status: agent.status ?? null,
      disconnected_at: agent.disconnected_at ?? null, last_connected_at: agent.last_connected_at ?? null,
      workspace_lifecycle: status.lifecycle ?? null, build_status: status.build?.status ?? null});
  }
  return transitions;
}

export function outageWindows(observations) {
  const rows = [...observations].sort(byTime);
  const windows = []; let current = null, active = null, initialized = false;
  for (const row of rows) {
    const status = parse(row.status_json) ?? {};
    const agent = status.agent ?? {};
    const disconnected = agent.disconnected_at ?? null;
    const connected = agent.last_connected_at ?? null;
    if (!initialized) {
      initialized = true; current = disconnected;
      // The span may start in the middle of an old, already recovered disconnect;
      // only keep it as an incident if the agent is still down at this point.
      const alreadyHealthy = agent.status === 'connected' && connected !== null && connected > disconnected;
      if (disconnected !== null && !alreadyHealthy) {
        active = {disconnected_at: disconnected, first_observed_at: row.observed_at, last_observed_at: row.observed_at,
          lifecycle: status.lifecycle ?? null, observations: 0, recovered_at: null};
        windows.push(active);
      }
    } else if (disconnected !== current) {
      current = disconnected; active = null;
      if (disconnected !== null) {
        active = {disconnected_at: disconnected, first_observed_at: row.observed_at, last_observed_at: row.observed_at,
          lifecycle: status.lifecycle ?? null, observations: 0, recovered_at: null};
        windows.push(active);
      }
    }
    if (!active) continue;
    active.observations += 1;
    active.last_observed_at = row.observed_at;
    if (connected && connected > disconnected && (!active.recovered_at || connected < active.recovered_at))
      active.recovered_at = connected;
  }
  return windows.map(window => ({...window, recovered: Boolean(window.recovered_at),
    duration_ms: Date.parse(window.recovered_at ?? window.last_observed_at) - Date.parse(window.disconnected_at)}));
}

export function channelLosses(events) {
  const rows = [...events].sort(byTime).filter(row => row.action === 'channel.lost' || row.action === 'environment.unavailable');
  const losses = [];
  for (const row of rows) {
    const details = parse(row.details_json) ?? {};
    losses.push({at: row.created_at, action: row.action, outcome: row.outcome ?? null,
      reason: details.reason ?? null, stage: details.stage ?? null, channel_id: details.channel_id ?? null,
      helper_session_id: details.helper_session_id ?? null, ssh_exit_code: details.ssh_exit_code ?? null,
      ssh_signal: details.ssh_signal ?? null, resource_id: row.resource_id ?? null});
  }
  return losses;
}

export function brokerFailures(events) {
  const failures = [];
  for (const row of [...events].sort(byTime)) {
    if (row.action !== 'transport.diagnostic') continue;
    const details = parse(row.details_json) ?? {};
    if (details.layer !== 'broker' || details.exit_code === 0) continue;
    failures.push({at: row.created_at, mode: details.mode ?? null, exit_code: details.exit_code ?? null,
      signal: details.signal ?? null, close_observed: details.close_observed ?? null,
      duration_ms: details.duration_ms ?? null, stderr_bytes: details.stderr_bytes ?? null,
      stderr_sha256: details.stderr_sha256 ?? null, broker_pid: details.broker_pid ?? null});
  }
  return failures;
}

export function unknownOperations(operations) {
  const rows = operations.filter(row => row.state === 'unknown');
  const bySession = new Map();
  for (const row of rows) bySession.set(row.session_id, (bySession.get(row.session_id) ?? 0) + 1);
  const byDay = new Map();
  for (const row of rows) { const day = String(row.created_at).slice(0, 10); byDay.set(day, (byDay.get(day) ?? 0) + 1); }
  return {count: rows.length,
    by_session: [...bySession].map(([session_id, count]) => ({session_id, count})),
    by_day: [...byDay].map(([day, count]) => ({day, count})).sort((a, b) => a.day.localeCompare(b.day)),
    operations: rows.map(row => ({operation_id: row.operation_id, kind: row.kind, session_id: row.session_id,
      error_code: row.error_code, created_at: row.created_at}))};
}

export function incidentReport({observations = [], events = [], operations = []}) {
  const transitions = agentTransitions(observations);
  const windows = outageWindows(observations);
  const losses = channelLosses(events);
  const failures = brokerFailures(events);
  return {
    scope: 'Read-only correlation from stored observations/audit/operations; no channel, SSH, Coder or model action.',
    observation_span: observations.length ? {first: [...observations].sort(byTime)[0].observed_at,
      last: [...observations].sort(byTime).at(-1).observed_at, rows: observations.length} : null,
    agent_transitions: transitions,
    outages: windows,
    channel_losses: losses,
    broker_failures: failures,
    unknown_operations: unknownOperations(operations),
    correlation: windows.map(window => {
      const start = Date.parse(window.disconnected_at);
      const end = window.recovered_at ? Date.parse(window.recovered_at) : Infinity;
      const lookback = start - 120000;
      const at = item => Date.parse(item.at);
      return {disconnected_at: window.disconnected_at, recovered_at: window.recovered_at, recovered: window.recovered,
        precursor_losses: losses.filter(item => at(item) >= lookback && at(item) < start).length,
        losses_in_window: losses.filter(item => at(item) >= start && at(item) <= end).length,
        precursor_broker_failures: failures.filter(item => at(item) >= lookback && at(item) < start).length,
        broker_failures_in_window: failures.filter(item => at(item) >= start && at(item) <= end).length};
    })
  };
}

export function loadReport(dbPath) {
  const db = new DatabaseSync(dbPath, {readOnly: true});
  try {
    const observations = db.prepare('SELECT observed_at, status_json FROM environment_observations ORDER BY observed_at, rowid').all();
    const events = db.prepare(`SELECT created_at, action, outcome, details_json, resource_id FROM audit_events
      WHERE action IN ('channel.lost','environment.unavailable','transport.diagnostic') ORDER BY created_at, rowid`).all()
      .filter(row => ACTIONS.has(row.action));
    const operations = db.prepare('SELECT operation_id, kind, session_id, state, error_code, created_at FROM operation_records').all();
    return incidentReport({observations, events, operations});
  } finally { db.close(); }
}

export function formatReport(report) {
  const lines = ['Remote incident diagnostics (read-only)'];
  if (report.observation_span) lines.push(`Observations: ${report.observation_span.rows} rows, ${report.observation_span.first} → ${report.observation_span.last}`);
  for (const outage of report.outages) lines.push(`Agent outage: disconnect ${outage.disconnected_at}, recover ${outage.recovered_at ?? 'unresolved'}, duration ${outage.duration_ms ?? 'unknown'} ms, recovered ${outage.recovered}`);
  const recent = report.agent_transitions.slice(-8);
  for (const transition of recent) lines.push(`Agent transition: ${transition.observed_at} status ${transition.agent_status} disconnected ${transition.disconnected_at} last ${transition.last_connected_at} lifecycle ${transition.workspace_lifecycle} build ${transition.build_status}`);
  const losses = report.channel_losses.filter(item => item.action === 'channel.lost').slice(-12);
  for (const loss of losses) lines.push(`Channel loss: ${loss.at} reason ${loss.reason} stage ${loss.stage} channel ${loss.channel_id}`);
  for (const failure of report.broker_failures) lines.push(`Broker failure: ${failure.at} mode ${failure.mode} exit ${failure.exit_code} signal ${failure.signal} stderr ${failure.stderr_bytes} bytes`);
  lines.push(`Unknown operations: ${report.unknown_operations.count} (${report.unknown_operations.by_day.map(day => day.day + ':' + day.count).join(', ') || 'none'})`);
  return lines.join('\n') + '\n';
}

async function main() {
  const args = process.argv.slice(2);
  const options = {db: resolve('.preview/agent-studio/bindings.sqlite'), json: false, help: false};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') options.json = true;
    else if (args[i] === '--help') options.help = true;
    else if (args[i] === '--db') { const value = args[++i]; if (!value || value.startsWith('--')) throw new Error('--db requires a path'); options.db = resolve(value); }
    else throw new Error('Unknown remote-diagnostics option: ' + args[i]);
  }
  if (options.help) {
    process.stdout.write('Usage: node scripts/dev/remote-diagnostics.mjs [--json] [--db PATH]\n'
      + 'Read-only: correlates stored Coder agent observations, channel loss, broker failures and unknown operations.\n'
      + 'Never connects to Coder/SSH, writes the database, spawns a task or replays anything.\n');
    return;
  }
  const report = loadReport(options.db);
  process.stdout.write((options.json ? JSON.stringify(report, null, 2) : formatReport(report)) + (options.json ? '\n' : ''));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
