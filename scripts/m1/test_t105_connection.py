"""Offline T-105 guard tests. Real SSH/helper cases are t105_connection.py run."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

SCRIPTS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('t105', SCRIPTS / 't105_connection.py')
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)


def sample():
    marker = {'generation': 'fixed-fixture', 'root': '/workspace'}
    expected = {'marker': marker, 'name': 'm1-a', 'workspaceId': 'workspace-fixture', 'agentName': 'main',
                'owner': 'lab-owner', 'expectedUid': 1000, 'expectedUser': 'coder', 'root': '/workspace'}
    observed = {'marker': copy.deepcopy(marker), 'uid': 1000, 'user': 'coder', 'root': '/workspace',
                'channel': {'CODER_WORKSPACE_ID': 'workspace-fixture', 'CODER_WORKSPACE_NAME': 'm1-a',
                            'CODER_WORKSPACE_AGENT_NAME': 'main', 'CODER_WORKSPACE_OWNER_NAME': 'lab-owner'}}
    return expected, observed


class T105Tests(unittest.TestCase):
    def test_full_current_channel_observation(self):
        self.assertTrue(all(t.compare_observation(*sample()).values()))

    def test_each_observation_field_is_enforced(self):
        for field, value in [('marker', {}), ('uid', 0), ('user', 'root'), ('root', '/tmp')]:
            with self.subTest(field=field):
                e, o = sample(); o[field] = value
                self.assertFalse(all(t.compare_observation(e, o).values()))
        for key in sample()[1]['channel']:
            with self.subTest(channel=key):
                e, o = sample(); o['channel'][key] = 'different'
                self.assertFalse(all(t.compare_observation(e, o).values()))

    def test_missing_channel_fails_closed(self):
        e, o = sample(); del o['channel']
        with self.assertRaises(KeyError):
            t.compare_observation(e, o)

    def test_uid_boolean_not_integer(self):
        e, o = sample(); e['expectedUid'] = 1; o['uid'] = True
        self.assertFalse(t.compare_observation(e, o)['uid'])

    def test_stale_marker_not_a_valid_channel(self):
        e, o = sample(); e['marker']['generation'] = 'previous'
        self.assertFalse(t.compare_observation(e, o)['marker'])

    def test_environment_does_not_inherit_credentials(self):
        os.environ['T105_TEST_SECRET'] = 'offline-only'
        try:
            self.assertNotIn('T105_TEST_SECRET', t.clean_env())
            self.assertEqual(set(t.clean_env()), {'PATH', 'LANG'})
        finally:
            del os.environ['T105_TEST_SECRET']

    def test_ssh_config_strict_no_global_writes(self):
        with tempfile.TemporaryDirectory(prefix='t105-offline-') as directory:
            run = Path(directory)
            conf, alias = t.configure(run, sample()[0])
            text = Path(conf['sshConfig']).read_text()
            for value in ('StrictHostKeyChecking yes', 'ControlMaster no', 'ForwardAgent no', 'IdentityAgent none'):
                self.assertIn(value, text)
            self.assertNotIn('StrictHostKeyChecking no', text)
            self.assertIn(str(run / 'known_hosts'), text)
            self.assertEqual(json.loads((run / 'connection.json').read_text()), conf)
            self.assertEqual(alias, 't105.m1-a')

    def test_unknown_ssh_shape_rejected_before_subprocess(self):
        with tempfile.TemporaryDirectory(prefix='t105-offline-') as directory:
            run = Path(directory); t.configure(run, sample()[0])
            with self.assertRaisesRegex(ValueError, 'UNREVIEWED_SSH_ARGUMENTS'):
                t.gated_ssh(str(run / 'connection.json'), ['-L', 'unauthorized-forward'])

    def test_preflight_timeout_and_eof(self):
        read, write = os.pipe()
        try:
            with self.assertRaises(TimeoutError):
                t.read_line(read, timeout=0.01)
            os.close(write); write = None
            with self.assertRaisesRegex(RuntimeError, 'TRANSPORT_CLOSED'):
                t.read_line(read, timeout=0.1)
        finally:
            os.close(read)
            if write is not None:
                os.close(write)

    def test_preflight_read_leaves_rpc_bytes_untouched(self):
        read, write = os.pipe()
        try:
            os.write(write, b'{"probe":1}\nRPC-PAYLOAD')
            self.assertEqual(t.read_line(read), b'{"probe":1}\n')
            self.assertEqual(os.read(read, 11), b'RPC-PAYLOAD')
        finally:
            os.close(read); os.close(write)

    def test_preflight_output_bounded(self):
        read, write = os.pipe()
        def writer():
            try:
                os.write(write, b'x' * 16385)
            except BrokenPipeError:
                return  # Reader explicitly rejected and closed the bounded frame.
            finally:
                os.close(write)
        thread = threading.Thread(target=writer); thread.start()
        try:
            with self.assertRaisesRegex(ValueError, 'OUTPUT_LIMIT'):
                t.read_line(read)
        finally:
            os.close(read); thread.join(timeout=2)
        self.assertFalse(thread.is_alive())

    def test_remote_gate_eof_ack_never_dispatches(self):
        # Explicit offline protocol seam, NOT a provider or remote identity proof.
        code = "import importlib.util,sys,json,base64; s=importlib.util.spec_from_file_location('g',sys.argv[1]);g=importlib.util.module_from_spec(s);s.loader.exec_module(g);g.observation=lambda root: {'offline':True};sys.argv=['gate',base64.b64encode(json.dumps({'mode':'probe','root':'/workspace'}).encode()).decode()];g.main()"
        result = subprocess.run(['python3', '-I', '-c', code, str(SCRIPTS / 't105_remote_gate.py')],
                                input='', capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 78)
        self.assertNotIn('identityAccepted', result.stdout)


if __name__ == '__main__':
    unittest.main(verbosity=2)
