// Serialized into the existing betterSidebar client by the hash-checked private
// projection. No standalone page, model turn, or alternative conversation UI.
export function AcpPanel({scope,visible,React,routeUrl}) {
  const h=React.createElement,[data,setData]=React.useState(null),[backend,setBackend]=React.useState(''),[prompt,setPrompt]=React.useState(''),[selected,setSelected]=React.useState(''),[events,setEvents]=React.useState([]),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false);
  const sessionId=scope.sessionId,current=React.useRef(sessionId);current.current=sessionId;
  const selectedRef=React.useRef(selected);selectedRef.current=selected;
  async function rpc(method,payload,signal) {
    const response=await fetch(routeUrl('agent-studio-rpc/'+method),{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload}),signal});
    if(!response.ok) throw new Error('HTTP '+response.status+'; no operation was retried');
    const envelope=await response.json();if(!envelope.result?.ok) throw new Error(envelope.result?.error?.code??'Invalid ACP response');return envelope.result.value;
  }
  React.useEffect(()=>{
    setData(null);setEvents([]);setSelected('');setBackend('');setError('');setPrompt('');setBusy(false);
  },[sessionId]);
  React.useEffect(()=>{
    if(visible===false || !sessionId) return;
    const controller=new AbortController();let timer,closed=false;
    const refresh=async()=>{
      try {
        const [session,description,tasks,controls]=await Promise.all([rpc('session.get',{session_id:sessionId},controller.signal),rpc('acp.describe',{session_id:sessionId},controller.signal),rpc('acp.tasks',{session_id:sessionId},controller.signal),rpc('acp.controls',{session_id:sessionId},controller.signal)]);
        const binding=await rpc('binding.get',{binding_id:session.binding_id,version:session.version},controller.signal);
        const active=tasks.find(task=>['starting','running','stopping'].includes(task.state));
        const chosen=selectedRef.current || active?.task_id || tasks.at(-1)?.task_id;
        const journal=chosen?await rpc('acp.events',{task_id:chosen},controller.signal):[];
        if(closed || current.current!==sessionId) return;
        setData({session,binding,description,tasks,controls});setEvents(journal);setBackend(value=>description.backends.some(row=>row.id===value)?value:description.backends[0]?.id??'');
      } catch(problem) {if(!closed) setError(problem.message);}
      finally {if(!closed) timer=setTimeout(refresh,1500);}
    };
    void refresh();return()=>{closed=true;controller.abort();clearTimeout(timer);};
  },[sessionId,visible,selected]);
  const active=data?.tasks.find(task=>['starting','running','stopping'].includes(task.state));
  const chosen=data?.tasks.find(task=>task.task_id===(selected||active?.task_id))??data?.tasks.at(-1);
  const backendRow=data?.description.backends.find(row=>row.id===backend);
  const pending=data?.controls.filter(control=>control.request_id===active?.request_id && control.state==='pending')??[];
  async function mutate(kind) {
    if(!data || busy) return;
    setBusy(true);setError('');const bound={session_id:sessionId,binding_id:data.session.binding_id,version:data.session.version};
    try {
      const task=kind==='start'?await rpc('acp.start',{...bound,backend_id:backend,request_id:crypto.randomUUID(),prompt},AbortSignal.timeout(20000)):await rpc('acp.cancel',{...bound,task_id:active.task_id},AbortSignal.timeout(100000));
      if(current.current!==sessionId) return;
      setSelected(task.task_id);setData(value=>({...value,tasks:[...value.tasks.filter(row=>row.task_id!==task.task_id),task]}));
      if(kind==='start') setPrompt('');
    } catch(problem) {if(current.current===sessionId) setError(problem.message+' · Check history before retrying; requests are never replayed.');}
    finally {if(current.current===sessionId) setBusy(false);}
  }
  const frame={border:'1px solid color-mix(in srgb, currentColor 18%, transparent)',borderRadius:6,padding:12,minWidth:0};
  const input={width:'100%',boxSizing:'border-box',border:'1px solid color-mix(in srgb, currentColor 28%, transparent)',borderRadius:4,padding:'8px 10px',background:'transparent',color:'inherit',font:'inherit',minWidth:0};
  const button={...input,width:'auto',cursor:'pointer'};
  const journal=events.filter(event=>['session/update','control-refused','process-stopped'].includes(event.kind)).slice(-40).map(event=>{
    const payload=JSON.parse(event.payload_json);return event.kind==='session/update'?payload.update?.content?.text??JSON.stringify(payload.update):event.kind+' · '+JSON.stringify(payload);
  }).join('\n');
  return h('section',{'data-studio-acp':sessionId,style:{height:'100%',boxSizing:'border-box',overflow:'auto',padding:16,minWidth:0,display:'flex',flexDirection:'column',gap:14,fontSize:13,overflowWrap:'anywhere'}},
    h('header',null,h('div',{style:{fontSize:10,letterSpacing:'0.12em',textTransform:'uppercase',opacity:.65}},'Bound CLI / structured protocol'),h('h2',{style:{fontSize:20,margin:'4px 0 8px',fontWeight:600}},'ACP tasks'),h('div',{style:{fontFamily:'monospace',fontSize:11,opacity:.75}},data?.binding.target_root??'Loading this session’s binding…')),
    error&&h('div',{role:'alert',style:{...frame,borderColor:'currentColor'}},error),
    !data?h('p',{role:'status'},'Loading registered backends and task history…'):
    !data.description.backends.length?h('div',{style:frame},h('strong',null,'No backend configured'),h('p',null,'This session has no registered ACP backend. An operator must add a dedicated policy, binding and fixed executable manifest. No CLI has been started.')):
    h('div',{style:{...frame,display:'flex',flexDirection:'column',gap:10}},
      h('label',null,'Registered backend',h('select',{'aria-label':'ACP backend',value:backend,disabled:busy||Boolean(active),onChange:event=>setBackend(event.target.value),style:{...input,marginTop:6}},data.description.backends.map(row=>h('option',{key:row.id,value:row.id},row.name+' · '+row.version)))),
      backendRow?.offline_fixture&&h('p',{'data-acp-offline':true,style:{fontSize:11,margin:0,borderLeft:'2px solid currentColor',paddingLeft:10}},'OFFLINE PROTOCOL TEST PEER — not a coding CLI, not real-model or SC-12 acceptance.'),
      backendRow&&!backendRow.configured&&h('p',{role:'status'},'Missing dedicated credentials: '+backendRow.missing_credentials.join(', ')+'. Add them through the original credential settings.'),
      h('label',null,'Task prompt',h('textarea',{'aria-label':'ACP task prompt',rows:5,value:prompt,maxLength:16000,disabled:busy||Boolean(active),onChange:event=>setPrompt(event.target.value),placeholder:backendRow?.offline_fixture?'Explicit test JSON, e.g. {"case":"form","marker":"offline"}':'Describe the task for this registered backend',style:{...input,marginTop:6,resize:'vertical',lineHeight:1.5}})),
      h('div',{style:{display:'flex',gap:8,flexWrap:'wrap'}},h('button',{type:'button',onClick:()=>void mutate('start'),disabled:busy||Boolean(active)||!backendRow?.configured||!prompt.trim(),style:button},'Start ACP task'),active&&h('button',{type:'button',onClick:()=>void mutate('cancel'),disabled:busy,style:button},'Cancel ACP task')),
      h('small',{style:{opacity:.7}},'One live task per session. No automatic restart, approval replay or central fallback.')),
    active&&h('div',{role:'status',style:frame},h('strong',null,'Running · '+active.state),h('div',null,pending.length?'Waiting for your decision in this session’s original '+(pending[0].kind==='approval'?'approval':'question')+' prompt.':'Streaming structured protocol updates…'),h('small',null,'CLI instance '+active.cli_instance_id)),
    h('section',{'aria-label':'ACP task history',style:{display:'flex',flexDirection:'column',gap:8}},h('h3',{style:{fontSize:13,margin:'0 0 2px'}},'Task history'),!(data?.tasks.length)&&h('p',{style:{opacity:.65}},'No ACP tasks in this session.'),...(data?.tasks??[]).slice(-12).reverse().map(task=>h('button',{key:task.task_id,type:'button','aria-pressed':chosen?.task_id===task.task_id,onClick:()=>setSelected(task.task_id),style:{...button,width:'100%',textAlign:'left',borderLeftWidth:chosen?.task_id===task.task_id?3:1}},h('strong',null,task.state),h('span',{style:{display:'block',fontSize:11,fontFamily:'monospace',opacity:.75}},task.task_id),task.error_code&&h('span',{style:{display:'block',fontSize:11}},task.error_code)))),
    chosen&&h('section',{style:frame},h('h3',{style:{fontSize:13,margin:'0 0 8px'}},'Protocol journal'),h('p',{style:{fontSize:11,opacity:.7}},'ACP records, not native model/tool history. A written response is not a peer acknowledgement.'),h('pre',{'data-acp-journal':chosen.task_id,style:{whiteSpace:'pre-wrap',wordBreak:'break-word',fontSize:11,lineHeight:1.6,margin:0,maxHeight:400,overflow:'auto'}},journal||'No streamed updates yet.'),h('details',null,h('summary',{style:{cursor:'pointer',marginTop:10}},'Execution identity'),h('pre',{style:{whiteSpace:'pre-wrap',wordBreak:'break-word',fontSize:10}},chosen.identity_json??'Identity not yet confirmed.'))));
}
