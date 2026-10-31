#!/usr/bin/env python3
"""Original sidebar and original approval/question UI, offline ACP peer only."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import time
from urllib.parse import urlsplit
from uuid import uuid4
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--root', required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--browser', required=True)
args = parser.parse_args()
root, out = Path(args.root), Path(args.out)
out.mkdir(parents=True, exist_ok=False)
origin = json.loads((root/'ready.json').read_text())['origin']
run = str(uuid4())
report = {'scope': 'D06 original UI + installed ACP client + real local/m1-a stdio, OFFLINE peer; not real CLI/SC-12 or actual-phone acceptance', 'run': run, 'checks': [], 'js_errors': [], 'console_errors': [], 'http_errors': [], 'rpc_errors': [], 'external_requests': []}
starts, active = [], {}


def scrub(value):
    return re.sub(r'([?&]token=)[^\s"&]+', r'\1[redacted]', str(value))


def sql(query, values=()):
    with sqlite3.connect('file:'+str(root/'bindings.sqlite')+'?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute(query, values)]


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=args.browser, headless=True)
    context = browser.new_context(viewport={'width': 1600, 'height': 1050})
    def route(r):
        if r.request.url.startswith(origin+'/'): r.continue_()
        else: report['external_requests'].append(urlsplit(r.request.url).netloc); r.abort()
    context.route('**/*', route)
    page = context.new_page()
    page.on('pageerror', lambda error: report['js_errors'].append(scrub(error)))
    page.on('console', lambda message: report['console_errors'].append(scrub(message.text)[:1200]) if message.type == 'error' else None)
    def response(r):
        path = urlsplit(r.url).path
        if r.status >= 400: report['http_errors'].append({'path': path, 'status': r.status})
        if r.request.method == 'POST' and (path.startswith('/api/') or path.startswith('/agent-studio-rpc/')) and path != '/api/$events':
            try:
                body = r.json(); result = body.get('result', {})
                if result.get('ok') is False: report['rpc_errors'].append({'path': path, 'code': result.get('error', {}).get('code')})
                if path == '/agent-studio-rpc/acp.start': starts.append({'request': r.request.post_data_json['payload'], 'result': result})
            except Exception as error: report.setdefault('decode_errors', []).append({'path': path, 'error': type(error).__name__})
    page.on('response', response)
    def rpc(method, payload, channel='/agent-studio-rpc'):
        r = context.request.post(origin+channel+'/'+method, headers={'origin': origin}, data={'type': 'client-request', 'rpcId': str(uuid4()), 'method': method, 'payload': payload}, timeout=100000)
        result = r.json()['result']; assert r.status == 200 and result['ok'], scrub(result)
        return result.get('value')
    def wait(check, timeout=120000):
        deadline = time.monotonic()+timeout/1000
        while time.monotonic() < deadline:
            value = check()
            if value: return value
            page.wait_for_timeout(100)
        raise AssertionError('D06_UI_WAIT_DEADLINE')
    def passed(name, **facts):
        report['checks'].append({'name': name, **facts}); print('PASS '+name)
    def choose(kind):
        page.get_by_role('button', name='Choose workspace', exact=True).click()
        page.get_by_role('menuitem', name='D06 ACP '+kind.title()+' · v1', exact=True).click()
        expect(page.get_by_role('button', name='Choose workspace', exact=True)).to_contain_text('D06 ACP '+kind.title())
        page.wait_for_timeout(800)
        opener = page.get_by_role('button', name='Open right sidebar', exact=True)
        if opener.count(): opener.click()
        page.get_by_role('button', name='ACP tasks', exact=True).click()
        expect(page.locator('[data-studio-acp]:visible')).to_be_visible()
        expect(page.locator('[data-studio-acp]:visible').get_by_label('ACP backend', exact=True)).to_be_visible()
    def submit(case):
        output = 'ui-acp-'+case+'-'+str(uuid4())+'.json'
        page.locator('[data-studio-acp]:visible').get_by_label('ACP task prompt', exact=True).fill(json.dumps({'case': case, 'output': output, 'marker': run}))
        count = len(starts); page.get_by_role('button', name='Start ACP task', exact=True).click()
        wait(lambda: len(starts)>count)
        entry = starts[-1]; assert entry['result'].get('ok'), entry
        task = entry['result']['value']; task['output'] = output; active[task['task_id']] = task
        return task
    def complete(task):
        row = wait(lambda: next((row for row in sql('SELECT * FROM acp_tasks WHERE task_id=?', (task['task_id'],)) if row['state'] not in ['starting', 'running', 'stopping']), None))
        assert rpc('acp.get', {'task_id': task['task_id']}) == row
        assert next(item for item in rpc('acp.tasks', {'session_id': task['session_id']}) if item['task_id'] == task['task_id']) == row
        active.pop(task['task_id'], None)
        return row
    def form(kind):
        task = submit('form')
        page.get_by_role('button', name='Allow once', exact=True).wait_for(state='visible', timeout=60000)
        control = sql("SELECT * FROM acp_controls WHERE request_id=? AND state='pending'", (task['request_id'],))[0]
        assert control['kind'] == 'approval'
        if kind == 'local': assert not (Path(json.loads((root/'acp-local-demo.json').read_text())['target_root'])/task['output']).exists()
        page.screenshot(path=str(out/(kind+'-approval.png')), full_page=True)
        page.get_by_role('button', name='Allow once', exact=True).click()
        question = page.locator('[data-question-key]:visible')
        # Original single-choice cards automatically advance to the next field.
        question.get_by_text('green', exact=True).click(timeout=60000)
        question.get_by_placeholder('Type your answer', exact=True).fill('5')
        question.get_by_role('button', name='Next', exact=True).click()
        question.get_by_text('False', exact=True).click()
        question.get_by_placeholder('Type your answer', exact=True).fill('Original '+kind+' UI answer 回传')
        page.screenshot(path=str(out/(kind+'-question.png')), full_page=True)
        question.get_by_role('button', name='Submit', exact=True).click()
        row = complete(task); assert row['state'] == 'completed', row
        data = rpc('fs.read', {'session_id': task['session_id'], 'path': task['output']})
        receipt = json.loads(base64.b64decode(data['data']))
        assert receipt['answer'] == {'color': 'green', 'count': 5, 'enabled': False, 'note': 'Original '+kind+' UI answer 回传'}
        assert hashlib.sha256(base64.b64decode(data['data'])).hexdigest() == data['sha256']
        assert receipt['selected_option'] == 'only-this-write'
        controls = sql('SELECT * FROM acp_controls WHERE request_id=?', (task['request_id'],))
        assert len(controls) == 2 and all(c['state'] == 'answered' and c['delivery'] == 'stdio-written-unconfirmed' for c in controls)
        assert not sql('SELECT * FROM model_requests WHERE session_id=?', (task['session_id'],))
        expect(page.locator('[data-acp-journal]:visible')).to_contain_text('answer_used', timeout=10000)
        page.screenshot(path=str(out/(kind+'-complete.png')), full_page=True)
        passed('original '+kind+' sidebar Start -> original Allow once -> original typed question Submit -> real peer answer/file -> SQL/API/history', task_id=task['task_id'], session_id=task['session_id'], receipt_sha256=data['sha256'], controls=[{'control_id': c['control_id'], 'state': c['state'], 'delivery': c['delivery']} for c in controls])
        return task
    try:
        page.goto((root/'login.url').read_text().strip(), wait_until='domcontentloaded')
        choose('local')
        local = form('local')
        for case in ['reject', 'timeout']:
            task = submit(case)
            page.get_by_role('button', name='Allow once', exact=True).wait_for(state='visible', timeout=60000)
            if case == 'reject': page.get_by_role('button', name='Reject', exact=True).click()
            row = complete(task); assert row['state'] == 'refused', row
            control = sql('SELECT * FROM acp_controls WHERE request_id=?', (task['request_id'],))[0]
            assert control['state'] == ('rejected' if case == 'reject' else 'expired')
            target = Path(json.loads((root/'acp-local-demo.json').read_text())['target_root'])/task['output']; assert not target.exists()
            page.screenshot(path=str(out/('local-'+case+'.png')), full_page=True)
            passed('original '+case+' UI path; blocking peer refused without file side effect', task_id=task['task_id'], control_id=control['control_id'])
        task = submit('cancel'); wait(lambda: sql('SELECT state FROM acp_tasks WHERE task_id=?', (task['task_id'],))[0]['state'] == 'running')
        page.get_by_role('button', name='Cancel ACP task', exact=True).click()
        assert complete(task)['state'] == 'cancelled'
        page.screenshot(path=str(out/'local-cancel.png'), full_page=True)
        passed('original Cancel ACP task stops real instance, no new task or approval replay', task_id=task['task_id'])
        choose('remote'); remote = form('remote')
        page.reload(wait_until='domcontentloaded')
        expect(page.locator('[data-studio-acp]:visible')).to_be_visible(timeout=30000)
        expect(page.locator('[data-studio-acp]:visible')).to_contain_text(remote['task_id'], timeout=30000)
        assert page.get_by_role('button', name='Allow once', exact=True).count() == 0
        passed('original session reload reopens durable ACP history without recreating controls', task_id=remote['task_id'])
        page.set_viewport_size({'width': 390, 'height': 844}); page.wait_for_timeout(800)
        layout = page.evaluate('''() => {const p=document.querySelector('[data-studio-acp]'),r=p.getBoundingClientRect();return {viewport:innerWidth,scroll:document.documentElement.scrollWidth,panel:{left:r.left,right:r.right,width:r.width},panelScroll:p.scrollWidth,panelClient:p.clientWidth};}''')
        assert layout['scroll'] <= layout['viewport']+1 and layout['panelScroll'] <= layout['panelClient']+1, layout
        page.screenshot(path=str(out/'mobile-width-layout.png'), full_page=True)
        passed('390px responsive layout check, not actual-phone acceptance', layout=layout)
        allowed_reads = ['/api/skills/list', '/api/schedule/catalog', '/api/schedule/list', '/api/llm/discoverModels']
        report['unexpected_rpc'] = [entry for entry in report['rpc_errors'] if not (entry['path'] in allowed_reads and entry['code'] == 'agent-studio/disabled')]
        report['unexpected_http'] = [entry for entry in report['http_errors'] if not (entry['status'] == 409 and entry['path'].startswith('/sidebar/api/git.'))]
        report['unexpected_console'] = [entry for entry in report['console_errors'] if entry != 'Failed to load resource: the server responded with a status of 409 (Conflict)']
        assert not any(report[key] for key in ['js_errors', 'unexpected_rpc', 'unexpected_http', 'unexpected_console', 'external_requests', 'decode_errors'] if key in report), 'Unexpected browser errors; see report'
        report['result'] = 'pass-limited-development'
    except Exception as error:
        report['result'] = 'fail'; report['failure'] = scrub(error)
        page.locator('input[type=password]').evaluate_all('(els)=>els.forEach(el=>{el.value=""})')
        report['buttons'] = page.get_by_role('button').evaluate_all('(els)=>els.map(e=>({text:e.innerText,label:e.getAttribute("aria-label")}))')
        report['body'] = scrub(page.locator('body').inner_text())
        page.screenshot(path=str(out/'failure.png'), full_page=True)
    finally:
        for task in active.values():
            if sql('SELECT state FROM acp_tasks WHERE task_id=?', (task['task_id'],))[0]['state'] not in ['starting', 'running', 'stopping']: continue
            try: rpc('acp.cancel', {key: task[key] for key in ['task_id', 'session_id', 'binding_id', 'version']})
            except Exception as error: report.setdefault('cleanup_errors', []).append(scrub(error))
        (out/'browser.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps({'result': report.get('result'), 'checks': len(report['checks']), 'failure': report.get('failure'), 'evidence': str(out/'browser.json')}, ensure_ascii=False))
        browser.close()
        if report['result'] == 'fail': raise SystemExit(1)
