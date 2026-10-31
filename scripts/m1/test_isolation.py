"""Offline regressions: synthetic peer links, fail-closed launch policy, and stubbed network APIs."""
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
import uuid

sys.dont_write_bytecode = True
SCRIPT_ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('t103_runner', SCRIPT_ROOT / 'run_candidate.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
ROOT = Path(tempfile.mkdtemp(prefix='regression-', dir=runner.PROJECT_ROOT / 'artifacts/m1/t103'))
NODE = shutil.which('node')
if NODE is None:
    raise SystemExit('Existing node is required; nothing will be installed')
OBSERVATIONS = {}


class IsolationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = ROOT / 'runtime'
        cls.candidate = cls.runtime / 'node_modules/dsh-ssh-remote'
        cls.installed = ROOT / 'installed-sdk'
        cls.peer = cls.installed / 'node_modules/@deepseek-ai/cordis'
        cls.candidate.mkdir(parents=True)
        cls.peer.mkdir(parents=True)
        (cls.candidate / 'package.json').write_text(json.dumps({
            'name': 'dsh-ssh-remote', 'version': '0.13.3',
            'peerDependencies': {'@deepseek-ai/cordis': '^4.0.1'}}))
        (cls.peer / 'package.json').write_text('{"name":"@deepseek-ai/cordis","version":"4.0.5"}\n')
        alias = cls.runtime / 'node_modules/@deepseek-ai/cordis'
        alias.parent.mkdir()
        alias.symlink_to(cls.peer, target_is_directory=True)

    def launch(self, broad=False, extra_write=False, extra_env=False, existing=False, entry='isolation.mjs'):
        root = self.runtime / f'run-{uuid.uuid4().hex}'
        if existing:
            root.symlink_to(self.peer, target_is_directory=True)
        command = runner.node_command(NODE, self.candidate, self.installed, root, entry,
                                      [self.candidate, self.installed, root])
        if broad:
            command[5] = f'--allow-fs-write={self.runtime}'
        if extra_write:
            command.insert(6, f'--allow-fs-write={self.runtime / "node_modules/@deepseek-ai/cordis"}')
        env = runner.clean_environment(NODE, root)
        if extra_env:
            env['T103_FAKE_INHERITED_VARIABLE'] = 'synthetic-test-value'
        result = runner.bounded_process(command, env, 30)
        self.assertFalse(result['timedOut'])
        return root, result

    def test_narrow_grant_denies_direct_and_alias_writes(self):
        root, result = self.launch()
        self.assertEqual(result['exitCode'], 0, result['stderr'])
        proof = json.loads(result['stdout'])
        self.assertEqual(proof['candidateWriteDenied'], 'ERR_ACCESS_DENIED')
        self.assertEqual(proof['peerWriteDenials'], [{'name': '@deepseek-ai/cordis',
                          'direct': 'ERR_ACCESS_DENIED', 'alias': 'ERR_ACCESS_DENIED'}])
        self.assertTrue((root / 'home').is_dir())
        OBSERVATIONS['narrowWritePreflight'] = proof

    def test_old_broad_grant_rejected_before_profile_load(self):
        root, result = self.launch(broad=True, entry='profile_candidate.mjs')
        self.assertNotEqual(result['exitCode'], 0)
        self.assertIn('T103_UNSAFE_WRITE_GRANT', result['stderr'])
        self.assertFalse(root.exists())
        OBSERVATIONS['broadGrantRejectedBeforeCandidateLoad'] = True

    def test_extra_alias_grant_rejected(self):
        root, result = self.launch(extra_write=True)
        self.assertNotEqual(result['exitCode'], 0)
        self.assertIn('T103_UNSAFE_WRITE_GRANT', result['stderr'])
        self.assertFalse(root.exists())

    def test_existing_symlink_root_rejected(self):
        _, result = self.launch(existing=True)
        self.assertNotEqual(result['exitCode'], 0)
        self.assertIn('T103_RUN_ROOT_EXISTS', result['stderr'])
        self.assertEqual((self.peer / 'package.json').read_text(), '{"name":"@deepseek-ai/cordis","version":"4.0.5"}\n')

    def test_inherited_environment_rejected(self):
        root, result = self.launch(extra_env=True)
        self.assertNotEqual(result['exitCode'], 0)
        self.assertIn('T103_INHERITED_ENVIRONMENT', result['stderr'])
        self.assertFalse(root.exists())

    def test_clean_environment_does_not_copy_parent(self):
        env = runner.clean_environment(NODE, ROOT / 'unused-run')
        self.assertEqual(set(env), runner.ENVIRONMENT_KEYS)
        for key in ('NODE_OPTIONS', 'SSH_AUTH_SOCK', 'HTTP_PROXY', 'HTTPS_PROXY', 'NPM_CONFIG_USERCONFIG'):
            self.assertNotIn(key, env)

    def test_timeout_kills_offline_process(self):
        result = runner.bounded_process([NODE, '-e', 'setInterval(() => {}, 1000)'],
                                       runner.clean_environment(NODE, ROOT / 'timeout'), 0.25)
        self.assertTrue(result['timedOut'])
        self.assertLess(result['exitCode'], 0)
        OBSERVATIONS['deadlineEnforced'] = {key: result[key] for key in ('timedOut', 'exitCode', 'durationSeconds')}
        for timeout in (0, 601):
            with self.assertRaises(ValueError):
                runner.bounded_process([], {}, timeout)

    def test_network_apis_offline(self):
        result = runner.bounded_process([NODE, str(SCRIPT_ROOT / 'test_network_guard.mjs')],
                                       runner.clean_environment(NODE, ROOT / 'network-test'), 30)
        self.assertFalse(result['timedOut'])
        self.assertEqual(result['exitCode'], 0, result['stderr'])
        OBSERVATIONS['networkGuard'] = json.loads(result['stdout'])
        self.assertTrue(OBSERVATIONS['networkGuard']['passed'])
        self.assertEqual(OBSERVATIONS['networkGuard']['sentinelCalls'], 0)


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(IsolationTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    report = {'task': 'T-103', 'kind': 'offline-isolation-regression', 'passed': result.wasSuccessful(),
              'testsRun': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors),
              'candidateCodeExecuted': False, 'realNetworkUsed': False, 'observations': OBSERVATIONS}
    runner.write_json_new(ROOT / 'regression-result.json', report)
    print('REGRESSION_REPORT', ROOT / 'regression-result.json')
    if not result.wasSuccessful():
        raise SystemExit(1)
    print(f'PASS: {result.testsRun} offline regressions; {OBSERVATIONS["networkGuard"]["guardedCalls"]} guarded API calls; no real network')
