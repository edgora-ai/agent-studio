"""Offline negative tests for the experimental template/identity boundary."""
import copy
import importlib.util
from pathlib import Path
import json
import tempfile
import unittest
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location('coder_template', Path(__file__).with_name('coder_template.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CoderContractTests(unittest.TestCase):
    def setUp(self):
        self.template = str(uuid.uuid4())
        self.version = str(uuid.uuid4())
        self.allowed = {self.version: {'templateId': self.template, 'revoked': False, 'name': 'older-approved'}}
        self.record = {
            'schemaVersion': 1, 'workspaceId': str(uuid.uuid4()),
            'agentResourceId': str(uuid.uuid4()), 'generation': str(uuid.uuid4()),
            'templateVersion': 'lab-v3', 'imageId': 'sha256:' + 'a' * 64,
            'root': '/workspace', 'uid': 1000, 'policyVersion': 'lab-v1',
        }

    def test_approved_older_version(self):
        result = module.validate_request(self.template, self.version, '/workspace', self.allowed)
        self.assertEqual(result['name'], 'older-approved')

    def test_unknown_version(self):
        with self.assertRaises(ValueError):
            module.validate_request(self.template, str(uuid.uuid4()), '/workspace', self.allowed)

    def test_revoked_version(self):
        self.allowed[self.version]['revoked'] = True
        with self.assertRaises(ValueError):
            module.validate_request(self.template, self.version, '/workspace', self.allowed)

    def test_wrong_template(self):
        with self.assertRaises(ValueError):
            module.validate_request(str(uuid.uuid4()), self.version, '/workspace', self.allowed)

    def test_root_boundaries(self):
        for root in ('/', '/workspace/../etc', '/workspace-two', 'workspace', '/workspace/sub', '/workspace/'):
            with self.subTest(root=root), self.assertRaises(ValueError):
                module.validate_request(self.template, self.version, root, self.allowed)

    def test_malformed_allowlist_fails_closed(self):
        for value in ({'templateId': self.template}, {'templateId': self.template, 'revoked': 'false'}, []):
            with self.subTest(value=value), self.assertRaises(ValueError):
                module.validate_request(self.template, self.version, '/workspace', {self.version: value})

    def test_complete_record_roundtrip(self):
        value = module.validate_record(copy.deepcopy(self.record), self.record)
        self.assertEqual(value, self.record)
        self.assertIsNot(value, self.record)

    def test_each_identity_mismatch_rejected(self):
        for key in self.record:
            changed = {**self.record, key: 'different'}
            with self.subTest(field=key), self.assertRaises(ValueError):
                module.validate_record(changed, self.record)

    def test_missing_and_extra_fields_rejected(self):
        for changed in ({}, {**self.record, 'clientAuthorized': True}):
            with self.subTest(record=changed), self.assertRaises(ValueError):
                module.validate_record(changed, changed)

    def test_invalid_uuid_rejected(self):
        changed = {**self.record, 'generation': 'not-a-uuid'}
        with self.assertRaises(ValueError):
            module.validate_record(changed, changed)

    def test_booleans_and_float_integers_rejected(self):
        for key, value in (('schemaVersion', True), ('uid', 1000.0)):
            changed = {**self.record, key: value}
            with self.subTest(field=key), self.assertRaises(ValueError):
                module.validate_record(changed, changed)

    def test_create_pins_version_and_skips_existing_owned_workspaces(self):
        config = {'templateId': self.template, 'templateVersionId': self.version}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'allowlist.json').write_text(json.dumps(self.allowed))
            with patch.object(module.lab, 'OUTPUT', root), patch.object(module.lab, 'PRIVATE', root), \
                 patch.object(module.lab, 'state', return_value=config), \
                 patch.object(module, 'workspaces', return_value=[]), \
                 patch.object(module.lab, 'cli', return_value='fixture') as cli, \
                 patch('builtins.print'):
                module.create()
                self.assertEqual([call.args[0] for call in cli.call_args_list], [
                    ['create', name, '--template', module.TEMPLATE, '--template-version', module.VERSION, '--yes']
                    for name in module.WORKSPACES
                ])
                cli.reset_mock()
                existing = [{'name': name, 'template_id': self.template} for name in module.WORKSPACES]
                with patch.object(module, 'workspaces', return_value=existing):
                    module.create()
                cli.assert_not_called()

    def test_mutable_image_tag_rejected(self):
        changed = {**self.record, 'imageId': 'workspace:latest'}
        with self.assertRaises(ValueError):
            module.validate_record(changed, changed)


if __name__ == '__main__':
    unittest.main()
