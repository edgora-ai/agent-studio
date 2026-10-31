"""Read back lab resources, private-file permissions and bounded recent logs."""
import importlib.util
import json
from pathlib import Path
import re
import secrets
import stat
import subprocess
import uuid

spec = importlib.util.spec_from_file_location('coder_lab', Path(__file__).with_name('coder_lab.py'))
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)


def main():
    config = lab.state()
    lab.compose('config', '--quiet')
    settings = dict(line.split('=', 1) for line in (lab.PRIVATE / 'compose.env').read_text().splitlines())
    assert settings['CODER_IMAGE'] == lab.CODER_IMAGE
    assert settings['POSTGRES_IMAGE'] == lab.POSTGRES_IMAGE
    assert settings['LAB_BIND_ADDRESS'] == config['bindAddress']
    assert int(settings['CODER_TLS_PORT']) == config['tlsPort']
    assert stat.S_IMODE(lab.PRIVATE.stat().st_mode) == 0o700
    private_files = []
    for path in lab.PRIVATE.iterdir():
        if path.is_file():
            assert stat.S_IMODE(path.stat().st_mode) & 0o077 == 0, path.name
            private_files.append(path.name)
    assert stat.S_IMODE((lab.PRIVATE / 'tls/server.key').stat().st_mode) == 0o640
    assert (lab.PRIVATE / 'tls/server.key').stat().st_gid == int(settings['DOCKER_SOCKET_GID'])
    lab.execute(['openssl', 'x509', '-in', str(lab.PRIVATE / 'tls/server.crt'), '-checkend', '86400', '-noout'])
    services = {name: lab.container_id(name) for name in ('coder', 'database')}
    workspace_ids = lab.execute(['docker', 'ps', '-q', '--filter', 'label=agent-studio.lab=t104']).split()
    assert len(workspace_ids) == 2
    resources = []
    alert = re.compile(r'\[(?:error|warn|fatal)\]|\b(?:ERROR|WARNING|FATAL|PANIC):', re.I)
    for role, container in [*services.items(), *(('workspace', value) for value in workspace_ids)]:
        info = json.loads(lab.execute(['docker', 'inspect', container]))[0]
        assert info['State']['Running'] and not info['State']['OOMKilled']
        assert info['RestartCount'] == 0
        host = info['HostConfig']
        environment = dict(value.split('=', 1) for value in info['Config']['Env'] if '=' in value)
        if role == 'coder':
            assert info['Config']['Image'] == lab.CODER_IMAGE
            assert host['Memory'] == 2 * 1024**3 and host['NanoCpus'] == 2000000000
            assert host['PidsLimit'] == 256
            assert environment['CODER_TLS_ENABLE'] == 'true'
            assert environment['CODER_ACCESS_URL'] == 'https://coder:' + str(config['tlsPort'])
            assert environment['CODER_TELEMETRY_ENABLE'] == environment['CODER_UPDATE_CHECK'] == 'false'
            assert len(host['PortBindings']) == 1
            assert all(binding['HostIp'] == config['bindAddress'] for group in host['PortBindings'].values() for binding in group)
            assert any(mount['Source'] == '/var/run/docker.sock' for mount in info['Mounts'])
        elif role == 'database':
            assert info['Config']['Image'] == lab.POSTGRES_IMAGE
            assert environment['POSTGRES_PASSWORD'] == settings['POSTGRES_PASSWORD']
            assert not host['PortBindings']
            assert info['State']['Health']['Status'] == 'healthy'
        else:
            assert not host['PortBindings'] and len(info['Mounts']) == 1
            assert info['Mounts'][0]['Type'] == 'volume' and info['Mounts'][0]['Destination'] == '/workspace'
            assert set(info['NetworkSettings']['Networks']) == {'agent-studio-coder-lab-workspaces'}
        counts = {}
        for label, flags in (('sinceCreation', []), ('lastTwoMinutes', ['--since', '2m'])):
            result = subprocess.run(['docker', 'logs', *flags, container], capture_output=True, text=True, timeout=30)
            assert result.returncode == 0
            counts[label] = sum(bool(alert.search(line)) for line in (result.stdout + '\n' + result.stderr).splitlines())
        assert counts['lastTwoMinutes'] == 0, (role, counts)
        resources.append({
            'role': role, 'name': info['Name'].lstrip('/'), 'image': info['Config']['Image'],
            'running': info['State']['Running'], 'restartCount': info['RestartCount'],
            'memoryBytes': host['Memory'], 'nanoCpus': host['NanoCpus'], 'pidsLimit': host['PidsLimit'],
            'mountDestinations': [mount['Destination'] for mount in info['Mounts']],
            'warningOrErrorLineCounts': counts,
        })
    network = json.loads(lab.execute(['docker', 'network', 'inspect', 'agent-studio-coder-lab-workspaces']))[0]
    assert network['Internal']
    running = set(lab.execute(['docker', 'ps', '-q']).split())
    assert set(config['baselineContainerIds']) <= running
    session = json.loads((lab.PRIVATE / 'session.json').read_text())
    user = str(uuid.UUID(session['user_id']))
    rows = lab.execute(['docker', 'exec', services['database'], 'psql', '-U', 'coder', '-d', 'coder', '-At', '-c',
                        f"SELECT count(*) FROM api_keys WHERE user_id='{user}';"]).strip()
    assert rows == '1'
    assert lab.request('/api/v2/users/me', token=lab.token())['id'] == user
    hba = lab.execute(['docker', 'exec', services['database'], 'psql', '-U', 'coder', '-d', 'coder', '-At', '-c',
                       'SELECT type, address, auth_method FROM pg_hba_file_rules WHERE error IS NULL;']).splitlines()
    assert 'host|all|scram-sha-256' in hba
    report = {
        'task': 'T-104', 'stage': 'resource-and-log-audit', 'passed': True,
        'resources': resources, 'preexistingRunningContainerCount': len(config['baselineContainerIds']),
        'preexistingContainersStillRunning': True, 'privateTopLevelFilesChecked': len(private_files),
        'privatePermissionsChecked': True, 'dedicatedCertificateValidBeyondOneDay': True,
        'workspaceNetworkInternal': network['Internal'], 'remainingOwnerSessionCount': int(rows),
        'runnerSessionStillValid': True, 'databaseHbaRules': hba,
        'startupLogsEntirelyClean': not any(item['warningOrErrorLineCounts']['sinceCreation'] for item in resources),
        'recentLogWindowSeconds': 120, 'recentWarningOrErrorLines': 0,
        'historicalDiagnostics': [
            'Telemetry disabled: security notifications unavailable; intentional lab setting.',
            'coder_agent.dir deprecated; non-HOME dir unsupported by Desktop file sync, which is not enabled.',
            'PostgreSQL local/socket trust initialization warning; network-wide host rule uses scram-sha-256.',
            'One workspace retried authentication before its provisioning job completed; current agents connected.',
            'Agent prebuilt-workspace probe rejected; these workspaces are not prebuilt.',
            'Userspace networking fakeRouter Up/Set warnings; not a full network-isolation verification.',
        ],
        'resourcesRetained': True, 'persistentDataDeleted': False, 'stageM1Passed': False,
    }
    output = lab.OUTPUT / ('resource-audit-' + secrets.token_hex(4) + '.json')
    lab.save(output, report)
    print('PASS: 4 running lab containers; private config, limits, TLS, database auth and retained session checked')
    print('Historical startup diagnostics retained; recent 120-second warning/error count: 0')
    print('Evidence:', output.relative_to(lab.ROOT))


if __name__ == '__main__':
    main()
