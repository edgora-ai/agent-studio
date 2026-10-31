"""Explicit in-process Coder v2.37.8 transport fixture; no socket/subprocess/lab access."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import time
import types
import unittest

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('environment_contract', REPO / 'packages/dsh-agent-studio/adapters/coder_environment.py')
environment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(environment)
UID = lambda digit: digit * 8 + '-' + digit * 4 + '-4' + digit * 3 + '-8' + digit * 3 + '-' + digit * 12
OWNER, ORG, TEMPLATE, VERSION, WORKSPACE, BUILD, JOB, AGENT, RESOURCE = [UID(n) for n in '123456789']


class Transport:
    def __init__(self, root):
        self.calls = []
        self.behavior = 'success'
        self.workspace = {'id': WORKSPACE, 'name': 'fixture-owned', 'owner_id': OWNER, 'organization_id': ORG, 'template_id': TEMPLATE,
                          'latest_build': {'id': BUILD, 'workspace_id': WORKSPACE, 'template_version_id': VERSION, 'status': 'running', 'transition': 'start', 'job': {'id': JOB, 'status': 'succeeded'}}}
        self.INFRA = root / 'infra'
        (self.INFRA / 'template').mkdir(parents=True)
        (self.INFRA / 'template/main.tf').write_text('OFFLINE fixture, never provisioned')
        self.marker = {'schemaVersion': 1, 'workspaceId': WORKSPACE, 'agentResourceId': RESOURCE, 'generation': UID('a'), 'templateVersion': 'fixture-v1', 'imageId': 'sha256:' + 'a' * 64, 'root': '/workspace', 'uid': 1000, 'policyVersion': 'lab-v1'}

    def state(self):
        return {'templateSha256': hashlib.sha256((self.INFRA / 'template/main.tf').read_bytes()).hexdigest()}

    def token(self):
        return 'OFFLINE_PROTOCOL_FIXTURE_ONLY'

    def container_id(self, name):
        assert name == 'database'
        return 'OFFLINE_DATABASE_NOT_A_CONTAINER'

    def execute(self, argv, timeout):
        # Tests the broker's exact independent-DB association comparison without
        # invoking docker/psql or touching any existing database.
        assert argv[:3] == ['docker', 'exec', 'OFFLINE_DATABASE_NOT_A_CONTAINER']
        assert 'SELECT a.id::text,r.id::text,r.job_id::text,b.id::text' in argv[-1]
        return '|'.join([AGENT, RESOURCE, JOB, BUILD, WORKSPACE, VERSION])

    def request(self, path, *, token=None, body=None, expected=200):
        self.calls.append(('POST' if body is not None else 'GET', path, body))
        if body is not None:
            assert expected == 201
            if self.behavior == 'response-lost':
                raise TimeoutError('fixture: response lost after write')
            if path == '/api/v2/users/' + OWNER + '/workspaces':
                return self.workspace
            if path == '/api/v2/workspaces/' + WORKSPACE + '/builds':
                build = dict(self.workspace['latest_build'])
                build['transition'] = body['transition']
                return build
            raise AssertionError('Unexpected fixture POST path')
        if path == '/api/v2/buildinfo':
            return {'version': environment.VERSION, 'external_url': 'https://github.com/coder/coder/commit/' + environment.COMMIT, 'deployment_id': ORG}
        if path == '/api/v2/users/me':
            return {'id': OWNER if self.behavior != 'wrong-owner' else ORG, 'username': 'lab-owner'}
        if path == '/api/v2/templateversions/' + VERSION:
            return {'id': VERSION, 'template_id': TEMPLATE, 'organization_id': ORG, 'job': {'status': 'succeeded'}}
        if path == '/api/v2/templates/' + TEMPLATE:
            return {'id': TEMPLATE, 'organization_id': ORG, 'active_version_id': VERSION}
        if path == '/api/v2/workspaces?q=owner%3Ame&limit=100':
            return {'count': 0, 'workspaces': []}
        if path == '/api/v2/workspaces/' + WORKSPACE:
            return self.workspace
        if path == '/api/v2/workspacebuilds/' + BUILD:
            return self.workspace['latest_build']
        if path == '/api/v2/workspacebuilds/' + BUILD + '/resources':
            return [{'id': RESOURCE, 'metadata': [{'key': 'agent-studio-instance', 'value': json.dumps(self.marker)}], 'agents': [{'id': AGENT, 'name': 'main', 'status': 'connected'}]}]
        raise AssertionError('Unexpected fixture GET path: ' + path)


class BrokerTests(unittest.TestCase):
    def setUp(self):
        # Retain independent randomized test data, never reset product storage.
        self.root = Path(tempfile.mkdtemp(prefix='agent-studio-test-d07-python-'))
        self.policy = {'version': 1, 'transport': 'coder-lab-v1', 'read_only': False, 'owner_id': OWNER, 'owner_name': 'lab-owner', 'organization_id': ORG, 'workspace_ids': [WORKSPACE], 'actions': ['create', 'start', 'stop'],
                       'templates': [{'template_id': TEMPLATE, 'version_id': VERSION, 'name': 'OFFLINE FIXTURE', 'template_version': 'fixture-v1', 'roots': ['/workspace'], 'image_id': 'sha256:' + 'a' * 64, 'parameters': [{'name': 'size', 'value': 'fixture-small'}], 'create_names': ['fixture-owned']}], 'observation_ttl_ms': 30000, 'action_timeout_ms': 180000}
        self.save_policy()
        schema = (REPO / 'packages/dsh-agent-studio/environment-state.mjs').read_text().split('ENVIRONMENT_SCHEMA=`', 1)[1].split('`;', 1)[0]
        with sqlite3.connect(self.root / 'bindings.sqlite') as db:
            db.executescript(schema + "CREATE TABLE deployment(key TEXT PRIMARY KEY,value TEXT); INSERT INTO deployment VALUES('principal_id','fixture-owner');")
        self.lab = Transport(self.root)
        def validate(record, expected):
            if record != expected or record['workspaceId'] != WORKSPACE or record['root'] != '/workspace':
                raise ValueError('fixture-identity-mismatch')
            return dict(record)
        self.broker = types.SimpleNamespace(transport=types.SimpleNamespace(lab=self.lab, template=types.SimpleNamespace(validate_record=validate), digest=lambda file: hashlib.sha256(file.read_bytes()).hexdigest()))

    def save_policy(self):
        file = self.root / 'environment-policy.json'
        file.write_text(json.dumps(self.policy))
        file.chmod(0o600)

    def row(self, action='create'):
        request_id = 'offline-request-' + action
        params = {'request_id': request_id, 'action': action, 'template_version_id': VERSION}
        if action == 'create':
            params['name'] = 'fixture-owned'
        else:
            params['workspace_id'] = WORKSPACE
        row = dict(request_id=request_id, principal_id='fixture-owner', run_id='fixture-run', action=action, target_key='fixture:' + action, workspace_id=None if action == 'create' else WORKSPACE, template_version_id=VERSION,
                   parameters_json=environment.canonical(params), parameters_sha256=environment.digest(params), policy_sha256=environment.digest(self.policy), confirmation_json='{}', confirmation_deadline_ms=int(time.time() * 1000) + 60000, deadline_ms=int(time.time() * 1000) + 180000, state='submitting', created_at='fixture-now', updated_at='fixture-now')
        with sqlite3.connect(self.root / 'bindings.sqlite') as db:
            db.execute('INSERT INTO environment_requests(' + ','.join(row) + ') VALUES(' + ','.join('?' for key in row) + ')', list(row.values()))
        return request_id

    def test_create_exact_user_endpoint_fixed_payload_and_durable_single_attempt(self):
        request_id = self.row()
        result = environment.submit(self.broker, self.root, request_id)
        self.assertEqual(result['outcome'], 'accepted')
        self.assertFalse(result['ready'])
        self.assertEqual([call for call in self.lab.calls if call[0] == 'POST'], [('POST', '/api/v2/users/' + OWNER + '/workspaces', {'name': 'fixture-owned', 'template_version_id': VERSION, 'rich_parameter_values': self.policy['templates'][0]['parameters'], 'automatic_updates': 'never'})])
        with self.assertRaisesRegex(ValueError, 'ATTEMPTED'):
            environment.submit(self.broker, self.root, request_id)
        self.assertEqual(len([call for call in self.lab.calls if call[0] == 'POST']), 1)
        self.assertIsNotNone(environment.request_row(self.root, request_id)['attempted_at'])

    def test_start_stop_exact_transition_endpoint_no_delete_or_hidden_fields(self):
        for action in ['start', 'stop']:
            with self.subTest(action=action):
                self.setUp()
                self.lab.workspace['latest_build']['status'] = 'stopped' if action == 'start' else 'running'
                request_id = self.row(action)
                self.assertEqual(environment.submit(self.broker, self.root, request_id)['outcome'], 'accepted')
                post = [call for call in self.lab.calls if call[0] == 'POST'][0]
                self.assertEqual(post[1], '/api/v2/workspaces/' + WORKSPACE + '/builds')
                self.assertEqual(post[2]['transition'], action)
                self.assertEqual(set(post[2]), {'transition', 'template_version_id', 'rich_parameter_values'} if action == 'start' else {'transition', 'template_version_id'})

    def test_readonly_owner_and_platform_state_race_reject_before_post(self):
        for failure in ['readonly', 'wrong-owner', 'state-race']:
            with self.subTest(failure=failure):
                self.setUp()
                request_id = self.row('stop')
                if failure == 'readonly':
                    self.policy.update(read_only=True, actions=[])
                    self.save_policy()
                elif failure == 'wrong-owner':
                    self.lab.behavior = 'wrong-owner'
                else:
                    self.lab.workspace['latest_build']['status'] = 'stopped'
                with self.assertRaises(ValueError):
                    environment.submit(self.broker, self.root, request_id)
                self.assertEqual([call for call in self.lab.calls if call[0] == 'POST'], [])
                self.assertIsNone(environment.request_row(self.root, request_id)['attempted_at'])

    def test_response_loss_is_unknown_without_replay(self):
        request_id = self.row()
        self.lab.behavior = 'response-lost'
        self.assertEqual(environment.submit(self.broker, self.root, request_id)['outcome'], 'unknown')
        with self.assertRaises(ValueError):
            environment.submit(self.broker, self.root, request_id)
        self.assertEqual(len([call for call in self.lab.calls if call[0] == 'POST']), 1)

    def test_poll_uses_original_build_read_only_and_checks_current_identity(self):
        request_id = self.row()
        environment.submit(self.broker, self.root, request_id)
        with sqlite3.connect(self.root / 'bindings.sqlite') as db:
            db.execute("UPDATE environment_requests SET state='accepted',build_id=?,submitted_workspace_id=? WHERE request_id=?", (BUILD, WORKSPACE, request_id))
        self.lab.calls.clear()
        result = environment.poll(self.broker, self.root, request_id)
        self.assertTrue(result['current_build'])
        self.assertTrue(result['workspace']['database_consistent'])
        self.assertEqual(result['workspace']['identity']['generation'], UID('a'))
        self.assertTrue(all(call[0] == 'GET' for call in self.lab.calls))
        self.assertIn(('GET', '/api/v2/workspacebuilds/' + BUILD, None), self.lab.calls)


if __name__ == '__main__':
    unittest.main(verbosity=2)
