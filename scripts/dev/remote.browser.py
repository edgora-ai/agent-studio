#!/usr/bin/env python3
"""Drive the original sidebar editor and native terminal, not a replacement UI."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import subprocess
from urllib.parse import urlsplit, parse_qs
from uuid import uuid4
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

parser=argparse.ArgumentParser()
parser.add_argument('--root',required=True)
parser.add_argument('--out',required=True)
parser.add_argument('--browser',required=True)
args=parser.parse_args()
root=Path(args.root);out=Path(args.out);out.mkdir(parents=True,exist_ok=True)
repo=Path(__file__).resolve().parents[2]
fixture=json.loads((repo/'artifacts/d02/ui-fixture.json').read_text())
origin=json.loads((root/'ready.json').read_text())['origin']
report={'scope':'D03 development UI only; not M1/M2 acceptance','origin':origin,'checks':[],'http_failures':[],'rpc_failures':[],'js_errors':[],'console_errors':[],'external_requests':[]}
terminal_ids=[];save_sessions=[];frames=[]

def scrub(value):return re.sub(r'([?&]token=)[^\s"&]+',r'\1[redacted]',str(value))
def observe(paths,pids=[]):
    result=subprocess.run(['/usr/bin/python3','-I',str(repo/'scripts/dev/observe_remote.py'),str(root)],input=json.dumps({**fixture,'paths':paths,'pids':pids}),text=True,capture_output=True,timeout=90,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})
    assert result.returncode==0,'Independent observer failed; diagnostics withheld'
    return json.loads(result.stdout)

def response_event(response):
    path=urlsplit(response.url).path
    if response.status>=400:report['http_failures'].append({'path':path,'status':response.status})
    if path=='/sidebar/write':save_sessions.append(parse_qs(urlsplit(response.url).query)['sessionId'][0])
    if response.request.method=='POST' and path.startswith('/api/'):
        try:
            envelope=response.json().get('result',{})
            if envelope.get('ok') is False:report['rpc_failures'].append({'path':path,'code':envelope.get('error',{}).get('code')})
            if path=='/api/terminal/create' and envelope.get('ok'):
                payload=response.request.post_data_json['payload']['args'];terminal_ids.append({'sessionId':payload['agentId'],'id':envelope['value']['id']})
        except Exception as error:report['http_failures'].append({'path':path,'read_error':type(error).__name__})

with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=args.browser,headless=True)
    context=browser.new_context(viewport={'width':1440,'height':1000})
    def route(r):
        if r.request.url.startswith(origin+'/'):r.continue_()
        else:report['external_requests'].append(urlsplit(r.request.url).netloc);r.abort()
    context.route('**/*',route)
    page=context.new_page()
    page.on('pageerror',lambda e:report['js_errors'].append(scrub(e)))
    page.on('console',lambda m:report['console_errors'].append(scrub(m.text)) if m.type=='error' else None)
    page.on('response',response_event)
    page.on('websocket',lambda ws:ws.on('framereceived',lambda data:frames.append(data) if isinstance(data,str) else None))
    def rpc(method,payload,channel='/agent-studio-rpc'):
        response=context.request.post(origin+channel+'/'+method,headers={'origin':origin},data={'type':'client-request','rpcId':str(uuid4()),'method':method,'payload':payload})
        result=response.json();assert response.status==200 and result['result']['ok'],scrub(result)
        return result['result'].get('value')
    try:
        page.goto((root/'login.url').read_text().strip(),wait_until='domcontentloaded')
        try:page.wait_for_load_state('networkidle',timeout=5000)
        except PlaywrightTimeout:report['network_idle']=False
        page.get_by_role('button',name='Open right sidebar',exact=True).click()
        page.get_by_role('button',name='Files',exact=True).click()
        page.get_by_text(fixture['relative'],exact=True).click()
        editor=page.locator('.cm-content[contenteditable="true"]')
        editor.wait_for(state='visible',timeout=20000)
        content='D03 browser edit 中文 '+str(uuid4())+'\n'
        editor.click();page.keyboard.press('Control+a');page.keyboard.insert_text(content)
        with page.expect_response(lambda r:urlsplit(r.url).path=='/sidebar/write',timeout=30000) as saved:
            page.get_by_role('button',name='Save',exact=True).click()
        assert saved.value.status==200 and saved.value.json()['value']['ok']
        assert save_sessions
        session_id=save_sessions[-1]
        db=sqlite3.connect('file:'+str(root/'bindings.sqlite')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
        binding=dict(db.execute('SELECT * FROM session_bindings WHERE session_id=?',(session_id,)).fetchone())
        assert binding['binding_id']==fixture['binding_id'] and binding['version']==fixture['version']
        physical=observe([fixture['relative']]);assert physical['files'][0]['sha256']==hashlib.sha256(content.encode()).hexdigest()
        read=rpc('fs.read',{'session_id':session_id,'path':fixture['relative']});assert base64.b64decode(read['data']).decode()==content
        assert any(e['name']==fixture['relative'] for e in rpc('fs.list',{'session_id':session_id,'path':''})['entries'])
        saved_op=dict(db.execute("SELECT * FROM operation_records WHERE session_id=? AND kind='fs.write' ORDER BY rowid DESC LIMIT 1",(session_id,)).fetchone())
        assert saved_op==rpc('operation.get',{'operation_id':saved_op['operation_id']})
        assert saved_op in rpc('operation.list',{'session_id':session_id})
        report['checks'].append({'name':'original Files tree/open/edit/save -> independent remote bytes -> full read/list and SQL operation identity','session':binding,'file':physical,'operation_id':saved_op['operation_id']})
        page.screenshot(path=str(out/'files.png'),full_page=True)
        # Original pane registry menu, then original native TerminalController client.
        page.get_by_role('button',name='New tab',exact=True).first.click()
        page.get_by_role('button',name='New terminal',exact=True).click()
        terminal=page.locator('.xterm-helper-textarea')
        terminal.wait_for(state='attached',timeout=60000)
        page.wait_for_timeout(1500)
        marker='ui-terminal-'+str(uuid4())+'.txt'
        proof='D03-REMOTE-UI-'+str(uuid4())
        command="printf '%s\\n' '"+proof+"' > "+marker+"; cat "+marker+"; pwd\n"
        terminal.focus();page.keyboard.insert_text(command.rstrip('\n'));page.keyboard.press('Enter')
        assert terminal_ids,'Original terminal/create response not observed'
        owned=terminal_ids[-1];assert owned['sessionId']==session_id
        task=dict(db.execute("SELECT * FROM operation_records WHERE session_id=? AND kind='pty.open' ORDER BY rowid DESC LIMIT 1",(session_id,)).fetchone())
        output=''
        for _ in range(30):
            result=rpc('task.read',{'session_id':session_id,'operation_id':task['operation_id']})
            output=''.join(base64.b64decode(chunk['data']).decode(errors='replace') for chunk in result['chunks'])
            if proof in output and '\r\n'+fixture['target_root'] in output:break
            page.wait_for_timeout(300)
        assert proof in output and '\r\n'+fixture['target_root'] in output,'Remote PTY command output missing'
        terminal_file=observe([marker],[task['remote_pid']])
        assert terminal_file['files'][0]['sha256']==hashlib.sha256((proof+'\n').encode()).hexdigest()
        assert terminal_file['processes'][0]['cwd']==fixture['target_root'] and not terminal_file['processes'][0]['coder_credentials_present']
        page.wait_for_timeout(1000);page.screenshot(path=str(out/'terminal.png'),full_page=True)
        assert any(proof in frame for frame in frames),'Browser did not receive native terminal output'
        report['checks'].append({'name':'original native terminal keyboard -> remote PTY -> browser output -> independent file/PID','terminal':owned,'operation_id':task['operation_id'],'remote':terminal_file,'output':output})
        rpc('terminal/close',{'args':{'agentId':session_id,'id':owned['id']}},'/api');terminal_ids.remove(owned)
        closed=rpc('operation.get',{'operation_id':task['operation_id']});assert closed['state']=='released'
        after=observe([],[task['remote_pid']])['processes'][0]
        before=terminal_file['processes'][0]
        assert after.get('exists') is False or after.get('state')=='Z' or after.get('start_tick')!=before['start_tick']
        report['checks'].append({'name':'native terminal close -> cancelled/released -> independent PID/startTick stopped','after':after})
        db.close()
        report['unexpected_rpc']=[x for x in report['rpc_failures'] if x!={'path':'/api/skills/list','code':'agent-studio/disabled'}]
        report['unexpected_http']=[x for x in report['http_failures'] if not(x.get('status')==409 and (x['path'].startswith('/sidebar/api/git.') or x['path']=='/sidebar/api/changes.ops'))]
        report['unexpected_console']=[x for x in report['console_errors'] if x!='Failed to load resource: the server responded with a status of 409 (Conflict)' and not('/sidebar/ws/fs-watch?' in x and 'Unexpected response code: 403' in x)]
        assert not report['js_errors'] and not report['unexpected_rpc'] and not report['unexpected_http'] and not report['unexpected_console'], 'Unexpected browser error'
        assert not report['external_requests']
        report['result']='pass'
    except Exception as error:
        report['result']='fail';report['failure']=scrub(error)
        page.screenshot(path=str(out/'failure.png'),full_page=True)
    finally:
        for owned in terminal_ids:
            try:rpc('terminal/close',{'args':{'agentId':owned['sessionId'],'id':owned['id']}},'/api')
            except Exception as error:report.setdefault('cleanup_failures',[]).append(scrub(error));report['result']='fail'
        (out/'browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
        print(json.dumps({'result':report.get('result'),'checks':len(report['checks']),'failure':report.get('failure'),'evidence':str(out/'browser.json')},ensure_ascii=False))
        browser.close()
        if report['result']!='pass':raise SystemExit(1)
