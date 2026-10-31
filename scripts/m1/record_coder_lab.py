"""Freeze selected non-secret lab reports and source fingerprints without overwriting history."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('control-plane', 'instances', 'browser', 'audit', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    reports = {}
    for name, stage in (
        ('control_plane', 'control-plane'), ('instances', 'template-and-independent-instances'),
        ('browser', 'browser-login-to-workspaces'), ('audit', 'resource-and-log-audit'),
    ):
        path = getattr(args, name).resolve()
        path.relative_to(ROOT / 'artifacts/m1/t104/lab')
        value = json.loads(path.read_text())
        assert value['task'] == 'T-104' and value['stage'] == stage and value['passed'] is True
        reports[name] = {'path': str(path.relative_to(ROOT)), 'sha256': digest(path), 'result': value}
    tests = []
    for filename in ('test_coder_contract.py', 'test_isolation.py'):
        command = ['python3', '-I', 'scripts/m1/' + filename]
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=120)
        assert result.returncode == 0, filename
        count = re.search(r'Ran (\d+) tests', result.stderr)
        assert count
        tests.append({'command': command, 'exitCode': result.returncode, 'testCount': int(count[1])})
    source_paths = sorted((ROOT / 'infra/coder-lab').rglob('*')) + [ROOT / 'scripts/m1' / name for name in (
        'coder_lab.py', 'coder_template.py', 'test_coder_browser.py', 'test_coder_contract.py',
        'audit_coder_lab.py', 'record_coder_lab.py',
    )]
    sources = [{'path': str(path.relative_to(ROOT)), 'sha256': digest(path)} for path in source_paths if path.is_file()]
    config = json.loads((ROOT / 'artifacts/m1/t104/lab/state.json').read_text())
    allowlist = json.loads((ROOT / 'artifacts/m1/t104/lab/allowlist.json').read_text())
    instances = reports['instances']['result']['records']
    assert len(instances) == 2 and {item['name'] for item in instances} == {'m1-a', 'm1-b'}
    assert all(item['templateVersionId'] == config['templateVersionId'] for item in instances)
    assert reports['instances']['result']['templateSha256'] == config['templateSha256']
    assert config['templateSha256'] == digest(ROOT / 'infra/coder-lab/template/main.tf')
    value = {
        'task': 'T-104', 'recordedOn': '2026-10-30', 'status': 'verified-local-lab-scope-with-known-limits',
        'deployment': {key: config[key] for key in (
            'project', 'coderVersion', 'coderImage', 'databaseImage', 'workspaceImage',
            'workspaceDockerfileSha256', 'templateId', 'templateVersionId', 'templateSha256',
        )},
        'templateAllowlist': allowlist, 'reports': reports, 'offlineTests': tests, 'sources': sources,
        'corrections': [
            'Coder password login returns HTTP 201; fixed expected status without resetting the database.',
            'Terraform agentResourceId and REST platformAgentId are different; associate the latter with build resources and database job ID.',
            'Marker is owned by workspace UID 1000, not root; lab-v3 declares observed ownership and makes no tamper-proof claim.',
            'An earlier failed Playwright API request printed a disposable test session cookie. All disposable owner sessions were revoked; no cookie value is retained here.',
            'Browser verification now uses in-page fetch, certificate pinning and browser-local hostname mapping; exceptions omit request details.',
        ],
        'scope': {
            'productCreateApiVerified': False, 'currentSshChannelIdentityVerified': False,
            'remoteHelperVerified': False, 'crossHostVerified': False, 'stageM1Passed': False,
            'productionDshChanged': False, 'publicIngressConfigured': False,
            'unattendedRestartOrLongLivedDeploymentVerified': False,
        },
        'nextTasks': ['T-105', 'T-106', 'T-107'],
    }
    output = args.output.resolve()
    output.relative_to(ROOT)
    with output.open('x', encoding='utf-8') as handle:
        json.dump(value, handle, indent=2, ensure_ascii=False)
        handle.write('\n')
    stored = json.loads(output.read_text())
    assert stored == value
    assert stored['task'] == 'T-104'
    indexed = {item['name']: item for item in stored['reports']['instances']['result']['records']}
    assert indexed['m1-a']['buildId'] == instances[0]['buildId']
    assert indexed['m1-b']['record']['generation'] != indexed['m1-a']['record']['generation']
    print('PASS: reports and source hashes frozen, complete readback and workspace/build lookup verified')
    print(digest(output), str(output.relative_to(ROOT)))


if __name__ == '__main__':
    main()
