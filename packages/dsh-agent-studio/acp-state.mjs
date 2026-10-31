import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {ControlState,sha} from './model-state.mjs';
import {fields,requireThat,now} from './store.mjs';
import {controlResponse} from './acp-protocol.mjs';

export const acpOperationContext=new AsyncLocalStorage();
export const ACP_POLICIES=Object.freeze(['d06-acp-local-v1','d06-acp-helper-v1']);
export const ACP_SCHEMA=`
CREATE TABLE acp_tasks(task_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, principal_id TEXT NOT NULL,
 session_id TEXT NOT NULL REFERENCES session_bindings, binding_id TEXT NOT NULL, version INTEGER NOT NULL,
 backend_id TEXT NOT NULL, backend_sha256 TEXT NOT NULL, backend_version TEXT NOT NULL, protocol TEXT NOT NULL,
 policy_version TEXT NOT NULL, run_id TEXT NOT NULL, cli_instance_id TEXT NOT NULL UNIQUE, prompt_json TEXT NOT NULL,
 prompt_sha256 TEXT NOT NULL, deadline_ms INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('starting','running','stopping','completed','refused','cancelled','failed','unknown','interrupted')),
 operation_id TEXT UNIQUE REFERENCES operation_records, cli_session_id TEXT, identity_json TEXT, negotiated_json TEXT,
 result_json TEXT, exit_code INTEGER, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 FOREIGN KEY(binding_id,version) REFERENCES project_bindings(binding_id,version));
CREATE INDEX acp_task_owner ON acp_tasks(principal_id,session_id,created_at);
CREATE TABLE acp_events(task_id TEXT NOT NULL REFERENCES acp_tasks, seq INTEGER NOT NULL, kind TEXT NOT NULL,
 payload_json TEXT NOT NULL, byte_count INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(task_id,seq));
CREATE TABLE acp_task_operations(task_id TEXT NOT NULL REFERENCES acp_tasks, operation_id TEXT NOT NULL UNIQUE REFERENCES operation_records);
CREATE TABLE acp_controls(control_id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, principal_id TEXT NOT NULL,
 session_id TEXT NOT NULL REFERENCES session_bindings, binding_id TEXT NOT NULL, version INTEGER NOT NULL,
 request_id TEXT NOT NULL REFERENCES acp_tasks(request_id), call_id TEXT NOT NULL, kind TEXT NOT NULL,
 run_id TEXT NOT NULL, deadline_ms INTEGER NOT NULL, payload_json TEXT NOT NULL, state TEXT NOT NULL,
 answer_json TEXT, delivery TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 cli_session_id TEXT NOT NULL, cli_instance_id TEXT NOT NULL REFERENCES acp_tasks(cli_instance_id), rpc_request_id TEXT NOT NULL,
 response_json TEXT, FOREIGN KEY(binding_id,version) REFERENCES project_bindings(binding_id,version),
 UNIQUE(cli_instance_id,rpc_request_id), UNIQUE(cli_instance_id,kind,call_id));
CREATE INDEX acp_control_owner ON acp_controls(principal_id,session_id,created_at);
CREATE TRIGGER acp_task_identity BEFORE UPDATE OF task_id,request_id,principal_id,session_id,binding_id,version,backend_id,backend_sha256,backend_version,protocol,policy_version,run_id,cli_instance_id,prompt_json,prompt_sha256,deadline_ms ON acp_tasks BEGIN SELECT RAISE(ABORT,'immutable ACP task'); END;
CREATE TRIGGER acp_process_once BEFORE UPDATE OF operation_id,cli_session_id,identity_json ON acp_tasks
 WHEN (OLD.operation_id IS NOT NULL AND NEW.operation_id IS NOT OLD.operation_id) OR (OLD.cli_session_id IS NOT NULL AND NEW.cli_session_id IS NOT OLD.cli_session_id) OR (OLD.identity_json IS NOT NULL AND NEW.identity_json IS NOT OLD.identity_json)
 BEGIN SELECT RAISE(ABORT,'immutable ACP process/session'); END;
CREATE TRIGGER acp_control_identity BEFORE UPDATE OF control_id,event_id,principal_id,session_id,binding_id,version,request_id,call_id,kind,run_id,deadline_ms,payload_json,cli_session_id,cli_instance_id,rpc_request_id ON acp_controls BEGIN SELECT RAISE(ABORT,'immutable ACP control'); END;
CREATE TRIGGER acp_control_once BEFORE UPDATE OF state ON acp_controls WHEN OLD.state!='pending' AND NEW.state!=OLD.state BEGIN SELECT RAISE(ABORT,'control already settled'); END;
CREATE TRIGGER acp_response_once BEFORE UPDATE OF response_json ON acp_controls WHEN OLD.response_json IS NOT NULL AND NEW.response_json IS NOT OLD.response_json BEGIN SELECT RAISE(ABORT,'immutable ACP response'); END;
CREATE TRIGGER acp_event_immutable BEFORE UPDATE ON acp_events BEGIN SELECT RAISE(ABORT,'immutable ACP event'); END;
`;

export class AcpState extends ControlState {
  constructor(store,runId) {super(store,runId,'acp_controls');}
  restart() {
    const stamp=now();
    this.db.prepare("UPDATE acp_tasks SET state='interrupted',error_code='preview-restarted-no-replay',updated_at=? WHERE state IN ('starting','running','stopping')").run(stamp);
    this.db.prepare("UPDATE acp_controls SET state='cancelled',delivery='restart-invalidated',updated_at=? WHERE state='pending'").run(stamp);
    this.db.prepare("UPDATE acp_controls SET delivery='restart-delivery-unknown',updated_at=? WHERE delivery IN ('accepted','ui-delivered')").run(stamp);
  }
  task(principal,id) {
    const row=this.db.prepare('SELECT * FROM acp_tasks WHERE task_id=? AND principal_id=?').get(id,principal);
    requireThat(row,'acp-task-not-found');return row;
  }
  request(principal,id) {
    const row=this.db.prepare('SELECT * FROM acp_tasks WHERE request_id=? AND principal_id=?').get(id,principal);
    requireThat(row,'acp-task-not-found');return row;
  }
  tasks(principal,sessionId) {return this.db.prepare('SELECT * FROM acp_tasks WHERE principal_id=? AND session_id=? ORDER BY created_at,rowid').all(principal,sessionId);}
  create(session,binding,backend,input,deadline) {
    requireThat(!this.db.prepare("SELECT 1 FROM acp_tasks WHERE session_id=? AND state IN ('starting','running','stopping')").get(session.session_id),'acp-task-active');
    requireThat(!this.db.prepare('SELECT 1 FROM acp_tasks WHERE request_id=?').get(input.request_id),'acp-request-exists');
    const taskId='acp-'+randomUUID(),instanceId=randomUUID(),stamp=now(),prompt=JSON.stringify([{type:'text',text:input.prompt}]);
    this.db.prepare(`INSERT INTO acp_tasks(task_id,request_id,principal_id,session_id,binding_id,version,backend_id,backend_sha256,backend_version,protocol,policy_version,run_id,cli_instance_id,prompt_json,prompt_sha256,deadline_ms,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(taskId,input.request_id,session.principal_id,session.session_id,binding.binding_id,binding.version,backend.id,sha(backend),backend.version,backend.protocol,binding.policy_version,this.runId,instanceId,prompt,sha(prompt),deadline,'starting',stamp,stamp);
    return this.task(session.principal_id,taskId);
  }
  update(principal,id,values) {
    fields(values,['state','operation_id','cli_session_id','identity_json','negotiated_json','result_json','exit_code','error_code']);
    this.task(principal,id);const entries=Object.entries(values);requireThat(entries.length>0,'empty-acp-update');
    this.db.prepare(`UPDATE acp_tasks SET ${entries.map(([key])=>key+'=?').join(',')},updated_at=? WHERE task_id=? AND principal_id=?`).run(...entries.map(([,v])=>v),now(),id,principal);
    return this.task(principal,id);
  }
  append(principal,id,kind,payload) {
    this.task(principal,id);requireThat(typeof kind==='string' && kind.length<=64,'acp-event-kind-invalid');
    const encoded=JSON.stringify(payload),bytes=Buffer.byteLength(encoded);
    const previous=this.db.prepare('SELECT count(*) n,coalesce(sum(byte_count),0) bytes,coalesce(max(seq),0) seq FROM acp_events WHERE task_id=?').get(id);
    requireThat(bytes<=65536 && previous.n<1000 && previous.bytes+bytes<=1048576,'acp-output-limit');
    const row={task_id:id,seq:previous.seq+1,kind,payload_json:encoded,byte_count:bytes,created_at:now()};
    this.db.prepare('INSERT INTO acp_events VALUES(?,?,?,?,?,?)').run(...Object.values(row));return row;
  }
  events(principal,id) {this.task(principal,id);return this.db.prepare('SELECT * FROM acp_events WHERE task_id=? ORDER BY seq').all(id);}
  validateAnswer(row,answer) {
    super.validateAnswer(row,answer);
    const task=this.request(row.principal_id,row.request_id);
    requireThat(task.cli_instance_id===row.cli_instance_id && task.cli_session_id===row.cli_session_id && task.operation_id,'control-instance-mismatch');
    const response=controlResponse(row,answer);
    this.db.prepare('UPDATE acp_controls SET response_json=? WHERE control_id=?').run(JSON.stringify(response),row.control_id);
  }
}
