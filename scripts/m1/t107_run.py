"""Bounded T-107 probes. No production profile, deployment or frozen-source edits."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts/m1'
OUTPUT = ROOT / 'artifacts/m1/t107'
SIDEBAR = Path('/home/ubuntu/.dsh/profiles/web/node_modules/dsh-better-sidebar')
spec = importlib.util.spec_from_file_location('t107_frozen_controller', SCRIPTS / 't106_run.py')
frozen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(frozen)
t = frozen.t


def save(path, value):
    with path.open('x') as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
    assert json.loads(path.read_text()) == value


def fingerprint():
    accepted = json.loads((ROOT / 'docs/implementation/evidence/t106-independent-acceptance-review2.json').read_text())
    checks = {p: t.digest(ROOT / p) == h for p, h in accepted['sourceSha256'].items()}
    assert all(checks.values()), 'T107_FROZEN_SOURCE_CHANGED'
    return {'t106': checks, 't105': frozen.trusted_sources(),
            'newSources': {str(p.relative_to(ROOT)): t.digest(p) for p in sorted(SCRIPTS.glob('t107_*')) if p.is_file()}}


def entrypoints():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='entrypoints-', dir=OUTPUT))
    for name in ('home', 'bin', 'tmp'):
        (run / name).mkdir(mode=0o700)
    before = fingerprint()
    args = [shutil.which('node'), '--experimental-transform-types', '--permission', '--allow-child-process',
            *['--allow-fs-read=' + str(p) for p in (SCRIPTS, SIDEBAR.parent, t.DSH, run)],
            '--allow-fs-write=' + str(run), '--allow-fs-write=' + str(run) + '/*',
            str(SCRIPTS / 't107_entrypoints.mjs'), str(SIDEBAR), str(t.DSH), str(run)]
    env = {'HOME': str(run / 'home'), 'PATH': str(run / 'bin'), 'TMPDIR': str(run / 'tmp'), 'LANG': 'C.UTF-8', 'CI': '1'}
    result = subprocess.run(args, cwd=ROOT, env=env, capture_output=True, text=True, timeout=40)
    (run / 'stdout.txt').write_text(result.stdout)
    (run / 'stderr.txt').write_text(result.stderr)
    save(run / 'command.json', {'args': args, 'exitCode': result.returncode})
    assert fingerprint() == before
    save(run / 'integrity.json', before)
    print(json.dumps({'run': str(run), 'exitCode': result.returncode, 'stdout': result.stdout}))
    return result.returncode


def runtime():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    token = secrets.token_hex(12)
    run = OUTPUT / ('run-' + token)
    run.mkdir(mode=0o700)
    report = {'task': 'T-107', 'run': str(run.relative_to(ROOT)), 'sources': fingerprint(), 'failures': [], 'dataDeleted': False}
    conf = None
    containers = {}
    try:
        expected = t.current_record('m1-a')
        save(run / 'current-records.json', {'m1-a': expected, 'm1-b': t.current_record('m1-b')})
        containers = {n: t.container_for(n) for n in ('m1-a', 'm1-b')}
        report['runningBefore'] = sorted(t.lab.execute(['docker', 'ps', '-q', '--no-trunc'], timeout=10).split())
        assert not any(t.transport_processes().values()), 'T107_EXISTING_TRANSPORT'
        conf, alias = t.configure(run, expected)
        assert conf['remoteHome'] == '/tmp/t105-' + token + '/home'
        save(run / 'plan.json', {'token': token})
        before = {n: frozen.observer(c, token, conf['remoteHome'], {}) for n, c in containers.items()}
        assert not any(v['rootExists'] or v['processes'] or v['helper']['exists'] for v in before.values())
        save(run / 'before.json', before)
        t.enroll(run, conf, alias)
        args = frozen.node_command(run, alias)
        args[args.index(str(SCRIPTS / 't106_candidate.mjs'))] = str(SCRIPTS / 't107_capacity.mjs')
        start = time.monotonic()
        child = subprocess.Popen(args, cwd=ROOT, env=t.clean_env(run), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            stdout, stderr = child.communicate(timeout=120)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                stdout, stderr = child.communicate(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                stdout, stderr = child.communicate(timeout=5)
            (run / 'timeout-stdout.txt').write_text(stdout)
            (run / 'timeout-stderr.txt').write_text(stderr)
            raise TimeoutError('T107_CONTROLLER_DEADLINE')
        result = subprocess.CompletedProcess(args, child.returncode, stdout, stderr)
        (run / 'stdout.txt').write_text(result.stdout)
        (run / 'stderr.txt').write_text(result.stderr)
        report['command'] = {'args': args, 'exitCode': result.returncode, 'elapsedMs': round((time.monotonic()-start)*1000)}
        report['probe'] = json.loads((run / 'capacity.json').read_text())
        assert result.returncode == 0 and report['probe']['probePassed'], 'T107_CAPACITY_FAILED'
        gates = [json.loads(p.read_text()) for p in sorted(run.glob('gate-*.json'))]
        assert len(gates) == 2 and all(g['dispatch'] and g['currentBuildBeforeAndAfter'] and all(g['checks'].values()) for g in gates)
        report['identityGates'] = gates
        after = {n: frozen.observer(c, token, conf['remoteHome'], {}) for n, c in containers.items()}
        save(run / 'direct-storage.json', after)
        assert after['m1-b'] == before['m1-b']
        assert after['m1-a']['nonTargetTopLevel'] == before['m1-a']['nonTargetTopLevel']
        actual = {f['path']: f for f in after['m1-a']['files'] if f['kind'] == 'file'}
        for f in report['probe']['storedFiles']:
            row = actual['project/' + f['path']]
            assert (row['sha256'], row['bytes']) == (f['sha256'], f['bytes'])
        report['directStorageMatchesHelperReadback'] = True
    except Exception as error:
        report['failures'].append({'type': type(error).__name__, 'code': str(error) if str(error).startswith('T107_') else None})
    finally:
        if conf and containers:
            try:
                observed = frozen.observer(containers['m1-a'], token, conf['remoteHome'], {})
                save(run / 'before-cleanup.json', observed)
                assert all(p['kind'] in ('daemon', 'supervisor-or-guardian') for p in observed['processes']), 'T107_WORKLOAD_STILL_RUNNING'
                extended = any(p['kind'] == 'supervisor-or-guardian' for p in observed['processes'])
                script = SCRIPTS / ('t106_cleanup.py' if extended else 't105_cleanup.py')
                args = [conf['remoteHome'], token] if extended else [conf['remoteHome']]
                cleanup = json.loads(t.lab.execute(['docker', 'exec', containers['m1-a'], 'python3', '-I', '-c', script.read_text(), *args], timeout=35))
                save(run / 'cleanup.json', cleanup)
                final = {n: frozen.observer(c, token, conf['remoteHome'], {'tracked': observed['processes']}) for n, c in containers.items()}
                save(run / 'after-cleanup.json', final)
                assert not final['m1-a']['processes'] and not cleanup.get('unreaped')
                assert all(p['state'] in ('gone', 'reused') for p in final['m1-a']['tracked'])
                report['cleanup'] = {'noOwnedProcesses': True, 'tracked': final['m1-a']['tracked'], 'receipt': str((run / 'cleanup.json').relative_to(ROOT))}
            except Exception as error:
                report['failures'].append({'stage': 'cleanup', 'type': type(error).__name__, 'code': str(error) if str(error).startswith('T107_') else None})
        report['transportAfter'] = t.transport_processes()
        report['runningAfter'] = sorted(t.lab.execute(['docker', 'ps', '-q', '--no-trunc'], timeout=10).split())
        report['sameContainerSet'] = report.get('runningBefore') == report['runningAfter']
        report['frozenSourcesUnchanged'] = fingerprint() == report['sources']
        if any(report['transportAfter'].values()) or not report['sameContainerSet'] or not report['frozenSourcesUnchanged']:
            report['failures'].append({'stage': 'final-state'})
        save(run / 'result.json', report)
        print(json.dumps({'run': str(run), 'failures': report['failures']}))
    return 1 if report['failures'] else 0


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['entrypoints', 'runtime'])
    args = parser.parse_args()
    raise SystemExit(entrypoints() if args.action == 'entrypoints' else runtime())
