// Serialized into both betterSidebar clients by the hash-checked projection.
// Keep every helper inside this function: the browser receives AcpPanel.toString().
export function AcpPanel({scope,visible,React,routeUrl}) {
  const h=React.createElement,sessionId=scope.sessionId;
  const [data,setData]=React.useState(null),[backend,setBackend]=React.useState(''),[prompt,setPrompt]=React.useState(''),[selected,setSelected]=React.useState(''),[journal,setJournal]=React.useState(null),[error,setError]=React.useState(''),[busyState,setBusy]=React.useState(null);
  const owner=React.useRef({sessionId,visible:visible!==false,epoch:0,operation:0,selection:0});
  if(owner.current.sessionId!==sessionId || owner.current.visible!==(visible!==false)) {
    owner.current={sessionId,visible:visible!==false,epoch:owner.current.epoch+1,operation:owner.current.operation+1,selection:owner.current.selection+1};
  }
  const selectionGeneration=owner.current.selection;
  const selectedRef=React.useRef(selected);if(owner.current.sessionId===sessionId) selectedRef.current=selected;
  const busyRef=React.useRef(null);
  if(busyRef.current?.epoch!==owner.current.epoch || visible===false) busyRef.current=null;
  const busy=busyRef.current!==null && busyState?.epoch===owner.current.epoch && busyState.operation===busyRef.current.operation;
  const validId=value=>typeof value==='string'&&value.length>0;
  const taskShape=row=>row&&typeof row==='object'&&['task_id','request_id','principal_id','session_id','binding_id','backend_id','run_id','cli_instance_id'].every(key=>validId(row[key]))&&(row.cli_session_id==null||validId(row.cli_session_id))&&Number.isSafeInteger(row.version)&&row.version>0;
  const sameTask=(row,task)=>row&&task&&validId(row.cli_session_id)&&validId(task.cli_session_id)&&['principal_id','run_id','session_id','request_id','binding_id','cli_instance_id'].every(key=>validId(row[key])&&validId(task[key])&&row[key]===task[key])&&Number.isSafeInteger(row.version)&&row.version>0&&row.version===task.version&&row.cli_session_id===task.cli_session_id;
  const parse=(raw,label)=>{
    if(raw==null) return {value:null};
    try {return {value:JSON.parse(raw)};} catch {return {value:null,warning:'Malformed stored '+label+' JSON; original record cannot be decoded.'};}
  };
  const text=value=>typeof value==='string'?value:JSON.stringify(value)??String(value);
  const bounded=(value,limit=12000)=>{
    const content=text(value);
    return content.length>limit?content.slice(0,limit)+'\n[Display truncated: '+(content.length-limit)+' characters omitted from this field.]':content;
  };
  const stamp=value=>Number.isFinite(value)&&Number.isFinite(new Date(value).getTime())?new Date(value).toISOString():text(value??'not recorded');
  const field=(name,value)=>h('div',{key:name,style:{margin:'3px 0'}},h('strong',null,name+': '),bounded(value??'not recorded',2000));
  async function rpc(method,payload,signal) {
    const response=await fetch(routeUrl('agent-studio-rpc/'+method),{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload}),signal});
    if(!response.ok) throw new Error('HTTP '+response.status+'; no operation was retried');
    const envelope=await response.json();if(!envelope.result?.ok) throw new Error(envelope.result?.error?.code??'Invalid ACP response');return envelope.result.value;
  }
  React.useEffect(()=>{
    setData(null);setJournal(null);setSelected('');setBackend('');setError('');setPrompt('');setBusy(null);busyRef.current=null;
  },[sessionId]);
  React.useEffect(()=>()=>{owner.current.epoch++;owner.current.operation++;owner.current.selection++;busyRef.current=null;},[]);
  React.useEffect(()=>{
    if(visible===false || !sessionId) {setJournal(null);return;}
    const controller=new AbortController();let timer,closed=false;
    const epoch=owner.current.epoch,selection=owner.current.selection;
    const live=()=>!closed&&owner.current.epoch===epoch&&owner.current.selection===selection&&owner.current.visible&&owner.current.sessionId===sessionId;
    setJournal(null);
    const refresh=async()=>{
      try {
        const [sessionRead,descriptionRead,tasksRead,controlsRead]=await Promise.allSettled([rpc('session.get',{session_id:sessionId},controller.signal),rpc('acp.describe',{session_id:sessionId},controller.signal),rpc('acp.tasks',{session_id:sessionId},controller.signal),rpc('acp.controls',{session_id:sessionId},controller.signal)]);
        const candidate=sessionRead.status==='fulfilled'?sessionRead.value:null;
        const session=candidate&&candidate.session_id===sessionId&&['session_id','principal_id','binding_id'].every(key=>validId(candidate[key]))&&Number.isSafeInteger(candidate.version)&&candidate.version>0?candidate:null;
        const description=descriptionRead.status==='fulfilled'&&Array.isArray(descriptionRead.value?.backends)?descriptionRead.value:null;
        const bindingRead=session&&validId(session.binding_id)&&Number.isSafeInteger(session.version)?await Promise.allSettled([rpc('binding.get',{binding_id:session.binding_id,version:session.version},controller.signal)]):[];
        const bindingCandidate=bindingRead[0]?.status==='fulfilled'?bindingRead[0].value:null;
        const binding=bindingCandidate&&bindingCandidate.binding_id===session.binding_id&&bindingCandidate.version===session.version&&bindingCandidate.principal_id===session.principal_id?bindingCandidate:null;
        const readiness=[sessionRead.status==='rejected'?'session.get unavailable':!session?'session metadata unavailable':null,descriptionRead.status==='rejected'?'acp.describe unavailable':!description?'backend description unavailable':null,bindingRead[0]?.status==='rejected'?'binding.get unavailable':!binding?'binding metadata unavailable':null].filter(Boolean);
        const owned=(Array.isArray(tasksRead.status==='fulfilled'?tasksRead.value:null)?tasksRead.value:[]).filter(task=>taskShape(task)&&task.session_id===sessionId&&(!session || session.principal_id===task.principal_id));
        const active=owned.find(task=>['starting','running','stopping'].includes(task.state));
        const chosen=selectedRef.current?owned.find(task=>task.task_id===selectedRef.current):active??owned.at(-1);
        const eventRead=chosen?await Promise.allSettled([rpc('acp.events',{task_id:chosen.task_id},controller.signal)]):[];
        if(!live()) return;
        setData({sessionId,epoch,session,binding,description,tasks:owned,controls:Array.isArray(controlsRead.status==='fulfilled'?controlsRead.value:null)?controlsRead.value:[],readiness,historyError:tasksRead.status==='rejected'?'Task history unavailable: '+tasksRead.reason.message:'',controlsError:controlsRead.status==='rejected'?'Decision history unavailable: '+controlsRead.reason.message:''});
        setJournal({sessionId,taskId:chosen?.task_id??'',events:eventRead[0]?.status==='fulfilled'?eventRead[0].value:[],error:eventRead[0]?.status==='rejected'?'Journal unavailable: '+eventRead[0].reason.message:''});
        setBackend(value=>description?.backends.some(row=>row.id===value)?value:description?.backends[0]?.id??'');setError('');
      } catch(problem) {if(live()) {setJournal({sessionId,taskId:selectedRef.current,events:[],error:'Journal unavailable: '+problem.message});setError(problem.message);}}
      finally {if(live()) timer=setTimeout(refresh,1500);}
    };
    void refresh();return()=>{closed=true;controller.abort();clearTimeout(timer);};
  },[sessionId,visible,selected,selectionGeneration]);
  const view=visible===false || data?.sessionId!==sessionId || data?.epoch!==owner.current.epoch?null:data;
  const active=view?.tasks.find(task=>['starting','running','stopping'].includes(task.state));
  const chosen=view?.tasks.find(task=>task.task_id===selected)??(selected?undefined:active??view?.tasks.at(-1));
  const backendRow=view?.description?.backends.find(row=>row.id===backend);
  const owns=control=>sameTask(control,chosen);
  const controls=view?.controls.filter(owns)??[];
  const pending=view?.controls.filter(control=>sameTask(control,active)&&control.state==='pending')??[];
  async function mutate(kind) {
    if(!view || !owner.current.visible || busyRef.current || (kind==='start'&&(view.readiness.length||!view.session||!view.binding||!backendRow?.configured||!prompt.trim()||active)) || (kind==='cancel'&&!active)) return;
    const epoch=owner.current.epoch,operation=++owner.current.operation;
    const live=()=>owner.current.epoch===epoch&&owner.current.operation===operation&&owner.current.visible&&owner.current.sessionId===sessionId;
    busyRef.current={epoch,operation};setBusy({epoch,operation});setError('');const bound=kind==='cancel'?{session_id:active.session_id,binding_id:active.binding_id,version:active.version}:{session_id:sessionId,binding_id:view.session.binding_id,version:view.session.version};
    try {
      const task=kind==='start'?await rpc('acp.start',{...bound,backend_id:backend,request_id:crypto.randomUUID(),prompt},AbortSignal.timeout(20000)):await rpc('acp.cancel',{...bound,task_id:active.task_id},AbortSignal.timeout(100000));
      if(!live()) return;
      owner.current.selection++;selectedRef.current=task.task_id;setSelected(task.task_id);setJournal(null);setData(value=>value?.sessionId===sessionId?{...value,tasks:[...value.tasks.filter(row=>row.task_id!==task.task_id),task]}:value);
      if(kind==='start') setPrompt('');
    } catch(problem) {if(live()) setError(problem.message+' · Check history before retrying; requests are never replayed.');}
    finally {if(live()) {busyRef.current=null;setBusy(null);}}
  }
  const frame={border:'1px solid color-mix(in srgb, currentColor 18%, transparent)',borderRadius:6,padding:12,minWidth:0};
  const input={width:'100%',boxSizing:'border-box',border:'1px solid color-mix(in srgb, currentColor 28%, transparent)',borderRadius:4,padding:'8px 10px',background:'transparent',color:'inherit',font:'inherit',minWidth:0};
  const button={...input,width:'auto',cursor:'pointer'};
  const blocks=[];let omitted=0,rejected=0;
  if(chosen && journal?.sessionId===sessionId && journal.taskId===chosen.task_id) {
    const records=Array.isArray(journal.events)?journal.events:[];
    // Bound both node count and text size. Never silently discard the earliest updates.
    let size=0;
    for(const event of records) {
      if(!event || event.task_id!==chosen.task_id || !Number.isSafeInteger(event.seq) || event.seq<=0 || typeof event.kind!=='string' || typeof event.payload_json!=='string') {rejected++;continue;}
      if(blocks.length>=500 || size>=100000) {omitted++;continue;}
      const decoded=parse(event.payload_json,'event #'+event.seq),payload=decoded.value;
      const update=event.kind==='session/update'?payload?.update:null;
      const role=update?.sessionUpdate;
      const chunk=role==='agent_message_chunk'?'Agent':role==='user_message_chunk'?'User':null;
      const content=update?.content;
      const isText=chunk && content?.type==='text' && typeof content.text==='string' && !decoded.warning;
      let value=isText?content.text:decoded.warning??(event.kind==='session/update'?bounded(update??payload):bounded(payload));
      if(!isText) value=event.kind+' · '+value;
      const available=100000-size;
      if(value.length>available) {value=value.slice(0,available);omitted++;}
      size+=value.length;
      const previous=blocks.at(-1);
      if(isText && previous?.textChunk && previous.role===chunk) previous.value+=value;
      else blocks.push({role:isText?chunk:'Protocol record #'+event.seq,textChunk:Boolean(isText),value,seq:event.seq});
    }
    if(!Array.isArray(journal.events)) blocks.push({role:'Journal warning',value:'Malformed event list; history unavailable.'});
  }
  const original=chosen?parse(chosen.prompt_json,'prompt'):null;
  const result=chosen?parse(chosen.result_json,'result'):null;
  const identity=chosen?parse(chosen.identity_json,'identity'):null;
  if(visible===false) return null;
  return h('section',{'data-studio-acp':sessionId,style:{height:'100%',boxSizing:'border-box',overflow:'auto',padding:16,minWidth:0,display:'flex',flexDirection:'column',gap:14,fontSize:13,overflowWrap:'anywhere'}},
    h('header',null,h('div',{style:{fontSize:10,letterSpacing:'0.12em',textTransform:'uppercase',opacity:.65}},'Bound CLI / structured protocol'),h('h2',{style:{fontSize:20,margin:'4px 0 8px',fontWeight:600}},'ACP tasks'),h('div',{style:{fontFamily:'monospace',fontSize:11,opacity:.75}},view?.binding?.target_root??'Loading this session’s binding…')),
    error&&h('div',{role:'alert',style:{...frame,borderColor:'currentColor'}},error),
    view?.readiness.length>0&&h('div',{role:'alert',style:frame},'ACP readiness unavailable: '+view.readiness.join('; ')+'. Start is disabled; durable task history remains read-only.'),
    view?.historyError&&h('div',{role:'alert'},view.historyError),
    view?.controlsError&&h('div',{role:'alert'},view.controlsError),
    !view?h('p',{role:'status'},'Loading registered backends and task history…'):
    view.description&&!view.description.backends.length?h('div',{style:frame},h('strong',null,'No backend configured'),h('p',null,'This session has no registered ACP backend. An operator must add a dedicated policy, binding and fixed executable manifest before starting a new CLI task.')):
    !view.description?h('div',{style:frame},h('p',null,'Registered backend readiness unavailable.'),h('button',{type:'button',disabled:true,style:button},'Start ACP task')):
    h('div',{style:{...frame,display:'flex',flexDirection:'column',gap:10}},
      h('label',null,'Registered backend',h('select',{'aria-label':'ACP backend',value:backend,disabled:busy||Boolean(active),onChange:event=>setBackend(event.target.value),style:{...input,marginTop:6}},view.description.backends.map(row=>h('option',{key:row.id,value:row.id},row.name+' · '+row.version)))),
      backendRow?.offline_fixture&&h('p',{'data-acp-offline':true,style:{fontSize:11,margin:0,borderLeft:'2px solid currentColor',paddingLeft:10}},'OFFLINE PROTOCOL TEST PEER — not a coding CLI, not real-model or SC-12 acceptance.'),
      backendRow&&!backendRow.configured&&h('p',{role:'status'},'Missing dedicated credentials: '+backendRow.missing_credentials.join(', ')+'. Add them through the original credential settings.'),
      h('label',null,'Task prompt',h('textarea',{'aria-label':'ACP task prompt',rows:5,value:prompt,maxLength:16000,disabled:busy||Boolean(active),onChange:event=>setPrompt(event.target.value),placeholder:backendRow?.offline_fixture?'Explicit test JSON, e.g. {"case":"form","marker":"offline"}':'Describe the task for this registered backend',style:{...input,marginTop:6,resize:'vertical',lineHeight:1.5}})),
      h('div',{style:{display:'flex',gap:8,flexWrap:'wrap'}},h('button',{type:'button',onClick:()=>void mutate('start'),disabled:busy||Boolean(active)||view.readiness.length>0||!backendRow?.configured||!prompt.trim(),style:button},'Start ACP task')),
      h('small',{style:{opacity:.7}},'One live task per session. No automatic restart, approval replay or central fallback.')),
    active&&h('button',{type:'button',onClick:()=>void mutate('cancel'),disabled:busy,style:button},'Cancel ACP task'),
    active&&h('div',{role:'status',style:frame},h('strong',null,'Running · '+active.state),h('div',null,pending.length?'Waiting for your decision in this session’s original '+(pending[0].kind==='approval'?'approval':'question')+' prompt.':'Streaming structured protocol updates…'),h('small',null,'CLI instance '+active.cli_instance_id)),
     h('section',{'aria-label':'ACP task history',style:{display:'flex',flexDirection:'column',gap:8}},h('h3',{style:{fontSize:13,margin:'0 0 2px'}},'Task history'),!view?.tasks.length&&h('p',{style:{opacity:.65}},'No ACP tasks in this session.'),...(view?.tasks??[]).map(task=>h('button',{key:task.task_id,type:'button','aria-pressed':chosen?.task_id===task.task_id,onClick:()=>{if(selectedRef.current!==task.task_id) {owner.current.selection++;selectedRef.current=task.task_id;setSelected(task.task_id);setJournal(null);}},style:{...button,width:'100%',textAlign:'left',borderLeftWidth:chosen?.task_id===task.task_id?3:1}},h('strong',null,task.state),h('span',{style:{display:'block',fontSize:11,fontFamily:'monospace',opacity:.75}},task.task_id),task.error_code&&h('span',{style:{display:'block',fontSize:11}},task.error_code))).reverse()),
    chosen&&h('section',{style:frame,'aria-label':'Selected ACP task details'},
      h('h3',{style:{fontSize:14,margin:'0 0 8px'}},'Selected task · '+chosen.state),
      field('Task ID',chosen.task_id),field('Request ID',chosen.request_id),field('Session ID',chosen.session_id),field('Binding',chosen.binding_id+' · version '+chosen.version),field('Backend',chosen.backend_id+' · version '+chosen.backend_version),field('Protocol',chosen.protocol),field('CLI instance',chosen.cli_instance_id),field('CLI session',chosen.cli_session_id),field('Operation',chosen.operation_id),field('Run',chosen.run_id),field('Deadline',stamp(chosen.deadline_ms)),field('Status',chosen.state),field('Exit code',chosen.exit_code),field('Error code',chosen.error_code),
      h('h4',null,'Original prompt'),original.warning?h('p',{role:'alert'},original.warning):Array.isArray(original.value)?original.value.map((part,i)=>h('pre',{key:i,style:{whiteSpace:'pre-wrap',wordBreak:'break-word'}},'Content '+(i+1)+' · '+(part?.type??'unknown')+'\n'+bounded(part?.type==='text'?part.text:part))):h('p',{role:'alert'},'Stored prompt has an unexpected shape.'),
      h('h4',null,'Final protocol result'),result.warning?h('p',{role:'alert'},result.warning):result.value==null?h('p',null,'No final protocol result recorded; status is '+chosen.state+'.'):h('div',null,field('stopReason',result.value?.stopReason),h('pre',{style:{whiteSpace:'pre-wrap',wordBreak:'break-word'}},bounded(result.value))),
      h('details',null,h('summary',null,'CLI launch identity'),identity.warning?h('p',{role:'alert'},identity.warning):h('pre',{style:{whiteSpace:'pre-wrap',wordBreak:'break-word'}},identity.value==null?'Identity not yet confirmed.':bounded(identity.value)))),
     chosen&&h('section',{style:frame,'aria-label':'ACP protocol journal','data-acp-journal':chosen.task_id},h('h3',{style:{fontSize:13,margin:'0 0 8px'}},'Protocol journal'),h('p',{style:{fontSize:11,opacity:.7}},'Ordered ACP records, not native model/tool history. Text chunks from the same role are joined verbatim.'),
       journal?.sessionId!==sessionId || journal.taskId!==chosen.task_id?h('p',{role:'status'},'Loading this task’s journal…'):journal.error?h('p',{role:'alert'},journal.error):blocks.length?blocks.map((block,i)=>h('div',{key:i,style:{marginBottom:10}},h('strong',null,block.role),h('pre',{style:{whiteSpace:'pre-wrap',wordBreak:'break-word',fontSize:11,lineHeight:1.6,margin:'3px 0',maxHeight:400,overflow:'auto'}},block.value))):h('p',null,'No streamed updates yet.'),
       rejected>0&&h('p',{role:'alert'},rejected+' rejected journal record(s) with invalid or foreign task ownership/shape.'),
      omitted>0&&h('p',{role:'status'},'Display limit reached: '+omitted+' event(s) or partial event(s) omitted after the first 500 blocks / 100000 characters. Stored records remain available through the task API.')),
    chosen&&h('section',{style:frame,'aria-label':'Selected ACP task controls'},h('h3',{style:{fontSize:13,margin:'0 0 8px'}},'Decision history'),h('p',null,'Read-only. Native approval and question prompts remain separate. A decision written to stdio is not a peer acknowledgement.'),controls.length?controls.map(control=>{
      const answer=parse(control.answer_json,'control answer'),request=parse(control.payload_json,'control request');
      return h('div',{key:control.control_id,style:{borderTop:'1px solid currentColor',paddingTop:8,marginTop:8}},field('Kind',control.kind),field('State',control.state),field('Deadline',stamp(control.deadline_ms)),field('Delivery',control.delivery),field('Control ID',control.control_id),field('Call ID',control.call_id),field('Request ID',control.request_id),field('Session / binding / version',control.session_id+' / '+control.binding_id+' / '+control.version),field('CLI session / instance',control.cli_session_id+' / '+control.cli_instance_id),field('RPC request ID',control.rpc_request_id),h('div',null,'Action / request: ',request.warning??bounded(request.value)),h('div',null,'Answer: ',answer.warning??(answer.value==null?'No decision recorded.':bounded(answer.value))),control.delivery==='stdio-written-unconfirmed'&&h('p',{role:'status'},'Response written to stdio; peer consumption unconfirmed.'));
    }):h('p',null,'No decisions recorded for this exact task and CLI instance.')));
}
