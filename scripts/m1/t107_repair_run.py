"""One bounded repair1 run: real recovery + actual guarded entrypoints; no deployment."""
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts/m1'
spec = importlib.util.spec_from_file_location('t107_history', SCRIPTS / 't107_run.py')
history = importlib.util.module_from_spec(spec)
spec.loader.exec_module(history)
frozen, t = history.frozen, history.t
save = history.save


def recovery(run, alias, containers, conf, token, before):
    args = frozen.node_command(run, alias)
    args[args.index(str(SCRIPTS / 't106_candidate.mjs'))] = str(SCRIPTS / 't107_repair_runtime.mjs')
    handled = set()
    with (run / 'recovery.stdout').open('x') as out, (run / 'recovery.stderr').open('x') as err:
        child = subprocess.Popen(args, cwd=ROOT, env=t.clean_env(run), stdout=out, stderr=err, start_new_session=True)
        try:
            deadline = time.monotonic() + 100
            while child.poll() is None:
                if time.monotonic() >= deadline:
                    raise TimeoutError('T107_REPAIR_RUNTIME_DEADLINE')
                for path in sorted(run.glob('observe-*.request.json')):
                    if path.name in handled:
                        continue
                    try:
                        req = json.loads(path.read_text())
                    except json.JSONDecodeError:
                        continue  # Partial publication only; outer finite deadline applies.
                    if set(req) - {'label', 'tracked', 'waitFor', 'waitGone'}:
                        raise ValueError('T107_REPAIR_OBSERVER_SCOPE')
                    remote = frozen.observer(containers['m1-a'], token, conf['remoteHome'], req)
                    other = frozen.observer(containers['m1-b'], token, conf['remoteHome'], {})
                    current = t.current_record('m1-a')
                    value = {'remote': remote, 'other': other, 'binding': current}
                    assert current == conf['expected'], 'T107_REPAIR_CURRENT_BINDING_CHANGED'
                    assert other == before['m1-b'], 'T107_REPAIR_OTHER_CHANGED'
                    assert remote['nonTargetTopLevel'] == before['m1-a']['nonTargetTopLevel'], 'T107_REPAIR_NONTARGET_CHANGED'
                    assert not list((run / 'workspace').iterdir()), 'T107_REPAIR_CENTRAL_WORKLOAD'
                    frozen.publish_response(path.with_name(path.name.replace('.request.', '.response.')), value)
                    handled.add(path.name)
                time.sleep(0.025)
            return {'args': args, 'exitCode': child.wait(), 'observerRequests': len(handled)}
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=5)


def entrypoints(run):
    run.mkdir(mode=0o700)
    for name in ('home', 'bin', 'tmp'):
        (run / name).mkdir(mode=0o700)
    args = [shutil.which('node'), '--experimental-transform-types', '--permission', '--allow-child-process',
            *['--allow-fs-read=' + str(p) for p in (SCRIPTS, history.SIDEBAR.parent, t.DSH, run)],
            '--allow-fs-write=' + str(run), '--allow-fs-write=' + str(run) + '/*',
            str(SCRIPTS / 't107_repair_entrypoints.mjs'), str(history.SIDEBAR), str(t.DSH), str(run)]
    env = {'HOME': str(run / 'home'), 'PATH': str(run / 'bin'), 'TMPDIR': str(run / 'tmp'), 'LANG': 'C.UTF-8', 'CI': '1'}
    result = subprocess.run(args, cwd=ROOT, env=env, capture_output=True, text=True, timeout=35)
    (run / 'stdout.txt').write_text(result.stdout)
    (run / 'stderr.txt').write_text(result.stderr)
    command = {'args': args, 'exitCode': result.returncode}
    save(run / 'command.json', command)
    return command


def main():
    os.umask(0o077)
    token = secrets.token_hex(12)
    run = history.OUTPUT / ('repair1-' + token)
    run.mkdir(mode=0o700)
    report = {'task': 'T-107-repair1', 'run': str(run.relative_to(ROOT)), 'sources': history.fingerprint(),
              'failures': [], 'm1Passed': False, 't201Ready': False, 'independentAcceptance': False, 'dataDeleted': False}
    conf, containers = None, {}
    stage = 'identity'
    try:
        stage = 'focused-regressions'
        unit = subprocess.run(['node', '--test', str(SCRIPTS / 't107_repair.test.mjs')], cwd=ROOT, capture_output=True, text=True, timeout=15)
        (run / 'focused.stdout').write_text(unit.stdout)
        (run / 'focused.stderr').write_text(unit.stderr)
        report['focusedCommand'] = {'args': unit.args, 'exitCode': unit.returncode}
        assert unit.returncode == 0, 'T107_REPAIR_FOCUSED_FAILED'
        counter = run / 'counterexample'
        counter.mkdir()
        old = history.OUTPUT / 'acceptance-945cpr60/discovery_budget.mjs'
        shutil.copyfile(old, counter / old.name)
        assert t.digest(old) == t.digest(counter / old.name)
        offline = subprocess.run(['node', str(counter / old.name)], cwd=ROOT, capture_output=True, text=True, timeout=10)
        (counter / 'stdout.txt').write_text(offline.stdout)
        (counter / 'stderr.txt').write_text(offline.stderr)
        report['counterexampleCommand'] = {'args': offline.args, 'exitCode': offline.returncode, 'unchangedSourceSha256': t.digest(old)}
        assert offline.returncode == 0, 'T107_REPAIR_COUNTEREXAMPLE_FAILED'
        assert json.loads((counter / 'discovery-budget.json').read_text())['actual']['virtualElapsedMs'] == 28800
        stage = 'identity'
        expected = t.current_record('m1-a')
        save(run / 'current-records.json', {'m1-a': expected, 'm1-b': t.current_record('m1-b')})
        containers = {n: t.container_for(n) for n in ('m1-a', 'm1-b')}
        report['runningBefore'] = sorted(t.lab.execute(['docker', 'ps', '-q', '--no-trunc'], timeout=10).split())
        assert len(report['runningBefore']) == 36
        assert not any(t.transport_processes().values()), 'T107_REPAIR_EXISTING_TRANSPORT'
        conf, alias = t.configure(run, expected)
        save(run / 'plan.json', {'token': token})
        before = {n: frozen.observer(c, token, conf['remoteHome'], {}) for n, c in containers.items()}
        assert not any(v['rootExists'] or v['processes'] or v['helper']['exists'] for v in before.values())
        save(run / 'before.json', before)
        t.enroll(run, conf, alias)
        stage = 'actual-recovery'
        report['recoveryCommand'] = recovery(run, alias, containers, conf, token, before)
        probe = json.loads((run / 'recovery.json').read_text())
        assert report['recoveryCommand']['exitCode'] == 0 and probe['passed'], 'T107_REPAIR_RECOVERY_FAILED'
        report['recovery'] = {'path': str((run / 'recovery.json').relative_to(ROOT)), 'sha256': t.digest(run / 'recovery.json')}
        gates = [json.loads(p.read_text()) for p in sorted(run.glob('gate-*.json'))]
        assert len(gates) == 3 and all(g['dispatch'] and g['currentBuildBeforeAndAfter'] and all(g['checks'].values()) for g in gates), 'T107_REPAIR_IDENTITY_GATES'
        report['identityGates'] = gates
        direct = frozen.observer(containers['m1-a'], token, conf['remoteHome'], {})
        save(run / 'direct-storage.json', direct)
        actual = {f['path']: f for f in direct['files'] if f['kind'] == 'file'}
        for f in probe['storedFiles']:
            assert (actual['project/' + f['path']]['sha256'], actual['project/' + f['path']]['bytes']) == (f['sha256'], f['bytes'])
        report['directStorageMatchesHelperReadback'] = True
        stage = 'actual-guarded-entrypoints'
        report['entrypointCommand'] = entrypoints(run / 'entrypoints')
        ep = json.loads((run / 'entrypoints/entrypoints.json').read_text())
        assert report['entrypointCommand']['exitCode'] == 0 and ep['passed'], 'T107_REPAIR_ENTRYPOINTS_FAILED'
        report['entrypoints'] = {'path': str((run / 'entrypoints/entrypoints.json').relative_to(ROOT)), 'sha256': t.digest(run / 'entrypoints/entrypoints.json')}
        report['recorderPids'] = [a['pid'] for a in ep['actions']]
        assert all(not Path('/proc', str(pid)).exists() for pid in report['recorderPids']), 'T107_REPAIR_RECORDER_ALIVE'
    except Exception as error:
        report['failures'].append({'stage': stage, 'type': type(error).__name__, 'code': str(error) if str(error).startswith('T107_') else None})
    finally:
        if conf and containers:
            try:
                observed = frozen.observer(containers['m1-a'], token, conf['remoteHome'], {})
                # A failed run may wait for its 50s alarm, never present cleanup as recovery.
                end = time.monotonic() + 55
                while any(p['kind'] == 'workload' for p in observed['processes']) and time.monotonic() < end:
                    time.sleep(0.5)
                    observed = frozen.observer(containers['m1-a'], token, conf['remoteHome'], {})
                save(run / 'before-cleanup.json', observed)
                assert all(p['kind'] in ('daemon', 'supervisor-or-guardian') for p in observed['processes']), 'T107_REPAIR_WORKLOAD_REMAINS'
                extended = any(p['kind'] == 'supervisor-or-guardian' for p in observed['processes'])
                script = SCRIPTS / ('t106_cleanup.py' if extended else 't105_cleanup.py')
                args = [conf['remoteHome'], token] if extended else [conf['remoteHome']]
                cleanup = json.loads(t.lab.execute(['docker', 'exec', containers['m1-a'], 'python3', '-I', '-c', script.read_text(), *args], timeout=35))
                save(run / 'cleanup.json', cleanup)
                final = {n: frozen.observer(c, token, conf['remoteHome'], {'tracked': observed['processes']} if n == 'm1-a' else {}) for n, c in containers.items()}
                save(run / 'after-cleanup.json', final)
                assert not final['m1-a']['processes'] and not cleanup.get('unreaped')
                assert all(p['state'] in ('gone', 'reused') for p in final['m1-a']['tracked'])
                assert final['m1-b'] == before['m1-b']
                report['cleanup'] = {'noOwnedProcesses': True, 'tracked': final['m1-a']['tracked'], 'receipt': str((run / 'cleanup.json').relative_to(ROOT))}
            except Exception as error:
                report['failures'].append({'stage': 'cleanup', 'type': type(error).__name__, 'code': str(error) if str(error).startswith('T107_') else None})
        report['transportAfter'] = t.transport_processes()
        report['runningAfter'] = sorted(t.lab.execute(['docker', 'ps', '-q', '--no-trunc'], timeout=10).split())
        report['sameContainerSet'] = report.get('runningBefore') == report['runningAfter']
        report['sourcesUnchanged'] = history.fingerprint() == report['sources']
        if any(report['transportAfter'].values()) or not report['sameContainerSet'] or not report['sourcesUnchanged']:
            report['failures'].append({'stage': 'final-integrity'})
        report['passed'] = not report['failures']
        save(run / 'result.json', report)
        print(json.dumps({'run': str(run), 'passed': report['passed'], 'failures': report['failures']}))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
