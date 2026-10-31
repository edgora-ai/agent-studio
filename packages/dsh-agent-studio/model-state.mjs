import {createHash,randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
export const modelCallContext=new AsyncLocalStorage();
import {fields,requireThat,now} from './store.mjs';

export const MODEL_POLICIES=Object.freeze(['d05-model-local-v1','d05-model-helper-v1']);
export const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export const MODEL_SCHEMA=`
CREATE TABLE model_configurations(revision INTEGER PRIMARY KEY, principal_id TEXT NOT NULL, settings_revision INTEGER NOT NULL,
 config_json TEXT NOT NULL, config_sha256 TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','active','failed')), created_at TEXT NOT NULL);
CREATE TABLE model_selections(session_id TEXT PRIMARY KEY REFERENCES session_bindings, principal_id TEXT NOT NULL,
 provider TEXT NOT NULL, model TEXT NOT NULL, revision INTEGER NOT NULL REFERENCES model_configurations, updated_at TEXT NOT NULL);
CREATE TABLE model_requests(request_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES session_bindings,
 binding_id TEXT NOT NULL, version INTEGER NOT NULL, revision INTEGER NOT NULL REFERENCES model_configurations, provider TEXT NOT NULL, model TEXT NOT NULL,
 content_sha256 TEXT NOT NULL, run_id TEXT NOT NULL, state TEXT NOT NULL, turn INTEGER, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 FOREIGN KEY(binding_id,version) REFERENCES project_bindings(binding_id,version));
CREATE INDEX model_request_owner ON model_requests(principal_id,session_id,created_at);
CREATE TABLE model_tool_calls(call_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES session_bindings, request_id TEXT NOT NULL REFERENCES model_requests,
 name TEXT NOT NULL, arguments_sha256 TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(session_id,call_id));
CREATE TABLE model_tool_operations(session_id TEXT NOT NULL, call_id TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
 FOREIGN KEY(session_id,call_id) REFERENCES model_tool_calls(session_id,call_id));
CREATE TABLE model_controls(control_id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, principal_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES session_bindings,
 binding_id TEXT NOT NULL, version INTEGER NOT NULL, request_id TEXT NOT NULL REFERENCES model_requests, call_id TEXT NOT NULL, kind TEXT NOT NULL,
 run_id TEXT NOT NULL, deadline_ms INTEGER NOT NULL, payload_json TEXT NOT NULL, state TEXT NOT NULL, answer_json TEXT, delivery TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 FOREIGN KEY(binding_id,version) REFERENCES project_bindings(binding_id,version));
CREATE INDEX model_control_owner ON model_controls(principal_id,session_id,created_at);
CREATE TRIGGER model_request_identity BEFORE UPDATE OF request_id,principal_id,session_id,binding_id,version,revision,provider,model,content_sha256,run_id ON model_requests BEGIN SELECT RAISE(ABORT,'immutable model request'); END;
CREATE TRIGGER model_control_identity BEFORE UPDATE OF control_id,event_id,principal_id,session_id,binding_id,version,request_id,call_id,kind,run_id,deadline_ms,payload_json ON model_controls BEGIN SELECT RAISE(ABORT,'immutable control request'); END;
CREATE TRIGGER model_control_once BEFORE UPDATE OF state ON model_controls WHEN OLD.state!='pending' AND NEW.state!=OLD.state BEGIN SELECT RAISE(ABORT,'control already settled'); END;
`;

// D05 and ACP share the same authority/deadline/one-shot control state machine.
// Separate FK targets avoid inventing a model request for an external CLI task.
export class ControlState {
  constructor(store,runId,table='model_controls') {
    requireThat(['model_controls','acp_controls'].includes(table),'invalid-control-table');
    this.store=store;this.db=store.db;this.runId=runId;this.controlTable=table;
  }
  controls(principal,sessionId) {return this.db.prepare(`SELECT * FROM ${this.controlTable} WHERE principal_id=? AND session_id=? ORDER BY created_at,rowid`).all(principal,sessionId);}
  control(principal,id) {
    const row=this.db.prepare(`SELECT * FROM ${this.controlTable} WHERE control_id=? AND principal_id=?`).get(id,principal);
    requireThat(row,'control-not-found');return row;
  }
  openControl({eventId,session,binding,request,callId,kind,payload,deadline,extra={}}) {
    const id='control-'+randomUUID(),stamp=now();
    const columns=['control_id','event_id','principal_id','session_id','binding_id','version','request_id','call_id','kind','run_id','deadline_ms','payload_json','state','answer_json','delivery','created_at','updated_at'];
    const values=[id,eventId,session.principal_id,session.session_id,binding.binding_id,binding.version,request.request_id,callId,kind,this.runId,deadline,JSON.stringify(payload),'pending',null,'waiting',stamp,stamp];
    const allowed=this.controlTable==='acp_controls'?['cli_session_id','cli_instance_id','rpc_request_id']:[];
    fields(extra,allowed,allowed);
    for(const key of allowed) {columns.push(key);values.push(extra[key]);}
    this.db.prepare(`INSERT INTO ${this.controlTable}(${columns.join(',')}) VALUES(${values.map(()=>'?').join(',')})`).run(...values);
    return this.control(session.principal_id,id);
  }
  validateAnswer(row,answer) {
    if(row.kind==='approval') requireThat(['allowed-once','rejected'].includes(answer),'invalid-approval-answer');
    else {
      fields(answer,['answers'],['answers']);const questions=JSON.parse(row.payload_json).questions;
      requireThat(Array.isArray(answer.answers) && answer.answers.length===questions.length,'invalid-question-answer');
      const seen=new Set();
      for(const item of answer.answers) {
        fields(item,['id','selected','custom'],['id','selected']);
        const question=questions.find(q=>q.id===item.id);
        requireThat(question && !seen.has(item.id) && Array.isArray(item.selected) && item.selected.length<=32 && item.selected.every(v=>typeof v==='string' && question.options?.some(o=>o.label===v)) && new Set(item.selected).size===item.selected.length,'invalid-question-answer');
        requireThat(question.multiSelect || item.selected.length<=1,'invalid-question-answer');
        requireThat(item.custom===undefined || typeof item.custom==='string' && item.custom.length<=8192,'invalid-question-answer');seen.add(item.id);
      }
    }
  }
  decide(principal,input,answer) {
    fields(input,['control_id','session_id','binding_id','version'],['control_id','session_id','binding_id','version']);
    return this.store.transaction(()=>{
      const row=this.control(principal,input.control_id);
      requireThat(row.session_id===input.session_id && row.binding_id===input.binding_id && row.version===input.version,'control-binding-mismatch');
      requireThat(row.run_id===this.runId && row.state==='pending','control-not-pending');
      requireThat(Date.now()<row.deadline_ms,'control-expired');
      const request=this.request(principal,row.request_id);
      requireThat(request.state==='running','control-turn-inactive');
      requireThat(request.session_id===row.session_id && request.binding_id===row.binding_id && request.version===row.version && request.run_id===row.run_id,'control-instance-mismatch');
      this.validateAnswer(row,answer);
      const result=this.db.prepare(`UPDATE ${this.controlTable} SET state=?,answer_json=?,delivery='accepted',updated_at=? WHERE control_id=? AND state='pending'`).run(row.kind==='approval' && answer==='rejected'?'rejected':'answered',JSON.stringify(answer),now(),row.control_id);
      requireThat(result.changes===1,'control-not-pending');return this.control(principal,row.control_id);
    });
  }
  endControl(id,state,delivery) {this.db.prepare(`UPDATE ${this.controlTable} SET state=?,delivery=?,updated_at=? WHERE control_id=? AND state='pending'`).run(state,delivery,now(),id);}
  delivered(id,delivery) {this.db.prepare(`UPDATE ${this.controlTable} SET delivery=?,updated_at=? WHERE control_id=?`).run(delivery,now(),id);}
}

export class ModelState extends ControlState {
  restart() {
    const stamp=now();
    this.db.prepare("UPDATE model_requests SET state='interrupted',error_code='preview-restarted',updated_at=? WHERE state IN ('admitting','queued','running')").run(stamp);
    this.db.prepare("UPDATE model_controls SET state='cancelled',delivery='restart-invalidated',updated_at=? WHERE state='pending'").run(stamp);
    this.db.prepare("UPDATE model_tool_calls SET state='interrupted',updated_at=? WHERE state IN ('pending','running')").run(stamp);
    this.db.prepare("UPDATE model_configurations SET state='failed' WHERE state='pending'").run();
  }
  current() {return this.db.prepare("SELECT * FROM model_configurations WHERE state='active' ORDER BY revision DESC LIMIT 1").get();}
  configs() {return this.db.prepare('SELECT * FROM model_configurations ORDER BY revision').all();}
  request(principal,id) {
    const row=this.db.prepare('SELECT * FROM model_requests WHERE request_id=? AND principal_id=?').get(id,principal);
    requireThat(row,'model-request-not-found');return row;
  }
  requests(principal,sessionId) {return this.db.prepare('SELECT * FROM model_requests WHERE principal_id=? AND session_id=? ORDER BY created_at,rowid').all(principal,sessionId);}
  transition(requestId,state,error=null) {this.db.prepare('UPDATE model_requests SET state=?,error_code=?,updated_at=? WHERE request_id=?').run(state,error,now(),requestId);}
}
