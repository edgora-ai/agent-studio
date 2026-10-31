#!/usr/bin/env python3
"""Original dsh UI + installed adapter/native Agent, explicit offline protocol only."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import sqlite3
from urllib.parse import urlsplit
from uuid import uuid4
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--root', required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--browser', required=True)
args = parser.parse_args()
root = Path(args.root); out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
fixture = json.loads((root/'offline-model-fixture.json').read_text())
assert fixture['enabled'] and fixture['kind'] == 'offline-protocol-fixture'
key = (root/'offline-fixture-credential.txt').read_text()
origin = json.loads((root/'ready.json').read_text())['origin']
run = str(uuid4()); alias = 'studio-model-browser'; model_name = 'Offline browser fixture - NOT LLM'
ids = {kind: json.loads((root/('model-'+kind+'-demo.json')).read_text()) for kind in ['local', 'remote']}
report = {'scope': 'D05 original UI; explicit offline protocol fixture, NOT real LLM acceptance', 'run': run,
          'checks': [], 'http_errors': [], 'rpc_errors': [], 'js_errors': [], 'console_errors': [], 'external_requests': []}
prompts = []; selected = []; active_sessions = set()

def scrub(value):
    return re.sub(r'([?&]token=)[^\s"&]+', r'\1[redacted]', str(value).replace(key, '[synthetic-key-redacted]'))

def sql(query, values=()):
    with sqlite3.connect('file:'+str(root/'bindings.sqlite')+'?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute(query, values)]

def nodes(value):
    if isinstance(value, dict):
        yield value
        for child in value.values(): yield from nodes(child)
    elif isinstance(value, list):
        for child in value: yield from nodes(child)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=args.browser, headless=True)
    context = browser.new_context(viewport={'width': 1600, 'height': 1050})
    def route(r):
        if r.request.url.startswith(origin+'/'): r.continue_()
        else: report['external_requests'].append(urlsplit(r.request.url).netloc); r.abort()
    context.route('**/*', route)
    page = context.new_page()
    page.on('pageerror', lambda e: report['js_errors'].append(scrub(e)))
    page.on('console', lambda m: report['console_errors'].append(scrub(m.text)[:1000]) if m.type == 'error' else None)
    def response(r):
        path = urlsplit(r.url).path
        if r.status >= 400: report['http_errors'].append({'path': path, 'status': r.status})
        if r.request.method == 'POST' and path.startswith('/api/') and path != '/api/$events':
            try:
                body = r.json(); result = body.get('result', {})
                if result.get('ok') is False: report['rpc_errors'].append({'path': path, 'code': result.get('error', {}).get('code')})
                if path in ['/api/session/prompt', '/api/session/selectModel']:
                    request = r.request.post_data_json['payload']['args']['request']
                    entry = {'request': request, 'result': result}
                    (prompts if path.endswith('/prompt') else selected).append(entry)
            except Exception as error: report.setdefault('decode_errors', []).append({'path': path, 'error': type(error).__name__})
    page.on('response', response)
    def rpc(method, payload, channel='/agent-studio-rpc'):
        r = context.request.post(origin+channel+'/'+method, headers={'origin': origin},
            data={'type': 'client-request', 'rpcId': str(uuid4()), 'method': method, 'payload': payload})
        body = r.json(); assert r.status == 200 and body['result']['ok'], scrub(body)
        return body['result'].get('value')
    def passed(name, **facts):
        report['checks'].append({'name': name, **facts}); print('PASS '+name)
    def wait_for(check, timeout=60000):
        import time
        deadline = time.monotonic()+timeout/1000
        while time.monotonic() < deadline:
            value = check()
            if value: return value
            page.wait_for_timeout(100)
        raise AssertionError('D05_UI_WAIT_DEADLINE')
    def composer(): return page.locator('[contenteditable="true"][data-lexical-editor="true"]:visible').first
    def choose(kind):
        page.get_by_role('button', name='Choose workspace', exact=True).click()
        page.get_by_role('menuitem', name='D05 Model '+kind.title()+' · v1', exact=True).click()
        expect(page.get_by_role('button', name='Choose workspace', exact=True)).to_contain_text('D05 Model '+kind.title())
        # Workspace navigation first paints its label, then replaces the native
        # composer scope after the authenticated session/open result.
        page.wait_for_timeout(800)
    def send(text):
        composer().fill(text)
        count = len(prompts)
        page.get_by_role('button', name='Send message', exact=True).click()
        wait_for(lambda: len(prompts) > count)
        entry = prompts[-1]; assert entry['result'].get('ok'), scrub(entry['result'])
        assert entry['result']['value'] == {'accepted': True}
        request = entry['request']; active_sessions.add(request['sessionId']); return request
    def done(request):
        row = wait_for(lambda: next((r for r in sql('SELECT * FROM model_requests WHERE request_id=?', (request['requestId'],)) if r['state'] not in ['admitting', 'queued', 'running']), None))
        active_sessions.discard(request['sessionId']); return row
    def tools(kind):
        path = 'browser-'+kind+'-'+run+'.txt'
        rpc('fs.write', {'session_id': ids[kind]['session_id'], 'path': path, 'operation_id': str(uuid4()), 'encoding': 'utf8', 'data': 'D05_ALPHA browser native input\n', 'expected_version': None})
        request = send('[D05 scenario:tools] [D05 path:'+path+'] Explicit synthetic browser test '+run)
        for index in range(3):
            allow = page.get_by_role('button', name='Allow once', exact=True)
            allow.wait_for(state='visible', timeout=60000)
            pending = sql("SELECT * FROM model_controls WHERE request_id=? AND state='pending'", (request['requestId'],))
            assert len(pending) == 1 and pending[0]['kind'] == 'approval'
            if kind == 'local' and index == 1: assert not (Path(ids[kind]['target_root'])/(path+'.written')).exists()
            if index == 0: page.screenshot(path=str(out/(kind+'-approval.png')), full_page=True)
            allow.click()
            wait_for(lambda: sql('SELECT state FROM model_controls WHERE control_id=?', (pending[0]['control_id'],))[0]['state'] == 'answered')
        page.get_by_text('Synthetic B', exact=True).click(timeout=60000)
        page.screenshot(path=str(out/(kind+'-question.png')), full_page=True)
        page.get_by_role('button', name='Submit', exact=True).click()
        row = done(request); assert row['state'] == 'completed', row
        controls = sql('SELECT kind,state,delivery FROM model_controls WHERE request_id=?', (request['requestId'],))
        assert len(controls) == 4 and all(c['state'] == 'answered' and c['delivery'] == 'delivered' for c in controls)
        calls = sql('SELECT name,state FROM model_tool_calls WHERE request_id=?', (request['requestId'],))
        assert len(calls) == 6 and all(c['state'] == 'completed' for c in calls), calls
        events = rpc('session.get', {'session_id': request['sessionId']})['native']['inspection']['events']
        tool_results = [e for e in events if e['type'] == 'tool/result' and e['data']['turn'] == row['turn']]
        assert len(tool_results) == 6 and all(not e['data']['message']['isError'] for e in tool_results)
        data = rpc('fs.read', {'session_id': request['sessionId'], 'path': path})
        assert base64.b64decode(data['data']) == b'D05_BETA browser native input\n'
        if kind == 'local': assert (Path(ids[kind]['target_root'])/path).read_bytes() == base64.b64decode(data['data'])
        assert any(h['path'].endswith(path) for h in rpc('fs.search', {'session_id': request['sessionId'], 'query': 'content:D05_BETA'})['hits'])
        expect(page.locator('body')).to_contain_text('Native tool sequence returned 6 results.', timeout=20000)
        page.screenshot(path=str(out/(kind+'-complete.png')), full_page=True)
        passed('original '+kind+' UI Send -> six native tools -> three Allow once -> question Submit -> actual completion', request_id=request['requestId'], session_id=request['sessionId'], sha256=data['sha256'], controls=controls)
        return request, path
    try:
        page.goto((root/'login.url').read_text().strip(), wait_until='domcontentloaded')
        page.get_by_role('button', name='Account menu', exact=True).click(timeout=30000)
        page.get_by_role('menuitem', name='Settings', exact=True).click()
        page.get_by_role('button', name='Models', exact=True).click()
        if not page.get_by_role('button', name='Edit Offline Browser Protocol Fixture (studio-model-browser)', exact=True).count():
            page.get_by_role('button', name='Add model provider', exact=True).click()
            page.get_by_role('tab', name='Custom model API', exact=True).click()
            page.get_by_label('Provider ID', exact=True).fill(alias)
            page.get_by_label('Display name', exact=True).fill('Offline Browser Protocol Fixture')
            page.locator('input[aria-label="Base URL"]:visible').fill(fixture['baseURL'])
            page.locator('input[aria-label="API key"]:visible').fill(key)
            page.get_by_role('button', name='Add model', exact=True).click()
            page.get_by_label('Model ID 1', exact=True).fill('offline-protocol-v1')
            page.get_by_label('Display name 1', exact=True).fill(model_name)
            page.get_by_role('button', name='Create provider', exact=True).click()
            page.get_by_role('button', name='Add model provider', exact=True).wait_for(state='visible', timeout=30000)
            report['configuration_created_in_ui'] = True
        else: report['configuration_created_in_ui'] = False
        info = rpc('model.describe', {})
        assert info['providers'][alias]['baseURL'] == fixture['baseURL']
        assert info['providers'][alias]['apiKeyEnv'] == 'STUDIO_MODEL_BROWSER_API_KEY'
        config = sql("SELECT * FROM model_configurations WHERE state='active' ORDER BY revision DESC LIMIT 1")[0]
        assert json.loads(config['config_json'])['providers'] == info['providers'] and key not in config['config_json']
        vault = json.loads((root/'model-credentials.json').read_text())
        assert vault['references']['STUDIO_MODEL_BROWSER_API_KEY'] == key
        assert rpc('credentials/describe', {'args': {'refs': ['STUDIO_MODEL_BROWSER_API_KEY']}}, '/api')['STUDIO_MODEL_BROWSER_API_KEY']['configured']
        page.screenshot(path=str(out/'models-configured.png'), full_page=True)
        passed('original Models custom provider form -> settings revision -> SQL metadata -> private credential reference -> native catalog', revision=info['revision'], created=report['configuration_created_in_ui'])
        page.get_by_role('button', name='Close', exact=True).click()
        choose('local')
        def pick(name):
            count = len(selected)
            page.get_by_role('button', name=re.compile('^Select model, current')).click()
            page.get_by_role('menuitem').filter(has_text=re.compile('^Model')).click()
            page.get_by_role('menuitemradio', name=name, exact=True).click()
            wait_for(lambda: len(selected) > count and selected[-1]['result'].get('ok'))
        if model_name in page.get_by_role('button', name=re.compile('^Select model, current')).inner_text():
            pick('Offline protocol fixture — NOT LLM')
        pick(model_name)
        assert selected[-1]['request']['provider'] == alias
        selected_id = selected[-1]['request']['sessionId']
        assert sql('SELECT provider FROM model_selections WHERE session_id=?', (selected_id,))[0]['provider'] == alias
        passed('original model picker -> native selectModel -> persisted selection', session_id=selected_id, provider=alias)
        local_request, local_path = tools('local')
        cancel = send('[D05 scenario:cancel] Explicit synthetic UI cancel '+run)
        expect(page.locator('body')).to_contain_text('OFFLINE FIXTURE — slow stream', timeout=30000)
        with page.expect_response(lambda r: urlsplit(r.url).path == '/api/session/cancel') as cancelled:
            page.get_by_role('button', name='Stop generating', exact=True).click()
        assert cancelled.value.json()['result']['ok']
        assert done(cancel)['state'] == 'cancelled'
        page.reload(wait_until='domcontentloaded')
        expect(page.locator('body')).to_contain_text('Native tool sequence returned 6 results.', timeout=30000)
        assert local_request['sessionId'] in json.dumps(rpc('session/list', {'args': {'_request': {}}}, '/api'))
        page.screenshot(path=str(out/'cancel-reopened.png'), full_page=True)
        passed('original streaming stop -> cancelled journal -> reload/reopen preserves native history', request_id=cancel['requestId'])
        page.get_by_role('button', name='New session', exact=True).first.click()
        choose('local')
        page.get_by_role('button', name='Open right sidebar', exact=True).click()
        page.get_by_role('button', name='Files', exact=True).click()
        page.get_by_placeholder('Name or content: text (bounded search)').fill(local_path)
        hit = page.locator('[data-studio-search-hit]:visible').filter(has_text=local_path).filter(has_not_text=local_path+'.written')
        hit.get_by_role('button', name='Reference bound file snapshot', exact=True).click(timeout=60000)
        expect(page.locator('[data-composer-chip="reference"]')).to_have_count(1)
        state = page.evaluate('''() => {for(const el of document.querySelectorAll('[contenteditable="true"]')) if(el.__lexicalEditor) return el.__lexicalEditor.getEditorState().toJSON(); throw new Error('composer unavailable');}''')
        reference = next(n['ref'] for n in nodes(state) if n.get('type') == 'reference-chip')
        choose('remote')
        before = sql('SELECT count(*) n FROM model_requests')[0]['n']; count = len(prompts)
        page.get_by_role('button', name='Send message', exact=True).click()
        wait_for(lambda: len(prompts) > count)
        assert prompts[-1]['result']['error']['code'] == 'agent-studio/cross-binding-reference', prompts[-1]['result']
        assert sql('SELECT count(*) n FROM model_requests')[0]['n'] == before
        state = page.evaluate('''() => {for(const el of document.querySelectorAll('[contenteditable="true"]')) if(el.__lexicalEditor) return el.__lexicalEditor.getEditorState().toJSON(); throw new Error('composer unavailable');}''')
        assert next(n['ref'] for n in nodes(state) if n.get('type') == 'reference-chip') == reference
        page.screenshot(path=str(out/'cross-binding-draft.png'), full_page=True)
        passed('original bound reference chip -> cross-binding Send denied before admission -> identical editable draft retained')
        close_sidebar = page.get_by_role('button', name='Close right sidebar', exact=True)
        if close_sidebar.count(): close_sidebar.click()
        tools('remote')
        passed('corrected draft sends via native saved default on a new authoritative remote session')
        report['unexpected_http'] = [e for e in report['http_errors'] if not (e['status'] == 409 and e['path'] in ['/sidebar/api/changes.ops', '/sidebar/api/git.graph', '/sidebar/api/git.branch', '/sidebar/api/git.commit-model', '/sidebar/api/git.diff-head'])]
        disabled_reads = ['/api/skills/list', '/api/schedule/catalog', '/api/schedule/list', '/api/llm/discoverModels']
        report['unexpected_rpc'] = [e for e in report['rpc_errors'] if not (e['path'] in disabled_reads and e['code'] == 'agent-studio/disabled') and e != {'path': '/api/session/prompt', 'code': 'agent-studio/cross-binding-reference'}]
        report['unexpected_console'] = [e for e in report['console_errors'] if e != 'Failed to load resource: the server responded with a status of 409 (Conflict)']
        assert not any(report[k] for k in ['js_errors', 'unexpected_http', 'unexpected_rpc', 'unexpected_console', 'external_requests', 'decode_errors'] if k in report), 'Unexpected browser errors (see report)'
        report['result'] = 'pass-limited-development'
    except Exception as error:
        report['result'] = 'fail'; report['failure'] = scrub(error)
        # Password values are never extracted, and are masked before failure capture.
        page.locator('input[type=password]').evaluate_all('(els)=>els.forEach(el=>{el.value=""})')
        report['buttons'] = page.get_by_role('button').evaluate_all('(els)=>els.map(e=>({text:e.innerText,label:e.getAttribute("aria-label")}))')
        report['body'] = scrub(page.locator('body').inner_text())
        page.screenshot(path=str(out/'failure.png'), full_page=True)
    finally:
        for session in active_sessions:
            try: rpc('session/cancel', {'args': {'request': {'sessionId': session}}}, '/api')
            except Exception as error: report.setdefault('cleanup_errors', []).append(scrub(error))
        (out/'browser.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps({'result': report.get('result'), 'checks': len(report['checks']), 'failure': report.get('failure'), 'evidence': str(out/'browser.json')}, ensure_ascii=False))
        browser.close()
        if report['result'] == 'fail': raise SystemExit(1)
