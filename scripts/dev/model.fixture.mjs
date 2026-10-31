#!/usr/bin/env node
// Test-only protocol server. NOT an LLM, not a tool executor or session writer.
import {createServer} from 'node:http';
import {readFile,writeFile,appendFile,realpath,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID,createHash,timingSafeEqual} from 'node:crypto';

export async function fixture(root,host) {
  if(!['127.0.0.1','::1'].includes(host)) throw new Error('Explicit loopback fixture host required');
  if(await realpath(root)!==root || (await readFile(join(root,'.agent-studio-root'),'utf8')).trim()!=='agent-studio-preview-v1' || (await lstat(root)).mode&0o077) throw new Error('Owned private root required');
  const synthetic='synthetic-offline-only-'+randomUUID(),events=join(root,'offline-fixture-events.jsonl');
  await writeFile(join(root,'offline-fixture-credential.txt'),synthetic,{mode:0o600});
  const record=event=>appendFile(events,JSON.stringify({...event,time:new Date().toISOString()})+'\n',{mode:0o600}).catch(error=>{console.error('Fixture evidence write failed',error.code);process.exitCode=1;});
  const server=createServer(async(req,res)=>{
    let closed=false;res.on('close',()=>{closed=true;});
    if(req.url!=='/v1/chat/completions' || req.method!=='POST') {res.writeHead(404);res.end();return;}
    const expected=Buffer.from('Bearer '+synthetic),got=Buffer.from(req.headers.authorization??'');
    if(expected.length!==got.length || !timingSafeEqual(expected,got)) {res.writeHead(401);res.end();return;}
    let size=0;const chunks=[];
    try {
      for await(const chunk of req) {size+=chunk.length;if(size>2097152) throw new Error('fixture-body-limit');chunks.push(chunk);}
      const raw=Buffer.concat(chunks),body=JSON.parse(raw);
      if(body.model!=='offline-protocol-v1' || body.stream!==true) throw new Error('fixture-protocol-invalid');
      const messages=body.messages,extract=content=>typeof content==='string'?content:Array.isArray(content)?content.filter(p=>p.type==='text').map(p=>p.text).join('\n'):'';
      const index=messages.findLastIndex(m=>m.role==='user' && extract(m.content).includes('[D05 scenario:'));
      if(index<0) throw new Error('fixture-scenario-required');
      const prompt=extract(messages[index].content),scenario=/\[D05 scenario:([a-z-]+)\]/.exec(prompt)?.[1],path=/\[D05 path:([^\]\n]+)\]/.exec(prompt)?.[1]??'fixture.txt';
      const turn=messages.slice(index+1),step=turn.filter(m=>m.role==='tool').length;
      await record({kind:'request',scenario,step,request_sha256:createHash('sha256').update(raw).digest('hex'),advertised_tools:body.tools?.map(t=>t.function?.name)??[]});
      if(scenario==='error') {res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Explicit offline fixture failure',type:'offline_protocol_test'}}));return;}
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','connection':'keep-alive'});
      const id='offline-'+randomUUID(),chunk=(delta,finish_reason=null)=>{
        if(!closed) res.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason}]})+'\n\n');
      };
      chunk({role:'assistant'});
      if(scenario==='cancel') {
        chunk({content:'OFFLINE FIXTURE — slow stream; cancel this synthetic turn. '});
        const timer=setInterval(()=>chunk({content:'waiting '}),200);timer.unref();
        const finish=setTimeout(()=>{clearInterval(timer);if(!closed){chunk({},'stop');res.end('data: [DONE]\n\n');}},30000);finish.unref();
        res.once('close',()=>{clearInterval(timer);clearTimeout(finish);void record({kind:'stream-closed',scenario});});return;
      }
      if(scenario==='truncated') {chunk({content:'OFFLINE INCOMPLETE'});setTimeout(()=>res.destroy(),100).unref();return;}
      const calls=scenario==='tools'?[
        ['read',{file_path:path}],
        ['edit',{file_path:path,old_string:'D05_ALPHA',new_string:'D05_BETA',replace_all:false}],
        ['write',{file_path:path+'.written',content:'D05_WRITTEN synthetic model tool bytes\n'}],
        ['search',{query:'D05_BETA',mode:'content'}],
        ['bash',{description:'Read the synthetic bound project path and checksum',command:'printf "D05_COMMAND_CWD="; pwd; printf "D05_COMMAND_FILE="; /usr/bin/sha256sum -- '+JSON.stringify(path)}],
        ['ask_user_question',{questions:[{id:'synthetic-choice',question:'Offline protocol test only: choose a fixture label.',options:[{label:'Synthetic A'},{label:'Synthetic B'}],multi_select:false}]}],
      ]:scenario==='write'? [['write',{file_path:path,content:'D05_APPROVED_ONCE\n'}]]:scenario==='escape'?[['read',{file_path:path}]]:[];
      if(step<calls.length) {
        const [name,args]=calls[step],callId='offline-call-'+randomUUID();
        chunk({tool_calls:[{index:0,id:callId,type:'function',function:{name,arguments:''}}]});
        const serialized=JSON.stringify(args),mid=Math.max(1,Math.floor(serialized.length/2));
        chunk({tool_calls:[{index:0,function:{arguments:serialized.slice(0,mid)}}]});
        chunk({tool_calls:[{index:0,function:{arguments:serialized.slice(mid)}}]});chunk({},'tool_calls');
        await record({kind:'tool-call',scenario,step,name,call_id:callId});
      } else {
        const text='OFFLINE PROTOCOL FIXTURE COMPLETE — not a real LLM response. '+(scenario==='tools'?'Native tool sequence returned '+step+' results.':'Synthetic '+scenario+'.');
        for(const part of [text.slice(0,35),text.slice(35,70),text.slice(70)]) chunk({content:part});chunk({},'stop');
      }
      res.end('data: [DONE]\n\n');
    } catch(error) {
      await record({kind:'fixture-error',code:error.message});if(!res.headersSent) res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Offline fixture protocol rejected'}}));
    }
  });
  await new Promise((done,fail)=>{server.once('error',fail);server.listen(0,host,done);});
  const port=server.address().port,origin=`http://${host.includes(':')?'['+host+']':host}:${port}`;
  const config={kind:'offline-protocol-fixture',enabled:true,pid:process.pid,baseURL:origin+'/v1',controlTimeoutMs:15000};
  await writeFile(join(root,'offline-model-fixture.json'),JSON.stringify(config,null,2),{mode:0o600});
  return {server,config};
}
if(process.argv[1] && resolve(process.argv[1])===new URL(import.meta.url).pathname) {
  const root=process.argv[2],host=process.argv[3];if(!root || !host) throw new Error('Usage: model.fixture.mjs <owned-root> <explicit-loopback>');
  const {server,config}=await fixture(root,host);console.log(JSON.stringify(config));
  for(const signal of ['SIGTERM','SIGINT']) process.once(signal,()=>{server.closeAllConnections();server.close();});
}
