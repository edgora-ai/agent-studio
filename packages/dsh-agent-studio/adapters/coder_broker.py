"""D02 central-only Coder broker. Credentials never enter stdout or the preview.

Only the existing m1-a instance is eligible. All remote payloads are fixed helper
install/connect code, never client commands; project execution uses helper RPC.
"""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid

REPO = Path(__file__).resolve().parents[3]
SOURCE = REPO / 'scripts/m1/t105_connection.py'
spec = importlib.util.spec_from_file_location('d02_frozen_transport', SOURCE)
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)
WORKSPACE_ID = 'ff136352-6a92-41d4-9c2c-6cc783cb989b'
CATALOG_KEY = 'coder-lab-m1-a'
HELPER_SHA = transport.HELPER_SHA
KNOWN_HOSTS = REPO / 'artifacts/m1/t107/repair1-3b306efdbbb419d4cbc6ce95/known_hosts'
ALIAS = 't105.m1-a'


def require(condition, code):
    if not condition:
        raise ValueError(code)


def private_json(path, value):
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    require(not path.is_symlink(), 'D02_SYMLINK_OUTPUT')
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with temporary.open('x') as handle:
        json.dump(value, handle, separators=(',', ':'))
        handle.flush()
        os.fsync(handle.fileno())
    temporary.chmod(0o600)
    os.replace(temporary, path)


def owned_root(value):
    root = Path(value)
    require(root.is_absolute() and root.resolve(strict=True) == root, 'D02_ROOT_INVALID')
    require((root / '.agent-studio-root').read_text().strip() == 'agent-studio-preview-v1', 'D02_ROOT_UNOWNED')
    require(root.is_relative_to(REPO / '.preview') or re.fullmatch(r'/tmp/agent-studio-test-[^/]+', str(root)), 'D02_ROOT_SCOPE')
    return root


def current():
    record = transport.current_record('m1-a')
    require(record['workspaceId'] == WORKSPACE_ID and record['marker']['templateVersion'] == 'lab-v3', 'D02_TARGET_CHANGED')
    return record


def register(root):
    expected = current()
    require(KNOWN_HOSTS.is_file() and not KNOWN_HOSTS.is_symlink(), 'D02_HOST_KEY_UNREGISTERED')
    found = subprocess.run(['/usr/bin/ssh-keygen', '-F', ALIAS, '-f', str(KNOWN_HOSTS)],
                           capture_output=True, env=transport.clean_env(), timeout=5)
    require(found.returncode == 0, 'D02_HOST_KEY_UNREGISTERED')
    catalog = json.loads((root / 'catalog.json').read_text())
    item = {'key': CATALOG_KEY, 'kind': 'coder', 'name': 'Coder lab m1-a (bound helper)',
            'roots': ['/workspace'], 'workspace_id': WORKSPACE_ID,
            'agent_id': expected['platformAgentId'], 'generation': expected['marker']['generation'],
            'policy_version': 'd02-bound-helper-v1', 'template_version': 'lab-v3',
            'credential_ref': 'coder-lab:owner', 'provider': 'coder-helper', 'expected': expected,
            'known_hosts': str(KNOWN_HOSTS), 'known_hosts_sha256': transport.digest(KNOWN_HOSTS)}
    old = next((row for row in catalog if row['key'] == CATALOG_KEY), None)
    # Never silently update an existing generation. A later lifecycle slice must
    # add an operator-approved new record/version rather than mutate this catalog.
    require(old is None or old == item, 'D02_CATALOG_SNAPSHOT_CHANGED')
    if old is None:
        private_json(root / 'catalog.json', [*catalog, item])
    return {'catalog_key': CATALOG_KEY, 'workspace_id': WORKSPACE_ID,
            'generation': item['generation'], 'credential_ref': item['credential_ref']}


def context(root, binding_id, version):
    require(re.fullmatch(r'binding-[0-9a-f-]{36}', binding_id) and re.fullmatch(r'[1-9][0-9]{0,8}', version), 'D02_BINDING_REF_INVALID')
    with sqlite3.connect(f'file:{root / "bindings.sqlite"}?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        row = db.execute('SELECT b.*,e.catalog_key,e.credential_ref FROM project_bindings b JOIN environments e USING(environment_id) WHERE binding_id=? AND version=?', (binding_id, int(version))).fetchone()
        require(row is not None and row['state'] == 'ready', 'D02_BINDING_UNAVAILABLE')
        owner = db.execute("SELECT value FROM deployment WHERE key='principal_id'").fetchone()[0]
        policies = {CATALOG_KEY: 'd02-bound-helper-v1', 'coder-lab-m1-a-d05-v1': 'd05-model-helper-v1', 'coder-lab-m1-a-d06-v1': 'd06-acp-helper-v1'}
        require(row['principal_id'] == owner and policies.get(row['catalog_key']) == row['policy_version'] and row['credential_ref'] == 'coder-lab:owner', 'D02_BINDING_OWNER_OR_TARGET')
        binding = dict(row)
    catalog = json.loads((root / 'catalog.json').read_text())
    target = next((item for item in catalog if item['key'] == binding['catalog_key']), None)
    require(target is not None and target['provider'] == 'coder-helper', 'D02_TARGET_UNREGISTERED')
    expected = target['expected']
    require(expected['workspaceId'] == WORKSPACE_ID and expected['name'] == 'm1-a', 'D02_TARGET_OUTSIDE_SCOPE')
    require(binding['policy_version'] == target['policy_version'], 'D02_POLICY_CHANGED')
    with sqlite3.connect(f'file:{root / "bindings.sqlite"}?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        instance = db.execute('SELECT * FROM instance_records WHERE record_id=? AND principal_id=? AND environment_id=?', (binding['record_id'], owner, binding['environment_id'])).fetchone()
        require(instance is not None and instance['instance_generation'] == binding['instance_generation'] and instance['policy_version'] == binding['policy_version'] and instance['workspace_id'] == WORKSPACE_ID and json.loads(instance['allowed_roots_json']) == target['roots'], 'D07_INSTANCE_SNAPSHOT_CHANGED')
    remote_root = f'/workspace/agent-studio-{binding_id}-v{version}'
    require(binding['target_root'] == remote_root, 'D02_ROOT_MISMATCH')
    require(Path(target['known_hosts']) == KNOWN_HOSTS and transport.digest(KNOWN_HOSTS) == target['known_hosts_sha256'], 'D02_HOST_KEY_CHANGED')
    return binding, target


def configure(root, binding, target):
    key = f"{binding['binding_id']}-v{binding['version']}"
    directory = root / 'broker' / key
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    conf = directory / 'ssh_config'
    text = '\n'.join([
        'Host ' + ALIAS, '  HostName ' + ALIAS, '  User coder', '  BatchMode yes',
        '  ConnectTimeout 15', '  ConnectionAttempts 1', '  ServerAliveInterval 10', '  ServerAliveCountMax 3',
        '  StrictHostKeyChecking yes', '  UserKnownHostsFile ' + str(KNOWN_HOSTS),
        '  GlobalKnownHostsFile /dev/null', '  IdentityFile none', '  IdentityAgent none',
        '  ForwardAgent no', '  ClearAllForwardings yes', '  ControlMaster no', '  LogLevel ERROR',
        '  ProxyCommand ' + shlex.join(['/usr/bin/python3', '-I', str(Path(__file__).resolve()), str(root), 'proxy', binding['binding_id'], str(binding['version'])]), ''])
    require(not conf.is_symlink(), 'D02_CONFIG_SYMLINK')
    conf.write_text(text)
    conf.chmod(0o600)
    return conf, directory


def proxy(root, binding, target):
    # Only this central process reads the owner token. Official CLI is used as a
    # stdio network transport, never as an alternate workload executor.
    env = transport.clean_env()
    env['CODER_SESSION_TOKEN'] = transport.lab.token()
    command = ['docker', 'exec', '-i', '--env', 'CODER_SESSION_TOKEN', transport.lab.container_id('coder'),
               '/opt/coder', '--url', 'https://coder:' + str(transport.lab.state()['tlsPort']),
               '--client-tls-ca-file', '/run/lab-tls/ca.crt', '--global-config', '/tmp/agent-studio-d02-cli',
               '--disable-direct-connections', '--disable-network-telemetry', 'ssh', '--stdio',
               '--disable-autostart', '--wait', 'no', 'm1-a.main']
    os.execvpe(command[0], command, env)


def payload_command(mode):
    if mode == 'connect':
        return f'exec python3 "$HOME/.local/share/dsh-remote-helper/releases/{HELPER_SHA}/helper.py" connect --stdio'
    require(mode == 'install', 'D02_MODE_INVALID')
    # Content-addressed, exclusive create. Existing helper bytes must match;
    # never overwrite an existing release or remove any prior file.
    script = '''import hashlib,os,pathlib,sys
expected=sys.argv[1]; data=sys.stdin.buffer.read(2*1024*1024)
if hashlib.sha256(data).hexdigest()!=expected: raise RuntimeError('D02_HELPER_DIGEST')
p=pathlib.Path.home()/'.local/share/dsh-remote-helper/releases'/expected/'helper.py'
p.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
if p.is_symlink(): raise RuntimeError('D02_HELPER_SYMLINK')
if p.exists():
 if hashlib.sha256(p.read_bytes()).hexdigest()!=expected: raise RuntimeError('D02_EXISTING_HELPER_CHANGED')
else:
 with p.open('xb') as f: f.write(data); f.flush(); os.fsync(f.fileno())
 p.chmod(0o600)
'''
    return shlex.join(['python3', '-I', '-c', script, HELPER_SHA])


def trusted_current(binding, target):
    observed = current()
    frozen = target['expected']
    stable = ('name', 'owner', 'ownerId', 'workspaceId', 'agentName', 'templateId', 'templateVersionId', 'templateSha256', 'expectedUser', 'expectedUid', 'root')
    marker_fields = ('imageId', 'policyVersion', 'root', 'schemaVersion', 'templateVersion', 'uid', 'workspaceId')
    require(all(observed[key] == frozen[key] for key in stable) and all(observed['marker'][key] == frozen['marker'][key] for key in marker_fields) and observed['marker']['generation'] == binding['instance_generation'], 'D07_CURRENT_INSTANCE_CHANGED')
    # Build/job/platform-agent identities are current observations, not generation.
    # Every new channel still proves the complete CURRENT marker on that channel.
    return observed


def task_probe_command(root, binding, target, operation_id):
    require(re.fullmatch(r'[A-Za-z0-9_-]{8,128}', operation_id or ''), 'D08_OPERATION_REF')
    with sqlite3.connect(f'file:{root / "bindings.sqlite"}?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        row = db.execute('SELECT * FROM operation_records WHERE operation_id=? AND principal_id=? AND binding_id=? AND version=?',
                         (operation_id, binding['principal_id'], binding['binding_id'], binding['version'])).fetchone()
        require(row is not None and row['kind'] in ('command.exec', 'pty.open') and row['remote_process_id'] and row['helper_session_id'] and row['channel_id'], 'D08_TASK_IDENTITY_INCOMPLETE')
        require(type(row['remote_pid']) is int and row['remote_pid'] > 1, 'D08_TASK_PID_INCOMPLETE')
        request = json.loads(row['request_json'])
        relative = request.get('cwd', '')
        require(isinstance(relative, str) and not relative.startswith('/') and all(part not in ('.', '..') for part in relative.split('/')), 'D08_TASK_CWD')
        owner = {key: binding[key] for key in ('binding_id', 'version', 'principal_id')}
        owner['generation'] = binding['instance_generation']
        probe = {'root': binding['target_root'], 'cwd': str(Path(binding['target_root']) / relative), 'owner': owner,
                 'pid': row['remote_pid'], 'uid': target['expected']['expectedUid'], 'operation_id': operation_id, 'request_sha256': row['request_sha256']}
    script = Path(__file__).with_name('task-observe.py').read_text()
    return shlex.join(['python3', '-I', '-c', script, base64.b64encode(json.dumps(probe).encode()).decode()])


def gated(root, binding, target, mode, operation_id=None):
    started = time.monotonic()
    conf, directory = configure(root, binding, target)
    expected = trusted_current(binding, target)
    before = expected
    home = f"/workspace/.agent-studio-helper-{binding['binding_id']}-v{binding['version']}/home"
    command = task_probe_command(root, binding, target, operation_id) if mode == 'observe-task' else payload_command(mode)
    payload = {'mode': 'helper', 'root': '/workspace', 'remoteHome': home, 'command': command}
    encoded = base64.b64encode(json.dumps(payload).encode()).decode()
    gate = (REPO / 'scripts/m1/t105_remote_gate.py').read_text()
    remote = shlex.join(['python3', '-I', '-c', gate, encoded])
    argv = ['/usr/bin/ssh', '-F', str(conf), '-T', '-o', 'BatchMode=yes', ALIAS, remote]
    child = None
    audit = {'binding_id': binding['binding_id'], 'version': binding['version'], 'mode': mode,
             'channel_id': str(uuid.uuid4()), 'dispatch': False, 'broker_pid': os.getpid(),
             'started_at_ms': int(time.time() * 1000), 'control_plane_ms': round((time.monotonic() - started) * 1000)}
    diagnostic_hash = hashlib.sha256()
    diagnostic_codes = set()
    diagnostic_thread = None
    def drain_errors(stream):
        carry = b''
        for chunk in iter(lambda: stream.read(4096), b''):
            diagnostic_hash.update(chunk)
            audit['ssh_diagnostic_bytes'] = audit.get('ssh_diagnostic_bytes', 0) + len(chunk)
            sample = (carry + chunk).lower()
            for label in ('Connection reset', 'Broken pipe', 'Killed', 'No space left', 'Resource temporarily unavailable', 'Cannot allocate', 'timed out', 'closed', 'Traceback', 'No such file', 'Permission denied'):
                if label.encode().lower() in sample:
                    diagnostic_codes.add(label)
            carry = sample[-64:]
    def interrupted(signum, frame):
        raise InterruptedError('D02_TRANSPORT_INTERRUPTED')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    try:
        child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, env=transport.clean_env(), start_new_session=True, bufsize=0)
        audit['ssh_pid'] = child.pid
        diagnostic_thread = threading.Thread(target=drain_errors, args=(child.stderr,), daemon=True)
        diagnostic_thread.start()
        line = transport.read_line(child.stdout.fileno())
        observed = json.loads(line)
        tests = transport.compare_observation(expected, observed)
        require(all(tests.values()) and current() == before == expected, 'D02_SAME_CHANNEL_IDENTITY_REJECTED')
        child.stdin.write(b'DISPATCH ' + hashlib.sha256(line.rstrip(b'\n')).hexdigest().encode() + b'\n')
        audit.update(dispatch=True, generation=expected['marker']['generation'],
                     build_id=expected['buildId'], agent_id=expected['platformAgentId'],
                     proof_ms=round((time.monotonic() - started) * 1000))
        os.write(3, (json.dumps(audit) + '\n').encode())
        def upload():
            try:
                while chunk := os.read(0, 65536):
                    child.stdin.write(chunk)
                    audit['stdin_bytes'] = audit.get('stdin_bytes', 0) + len(chunk)
            except (BrokenPipeError, OSError) as error:
                audit['upload_error'] = type(error).__name__
            finally:
                try:
                    child.stdin.close()
                except OSError as error:
                    audit['stdin_close_error'] = type(error).__name__
        threading.Thread(target=upload, daemon=True).start()
        while chunk := child.stdout.read(65536):
            audit['stdout_bytes'] = audit.get('stdout_bytes', 0) + len(chunk)
            os.write(1, chunk)
        return child.wait(timeout=10)
    finally:
        if child is not None and child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=5)
        if diagnostic_thread:
            diagnostic_thread.join(timeout=2)
        audit.update(transport_exit=None if child is None else child.returncode,
                     ssh_diagnostic_sha256=diagnostic_hash.hexdigest(), ssh_diagnostic_codes=sorted(diagnostic_codes),
                     finished_at_ms=int(time.time() * 1000), duration_ms=round((time.monotonic() - started) * 1000))
        private_json(directory / ('gate-' + audit['channel_id'] + '.json'), audit)


def main():
    os.umask(0o077)
    require(len(sys.argv) >= 3, 'D02_ARGUMENTS')
    root, mode = owned_root(sys.argv[1]), sys.argv[2]
    if mode in ('environment-policy', 'environment-discover', 'environment-submit', 'environment-poll'):
        require(len(sys.argv) == (4 if mode in ('environment-submit', 'environment-poll') else 3), 'D07_ARGUMENTS')
        module_spec = importlib.util.spec_from_file_location('studio_environment', Path(__file__).with_name('coder_environment.py'))
        environment = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(environment)
        broker = sys.modules[__name__]
        if mode == 'environment-policy':
            result = environment.enable_readonly(broker, root)
        elif mode == 'environment-discover':
            result = environment.discover(broker, root)
        elif mode == 'environment-submit':
            result = environment.submit(broker, root, sys.argv[3])
        else:
            result = environment.poll(broker, root, sys.argv[3])
        print(json.dumps(result))
        return 0
    if mode == 'register':
        require(len(sys.argv) == 3, 'D02_ARGUMENTS')
        print(json.dumps(register(root)))
        return 0
    require(len(sys.argv) == (6 if mode == 'observe-task' else 5), 'D02_ARGUMENTS')
    binding, target = context(root, sys.argv[3], sys.argv[4])
    if mode == 'proxy':
        proxy(root, binding, target)
        raise RuntimeError('D02_PROXY_RETURNED')
    if mode == 'check':
        observed = trusted_current(binding, target)
        print(json.dumps({'generation': binding['instance_generation'], 'workspace_id': WORKSPACE_ID,
                          'agent_id': observed['platformAgentId'], 'build_id': observed['buildId']}))
        return 0
    require(mode in ('install', 'connect', 'observe-task'), 'D02_MODE_INVALID')
    return gated(root, binding, target, mode, sys.argv[5] if mode == 'observe-task' else None)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        # No raw subprocess/urllib diagnostics, credential values, or environment.
        print(json.dumps({'error': str(error) if isinstance(error, ValueError) else type(error).__name__}), file=sys.stderr)
        raise SystemExit(78)
