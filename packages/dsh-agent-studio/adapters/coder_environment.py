"""D07 fixed Coder control-plane contract, called only inside coder_broker.

No credentials leave the central broker. The installed lab policy is read-only;
mutations require a separately operator-edited policy AND a consumed, durable
owner confirmation. No DELETE/rebuild, SSH fallback or automatic POST retries.
"""
from datetime import datetime, timezone
import hashlib
import json
import re
import sqlite3
import time
import uuid

COMMIT = '7ac93cffea828ca2d9514cfc6c0ad6337834aebe'
VERSION = 'v2.37.8+7ac93cf'
WORKSPACE = 'ff136352-6a92-41d4-9c2c-6cc783cb989b'


def require(value, code):
    if not value:
        raise ValueError(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def uid(value):
    require(isinstance(value, str) and str(uuid.UUID(value)) == value, 'D07_INVALID_ID')
    return value


def load_policy(root):
    file = root / 'environment-policy.json'
    info = file.lstat()
    require(file.is_file() and not file.is_symlink() and info.st_mode & 0o077 == 0 and info.st_size <= 65536, 'D07_POLICY_FILE')
    p = json.loads(file.read_text())
    require(set(p) == {'version', 'transport', 'read_only', 'owner_id', 'owner_name', 'organization_id', 'workspace_ids', 'actions', 'templates', 'observation_ttl_ms', 'action_timeout_ms'}, 'D07_POLICY_FIELDS')
    require(p['version'] == 1 and p['transport'] == 'coder-lab-v1' and type(p['read_only']) is bool and p['owner_name'] == 'lab-owner', 'D07_POLICY_INVALID')
    uid(p['owner_id']); uid(p['organization_id'])
    require(isinstance(p['workspace_ids'], list) and len(p['workspace_ids']) <= 16, 'D07_POLICY_TARGETS')
    for value in p['workspace_ids']:
        uid(value)
    require(isinstance(p['actions'], list) and set(p['actions']) <= {'create', 'start', 'stop'} and (not p['read_only'] or not p['actions']), 'D07_POLICY_ACTIONS')
    require(type(p['observation_ttl_ms']) is int and 1000 <= p['observation_ttl_ms'] <= 60000 and type(p['action_timeout_ms']) is int and 1000 <= p['action_timeout_ms'] <= 300000, 'D07_POLICY_DEADLINES')
    require(isinstance(p['templates'], list) and 0 < len(p['templates']) <= 8, 'D07_POLICY_TEMPLATES')
    for t in p['templates']:
        require(set(t) == {'template_id', 'version_id', 'name', 'template_version', 'roots', 'image_id', 'parameters', 'create_names'}, 'D07_POLICY_TEMPLATE_FIELDS')
        uid(t['template_id']); uid(t['version_id'])
        require(t['roots'] == ['/workspace'] and re.fullmatch(r'sha256:[a-f0-9]{64}', t['image_id']) and isinstance(t['name'], str) and 0 < len(t['name']) <= 80 and isinstance(t['template_version'], str) and 0 < len(t['template_version']) <= 80, 'D07_POLICY_TEMPLATE')
        require(isinstance(t['parameters'], list) and len(t['parameters']) <= 16 and isinstance(t['create_names'], list) and len(t['create_names']) <= 4, 'D07_POLICY_PARAMETERS')
        for parameter in t['parameters']:
            require(set(parameter) == {'name', 'value'} and re.fullmatch(r'[a-z][a-z0-9_]{0,63}', parameter['name']) and not re.search(r'secret|token|password|credential|key', parameter['name'], re.I) and isinstance(parameter['value'], str) and len(parameter['value']) <= 1024, 'D07_POLICY_PARAMETER')
        for name in t['create_names']:
            require(isinstance(name, str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,31}', name) and name not in ('new', 'create'), 'D07_POLICY_NAME')
    require(len({t['version_id'] for t in p['templates']}) == len(p['templates']), 'D07_POLICY_DUPLICATE')
    return p


def authenticated(lab, policy):
    build = lab.request('/api/v2/buildinfo')
    require(build['version'] == VERSION and build['external_url'].endswith('/' + COMMIT), 'D07_SERVER_VERSION_CHANGED')
    me = lab.request('/api/v2/users/me', token=lab.token())
    require(me['id'] == policy['owner_id'] and me['username'] == policy['owner_name'], 'D07_CONTROL_PLANE_OWNER_CHANGED')
    return {'version': build['version'], 'commit': COMMIT, 'deployment_id': build['deployment_id']}


def templates(lab, policy):
    rows = []
    for allowed in policy['templates']:
        version = lab.request('/api/v2/templateversions/' + uid(allowed['version_id']), token=lab.token())
        template = lab.request('/api/v2/templates/' + uid(allowed['template_id']), token=lab.token())
        require(version['template_id'] == template['id'] == allowed['template_id'] and version['organization_id'] == template['organization_id'] == policy['organization_id'], 'D07_TEMPLATE_OWNER_CHANGED')
        require(version['job']['status'] == 'succeeded', 'D07_TEMPLATE_NOT_READY')
        rows.append({**allowed, 'active_version_id': template['active_version_id'], 'version_job_status': version['job']['status'], 'operator_allowed': True})
    return rows


def allowed_workspace(workspace, policy):
    return (workspace['owner_id'] == policy['owner_id'] and workspace['organization_id'] == policy['organization_id'] and
            (workspace['id'] in policy['workspace_ids'] or any(workspace['name'] in t['create_names'] and workspace['template_id'] == t['template_id'] for t in policy['templates'])))


def build_summary(build):
    return {key: build.get(key) for key in ('id', 'workspace_id', 'template_version_id', 'transition', 'status', 'created_at', 'updated_at')} | {
        'job': {key: build.get('job', {}).get(key) for key in ('id', 'status', 'started_at', 'completed_at')},
        # Never forward arbitrary provisioner diagnostic strings to the browser.
        'error_code': 'coder-build-failed' if build.get('job', {}).get('error') else None}


def observe_workspace(broker, policy, workspace):
    lab = broker.transport.lab
    require(broker.transport.digest(lab.INFRA / 'template/main.tf') == lab.state()['templateSha256'], 'D07_FROZEN_TEMPLATE_CHANGED')
    require(allowed_workspace(workspace, policy), 'D07_TARGET_DENIED')
    build = workspace['latest_build']
    template = next((row for row in policy['templates'] if row['template_id'] == workspace['template_id'] and row['version_id'] == build['template_version_id']), None)
    base = {'workspace_id': uid(workspace['id']), 'name': workspace['name'], 'owner_id': workspace['owner_id'], 'organization_id': workspace['organization_id'],
            'template_id': workspace['template_id'], 'template_version_id': build['template_version_id'], 'lifecycle': build['status'],
            'dormant_at': workspace.get('dormant_at'), 'deleting_at': workspace.get('deleting_at'), 'build': build_summary(build),
            'job': build_summary(build)['job'], 'agent': {'id': None, 'status': 'not-observed'}, 'identity': {'verified': False, 'generation': None}, 'error_code': None}
    if template is None:
        return {**base, 'error_code': 'environment-template-denied'}
    resources = lab.request('/api/v2/workspacebuilds/' + uid(build['id']) + '/resources', token=lab.token())
    pairs = [(resource, item) for resource in resources for item in resource.get('metadata', []) if item['key'] == 'agent-studio-instance']
    if len(pairs) != 1:
        return {**base, 'error_code': 'environment-identity-unavailable'}
    resource, metadata = pairs[0]
    marker = json.loads(metadata['value'])
    broker.transport.template.validate_record(marker, marker)
    require(marker['workspaceId'] == workspace['id'] and marker['imageId'] == template['image_id'] and marker['templateVersion'] == template['template_version'] and marker['root'] in template['roots'], 'D07_INSTANCE_POLICY_CHANGED')
    agents = resource.get('agents') or []
    if len(agents) != 1 or agents[0]['name'] != 'main':
        return {**base, 'error_code': 'environment-agent-unavailable'}
    agent = agents[0]
    query = ("SELECT a.id::text,r.id::text,r.job_id::text,b.id::text,b.workspace_id::text,b.template_version_id::text FROM workspace_agents a "
             "JOIN workspace_resources r ON a.resource_id=r.id JOIN workspace_builds b ON b.job_id=r.job_id WHERE a.id='" + uid(agent['id']) + "';")
    actual = lab.execute(['docker', 'exec', lab.container_id('database'), 'psql', '-U', 'coder', '-d', 'coder', '-At', '-c', query], timeout=20).strip().split('|')
    expected = [agent['id'], resource['id'], build['job']['id'], build['id'], workspace['id'], build['template_version_id']]
    require(actual == expected, 'D07_CURRENT_BUILD_DATABASE_MISMATCH')
    record = {'name': workspace['name'], 'owner': policy['owner_name'], 'ownerId': policy['owner_id'], 'workspaceId': workspace['id'], 'platformAgentId': agent['id'], 'agentName': agent['name'], 'resourceId': resource['id'], 'jobId': build['job']['id'], 'buildId': build['id'], 'templateId': workspace['template_id'], 'templateVersionId': build['template_version_id'], 'templateSha256': lab.state()['templateSha256'], 'marker': marker, 'expectedUser': 'coder', 'expectedUid': 1000, 'root': marker['root']}
    return {**base, 'agent': {key: agent.get(key) for key in ('id', 'name', 'status', 'lifecycle_state', 'first_connected_at', 'last_connected_at', 'disconnected_at')},
            'identity': {'verified': True, 'generation': marker['generation'], 'source': 'authenticated-current-build/resources+direct-SQL; not a helper-channel proof', 'record': record}, 'database_consistent': True}


def discover(broker, root):
    policy = load_policy(root); lab = broker.transport.lab
    server = authenticated(lab, policy); allowed = templates(lab, policy)
    document = lab.request('/api/v2/workspaces?q=owner%3Ame&limit=100', token=lab.token())
    require(document.get('count', len(document['workspaces'])) <= 100, 'D07_DIRECTORY_LIMIT')
    rows = []
    for workspace in document['workspaces']:
        if not allowed_workspace(workspace, policy):
            continue
        try:
            rows.append(observe_workspace(broker, policy, workspace))
        except Exception as error:
            rows.append({'workspace_id': workspace['id'], 'name': workspace['name'], 'owner_id': workspace['owner_id'], 'lifecycle': 'unknown', 'error_code': str(error) if isinstance(error, ValueError) and str(error).startswith('D07_') else 'environment-observation-failed'})
    observed = {row['workspace_id'] for row in rows}
    for missing in set(policy['workspace_ids']) - observed:
        rows.append({'workspace_id': missing, 'name': 'Unavailable approved workspace', 'owner_id': policy['owner_id'], 'lifecycle': 'unknown', 'error_code': 'environment-not-found-or-owner-changed'})
    return {'server': server, 'templates': allowed, 'workspaces': rows, 'observed_at': datetime.now(timezone.utc).isoformat(), 'read_only': policy['read_only'], 'actions': policy['actions'], 'policy_sha256': digest(policy), 'source': 'coder-control-plane', 'complete': True}


def request_row(root, request_id):
    require(re.fullmatch(r'[A-Za-z0-9_-]{8,128}', request_id), 'D07_REQUEST_ID')
    with sqlite3.connect('file:' + str(root / 'bindings.sqlite') + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        row = db.execute('SELECT * FROM environment_requests WHERE request_id=?', (request_id,)).fetchone()
        owner = db.execute("SELECT value FROM deployment WHERE key='principal_id'").fetchone()[0]
        require(row is not None and row['principal_id'] == owner, 'D07_REQUEST_OWNER')
        return dict(row)


def submit(broker, root, request_id):
    policy = load_policy(root); row = request_row(root, request_id)
    require(not policy['read_only'] and row['action'] in policy['actions'] and row['policy_sha256'] == digest(policy), 'D07_READ_ONLY_OR_POLICY_CHANGED')
    require(row['state'] == 'submitting' and row['attempted_at'] is None and row['deadline_ms'] > time.time() * 1000, 'D07_REQUEST_EXPIRED_OR_ATTEMPTED')
    require(hashlib.sha256(row['parameters_json'].encode()).hexdigest() == row['parameters_sha256'], 'D07_PARAMETERS_CHANGED')
    params = json.loads(row['parameters_json']); lab = broker.transport.lab
    require(params['request_id'] == row['request_id'] and params['action'] == row['action'] and params['template_version_id'] == row['template_version_id'], 'D07_REQUEST_PARAMETERS_MISMATCH')
    authenticated(lab, policy); templates(lab, policy)
    template = next((item for item in policy['templates'] if item['version_id'] == row['template_version_id']), None)
    require(template is not None, 'D07_TEMPLATE_DENIED')
    if row['action'] == 'create':
        require(set(params) == {'request_id', 'action', 'name', 'template_version_id'} and params['name'] in template['create_names'], 'D07_CREATE_TARGET_DENIED')
        existing = lab.request('/api/v2/workspaces?q=owner%3Ame&limit=100', token=lab.token())
        require(existing.get('count', len(existing['workspaces'])) <= 100 and not any(w['name'] == params['name'] for w in existing['workspaces']), 'D07_CREATE_NAME_EXISTS')
        path = '/api/v2/users/' + uid(policy['owner_id']) + '/workspaces'
        body = {'name': params['name'], 'template_version_id': template['version_id'], 'rich_parameter_values': template['parameters'], 'automatic_updates': 'never'}
    else:
        require(set(params) == {'request_id', 'action', 'workspace_id', 'template_version_id'} and params['workspace_id'] == row['workspace_id'], 'D07_TARGET_CHANGED')
        workspace = lab.request('/api/v2/workspaces/' + uid(row['workspace_id']), token=lab.token())
        require(allowed_workspace(workspace, policy) and workspace['template_id'] == template['template_id'] and workspace['latest_build']['template_version_id'] == template['version_id'], 'D07_TARGET_DENIED')
        require(workspace['latest_build']['status'] == ('stopped' if row['action'] == 'start' else 'running'), 'D07_TARGET_STATE_CHANGED')
        path = '/api/v2/workspaces/' + uid(row['workspace_id']) + '/builds'
        body = {'transition': row['action'], 'template_version_id': template['version_id']}
        if row['action'] == 'start':
            body['rich_parameter_values'] = template['parameters']
    # One durable attempt BEFORE the HTTP request. Loss after this line is unknown,
    # never grounds to send another POST, even if this broker itself is restarted.
    require(load_policy(root) == policy, 'D07_POLICY_CHANGED_BEFORE_ATTEMPT')
    with sqlite3.connect(root / 'bindings.sqlite', timeout=5) as db:
        db.execute('BEGIN IMMEDIATE')
        changed = db.execute("UPDATE environment_requests SET attempted_at=? WHERE request_id=? AND state='submitting' AND attempted_at IS NULL AND deadline_ms>?", (datetime.now(timezone.utc).isoformat(), request_id, time.time() * 1000)).rowcount
        require(changed == 1, 'D07_ALREADY_ATTEMPTED')
    try:
        result = lab.request(path, body=body, token=lab.token(), expected=201)
    except Exception as error:
        # HTTP status/transport loss may follow a committed write. Do not retry.
        return {'outcome': 'unknown', 'error_code': 'environment-submission-unknown', 'attempted': True, 'diagnostic_type': type(error).__name__}
    build = result['latest_build'] if row['action'] == 'create' else result
    workspace_id = result['id'] if row['action'] == 'create' else row['workspace_id']
    require(build['workspace_id'] == workspace_id and build['template_version_id'] == template['version_id'] and build['transition'] == ('start' if row['action'] == 'create' else row['action']), 'D07_SUBMITTED_JOB_MISMATCH')
    return {'outcome': 'accepted', 'workspace_id': uid(workspace_id), 'build_id': uid(build['id']), 'build': build_summary(build), 'ready': False}


def poll(broker, root, request_id):
    policy = load_policy(root); row = request_row(root, request_id); lab = broker.transport.lab
    require(row['build_id'] is not None and row['submitted_workspace_id'] is not None, 'D07_NO_TRACKABLE_JOB')
    authenticated(lab, policy)
    build = lab.request('/api/v2/workspacebuilds/' + uid(row['build_id']), token=lab.token())
    workspace = lab.request('/api/v2/workspaces/' + uid(row['submitted_workspace_id']), token=lab.token())
    require(allowed_workspace(workspace, policy) and build['workspace_id'] == workspace['id'] and build['template_version_id'] == row['template_version_id'], 'D07_JOB_TARGET_CHANGED')
    return {'build': build_summary(build), 'current_build': workspace['latest_build']['id'] == build['id'], 'workspace': observe_workspace(broker, policy, workspace)}


def enable_readonly(broker, root):
    file = root / 'environment-policy.json'
    if file.exists():
        policy = load_policy(root)
        require(policy['read_only'] and policy['actions'] == [], 'D07_EXISTING_POLICY_NOT_READ_ONLY')
        return {'read_only': True, 'reused': True, 'policy_sha256': digest(policy)}
    lab = broker.transport.lab; config = lab.state()
    me = lab.request('/api/v2/users/me', token=lab.token())
    workspace = lab.request('/api/v2/workspaces/' + WORKSPACE, token=lab.token())
    require(workspace['owner_id'] == me['id'] and me['username'] == 'lab-owner' and workspace['template_id'] == config['templateId'], 'D07_LAB_TARGET_CHANGED')
    policy = {'version': 1, 'transport': 'coder-lab-v1', 'read_only': True, 'owner_id': me['id'], 'owner_name': me['username'], 'organization_id': workspace['organization_id'], 'workspace_ids': [WORKSPACE], 'actions': [],
              'templates': [{'template_id': config['templateId'], 'version_id': config['templateVersionId'], 'name': broker.transport.template.TEMPLATE, 'template_version': 'lab-v3', 'roots': ['/workspace'], 'image_id': config['workspaceImage'], 'parameters': [], 'create_names': []}], 'observation_ttl_ms': 30000, 'action_timeout_ms': 180000}
    authenticated(lab, policy); templates(lab, policy)
    broker.private_json(file, policy); load_policy(root)
    return {'read_only': True, 'reused': False, 'policy_sha256': digest(policy)}
