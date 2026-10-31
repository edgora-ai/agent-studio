#!/usr/bin/env python3
"""Original sidebar Git/search/reference + native-terminal external-change flow."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import shlex
import sqlite3
import subprocess
from urllib.parse import urlsplit
from uuid import uuid4
from playwright.sync_api import sync_playwright, expect, TimeoutError as PlaywrightTimeout

parser=argparse.ArgumentParser()
parser.add_argument('--root',required=True)
parser.add_argument('--out',required=True)
parser.add_argument('--browser',required=True)
parser.add_argument('--inspect',action='store_true')
parser.add_argument('--local',action='store_true')
args=parser.parse_args()
root=Path(args.root);out=Path(args.out);out.mkdir(parents=True,exist_ok=True)
repo=Path(__file__).resolve().parents[2]
f=json.loads((repo/('artifacts/d04/ui-fixture.json' if args.local else 'artifacts/d03/ui-fixture.json')).read_text())
workspace='D04 Local Project' if args.local else 'D02 Remote Project'
other_workspace='D02 Remote Project' if args.local else 'D01 Preview Project'
kind='local' if args.local else 'remote'
origin=json.loads((root/'ready.json').read_text())['origin']
report={'scope':('D04-local' if args.local else 'D03-core')+' original UI, development only','checks':[],'http_errors':[],'rpc_errors':[],'js_errors':[],'console_errors':[],'external_requests':[]}
terminals=[];replies=[];watch_frames=[]
def scrub(v):return re.sub(r'([?&]token=)[^\s"&]+',r'\1[redacted]',str(v))
def observe(paths,pids=[]):
    if args.local:
        files=[];processes=[]
        for rel in paths:
            assert not rel.startswith('/') and '..' not in Path(rel).parts
            target=Path(f['target_root'])/rel
            assert target.resolve()==target
            data=target.read_bytes();files.append({'path':rel,'size':len(data),'sha256':hashlib.sha256(data).hexdigest()})
        for pid in pids:
            try:
                fields=Path('/proc/'+str(pid)+'/stat').read_text().split(') ')[1].split()
                env=Path('/proc/'+str(pid)+'/environ').read_bytes().split(b'\0')
                names=[item.split(b'=',1)[0].decode() for item in env if item]
                processes.append({'pid':pid,'exists':True,'state':fields[0],'start_tick':fields[19],'coder_credentials_present':any(re.search('TOKEN|SECRET|CREDENTIAL|CODER_',name) for name in names),'env_names':names})
            except FileNotFoundError:processes.append({'pid':pid,'exists':False})
        return {'files':files,'processes':processes}
    r=subprocess.run(['/usr/bin/python3','-I',str(repo/'scripts/dev/observe_remote.py'),str(root)],input=json.dumps({**f,'paths':paths,'pids':pids}),text=True,capture_output=True,timeout=90,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})
    assert r.returncode==0,'readonly observer failed; diagnostics withheld'
    return json.loads(r.stdout)

with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=args.browser,headless=True)
    context=browser.new_context(viewport={'width':1600,'height':1050})
    def route(r):
        if r.request.url.startswith(origin+'/'):r.continue_()
        else:report['external_requests'].append(urlsplit(r.request.url).netloc);r.abort()
    context.route('**/*',route)
    page=context.new_page()
    page.on('pageerror',lambda e:report['js_errors'].append(scrub(e)))
    page.on('console',lambda m:report['console_errors'].append(scrub(m.text)[:1000]) if m.type=='error' else None)
    def response(r):
        path=urlsplit(r.url).path
        if r.status>=400:report['http_errors'].append({'path':path,'status':r.status})
        if r.request.method=='POST' and (path.startswith('/sidebar/api/') or path.startswith('/api/')):
            try:
                body=r.json();request=r.request.post_data_json
                if path.startswith('/api/'):
                    result=body.get('result',{})
                    if result.get('ok') is False:report['rpc_errors'].append({'path':path,'code':result.get('error',{}).get('code')})
                    if path=='/api/terminal/create' and result.get('ok'):terminals.append({'sessionId':request['payload']['args']['agentId'],'id':result['value']['id']})
                else:replies.append({'path':path,'request':request,'body':body})
            except Exception as e:report.setdefault('decode_errors',[]).append({'path':path,'error':type(e).__name__})
    page.on('response',response)
    page.on('websocket',lambda ws:ws.on('framereceived',lambda data:watch_frames.append(data) if isinstance(data,str) and '/sidebar/ws/fs-watch' in ws.url else None))
    def rpc(method,payload,channel='/agent-studio-rpc'):
        r=context.request.post(origin+channel+'/'+method,headers={'origin':origin},data={'type':'client-request','rpcId':str(uuid4()),'method':method,'payload':payload})
        body=r.json();assert r.status==200 and body['result']['ok'],scrub(body)
        return body['result'].get('value')
    def pass_check(name,**facts):report['checks'].append({'name':name,**facts});print('PASS '+name)
    try:
        page.goto((root/'login.url').read_text().strip(),wait_until='domcontentloaded')
        try:page.wait_for_load_state('networkidle',timeout=7000)
        except PlaywrightTimeout:report['network_idle']=False
        report['initial_buttons']=page.get_by_role('button').evaluate_all('(els)=>els.map(e=>({text:e.innerText,title:e.title,label:e.getAttribute("aria-label")}))')
        page.get_by_role('button',name='Choose workspace',exact=True).click()
        report['workspaces']=page.get_by_role('menuitem').all_text_contents()
        page.get_by_role('menuitem',name=workspace+' · v1',exact=True).click()
        page.get_by_role('button',name='Open right sidebar',exact=True).click()
        page.get_by_role('button',name='Files',exact=True).click()
        query=page.get_by_placeholder('Name or content: text (bounded search)')
        query.fill('content:'+f['needle'])
        hit=page.locator('[data-studio-search-hit]:visible').filter(has_text='中文 file.txt')
        hit.wait_for(state='visible',timeout=60000)
        assert ':2' in hit.inner_text()
        hit.get_by_role('button').first.click()
        editor=page.locator('.cm-content[contenteditable="true"]:visible')
        editor.wait_for(state='visible',timeout=30000)
        assert f['needle'] in editor.inner_text()
        search=next(v for v in reversed(replies) if v['path']=='/sidebar/api/fs.search' and v['body'].get('ok'))
        session=search['body']['value']['identity']['session_id'];assert search['body']['value']['identity']['binding_id']==f['binding_id']
        pass_check('original content search -> line-bearing result -> original file editor',identity=search['body']['value']['identity'])
        if args.local:
            content=Path(f['absolute']).read_text()+'UI_LOCAL_SAVE_'+str(uuid4())+'\n'
            editor.click();page.keyboard.press('Control+a');page.keyboard.insert_text(content)
            with page.expect_response(lambda r:urlsplit(r.url).path=='/sidebar/write',timeout=30000) as saved:
                page.get_by_role('button',name='Save',exact=True).click()
            assert saved.value.status==200 and saved.value.json()['ok']
            assert Path(f['absolute']).read_text()==content
            assert base64.b64decode(rpc('fs.read',{'session_id':session,'path':f['path']})['data']).decode()==content
            expect(page.locator('[data-studio-watch]')).to_contain_text('Local polling',timeout=30000)
            page.screenshot(path=str(out/'local-save.png'),full_page=True)
            pass_check('original local Files Save -> physical UTF8/hash -> full API',sha256=hashlib.sha256(content.encode()).hexdigest())
        page.locator('[data-slot="sidebar.right.pane.tab.title"]').filter(has_text=re.compile('^Files$')).click()
        with page.expect_response(lambda r:urlsplit(r.url).path=='/sidebar/api/reference.create',timeout=30000) as referenced:
            hit.get_by_role('button',name='Reference bound file snapshot',exact=True).click()
        reference=referenced.value.json()['value'];assert reference['identity']['session_id']==session
        chip=page.locator('[data-composer-chip="reference"]');chip.wait_for(state='visible',timeout=15000)
        assert '中文 file.txt' in chip.inner_text()
        state=page.evaluate('''() => {for(const el of document.querySelectorAll('[contenteditable="true"]')) {if(el.__lexicalEditor) return el.__lexicalEditor.getEditorState().toJSON();} throw new Error('native composer state unavailable');}''')
        def nodes(value):
            if isinstance(value,dict):
                yield value
                for x in value.values():yield from nodes(x)
            elif isinstance(value,list):
                for x in value:yield from nodes(x)
        stored=next(node for node in nodes(state) if node.get('type')=='reference-chip')
        assert stored['ref']==reference['text']
        citation=json.loads(stored['ref'].split('\n',1)[1]);assert citation['identity']['session_id']==session and citation['path']==f['absolute']
        assert citation['content']==base64.b64decode(rpc('fs.read',{'session_id':session,'path':f['path']})['data']).decode('utf-8')
        pass_check('native composer chip carries exact bound/versioned '+kind+' snapshot, no model call',citation={k:v for k,v in citation.items() if k!='content'})
        page.screenshot(path=str(out/'search-reference.png'),full_page=True)
        held_terminal=None
        if args.local and not args.inspect:
            page.get_by_role('button',name='New tab',exact=True).first.click()
            page.get_by_role('button',name='New terminal',exact=True).click()
            expect(page.locator('.xterm-helper-textarea:visible')).to_be_editable(timeout=60000)
            held_terminal=terminals[-1]
            db_hold=sqlite3.connect('file:'+str(root/'bindings.sqlite')+'?mode=ro',uri=True);db_hold.row_factory=sqlite3.Row
            held_task=dict(db_hold.execute("SELECT * FROM operation_records WHERE session_id=? AND kind='pty.open' ORDER BY rowid DESC LIMIT 1",(session,)).fetchone());db_hold.close()
            assert held_task['local_pid'] and held_task['remote_pid'] is None
        page.get_by_role('button',name='Choose workspace',exact=True).click()
        page.get_by_role('menuitem',name=other_workspace+' · v1',exact=True).click()
        expect(page.get_by_role('button',name='Choose workspace',exact=True)).to_contain_text(other_workspace,timeout=20000)
        expect(page.locator('[data-studio-search-hit]:visible')).to_have_count(0,timeout=20000)
        migrated=page.evaluate('''() => {for(const el of document.querySelectorAll('[contenteditable="true"]')) if(el.__lexicalEditor) return el.__lexicalEditor.getEditorState().toJSON(); throw new Error('composer missing');}''')
        migrated_chip=next(node for node in nodes(migrated) if node.get('type')=='reference-chip')
        assert migrated_chip['ref']==stored['ref'] and 'appearance' not in migrated_chip
        assert kind in migrated_chip['label']
        other_id=json.loads((root/'remote-demo.json').read_text())['session_id'] if args.local else None
        other=next(s for s in rpc('session.list',{}) if s['session_id']==other_id) if args.local else next(s for s in rpc('session.list',{}) if s['binding_id']!=f['binding_id'])
        denied=context.request.post(origin+'/sidebar/api/reference.create',headers={'origin':origin},data={'sessionId':other['session_id'],'path':f['absolute']})
        assert denied.status==409
        page.screenshot(path=str(out/'other-binding.png'),full_page=True)
        if args.local and not args.inspect:
            expect(page.locator('.xterm-helper-textarea:visible')).to_have_count(0)
            rejected=context.request.post(origin+'/agent-studio-rpc/task.input',headers={'origin':origin},data={'type':'client-request','rpcId':str(uuid4()),'method':'task.input','payload':{'session_id':other['session_id'],'operation_id':held_task['operation_id'],'action_id':str(uuid4()),'data':'MUST_NOT_EXECUTE'}})
            assert rejected.json()['result']['error']['code']=='agent-studio/task-not-owned'
            assert rpc('task.status',{'session_id':session,'operation_id':held_task['operation_id']})['running']
            page.get_by_role('button',name='Open right sidebar',exact=True).click()
            page.get_by_role('button',name='Files',exact=True).click()
            remote_query=page.locator('input[placeholder="Name or content: text (bounded search)"]:visible')
            remote_query.fill('content:REMOTE_D04_'+f['runId'])
            remote_hit=page.locator('[data-studio-search-hit]:visible').filter(has_text='中文 file.txt');remote_hit.wait_for(state='visible',timeout=60000)
            remote_hit.get_by_role('button').first.click()
            expect(editor).to_contain_text('REMOTE_D04_'+f['runId'],timeout=30000)
            assert f['needle'] not in editor.inner_text()
            remote_result=next(v for v in reversed(replies) if v['path']=='/sidebar/api/fs.search' and v['body'].get('ok'))['body']['value']
            assert remote_result['identity']['kind']=='remote' and remote_result['identity']['session_id']==other['session_id']
            assert remote_result['hits'][0]['path'].endswith('/'+f['path'])
            page.screenshot(path=str(out/'remote-same-file.png'),full_page=True)
            rpc('terminal/close',{'args':{'agentId':session,'id':held_terminal['id']}},'/api');terminals.remove(held_terminal)
            held_after=observe([],[held_task['local_pid']])['processes'][0]
            assert not held_after.get('exists') or held_after.get('state')=='Z' or held_after.get('start_tick')!=held_task['local_start_ticks']
            pass_check('local to remote same filename has different editor bytes; old local PTY never changes owner and closes by exact identity',remote_identity=remote_result['identity'],local_task=held_task['operation_id'],local_after=held_after)
        page.get_by_role('button',name='Choose workspace',exact=True).click()
        page.get_by_role('menuitem',name=workspace+' · v1',exact=True).click()
        expect(page.locator('[data-composer-chip="reference"]:visible')).to_have_count(1,timeout=20000)
        pass_check('native blank-draft workspace transfer retains exact original-bound snapshot; cached results hidden and foreign path resolve denied',source_identity=citation['identity'],target_session=other['session_id'])
        expect(page.get_by_role('button',name='Choose workspace',exact=True)).to_contain_text(workspace,timeout=20000)
        # Native workspace switching restores this workspace's sidebar asynchronously.
        # Wait for its real tab bar, not the transient pre-restoration toggle.
        expect(page.get_by_role('button',name='New tab',exact=True).first).to_be_visible(timeout=20000)
        if args.local and not args.inspect:
            page.locator('[data-slot="sidebar.right.pane.tab.title"]').filter(has_text=re.compile('^中文 file.txt$')).first.click()
            expect(editor).to_contain_text(f['needle'],timeout=30000)
            assert 'REMOTE_D04_' not in editor.inner_text()
            page.screenshot(path=str(out/'local-restored-file.png'),full_page=True)
            pass_check('remote to local restores the original local file tab without remote bytes')
        if args.inspect:
            page.get_by_role('button',name='New tab',exact=True).first.click()
            page.get_by_role('button',name='Git',exact=True).click()
            page.wait_for_timeout(5000)
            report['buttons']=page.get_by_role('button').evaluate_all('(els)=>els.map(e=>({text:e.innerText,title:e.title,label:e.getAttribute("aria-label")}))')
            report['body']=page.locator('body').inner_text()
            page.screenshot(path=str(out/'changes-inspect.png'),full_page=True)
            report['result']='inspected'
        else:
            page.get_by_role('button',name='New tab',exact=True).first.click()
            page.get_by_role('button',name='Git',exact=True).click()
            row=page.locator('button[title='+json.dumps(f['path'],ensure_ascii=False)+']')
            expect(row).to_have_count(2,timeout=45000)
            assert page.get_by_role('button',name='Stage',exact=True).first.is_disabled()
            assert page.get_by_role('button',name='Commit',exact=True).is_disabled()
            for staged,index in [(True,0),(False,1)]:
                page.locator('[data-slot="sidebar.right.pane.tab.title"]').filter(has_text=re.compile('^Git$')).click()
                with page.expect_response(lambda r:urlsplit(r.url).path=='/sidebar/api/git.diff' and r.request.post_data_json.get('staged')==staged,timeout=45000) as diff_response:
                    row.nth(index).click()
                diff=diff_response.value.json()['value']
                assert diff['identity']['session_id']==session and diff['side']==('index' if staged else 'worktree')
                header=page.locator('button[aria-expanded]').filter(has_text=f['path'])
                header.wait_for(state='visible',timeout=30000)
                if header.get_attribute('aria-expanded')=='false':header.click()
                phrase=('local original' if args.local else 'D03_INDEX_'+f['runId']) if staged else f['needle']
                expect(page.locator('body')).to_contain_text(phrase,timeout=30000)
                page.screenshot(path=str(out/('git-index.png' if staged else 'git-worktree.png')),full_page=True)
                pass_check('original Changes -> '+('staged' if staged else 'worktree')+' Diff',identity=diff['identity'],repo_id=diff['repo_id'])
            page.locator('[data-slot="sidebar.right.pane.tab.title"]').filter(has_text=re.compile('^Git$')).click()
            row.nth(1).click(button='right')
            page.get_by_text('Open editor',exact=True).click()
            editor.wait_for(state='visible',timeout=30000)
            assert f['needle'] in editor.inner_text()
            pass_check('original Git/Diff context -> original file editor keeps binding')
            db=sqlite3.connect('file:'+str(root/'bindings.sqlite')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
            def terminal_write(content,tag):
                page.get_by_role('button',name='New tab',exact=True).first.click()
                page.get_by_role('button',name='New terminal',exact=True).click()
                terminal=page.locator('.xterm-helper-textarea:visible');terminal.wait_for(state='attached',timeout=60000)
                # xterm maps the native model's writable flag to textarea.readOnly.
                expect(terminal).to_be_editable(timeout=60000)
                script='from pathlib import Path; Path('+repr(f['path'])+').write_text('+repr(content)+',encoding="utf-8"); print('+repr(tag)+',flush=True)'
                terminal.focus();page.keyboard.insert_text('python3 -I -c '+shlex.quote(script));page.keyboard.press('Enter')
                assert terminals
                owned=terminals[-1];assert owned['sessionId']==session
                task=dict(db.execute("SELECT * FROM operation_records WHERE session_id=? AND kind='pty.open' ORDER BY rowid DESC LIMIT 1",(session,)).fetchone())
                for _ in range(30):
                    result=rpc('task.read',{'session_id':session,'operation_id':task['operation_id']})
                    output=''.join(base64.b64decode(c['data']).decode(errors='replace') for c in result['chunks'])
                    lines=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',output).splitlines()
                    if tag in lines:break
                    page.wait_for_timeout(200)
                report.setdefault('terminal_outputs',[]).append(output[-6000:])
                assert tag in lines,'terminal command completion not observed'
                physical=observe([f['path']],[task['local_pid' if args.local else 'remote_pid']]);assert physical['files'][0]['sha256']==hashlib.sha256(content.encode()).hexdigest()
                assert not physical['processes'][0]['coder_credentials_present']
                page.screenshot(path=str(out/(tag+'.png')),full_page=True)
                rpc('terminal/close',{'args':{'agentId':session,'id':owned['id']}},'/api');terminals.remove(owned)
                assert rpc('operation.get',{'operation_id':task['operation_id']})['state']=='released'
                stopped=observe([],[task['local_pid' if args.local else 'remote_pid']])['processes'][0]
                assert stopped.get('exists') is False or stopped.get('state')=='Z' or stopped.get('start_tick')!=physical['processes'][0]['start_tick']
                page.locator('[data-slot="sidebar.right.pane.tab.title"]').filter(has_text=re.compile('^中文 file.txt$')).first.click()
                return {'operation_id':task['operation_id'],'physical':physical,'after':stopped}
            clean='worktree edited\n'+f['needle']+'\nCLEAN_REFRESH_'+str(uuid4())+'\n'
            fact=terminal_write(clean,'D03_CLEAN_DONE')
            expect(editor).to_contain_text(clean.splitlines()[-1],timeout=45000)
            pass_check('native terminal external edit -> clean editor automatically refreshes on '+kind+' polling',**fact)
            page.screenshot(path=str(out/'clean-refresh.png'),full_page=True)
            draft=clean+'UNSAVED_DRAFT_'+str(uuid4())+'\n'
            editor.click();page.keyboard.press('Control+a');page.keyboard.insert_text(draft)
            external='worktree edited\n'+f['needle']+'\nEXTERNAL_CONFLICT_'+str(uuid4())+'\n'
            fact=terminal_write(external,'D03_CONFLICT_DONE')
            page.get_by_role('button',name='Reload from disk',exact=True).wait_for(state='visible',timeout=45000)
            assert 'UNSAVED_DRAFT_' in editor.inner_text() and 'EXTERNAL_CONFLICT_' not in editor.inner_text()
            with page.expect_response(lambda r:urlsplit(r.url).path=='/sidebar/write',timeout=30000) as saved:
                page.get_by_role('button',name='Save',exact=True).click()
            assert saved.value.status==409 and saved.value.json()['error']['code']=='conflict'
            assert observe([f['path']])['files'][0]['sha256']==hashlib.sha256(external.encode()).hexdigest()
            pass_check('native terminal external edit -> dirty draft retained, conflict banner and strong-CAS rejection',**fact)
            page.screenshot(path=str(out/'dirty-conflict.png'),full_page=True)
            db.close()
            allowed={'/sidebar/api/changes.ops','/sidebar/api/git.graph','/sidebar/api/git.branch','/sidebar/api/git.commit-model','/sidebar/api/git.diff-head','/sidebar/write'}
            report['unexpected_http']=[e for e in report['http_errors'] if not(e['path'] in allowed and e['status']==409)]
            report['unexpected_rpc']=[e for e in report['rpc_errors'] if e not in [{'path':'/api/skills/list','code':'agent-studio/disabled'},{'path':'/api/schedule/catalog','code':'agent-studio/disabled'}]]
            report['unexpected_console']=[e for e in report['console_errors'] if e!='Failed to load resource: the server responded with a status of 409 (Conflict)']
            assert not report['js_errors'] and not report['unexpected_http'] and not report['unexpected_rpc'] and not report['unexpected_console'] and not report['external_requests']
            report['result']='pass-limited-development'
    except Exception as error:
        report['result']='fail';report['failure']=scrub(error)
        report['buttons']=page.get_by_role('button').evaluate_all('(els)=>els.map(e=>({text:e.innerText,title:e.title,label:e.getAttribute("aria-label")}))')
        report['body']=page.locator('body').inner_text()
        page.screenshot(path=str(out/'failure.png'),full_page=True)
    finally:
        for terminal in terminals:
            try:rpc('terminal/close',{'args':{'agentId':terminal['sessionId'],'id':terminal['id']}},'/api')
            except Exception as e:report.setdefault('cleanup_errors',[]).append(scrub(e))
        report['watch_frames']=watch_frames
        (out/'browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
        print(json.dumps({'result':report.get('result'),'checks':len(report['checks']),'failure':report.get('failure'),'evidence':str(out/'browser.json')},ensure_ascii=False))
        browser.close()
        if report['result']=='fail':raise SystemExit(1)
