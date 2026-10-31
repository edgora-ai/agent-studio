import {createHash,randomUUID} from 'node:crypto';
import {requireThat,now,fields} from './store.mjs';

export const RECOVERY_SCHEMA=`
CREATE TABLE task_recovery_snapshots(
 operation_id TEXT PRIMARY KEY REFERENCES operation_records, principal_id TEXT NOT NULL,
 session_id TEXT NOT NULL, binding_id TEXT NOT NULL, version INTEGER NOT NULL,
 host_run_id TEXT NOT NULL, execution_kind TEXT NOT NULL, identity_json TEXT NOT NULL,
 identity_sha256 TEXT NOT NULL, token_ref TEXT, complete INTEGER NOT NULL,
 incomplete_reason TEXT, task_deadline_ms INTEGER NOT NULL, retention_ms INTEGER NOT NULL,
 recovery_window_ms INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE task_recovery_state(
 operation_id TEXT PRIMARY KEY REFERENCES task_recovery_snapshots, state TEXT NOT NULL,
 first_lost_at_ms INTEGER, recovery_deadline_ms INTEGER, loss_revision INTEGER NOT NULL DEFAULT 0,
 last_error TEXT, current_transport_id TEXT, current_recovery_id TEXT,
 output_cursor TEXT NOT NULL DEFAULT '0', earliest_seq TEXT, output_gap INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL);
CREATE TABLE task_recovery_requests(
 recovery_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES task_recovery_snapshots,
 principal_id TEXT NOT NULL, request_sha256 TEXT NOT NULL, loss_revision INTEGER NOT NULL,
 state TEXT NOT NULL, transport_id TEXT, error_code TEXT, result_json TEXT,
 created_at TEXT NOT NULL, completed_at TEXT);
CREATE UNIQUE INDEX task_recovery_once ON task_recovery_requests(operation_id) WHERE state='verifying';
CREATE TABLE task_recovery_events(
 event_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES task_recovery_snapshots,
 kind TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX task_recovery_owner ON task_recovery_snapshots(principal_id,session_id,created_at);
CREATE TRIGGER task_recovery_snapshot_immutable BEFORE UPDATE ON task_recovery_snapshots BEGIN SELECT RAISE(ABORT,'immutable task startup identity'); END;
CREATE TRIGGER task_recovery_event_immutable BEFORE UPDATE ON task_recovery_events BEGIN SELECT RAISE(ABORT,'append only recovery event'); END;
CREATE TRIGGER task_recovery_fixed_window BEFORE UPDATE ON task_recovery_state
WHEN OLD.first_lost_at_ms IS NOT NULL AND (NEW.first_lost_at_ms IS NOT OLD.first_lost_at_ms OR NEW.recovery_deadline_ms IS NOT OLD.recovery_deadline_ms)
BEGIN SELECT RAISE(ABORT,'first loss deadline is fixed'); END;
CREATE TRIGGER remote_launch_identity_immutable BEFORE UPDATE OF channel_id,helper_session_id,remote_process_id,remote_pid ON operation_records
WHEN OLD.remote_process_id IS NOT NULL AND OLD.remote_pid IS NOT NULL AND
(NEW.channel_id IS NOT OLD.channel_id OR NEW.helper_session_id IS NOT OLD.helper_session_id OR NEW.remote_process_id IS NOT OLD.remote_process_id OR NEW.remote_pid IS NOT OLD.remote_pid)
BEGIN SELECT RAISE(ABORT,'immutable remote startup identity'); END;
`;
export const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const plain=row=>row?{...row}:null;
export class RecoveryState {
 constructor(store,runId,{clock=Date.now,windowMs=30000}={}) {requireThat(Number.isSafeInteger(windowMs)&&windowMs>=1000&&windowMs<=120000,'recovery-window-policy');this.store=store;this.db=store.db;this.runId=runId;this.clock=clock;this.windowMs=windowMs;}
 row(operationId) {return plain(this.db.prepare('SELECT * FROM task_recovery_state WHERE operation_id=?').get(operationId));}
 snapshot(operationId) {return plain(this.db.prepare('SELECT * FROM task_recovery_snapshots WHERE operation_id=?').get(operationId));}
 event(operationId,kind,details={}) {this.db.prepare('INSERT INTO task_recovery_events VALUES(?,?,?,?,?)').run(randomUUID(),operationId,kind,JSON.stringify(details),now());}
 capture(operation,{identity,tokenRef=null,complete,reason=null,deadline,retention=30000}) {
  requireThat(!this.snapshot(operation.operation_id),'recovery-snapshot-exists');
  const serialized=JSON.stringify(identity);
  this.store.transaction(()=>{
   this.db.prepare('INSERT INTO task_recovery_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(operation.operation_id,operation.principal_id,operation.session_id,operation.binding_id,operation.version,this.runId,identity.execution_kind,serialized,hash(serialized),tokenRef,complete?1:0,reason,deadline,retention,Math.min(this.windowMs,retention),now());
   this.db.prepare('INSERT INTO task_recovery_state(operation_id,state,current_transport_id,last_error,updated_at) VALUES(?,?,?,?,?)').run(operation.operation_id,complete?'live':'unavailable',identity.channel_id??identity.runtime_id,reason,now());
   this.event(operation.operation_id,'startup-snapshot',{complete:!!complete,reason,identity_sha256:hash(serialized)});
  });return this.snapshot(operation.operation_id);
 }
 lose(operationId,reason) {
  const snapshot=this.snapshot(operationId),state=this.row(operationId);if(!snapshot || !state || ['revoked','released','unavailable'].includes(state.state)) return;
  const first=state.first_lost_at_ms??this.clock(),deadline=state.recovery_deadline_ms??Math.min(first+snapshot.recovery_window_ms,snapshot.task_deadline_ms);
  if(state.state==='lost') return;
  this.db.prepare("UPDATE task_recovery_state SET state='lost',first_lost_at_ms=?,recovery_deadline_ms=?,loss_revision=loss_revision+1,last_error=?,updated_at=? WHERE operation_id=?").run(first,deadline,reason,now(),operationId);
  this.event(operationId,'transport-lost',{reason,first_lost_at_ms:first,recovery_deadline_ms:deadline,original_channel:JSON.parse(snapshot.identity_json).channel_id??null,current_transport:state.current_transport_id});
 }
 revoke(binding,reason) {
  for(const row of this.db.prepare('SELECT operation_id FROM task_recovery_snapshots WHERE binding_id=? AND version=?').all(binding.binding_id,binding.version)) {
   this.db.prepare("UPDATE task_recovery_state SET state='revoked',loss_revision=loss_revision+1,last_error=?,updated_at=? WHERE operation_id=? AND state!='released'").run(reason,now(),row.operation_id);this.event(row.operation_id,'revoked',{reason});
  }
 }
 owned(principal,input) {
  const operation=this.store.operation(principal,input.operation_id);
  requireThat(operation.session_id===input.session_id && ['command.exec','pty.open'].includes(operation.kind),'task-not-owned');
  const snapshot=this.snapshot(operation.operation_id);requireThat(snapshot,'recovery-identity-incomplete');
  requireThat(snapshot.principal_id===principal && snapshot.session_id===input.session_id && snapshot.binding_id===operation.binding_id && snapshot.version===operation.version,'recovery-identity-mismatch');
  const identity=JSON.parse(snapshot.identity_json);
  requireThat(hash(snapshot.identity_json)===snapshot.identity_sha256&&identity.operation_id===operation.operation_id&&identity.request_sha256===operation.request_sha256&&identity.principal_id===principal&&identity.session_id===operation.session_id&&identity.binding_id===operation.binding_id&&identity.version===operation.version,'recovery-identity-mismatch');
  requireThat(identity.execution_kind==='local'?identity.runtime_id===operation.local_runtime_id&&identity.process_id===operation.local_process_id&&identity.pid===operation.local_pid:identity.channel_id===operation.channel_id&&identity.helper_session_id===operation.helper_session_id&&identity.process_id===operation.remote_process_id&&identity.pid===operation.remote_pid,'recovery-identity-mismatch');
  return {operation,snapshot,state:this.row(operation.operation_id),identity};
 }
 eligible(value) {
  requireThat(value.snapshot.complete===1,'recovery-identity-incomplete');
  requireThat(value.snapshot.host_run_id===this.runId,'recovery-host-handle-unavailable');
  requireThat(value.state.state==='lost','recovery-not-lost');
  requireThat(this.clock()<value.state.recovery_deadline_ms && this.clock()<value.snapshot.task_deadline_ms,'recovery-window-expired');
  requireThat(value.operation.state==='unknown','recovery-original-state-changed');
 }
 begin(principal,input) {
  fields(input,['session_id','operation_id','recovery_id'],['session_id','operation_id','recovery_id']);
  requireThat(typeof input.recovery_id==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(input.recovery_id),'invalid-recovery-id');
  const value=this.owned(principal,input);this.eligible(value);
  requireThat(!this.db.prepare('SELECT 1 FROM task_recovery_requests WHERE recovery_id=?').get(input.recovery_id),'recovery-request-exists');
  requireThat(!this.db.prepare("SELECT 1 FROM task_recovery_requests WHERE operation_id=? AND state='verifying'").get(input.operation_id),'recovery-in-progress');
  this.db.prepare('INSERT INTO task_recovery_requests VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(input.recovery_id,input.operation_id,principal,hash(input),value.state.loss_revision,'verifying',null,null,null,now(),null);
  this.event(input.operation_id,'recovery-requested',{recovery_id:input.recovery_id,loss_revision:value.state.loss_revision});return value;
 }
 assertCurrent(principal,input,expected) {
  const current=this.owned(principal,input);this.eligible(current);
  requireThat(current.state.loss_revision===expected.state.loss_revision && current.snapshot.identity_sha256===expected.snapshot.identity_sha256,'recovery-superseded');return current;
 }
 commit(principal,input,expected,transportId,status) {
  this.store.transaction(()=>{
   this.assertCurrent(principal,input,expected);
   requireThat(this.db.prepare("UPDATE task_recovery_requests SET state='verified',transport_id=?,result_json=?,completed_at=? WHERE recovery_id=? AND state='verifying'").run(transportId,JSON.stringify(status),now(),input.recovery_id).changes===1,'recovery-request-consumed');
   this.db.prepare("UPDATE task_recovery_state SET state='recovered',current_transport_id=?,current_recovery_id=?,updated_at=? WHERE operation_id=?").run(transportId,input.recovery_id,now(),input.operation_id);
   // Only this explicit verified transaction can publish state after uncertainty.
   // Original channel, start result and loss reason are deliberately untouched.
   this.db.prepare('UPDATE operation_records SET state=?,updated_at=? WHERE operation_id=? AND principal_id=?').run(status.running?'running':'completed',now(),input.operation_id,principal);
   this.event(input.operation_id,'recovered',{recovery_id:input.recovery_id,transport_id:transportId,status,loss_revision:expected.state.loss_revision,dispatch_replay:false});
  });
 }
 fail(input,code) {this.db.prepare("UPDATE task_recovery_requests SET state='failed',error_code=?,completed_at=? WHERE recovery_id=? AND state='verifying'").run(code,now(),input.recovery_id);this.event(input.operation_id,'recovery-refused',{recovery_id:input.recovery_id,code});}
 cursor(operationId,page) {
  const row=this.row(operationId);if(!row) return;
  requireThat(/^\d{1,20}$/.test(page.nextSeq),'invalid-output-cursor');
  const next=BigInt(page.nextSeq)>BigInt(row.output_cursor)?page.nextSeq:row.output_cursor;
  this.db.prepare('UPDATE task_recovery_state SET output_cursor=?,earliest_seq=?,output_gap=?,updated_at=? WHERE operation_id=?').run(next,page.earliestSeq??row.earliest_seq,page.truncated?1:row.output_gap,now(),operationId);
  if(page.truncated) this.event(operationId,'output-gap',{after:row.output_cursor,earliest_seq:page.earliestSeq??null,next_seq:page.nextSeq});
 }
 get(principal,input) {
  const operation=this.store.operation(principal,input.operation_id);requireThat(operation.session_id===input.session_id,'task-not-owned');
  const snapshot=this.snapshot(operation.operation_id),state=this.row(operation.operation_id);
  let eligible=false,reason='recovery-identity-incomplete';
  if(snapshot) {try {this.eligible(this.owned(principal,input));eligible=true;reason=null;}catch(error){reason=error.code;}}
  return {operation,snapshot,state,eligible,reason,requests:this.db.prepare('SELECT * FROM task_recovery_requests WHERE operation_id=? ORDER BY created_at,rowid').all(operation.operation_id).map(plain),events:this.db.prepare('SELECT * FROM task_recovery_events WHERE operation_id=? ORDER BY created_at,rowid').all(operation.operation_id).map(plain)};
 }
}
