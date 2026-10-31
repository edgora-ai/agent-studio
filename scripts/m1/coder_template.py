"""Push the reviewed lab template and verify two independent instance records."""
import argparse
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path, PurePosixPath
import secrets
import shutil
import time
import uuid

spec = importlib.util.spec_from_file_location('coder_lab', Path(__file__).with_name('coder_lab.py'))
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)
TEMPLATE = 'agent-studio-lab'
VERSION = 'lab-v3'
WORKSPACES = ('m1-a', 'm1-b')


def validate_request(template_id, version_id, root, allowed):
    version = allowed.get(version_id)
    if not isinstance(version, dict) or version.get('revoked') is not False or version.get('templateId') != template_id:
        raise ValueError('Template version is not authorized')
    if root != '/workspace' or str(PurePosixPath(root)) != root:
        raise ValueError('Project root is outside the frozen lab contract')
    return version


def validate_record(record, expected):
    if record != expected:
        raise ValueError('Instance record differs from the independent build record')
    if set(record) != {'schemaVersion', 'workspaceId', 'agentResourceId', 'generation', 'templateVersion', 'imageId', 'root', 'uid', 'policyVersion'}:
        raise ValueError('Unexpected instance record fields')
    if any(type(record[key]) is not int for key in ('schemaVersion', 'uid')):
        raise ValueError('Integer fields cannot be booleans or floating-point values')
    if any(type(record[key]) is not str or not record[key] for key in set(record) - {'schemaVersion', 'uid'}):
        raise ValueError('Instance identity fields must be nonempty strings')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', record['imageId']):
        raise ValueError('Image identity must be an immutable SHA-256')
    for key in ('workspaceId', 'agentResourceId', 'generation'):
        uuid.UUID(record[key])
    if record['schemaVersion'] != 1 or record['root'] != '/workspace' or record['uid'] != 1000 or record['policyVersion'] != 'lab-v1':
        raise ValueError('Instance record violates the frozen lab contract')
    return dict(record)


def organization_id():
    return json.loads((lab.PRIVATE / 'session.json').read_text())['organization_id']


def template_info():
    templates = lab.request('/api/v2/organizations/' + organization_id() + '/templates', token=lab.token())
    matches = [value for value in templates if value['name'] == TEMPLATE]
    if len(matches) != 1:
        raise RuntimeError('Expected exactly one dedicated lab template')
    return matches[0]


def push():
    config = lab.state()
    source = lab.INFRA / 'template/main.tf'
    if 'templateVersionId' in config:
        remote = lab.request('/api/v2/templateversions/' + config['templateVersionId'], token=lab.token())
        if remote['name'] == VERSION:
            if config['templateSha256'] != hashlib.sha256(source.read_bytes()).hexdigest():
                raise RuntimeError('Bump the explicit template version before changing its frozen source')
            assert template_info()['active_version_id'] == config['templateVersionId']
            print('PASS: exact frozen template version already active; no upload needed')
            return
    target = lab.OUTPUT / 'template/main.tf'
    if target.exists() and target.read_bytes() != source.read_bytes():
        previous = target.read_bytes()
        snapshot = lab.OUTPUT / ('template-history-' + hashlib.sha256(previous).hexdigest() + '.tf')
        if not snapshot.exists():
            with snapshot.open('xb') as handle:
                handle.write(previous)
        assert snapshot.read_bytes() == previous
    shutil.copyfile(source, target)
    target.chmod(0o644)
    output = lab.cli(['templates', 'push', TEMPLATE, '--directory', '/opt/lab-template',
                      '--name', VERSION, '--variable', 'workspace_image=' + config['workspaceImage'],
                      '--message', 'T-104 dedicated identity fixture', '--yes'])
    private_log = lab.PRIVATE / ('template-push-' + secrets.token_hex(4) + '.log')
    private_log.write_text(output)
    private_log.chmod(0o600)
    info = template_info()
    config['templateId'] = info['id']
    config['templateVersionId'] = info['active_version_id']
    config['templateSha256'] = hashlib.sha256(source.read_bytes()).hexdigest()
    lab.save(lab.OUTPUT / 'state.json', config, exclusive=False)
    allowlist_path = lab.OUTPUT / 'allowlist.json'
    allowed = json.loads(allowlist_path.read_text()) if allowlist_path.exists() else {}
    for previous in allowed.values():
        previous['revoked'] = True
    allowed[info['active_version_id']] = {'templateId': info['id'], 'revoked': False, 'name': VERSION}
    lab.save(allowlist_path, allowed, exclusive=not allowlist_path.exists())
    print('PASS: frozen template uploaded:', info['id'], info['active_version_id'])


def workspaces():
    return lab.request('/api/v2/workspaces?q=owner%3Ame', token=lab.token())['workspaces']


def create():
    config = lab.state()
    allowed = json.loads((lab.OUTPUT / 'allowlist.json').read_text())
    validate_request(config['templateId'], config['templateVersionId'], '/workspace', allowed)
    for name in WORKSPACES:
        current = [value for value in workspaces() if value['name'] == name]
        if current:
            if len(current) != 1 or current[0]['template_id'] != config['templateId']:
                raise RuntimeError('A workspace name is already owned by another template')
            continue
        output = lab.cli(['create', name, '--template', TEMPLATE, '--template-version', VERSION, '--yes'])
        private_log = lab.PRIVATE / ('create-' + name + '-' + secrets.token_hex(4) + '.log')
        private_log.write_text(output)
        private_log.chmod(0o600)
        print('Created dedicated workspace:', name)


def update():
    config = lab.state()
    current = {value['name']: value for value in workspaces()}
    for name in WORKSPACES:
        assert current[name]['template_id'] == config['templateId']
        lab.cli(['update', name])
        print('Updated only dedicated workspace:', name)


def verify():
    config = lab.state()
    allowed = json.loads((lab.OUTPUT / 'allowlist.json').read_text())
    records = []
    for name in WORKSPACES:
        matches = [value for value in workspaces() if value['name'] == name]
        assert len(matches) == 1
        workspace = matches[0]
        build = workspace['latest_build']
        assert build['status'] == 'running', (name, build['status'])
        validate_request(workspace['template_id'], build['template_version_id'], '/workspace', allowed)
        resources = lab.request('/api/v2/workspacebuilds/' + build['id'] + '/resources', token=lab.token())
        metadata = [item['value'] for resource in resources for item in resource.get('metadata', [])
                    if item['key'] == 'agent-studio-instance']
        assert len(metadata) == 1
        expected = json.loads(metadata[0])
        assert expected['workspaceId'] == workspace['id'] and expected['imageId'] == config['workspaceImage']
        bound_resources = [resource for resource in resources if any(
            item['key'] == 'agent-studio-instance' for item in resource.get('metadata', []))]
        assert len(bound_resources) == 1
        agents = bound_resources[0].get('agents') or []
        assert len(agents) == 1 and agents[0]['name'] == 'main'
        platform_agent_id = str(uuid.UUID(agents[0]['id']))
        deadline = time.monotonic() + 90
        while agents[0]['status'] != 'connected' and time.monotonic() < deadline:
            time.sleep(2)
            resources = lab.request('/api/v2/workspacebuilds/' + build['id'] + '/resources', token=lab.token())
            agents = [agent for resource in resources for agent in (resource.get('agents') or [])
                      if agent['id'] == platform_agent_id]
        assert agents[0]['status'] == 'connected', (name, agents[0]['status'])
        containers = lab.execute(['docker', 'ps', '-q', '--filter', 'label=agent-studio.lab=t104',
                                  '--filter', 'label=agent-studio.workspace=' + workspace['id']]).split()
        assert len(containers) == 1
        container = containers[0]
        details = json.loads(lab.execute(['docker', 'inspect', container]))[0]
        assert details['Config']['Labels']['agent-studio.generation'] == expected['generation']
        assert details['Image'] == config['workspaceImage']
        assert details['Config']['User'] == '1000:1000'
        assert details['HostConfig']['Memory'] == 256 * 1024 * 1024
        assert details['HostConfig']['NanoCpus'] == 500000000
        assert not details['HostConfig']['Privileged']
        assert set(details['NetworkSettings']['Networks']) == {'agent-studio-coder-lab-workspaces'}
        assert not details['HostConfig']['PortBindings']
        assert len(details['Mounts']) == 1
        assert all(mount['Type'] == 'volume' and mount['Destination'] == '/workspace' for mount in details['Mounts'])
        assert details['HostConfig']['CapDrop'] == ['ALL']
        assert any(option.startswith('no-new-privileges') for option in details['HostConfig']['SecurityOpt'])
        observed = json.loads(lab.execute(['docker', 'exec', container, 'python', '-c',
            "import json,os,pathlib; p=pathlib.Path('/run/agent-studio/identity.json'); print(json.dumps({'record':json.loads(p.read_text()),'uid':os.getuid(),'root':str(pathlib.Path('/workspace').resolve()),'identityOwner':p.stat().st_uid,'identityMode':p.stat().st_mode & 511}))"]))
        validate_record(observed['record'], expected)
        assert observed['uid'] == 1000 and observed['root'] == '/workspace'
        assert observed['identityOwner'] == 1000 and observed['identityMode'] == 0o444
        query = "SELECT id::text, workspace_id::text, template_version_id::text FROM workspace_builds WHERE id = '" + str(uuid.UUID(build['id'])) + "';"
        stored = lab.execute(['docker', 'exec', lab.container_id('database'), 'psql', '-U', 'coder', '-d', 'coder', '-At', '-c', query]).strip().split('|')
        assert stored == [build['id'], workspace['id'], build['template_version_id']]
        agent_query = "SELECT a.id::text, r.job_id::text FROM workspace_agents a JOIN workspace_resources r ON a.resource_id = r.id WHERE a.id = '" + platform_agent_id + "';"
        agent_row = lab.execute(['docker', 'exec', lab.container_id('database'), 'psql', '-U', 'coder', '-d', 'coder', '-At', '-c', agent_query]).strip().split('|')
        assert agent_row == [platform_agent_id, build['job']['id']]
        records.append({'name': name, 'buildId': build['id'], 'templateVersionId': build['template_version_id'],
                        'platformAgentId': platform_agent_id, 'agentBuildAssociationReadback': True,
                        'record': expected, 'agentConnected': True, 'databaseReadback': True,
                        'independentContainerReadback': True, 'runtimePolicyChecked': True,
                        'markerOwner': observed['identityOwner'], 'markerMode': oct(observed['identityMode']),
                        'markerTamperProofAgainstWorkspaceUser': False})
    assert records[0]['record']['generation'] != records[1]['record']['generation']
    before = {value['id'] for value in workspaces()}
    rejects = []
    for label, template_id, version_id, root, versions in [
        ('unknown-version', config['templateId'], str(uuid.uuid4()), '/workspace', allowed),
        ('wrong-template', str(uuid.uuid4()), config['templateVersionId'], '/workspace', allowed),
        ('outside-root', config['templateId'], config['templateVersionId'], '/workspace/../etc', allowed),
        ('revoked-version', config['templateId'], config['templateVersionId'], '/workspace',
         {config['templateVersionId']: {'templateId': config['templateId'], 'revoked': True}}),
    ]:
        try:
            validate_request(template_id, version_id, root, versions)
        except ValueError:
            rejects.append(label)
        else:
            raise AssertionError(label + ' was incorrectly accepted')
    for label, record in [('missing-record', {}), ('wrong-instance', records[1]['record']),
                          ('forged-generation', {**records[0]['record'], 'generation': str(uuid.uuid4())})]:
        try:
            validate_record(record, records[0]['record'])
        except ValueError:
            rejects.append(label)
        else:
            raise AssertionError(label + ' was incorrectly accepted')
    historical = str(uuid.uuid4())
    validate_request(config['templateId'], historical, '/workspace',
                     {historical: {'templateId': config['templateId'], 'revoked': False, 'name': 'older-approved'}})
    assert {value['id'] for value in workspaces()} == before
    report = {'task': 'T-104', 'stage': 'template-and-independent-instances', 'passed': True,
              'templateSha256': config['templateSha256'], 'records': records,
              'rejectedProbeCases': rejects, 'approvedOlderVersionAcceptedByProbe': True,
              'negativeProbesCreatedNoWorkspaces': True, 'productCreateApiTested': False,
              'sshHelperTested': False, 'crossHostTested': False, 'stageM1Passed': False,
              'limits': ['same-host Docker, not VM isolation', 'marker owner can chmod it; marker is not a trust boundary',
                         'internal bridge is not full egress security proof',
                         'workspace writable image layer has no hard disk quota', 'no per-workspace PID cgroup limit yet',
                         'older-version acceptance is an offline policy probe, not a deployed rollback']}
    output = lab.OUTPUT / ('instances-' + secrets.token_hex(4) + '.json')
    lab.save(output, report)
    print('PASS: two different independent instance records, database/API/container readback, 7 rejected probes')
    print('Evidence:', output.relative_to(lab.ROOT))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('push', 'create', 'update', 'verify'))
    args = parser.parse_args()
    os.umask(0o077)
    {'push': push, 'create': create, 'update': update, 'verify': verify}[args.action]()


if __name__ == '__main__':
    main()
