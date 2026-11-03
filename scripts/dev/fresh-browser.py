#!/usr/bin/env python3
"""Actual fresh-instance browser acceptance. Importing this module does no I/O.

Run ONLY after Lead live-ready:
  python3 -B scripts/dev/fresh-browser.py --live-ready

Offline unit tests cover guardrails, not live model/CLI acceptance. This probe
never configures a provider, consumes an offline fixture, invokes an agent CLI,
or visits the old preview, existing GUI, or existing Coder lab.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import secrets
import shlex
import sqlite3
import subprocess
import time
from urllib.parse import parse_qs, unquote, urljoin, urlsplit, urlunsplit
from uuid import uuid4

REPO = Path(__file__).resolve().parents[2]
FRESH = REPO / '.preview/agent-studio-fresh'
OUT = REPO / 'artifacts/deployment-fresh/browser'
REDIRECTS = {301, 302, 303, 307, 308}


def require(condition, code):
    if not condition:
        raise AssertionError(code)


def origin_of(url):
    parsed = urlsplit(url)
    require(parsed.scheme in {'http', 'https', 'ws', 'wss'} and parsed.hostname
            and parsed.username is None and parsed.password is None, 'INVALID_ORIGIN')
    scheme = {'ws': 'http', 'wss': 'https'}.get(parsed.scheme, parsed.scheme)
    host = parsed.hostname.lower()
    host = '[' + host + ']' if ':' in host else host
    port = parsed.port or (443 if scheme == 'https' else 80)
    return scheme + '://' + host + ('' if port == (443 if scheme == 'https' else 80) else ':' + str(port))


def checked_origin(url):
    parsed = urlsplit(url)
    value = origin_of(url)
    require(parsed.path in {'', '/'} and not parsed.query and not parsed.fragment, 'ORIGIN_NOT_BARE')
    require(parsed.port != 3080, 'PROTECTED_GUI_ORIGIN')
    return value


def redirect_target(current, location, allowed):
    """Reject even a redirect to another otherwise-allowed origin."""
    target = urljoin(current, location)
    require(origin_of(target) in allowed and origin_of(target) == origin_of(current),
            'CROSS_ORIGIN_REDIRECT_BLOCKED')
    require(not urlsplit(target).fragment, 'REDIRECT_FRAGMENT_BLOCKED')
    return target


def redirect_request(status, method, data):
    if status == 303 and method != 'HEAD' or status in {301, 302} and method == 'POST':
        return 'GET', None
    return method, data


class Sanitizer:
    def __init__(self, secrets_=()):
        self.secrets = set()
        self.add(*secrets_)

    def add(self, *values):
        for value in values:
            if isinstance(value, str) and len(value) >= 6:
                self.secrets.add(value)
                self.secrets.add(unquote(value))

    def text(self, value):
        value = str(value)
        for secret in sorted(self.secrets, key=len, reverse=True):
            value = value.replace(secret, '[REDACTED]')
        # Never persist URL queries/fragments, including URLs in stack traces.
        value = re.sub(r'(?:https?|wss?)://[^\s<>"\']+', self._url, value)
        value = re.sub(r'(?i)((?:[?&]|\b)(?:token|access_token|session_token|api_key|apikey)=)[^\s&"\']+',
                       r'\1[REDACTED]', value)
        value = re.sub(r'(?im)\b(authorization|cookie|set-cookie)\s*:\s*[^\r\n]+',
                       r'\1: [REDACTED]', value)
        return value

    @staticmethod
    def _url(match):
        try:
            parsed = urlsplit(match.group(0))
            host = parsed.hostname or '[invalid]'
            if ':' in host:
                host = '[' + host + ']'
            if parsed.port:
                host += ':' + str(parsed.port)
            return urlunsplit((parsed.scheme, host, parsed.path, '', ''))
        except ValueError:
            return '[REDACTED-URL]'

    def clean(self, value):
        if isinstance(value, dict):
            return {str(key): '[REDACTED]' if re.search(r'(?i)^(?:token|cookie|authorization|password|api_?key|credential)$', str(key))
                    else self.clean(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [self.clean(item) for item in value]
        if isinstance(value, str):
            return self.text(value)
        return value


class Ledger:
    """Correlate each failure with its exact request, envelope type and code.

    Native RPC has rpcId. Original sidebar HTTP has no envelope ID; give its
    intercepted request a separate observer ID, never pretend that is rpcId.
    No rejection is excused merely because its URL path matches.
    """
    def __init__(self):
        self.entries = []
        self.by_request = {}
        self.explicit = {}

    def expect(self, request_id, request_type, method, code):
        self.explicit[request_id] = (request_type, method, code)

    def begin(self, request):
        existing = self.by_request.get(request)
        if existing:
            return existing
        path = urlsplit(request.url).path
        try:
            body = request.post_data_json if request.method == 'POST' else None
        except Exception:
            body = None
        rpc = isinstance(body, dict) and body.get('type') == 'client-request'
        entry = {'observer_id': str(uuid4()), 'request_id': body.get('rpcId') if rpc else None,
                 'request_type': body.get('type') if rpc else 'sidebar-http' if path.startswith('/sidebar/') else 'http',
                 'method': body.get('method') if rpc else path.rsplit('/', 1)[-1],
                 'verb': request.method, 'path': path, 'status': None}
        if rpc:
            require(isinstance(entry['request_id'], str) and bool(entry['request_id']), 'RPC_REQUEST_ID_MISSING')
        self.entries.append(entry)
        self.by_request[id(request)] = entry
        return entry

    def finish(self, entry, status, body=None):
        entry['status'] = status
        if not isinstance(body, dict):
            return
        if 'rpcId' in body and entry['request_id']:
            require(body['rpcId'] == entry['request_id'], 'RPC_RESPONSE_ID_MISMATCH')
        result = body.get('result', body)
        if isinstance(result, dict) and result.get('ok') is False:
            code = result.get('error', {}).get('code')
            entry['code'] = code
            key = entry['request_id'] or entry['observer_id']
            identity = (entry['request_type'], entry['method'], code)
            explicit = self.explicit.get(key)
            # Reviewed automatic original UI reads only, each preserved by ID.
            expected = explicit == identity or (
                entry['request_type'] == 'client-request' and entry['method'] == 'skills/list'
                and code == 'agent-studio/disabled' and bool(entry['request_id'])) or (
                entry['request_type'] == 'sidebar-http' and entry['method'] == 'changes.ops'
                and code == 'agent-studio/provider-unavailable')
            entry['expected_rejection'] = expected
            entry['rejection_identity'] = {'id': key, 'type': identity[0], 'method': identity[1], 'code': code}

    def unexpected(self):
        return [item for item in self.entries
                if (item.get('code') or (item.get('status') or 0) >= 400)
                and not item.get('expected_rejection')]


class ExactOriginProxy:
    """No network continuation: explicit same-origin fetch, bounded redirects.

    Context APIRequestContext shares the browser cookie jar. Each fetch has
    max_redirects=0. Redirect responses are consumed here, never passed through
    to Chromium where route handlers would miss redirected requests.
    """
    def __init__(self, context, allowed, ledger, report):
        self.context = context
        self.allowed = frozenset(allowed)
        self.ledger = ledger
        self.report = report

    def route(self, route):
        request = route.request
        try:
            entry = self.ledger.begin(request)
            current = request.url
            require(origin_of(current) in self.allowed, 'UNAPPROVED_REQUEST_ORIGIN')
            method, data = request.method, request.post_data_buffer
            headers = {key: value for key, value in request.all_headers().items()
                       if key.lower() not in {'host', 'cookie', 'content-length'}}
            for hop in range(6):
                response = self.context.request.fetch(current, method=method, data=data,
                    headers=headers, max_redirects=0, timeout=180000, fail_on_status_code=False)
                if response.status not in REDIRECTS:
                    body = None
                    if 'json' in response.headers.get('content-type', ''):
                        try:
                            body = response.json()
                        except Exception:
                            self.report['decode_errors'].append({'id': entry['observer_id'], 'kind': 'json'})
                    self.ledger.finish(entry, response.status, body)
                    route.fulfill(response=response)
                    response.dispose()
                    return
                location = response.headers.get('location')
                require(bool(location), 'REDIRECT_LOCATION_MISSING')
                target = redirect_target(current, location, self.allowed)
                self.report['redirects'].append({'id': entry['observer_id'], 'status': response.status,
                                                'same_origin': True, 'hop': hop + 1})
                method, data = redirect_request(response.status, method, data)
                if data is None:
                    headers.pop('content-type', None)
                response.dispose()
                current = target
            raise AssertionError('REDIRECT_LIMIT')
        except Exception as error:
            self.report['network_guard_errors'].append({'kind': type(error).__name__, 'error': str(error)})
            route.abort('blockedbyclient')


def single_line_python(program):
    require(isinstance(program, str), 'PROGRAM_TYPE')
    payload = base64.b64encode(program.encode()).decode()
    invocation = 'import base64;exec(compile(base64.b64decode(' + repr(payload) + '),"<fresh-browser>","exec"))'
    return 'python3 -I -c ' + shlex.quote(invocation)


def terminal_program(relative):
    safe_relative(relative)
    return ('import json,os,pathlib,secrets\n'
            'nonce=secrets.token_hex(24)\n'
            'proof={"nonce":nonce,"cwd":os.getcwd(),"pid":os.getpid()}\n'
            'pathlib.Path(' + repr(relative) + ').write_text(json.dumps(proof)+"\\n")\n'
            'print("FRESH_TERMINAL_PROOF "+nonce,flush=True)\n'
            'print("FRESH_TERMINAL_CWD "+os.getcwd(),flush=True)\n')


def terminal_nonce(output):
    # Full output line, not shell echo containing source or a fixed expected value.
    values = re.findall(r'(?:^|[\r\n])FRESH_TERMINAL_PROOF ([a-f0-9]{48})(?=\r?\n|$)', output)
    return values[-1] if values else None


def safe_relative(path):
    require(isinstance(path, str) and path and '\\' not in path and '\0' not in path
            and not path.startswith('/') and all(part not in {'', '.', '..'} for part in path.split('/')),
            'UNSAFE_RELATIVE_PATH')
    return path


# A read-only subprocess in the fresh manifest's exact container, NOT DSH RPC.
OBSERVER = r'''
import hashlib,json,os,pathlib,sys
root=pathlib.Path(sys.argv[1]); request=json.loads(sys.argv[2])
assert root.is_absolute() and root.resolve()==root and not root.is_symlink()
assert root.parent==pathlib.Path('/workspace') and root.name.startswith('agent-studio-')
result={'root':str(root),'uid':os.getuid(),'files':[],'processes':[]}
for relative in request['paths']:
 parts=relative.split('/')
 assert relative and all(p not in ('','.','..') for p in parts) and not relative.startswith('/')
 path=root/relative
 assert not path.is_symlink() and path.resolve().is_relative_to(root)
 if not path.exists(): result['files'].append({'path':relative,'exists':False}); continue
 assert path.is_file() and path.stat().st_size<=196608
 data=path.read_bytes()
 item={'path':relative,'exists':True,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
 if relative in request.get('safe_text_paths',[]): item['text']=data.decode('utf-8')
 result['files'].append(item)
for pid in request['pids']:
 assert isinstance(pid,int) and pid>1
 proc=pathlib.Path('/proc')/str(pid)
 try:
  fields=(proc/'stat').read_text().split(') ')[1].split()
  names=[v.split(b'=',1)[0].decode(errors='replace') for v in (proc/'environ').read_bytes().split(b'\0') if v]
  result['processes'].append({'pid':pid,'exists':True,'state':fields[0],'start_tick':fields[19],
   'cwd':str((proc/'cwd').resolve()),'coder_credentials_present':any(n in {'CODER_SESSION_TOKEN','CODER_AGENT_TOKEN'} for n in names)})
 except FileNotFoundError: result['processes'].append({'pid':pid,'exists':False})
print(json.dumps(result))
'''


class DirectObserver:
    def __init__(self, coder_manifest):
        workspace = coder_manifest['workspace']
        self.container = workspace['container_id']
        require(re.fullmatch(r'[a-f0-9]{64}', self.container) is not None, 'FRESH_CONTAINER_ID_REQUIRED')
        self.name = workspace['container_name'].lstrip('/')
        result = subprocess.run(['docker', 'inspect', self.container], capture_output=True, text=True, timeout=20)
        require(result.returncode == 0, 'FRESH_CONTAINER_INSPECT_FAILED_DIAGNOSTICS_WITHHELD')
        inspected = json.loads(result.stdout)
        require(len(inspected) == 1 and inspected[0]['Id'] == self.container
                and inspected[0]['Name'].lstrip('/') == self.name and inspected[0]['State']['Running'],
                'FRESH_CONTAINER_IDENTITY_MISMATCH')
        self.identity = {'container_id': self.container, 'container_name': self.name,
                         'workspace_id': workspace.get('id'), 'running': True}

    def observe(self, binding, paths, pids=(), safe_text_paths=()):
        target = '/workspace/agent-studio-' + binding['binding_id'] + '-v' + str(binding['version'])
        require(binding['target_root'] == target, 'OBSERVER_NOT_NEW_BINDING_ROOT')
        for path in paths:
            safe_relative(path)
        require(len(paths) <= 20 and len(pids) <= 10 and set(safe_text_paths) <= set(paths), 'OBSERVER_LIMIT')
        payload = json.dumps({'paths': list(paths), 'pids': list(pids), 'safe_text_paths': list(safe_text_paths)})
        result = subprocess.run(['docker', 'exec', '--user', '1000', self.container, 'python3', '-I', '-c',
                                 OBSERVER, target, payload], capture_output=True, text=True, timeout=30)
        require(result.returncode == 0, 'DIRECT_REMOTE_OBSERVATION_FAILED_DIAGNOSTICS_WITHHELD')
        value = json.loads(result.stdout)
        require(value['root'] == target and value['uid'] == 1000, 'DIRECT_REMOTE_IDENTITY_MISMATCH')
        return value


def read_json(path):
    return json.loads(path.read_text())


def load_inputs(root, out, live_ready):
    require(live_ready, 'WAIT_FOR_LEAD_LIVE_READY')
    require(root.resolve() == FRESH / 'dsh' and not root.is_symlink(), 'ONLY_FRESH_DSH_ROOT')
    require(out.resolve().is_relative_to(OUT) and not out.is_symlink(), 'ONLY_BROWSER_ARTIFACT_SCOPE')
    require(out.resolve() != OUT, 'USE_NEW_ARTIFACT_RUN_DIRECTORY')
    manifest = read_json(root / 'fresh-manifest.json')
    ready = read_json(root / 'ready.json')
    coder = read_json(FRESH / 'coder/manifest.json')
    origin = checked_origin(ready['origin'])
    coder_origin = checked_origin(coder['origin'])
    require(manifest.get('origin', origin) == ready['origin'], 'MANIFEST_ORIGIN_MISMATCH')
    # An offline protocol fixture can never become evidence for this probe.
    require(not (root / 'offline-model-fixture.json').exists(), 'OFFLINE_FIXTURE_REFUSED')
    return manifest, coder, origin, coder_origin


class Probe:
    def __init__(self, args):
        self.args = args
        self.manifest, self.coder, self.origin, self.coder_origin = load_inputs(args.root, args.out, args.live_ready)
        args.out.mkdir(parents=True, exist_ok=False, mode=0o700)
        self.scrub = Sanitizer()
        self.ledger = Ledger()
        self.terminals = []
        self.active_sessions = set()
        self.frames = []
        self.ui_replies = []
        self.report = {'scope': 'actual fresh DSH + fresh Coder; native browser, not offline fixture',
            'trace_gap': 'Unresolved earlier topology/work TRACE GAP; fresh success is not restored historical work.',
            'result': 'running', 'checks': [], 'console': [], 'page_errors': [], 'decode_errors': [],
            'network_guard_errors': [], 'external_websockets': [], 'redirects': [], 'cleanup': [],
            'real_model': {'status': 'not-exercised'},
            'external_cli': {'status': 'not-exercised', 'reason': 'No agent CLI invoked by this probe.'}}
        self.observer = DirectObserver(self.coder)
        self.report['direct_remote_identity'] = self.observer.identity

    def check(self, name, **facts):
        self.report['checks'].append({'name': name, **facts})
        print('PASS ' + name, flush=True)

    def wait_for(self, fn, code, timeout=60):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = fn()
            if value:
                return value
            self.page.wait_for_timeout(150)
        raise AssertionError(code)

    def sql(self, query, values=()):
        with sqlite3.connect('file:' + str(self.args.root / 'bindings.sqlite') + '?mode=ro', uri=True) as db:
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute(query, values)]

    def rpc(self, method, payload, channel='/agent-studio-rpc', expected_code=None):
        request_id = str(uuid4())
        if expected_code:
            self.ledger.expect(request_id, 'client-request', method, expected_code)
        url = self.origin + channel + '/' + method
        require(origin_of(url) == self.origin, 'RPC_ORIGIN')
        response = self.context.request.post(url, headers={'origin': self.origin},
            data={'type': 'client-request', 'rpcId': request_id, 'method': method, 'payload': payload},
            max_redirects=0, timeout=180000, fail_on_status_code=False)
        require(response.status not in REDIRECTS, 'RPC_REDIRECT_REFUSED')
        body = response.json()
        entry = {'observer_id': str(uuid4()), 'request_id': request_id, 'request_type': 'client-request',
                 'method': method, 'verb': 'POST', 'path': channel + '/' + method, 'status': None}
        self.ledger.entries.append(entry)
        self.ledger.finish(entry, response.status, body)
        require(response.status == 200, 'RPC_HTTP_' + str(response.status))
        result = body.get('result', {})
        if expected_code:
            require(result.get('ok') is False and result.get('error', {}).get('code') == expected_code
                    and entry.get('expected_rejection'), 'EXPECTED_REJECTION_ID_TYPE_CODE_MISMATCH')
            return entry['rejection_identity']
        require(result.get('ok') is True, 'RPC_FAILED_' + method + '_' + str(result.get('error', {}).get('code')))
        return result.get('value')

    def response(self, response):
        # Request correlation is captured by the route before any request leaves.
        path = urlsplit(response.url).path
        if response.request.method != 'POST' or not path.startswith(('/api/', '/agent-studio-rpc/', '/sidebar/')):
            return
        try:
            body = response.json()
            result = body.get('result', body)
            entry = self.ledger.by_request.get(id(response.request))
            # Playwright may wrap Request again; rpcId is the stable wire identity.
            try:
                request = response.request.post_data_json
            except Exception:
                request = None
            self.ui_replies.append({'path': path, 'request': request, 'body': body})
            if path == '/api/terminal/create' and result.get('ok'):
                terminal = {'session_id': request['payload']['args']['agentId'], 'id': result['value']['id']}
                if terminal not in self.terminals:
                    self.terminals.append(terminal)
        except Exception as error:
            self.report['decode_errors'].append({'path': path, 'kind': type(error).__name__})

    def screenshot(self, name, gate=False):
        parsed = urlsplit(self.page.url)
        require(origin_of(self.page.url) == self.origin and not parsed.query and not parsed.fragment,
                'SCREENSHOT_REQUIRES_CLEAN_URL')
        # Inputs on the anonymous gate and all credential fields are masked.
        mask = self.page.locator('input, textarea') if gate else self.page.locator(
            'input[type=password],input[autocomplete=current-password],input[aria-label="API key"]')
        self.page.screenshot(path=str(self.args.out / name), full_page=True, mask=[mask])

    def auth(self):
        from playwright.sync_api import expect
        page = self.page
        page.goto(self.origin + '/', wait_until='domcontentloaded')
        self.wait_for(lambda: bool(page.locator('body').inner_text().strip()), 'ANONYMOUS_DOM_EMPTY')
        anonymous = page.locator('body').inner_text()
        require(page.get_by_role('button', name='Manage environments', exact=True).count() == 0,
                'ANONYMOUS_PAGE_ALREADY_AUTHENTICATED')
        require(bool(re.search(r'connect|authenticat|token|sign.?in|access', anonymous, re.I)), 'AUTH_GATE_DOM_NOT_FOUND')
        self.report['auth_gate'] = {'visible': True, 'text': self.scrub.text(anonymous)[:1600]}
        self.screenshot('01-auth-gate.png', gate=True)
        login_file = self.args.root / 'login-url.txt'
        require(login_file.is_file(), 'LOGIN_URL_FILE_NOT_READY')
        private_url = login_file.read_text().strip()
        require(origin_of(private_url) == self.origin, 'LOGIN_ORIGIN_MISMATCH')
        self.scrub.add(private_url)
        for values in parse_qs(urlsplit(private_url).query).values():
            self.scrub.add(*values)
        page.goto(private_url, wait_until='domcontentloaded')
        # Proxy consumes redirects itself; explicitly leave the credential URL.
        page.goto(self.origin + '/', wait_until='domcontentloaded')
        self.scrub.add(*(item['value'] for item in self.context.cookies()))
        expect(page.get_by_role('button', name='Account menu', exact=True)).to_be_visible(timeout=45000)
        expect(page.get_by_role('button', name='Manage environments', exact=True)).to_be_visible(timeout=45000)
        self.screenshot('02-authenticated.png')
        self.check('real anonymous auth DOM -> private login -> clean authenticated native DOM', clean_url=True)

    def open_environment(self):
        from playwright.sync_api import expect
        page = self.page
        before = self.sql('SELECT count(*) n FROM session_bindings')[0]['n']
        page.get_by_role('button', name='Manage environments', exact=True).click()
        panel = page.locator('dialog[open] [data-studio-environments]')
        expect(panel.get_by_role('button', name='Discover now', exact=True)).to_be_enabled(timeout=45000)
        count = len(self.ui_replies)
        panel.get_by_role('button', name='Discover now', exact=True).click()
        def discovery():
            return next((item for item in self.ui_replies[count:] if item['path'] == '/agent-studio-rpc/environment.discover'), None)
        reply = self.wait_for(discovery, 'ENVIRONMENT_DISCOVERY_RESPONSE_MISSING', timeout=120)
        require(reply['body'].get('result', {}).get('ok') is True, 'ENVIRONMENT_DISCOVERY_FAILED')
        workspace_id = self.coder['workspace']['id']
        item = next((item for item in reply['body']['result']['value']['workspaces'] if item['workspace_id'] == workspace_id), None)
        require(item and item['status']['identity']['verified'] and item['status']['lifecycle'] == 'running', 'FRESH_ENVIRONMENT_NOT_VERIFIED')
        panel.get_by_role('button').filter(has_text=workspace_id).click()
        panel.get_by_label('Environment binding', exact=True).select_option('')
        self.screenshot('03-fresh-environment.png')
        count = len(self.ui_replies)
        panel.get_by_role('button', name='Connect and open session', exact=True).click()
        reply = self.wait_for(lambda: next((item for item in self.ui_replies[count:]
            if item['path'] == '/agent-studio-rpc/environment.open'), None), 'ENVIRONMENT_OPEN_RESPONSE_MISSING', timeout=200)
        require(reply['body'].get('result', {}).get('ok') is True, 'ENVIRONMENT_OPEN_RPC_FAILED')
        link = reply['body']['result']['value']
        require(link['state'] == 'ready' and link['project_id'] and link['session_id'], 'ENVIRONMENT_OPEN_NOT_READY_' + str(link.get('error_code')))
        self.session = link['session_id']
        self.binding = self.rpc('binding.get', {'binding_id': link['binding_id'], 'version': link['version']})
        require(self.binding['project_id'] == link['project_id'] and self.binding['version'] == 1, 'NEW_PROJECT_BINDING_IDENTITY')
        require(self.sql('SELECT count(*) n FROM session_bindings')[0]['n'] == before + 1, 'NEW_SESSION_NOT_CREATED')
        native = self.rpc('session.get', {'session_id': self.session})
        require(native['native'] and native['binding_id'] == link['binding_id'], 'NATIVE_SESSION_IDENTITY')
        expect(panel).not_to_be_visible(timeout=30000)
        self.check('original environment discovery -> NEW project/binding/native session -> authenticated helper',
                   link=link, target_root=self.binding['target_root'], native=True)

    def files(self):
        from playwright.sync_api import expect
        page = self.page
        self.file = 'fresh-browser-' + secrets.token_hex(8) + '.txt'
        initial = 'Actual fresh browser initial bytes ' + secrets.token_hex(16) + '\n'
        # Seed is explicitly setup RPC; opening, editing and saving are real DOM.
        self.rpc('fs.write', {'session_id': self.session, 'path': self.file, 'operation_id': str(uuid4()),
            'encoding': 'utf8', 'data': initial, 'expected_version': None})
        page.get_by_role('button', name='Open right sidebar', exact=True).click()
        page.get_by_role('button', name='Files', exact=True).click()
        page.get_by_placeholder('Name or content: text (bounded search)').fill(self.file)
        hit = page.locator('[data-studio-search-hit]:visible').filter(has_text=self.file)
        expect(hit).to_have_count(1, timeout=45000)
        hit.get_by_role('button').first.click()
        editor = page.locator('.cm-content[contenteditable="true"]:visible')
        expect(editor).to_contain_text(initial.strip(), timeout=30000)
        content = 'Actual original Files save 中文 ' + secrets.token_hex(24) + '\n'
        editor.click()
        page.keyboard.press('Control+a')
        page.keyboard.insert_text(content)
        count = len(self.ui_replies)
        page.get_by_role('button', name='Save', exact=True).click()
        saved = self.wait_for(lambda: next((item for item in self.ui_replies[count:] if item['path'] == '/sidebar/write'), None), 'FILES_SAVE_RESPONSE_MISSING')
        require(saved['body'].get('ok') is True and saved['body'].get('value', {}).get('ok') is True, 'FILES_SAVE_REJECTED')
        direct = self.observer.observe(self.binding, [self.file])
        digest = hashlib.sha256(content.encode()).hexdigest()
        require(direct['files'][0]['sha256'] == digest, 'FILES_DIRECT_REMOTE_HASH_MISMATCH')
        read = self.rpc('fs.read', {'session_id': self.session, 'path': self.file})
        require(base64.b64decode(read['data']) == content.encode(), 'FILES_RPC_BYTES_MISMATCH')
        self.screenshot('04-files-saved.png')
        self.check('original remote Files open/edit/Save -> direct fresh container bytes',
                   path=self.file, sha256=digest, remote=direct)
        # Explicit rejection uses exact ID + envelope type + error code.
        rejected = self.rpc('fs.read', {'session_id': self.session, 'path': '../outside'}, expected_code='invalid-relative-path')
        self.check('path escape rejected by exact request ID/type/code', rejection=rejected)

    def terminal(self):
        page = self.page
        page.get_by_role('button', name='New tab', exact=True).first.click()
        page.get_by_role('button', name='New terminal', exact=True).click()
        terminal = page.locator('.xterm-helper-textarea:visible')
        terminal.wait_for(state='attached', timeout=60000)
        owned = self.wait_for(lambda: next((item for item in self.terminals if item['session_id'] == self.session), None), 'NATIVE_TERMINAL_CREATE_MISSING')
        operation = self.wait_for(lambda: next(iter(self.sql("SELECT * FROM operation_records WHERE session_id=? AND kind='pty.open' ORDER BY rowid DESC LIMIT 1", (self.session,))), None), 'PTY_OPERATION_MISSING')
        proof_path = 'fresh-terminal-' + secrets.token_hex(8) + '.json'
        command = single_line_python(terminal_program(proof_path))
        require('\n' not in command and '\r' not in command, 'TERMINAL_COMMAND_MULTILINE')
        terminal.focus()
        page.keyboard.insert_text(command)
        page.keyboard.press('Enter')
        def output_proof():
            result = self.rpc('task.read', {'session_id': self.session, 'operation_id': operation['operation_id']})
            output = ''.join(base64.b64decode(item['data']).decode(errors='replace') for item in result.get('chunks', []))
            nonce = terminal_nonce(output)
            return (output, nonce) if nonce else None
        output, nonce = self.wait_for(output_proof, 'REMOTE_UNPREDICTABLE_NONCE_NOT_OUTPUT', timeout=90)
        require('FRESH_TERMINAL_CWD ' + self.binding['target_root'] in output, 'TERMINAL_REMOTE_CWD_MISSING')
        self.wait_for(lambda: any('FRESH_TERMINAL_PROOF ' + nonce in frame for frame in self.frames), 'BROWSER_WS_NONCE_NOT_RECEIVED')
        pid = operation.get('remote_pid')
        require(isinstance(pid, int) and pid > 1, 'REMOTE_PTY_PID_MISSING')
        direct = self.observer.observe(self.binding, [proof_path], [pid], safe_text_paths=[proof_path])
        proof = json.loads(direct['files'][0]['text'])
        require(proof['nonce'] == nonce and proof['cwd'] == self.binding['target_root'], 'TERMINAL_DIRECT_REMOTE_PROOF_MISMATCH')
        process = direct['processes'][0]
        require(process['exists'] and process['cwd'] == self.binding['target_root'] and not process['coder_credentials_present'], 'TERMINAL_DIRECT_PROCESS_IDENTITY')
        self.screenshot('05-terminal-live.png')
        self.check('native Terminal keyboard -> remote-generated unpredictable nonce -> browser stream + independent file/PID',
            terminal=owned, operation_id=operation['operation_id'], nonce=nonce, direct=direct)
        self.rpc('terminal/close', {'args': {'agentId': self.session, 'id': owned['id']}}, '/api')
        self.terminals.remove(owned)
        closed = self.rpc('operation.get', {'operation_id': operation['operation_id']})
        after = self.observer.observe(self.binding, [], [pid])['processes'][0]
        require(closed['state'] == 'released' and (not after.get('exists') or after.get('state') == 'Z'
                or after.get('start_tick') != process['start_tick']), 'PTY_CLEANUP_NOT_INDEPENDENTLY_CONFIRMED')
        self.check('native terminal close releases original PTY; direct PID/start_tick no longer live', after=after)

    def model(self):
        from playwright.sync_api import expect
        model = self.manifest.get('model', {})
        if model.get('configured') is not True:
            self.report['real_model'] = {'status': 'not-exercised', 'reason': 'Fresh instance has no configured real model backend; offline fallback prohibited.'}
            return
        require(model.get('real_backend') is True, 'MODEL_NOT_EXPLICITLY_REAL')
        info = self.rpc('model.describe', {})
        require(not info.get('offline_fixture'), 'OFFLINE_MODEL_FIXTURE_REFUSED')
        provider, model_id = model['provider'], model['model']
        route = info.get('providers', {}).get(provider)
        require(route and urlsplit(route['baseURL']).scheme == 'https' and any(item['id'] == model_id for item in route['models']), 'REAL_MODEL_ROUTE_NOT_CONFIGURED')
        button = self.page.get_by_role('button', name=re.compile('^Select model, current'))
        button.click()
        self.page.get_by_role('menuitem').filter(has_text=re.compile('^Model')).click()
        self.page.get_by_role('menuitemradio', name=model['display_name'], exact=True).click()
        self.wait_for(lambda: self.sql('SELECT 1 FROM model_selections WHERE session_id=? AND provider=? AND model=?',
                                     (self.session, provider, model_id)), 'NATIVE_MODEL_SELECTION_MISSING')
        directory = 'live-code-' + secrets.token_hex(6)
        self.rpc('fs.mkdir', {'session_id': self.session, 'path': directory, 'operation_id': str(uuid4())})
        module = directory + '/intervals.py'
        test_file = directory + '/test_intervals.py'
        tests = '''import unittest\nfrom intervals import merge_intervals\nclass IntervalTests(unittest.TestCase):\n def test_examples(self):\n  self.assertEqual(merge_intervals([(5,8),(1,3),(3,6),(12,12)]),[(1,8),(12,12)])\n def test_empty(self):\n  self.assertEqual(merge_intervals([]),[])\n def test_no_mutation(self):\n  data=[(9,10),(1,4),(2,3)];before=list(data)\n  self.assertEqual(merge_intervals(data),[(1,4),(9,10)])\n  self.assertEqual(data,before)\n def test_invalid(self):\n  with self.assertRaises(ValueError): merge_intervals([(7,2)])\nif __name__=='__main__': unittest.main()\n'''
        for path, content in [(module, 'def merge_intervals(intervals):\n    raise NotImplementedError("Implement the real coding task")\n'), (test_file, tests)]:
            self.rpc('fs.write', {'session_id': self.session, 'path': path, 'operation_id': str(uuid4()), 'encoding': 'utf8', 'data': content, 'expected_version': None})
        prompt = ('Real coding task in this remote binding. Implement ' + module +
            ' merge_intervals(intervals): accept a sequence of (start,end) numeric pairs, return sorted tuples merging overlaps and touching endpoints, never mutate input, reject start>end with ValueError, empty input returns []. '
            'Read the file and tests in ' + directory + '; use native bound tools to edit only intervals.py and execute python3 -B -m unittest discover -s ' + directory +
            ' -p test_intervals.py. Do not modify tests or other files. Report actual test result. No delegates or external agent CLI.')
        composer = self.page.locator('[contenteditable="true"][data-lexical-editor="true"]:visible').first
        composer.fill(prompt)
        count = len(self.ui_replies)
        self.page.get_by_role('button', name='Send message', exact=True).click()
        reply = self.wait_for(lambda: next((item for item in self.ui_replies[count:] if item['path'] == '/api/session/prompt'), None), 'REAL_MODEL_PROMPT_RESPONSE_MISSING')
        result = reply['body'].get('result', {})
        require(result.get('ok') and result.get('value') == {'accepted': True}, 'REAL_MODEL_PROMPT_NOT_ACCEPTED')
        request = reply['request']['payload']['args']['request']
        require(request['sessionId'] == self.session, 'MODEL_SESSION_MISMATCH')
        self.active_sessions.add(self.session)
        # No approval escalation: if a native tool requires approval, stop/report.
        def finished():
            if self.page.get_by_role('button', name='Allow once', exact=True).count():
                raise AssertionError('MODEL_TOOL_APPROVAL_REQUIRED_NOT_ESCALATED')
            rows = self.sql('SELECT * FROM model_requests WHERE request_id=?', (request['requestId'],))
            return rows[0] if rows and rows[0]['state'] not in {'admitting', 'queued', 'running'} else None
        row = self.wait_for(finished, 'REAL_MODEL_TURN_TIMEOUT', timeout=self.args.model_timeout)
        require(row['state'] == 'completed', 'REAL_MODEL_TURN_' + row['state'] + '_' + str(row.get('error_code')))
        self.active_sessions.remove(self.session)
        calls = self.sql('SELECT name,state FROM model_tool_calls WHERE request_id=?', (request['requestId'],))
        require(calls and all(item['state'] == 'completed' for item in calls), 'REAL_MODEL_TOOLS_NOT_COMPLETED')
        direct = self.observer.observe(self.binding, [module, test_file], safe_text_paths=[module])
        require(direct['files'][0]['exists'] and 'NotImplementedError' not in direct['files'][0]['text'], 'MODEL_DID_NOT_WRITE_IMPLEMENTATION')
        require(direct['files'][1]['sha256'] == hashlib.sha256(tests.encode()).hexdigest(), 'MODEL_MODIFIED_TESTS')
        # Independent read-only execution of the model-produced module; no DSH/LLM mock.
        verify = 'import os,runpy,sys; os.chdir(sys.argv[1]); sys.path.insert(0,os.getcwd()); runpy.run_path("test_intervals.py",run_name="__main__")'
        result = subprocess.run(['docker', 'exec', '--user', '1000', self.observer.container, 'python3', '-I', '-B', '-c',
            verify, self.binding['target_root'] + '/' + directory], capture_output=True, text=True, timeout=30)
        require(result.returncode == 0 and re.search(r'Ran 4 tests', result.stderr) and '\nOK' in result.stderr, 'INDEPENDENT_MODEL_CODE_TESTS_FAILED')
        self.screenshot('06-real-model-complete.png')
        self.report['real_model'] = {'status': 'passed', 'request_id': request['requestId'], 'provider': provider,
            'model': model_id, 'tools': calls, 'direct': direct, 'independent_test_result': result.stderr}
        self.check('real native model UI Send -> completed tool-backed coding task -> independent remote tests',
                   request_id=request['requestId'], test_count=4)

    def run(self):
        from playwright.sync_api import sync_playwright
        # All cleanup is INSIDE Playwright lifetime, including exceptional paths.
        with sync_playwright() as playwright:
            browser = None
            try:
                browser = playwright.chromium.launch(executable_path=self.args.browser, headless=True)
                self.context = browser.new_context(viewport={'width': 1600, 'height': 1050},
                    service_workers='block', ignore_https_errors=True)
                proxy = ExactOriginProxy(self.context, {self.origin, self.coder_origin}, self.ledger, self.report)
                self.context.route('**/*', proxy.route)
                def ws_route(route):
                    if origin_of(route.url) not in {self.origin, self.coder_origin}:
                        self.report['external_websockets'].append({'origin': origin_of(route.url)})
                        route.close(code=1008, reason='Origin blocked')
                    else:
                        route.connect_to_server()
                self.context.route_web_socket('**/*', ws_route)
                self.page = self.context.new_page()
                self.page.on('pageerror', lambda error: self.report['page_errors'].append(str(error)))
                self.page.on('console', lambda message: self.report['console'].append({'type': message.type,
                    'text': message.text[:2500]}) if message.type in {'warning', 'error'} else None)
                self.page.on('response', self.response)
                self.page.on('websocket', lambda ws: ws.on('framereceived', lambda frame:
                    self.frames.append(frame) if isinstance(frame, str) else None))
                self.auth()
                self.open_environment()
                self.files()
                self.terminal()
                self.model()
                require(not self.report['network_guard_errors'] and not self.report['external_websockets'], 'NETWORK_GUARD_FAILURE')
                require(not self.report['page_errors'] and not self.ledger.unexpected(), 'UNEXPECTED_BROWSER_OR_RPC_FAILURE')
                self.report['result'] = 'passed' if self.report['real_model']['status'] == 'passed' else 'passed-browser-model-not-exercised'
            except Exception as error:
                self.report['result'] = 'failed'
                self.report['failure'] = {'kind': type(error).__name__, 'error': str(error)}
                if hasattr(self, 'page'):
                    try:
                        self.screenshot('failure.png', gate=True)
                        self.report['failure_dom'] = self.page.locator('body').inner_text()[:12000]
                    except Exception as screenshot_error:
                        self.report['screenshot_failure'] = type(screenshot_error).__name__
            finally:
                if hasattr(self, 'context'):
                    for session in list(self.active_sessions):
                        try:
                            self.rpc('session/cancel', {'args': {'request': {'sessionId': session}}}, '/api')
                            self.report['cleanup'].append({'kind': 'model-cancel', 'session_id': session, 'ok': True})
                        except Exception as error:
                            self.report['cleanup'].append({'kind': 'model-cancel', 'ok': False, 'error': str(error)})
                    for terminal in list(self.terminals):
                        try:
                            self.rpc('terminal/close', {'args': {'agentId': terminal['session_id'], 'id': terminal['id']}}, '/api')
                            self.report['cleanup'].append({'kind': 'terminal-close', 'id': terminal['id'], 'ok': True})
                        except Exception as error:
                            self.report['cleanup'].append({'kind': 'terminal-close', 'ok': False, 'error': str(error)})
                    self.scrub.add(*(item['value'] for item in self.context.cookies()))
                    if any(item.get('ok') is False for item in self.report['cleanup']):
                        self.report['result'] = 'failed'
                    self.context.close()
                if browser:
                    browser.close()
                self.report['requests'] = self.ledger.entries
                self.report['unexpected_requests'] = self.ledger.unexpected()
                self.write_report()
        print(json.dumps({'result': self.report['result'], 'checks': len(self.report['checks']),
            'real_model': self.report['real_model']['status'], 'report': str(self.args.out / 'browser.json')}), flush=True)
        return 1 if self.report['result'] == 'failed' else 0

    def write_report(self):
        clean = self.scrub.clean(self.report)
        text = json.dumps(clean, ensure_ascii=False, indent=2)
        require(not any(secret in text for secret in self.scrub.secrets), 'ARTIFACT_SECRET_SCAN_FAILED')
        (self.args.out / 'browser.json').write_text(text + '\n')
        (self.args.out / 'browser.json').chmod(0o600)
        lines = ['# Fresh actual browser acceptance', '', '- Result: **' + clean['result'] + '**',
                 '- Real model: **' + clean['real_model']['status'] + '**',
                 '- External agent CLI: not exercised.', '- ' + clean['trace_gap'], '', '## Proven checks']
        lines += ['- ' + item['name'] for item in clean['checks']]
        if 'failure' in clean:
            lines += ['', '## Failure', '```json', json.dumps(clean['failure'], ensure_ascii=False), '```']
        lines += ['', '## Scope notes',
                  'Offline fixtures and unit tests are not evidence for a real model or CLI.',
                  'Local probe setup seeds a scratch file via RPC; Files open/edit/save is browser DOM.',
                  'Direct remote evidence uses only the fresh manifest container ID, independent of DSH RPC.',
                  'All terminal/model cleanup occurs before Playwright exits.', '']
        (self.args.out / 'report.md').write_text('\n'.join(lines))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=FRESH / 'dsh')
    parser.add_argument('--out', type=Path, default=OUT / ('run-' + time.strftime('%Y%m%d-%H%M%S') + '-' + secrets.token_hex(3)))
    parser.add_argument('--browser', default='/snap/bin/chromium')
    parser.add_argument('--model-timeout', type=int, default=300)
    parser.add_argument('--live-ready', action='store_true', help='Explicit Lead live-ready acknowledgement, never use before authorization.')
    args = parser.parse_args()
    require(args.live_ready, 'WAIT_FOR_LEAD_LIVE_READY')
    try:
        return Probe(args).run()
    except Exception as error:
        # Startup diagnostics do not echo manifest/auth URLs or subprocess output.
        print(json.dumps({'result': 'startup-failed', 'kind': type(error).__name__, 'error': Sanitizer().text(error)}), flush=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
