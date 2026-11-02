// Embedded only into private projections. Native terminals retain their model,
// rendering/frame ACKs and lifetime; this panel never replays commands or input.
export function terminalRecoveryIdentity(sessionId,model,state) {
 const valid=typeof sessionId==='string'&&sessionId!==''&&model?.sessionId===sessionId&&typeof model.id==='string'&&model.id!==''&&(state?.info===undefined||state?.info?.id===model.id);
 // model.id is the Host allocation/request.id, not the tab or content address.
 return {sessionId,terminalId:valid?model.id:''};
}
export function terminalRecoveryWritable(recovery,identity) {
 return typeof identity?.sessionId==='string'&&identity.sessionId!==''&&typeof identity.terminalId==='string'&&identity.terminalId!==''&&recovery?.sessionId===identity.sessionId&&recovery?.terminalId===identity.terminalId&&recovery?.writable===true;
}
export function RecoveryPanel({scope,visible,terminalId,generation,React,onState,routeUrl=path=>{const base=new URL(document.baseURI);base.search='';base.hash='';if(!base.pathname.endsWith('/'))base.pathname+='/';return new URL(path.replace(/^\/+/,''),base).href;}}) {
 const h=React.createElement,sessionId=scope?.sessionId,terminalMode=terminalId!==undefined;
 const [rows,setRows]=React.useState([]),[error,setError]=React.useState(''),[busy,setBusy]=React.useState('');
 const current=React.useRef({sessionId,terminalId,visible,generation});
 if(current.current.sessionId!==sessionId||current.current.terminalId!==terminalId||current.current.visible!==visible||current.current.generation!==generation)current.current={sessionId,terminalId,visible,generation};
 const notify=React.useRef(onState);notify.current=onState;
 const pending=React.useRef(),proof=React.useRef(),epoch=React.useRef(0);
 function signal(owner,writable,value) {
  if(current.current===owner)notify.current?.({sessionId:owner.sessionId,terminalId:owner.terminalId,writable,value});
 }
 async function rpc(method,payload,signal) {
  const response=await fetch(routeUrl('agent-studio-rpc/'+method),{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload}),signal});
  if(!response.ok)throw new Error('HTTP '+response.status+'; no task was replayed');
  const result=(await response.json()).result;if(!result?.ok)throw new Error(result?.error?.code??'Invalid task response');return result.value;
 }
 function checked(values,owner) {
  if(!Array.isArray(values)||values.some(row=>!row?.operation||row.operation.session_id!==owner.sessionId))throw new Error('Original task identity mismatch');
  if(terminalMode&&(values.length!==1||proof.current?.owner!==owner||values[0].operation.operation_id!==proof.current.operationId||values[0].operation.kind!=='pty.open'))throw new Error('Original terminal identity mismatch');
  return values;
 }
 function publish(values,owner) {
  checked(values,owner);setRows(values);setError('');const first=values[0];
  signal(owner,!pending.current&&!!first&&['live','recovered'].includes(first.state?.state)&&first.operation.state==='running',first);
 }
 React.useEffect(()=>{
  const owner=current.current;pending.current=undefined;proof.current=undefined;epoch.current++;
  setRows([]);setError('');setBusy('');signal(owner,false);
  if(visible===false||!sessionId||(terminalMode&&(!terminalId||visible!==true)))return;
  const controller=new AbortController();let closed=false,timer;
  async function refresh(){
   const reading=epoch.current;
   try{
    if(pending.current)return;
    let values;
    if(terminalMode){
     if(proof.current?.owner!==owner){
      const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(sessionId+'\0'+terminalId));
      if(closed||current.current!==owner)return;
      proof.current={owner,operationId:'terminal-'+Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('')};
     }
     values=[await rpc('task.recovery',{session_id:sessionId,operation_id:proof.current.operationId},controller.signal)];
    }else values=await rpc('task.recoveries',{session_id:sessionId},controller.signal);
    if(closed||current.current!==owner||pending.current||epoch.current!==reading)return;
    publish(values,owner);
   }catch(problem){if(!closed&&current.current===owner&&!pending.current&&epoch.current===reading){setError(problem.message);signal(owner,false);}}
   finally{if(!closed)timer=setTimeout(refresh,750);}
  }
  void refresh();return()=>{closed=true;controller.abort();clearTimeout(timer);signal(owner,false);};
 },[sessionId,terminalId,visible,generation]);
 async function action(row,method){
  const owner=current.current;
  if(pending.current||owner.visible===false||row.operation.session_id!==owner.sessionId)return;
  if(terminalMode&&(proof.current?.owner!==owner||row.operation.operation_id!==proof.current.operationId))return;
  const token={owner};pending.current=token;epoch.current++;setBusy(row.operation.operation_id);setError('');signal(owner,false);
  const payload={session_id:sessionId,operation_id:row.operation.operation_id,...(method==='recover'?{recovery_id:crypto.randomUUID()}:{action_id:crypto.randomUUID()})};
  try{
   await rpc('task.'+method,payload,AbortSignal.timeout(45000));
   const value=await rpc('task.recovery',{session_id:sessionId,operation_id:row.operation.operation_id},AbortSignal.timeout(45000));
   if(current.current!==owner||pending.current!==token)return;
   checked([value],owner);
   if(value.operation.operation_id!==row.operation.operation_id)throw new Error('Original task identity mismatch');
   pending.current=undefined;setBusy('');
   if(terminalMode)publish([value],owner);
   else {setRows(values=>values.map(item=>item.operation.operation_id===value.operation.operation_id?value:item));signal(owner,false);}
  }catch(problem){if(current.current===owner&&pending.current===token){setError(problem.message+' · Original task retained; no automatic retry.');signal(owner,false);}}
  finally{if(current.current===owner&&pending.current===token){pending.current=undefined;setBusy('');}}
 }
 const button={font:'inherit',fontSize:12,color:'inherit',background:'transparent',border:'1px solid color-mix(in srgb,currentColor 25%,transparent)',borderRadius:4,padding:'4px 8px',cursor:'pointer'};
 const shown=rows.filter(row=>row.operation.session_id===sessionId&&(!terminalMode||(proof.current?.owner===current.current&&row.operation.operation_id===proof.current.operationId)));
 return h('section',{'data-studio-recovery':terminalId??'tasks','aria-label':'Original task recovery',style:{padding:terminalMode?'6px 10px':16,borderBottom:'1px solid color-mix(in srgb,currentColor 18%,transparent)',fontSize:12,minWidth:0,overflowWrap:'anywhere',maxHeight:terminalMode?160:'100%',overflow:'auto'}},
  !terminalMode&&h('h2',{style:{fontSize:18,margin:'0 0 12px'}},'Original tasks'),
  error&&h('div',{role:'alert','data-recovery-error':true},error),
  !shown.length&&!error&&h('span',{role:'status'},terminalMode?'Checking original task identity…':'No recorded task in this session.'),
  ...shown.slice(-30).reverse().map(row=>{
   const op=row.operation,state=row.state;let identity;
   try{identity=row.snapshot?JSON.parse(row.snapshot.identity_json):null;}catch{identity=null;}
   const lost=state?.state==='lost',live=['live','recovered'].includes(state?.state)&&op.state==='running';
   return h('div',{key:op.operation_id,'data-recovery-operation':op.operation_id,'data-recovery-state':state?.state??'identity-incomplete',style:{display:'flex',flexDirection:'column',gap:4,marginBottom:terminalMode?0:12}},
    h('div',{role:'status'},h('strong',null,lost?'Disconnected · original task':state?.state==='recovered'?'Recovered · same original process':state?.state??'Identity incomplete'),h('span',{style:{marginLeft:8,opacity:.75}},'PID '+(identity?.pid??op.remote_pid??op.local_pid??'unconfirmed'))),
    h('code',{style:{fontSize:10,opacity:.7}},op.operation_id),
    state?.first_lost_at_ms&&h('small',null,'Fixed recovery deadline '+new Date(state.recovery_deadline_ms).toISOString()+' · '+(row.eligible?'eligible for explicit verification':row.reason??op.state)),
    (!row.snapshot?.complete)&&h('small',null,'Not recoverable: '+(row.snapshot?.incomplete_reason??row.reason)+'. No PID-based adoption.'),
    state?.output_gap?h('div',{role:'alert'},'Original output gap: earliest helper chunk '+state.earliest_seq+'. Missing output is not reconstructed.'):h('small',{style:{opacity:.7}},'Original output cursor '+(state?.output_cursor??'0')+' · no known gap'),
    h('div',{style:{display:'flex',flexWrap:'wrap',gap:6}},
     lost&&h('button',{type:'button',style:button,disabled:!!busy||!row.eligible,onClick:()=>void action(row,'recover')},busy===op.operation_id?'Verifying original identity…':'Recover original task'),
     live&&h('button',{type:'button',style:button,disabled:!!busy,onClick:()=>void action(row,'cancel')},'Cancel original task'),
     ['completed','cancelled'].includes(op.state)&&state&&h('button',{type:'button',style:button,disabled:!!busy,onClick:()=>void action(row,'release')},'Release original task')));
  }),!terminalMode&&h('small',{style:{opacity:.7}},'Same Host only. Recovery never starts a replacement command or resumes ACP business protocol. Close a terminal explicitly to clean it up.'));
}
