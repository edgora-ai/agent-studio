"""Provision and verify the dedicated, loopback-only Coder test deployment."""
import argparse
import hashlib
import ipaddress
import json
import os
import re
import uuid
from pathlib import Path
import secrets
import shutil
import ssl
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPSHandler, ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[2]
INFRA = ROOT / 'infra/coder-lab'
PRIVATE = ROOT / 'secrets/coder-lab'
OUTPUT = ROOT / 'artifacts/m1/t104/lab'
COMPOSE = INFRA / 'compose.yaml'
CODER_IMAGE = 'ghcr.io/coder/coder@sha256:8514c20c3c7811a9835eb903c5123b0090ba6538dc8bcc8281624d0bdedd9063'
POSTGRES_IMAGE = 'postgres@sha256:1b92e7a80c021647bf70f5d3eb66066a998e4f5cf43c07bb9dc9f729782cf88e'


def save(path, value, exclusive=True):
    with path.open('x' if exclusive else 'w', encoding='utf-8') as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
    assert json.loads(path.read_text()) == value


def execute(arguments, *, env=None, timeout=540, input_text=None):
    result = subprocess.run(arguments, cwd=ROOT, env=env, input=input_text,
                            capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        # Do not send raw provisioning output or generated credentials to the terminal.
        PRIVATE.mkdir(parents=True, exist_ok=True, mode=0o700)
        log = PRIVATE / f'failure-{secrets.token_hex(6)}.log'
        with log.open('x') as handle:
            handle.write(result.stdout + '\n' + result.stderr)
        log.chmod(0o600)
        raise RuntimeError(f'{arguments[0]} exited {result.returncode}; private diagnostics: {log.relative_to(ROOT)}')
    return result.stdout


def compose(*arguments, **kwargs):
    return execute(['docker', 'compose', '--env-file', str(PRIVATE / 'compose.env'),
                    '-f', str(COMPOSE), *arguments], **kwargs)


def container_id(service):
    value = compose('ps', '-q', service).strip()
    if not value:
        raise RuntimeError(f'Lab service is not running: {service}')
    return value


def state():
    return json.loads((OUTPUT / 'state.json').read_text())


def request(path, *, body=None, token=None, expected=200, with_status=False):
    config = state()
    context = ssl.create_default_context(cafile=str(PRIVATE / 'tls/ca.crt'))
    opener = build_opener(ProxyHandler({}), HTTPSHandler(context=context))
    headers = {'Accept': 'application/json'}
    if token:
        headers['Coder-Session-Token'] = token
    if body is not None:
        headers['Content-Type'] = 'application/json'
    req = Request(config['url'] + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
    try:
        response = opener.open(req, timeout=20)
    except HTTPError as error:
        response = error
    with response:
        code, content = response.status, response.read()
    allowed = (expected,) if isinstance(expected, int) else expected
    if code not in allowed:
        raise RuntimeError(f'{req.get_method()} {path}: expected HTTP {expected}, got {code}')
    try:
        value = json.loads(content)
    except json.JSONDecodeError:
        value = content.decode('utf-8')
    return (code, value) if with_status else value


def prepare(bind_address, tls_port):
    address = ipaddress.ip_address(bind_address)
    if address.version != 4 or not address.is_loopback:
        raise ValueError('This lab requires an explicit IPv4 loopback bind address')
    if not 1024 <= tls_port <= 65535:
        raise ValueError('Invalid container TLS port')
    PRIVATE.mkdir(parents=True, exist_ok=False, mode=0o700)
    OUTPUT.mkdir(parents=True, exist_ok=False)
    os.umask(0o077)
    tls = PRIVATE / 'tls'
    tls.mkdir()
    gid = os.stat('/var/run/docker.sock').st_gid
    os.chown(tls, -1, gid)
    tls.chmod(0o750)
    ca_key = PRIVATE / 'ca.key'
    execute(['openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '30',
             '-keyout', str(ca_key), '-out', str(tls / 'ca.crt'), '-subj', '/CN=Agent Studio Lab CA'])
    execute(['openssl', 'req', '-new', '-newkey', 'rsa:3072', '-nodes',
             '-keyout', str(tls / 'server.key'), '-out', str(PRIVATE / 'server.csr'), '-subj', '/CN=coder'])
    extensions = PRIVATE / 'extensions.cnf'
    extensions.write_text(f'subjectAltName=DNS:coder,IP:{address}\nextendedKeyUsage=serverAuth\n')
    execute(['openssl', 'x509', '-req', '-in', str(PRIVATE / 'server.csr'),
             '-CA', str(tls / 'ca.crt'), '-CAkey', str(ca_key), '-CAcreateserial', '-days', '30',
             '-extfile', str(extensions), '-out', str(tls / 'server.crt')])
    for path in tls.iterdir():
        os.chown(path, -1, gid)
        path.chmod(0o640 if path.suffix == '.key' else 0o644)
    build = OUTPUT / 'workspace-build'
    build.mkdir()
    shutil.copyfile(INFRA / 'Dockerfile.workspace', build / 'Dockerfile')
    shutil.copyfile(tls / 'ca.crt', build / 'ca.crt')
    for path in build.iterdir():
        path.chmod(0o644)
    build.chmod(0o755)
    template = OUTPUT / 'template'
    template.mkdir(mode=0o755)
    template.chmod(0o755)
    password = secrets.token_urlsafe(36)
    account = {'email': 'lab-owner@agent-studio.invalid', 'username': 'lab-owner',
               'name': 'Agent Studio Test Owner', 'password': secrets.token_urlsafe(36), 'trial': False}
    save(PRIVATE / 'account.json', account)
    values = {
        'CODER_IMAGE': CODER_IMAGE, 'POSTGRES_IMAGE': POSTGRES_IMAGE,
        'POSTGRES_PASSWORD': password, 'LAB_BIND_ADDRESS': str(address),
        'CODER_TLS_PORT': str(tls_port), 'DOCKER_SOCKET_GID': str(gid),
        'LAB_TLS_DIR': str(tls), 'LAB_BUILD_DIR': str(build), 'LAB_TEMPLATE_DIR': str(template),
    }
    with (PRIVATE / 'compose.env').open('x') as handle:
        handle.write(''.join(f'{key}={value}\n' for key, value in values.items()))
    baseline = execute(['docker', 'ps', '-q']).split()
    save(OUTPUT / 'state.json', {'project': 'agent-studio-coder-lab', 'bindAddress': str(address),
                               'tlsPort': tls_port, 'coderVersion': '2.37.8', 'coderImage': CODER_IMAGE,
                               'databaseImage': POSTGRES_IMAGE, 'baselineContainerIds': baseline})
    compose('config', '--quiet')
    print('PASS: dedicated config, short-lived TLS and generated test credentials saved; no secrets printed')


def up():
    compose('up', '-d', 'database', 'coder')
    config = state()
    endpoint = compose('port', 'coder', str(config['tlsPort'])).strip()
    assert endpoint.startswith(config['bindAddress'] + ':'), endpoint
    config['url'] = 'https://' + endpoint
    save(OUTPUT / 'state.json', config, exclusive=False)
    deadline = time.monotonic() + 180
    last_error = None
    while time.monotonic() < deadline:
        try:
            request('/healthz')
            break
        except (URLError, RuntimeError, TimeoutError) as error:
            last_error = error
            time.sleep(2)
    else:
        raise RuntimeError(f'Coder health deadline exceeded: {last_error}')
    token_file = PRIVATE / 'session.json'
    if not token_file.exists():
        account = json.loads((PRIVATE / 'account.json').read_text())
        first_status, _ = request('/api/v2/users/first', expected=(200, 404), with_status=True)
        if first_status == 404:
            request('/api/v2/users/first', body=account, expected=201)
        login = request('/api/v2/users/login', body={'email': account['email'], 'password': account['password']}, expected=201)
        me = request('/api/v2/users/me', token=login['session_token'])
        assert me['username'] == account['username'] and me['email'] == account['email']
        assert len(me['organization_ids']) == 1
        save(token_file, {'token': login['session_token'], 'user_id': me['id'], 'organization_id': me['organization_ids'][0]})
        token_file.chmod(0o600)
    print('PASS: Coder is running at ' + config['url'] + '; dedicated owner initialized')


def token():
    return json.loads((PRIVATE / 'session.json').read_text())['token']


def cleanup_sessions():
    session = json.loads((PRIVATE / 'session.json').read_text())
    user = str(uuid.UUID(session['user_id']))
    keep = session['token'].split('-', 1)[0]
    if not re.fullmatch('[A-Za-z0-9]{10}', keep):
        raise ValueError('Unexpected runner session identifier')
    assert request('/api/v2/users/me', token=token())['username'] == 'lab-owner'
    database = container_id('database')
    query = f"DELETE FROM api_keys WHERE user_id='{user}' AND id <> '{keep}';"
    result = execute(['docker', 'exec', database, 'psql', '-U', 'coder', '-d', 'coder', '-At', '-c', query])
    query = f"SELECT count(*) FROM api_keys WHERE user_id='{user}' AND id <> '{keep}';"
    remaining = execute(['docker', 'exec', database, 'psql', '-U', 'coder', '-d', 'coder', '-At', '-c', query]).strip()
    assert remaining == '0'
    assert request('/api/v2/users/me', token=token())['id'] == user
    print(result.strip() + '; disposable lab sessions revoked; protected runner session retained')


def cli(arguments, timeout=540):
    environment = os.environ.copy()
    environment['CODER_SESSION_TOKEN'] = token()
    # Credentials go through the subprocess environment, never command arguments or output.
    return execute(['docker', 'exec', '--env', 'CODER_SESSION_TOKEN', container_id('coder'),
                    '/opt/coder', '--url', 'https://coder:' + str(state()['tlsPort']),
                    '--global-config', '/tmp/agent-studio-lab-cli', *arguments], env=environment, timeout=timeout)


def verify():
    request('/healthz')
    page = request('/')
    assert isinstance(page, str) and '<html' in page.lower()
    request('/api/v2/users/me', expected=401)
    request('/api/v2/users/me', token='invalid-test-token', expected=401)
    me = request('/api/v2/users/me', token=token())
    assert me['username'] == 'lab-owner'
    organizations = request('/api/v2/users/me/organizations', token=token())
    assert len(organizations) == 1
    users = request('/api/v2/users?q=lab-owner', token=token())
    assert any(user['id'] == me['id'] for user in users['users'])
    query = "SELECT id::text, username, email, status::text FROM users WHERE username = 'lab-owner';"
    rows = execute(['docker', 'exec', container_id('database'), 'psql', '-U', 'coder', '-d', 'coder', '-At', '-c', query]).strip().split('|')
    assert rows[0] == me['id'] and rows[1] == me['username'] and rows[2] == me['email'] and rows[3] == me['status']
    info = json.loads(execute(['docker', 'inspect', container_id('coder')]))[0]
    bindings = info['HostConfig']['PortBindings']
    assert len(bindings) == 1 and all(binding['HostIp'] == state()['bindAddress'] for group in bindings.values() for binding in group)
    running = set(execute(['docker', 'ps', '-q']).split())
    assert set(state()['baselineContainerIds']) <= running, 'A preexisting running container disappeared'
    version = request('/api/v2/buildinfo')
    assert version['version'].startswith('v2.37.8')
    report = {
        'task': 'T-104', 'stage': 'control-plane', 'passed': True,
        'coderVersion': version['version'], 'coderImage': CODER_IMAGE,
        'databaseImage': POSTGRES_IMAGE, 'publicHealth': 200, 'loginPage': 200,
        'anonymousProtected': 401, 'invalidProtected': 401, 'authenticatedProtected': 200,
        'ownerDatabaseReadback': True, 'ownerApiReadback': True, 'ownerSearch': True,
        'tlsVerifiedWithDedicatedCA': True, 'hostBindingIsLoopbackOnly': True,
        'preexistingContainersStillRunning': True, 'workspaceChecksComplete': False,
        'browserLoginTested': False, 'stageM1Passed': False,
    }
    report_path = OUTPUT / ('control-plane-' + secrets.token_hex(4) + '.json')
    save(report_path, report)
    print(json.dumps(report, indent=2))
    print('Evidence:', report_path.relative_to(ROOT))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    setup = commands.add_parser('prepare')
    setup.add_argument('--bind-address', required=True)
    setup.add_argument('--tls-port', type=int, required=True)
    for action in ('up', 'verify', 'build-workspace', 'status', 'cleanup-sessions'):
        commands.add_parser(action)
    arguments = parser.parse_args()
    os.umask(0o077)
    if arguments.action == 'prepare':
        prepare(arguments.bind_address, arguments.tls_port)
    elif arguments.action == 'up':
        up()
    elif arguments.action == 'verify':
        verify()
    elif arguments.action == 'cleanup-sessions':
        cleanup_sessions()
    elif arguments.action == 'build-workspace':
        compose('--profile', 'build', 'build', '--no-cache', 'workspace-image')
        image = json.loads(execute(['docker', 'image', 'inspect', 'agent-studio-workspace:t104']))[0]
        config = state()
        config['workspaceImage'] = image['Id']
        config['workspaceDockerfileSha256'] = hashlib.sha256((INFRA / 'Dockerfile.workspace').read_bytes()).hexdigest()
        save(OUTPUT / 'state.json', config, exclusive=False)
        print('PASS: workspace rebuilt without cache:', image['Id'])
    else:
        print(compose('ps', '--format', 'json'))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, AssertionError, RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        print(f'FAIL: {error}', file=sys.stderr)
        sys.exit(1)
