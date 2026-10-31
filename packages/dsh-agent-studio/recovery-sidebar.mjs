// Embedded into the existing sidebar and original terminal chunk. The native
// terminal still owns rendering/frame ACKs; this panel never replays a command.
export function RecoveryPanel({scope,visible,terminalId,React,onState,routeUrl=path=>{const base=new URL(document.baseURI);base.search='';base.hash='';if(!base.pathname.endsWith('/'))base.pathname+='/';return new URL(path.replace(/^\/+/,''),base).href;}}) {
 const h=React.createElement,sessionId=scope.sessionId,[rows,setRows]=React.useState([]),[error,setError]=React.useState(''),[busy,setBusy]=React.useState('');
 const current=React.useRef(sessionId);current.current=sessionId;const notify=React.useRef(onState);notify.current=onState;
 async function rpc(method,payload,signal) {
  const response=await fetch(routeUrl('agent-studio-rpc/'+method),{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload}),signal});
  if(!response.ok)throw new Error('HTTP '+response.status+'; no task was replayed');
  const result=(await response.json()).result;if(!result?.ok)throw new Error(result?.error?.code??'Invalid task response');return result.value;
 }
 React.useEffect(()=>{
  setRows([]);setError('');notify.current?.({writable:false});
  if(visible===false||!sessionId)return;
  const controller=new AbortController();let closed=false,timer;
  async function refresh(){
   try{
    let values;
    if(terminalId){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(sessionId+'\0'+terminalId));const operation_id='terminal-'+Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');values=[await rpc('task.recovery',{session_id:sessionId,operation_id},controller.signal)];}
    else values=await rpc('task.recoveries',{session_id:sessionId},controller.signal);
    if(closed||current.current!==sessionId)return;
    setRows(values);setError('');const first=values[0];notify.current?.({writable:!!first&&['live','recovered'].includes(first.state?.state)&&first.operation.state==='running',value:first});
   }catch(problem){if(!closed){setError(problem.message);notify.current?.({writable:false});}}
   finally{if(!closed)timer=setTimeout(refresh,750);}
  }
  void refresh();return()=>{closed=true;controller.abort();clearTimeout(timer);};
 },[sessionId,terminalId,visible]);
 async function action(row,method){
  if(busy)return;setBusy(row.operation.operation_id);setError('');notify.current?.({writable:false});
  const payload={session_id:sessionId,operation_id:row.operation.operation_id,...(method==='recover'?{recovery_id:crypto.randomUUID()}:['cancel','release'].includes(method)?{action_id:crypto.randomUUID()}:{})};
  try{await rpc('task.'+method,payload,AbortSignal.timeout(45000));const value=await rpc('task.recovery',{session_id:sessionId,operation_id:row.operation.operation_id});if(current.current===sessionId)setRows(values=>values.map(item=>item.operation.operation_id===value.operation.operation_id?value:item));}
  catch(problem){if(current.current===sessionId)setError(problem.message+' · Original task retained; no automatic retry.');}
  finally{if(current.current===sessionId)setBusy('');}
 }
 const button={font:'inherit',fontSize:12,color:'inherit',background:'transparent',border:'1px solid color-mix(in srgb,currentColor 25%,transparent)',borderRadius:4,padding:'4px 8px',cursor:'pointer'};
 return h('section',{'data-studio-recovery':terminalId??'tasks','aria-label':'Original task recovery',style:{padding:terminalId?'6px 10px':16,borderBottom:'1px solid color-mix(in srgb,currentColor 18%,transparent)',fontSize:12,minWidth:0,overflowWrap:'anywhere',maxHeight:terminalId?160:'100%',overflow:'auto'}},
  !terminalId&&h('h2',{style:{fontSize:18,margin:'0 0 12px'}},'Original tasks'),
  error&&h('div',{role:'alert','data-recovery-error':true},error),
  !rows.length&&!error&&h('span',{role:'status'},terminalId?'Checking original task identity…':'No recorded task in this session.'),
  ...rows.slice(-30).reverse().map(row=>{
   const op=row.operation,state=row.state,identity=row.snapshot?JSON.parse(row.snapshot.identity_json):null,lost=state?.state==='lost',live=['live','recovered'].includes(state?.state)&&op.state==='running';
   return h('div',{key:op.operation_id,'data-recovery-operation':op.operation_id,'data-recovery-state':state?.state??'identity-incomplete',style:{display:'flex',flexDirection:'column',gap:4,marginBottom:terminalId?0:12}},
    h('div',{role:'status'},h('strong',null,lost?'Disconnected · original task':state?.state==='recovered'?'Recovered · same original process':state?.state??'Identity incomplete'),h('span',{style:{marginLeft:8,opacity:.75}},'PID '+(identity?.pid??op.remote_pid??op.local_pid??'unconfirmed'))),
    h('code',{style:{fontSize:10,opacity:.7}},op.operation_id),
    state?.first_lost_at_ms&&h('small',null,'Fixed recovery deadline '+new Date(state.recovery_deadline_ms).toISOString()+' · '+(row.eligible?'eligible for explicit verification':row.reason??op.state)),
    (!row.snapshot?.complete)&&h('small',null,'Not recoverable: '+(row.snapshot?.incomplete_reason??row.reason)+'. No PID-based adoption.'),
    state?.output_gap?h('div',{role:'alert'},'Original output gap: earliest helper chunk '+state.earliest_seq+'. Missing output is not reconstructed.'):h('small',{style:{opacity:.7}},'Original output cursor '+(state?.output_cursor??'0')+' · no known gap'),
    h('div',{style:{display:'flex',flexWrap:'wrap',gap:6}},
     lost&&h('button',{type:'button',style:button,disabled:!!busy||!row.eligible,onClick:()=>void action(row,'recover')},busy===op.operation_id?'Verifying original identity…':'Recover original task'),
     live&&h('button',{type:'button',style:button,disabled:!!busy,onClick:()=>void action(row,'cancel')},'Cancel original task'),
     ['completed','cancelled'].includes(op.state)&&state&&h('button',{type:'button',style:button,disabled:!!busy,onClick:()=>void action(row,'release')},'Release original task')));
  }),!terminalId&&h('small',{style:{opacity:.7}},'Same Host only. Recovery never starts a replacement command or resumes ACP business protocol. Close a terminal explicitly to clean it up.'));
}
