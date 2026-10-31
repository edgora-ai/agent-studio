"""Offline fixed-observer tests; observes only this test's process, never Coder."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[2] / 'packages/dsh-agent-studio/adapters/task-observe.py'
spec = importlib.util.spec_from_file_location('owned_task_observer', SOURCE)
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class ObserverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='agent-studio-test-d08-probe-')
        self.root = Path(self.temp.name)
        self.cwd = os.getcwd()
        os.chdir(self.root)
        owner = {'binding_id': 'offline-binding', 'version': 1, 'principal_id': 'offline-owner', 'generation': 'offline-generation'}
        (self.root / '.agent-studio-binding.json').write_text(json.dumps(owner))
        self.expected = {'root': str(self.root), 'cwd': str(self.root), 'owner': owner, 'pid': os.getpid(), 'uid': os.getuid()}

    def tearDown(self):
        os.chdir(self.cwd)
        self.temp.cleanup()

    def test_exact_owned_process_identity_from_proc(self):
        actual = observer.observe(self.expected)
        stat = Path('/proc/self/stat').read_text().rsplit(') ', 1)[1].split()
        self.assertEqual(actual['pid'], os.getpid())
        self.assertEqual(actual['start_ticks'], stat[19])
        self.assertEqual(actual['uid'], os.getuid())
        self.assertEqual(actual['pgid'], os.getpgrp())
        self.assertEqual(actual['sid'], os.getsid(0))
        self.assertEqual(actual['cwd'], str(self.root))

    def test_binding_marker_mismatch_is_not_current_identity(self):
        self.expected['owner'] = {**self.expected['owner'], 'generation': 'wrong'}
        with self.assertRaisesRegex(ValueError, 'D08_ROOT_IDENTITY'):
            observer.observe(self.expected)

    def test_uid_and_cwd_mismatch_refuse(self):
        with self.assertRaisesRegex(ValueError, 'D08_PROCESS_SCOPE'):
            observer.observe({**self.expected, 'uid': os.getuid() + 1})
        with self.assertRaisesRegex(ValueError, 'D08_PROCESS_CWD'):
            observer.observe({**self.expected, 'cwd': str(self.root / 'other')})

    def test_absence_does_not_report_exit_or_cancellation(self):
        actual = observer.observe({**self.expected, 'pid': 2147483647})
        self.assertEqual(actual, {'exists': False, 'pid': 2147483647})


if __name__ == '__main__':
    unittest.main(verbosity=2)
