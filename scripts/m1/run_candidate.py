"""Run an existing fixed T-103 installation with fresh outputs and a bounded clean environment."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time
import uuid

SCRIPT_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_ROOT.parent.parent
ENVIRONMENT_KEYS = {'PATH', 'HOME', 'DSH_HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'CI', 'LANG'}


def clean_environment(node, run_root):
    return {
        'PATH': os.pathsep.join(dict.fromkeys([str(Path(node).parent), '/usr/bin', '/bin'])),
        'HOME': str(run_root / 'home'), 'DSH_HOME': str(run_root / 'dsh-home'),
        'TMPDIR': str(run_root / 'tmp'),
        'XDG_CONFIG_HOME': str(run_root / 'home/.config'),
        'XDG_CACHE_HOME': str(run_root / 'home/.cache'),
        'CI': 'true', 'LANG': 'C.UTF-8',
    }


def node_command(node, candidate, installed_dsh, run_root, entry, arguments):
    return [str(node), '--permission',
            f'--allow-fs-read={installed_dsh}', f'--allow-fs-read={candidate.parent.parent}',
            f'--allow-fs-read={SCRIPT_ROOT}', f'--allow-fs-write={run_root}',
            f'--allow-fs-write={run_root}/*', str(SCRIPT_ROOT / entry), *map(str, arguments)]


def bounded_process(command, env, timeout):
    if not 0 < timeout <= 600:
        raise ValueError('T-103 timeout must be greater than zero and at most 600 seconds')
    started = time.monotonic()
    with subprocess.Popen(command, env=env, cwd=PROJECT_ROOT, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True, start_new_session=True) as process:
        timed_out = False
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
        return {'exitCode': process.returncode, 'timedOut': timed_out,
                'durationSeconds': round(time.monotonic() - started, 3),
                'stdout': stdout, 'stderr': stderr}


def write_json_new(path, data):
    with path.open('x', encoding='utf-8') as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
    if json.loads(path.read_text()) != data:
        raise RuntimeError(f'Full JSON readback mismatch: {path}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('profile', 'import', 'native', 'adapter'))
    parser.add_argument('--candidate-root', type=Path, required=True)
    parser.add_argument('--installed-dsh', type=Path, required=True)
    parser.add_argument('--timeout-seconds', type=int, default=120)
    args = parser.parse_args()
    if not 1 <= args.timeout_seconds <= 600:
        parser.error('--timeout-seconds must be between 1 and 600')
    node = shutil.which('node')
    if node is None:
        parser.error('Existing node executable is required; nothing will be installed')
    candidate = args.candidate_root.resolve(strict=True)
    installed_dsh = args.installed_dsh.resolve(strict=True)
    run_root = candidate.parent.parent / f't103-{args.mode}-{uuid.uuid4().hex}'
    if run_root.exists() or run_root.is_symlink():
        raise RuntimeError('Refusing an existing output directory')
    entry = {'profile': 'profile_candidate.mjs', 'import': 'import_candidate.mjs'}.get(args.mode, 'activate_candidate.mjs')
    arguments = [candidate, installed_dsh, run_root]
    if args.mode in ('native', 'adapter'):
        arguments.insert(0, args.mode)
    command = node_command(node, candidate, installed_dsh, run_root, entry, arguments)
    env = clean_environment(node, run_root)
    assert set(env) == ENVIRONMENT_KEYS
    result = bounded_process(command, env, args.timeout_seconds)
    # The probe normally creates this root after its preflight. Preserve diagnostics on early failure too.
    if run_root.is_symlink():
        raise RuntimeError('Refusing a symlink output directory')
    run_root.mkdir(exist_ok=True)
    for stream in ('stdout', 'stderr'):
        with (run_root / f'{stream}.txt').open('x', encoding='utf-8') as handle:
            handle.write(result.pop(stream))
    report_name = {'profile': 'profile-result.json', 'import': 'import-result.json'}.get(args.mode, 'activation.json')
    report_path = run_root / report_name
    report = json.loads(report_path.read_text()) if report_path.is_file() else None
    expected_native_failure = False
    if args.mode == 'native' and report:
        failed = {key for key, value in report.get('checks', {}).items() if value is not True}
        expected_native_failure = (failed == {'helpersDisposed', 'intervalsCleared'}
                                   and report.get('passed') is False and 'error' not in report
                                   and not report.get('cordisErrors') and not report.get('networkAttempts'))
    passed = (not result['timedOut'] and report is not None
              and ((args.mode == 'native' and result['exitCode'] == 1 and expected_native_failure)
                   or (args.mode != 'native' and result['exitCode'] == 0 and report.get('passed') is True)))
    launcher = {'task': 'T-103', 'mode': args.mode, 'command': command,
                'environmentKeys': sorted(env), 'timeoutSeconds': args.timeout_seconds,
                'runRoot': str(run_root), 'report': report_name, **result, 'passed': passed}
    write_json_new(run_root / 'launcher-result.json', launcher)
    print(json.dumps(launcher, indent=2))
    if not passed:
        raise SystemExit(f'FAIL: inspect fresh diagnostics in {run_root}')
    print(f'PASS: {args.mode}; fresh root {run_root}; full report readback; deadline {args.timeout_seconds}s')


if __name__ == '__main__':
    main()
