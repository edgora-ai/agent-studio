"""T-105 only: dedicated Coder/OpenSSH transport with per-channel identity gating.

Run with python3 -I. Never alters the lab template, workspaces, global SSH/CA/DNS,
installed candidate or production profiles. Credentials are read only in this
central broker and passed to Docker via environment, not argv or workspaces.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import selectors
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts/m1'
spec = importlib.util.spec_from_file_location('t105_template', SCRIPTS / 'coder_template.py')
template = importlib.util.module_from_spec(spec)
spec.loader.exec_module(template)
lab = template.lab
OUTPUT = ROOT / 'artifacts/m1/t105'
CANDIDATE = ROOT / 'artifacts/m1/t103/fixture-9teakpr5/runtime/node_modules/dsh-ssh-remote'
DSH = Path('/home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh')
HELPER_SHA = 'c853353b330d790813fdd2a2d641c9a4738c6b96f50b53c2f4aa53acec31901f'


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    lab.save(Path(path), value)


def current_record(name):
    if name not in template.WORKSPACES:
        raise ValueError('T105_TARGET_OUTSIDE_LAB')
    config = lab.state()
    if digest(lab.INFRA / 'template/main.tf') != config['templateSha256']:
        raise ValueError('T105_FROZEN_TEMPLATE_CHANGED')
    me = lab.request('/api/v2/users/me', token=lab.token())
    candidates = [w for w in template.workspaces() if w['name'] == name]
    if len(candidates) != 1:
        raise ValueError('T105_WORKSPACE_AMBIGUOUS')
    w = lab.request('/api/v2/workspaces/' + str(uuid.UUID(candidates[0]['id'])), token=lab.token())
    b = w['latest_build']
    allowed = json.loads((lab.OUTPUT / 'allowlist.json').read_text())
    template.validate_request(w['template_id'], b['template_version_id'], '/workspace', allowed)
    if (w['owner_id'] != me['id'] or me['username'] != 'lab-owner' or b['status'] != 'running'
            or b['template_version_id'] != config['templateVersionId']):
        raise ValueError('T105_CURRENT_BUILD_OR_OWNER_CHANGED')
    resources = lab.request('/api/v2/workspacebuilds/' + str(uuid.UUID(b['id'])) + '/resources', token=lab.token())
    bound = [(r, m) for r in resources for m in r.get('metadata', []) if m['key'] == 'agent-studio-instance']
    if len(bound) != 1:
        raise ValueError('T105_RESOURCE_AMBIGUOUS')
    resource, metadata = bound[0]
    marker = json.loads(metadata['value'])
    template.validate_record(marker, marker)
    agents = resource.get('agents') or []
    if (len(agents) != 1 or agents[0]['name'] != 'main' or agents[0]['status'] != 'connected'
            or marker['workspaceId'] != w['id'] or marker['imageId'] != config['workspaceImage']
            or marker['templateVersion'] != template.VERSION):
        raise ValueError('T105_PLATFORM_AGENT_OR_IMAGE_CHANGED')
    agent = str(uuid.UUID(agents[0]['id']))
    # Do not confuse the Terraform resource reference with the REST platform ID.
    query = ("SELECT a.id::text,r.id::text,r.job_id::text,b.id::text,b.workspace_id::text,b.template_version_id::text "
             "FROM workspace_agents a JOIN workspace_resources r ON a.resource_id=r.id "
             "JOIN workspace_builds b ON b.job_id=r.job_id WHERE a.id='" + agent + "';")
    row = lab.execute(['docker', 'exec', lab.container_id('database'), 'psql', '-U', 'coder', '-d', 'coder', '-At', '-c', query], timeout=20).strip().split('|')
    if row != [agent, resource['id'], b['job']['id'], b['id'], w['id'], b['template_version_id']]:
        raise ValueError('T105_AGENT_CURRENT_BUILD_DATABASE_MISMATCH')
    return {'name': name, 'owner': me['username'], 'ownerId': me['id'], 'workspaceId': w['id'],
            'platformAgentId': agent, 'agentName': agents[0]['name'], 'resourceId': resource['id'],
            'jobId': b['job']['id'], 'buildId': b['id'], 'templateId': w['template_id'],
            'templateVersionId': b['template_version_id'], 'templateSha256': config['templateSha256'],
            'marker': marker, 'expectedUser': 'coder', 'expectedUid': 1000, 'root': '/workspace'}


def historical_input(expected):
    builds = lab.request('/api/v2/workspaces/' + expected['workspaceId'] + '/builds', token=lab.token())
    for build in builds:
        if build['transition'] != 'start' or build['id'] == expected['buildId']:
            continue
        resources = lab.request('/api/v2/workspacebuilds/' + str(uuid.UUID(build['id'])) + '/resources', token=lab.token())
        markers = [json.loads(m['value']) for r in resources for m in r.get('metadata', [])
                   if m['key'] == 'agent-studio-instance']
        if len(markers) != 1 or markers[0].get('generation') == expected['marker']['generation']:
            continue
        if markers[0].get('workspaceId') != expected['workspaceId']:
            raise ValueError('T105_HISTORICAL_WORKSPACE_MISMATCH')
        query = "SELECT workspace_id::text,job_id::text,template_version_id::text FROM workspace_builds WHERE id='" + str(uuid.UUID(build['id'])) + "';"
        row = lab.execute(['docker', 'exec', lab.container_id('database'), 'psql', '-U', 'coder', '-d', 'coder', '-At', '-c', query], timeout=20).strip().split('|')
        if row != [expected['workspaceId'], build['job']['id'], build['template_version_id']]:
            raise ValueError('T105_HISTORICAL_DATABASE_MISMATCH')
        return {'buildId': build['id'], 'jobId': build['job']['id'], 'templateVersionId': build['template_version_id'],
                'marker': markers[0], 'source': 'authenticated historical build/resources and direct workspace_builds SQL'}
    raise ValueError('T105_NO_REAL_HISTORICAL_IDENTITY_INPUT')


def compare_observation(expected, observed):
    tests = {
        'marker': observed['marker'] == expected['marker'],
        'uid': type(observed['uid']) is int and observed['uid'] == expected['expectedUid'],
        'account': observed['user'] == expected['expectedUser'],
        'root': observed['root'] == expected['marker']['root'] == expected['root'] == '/workspace',
        'channelWorkspace': observed['channel']['CODER_WORKSPACE_ID'] == expected['workspaceId'],
        'channelName': observed['channel']['CODER_WORKSPACE_NAME'] == expected['name'],
        'channelAgentName': observed['channel']['CODER_WORKSPACE_AGENT_NAME'] == expected['agentName'],
        'channelOwner': observed['channel']['CODER_WORKSPACE_OWNER_NAME'] == expected['owner'],
    }
    return tests


def clean_env(run=None):
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8'}
    if run:
        env.update(HOME=str(run / 'home'), DSH_HOME=str(run / 'dsh-home'), TMPDIR=str(run / 'tmp'),
                   XDG_CONFIG_HOME=str(run / 'home/.config'), XDG_CACHE_HOME=str(run / 'home/.cache'), CI='true')
        env['PATH'] = str(run / 'bin') + ':' + env['PATH']
    return env


def proxy(config_path, alias):
    conf = json.loads(Path(config_path).read_text())
    if alias not in conf['targets']:
        raise ValueError('T105_UNREGISTERED_ALIAS')
    name = conf['targets'][alias]
    # Dedicated fault injection: change the actual next transport, not the cached
    # observation, after the first gated installer dispatch has succeeded.
    if conf.get('switchAfterFirstDispatch') and any(
            json.loads(p.read_text()).get('dispatch') for p in Path(config_path).parent.glob('gate-*.json')):
        name = 'm1-b'
    if name not in template.WORKSPACES:
        raise ValueError('T105_TARGET_OUTSIDE_LAB')
    env = clean_env()
    env['CODER_SESSION_TOKEN'] = lab.token()
    # Fixed official binary inside the existing control plane: canonical TLS DNS
    # and DERP are reachable there, without changing the host or any container.
    command = ['docker', 'exec', '-i', '--env', 'CODER_SESSION_TOKEN', lab.container_id('coder'),
               'timeout', '-s', 'TERM', '-k', '5', '90', '/opt/coder', '--url', 'https://coder:' + str(lab.state()['tlsPort']),
               '--client-tls-ca-file', '/run/lab-tls/ca.crt', '--global-config', '/tmp/agent-studio-t105-cli',
               '--disable-direct-connections', '--disable-network-telemetry', 'ssh', '--stdio',
               '--disable-autostart', '--wait', 'no', name + '.main']
    os.execvpe(command[0], command, env)


def read_line(fd, timeout=25):
    selector = selectors.DefaultSelector()
    selector.register(fd, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout
    line = bytearray()
    try:
        while len(line) < 16384:
            if not selector.select(max(0, deadline - time.monotonic())):
                raise TimeoutError('T105_PREFLIGHT_TIMEOUT')
            char = os.read(fd, 1)
            if not char:
                raise RuntimeError('T105_PREFLIGHT_TRANSPORT_CLOSED')
            line += char
            if char == b'\n':
                return bytes(line)
        raise ValueError('T105_PREFLIGHT_OUTPUT_LIMIT')
    finally:
        selector.close()


def gated_ssh(config_path, arguments):
    conf = json.loads(Path(config_path).read_text())
    ssh_config = conf['sshConfig']
    # These exact option-only probes never contact a remote target.
    if arguments == ['-F', '/dev/null', '-G', '-o', 'SessionType=default', '-o', 'StdinNull=no', 'probe.invalid']:
        return subprocess.run(['/usr/bin/ssh', *arguments], env=clean_env(), timeout=6).returncode
    if len(arguments) == 4 and arguments[:2] == ['-G', '-F'] and arguments[2] == ssh_config and arguments[3] in conf['targets']:
        return subprocess.run(['/usr/bin/ssh', *arguments], env=clean_env(), timeout=6).returncode
    # Only the fixed candidate's noninteractive system-SSH call shape is allowed.
    prefix = ['-T', '-o', 'BatchMode=yes', '-o', 'RemoteCommand=none', '-o', 'SessionType=default',
              '-o', 'StdinNull=no', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15',
              '-o', 'ServerAliveCountMax=3', '--']
    if len(arguments) != len(prefix) + 2 or arguments[:len(prefix)] != prefix or arguments[-2] not in conf['targets']:
        raise ValueError('T105_UNREVIEWED_SSH_ARGUMENTS')
    alias, command = arguments[-2:]
    expected = conf['expected']
    payload = {'mode': 'helper', 'root': expected['root'], 'remoteHome': conf['remoteHome'], 'command': command}
    encoded = base64.b64encode(json.dumps(payload).encode()).decode()
    gate = (SCRIPTS / 't105_remote_gate.py').read_text()
    remote = shlex.join(['python3', '-I', '-c', gate, encoded])
    argv = ['/usr/bin/ssh', '-F', ssh_config, '-T', '-o', 'BatchMode=yes', alias, remote]
    audit = {'alias': alias, 'commandSha256': hashlib.sha256(command.encode()).hexdigest(), 'dispatch': False}
    child = None
    def interrupted(signum, frame):
        raise InterruptedError('T105_TRANSPORT_INTERRUPTED')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    status = 78
    log_path = Path(config_path).parent / ('gate-' + uuid.uuid4().hex + '.json')
    try:
        before = current_record(expected['name'])
        with tempfile.TemporaryFile() as errors:
            child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors,
                                     env=clean_env(), start_new_session=True, bufsize=0)
            try:
                line = read_line(child.stdout.fileno())
            except RuntimeError:
                child.wait(timeout=8)
                errors.seek(0)
                diagnostic = errors.read(16384)
                audit['sshExitCode'] = child.returncode
                audit['hostKeyRejected'] = b'Host key verification failed' in diagnostic or b'REMOTE HOST IDENTIFICATION HAS CHANGED' in diagnostic
                raise
            observed = json.loads(line)
            audit['observed'] = observed
            audit['checks'] = compare_observation(expected, observed)
            after = current_record(expected['name'])
            audit['currentBuildBeforeAndAfter'] = before == after == expected
            audit['buildId'] = after['buildId']
            audit['platformAgentId'] = after['platformAgentId']
            if not all(audit['checks'].values()) or not audit['currentBuildBeforeAndAfter']:
                audit['failure'] = 'T105_IDENTITY_REJECTED'
                child.stdin.close()
                child.wait(timeout=8)
                return 78
            # ACK belongs to this observation and this exact SSH process. No cached
            # pass flag is reused by the next installer/connector/reconnect call.
            child.stdin.write(b'DISPATCH ' + hashlib.sha256(line.rstrip(b'\n')).hexdigest().encode() + b'\n')
            audit['dispatch'] = True
            save(log_path, audit)
            def upload():
                try:
                    while chunk := os.read(0, 65536):
                        child.stdin.write(chunk)
                except (BrokenPipeError, OSError) as error:
                    # Main thread still observes SSH exit; no fabricated success.
                    audit.setdefault('streamErrors', []).append(type(error).__name__)
                finally:
                    try:
                        child.stdin.close()
                    except OSError as error:
                        audit.setdefault('streamCloseErrors', []).append(type(error).__name__)
            thread = threading.Thread(target=upload, daemon=True)
            thread.start()
            while chunk := child.stdout.read(65536):
                os.write(1, chunk)
            status = child.wait(timeout=8)
            if status:
                print('T105_SSH_PAYLOAD_FAILED exit=' + str(status), file=sys.stderr)
            return status
    except Exception as error:
        audit['failure'] = type(error).__name__ + ':' + str(error)[:200] if isinstance(error, (ValueError, RuntimeError, TimeoutError)) else type(error).__name__
        print('T105_GATE_FAILED ' + type(error).__name__, file=sys.stderr)
        return 78
    finally:
        if not log_path.exists():
            save(log_path, audit)
        if child is not None and child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=5)


def configure(run, expected, target='m1-a', switch=False):
    for directory in ('home/.ssh', 'dsh-home', 'tmp', 'bin', 'workspace'):
        (run / directory).mkdir(parents=True, exist_ok=True, mode=0o700)
    config_path = run / 'connection.json'
    alias = 't105.' + target
    conf = {'targets': {alias: target}, 'expected': expected, 'sshConfig': str(run / 'home/.ssh/config'),
            'remoteHome': '/tmp/t105-' + run.name[-24:] + '/home', 'switchAfterFirstDispatch': switch}
    save(config_path, conf)
    text = '\n'.join([
        'Host ' + alias, '  HostName ' + alias, '  User coder', '  BatchMode yes',
        '  ConnectTimeout 15', '  ConnectionAttempts 1', '  ServerAliveInterval 5', '  ServerAliveCountMax 2',
        '  StrictHostKeyChecking yes', '  UserKnownHostsFile ' + str(run / 'known_hosts'),
        '  GlobalKnownHostsFile /dev/null', '  IdentityFile none', '  IdentityAgent none',
        '  ForwardAgent no', '  ClearAllForwardings yes', '  ControlMaster no', '  LogLevel ERROR',
        '  ProxyCommand ' + shlex.join(['/usr/bin/python3', '-I', str(__file__), 'proxy', str(config_path), '%h']), '',
    ])
    (run / 'home/.ssh/config').write_text(text)
    wrapper = '#!/bin/sh\nexec ' + shlex.join(['/usr/bin/python3', '-I', str(__file__), 'ssh', str(config_path)]) + ' "$@"\n'
    (run / 'bin/ssh').write_text(wrapper)
    (run / 'bin/ssh').chmod(0o700)
    return conf, alias


def enroll(run, conf, alias):
    # Explicit first-use enrollment ONLY over the authenticated official Coder
    # tunnel. Subsequent calls require the exact stored key; no -insecure option.
    code = "import json,os,pathlib,pwd;print(json.dumps({'marker':json.loads(pathlib.Path('/run/agent-studio/identity.json').read_text()),'uid':os.getuid(),'user':pwd.getpwuid(os.getuid()).pw_name,'root':str(pathlib.Path('/workspace').resolve(strict=True)),'channel':{k:os.environ.get(k) for k in ['CODER_WORKSPACE_ID','CODER_WORKSPACE_NAME','CODER_WORKSPACE_AGENT_NAME','CODER_WORKSPACE_OWNER_NAME']}}))"
    cmd = ['/usr/bin/ssh', '-F', conf['sshConfig'], '-o', 'StrictHostKeyChecking=accept-new', alias,
           shlex.join(['python3', '-I', '-c', code])]
    before = current_record(conf['targets'][alias])
    result = subprocess.run(cmd, env=clean_env(), capture_output=True, text=True, timeout=45)
    if result.returncode:
        raise RuntimeError('T105_HOST_ENROLLMENT_FAILED exit=' + str(result.returncode))
    observed = json.loads(result.stdout)
    if not all(compare_observation(before, observed).values()) or current_record(before['name']) != before:
        raise ValueError('T105_ENROLLMENT_IDENTITY_REJECTED')
    fingerprint = lab.execute(['ssh-keygen', '-lf', str(run / 'known_hosts')], timeout=5).strip()
    save(run / 'enrollment.json', {'observed': observed, 'expected': before, 'fingerprint': fingerprint,
                                   'trust': 'authenticated Coder TLS/control-plane + Agent tailnet; explicit scoped accept-new, then strict=yes'})


def container_for(name):
    record = current_record(name)
    ids = lab.execute(['docker', 'ps', '-q', '--filter', 'label=agent-studio.lab=t104',
                       '--filter', 'label=agent-studio.workspace=' + record['workspaceId']], timeout=10).split()
    if len(ids) != 1:
        raise ValueError('T105_CONTAINER_AMBIGUOUS')
    return ids[0]


def observe_remote(name, remote_home):
    # Read ONLY dedicated synthetic state and process metadata. Never read key files.
    script = '''import hashlib,json,os,pathlib,sys
home=pathlib.Path(sys.argv[1]); root=pathlib.Path('/workspace'); files=[]
for p in sorted(root.rglob('*')):
 if len(files)>1000: raise RuntimeError('snapshot limit')
 files.append({'path':str(p.relative_to(root)),'kind':'symlink' if p.is_symlink() else 'dir' if p.is_dir() else 'file','sha256':hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() and not p.is_symlink() else None})
helper=home/'.local/share/dsh-remote-helper/releases'/sys.argv[2]/'helper.py'
processes=[]
for p in pathlib.Path('/proc').glob('[0-9]*'):
 try:
  args=(p/'cmdline').read_bytes().split(b'\\0')
  if str(helper).encode() not in args: continue
  st=(p/'stat').read_text().split()
  env=(p/'environ').read_bytes().split(b'\\0')
  processes.append({'pid':int(p.name),'state':st[2],'startTick':st[21],'kind':'daemon' if b'daemon' in args else 'connector' if b'connect' in args else 'other','ownerTokenPresent':any(v.startswith(b'CODER_SESSION_TOKEN=') for v in env),'agentTokenPresent':any(v.startswith(b'CODER_AGENT_TOKEN=') for v in env)})
 except FileNotFoundError: continue
releases=list((home/'.local/share/dsh-remote-helper/releases').glob('*/helper.py'))
print(json.dumps({'project':files,'homeExists':home.exists(),'helperExists':helper.exists(),'helperSha256':hashlib.sha256(helper.read_bytes()).hexdigest() if helper.exists() else None,'helperBytes':helper.stat().st_size if helper.exists() else None,'helperReleaseLookup':sum(p==helper for p in releases),'processes':processes}))'''
    return json.loads(lab.execute(['docker', 'exec', container_for(name), 'python3', '-I', '-c', script, remote_home, HELPER_SHA], timeout=20))


def run_node(run, alias):
    env = clean_env(run)
    args = ['node', '--permission', '--allow-child-process',
            *['--allow-fs-read=' + str(p) for p in (SCRIPTS, CANDIDATE.parent.parent, DSH, run)],
            '--allow-fs-write=' + str(run), '--allow-fs-write=' + str(run) + '/*',
            str(SCRIPTS / 't105_candidate.mjs'), str(CANDIDATE), str(DSH), str(run), alias]
    with (run / 'node.stdout').open('x') as stdout, (run / 'node.stderr').open('x') as stderr:
        process = subprocess.Popen(args, cwd=ROOT, env=env, stdout=stdout, stderr=stderr, start_new_session=True)
        try:
            code = process.wait(timeout=80)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
            code = 124
    return {'command': args, 'exitCode': code}


def transport_processes():
    host = []
    for path in Path('/proc').glob('[0-9]*'):
        try:
            args = (path / 'cmdline').read_bytes().split(b'\0')
            if str(SCRIPTS / 't105_connection.py').encode() in args and (b'ssh' in args or b'proxy' in args):
                host.append(int(path.name))
        except (FileNotFoundError, PermissionError):
            continue  # Only our readable, exact test entrypoints are inspected.
    text = lab.execute(['docker', 'top', lab.container_id('coder'), '-eo', 'pid,args'], timeout=10)
    coder = [int(line.split()[0]) for line in text.splitlines()[1:]
             if '/tmp/agent-studio-t105-cli' in line and ' ssh ' in line]
    return {'hostBrokerPids': host, 'controlPlaneCliPids': coder}


def run_suite():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='connection-', dir=OUTPUT))
    report = {'task': 'T-105', 'status': 'in-progress', 'm1Passed': False, 't106Enabled': False, 'cases': []}
    report['transportBaseline'] = transport_processes()
    expected = current_record('m1-a')
    save(run / 'current-record.json', expected)
    historical = historical_input(expected)
    report['historicalIdentityInput'] = historical
    save(run / 'historical-record.json', historical)
    cases = [('wrong-workspace', 'm1-b'), ('wrong-account-uid', 'm1-a'), ('wrong-root', 'm1-a'),
             ('stale-generation', 'm1-a'), ('stale-build-record', 'm1-a'),
             ('channel-switch', 'm1-a'), ('positive', 'm1-a')]
    for label, target in cases:
        case = run / (label + '-' + uuid.uuid4().hex[:12])
        case.mkdir(mode=0o700)
        value = json.loads(json.dumps(expected))
        if label == 'wrong-account-uid':
            value['expectedUid'], value['expectedUser'] = 0, 'root'
        if label == 'wrong-root':
            value['root'] = '/tmp'
        if label == 'stale-generation':
            value['marker']['generation'] = historical['marker']['generation']
        if label == 'stale-build-record':
            value['buildId'] = historical['buildId']
        conf, alias = configure(case, value, target, switch=label == 'channel-switch')
        try:
            enroll(case, conf, alias)
        except Exception as error:
            report['status'] = 'blocked'
            report['blocker'] = 'host-enrollment:' + type(error).__name__
            report['cases'].append({'case': label, 'accepted': False, 'path': str(case.relative_to(ROOT)), 'failure': report['blocker']})
            break
        before = observe_remote(target, conf['remoteHome'])
        other_before = observe_remote('m1-b', conf['remoteHome'])
        outcome = run_node(case, alias)
        after = observe_remote(target, conf['remoteHome'])
        cleanup_script = (SCRIPTS / 't105_cleanup.py').read_text()
        cleanup = json.loads(lab.execute(['docker', 'exec', container_for(target), 'python3', '-I', '-c',
                                         cleanup_script, conf['remoteHome']], timeout=30))
        save(case / 'daemon-cleanup.json', cleanup)
        after_cleanup = observe_remote(target, conf['remoteHome'])
        other_after = observe_remote('m1-b', conf['remoteHome'])
        gates = [json.loads(p.read_text()) for p in sorted(case.glob('gate-*.json'))]
        node_path = case / 'candidate.json'
        node = json.loads(node_path.read_text()) if node_path.exists() else None
        entry = {'case': label, 'path': str(case.relative_to(ROOT)), 'command': outcome, 'before': before,
                 'after': after, 'gates': gates, 'candidate': node, 'daemonCleanup': cleanup,
                 'afterCleanup': after_cleanup, 'otherWorkspaceBefore': other_before, 'otherWorkspaceAfter': other_after}
        if label == 'channel-switch':
            entry['accepted'] = (outcome['exitCode'] != 0 and len(gates) == 2
                                 and sum(g['dispatch'] for g in gates) == 1
                                 and any(g.get('hostKeyRejected') for g in gates)
                                 and other_before == other_after and not after_cleanup['processes'])
        elif label != 'positive':
            entry['accepted'] = outcome['exitCode'] != 0 and bool(gates) and not any(g['dispatch'] for g in gates) and before == after and other_before == other_after
        else:
            entry['accepted'] = (outcome['exitCode'] == 0 and after['helperSha256'] == HELPER_SHA and node is not None and node['passed']
                                 and after['helperReleaseLookup'] == 1
                                 and not any(p['ownerTokenPresent'] or p['agentTokenPresent'] for p in after['processes'])
                                 and not after_cleanup['processes'] and not cleanup.get('unreaped') and other_before == other_after)
        report['cases'].append(entry)
        save(case / 'case.json', entry)
        print(label, 'PASS' if entry['accepted'] else 'BLOCKED', 'nodeExit=' + str(outcome['exitCode']))
        if not entry['accepted']:
            report['status'] = 'blocked'
            report['blocker'] = label
            break
    deadline = time.monotonic() + 15
    while True:
        remaining = transport_processes()
        if not any(remaining.values()) or time.monotonic() >= deadline:
            break
        time.sleep(0.5)
    report['transportAfter'] = remaining
    if any(remaining.values()):
        report['status'] = 'blocked'
        report['blocker'] = 'T105_TRANSPORT_PROCESS_REMAINING'
    if report['status'] != 'blocked':
        report['status'] = 'awaiting-independent-verification'
    report['sources'] = {str(p.relative_to(ROOT)): digest(p) for p in [
        SCRIPTS / 't105_connection.py', SCRIPTS / 't105_remote_gate.py', SCRIPTS / 't105_candidate.mjs', SCRIPTS / 't105_cleanup.py',
        SCRIPTS / 'ssh_remote_entry.mjs', SCRIPTS / 'network_guard.mjs', SCRIPTS / 'coder_lab.py', SCRIPTS / 'coder_template.py']}
    save(run / 'result.json', report)
    print('Evidence:', run / 'result.json')
    return 1 if report['status'] == 'blocked' else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest='action', required=True)
    subs.add_parser('run')
    p = subs.add_parser('proxy'); p.add_argument('config'); p.add_argument('alias')
    s = subs.add_parser('ssh'); s.add_argument('config'); s.add_argument('arguments', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    os.umask(0o077)
    if args.action == 'run':
        return run_suite()
    if args.action == 'proxy':
        proxy(args.config, args.alias)
        raise RuntimeError('T105_PROXY_EXEC_RETURNED')
    return gated_ssh(args.config, args.arguments)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print('T105_FAILED ' + type(error).__name__, file=sys.stderr)
        if len(sys.argv) > 1 and sys.argv[1] == 'run':
            OUTPUT.mkdir(parents=True, exist_ok=True)
            failure = OUTPUT / ('failure-' + uuid.uuid4().hex + '.json')
            save(failure, {'task': 'T-105', 'status': 'blocked', 'errorClass': type(error).__name__,
                           'entrySourceSha256': digest(__file__), 'stageM1Passed': False})
            print('Evidence:', failure, file=sys.stderr)
        raise SystemExit(1)
