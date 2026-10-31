import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {MODEL_SCHEMA,modelCallContext} from './model-state.mjs';
import {ACP_SCHEMA,acpOperationContext} from './acp-state.mjs';
import {ENVIRONMENT_SCHEMA} from './environment-state.mjs';
import {RECOVERY_SCHEMA} from './recovery-state.mjs';

export class StudioError extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}
export function requireThat(condition, code, message) {
  if (!condition) throw new StudioError(code, message);
}
export function fields(input, allowed, required = []) {
  requireThat(input && typeof input === 'object' && !Array.isArray(input), 'invalid-input');
  for (const key of Object.keys(input)) requireThat(allowed.includes(key), 'unknown-field', key);
  for (const key of required) requireThat(Object.hasOwn(input, key), 'missing-field', key);
  return input;
}
export function text(value, name, max = 200) {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value), 'invalid-input', name);
  return value.trim();
}
export const id = prefix => `${prefix}-${randomUUID()}`;
export const now = () => new Date().toISOString();
const plain = row => row ? { ...row } : undefined;

const migration = `
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE deployment(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE projects(
 project_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, name TEXT NOT NULL,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('empty','registered')), created_at TEXT NOT NULL);
CREATE TABLE environments(
 environment_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, catalog_key TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('local','coder')), name TEXT NOT NULL,
 lifecycle_state TEXT NOT NULL, connection_state TEXT NOT NULL, capabilities_json TEXT NOT NULL,
 policy_version TEXT NOT NULL, instance_generation TEXT NOT NULL, credential_ref TEXT,
 created_at TEXT NOT NULL, UNIQUE(principal_id,catalog_key));
CREATE TABLE instance_records(
 record_id TEXT PRIMARY KEY, environment_id TEXT NOT NULL REFERENCES environments,
 principal_id TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL,
 instance_generation TEXT NOT NULL, verified_generation TEXT, template_version TEXT NOT NULL,
 allowed_roots_json TEXT NOT NULL, policy_version TEXT NOT NULL, registration_source TEXT NOT NULL,
 verification_state TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE project_bindings(
 binding_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0), principal_id TEXT NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects, environment_id TEXT NOT NULL REFERENCES environments,
 record_id TEXT NOT NULL REFERENCES instance_records, target_root TEXT NOT NULL, policy_version TEXT NOT NULL,
 instance_generation TEXT NOT NULL, verified_generation TEXT, anchor_path TEXT NOT NULL UNIQUE,
 anchor_dev TEXT, anchor_ino TEXT, workspace_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('pending','ready','superseded','invalid','failed')),
 error_code TEXT, created_at TEXT NOT NULL, ready_at TEXT, PRIMARY KEY(binding_id,version));
CREATE TABLE session_bindings(
 session_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, binding_id TEXT NOT NULL, version INTEGER NOT NULL,
 title TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','ready','invalid','failed')),
 error_code TEXT, created_at TEXT NOT NULL, ready_at TEXT,
 FOREIGN KEY(binding_id,version) REFERENCES project_bindings(binding_id,version));
CREATE TABLE audit_events(
 event_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, action TEXT NOT NULL,
 resource_id TEXT NOT NULL, outcome TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX project_owner ON projects(principal_id,name);
CREATE INDEX environment_owner ON environments(principal_id,catalog_key);
CREATE INDEX binding_owner ON project_bindings(principal_id,project_id,version);
CREATE INDEX session_owner ON session_bindings(principal_id,binding_id,version);
CREATE TRIGGER binding_snapshot_immutable BEFORE UPDATE OF binding_id,version,principal_id,project_id,environment_id,record_id,target_root,policy_version,instance_generation,verified_generation,anchor_path ON project_bindings BEGIN SELECT RAISE(ABORT,'immutable binding snapshot'); END;
CREATE TRIGGER binding_anchor_immutable BEFORE UPDATE OF anchor_dev,anchor_ino,workspace_id ON project_bindings WHEN OLD.anchor_ino IS NOT NULL AND (NEW.anchor_dev IS NOT OLD.anchor_dev OR NEW.anchor_ino IS NOT OLD.anchor_ino OR NEW.workspace_id IS NOT OLD.workspace_id) BEGIN SELECT RAISE(ABORT,'immutable anchor identity'); END;
CREATE TRIGGER session_snapshot_immutable BEFORE UPDATE OF session_id,principal_id,binding_id,version ON session_bindings BEGIN SELECT RAISE(ABORT,'immutable session binding'); END;
CREATE TRIGGER instance_snapshot_immutable BEFORE UPDATE ON instance_records BEGIN SELECT RAISE(ABORT,'immutable instance record'); END;
`;

export class Store {
  constructor(root) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    this.path = join(root, 'bindings.sqlite');
    this.db = new DatabaseSync(this.path);
    chmodSync(this.path, 0o600);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    requireThat(version <= 8, 'newer-database');
    if (version === 0) this.transaction(() => {
      this.db.exec(migration);
      this.db.prepare('INSERT INTO schema_migrations VALUES(1,?)').run(now());
      this.db.exec('PRAGMA user_version=1');
    });
    if (version < 2) this.transaction(() => {
      this.db.exec(`ALTER TABLE environments ADD COLUMN provider TEXT NOT NULL DEFAULT 'unavailable';
        UPDATE environments SET provider='local-metadata' WHERE kind='local';
        CREATE TABLE operation_records(
          operation_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES session_bindings,
          binding_id TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL, request_json TEXT NOT NULL,
          request_sha256 TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','running','completed','failed','unknown','cancelled','released')),
          channel_id TEXT, helper_session_id TEXT, remote_process_id TEXT, remote_pid INTEGER,
          result_json TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          FOREIGN KEY(binding_id,version) REFERENCES project_bindings(binding_id,version));
        CREATE INDEX operation_owner ON operation_records(principal_id,session_id,created_at);
        CREATE TRIGGER operation_identity_immutable BEFORE UPDATE OF operation_id,principal_id,session_id,binding_id,version,kind,request_json,request_sha256 ON operation_records BEGIN SELECT RAISE(ABORT,'immutable operation identity'); END;
        PRAGMA user_version=2;`);
      this.db.prepare('INSERT INTO schema_migrations VALUES(2,?)').run(now());
    });
    if(version < 3) this.transaction(()=>{
      this.db.exec(`CREATE TABLE file_read_versions(
        session_id TEXT NOT NULL REFERENCES session_bindings, path TEXT NOT NULL,
        mtime_ms TEXT NOT NULL, strong_version TEXT,
        PRIMARY KEY(session_id,path,mtime_ms)); PRAGMA user_version=3;`);
      this.db.prepare('INSERT INTO schema_migrations VALUES(3,?)').run(now());
    });
    if(version < 4) this.transaction(()=>{
      this.db.exec(`ALTER TABLE operation_records ADD COLUMN execution_kind TEXT;
        ALTER TABLE operation_records ADD COLUMN local_runtime_id TEXT;
        ALTER TABLE operation_records ADD COLUMN local_process_id TEXT;
        ALTER TABLE operation_records ADD COLUMN local_pid INTEGER;
        ALTER TABLE operation_records ADD COLUMN local_start_ticks TEXT;
        CREATE TRIGGER local_identity_immutable BEFORE UPDATE OF execution_kind,local_runtime_id,local_process_id,local_pid,local_start_ticks ON operation_records
        WHEN OLD.local_process_id IS NOT NULL AND (NEW.execution_kind IS NOT OLD.execution_kind OR NEW.local_runtime_id IS NOT OLD.local_runtime_id OR NEW.local_process_id IS NOT OLD.local_process_id OR NEW.local_pid IS NOT OLD.local_pid OR NEW.local_start_ticks IS NOT OLD.local_start_ticks)
        BEGIN SELECT RAISE(ABORT,'immutable local process identity'); END;
        CREATE TRIGGER local_not_remote BEFORE UPDATE ON operation_records WHEN NEW.execution_kind='local' AND (NEW.channel_id IS NOT NULL OR NEW.helper_session_id IS NOT NULL OR NEW.remote_process_id IS NOT NULL OR NEW.remote_pid IS NOT NULL)
        BEGIN SELECT RAISE(ABORT,'local identity cannot carry remote fields'); END;
        PRAGMA user_version=4;`);
      this.db.prepare('INSERT INTO schema_migrations VALUES(4,?)').run(now());
    });
    if(version < 5) this.transaction(()=>{
      this.db.exec(MODEL_SCHEMA);
      this.db.prepare('INSERT INTO schema_migrations VALUES(5,?)').run(now());
      this.db.exec('PRAGMA user_version=5');
    });
    if(version < 6) this.transaction(()=>{
      this.db.exec(ACP_SCHEMA);
      this.db.prepare('INSERT INTO schema_migrations VALUES(6,?)').run(now());
      this.db.exec('PRAGMA user_version=6');
    });
    if(version < 7) this.transaction(()=>{
      this.db.exec(ENVIRONMENT_SCHEMA);
      this.db.prepare('INSERT INTO schema_migrations VALUES(7,?)').run(now());
      this.db.exec('PRAGMA user_version=7');
    });
    if(version < 8) this.transaction(()=>{
      this.db.exec(RECOVERY_SCHEMA);
      this.db.prepare('INSERT INTO schema_migrations VALUES(8,?)').run(now());
      this.db.exec('PRAGMA user_version=8');
    });
    this.db.prepare('INSERT OR IGNORE INTO deployment VALUES(?,?)').run('principal_id', id('owner'));
    this.principal = this.db.prepare('SELECT value FROM deployment WHERE key=?').get('principal_id').value;
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  audit(principal, action, resource, outcome, details = {}) {
    this.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)').run(id('audit'), principal, action, resource, outcome, JSON.stringify(details), now());
  }
  get(table, key, value, principal) {
    requireThat(['projects','environments','session_bindings'].includes(table), 'invalid-table');
    requireThat(['project_id','environment_id','session_id'].includes(key), 'invalid-key');
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE ${key}=? AND principal_id=?`).get(value, principal);
    requireThat(row, 'not-found');
    return plain(row);
  }
  list(table, principal) {
    requireThat(['projects','environments','session_bindings','project_bindings'].includes(table), 'invalid-table');
    return this.db.prepare(`SELECT * FROM ${table} WHERE principal_id=? ORDER BY created_at,rowid`).all(principal).map(plain);
  }
  project(principal, input) {
    fields(input, ['name','source_kind'], ['name']);
    const row = { project_id: id('project'), principal_id: principal, name: text(input.name, 'name'), source_kind: input.source_kind ?? 'empty', created_at: now() };
    requireThat(['empty','registered'].includes(row.source_kind), 'invalid-source-kind');
    this.transaction(() => {
      this.db.prepare('INSERT INTO projects VALUES(?,?,?,?,?)').run(...Object.values(row));
      this.audit(principal, 'project.create', row.project_id, 'ready');
    });
    return row;
  }
  environment(principal, spec) {
    const existing = this.db.prepare('SELECT * FROM environments WHERE principal_id=? AND catalog_key=?').get(principal, spec.key);
    if (existing) return plain(existing);
    const row = {
      environment_id: id('environment'), principal_id: principal, catalog_key: spec.key, kind: spec.kind, name: spec.name,
      lifecycle_state: spec.kind === 'local' ? 'running' : 'unknown', connection_state: spec.provider==='local-managed' && spec.kind==='local' ? 'local-authorized' : spec.kind === 'local' ? 'metadata-only' : 'unverified',
      capabilities_json: JSON.stringify(spec.provider === 'coder-helper' || spec.provider==='local-managed' && spec.kind==='local' ? ['metadata.read','fs.read','fs.write','command.exec','pty.open'] : spec.kind === 'local' ? ['metadata.read'] : []), policy_version: spec.policy_version,
      instance_generation: spec.generation, credential_ref: spec.credential_ref ?? null, created_at: now(),
      provider: spec.provider ?? (spec.kind === 'local' ? 'local-metadata' : 'unavailable'),
    };
    this.transaction(() => {
      this.db.prepare('INSERT INTO environments VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(row));
      this.db.prepare('INSERT INTO instance_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        id('instance'), row.environment_id, principal, spec.workspace_id, spec.agent_id, spec.generation,
        spec.kind === 'local' ? spec.generation : null, spec.template_version, JSON.stringify(spec.roots),
        spec.policy_version, 'preview-operator-catalog', spec.provider==='local-managed' && spec.kind==='local' ? 'local-authorized' : spec.kind === 'local' ? 'local-metadata' : 'unverified', now());
      this.audit(principal, 'environment.register', row.environment_id, row.connection_state);
    });
    return row;
  }
  binding(principal, bindingId, version) {
    const row = this.db.prepare('SELECT * FROM project_bindings WHERE binding_id=? AND version=? AND principal_id=?').get(bindingId, version, principal);
    requireThat(row, 'not-found');
    return plain(row);
  }
  newBinding(principal, input, anchors) {
    fields(input, ['project_id','environment_id','binding_id','expected_version','root_index'], ['project_id','environment_id']);
    return this.transaction(() => {
      this.get('projects','project_id',text(input.project_id,'project_id'), principal);
      const environment = this.get('environments','environment_id',text(input.environment_id,'environment_id'), principal);
      const record = this.db.prepare('SELECT * FROM instance_records WHERE environment_id=? AND principal_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(input.environment_id, principal);
      const roots = JSON.parse(record.allowed_roots_json), index = input.root_index ?? 0;
      requireThat(Number.isInteger(index) && index >= 0 && index < roots.length, 'invalid-root');
      let version = 1, bindingId = id('binding');
      if (input.binding_id !== undefined) {
        const old = this.db.prepare('SELECT * FROM project_bindings WHERE binding_id=? AND principal_id=? ORDER BY version DESC LIMIT 1').get(text(input.binding_id,'binding_id'), principal);
        requireThat(old, 'not-found');
        requireThat(old.version === input.expected_version, 'version-conflict');
        requireThat(old.project_id === input.project_id && old.environment_id === input.environment_id, 'new-binding-required');
        bindingId = old.binding_id; version = old.version + 1;
        this.db.prepare("UPDATE project_bindings SET state='superseded' WHERE binding_id=? AND state IN ('ready','pending')").run(bindingId);
      } else requireThat(input.expected_version === undefined, 'invalid-version');
      const row = {
        binding_id: bindingId, version, principal_id: principal, project_id: input.project_id, environment_id: input.environment_id,
        record_id: record.record_id, target_root: environment.provider === 'coder-helper' ? join(roots[index],`agent-studio-${bindingId}-v${version}`) : roots[index], policy_version: record.policy_version,
        instance_generation: record.instance_generation, verified_generation: record.verified_generation,
        anchor_path: join(anchors, `${bindingId}-v${version}`), anchor_dev: null, anchor_ino: null, workspace_id: null,
        state: 'pending', error_code: null, created_at: now(), ready_at: null,
      };
      this.db.prepare(`INSERT INTO project_bindings VALUES(${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
      this.audit(principal,'binding.create',`${bindingId}@${version}`,'pending');
      return row;
    });
  }
  newSession(principal, binding, title) {
    const row = { session_id: id('session'), principal_id: principal, binding_id: binding.binding_id, version: binding.version, title,
      state: 'pending', error_code: null, created_at: now(), ready_at: null };
    this.transaction(() => {
      const current = this.binding(principal, binding.binding_id, binding.version);
      requireThat(current.state === 'ready', 'binding-not-ready');
      this.db.prepare('INSERT INTO session_bindings VALUES(?,?,?,?,?,?,?,?,?)').run(...Object.values(row));
      this.audit(principal,'session.create',row.session_id,'pending');
    });
    return row;
  }
  operation(principal, operationId) {
    const row = this.db.prepare('SELECT * FROM operation_records WHERE operation_id=? AND principal_id=?').get(text(operationId,'operation_id'),principal);
    requireThat(row,'operation-not-found'); return plain(row);
  }
  operations(principal, sessionId) {
    return this.db.prepare('SELECT * FROM operation_records WHERE principal_id=? AND session_id=? ORDER BY created_at,rowid').all(principal,sessionId).map(plain);
  }
  beginOperation(principal, session, kind, request) {
    const operationId = text(request.operation_id,'operation_id',128);
    requireThat(/^[A-Za-z0-9_-]{8,128}$/.test(operationId),'invalid-operation-id');
    requireThat(!this.db.prepare('SELECT 1 FROM operation_records WHERE operation_id=?').get(operationId),'operation-exists','Mutation replay is disabled; read the original operation');
    this.environmentGate?.(principal,session,kind,request);
    const modelCall=modelCallContext.getStore();
    if(modelCall) {
      requireThat(modelCall.session_id===session.session_id && modelCall.principal===principal,'tool-operation-owner-mismatch');
      requireThat(this.db.prepare("SELECT 1 FROM model_tool_calls WHERE session_id=? AND call_id=? AND state='running'").get(session.session_id,modelCall.call_id),'tool-operation-context-inactive');
    }
    const acp=acpOperationContext.getStore();
    if(acp) {
      requireThat(!modelCall && acp.principal===principal && acp.session_id===session.session_id,'acp-operation-owner-mismatch');
      const task=this.db.prepare("SELECT * FROM acp_tasks WHERE task_id=? AND principal_id=? AND state IN ('starting','running','stopping')").get(acp.task_id,principal);
      requireThat(task && task.session_id===session.session_id && task.binding_id===session.binding_id && task.version===session.version && task.run_id===acp.run_id && task.cli_instance_id===acp.cli_instance_id,'acp-operation-context-inactive');
      let cancellation=false;
      if(acp.control_id) {
        const control=this.db.prepare('SELECT * FROM acp_controls WHERE control_id=? AND cli_instance_id=?').get(acp.control_id,task.cli_instance_id);
        let frame;try {frame=JSON.parse(request.data);} catch(error) {throw new StudioError('acp-response-mismatch');}
        requireThat(control && JSON.stringify(frame.id)===control.rpc_request_id && JSON.stringify(frame.result)===control.response_json && control.delivery!=='stdio-written-unconfirmed','acp-response-mismatch');
        cancellation=control.kind==='approval'?frame.result?.outcome?.outcome==='cancelled':frame.result?.action==='cancel';
        requireThat(cancellation || task.state==='running' && Date.now()<control.deadline_ms && ['answered','rejected'].includes(control.state),'acp-response-expired');
      }
      let cancelNotification=false;
      if(kind==='task.input' && typeof request.data==='string' && !acp.control_id) {
        try {cancelNotification=JSON.parse(request.data).method==='session/cancel';} catch(error) {cancelNotification=false;}
      }
      const cleanup=['task.cancel','task.release'].includes(kind) || kind==='task.input' && request.eof===true || cancelNotification || cancellation;
      requireThat(cleanup || Date.now()<task.deadline_ms && !acp.signal?.aborted && task.state!=='stopping','acp-task-deadline');
    }
    const serialized=JSON.stringify(request), timestamp=now();
    this.db.prepare('INSERT INTO operation_records(operation_id,principal_id,session_id,binding_id,version,kind,request_json,request_sha256,state,channel_id,helper_session_id,remote_process_id,remote_pid,result_json,error_code,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      operationId,principal,session.session_id,session.binding_id,session.version,kind,serialized,
      createHash('sha256').update(serialized).digest('hex'),'pending',null,null,null,null,null,null,timestamp,timestamp);
    if(modelCall) this.db.prepare('INSERT INTO model_tool_operations VALUES(?,?,?)').run(session.session_id,modelCall.call_id,operationId);
    if(acp) this.db.prepare('INSERT INTO acp_task_operations VALUES(?,?)').run(acp.task_id,operationId);
    return this.operation(principal,operationId);
  }
  updateOperation(principal, operationId, updates) {
    fields(updates,['state','channel_id','helper_session_id','remote_process_id','remote_pid','result_json','error_code','execution_kind','local_runtime_id','local_process_id','local_pid','local_start_ticks']);
    const entries=Object.entries(updates);
    this.db.prepare(`UPDATE operation_records SET ${entries.map(([key])=>`${key}=?`).join(',')},updated_at=? WHERE operation_id=? AND principal_id=?`).run(...entries.map(([,value])=>value),now(),operationId,principal);
    return this.operation(principal,operationId);
  }
  markInterrupted() {
    this.db.prepare("UPDATE operation_records SET state='unknown',error_code='preview-restarted',updated_at=? WHERE state IN ('pending','running')").run(now());
  }
  failBinding(row, code) {
    this.transaction(() => {
      this.db.prepare("UPDATE project_bindings SET state='invalid',error_code=? WHERE binding_id=? AND version=? AND state IN ('ready','pending')").run(code, row.binding_id, row.version);
      this.audit(row.principal_id,'binding.invalidate',`${row.binding_id}@${row.version}`,'denied',{ code });
    });
  }
  failSession(row, code) {
    this.transaction(() => {
      this.db.prepare("UPDATE session_bindings SET state='failed',error_code=? WHERE session_id=?").run(code, row.session_id);
      this.audit(row.principal_id,'session.reconcile',row.session_id,'failed',{ code });
    });
  }
}
