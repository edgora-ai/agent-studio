"""Independent read-only observation of this D02 binding's files and exact PIDs."""
import importlib.util
import json
from pathlib import Path
import sys

REPO=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('d02_broker',REPO/'packages/dsh-agent-studio/adapters/coder_broker.py')
broker=importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)
root=broker.owned_root(sys.argv[1])
request=json.loads(sys.stdin.read())
binding,target=broker.context(root,request['binding_id'],str(request['version']))
broker.require(broker.current()==target['expected'],'D02_OBSERVER_INSTANCE_CHANGED')
paths=request.get('paths',[])
pids=request.get('pids',[])
broker.require(len(paths)<=20 and all(isinstance(p,str) and p and not p.startswith('/') and all(part not in ('','..','.') for part in p.split('/')) for p in paths),'D02_OBSERVER_PATHS')
broker.require(len(pids)<=20 and all(type(p) is int and p>1 for p in pids),'D02_OBSERVER_PIDS')
script='''import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]); inputs=json.loads(sys.argv[2]); files=[]; processes=[]
for relative in inputs['paths']:
 p=root/relative
 if p.is_symlink() or not p.resolve().is_relative_to(root): raise RuntimeError('path boundary')
 if not p.exists(): files.append({'path':relative,'exists':False}); continue
 data=p.read_bytes(); files.append({'path':relative,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
for pid in inputs['pids']:
 p=pathlib.Path('/proc')/str(pid)
 try:
  fields=(p/'stat').read_text().split(') ')[1].split()
  env=(p/'environ').read_bytes().split(b'\\0')
  processes.append({'pid':pid,'state':fields[0],'start_tick':fields[19],'cwd':str((p/'cwd').resolve()),'coder_credentials_present':any(v.startswith((b'CODER_SESSION_TOKEN=',b'CODER_AGENT_TOKEN=')) for v in env)})
 except FileNotFoundError: processes.append({'pid':pid,'exists':False})
print(json.dumps({'root':str(root),'files':files,'processes':processes}))
'''
container=broker.transport.container_for('m1-a')
result=broker.transport.lab.execute(['docker','exec',container,'python3','-I','-c',script,binding['target_root'],json.dumps({'paths':paths,'pids':pids})],timeout=20)
print(json.dumps(json.loads(result)))
