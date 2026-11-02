#!/usr/bin/env python3
"""D08 one original-UI PTY task, same-Host explicit transport recovery.
No workspace lifecycle, daemon signal, model, CLI, business restart or historical replay.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import importlib.util

# Resolve only this pure sibling, independent of cwd/sys.path (including -I).
_spec = importlib.util.spec_from_file_location('recovery_command', Path(__file__).resolve().with_name('recovery_command.py'))
assert _spec is not None and _spec.loader is not None
_helper = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_helper)
single_line_python_command = _helper.single_line_python_command
synthetic_program = _helper.synthetic_program
import sqlite3
import subprocess
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
repo = Path(__file__).resolve().parents[2]
origin = json.loads((root / 'ready.json').read_text())['origin']
session_id = 'session-e5dea400-7d8d-4f76-8296-4269325fdf30'
binding_id = 'binding-6113005c-b396-4807-b48a-90f697c1395e'
run = str(uuid4())
report = {'scope': 'D08 one bounded synthetic original native terminal task; same Host recovery, no replacement process', 'run': run, 'checks': [], 'js_errors': [], 'http_errors': [], 'rpc_errors': [], 'external_requests': []}
terminals, recoveries = [], []
operation_id = None
released = False


def sql(query, values=()):
    with sqlite3.connect('file:' + str(root / 'bindings.sqlite') + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute(query, values)]


def scrub(value):
    return re.sub(r'([?&]token=)[^\s"&]+', r'\1[redacted]', str(value))


def observe_file_and_pid(path, pid):
    # Independent verification only. Product recovery uses its own fixed probe
    # over the authenticated official SSH transport, NOT this Docker observer.
    result = subprocess.run(['/usr/bin/python3', '-I', str(repo / 'scripts/dev/observe_remote.py'), str(root)],
                            input=json.dumps({'binding_id': binding_id, 'version': 1, 'paths': [path], 'pids': [pid]}),
                            text=True, capture_output=True, timeout=40)
    assert result.returncode == 0, 'Independent readonly observer failed; raw diagnostics withheld'
    return json.loads(result.stdout)


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
        if r.request.method != 'POST' or not path.startswith(('/api/', '/agent-studio-rpc/', '/sidebar/')) or path == '/api/$events' or r.status == 401:
            return
        try:
            body = r.json()
            result = body.get('result', body)
            if result.get('ok') is False:
                report['rpc_errors'].append({'path': path, 'code': result.get('error', {}).get('code')})
            if path == '/api/terminal/create' and result.get('ok'):
                terminals.append({'session_id': r.request.post_data_json['payload']['args']['agentId'], 'id': result['value']['id']})
            if path == '/agent-studio-rpc/task.recover':
                recoveries.append(result)
        except Exception as error:
            report.setdefault('observer_decode_errors', []).append({'path': path, 'type': type(error).__name__})
    page.on('response', response)
    def rpc(method, payload, channel='/agent-studio-rpc'):
        r = context.request.post(origin + channel + '/' + method, headers={'origin': origin}, data={'type': 'client-request', 'rpcId': str(uuid4()), 'method': method, 'payload': payload}, timeout=60000)
        assert r.status == 200, 'RPC HTTP ' + str(r.status)
        result = r.json()['result']
        assert result['ok'], result.get('error', {}).get('code')
        return result.get('value')
    def passed(name, **facts):
        report['checks'].append({'name': name, **facts})
        print('PASS ' + name)
    try:
        before_ids = {row['operation_id'] for row in sql('SELECT operation_id FROM operation_records')}
        unknown_before = sql("SELECT * FROM operation_records WHERE state='unknown' ORDER BY operation_id")
        # 13 historical unknowns predate 2026-11-02. The rc.5 remote helper
        # instability added 9 new unknown rows on 2026-11-02; they are real
        # records and must stay unchanged too, never deleted or rewritten.
        historical_unknown_before = [row for row in unknown_before if row['created_at'] < '2026-11-02']
        assert len(historical_unknown_before) == 13, len(historical_unknown_before)
        report['unknown_baseline'] = {'historical_13': len(historical_unknown_before), 'preexisting_total': len(unknown_before)}
        page.goto((root / 'login.url').read_text().strip(), wait_until='domcontentloaded')
        page.wait_for_load_state('networkidle')
        page.get_by_role('button', name='Manage environments', exact=True).click()
        panel = page.locator('dialog[open] [data-studio-environments]')
        with page.expect_response(lambda r: urlsplit(r.url).path == '/agent-studio-rpc/environment.discover', timeout=60000):
            panel.get_by_role('button', name='Discover now', exact=True).click()
        panel.get_by_role('button', name='m1-a', exact=False).click(timeout=60000)
        panel.get_by_label('Environment binding', exact=True).select_option(binding_id + '@1')
        panel.get_by_label('Environment session', exact=True).select_option(session_id)
        with page.expect_response(lambda r: urlsplit(r.url).path == '/agent-studio-rpc/environment.open', timeout=120000) as opened:
            panel.get_by_role('button', name='Connect and open session', exact=True).click()
        assert opened.value.json()['result']['value']['state'] == 'ready'
        expect(page.get_by_role('dialog', name='Environment management')).not_to_be_visible(timeout=30000)
        opener = page.get_by_role('button', name='Open right sidebar', exact=True)
        if opener.count():
            opener.click()
        page.get_by_role('button', name='Original tasks', exact=True).click()
        page.get_by_role('button', name='New tab', exact=True).first.click()
        with page.expect_response(lambda r: urlsplit(r.url).path == '/api/terminal/create', timeout=120000) as created:
            page.get_by_role('button', name='New terminal', exact=True).click()
        operation = sql("SELECT * FROM operation_records WHERE session_id=? AND kind='pty.open' ORDER BY rowid DESC LIMIT 1", (session_id,))[0]
        operation_id = operation['operation_id']
        assert operation_id not in before_ids
        assert created.value.json()['result']['ok']
        assert len(terminals) == 1 and terminals[0]['session_id'] == session_id
        terminal = page.locator('.xterm-helper-textarea:visible')
        task = {'session_id': session_id, 'operation_id': operation_id}
        view = rpc('task.recovery', task)
        snapshot = sql('SELECT * FROM task_recovery_snapshots WHERE operation_id=?', (operation_id,))[0]
        assert view['snapshot'] == snapshot and snapshot['complete'] == 1, snapshot['incomplete_reason']
        expect(terminal).to_be_editable(timeout=10000)
        identity = json.loads(snapshot['identity_json'])
        assert identity['pid'] == operation['remote_pid'] and identity['process_id'] == operation['remote_process_id']
        filename = '.d08-single-' + run + '.txt'
        synthetic = synthetic_program(filename, run)
        terminal.focus()
        page.keyboard.insert_text(single_line_python_command(synthetic))
        page.keyboard.press('Enter')
        for _ in range(30):
            first = rpc('task.read', {**task, 'after_seq': '0'})
            text = ''.join(base64.b64decode(chunk['data']).decode(errors='replace') for chunk in first['chunks'])
            if 'D08_ORIGINAL_READY ' + str(identity['pid']) in text:
                break
            page.wait_for_timeout(100)
        assert 'D08_ORIGINAL_READY ' + str(identity['pid']) in text
        first_file = rpc('fs.read', {'session_id': session_id, 'path': filename})
        expected_file = (run + '\n').encode()
        assert base64.b64decode(first_file['data']) == expected_file
        cursor = first['nextSeq']
        page.screenshot(path=str(out / 'original-task-running.png'), full_page=True)
        passed('original UI starts exactly one PTY, records full immutable identity, runs one bounded synthetic side effect', operation_id=operation_id, native_terminal=terminals[0], snapshot=snapshot, file={'path': filename, 'sha256': hashlib.sha256(expected_file).hexdigest(), 'count': 1}, synthetic_deadline_seconds=90)
        detached = rpc('task.detach', task)
        assert detached['state']['state'] == 'lost' and detached['operation']['state'] == 'unknown'
        recover = page.get_by_role('button', name='Recover original task', exact=True).last
        expect(recover).to_be_enabled(timeout=10000)
        expect(terminal).not_to_be_editable(timeout=10000)
        page.screenshot(path=str(out / 'original-task-disconnected.png'), full_page=True)
        fixed_deadline = detached['state']['recovery_deadline_ms']
        with page.expect_response(lambda r: urlsplit(r.url).path == '/agent-studio-rpc/task.recover', timeout=35000) as recovered:
            recover.click()
        result = recovered.value.json()['result']
        assert result['ok'], result.get('error', {}).get('code')
        restored = result['value']
        assert restored['state']['state'] == 'recovered' and restored['state']['recovery_deadline_ms'] == fixed_deadline
        assert restored['operation']['channel_id'] == operation['channel_id']
        assert restored['state']['current_transport_id'] != operation['channel_id']
        assert restored['snapshot'] == snapshot
        assert restored['requests'][-1]['state'] == 'verified'
        expect(terminal).to_be_editable(timeout=10000)
        after = rpc('task.read', {**task, 'after_seq': cursor})
        resumed_text = ''.join(base64.b64decode(chunk['data']).decode(errors='replace') for chunk in after['chunks'])
        assert 'D08_ORIGINAL_TICK' in resumed_text and 'COUNT 1' in resumed_text and not after['truncated']
        page.wait_for_timeout(1200)
        page.screenshot(path=str(out / 'original-task-recovered.png'), full_page=True)
        passed('only own transport detached; UI resumes same helper session/epoch/process/PID/startTick and original output', startup_channel=operation['channel_id'], recovered_transport=restored['state']['current_transport_id'], helper_session_id=identity['helper_session_id'], server_epoch=identity['server_epoch'], process_id=identity['process_id'], pid=identity['pid'], start_ticks=identity['process']['start_ticks'], recovery_request=restored['requests'][-1], fixed_deadline=fixed_deadline, output_after_cursor=cursor, next_seq=after['nextSeq'], output_sha256=hashlib.sha256(resumed_text.encode()).hexdigest(), output_excerpt=resumed_text[-1200:])
        cancel = page.get_by_role('button', name='Cancel original task', exact=True).last
        with page.expect_response(lambda r: urlsplit(r.url).path == '/agent-studio-rpc/task.cancel', timeout=45000) as cancelled:
            cancel.click()
        assert cancelled.value.json()['result']['value']['running'] is False
        status = rpc('task.status', task)
        assert status['running'] is False and status['pid'] == identity['pid']
        owned = terminals[0]
        rpc('terminal/close', {'args': {'agentId': session_id, 'id': owned['id']}}, '/api')
        final = rpc('task.recovery', task)
        assert final['operation']['state'] == 'released' and final['state']['state'] == 'released'
        released = True
        independent = observe_file_and_pid(filename, identity['pid'])
        assert independent['files'][0]['sha256'] == hashlib.sha256(expected_file).hexdigest()
        assert independent['files'][0]['bytes'] == len(expected_file)
        assert independent['processes'][0].get('exists') is False or independent['processes'][0].get('start_tick') != identity['process']['start_ticks'] or independent['processes'][0].get('state') == 'Z'
        page.screenshot(path=str(out / 'original-task-released.png'), full_page=True)
        passed('UI cancels original task; actual status exit, native close/release and independent exact PID/file verification', status=status, final_operation=final['operation'], independent=independent, side_effect_count=1)
        for table, key in [('task_recovery_requests', 'requests'), ('task_recovery_events', 'events')]:
            assert final[key] == sql('SELECT * FROM ' + table + ' WHERE operation_id=? ORDER BY created_at,rowid', (operation_id,))
        assert final['snapshot'] == sql('SELECT * FROM task_recovery_snapshots WHERE operation_id=?', (operation_id,))[0]
        assert final['state'] == sql('SELECT * FROM task_recovery_state WHERE operation_id=?', (operation_id,))[0]
        assert any(item == final for item in rpc('task.recoveries', {'session_id': session_id}))
        assert sql("SELECT * FROM operation_records WHERE state='unknown' ORDER BY operation_id") == unknown_before
        new_starts = [row for row in sql("SELECT operation_id,kind FROM operation_records WHERE kind IN ('command.exec','pty.open')") if row['operation_id'] not in before_ids]
        assert new_starts == [{'operation_id': operation_id, 'kind': 'pty.open'}], new_starts
        assert sql('SELECT count(*) n FROM environment_requests')[0]['n'] == 0
        passed('all new snapshots/recovery events SQL -> full API -> list, exactly one business start, thirteen old unknown rows unchanged', new_starts=new_starts, recovery_requests=len(final['requests']), recovery_events=len(final['events']), old_unknown=13)
        context.clear_cookies()
        expect(page.locator('[data-recovery-error]').first).to_contain_text('HTTP 401', timeout=10000)
        page.screenshot(path=str(out / 'recovery-authentication-error.png'), full_page=True)
        passed('original recovery panel shows explicit HTTP401 and does not retry an action')
        assert not report['js_errors'] and not report['external_requests']
        report['result'] = 'pass-single-task-same-host'
    except Exception as error:
        report['result'] = 'D08_SINGLE_TASK_UI_FAILED'
        report['failure'] = {'type': type(error).__name__, 'message': scrub(error), 'operation_id': operation_id}
        page.screenshot(path=str(out / 'failure.png'), full_page=True)
    finally:
        if operation_id and not released:
            row = sql('SELECT * FROM operation_records WHERE operation_id=?', (operation_id,))[0]
            report['retained_task'] = {key: row[key] for key in ('operation_id','state','channel_id','helper_session_id','remote_process_id','remote_pid','error_code')}
            if row['state'] != 'unknown':
                try:
                    owned = terminals[0]
                    rpc('terminal/close', {'args': {'agentId': session_id, 'id': owned['id']}}, '/api')
                    report['cleanup'] = sql('SELECT state FROM operation_records WHERE operation_id=?', (operation_id,))[0]
                except Exception as error:
                    report['cleanup'] = {'state': 'unconfirmed', 'error': scrub(error)}
            else:
                report['cleanup'] = {'state': 'unknown', 'automatic_recovery_or_replay': False}
        (out / 'browser.json').write_text(json.dumps(report, indent=2, ensure_ascii=False))
        browser.close()
        print(json.dumps({'result': report.get('result'), 'checks': len(report['checks']), 'failure': report.get('failure'), 'report': str(out / 'browser.json')}, ensure_ascii=False))
        if report.get('result') != 'pass-single-task-same-host':
            raise SystemExit(1)
