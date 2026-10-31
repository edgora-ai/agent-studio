"""Run T-106 through unchanged T-105 Coder/OpenSSH/current-identity ACK gates.

Creates only a fresh ignored central run, a random /workspace/t106-<24 hex>
root on m1-a via the provider, and that connection's helper HOME. m1-b and
central synthetic canaries are observed, not used to execute success workloads.
Docker is an independent observer and the accepted authenticated helper teardown.
Only one pinned private rg test dependency; no system installation or workspace/
service lifecycle changes, retry, recovery or data deletion.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts/m1'
spec = importlib.util.spec_from_file_location('t106_connection', SCRIPTS / 't105_connection.py')
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)
tool_spec = importlib.util.spec_from_file_location('t106_tools', SCRIPTS / 't106_tools.py')
tools = importlib.util.module_from_spec(tool_spec)
tool_spec.loader.exec_module(tools)
OUTPUT = ROOT / 'artifacts/m1/t106'


def save(path, value):
    t.save(path, value)


def publish_response(path, value):
    """Publish only complete, fsynced JSON; never overwrite an earlier receipt.

    The same-directory hard link is an atomic, create-if-absent publication.
    Readers of the final name cannot observe serialization of the private inode.
    """
    temporary = path.with_name('.' + path.name + '.' + secrets.token_hex(8) + '.pending')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.link(temporary, path, follow_symlinks=False)
    finally:
        temporary.unlink()  # Only this call's exclusively created scratch inode.
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)


def stage_tool(run):
    dependency, verified_bytes = tools.ensure_tool(with_bytes=True)
    (run / 'dependency').mkdir(mode=0o700)
    # Never reopen dependency['binary'] after verification: the bytes returned by
    # the descriptor-based verifier are the bytes staged for the helper upload.
    with (run / 'dependency/rg').open('xb') as handle:
        handle.write(verified_bytes)
        handle.flush()
        os.fsync(handle.fileno())
    assert (run / 'dependency/rg').read_bytes() == verified_bytes
    assert t.digest(run / 'dependency/rg') == dependency['binarySha256']
    return dependency


def source_fingerprints():
    paths = sorted(SCRIPTS.glob('t106_*'))
    return {str(p.relative_to(ROOT)): t.digest(p) for p in paths if p.is_file()}


def trusted_sources():
    path = ROOT / 'docs/implementation/evidence/t105-independent-acceptance-pass1.json'
    accepted = json.loads(path.read_text())
    checks = {p: t.digest(ROOT / p) == digest for p, digest in accepted['sourceSha256'].items()}
    if not all(checks.values()):
        raise ValueError('T106_T105_SOURCE_CHANGED')
    # The deployed asset embeds two extension modules. The bare .py source is
    # intentionally NOT the 217238-byte bundle accepted by T-105.
    module = (t.CANDIDATE / 'lib/helper/installer.js').as_uri()
    script = ('import {loadHelperAsset} from ' + json.dumps(module) + ';'
              'const a=loadHelperAsset();console.log(JSON.stringify({sha256:a.sha256,bytes:a.content.length}));')
    built = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT,
                           env=t.clean_env(), capture_output=True, text=True, timeout=10)
    if built.returncode:
        raise ValueError('T106_HELPER_BUNDLE_LOAD_FAILED')
    bundle = json.loads(built.stdout)
    if bundle != {'sha256': t.HELPER_SHA, 'bytes': 217238}:
        raise ValueError('T106_HELPER_ASSET_CHANGED')
    return {'evidenceSha256': t.digest(path), 'sourceMatches': checks, 'helperBundle': bundle}


def central_snapshot(run):
    values = []
    for path in sorted((run / 'workspace').rglob('*')):
        if path.is_symlink() or not path.is_file():
            raise ValueError('T106_CENTRAL_CANARY_CHANGED_TYPE')
        values.append({'path': str(path.relative_to(run / 'workspace')), 'bytes': path.stat().st_size, 'sha256': t.digest(path)})
    return values


def observer(container, token, home, request):
    code = (SCRIPTS / 't106_observe.py').read_text()
    output = t.lab.execute(['docker', 'exec', container, 'python3', '-I', '-c', code,
                            token, home, json.dumps(request)], timeout=16)
    return json.loads(output)


def node_command(run, alias):
    return ['node', '--permission', '--allow-child-process',
            *['--allow-fs-read=' + str(p) for p in (SCRIPTS, t.CANDIDATE.parent.parent, t.DSH, run)],
            '--allow-fs-write=' + str(run), '--allow-fs-write=' + str(run) + '/*',
            str(SCRIPTS / 't106_candidate.mjs'), str(t.CANDIDATE), str(t.DSH), str(run), alias]


def run_candidate(run, alias, containers, conf, token, before, central):
    args = node_command(run, alias)
    handled = set()
    with (run / 'node.stdout').open('x') as out, (run / 'node.stderr').open('x') as err:
        child = subprocess.Popen(args, cwd=ROOT, env=t.clean_env(run), stdout=out, stderr=err, start_new_session=True)
        try:
            end = time.monotonic() + 210
            while child.poll() is None:
                if time.monotonic() >= end:
                    raise TimeoutError('T106_NODE_DEADLINE')
                for path in sorted(run.glob('observe-*.request.json')):
                    if path.name in handled:
                        continue
                    try:
                        request = json.loads(path.read_text())
                    except json.JSONDecodeError:
                        continue  # Writer still closing the small request; bounded by end.
                    if set(request) - {'label', 'pids', 'groups', 'tracked', 'waitFor', 'waitGone'}:
                        raise ValueError('T106_UNREVIEWED_OBSERVER_REQUEST')
                    remote = observer(containers['m1-a'], token, conf['remoteHome'], request)
                    other = observer(containers['m1-b'], token, conf['remoteHome'], {})
                    response = {'remote': remote, 'other': other,
                                'centralCanariesUnchanged': central_snapshot(run) == central,
                                'centralAbsoluteRunAbsent': not (Path('/workspace') / ('t106-' + token)).exists(),
                                'secondWorkspaceUnchanged': other == before['m1-b'],
                                'nonTargetUnchanged': remote['nonTargetTopLevel'] == before['m1-a']['nonTargetTopLevel']}
                    if not all(response[k] for k in ('centralCanariesUnchanged', 'centralAbsoluteRunAbsent', 'secondWorkspaceUnchanged', 'nonTargetUnchanged')):
                        response['error'] = 'T106_NON_TARGET_CHANGED'
                    publish_response(path.with_name(path.name.replace('.request.', '.response.')), response)
                    handled.add(path.name)
                time.sleep(0.025)
            return {'command': args, 'exitCode': child.wait(), 'observerRequests': len(handled)}
        finally:
            if child.poll() is None:
                # Exact child group created by this controller, never a global pkill.
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=5)


def run_suite(focus='all'):
    os.umask(0o077)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    token = secrets.token_hex(12)
    run = OUTPUT / ('run-' + token)
    run.mkdir(mode=0o700)
    report = {'task': 'T-106', 'status': 'in-progress', 'independentAcceptance': False,
              't107Ready': False, 'm1Passed': False, 'productScenariosPassed': [], 'run': str(run.relative_to(ROOT)),
              'sources': source_fingerprints(), 'failures': [], 'dataDeleted': False}
    report['focus'] = focus
    conf = None
    containers = {}
    stage = 'trusted-source-gate'
    try:
        report['trustedSources'] = trusted_sources()
        stage = 'pinned-private-tool'
        dependency = stage_tool(run)
        report['toolDependency'] = dependency
        save(run / 'plan.json', {'token': token, 'focus': focus, 'tool': {
            'sha256': dependency['binarySha256'], 'bytes': dependency['binaryBytes'], 'path': 'dependency/rg'}})
        stage = 'current-identity-and-resources'
        expected = t.current_record('m1-a')
        other_record = t.current_record('m1-b')
        save(run / 'current-records.json', {'m1-a': expected, 'm1-b': other_record})
        containers = {name: t.container_for(name) for name in ('m1-a', 'm1-b')}
        report['containerIds'] = containers
        report['runningContainersBefore'] = sorted(t.lab.execute(['docker', 'ps', '-q', '--no-trunc'], timeout=10).split())
        report['transportBefore'] = t.transport_processes()
        if any(report['transportBefore'].values()):
            raise ValueError('T106_EXISTING_TRANSPORT_OWNERSHIP_UNKNOWN')
        conf, alias = t.configure(run, expected)
        assert conf['remoteHome'] == '/tmp/t105-' + token + '/home'
        for name, content in [('utf8 文件.txt', 'CENTRAL-NOT-REMOTE-' + token), ('binary fixture.bin', 'CENTRAL-BINARY-' + token), ('central-canary.txt', token)]:
            with (run / 'workspace' / name).open('x') as handle:
                handle.write(content)
        central = central_snapshot(run)
        before = {name: observer(container, token, conf['remoteHome'], {}) for name, container in containers.items()}
        if any(value['rootExists'] or value['processes'] or value['helper']['exists'] for value in before.values()):
            raise ValueError('T106_RUN_NOT_FRESH')
        if (Path('/workspace') / ('t106-' + token)).exists():
            raise ValueError('T106_CENTRAL_RUN_COLLISION')
        save(run / 'before.json', {'workspaces': before, 'centralCanaries': central})
        stage = 'strict-host-key-enrollment'
        t.enroll(run, conf, alias)
        stage = 'candidate-runtime'
        report['runtime'] = run_candidate(run, alias, containers, conf, token, before, central)
        candidate_path = run / 'candidate.json'
        report['candidate'] = json.loads(candidate_path.read_text()) if candidate_path.exists() else None
        report['gates'] = [json.loads(p.read_text()) for p in sorted(run.glob('gate-*.json'))]
        if report['runtime']['exitCode'] != 0 or not report['candidate'] or not report['candidate']['runtimePassed']:
            raise ValueError('T106_RUNTIME_CASE_FAILED')
        if len(report['gates']) != 2 or not all(g['dispatch'] and g['currentBuildBeforeAndAfter'] and all(g['checks'].values()) for g in report['gates']):
            raise ValueError('T106_IDENTITY_GATE_EVIDENCE_FAILED')
        after = {name: observer(container, token, conf['remoteHome'], {}) for name, container in containers.items()}
        save(run / 'after-runtime.json', after)
        report['helperDirectReadback'] = after['m1-a']['helper']
        assert report['helperDirectReadback'] == {'exists': True, 'sha256': t.HELPER_SHA, 'bytes': 217238}
        assert after['m1-b'] == before['m1-b']
        assert central_snapshot(run) == central
        report['runtimeProbesPassed'] = True
    except Exception as error:
        report['failures'].append({'stage': stage, 'type': type(error).__name__,
                                   'code': str(error) if str(error).startswith('T106_') else None})
    finally:
        if conf and containers:
            try:
                # Wait for bounded workloads/connector, not retained supervisors.
                # A detached session legitimately retains those for 600 seconds.
                end = time.monotonic() + 35
                while True:
                    observed = observer(containers['m1-a'], token, conf['remoteHome'], {})
                    if all(p['kind'] in ('daemon', 'supervisor-or-guardian') for p in observed['processes']) or time.monotonic() >= end:
                        break
                    time.sleep(0.2)
                save(run / 'before-helper-cleanup.json', observed)
                if any(p['kind'] not in ('daemon', 'supervisor-or-guardian') for p in observed['processes']):
                    raise ValueError('T106_OWNED_WORKLOAD_NOT_QUIESCENT')
                extended = any(p['kind'] == 'supervisor-or-guardian' for p in observed['processes'])
                cleanup_script = SCRIPTS / ('t106_cleanup.py' if extended else 't105_cleanup.py')
                cleanup_args = [conf['remoteHome'], token] if extended else [conf['remoteHome']]
                cleanup = json.loads(t.lab.execute(['docker', 'exec', containers['m1-a'], 'python3', '-I', '-c',
                                                   cleanup_script.read_text(), *cleanup_args], timeout=35))
                report['helperCleanup'] = cleanup
                save(run / 'daemon-cleanup.json', cleanup)
                final = {name: observer(container, token, conf['remoteHome'], {}) for name, container in containers.items()}
                save(run / 'after-cleanup.json', final)
                assert not final['m1-a']['processes'] and not cleanup.get('unreaped')
                if 'before' in locals():
                    assert final['m1-b'] == before['m1-b']
                    assert final['m1-a']['nonTargetTopLevel'] == before['m1-a']['nonTargetTopLevel']
                    assert central_snapshot(run) == central
                report['noRemoteProcessRemaining'] = True
            except Exception as error:
                report['failures'].append({'stage': 'independent-cleanup', 'type': type(error).__name__,
                                           'code': str(error) if str(error).startswith('T106_') else None})
        try:
            end = time.monotonic() + 15
            while True:
                transport = t.transport_processes()
                if not any(transport.values()) or time.monotonic() >= end:
                    break
                time.sleep(0.2)
            report['transportAfter'] = transport
            report['runningContainersAfter'] = sorted(t.lab.execute(['docker', 'ps', '-q', '--no-trunc'], timeout=10).split())
            assert not any(transport.values())
            if 'runningContainersBefore' in report:
                assert report['runningContainersBefore'] == report['runningContainersAfter']
                report['resourcesRetained'] = True
            else:
                report['resourcesRetained'] = 'not-compared-preflight-stopped-before-baseline'
            assert report['sources'] == source_fingerprints()
        except Exception as error:
            report['failures'].append({'stage': 'final-resource-check', 'type': type(error).__name__})
        report['status'] = 'implementation-self-test-awaiting-independent-review' if not report['failures'] else 'blocked'
        report['searchLimits'] = {'GitFilenameDiscovery': 'separate-evidence',
                                 'nonGitFilenameSearch': 'requires-private-rg-see-case-result',
                                 'contentSearch': 'explicit-rg-via-bound-command-only-see-case-result',
                                 'frozenImageHealth': 'degraded-missing-ripgrep',
                                 'privateToolEnvironment': report.get('candidate', {}).get('privateToolEnvironment') if report.get('candidate') else None,
                                 'frozenImageFixed': False, 'globalInstallation': False}
        report['limits'] = ['Native ctx.subprocess.spawn manages local SSH PID, not remote cancellation.',
                            'Only explicit adapter tested; product main-session/provider integration not delivered.',
                            'danger-full-access synthetic commands are not an OS sandbox.',
                            'No mutation replay, session recovery, T-107 or M1 acceptance.']
        save(run / 'result.json', report)
        print(json.dumps({'status': report['status'], 'failures': report['failures'], 'evidence': str(run / 'result.json')}))
    return 1 if report['failures'] else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['run'])
    parser.add_argument('--focus', choices=['all', 'fault'], default='all', help='fault reruns only E, preserving prior A-D evidence')
    args = parser.parse_args()
    return run_suite(args.focus)


if __name__ == '__main__':
    raise SystemExit(main())
