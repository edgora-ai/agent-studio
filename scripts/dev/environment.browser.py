#!/usr/bin/env python3
"""D07 original Web flow, real READ ONLY Coder discovery and known m1-a helper.
No platform create/start/stop, no model, no external CLI, no synthetic session.
"""
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
root, out = Path(args.root), Path(args.out)
out.mkdir(parents=True, exist_ok=False)
repo = Path(__file__).resolve().parents[2]
f = json.loads((repo / 'artifacts/d03/ui-fixture.json').read_text())
origin = json.loads((root / 'ready.json').read_text())['origin']
report = {'historical_unresolved_failure': 'D07_REMOTE_SEARCH_SSH_255: prior three operations remain unknown; new success is not recovery or a root-cause fix', 'scope': 'D07 real readonly discovery + original Web/Files/terminal; not platform lifecycle, real model/CLI or phone acceptance', 'checks': [], 'js_errors': [], 'external_requests': [], 'http_errors': [], 'rpc_errors': []}
terminals, links, file_replies = [], [], []


def sql(query, values=()):
    with sqlite3.connect('file:' + str(root / 'bindings.sqlite') + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute(query, values)]


def scrub(value):
    return re.sub(r'([?&]token=)[^\s"&]+', r'\1[redacted]', str(value))


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=args.browser, headless=True)
    context = browser.new_context(viewport={'width': 1600, 'height': 1050})
    def route(r):
        if r.request.url.startswith(origin + '/'):
            r.continue_()
        else:
            report['external_requests'].append(urlsplit(r.request.url).netloc)
            r.abort()
    context.route('**/*', route)
    page = context.new_page()
    page.on('pageerror', lambda error: report['js_errors'].append(scrub(error)))
    def response(r):
        path = urlsplit(r.url).path
        if r.status >= 400:
            report['http_errors'].append({'path': path, 'status': r.status})
        if r.request.method != 'POST' or path == '/api/$events' or not path.startswith(('/api/', '/agent-studio-rpc/', '/sidebar/')):
            return
        try:
            body = r.json()
            result = body.get('result', body)
            if result.get('ok') is False:
                report['rpc_errors'].append({'path': path, 'code': result.get('error', {}).get('code')})
            if path == '/agent-studio-rpc/environment.open' and result.get('ok'):
                links.append(result['value'])
            if path == '/api/terminal/create' and result.get('ok'):
                terminals.append({'session_id': r.request.post_data_json['payload']['args']['agentId'], 'id': result['value']['id']})
            if path == '/sidebar/api/fs.search' and result.get('ok'):
                file_replies.append(result['value'])
        except Exception as error:
            report.setdefault('response_decode_errors', []).append({'path': path, 'error': type(error).__name__})
    page.on('response', response)
    def rpc(method, payload, channel='/agent-studio-rpc'):
        r = context.request.post(origin + channel + '/' + method, headers={'origin': origin}, data={'type': 'client-request', 'rpcId': str(uuid4()), 'method': method, 'payload': payload}, timeout=100000)
        body = r.json()
        assert r.status == 200 and body['result']['ok'], scrub(body)
        return body['result'].get('value')
    def passed(name, **facts):
        report['checks'].append({'name': name, **facts})
        print('PASS ' + name)
    def select_environment():
        page.get_by_role('button', name='Manage environments', exact=True).click()
        panel = page.locator('dialog[open] [data-studio-environments]')
        with page.expect_response(lambda r: urlsplit(r.url).path == '/agent-studio-rpc/environment.discover', timeout=90000) as discovery:
            panel.get_by_role('button', name='Discover now', exact=True).click()
        assert discovery.value.json()['result']['ok']
        panel.get_by_role('button', name='m1-a', exact=False).click(timeout=90000)
        return panel
    try:
        before = sql('SELECT count(*) n FROM session_bindings')[0]['n']
        page.goto((root / 'login.url').read_text().strip(), wait_until='domcontentloaded')
        assert page.evaluate('location.pathname') == '/'
        panel = select_environment()
        assert sql('SELECT count(*) n FROM session_bindings')[0]['n'] == before
        assert panel.get_by_role('button', name='Start workspace', exact=True).is_disabled()
        assert panel.get_by_role('button', name='Stop workspace', exact=True).is_disabled()
        page.screenshot(path=str(out / 'no-session-discovery.png'), full_page=True)
        passed('original login -> global environment entry without selected session or fake session -> real m1-a discovery', sessions_before=before, sessions_after=before, workspace_id='ff136352-6a92-41d4-9c2c-6cc783cb989b', read_only=True)
        panel.get_by_label('Environment binding', exact=True).select_option(f['binding_id'] + '@1')
        panel.get_by_label('Environment session', exact=True).select_option(f['session_id'])
        with page.expect_response(lambda r: urlsplit(r.url).path == '/agent-studio-rpc/environment.open', timeout=180000) as opened:
            panel.get_by_role('button', name='Connect and open session', exact=True).click()
        result = opened.value.json()['result']
        assert result['ok'] and result['value']['state'] == 'ready', result
        link = result['value']
        expect(page.get_by_role('dialog', name='Environment management')).not_to_be_visible(timeout=30000)
        assert link == sql('SELECT * FROM environment_links WHERE request_id=?', (link['request_id'],))[0]
        assert rpc('environment.link', {'request_id': link['request_id']}) == link
        assert link['session_id'] == f['session_id'] and link['binding_id'] == f['binding_id']
        assert rpc('remote.status', {'session_id': f['session_id']})['connected']
        opener = page.get_by_role('button', name='Open right sidebar', exact=True)
        if opener.count():
            opener.click()
        page.get_by_role('button', name='Files', exact=True).click()
        query = page.locator('input[placeholder="Name or content: text (bounded search)"]:visible')
        query.fill('content:' + f['needle'])
        hit = page.locator('[data-studio-search-hit]:visible').filter(has_text='中文 file.txt')
        hit.wait_for(state='visible', timeout=60000)
        hit.get_by_role('button').first.click()
        editor = page.locator('.cm-content[contenteditable="true"]:visible')
        expect(editor).to_contain_text(f['needle'], timeout=30000)
        remote = rpc('fs.read', {'session_id': f['session_id'], 'path': f['path']})
        text = base64.b64decode(remote['data']).decode()
        assert editor.inner_text().rstrip('\n') == text.rstrip('\n')
        assert file_replies[-1]['identity']['session_id'] == f['session_id']
        page.screenshot(path=str(out / 'bound-original-files.png'), full_page=True)
        passed('select existing registration/binding/session -> actual helper connection -> original Files full known synthetic bytes', link=link, identity=file_replies[-1]['identity'], sha256=hashlib.sha256(text.encode()).hexdigest())
        page.get_by_role('button', name='New tab', exact=True).first.click()
        page.get_by_role('button', name='New terminal', exact=True).click()
        terminal = page.locator('.xterm-helper-textarea:visible')
        expect(terminal).to_be_editable(timeout=60000)
        tag = 'D07_UI_TERMINAL_' + str(uuid4())
        terminal.focus()
        page.keyboard.insert_text("printf '%s\\n' '" + tag + "'; pwd")
        page.keyboard.press('Enter')
        assert terminals and terminals[-1]['session_id'] == f['session_id']
        task = sql("SELECT * FROM operation_records WHERE session_id=? AND kind='pty.open' ORDER BY rowid DESC LIMIT 1", (f['session_id'],))[0]
        output = ''
        for _ in range(40):
            read = rpc('task.read', {'session_id': f['session_id'], 'operation_id': task['operation_id']})
            output = ''.join(base64.b64decode(chunk['data']).decode(errors='replace') for chunk in read['chunks'])
            lines = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', output).splitlines()
            if tag in lines and f['target_root'] in lines:
                break
            page.wait_for_timeout(100)
        assert tag in lines and f['target_root'] in lines
        page.screenshot(path=str(out / 'bound-original-terminal.png'), full_page=True)
        owned = terminals.pop()
        rpc('terminal/close', {'args': {'agentId': owned['session_id'], 'id': owned['id']}}, '/api')
        assert rpc('operation.get', {'operation_id': task['operation_id']})['state'] == 'released'
        passed('original terminal runs only in selected bound root; exact task closes through real status/cancel/release', operation_id=task['operation_id'], remote_process_id=task['remote_process_id'], remote_pid=task['remote_pid'], output=output[-3000:], final_state='released')
        panel = select_environment()
        panel.get_by_label('Environment binding', exact=True).select_option(f['binding_id'] + '@1')
        panel.get_by_label('Environment session', exact=True).select_option('')
        with page.expect_response(lambda r: urlsplit(r.url).path == '/agent-studio-rpc/environment.open', timeout=180000) as opened:
            panel.get_by_role('button', name='Connect and open session', exact=True).click()
        new_link = opened.value.json()['result']['value']
        assert new_link['state'] == 'ready' and new_link['session_id'] != f['session_id']
        expect(page.get_by_role('dialog', name='Environment management')).not_to_be_visible(timeout=30000)
        session = rpc('session.get', {'session_id': new_link['session_id']})
        assert session['native'] and session['binding_id'] == f['binding_id'] and session['version'] == 1
        assert sql('SELECT count(*) n FROM session_bindings')[0]['n'] == before + 1
        passed('same environment opens a genuine new native session on the selected existing binding; no DB editing or fake session', link=new_link, native_cwd=session['native']['inspection']['meta']['cwd'])
        panel = select_environment()
        panel.get_by_label('Environment binding', exact=True).select_option('')
        with page.expect_response(lambda r: urlsplit(r.url).path == '/agent-studio-rpc/environment.open', timeout=180000) as opened:
            panel.get_by_role('button', name='Connect and open session', exact=True).click()
        created = opened.value.json()['result']['value']
        assert created['state'] == 'ready' and created['binding_id'] != f['binding_id']
        expect(page.get_by_role('dialog', name='Environment management')).not_to_be_visible(timeout=30000)
        binding = rpc('binding.get', {'binding_id': created['binding_id'], 'version': created['version']})
        assert binding['target_root'] == '/workspace/agent-studio-' + created['binding_id'] + '-v1'
        assert rpc('fs.list', {'session_id': created['session_id'], 'path': ''})['entries'] == []
        assert created == sql('SELECT * FROM environment_links WHERE request_id=?', (created['request_id'],))[0]
        passed('original environment panel registers/comparisons -> new project/binding/owned subdirectory -> genuine native session, without any platform lifecycle call', link=created, target_root=binding['target_root'])
        page.set_viewport_size({'width': 390, 'height': 844})
        panel = select_environment()
        panel.get_by_label('Environment binding', exact=True).select_option(f['binding_id'] + '@1')
        panel.get_by_label('Environment session', exact=True).select_option(new_link['session_id'])
        layout = panel.evaluate('(el)=>({document:document.documentElement.scrollWidth,viewport:innerWidth,left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,scroll:el.scrollWidth,client:el.clientWidth})')
        assert layout['document'] == 390 and layout['left'] >= 16 and layout['right'] <= 374 and layout['scroll'] <= layout['client']
        page.screenshot(path=str(out / 'mobile-390.png'), full_page=True)
        passed('390px original environment panel preserves gutters and has no horizontal overflow', layout=layout, actual_phone=False)
        page.keyboard.press('Escape')
        expect(page.get_by_role('dialog', name='Environment management')).not_to_be_visible()
        expect(page.get_by_role('button', name='Manage environments', exact=True)).to_be_focused()
        passed('native dialog Escape returns keyboard focus to original environment entry')
        panel = select_environment()
        context.clear_cookies()
        panel.get_by_role('button', name='Discover now', exact=True).click()
        expect(panel.get_by_role('alert')).to_contain_text('HTTP 401', timeout=20000)
        page.screenshot(path=str(out / 'authentication-error.png'), full_page=True)
        passed('expired browser authentication renders explicit 401 error; no automatic action retry')
        assert not report['js_errors'] and not report['external_requests']
        assert sql('SELECT count(*) n FROM environment_requests')[0]['n'] == 0
        assert not sql("SELECT * FROM operation_records WHERE state IN ('pending','running')")
        report['status'] = 'pass-limited-development'
    except Exception as error:
        report['status'] = 'failed'
        report['failure'] = scrub(error)
        report['body'] = page.locator('body').inner_text()
        page.screenshot(path=str(out / 'failure.png'), full_page=True)
        raise
    finally:
        for owned in terminals:
            try:
                rpc('terminal/close', {'args': {'agentId': owned['session_id'], 'id': owned['id']}}, '/api')
            except Exception as error:
                report.setdefault('cleanup_errors', []).append(scrub(error))
        report['links'] = links
        (out / 'browser.json').write_text(json.dumps(report, indent=2, ensure_ascii=False))
        browser.close()
