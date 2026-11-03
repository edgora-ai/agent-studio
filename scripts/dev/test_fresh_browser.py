"""Guardrail regressions ONLY. These tests are not live model/CLI evidence."""
import ast
import base64
import importlib.util
import json
from pathlib import Path
import secrets
import shlex
import subprocess
import unittest
from unittest import mock

FILE = Path(__file__).resolve().with_name('fresh-browser.py')
spec = importlib.util.spec_from_file_location('fresh_browser', FILE)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class Request:
    def __init__(self, url='http://127.0.0.1:4123/api/skills/list', body=None, method='POST'):
        self.url = url
        self.method = method
        self.post_data_json = body
        self.post_data_buffer = json.dumps(body).encode() if body else None

    def all_headers(self):
        return {'cookie': 'DO_NOT_FORWARD', 'host': 'bad-host', 'content-type': 'application/json'}


class Response:
    def __init__(self, status=200, headers=None, body=None):
        self.status = status
        self.headers = headers or {'content-type': 'application/json'}
        self.body = body or {'ok': True}
        self.disposed = False

    def json(self):
        return self.body

    def dispose(self):
        self.disposed = True


class Route:
    def __init__(self, request):
        self.request = request
        self.fulfilled = None
        self.aborted = None

    def fulfill(self, response):
        self.fulfilled = response

    def abort(self, error):
        self.aborted = error


def guard_report():
    return {'decode_errors': [], 'redirects': [], 'network_guard_errors': []}


class OriginTests(unittest.TestCase):
    def test_exact_origin_not_prefix_or_host_wildcard(self):
        self.assertEqual(probe.origin_of('wss://Example.org:443/api/$stream'), 'https://example.org')
        self.assertNotEqual(probe.origin_of('https://example.org.evil.test/x'), 'https://example.org')
        self.assertNotEqual(probe.origin_of('http://127.0.0.1:4124'), 'http://127.0.0.1:4123')
        for value in ['http://user:pass@example.org/', 'file:///tmp/x', 'javascript:alert(1)']:
            with self.assertRaises((AssertionError, ValueError)):
                probe.origin_of(value)
        with self.assertRaisesRegex(AssertionError, 'PROTECTED_GUI'):
            probe.checked_origin('http://10.147.18.50:3080')

    def test_redirect_to_another_allowed_origin_is_still_blocked(self):
        allowed = {'https://example.org', 'https://coder.example.org'}
        self.assertEqual(probe.redirect_target('https://example.org/a?token=secret', '/clean', allowed), 'https://example.org/clean')
        for target in ['https://coder.example.org/', '//evil.test/', 'https://example.org.evil.test/', 'file:///tmp/x']:
            with self.assertRaises(AssertionError):
                probe.redirect_target('https://example.org/a', target, allowed)

    def test_redirect_method_rules(self):
        self.assertEqual(probe.redirect_request(303, 'POST', b'x'), ('GET', None))
        self.assertEqual(probe.redirect_request(302, 'POST', b'x'), ('GET', None))
        self.assertEqual(probe.redirect_request(307, 'POST', b'x'), ('POST', b'x'))
        self.assertEqual(probe.redirect_request(308, 'PUT', b'x'), ('PUT', b'x'))

    def test_proxy_fetches_redirects_without_uncontrolled_continuation(self):
        first = Response(302, {'location': '/clean'})
        final = Response()
        api = mock.Mock()
        api.fetch.side_effect = [first, final]
        context = mock.Mock(request=api)
        report = guard_report()
        guard = probe.ExactOriginProxy(context, {'http://127.0.0.1:4123'}, probe.Ledger(), report)
        route = Route(Request(method='GET'))
        guard.route(route)
        self.assertIs(route.fulfilled, final)
        self.assertIsNone(route.aborted)
        self.assertEqual(api.fetch.call_count, 2)
        for call in api.fetch.call_args_list:
            self.assertEqual(call.kwargs['max_redirects'], 0)
            self.assertNotIn('cookie', call.kwargs['headers'])
            self.assertNotIn('host', call.kwargs['headers'])
        self.assertEqual(report['network_guard_errors'], [])
        self.assertTrue(first.disposed and final.disposed)

    def test_proxy_does_not_fetch_redirect_destination_when_cross_origin(self):
        api = mock.Mock()
        api.fetch.return_value = Response(302, {'location': 'https://evil.test/?token=private'})
        report = guard_report()
        guard = probe.ExactOriginProxy(mock.Mock(request=api), {'http://127.0.0.1:4123'}, probe.Ledger(), report)
        route = Route(Request(method='GET'))
        guard.route(route)
        self.assertEqual(api.fetch.call_count, 1)
        self.assertEqual(route.aborted, 'blockedbyclient')
        self.assertEqual(report['network_guard_errors'][0]['error'], 'CROSS_ORIGIN_REDIRECT_BLOCKED')

    def test_proxy_never_fetches_unapproved_initial_origin(self):
        context = mock.Mock()
        report = guard_report()
        guard = probe.ExactOriginProxy(context, {'http://127.0.0.1:4123'}, probe.Ledger(), report)
        route = Route(Request(url='http://127.0.0.1:41230/'))
        guard.route(route)
        context.request.fetch.assert_not_called()
        self.assertEqual(route.aborted, 'blockedbyclient')


class RejectionTests(unittest.TestCase):
    def test_native_rejection_records_id_type_code(self):
        ledger = probe.Ledger()
        request = Request(body={'type': 'client-request', 'rpcId': 'request-1', 'method': 'skills/list'})
        entry = ledger.begin(request)
        ledger.finish(entry, 200, {'rpcId': 'request-1', 'result': {'ok': False, 'error': {'code': 'agent-studio/disabled'}}})
        self.assertEqual(entry['rejection_identity'], {'id': 'request-1', 'type': 'client-request', 'method': 'skills/list', 'code': 'agent-studio/disabled'})
        self.assertEqual(ledger.unexpected(), [])

    def test_path_alone_never_exempts_wrong_code_method_type(self):
        for body, code in [
            ({'type': 'client-request', 'rpcId': 'req-2', 'method': 'skills/list'}, 'different-code'),
            ({'type': 'client-request', 'rpcId': 'req-2', 'method': 'session/prompt'}, 'agent-studio/disabled'),
            ({'type': 'not-client-request', 'rpcId': 'req-2', 'method': 'skills/list'}, 'agent-studio/disabled'),
        ]:
            ledger = probe.Ledger()
            entry = ledger.begin(Request(body=body))
            ledger.finish(entry, 200, {'result': {'ok': False, 'error': {'code': code}}})
            self.assertEqual(ledger.unexpected(), [entry])

    def test_explicit_rejection_does_not_exempt_other_request(self):
        ledger = probe.Ledger()
        ledger.expect('expected-id', 'client-request', 'fs.read', 'path-outside-binding')
        for request_id, expected in [('expected-id', True), ('other-id', False)]:
            entry = ledger.begin(Request(body={'type': 'client-request', 'rpcId': request_id, 'method': 'fs.read'}))
            ledger.finish(entry, 200, {'rpcId': request_id, 'result': {'ok': False, 'error': {'code': 'path-outside-binding'}}})
            self.assertEqual(entry['expected_rejection'], expected)

    def test_response_cannot_have_another_request_id(self):
        ledger = probe.Ledger()
        entry = ledger.begin(Request(body={'type': 'client-request', 'rpcId': 'correct', 'method': 'fs.read'}))
        with self.assertRaisesRegex(AssertionError, 'RPC_RESPONSE_ID_MISMATCH'):
            ledger.finish(entry, 200, {'rpcId': 'other', 'result': {'ok': True}})

    def test_sidebar_rejection_gets_separate_observer_id_and_exact_code(self):
        ledger = probe.Ledger()
        entry = ledger.begin(Request(url='http://127.0.0.1:4123/sidebar/api/changes.ops', body={'sessionId': 'session'}))
        ledger.finish(entry, 409, {'ok': False, 'error': {'code': 'agent-studio/provider-unavailable'}})
        self.assertIsNone(entry['request_id'])
        self.assertEqual(entry['rejection_identity']['id'], entry['observer_id'])
        self.assertEqual(entry['rejection_identity']['type'], 'sidebar-http')
        self.assertEqual(ledger.unexpected(), [])


class SanitizerTests(unittest.TestCase):
    def test_auth_query_cookie_and_known_secret_never_survive(self):
        sanitizer = probe.Sanitizer(['unique-private-secret-123'])
        data = {'text': 'Error at http://host:123/a?token=unknown-value#fragment and unique-private-secret-123\nCookie: private-cookie',
                'token': 'keep-me-out', 'nested': ['https://user:password@host/path?q=secret'], 'nonce': 'public-nonce'}
        encoded = json.dumps(sanitizer.clean(data))
        for value in ['unknown-value', 'unique-private-secret-123', 'private-cookie', 'keep-me-out', 'password', 'fragment', '?q=']:
            self.assertNotIn(value, encoded)
        self.assertIn('public-nonce', encoded)
        self.assertIn('http://host:123/a', encoded)


class NonceTests(unittest.TestCase):
    def test_terminal_echo_cannot_prove_output(self):
        command = probe.single_line_python(probe.terminal_program('scratch.json'))
        self.assertNotIn('\n', command)
        self.assertNotIn('\r', command)
        self.assertIsNone(probe.terminal_nonce(command + '\n'))
        self.assertIsNone(probe.terminal_nonce('FRESH_TERMINAL_PROOF nonce\n'))
        nonce = 'a' * 48
        self.assertEqual(probe.terminal_nonce('\r\nFRESH_TERMINAL_PROOF ' + nonce + '\r\n'), nonce)

    def test_local_program_generates_unpredictable_proof_only_after_execution(self):
        # This is a local command-construction test, NOT a live remote check.
        directory = probe.OUT / ('unit-command-' + secrets.token_hex(6))
        directory.mkdir(parents=True, exist_ok=False)
        self.assertTrue(directory.resolve().is_relative_to(probe.OUT))
        command = probe.single_line_python(probe.terminal_program('local-test-only.json'))
        self.assertFalse((directory / 'local-test-only.json').exists())
        result = subprocess.run(shlex.split(command), cwd=directory, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0)
        nonce = probe.terminal_nonce(result.stdout)
        self.assertIsNotNone(nonce)
        self.assertNotIn(nonce, command)
        value = json.loads((directory / 'local-test-only.json').read_text())
        self.assertEqual(value['nonce'], nonce)
        self.assertEqual(value['cwd'], str(directory))
        self.assertEqual(result.stderr, '')

    def test_relative_path_bounds(self):
        for value in ['../x', '/tmp/x', 'a//b', 'a/./b', 'a/../b', 'a\\b', '', 'a\0b']:
            with self.assertRaises(AssertionError):
                probe.safe_relative(value)
        self.assertEqual(probe.safe_relative('dir/test.py'), 'dir/test.py')


class LifecycleTests(unittest.TestCase):
    def test_no_network_before_live_ready(self):
        with mock.patch.object(probe, 'read_json') as read:
            with self.assertRaisesRegex(AssertionError, 'WAIT_FOR_LEAD_LIVE_READY'):
                probe.load_inputs(probe.FRESH / 'dsh', probe.OUT / 'unit', False)
            read.assert_not_called()

    def test_old_root_and_external_output_are_refused_before_read(self):
        with mock.patch.object(probe, 'read_json') as read:
            for root, out in [(probe.REPO / '.preview/agent-studio', probe.OUT / 'unit'),
                              (probe.FRESH / 'dsh', probe.REPO / 'outside-scope')]:
                with self.assertRaises(AssertionError):
                    probe.load_inputs(root, out, True)
            read.assert_not_called()

    def test_source_has_no_implicit_http_redirects_or_outside_cleanup(self):
        tree = ast.parse(FILE.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                self.assertNotEqual(node.func.attr, 'continue_')
                if node.func.attr in {'fetch', 'post'}:
                    self.assertTrue(any(item.arg == 'max_redirects' and isinstance(item.value, ast.Constant)
                                        and item.value.value == 0 for item in node.keywords))
        run = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == 'run')
        lifetime = next(node for node in run.body if isinstance(node, ast.With))
        cleanup = next(node for node in lifetime.body if isinstance(node, ast.Try))
        self.assertTrue(cleanup.finalbody)
        close_calls = [node for node in ast.walk(ast.Module(body=cleanup.finalbody, type_ignores=[]))
                       if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'close']
        self.assertGreaterEqual(len(close_calls), 2)


if __name__ == '__main__':
    unittest.main()
