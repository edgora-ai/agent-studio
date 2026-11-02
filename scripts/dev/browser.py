#!/usr/bin/env python3
"""Real dsh/unchanged sidebar smoke. Reads only this preview's private login URL."""
import argparse
import json
import re
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

parser = argparse.ArgumentParser()
parser.add_argument('--root', required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--browser', required=True)
parser.add_argument('--discover', action='store_true')
args = parser.parse_args()
root = Path(args.root); out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
ready = json.loads((root / 'ready.json').read_text())
origin = ready['origin']
errors = []; console_errors = []; failures = []; outside = []; rpc_failures = []
def scrub(value):
    return re.sub(r'([?&]token=)[^\s"&]+', r'\1[redacted]', str(value))
def response_event(response):
    path = urlsplit(response.url).path
    if response.status >= 400:
        failures.append({'path': path, 'status': response.status})
    if response.request.method == 'POST' and path.startswith('/api/') and 'application/json' in response.headers.get('content-type', ''):
        try:
            result = response.json().get('result', {})
            if result.get('ok') is False:
                rpc_failures.append({'path': path, 'code': result.get('error', {}).get('code')})
        except Exception as error:
            failures.append({'path': path, 'read_error': type(error).__name__})

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=args.browser, headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    def route_request(route):
        if route.request.url.startswith(origin + '/'):
            route.continue_()
        else:
            outside.append(urlsplit(route.request.url).scheme + '://' + urlsplit(route.request.url).netloc)
            route.abort()
    context.route('**/*', route_request)
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(scrub(error)))
    page.on('console', lambda message: console_errors.append(scrub(message.text)) if message.type == 'error' else None)
    page.on('response', response_event)
    try:
        page.goto((root / 'login.url').read_text().strip(), wait_until='domcontentloaded')
        # Native Remote follow streams can keep the network busy indefinitely.
        idle = True
        try:
            page.wait_for_load_state('networkidle', timeout=5000)
        except PlaywrightTimeout:
            idle = False
        page.wait_for_timeout(1500)
        notice = page.get_by_role('button', name='Continue', exact=True)
        if notice.count():
            notice.click()
            notice.wait_for(state='hidden', timeout=10000)
        # The shell restores the last selected workspace; pin D01 explicitly so
        # this regression does not depend on previous manual/test selections.
        chooser = page.get_by_role('button', name='Choose workspace', exact=True)
        if chooser.count() and 'D01 Preview Project' not in (chooser.first.inner_text() or ''):
            chooser.first.click()
            page.get_by_role('menu').get_by_text('D01 Preview Project · v1', exact=True).click()
            page.wait_for_timeout(1000)
        toggle = page.get_by_role('button', name='Open right sidebar', exact=True)
        if toggle.count():
            toggle.click()
        files = page.get_by_role('button', name='Files', exact=True)
        if files.count():
            files.click()
        page.wait_for_timeout(1000)
        native_response = context.request.post(origin + '/api/session/list', data={
            'type': 'client-request', 'rpcId': 'browser-native-list', 'method': 'session/list',
            'payload': {'args': {'_request': {}}}})
        native_envelope = native_response.json()
        assert native_envelope['result']['ok'], 'Native list RPC failed'
        native_items = native_envelope['result']['value']['items']
        native_session = next(item for item in native_items if item['projections']['values'].get('title') == 'D01 Native Session')
        plugin_loaded = page.evaluate('performance.getEntriesByType("resource").some(e => e.name.includes("dsh-better-sidebar"))')
        button_attributes = page.locator('button').evaluate_all('(nodes) => nodes.map(n => ({text:n.textContent,title:n.title,aria:n.getAttribute("aria-label")}))')
        page.screenshot(path=str(out / 'browser.png'), full_page=True)
        text = page.locator('body').inner_text()
        unexpected_console = [message for message in console_errors if not (
            message == 'Failed to load resource: the server responded with a status of 409 (Conflict)' or
            ('/sidebar/ws/fs-watch?' in message and 'Unexpected response code: 403' in message))]
        # Stock UI probes that the explicit Studio allowlist keeps fail-closed;
        # schedule/catalog is requested by the rc.5 shell and must stay disabled.
        disabled_reads = ['/api/skills/list', '/api/schedule/catalog']
        unexpected_rpc = [failure for failure in rpc_failures if not (
            failure['path'] in disabled_reads and failure['code'] == 'agent-studio/disabled')]
        report = {'origin': origin, 'network_idle': idle, 'body': text[:12000], 'js_errors': errors,
                  'unexpected_console_errors': unexpected_console, 'unexpected_rpc_failures': unexpected_rpc,
                  'console_errors': console_errors, 'http_failures': failures, 'rpc_failures': rpc_failures,
                  'external_requests_blocked': outside, 'original_sidebar_loaded': plugin_loaded,
                  'native_session': {'session_id': native_session['sessionId'], 'blank': native_session['blank'],
                                     'title': native_session['projections']['values']['title']},
                  'buttons': button_attributes}
        (out / 'browser.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report, ensure_ascii=False, indent=2))
        if not args.discover:
            assert not errors, 'JavaScript exceptions in real UI'
            assert not unexpected_console, 'Unexpected console error'
            assert not unexpected_rpc, 'Unexpected native RPC failure'
            assert 'D01 Preview Project' in text, 'Workspace not visible'
            assert native_session['sessionId'], 'Native session not loaded'
            assert plugin_loaded, 'Original sidebar client not loaded'
            # D01 metadata-only policy: the native Files entry stays in the
            # provider-unavailable state and its tree request is refused with 409.
            assert 'provider-unavailable' in text, 'Expected disabled Files state not visible'
            assert any(failure['path'] == '/sidebar/api/fs.trees' and failure.get('status') == 409
                       for failure in failures), 'D01 Files request was not denied with 409'
            assert not outside, 'Unexpected external browser request'
            assert all(failure.get('status') == 409 and failure['path'].startswith('/sidebar/') for failure in failures), 'Unexpected HTTP failure'
    except Exception as error:
        page.screenshot(path=str(out / 'browser-failure.png'), full_page=True)
        print(scrub(error))
        raise SystemExit(1)
    finally:
        browser.close()
