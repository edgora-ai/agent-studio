import {AcpPanel} from '../../packages/dsh-agent-studio/acp-sidebar.mjs';
import {EnvironmentPanel,EnvironmentEntry} from '../../packages/dsh-agent-studio/environment-sidebar.mjs';
import {RecoveryPanel} from '../../packages/dsh-agent-studio/recovery-sidebar.mjs';
// Small, uniqueness-checked edits to the hash-locked 0.28.2 client projection.
// The installed upstream package remains untouched. No new UI/server or build tool.
function once(source,oldText,newText) {
  if(source.split(oldText).length!==2) throw new Error('Sidebar projection seam mismatch: '+oldText.slice(0,90));
  return source.replace(oldText,newText);
}
function section(source,start,end,replacement) {
  if(source.split(start).length!==2) throw new Error('Sidebar projection start mismatch');
  const at=source.indexOf(start),finish=source.indexOf(end,at);
  if(finish<0) throw new Error('Sidebar projection end missing');
  return source.slice(0,at)+replacement+source.slice(finish);
}
export function projectSidebar(file,bytes) {
  let source=bytes.toString();
  if(['lib/client.js','lib/client-registry.js'].includes(file)) {
    source=once(source,'function builtinTabs(ctx) {',`const StudioRecoveryPanel = ${RecoveryPanel.toString()};\nconst StudioAcpPanel = ${AcpPanel.toString()};\nconst StudioEnvironmentPanel = ${EnvironmentPanel.toString()};\nconst StudioEnvironmentEntry = ${EnvironmentEntry.toString()};\nfunction builtinTabs(ctx) {`);
    source=once(source,'function Sidebar(props) {',`function Sidebar(props) {
      return (0,react.createElement)(react.Fragment,null,(0,react.createElement)(StudioOriginalSidebar,props),(0,react.createElement)(StudioEnvironmentEntry,{ctx:props.ctx,React:react,routeUrl:path=>hostRouteUrl(path).href,Panel:StudioEnvironmentPanel}));
    }
    function StudioOriginalSidebar(props) {`);
    source=once(source,'for (const tab of builtinTabs(ctx)) disposers.push(service.registerTab(tab));',`for (const tab of [...builtinTabs(ctx), {id:"studio-recovery",title:()=>"Original tasks",description:()=>"Explicit recovery of the same owned task",icon:tasksTabIcon,order:24,single:true,component:props=>(0,react_jsx_runtime.jsx)(StudioRecoveryPanel,{...props,React:react,routeUrl:path=>hostRouteUrl(path).href})}, {id:"studio-acp",title:()=>"ACP tasks",description:()=>"Bound structured CLI tasks; original approvals and questions",icon:tasksTabIcon,order:25,single:true,component:props=>(0,react_jsx_runtime.jsx)(StudioAcpPanel,{...props,React:react,routeUrl:path=>hostRouteUrl(path).href})}, {id:"studio-environments",title:()=>"Environments",description:()=>"Discover approved execution environments and open a bound session",icon:tasksTabIcon,order:26,single:true,component:props=>(0,react_jsx_runtime.jsx)(StudioEnvironmentPanel,{...props,ctx,React:react,routeUrl:path=>hostRouteUrl(path).href})}]) disposers.push(service.registerTab(tab));`);
    source=once(source,'const FileRow =','const studioGitReadOnly = true; // Explicit preview capability policy, not a mutation implementation.\n\t\tconst FileRow =');
    const rowDisable=/disabled: busy,(\s+)label: action,/g;
    if([...source.matchAll(rowDisable)].length!==2) throw new Error('Git row capability seam mismatch');
    source=source.replace(rowDisable,'disabled: studioGitReadOnly || busy,$1label: action,');
    source=once(source,'const canCommit = isRepo &&','const canCommit = !studioGitReadOnly && isRepo &&');
    source=once(source,'const runAction = async (action, failure = errorMessage, onSuccess) => {','const runAction = async (action, failure = errorMessage, onSuccess) => {\n if(studioGitReadOnly) {setActionError("Bound Git is read-only; writes are disabled");return;}');
    source=once(source,'placeholder: busy || suggesting ? "" : messagePlaceholder,','placeholder: "Read-only Git · writes and generation disabled",');
    const commitDisable=/value: commitMsg,(\s+)disabled: busy \|\| suggesting,/g;
    if([...source.matchAll(commitDisable)].length!==1) throw new Error('Git commit capability seam mismatch');
    source=source.replace(commitDisable,'value: commitMsg,$1disabled: studioGitReadOnly || busy || suggesting,');
    const groupDisable=/disabled: busy \|\| suggesting,(\s+)label: staged \? t\("unstageAll"\) : t\("stageAll"\),/g;
    if([...source.matchAll(groupDisable)].length!==1) throw new Error('Git group capability seam mismatch');
    source=source.replace(groupDisable,'disabled: studioGitReadOnly || busy || suggesting,$1label: staged ? t("unstageAll") : t("stageAll"),');
    source=once(source,'disabled: busy || suggesting || entries.length === 0,','disabled: studioGitReadOnly || busy || suggesting || entries.length === 0,');
    source=once(source,'if (result.diff === "") {','if (result.diff === "" && result.identity === undefined) {');
    source=once(source,'setResults(found);','if (!controller.signal.aborted && found.identity?.session_id === sessionId) setResults(found);');
    source=once(source,'const patterns = excludeKey === "" ? void 0 : excludeKey.split("\\0");','setResults(null);\n\t\t\tconst patterns = excludeKey === "" ? void 0 : excludeKey.split("\\0");');
    source=once(source,'placeholder: t("editorSearchPlaceholder"),','placeholder: "Name or content: text (bounded search)",');
    source=section(source,'error === null && results !== null && results.matches.map((rel) => {','\n\t\t\t\t\t\t\terror === null && results?.truncated',`error === null && results?.identity?.session_id === sessionId && results.matches.map((rel) => {
              const isDirHit = dirHits.has(rel);
              const hit = results.hits?.find(item => item.path === rel);
              const label = rel.slice(results.identity.target_root.length + 1) + (hit?.line ? ":" + hit.line + " — " + hit.preview : "");
              return (0, react_jsx_runtime.jsxs)("div", {"data-studio-search-hit": rel, style:{display:"flex",alignItems:"center",minWidth:0}, children: [
                (0, react_jsx_runtime.jsx)("button", {type: "button", className: sidebar_module_css_default.editorSearchResult,style:{flex:1,minWidth:0},
                  title: rel + " — " + results.identity.binding_id + " — " + label, onClick: () => {if(isDirHit) openSearchDir(rel);else onOpenFile(resolveSidebarPath(cwd,rel));}, children: (0,react_jsx_runtime.jsx)("span",{className:sidebar_module_css_default.editorSearchResultLabel,children:label})}),
                !isDirHit && (0, react_jsx_runtime.jsx)("button", {type: "button",className:sidebar_module_css_default.iconButton,title: "Reference bound file snapshot", "aria-label": "Reference bound file snapshot",
                  onClick: () => onReferenceFile(rel,false), children: "@"})
              ]}, rel);
            }),`);
    source=once(source,'children: t("editorSearchTruncated")','children: "Partial search: " + (results.reasons ?? []).join(", ")');
    source=section(source,'function insertWorkspaceReference(ctx, sessionId, path, isDir) {','\n\t\t//#endregion',`function insertWorkspaceReference(ctx, sessionId, path, isDir) {
      // Resolve through the original session before inserting. The reference is a
      // self-contained, versioned remote snapshot, never a central @path lookup.
      void call("reference.create", {sessionId,path,isDir}).then(reference => {
        if(reference.identity.session_id !== sessionId) throw new Error("Reference session mismatch");
        if(!insertDraftReference(ctx,sessionId,{label:reference.label,text:reference.text,clipboardText:reference.clipboardText}))
          throw new Error("Conversation refused the bound reference");
      }).catch(error => {console.error("Bound reference refused",error);window.alert("Bound reference refused: " + error.message);});
    }`);
  }
  if(file==='lib/client-editor.js') {
    source=once(source,'const savedTextRef = (0, react.useRef)(content ?? null);',`const savedTextRef = (0, react.useRef)(content ?? null);
      const studioDirty = (0, react.useRef)(dirty); studioDirty.current = dirty;
      const [studioWatch,setStudioWatch] = (0, react.useState)("Bound polling: connecting");
      (0, react.useEffect)(() => {
        if(props.visible === false || !path.startsWith("/")) return;
        let closed=false, pending=false, socket, retry, kind="Bound";
        const controller=new AbortController();
        const dir=path.slice(0,path.lastIndexOf("/"));
        const read = () => {
          if(pending || closed || savingRef.current) return;
          pending=true;
          api.fsRead(scope,path,controller.signal).then(result => {
            if(closed || result.kind!=="text" || savingRef.current) return;
            if(result.mtimeMs !== mtimeRef.current || !sameDocument(result.content,savedTextRef.current ?? "")) {
              if(studioDirty.current) setConflict(true);
              else props.onReload?.();
            }
          }).catch(error => {if(!closed) setStudioWatch(kind + " polling read failed: " + error.message);}).finally(()=>{pending=false;});
        };
        const connect=()=>{
          if(closed) return;
          const url=hostRouteUrl("sidebar/ws/fs-watch");url.protocol=url.protocol==="https:"?"wss:":"ws:";url.search=new URLSearchParams({sessionId:scope.sessionId}).toString();
          socket=new WebSocket(url.toString());
          socket.onopen=()=>socket.send(JSON.stringify({op:"watch",path:dir}));
          socket.onmessage=event=>{
            let frame;try{frame=JSON.parse(event.data);}catch(error){setStudioWatch("Invalid bound watch frame");return;}
            if(closed || frame.identity?.session_id!==scope.sessionId) return;
            kind=frame.identity.kind==="local"?"Local":frame.identity.kind==="remote"?"Remote":"Unknown";
            if(frame.ok===false) {setStudioWatch(kind + " polling unavailable: " + frame.code);return;}
            if(frame.dir===dir) {setStudioWatch(kind + " polling: 2.5s · max 1000 entries/directory");read();}
          };
          socket.onclose=()=>{if(!closed){setStudioWatch(kind + " polling disconnected (changes unknown)");retry=setTimeout(connect,5000);}};
        };
        connect();return()=>{closed=true;controller.abort();clearTimeout(retry);socket?.close();};
      },[scope.sessionId,scope.cwd,path,props.visible]);`);
    source=once(source,'editable && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [conflict &&',`(0, react_jsx_runtime.jsx)("div", {className:sidebar_module_css_default.editorStatus,"data-studio-watch":true,children:studioWatch}),
      editable && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [conflict &&`);
    // Keep the earlier D02 wire code compatible while activating the original
    // editor's real conflict banner rather than its generic failure message.
    source=once(source,'error.code === "fs-conflict"','(error.code === "fs-conflict" || error.code === "conflict")');
  }
  if(file==='lib/client-terminal.js') {
    source=once(source,'function TerminalBottomView({ ctx, scope, tab, visible }) {',`const StudioTerminalRecovery = ${RecoveryPanel.toString()};\nfunction TerminalBottomView({ ctx, scope, tab, visible }) {\n const [studioRecovery,setStudioRecovery]=(0,react.useState)({writable:false});`);
    source=once(source,'children: [\n\t\t\t\tstatus !== void 0',`children: [\n (0,react.createElement)(StudioTerminalRecovery,{scope,visible,terminalId:state.info?.id??model.id,React:react,onState:setStudioRecovery}),\n\t\t\t\tstatus !== void 0`);
    source=once(source,'state,\n\t\t\t\t\tvisible,\n\t\t\t\t\tscheme,','state:{...state,writable:state.writable&&studioRecovery.writable},\n\t\t\t\t\tvisible,\n\t\t\t\t\tscheme,');
  }
  return Buffer.from(source);
}
