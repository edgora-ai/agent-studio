"""Install the verified candidate in a fresh, credential-free local fixture."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--inspection', type=Path, required=True)
parser.add_argument('--installed-dsh', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
inspection = json.loads(args.inspection.read_text())
archive = Path(inspection['archive']).resolve()
if hashlib.sha256(archive.read_bytes()).hexdigest() != inspection['sha256']:
    raise SystemExit('FAIL: archive changed after inspection')
if inspection['sha256'] != 'cab6fa53954dc1272dfde9ec8a8fd3928fd79232c78b658cb1b434fb0644b162':
    raise SystemExit('FAIL: archive is not the approved fixed candidate')
if args.output.exists():
    raise SystemExit('FAIL: refusing to overwrite an existing installation report')
node = shutil.which('node')
npm = shutil.which('npm')
if node is None or npm is None:
    raise SystemExit('FAIL: existing node/npm executable is unavailable; no upgrade attempted')
base = args.inspection.resolve().parent
fixture = Path(tempfile.mkdtemp(prefix='fixture-', dir=base))
for directory in ('runtime', 'home', 'cache', 'tmp', 'dsh-home'):
    (fixture / directory).mkdir()
config = fixture / 'npmrc'
config.write_text('registry=https://registry.npmjs.org/\nignore-scripts=true\nlegacy-peer-deps=true\naudit=false\nfund=false\nupdate-notifier=false\nprogress=false\nengine-strict=true\nfetch-retries=0\nfetch-timeout=60000\nbin-links=false\n')
(fixture / 'global-npmrc').write_text('')
package = {
    'name': 'agent-studio-t103-fixture', 'version': '0.0.0',
    'private': True, 'type': 'module',
    'dependencies': {'dsh-ssh-remote': 'file:' + str(archive)},
    'overrides': {'@deepseek-ai/schemastery': '3.18.5', 'yaml': '2.9.1'},
}
(fixture / 'runtime/package.json').write_text(json.dumps(package, indent=2) + '\n')
env = {
    'PATH': os.pathsep.join(dict.fromkeys([str(Path(node).parent), str(Path(npm).parent), '/usr/bin', '/bin'])),
    'HOME': str(fixture / 'home'), 'TMPDIR': str(fixture / 'tmp'),
    'XDG_CONFIG_HOME': str(fixture / 'home/.config'),
    'XDG_CACHE_HOME': str(fixture / 'cache'),
    'DSH_HOME': str(fixture / 'dsh-home'),
    'NPM_CONFIG_USERCONFIG': str(config),
    'NPM_CONFIG_GLOBALCONFIG': str(fixture / 'global-npmrc'),
    'NPM_CONFIG_CACHE': str(fixture / 'cache'),
    'CI': 'true', 'LANG': 'C.UTF-8',
}
command = [npm, 'install', '--prefix', str(fixture / 'runtime'), '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', '--no-bin-links']
try:
    result = subprocess.run(command, env=env, cwd=Path.cwd(), capture_output=True, text=True, timeout=540, check=False)
except subprocess.TimeoutExpired as error:
    raise SystemExit('FAIL: npm installation exceeded the 540-second step budget') from error
(fixture / 'npm-stdout.txt').write_text(result.stdout)
(fixture / 'npm-stderr.txt').write_text(result.stderr)
report = {
    'task': 'T-103', 'fixture': str(fixture.relative_to(Path.cwd())),
    'archiveSha256': inspection['sha256'], 'npmExitCode': result.returncode,
    'lifecycleScriptsEnabled': False, 'peerAutoInstallEnabled': False,
    'credentialsInherited': False, 'productionProfileUsed': False,
    'peers': [],
}
if result.returncode == 0:
    installed = fixture / 'runtime/node_modules/dsh-ssh-remote'
    installed_meta = json.loads((installed / 'package.json').read_text())
    if installed_meta['version'] != '0.13.3':
        raise SystemExit('FAIL: installed candidate version differs')
    scope = fixture / 'runtime/node_modules/@deepseek-ai'
    scope.mkdir(exist_ok=True)
    for name in installed_meta['peerDependencies']:
        source = args.installed_dsh.resolve() / 'node_modules' / name
        target = fixture / 'runtime/node_modules' / name
        if not (source / 'package.json').is_file() or target.exists() or target.is_symlink():
            raise SystemExit(f'FAIL: missing source or unexpected preinstalled peer: {name}')
        peer_meta = json.loads((source / 'package.json').read_text())
        if name != '@deepseek-ai/cordis' and peer_meta['version'] != '0.2.1-rc.4':
            raise SystemExit(f'FAIL: peer is not existing rc.4: {name}')
        target.symlink_to(source.resolve(), target_is_directory=True)
        # A symlink is not read-only. The saved runner denies writes through both spellings.
        report['peers'].append({'name': name, 'version': peer_meta['version'], 'mode': 'source-symlink-not-read-only'})
    lock_path = fixture / 'runtime/package-lock.json'
    lock = json.loads(lock_path.read_text())
    report['lockSha256'] = hashlib.sha256(lock_path.read_bytes()).hexdigest()
    report['installedPackages'] = [
        {'path': path, 'version': item.get('version'), 'integrity': item.get('integrity'), 'hasInstallScript': item.get('hasInstallScript', False)}
        for path, item in lock['packages'].items() if path
    ]
report['directoryBytes'] = sum(path.lstat().st_size for path in fixture.rglob('*') if path.is_file() and not path.is_symlink())
if report['directoryBytes'] > 2 * 1024 ** 3:
    raise SystemExit('FAIL: fixture exceeds the 2-GiB operation budget')
with args.output.open('x') as handle:
    json.dump(report, handle, indent=2)
    handle.write('\n')
if json.loads(args.output.read_text()) != report:
    raise SystemExit('FAIL: installation report full readback differs')
print(result.stdout, end='')
print(result.stderr, end='')
print('Fixture:', report['fixture'])
print('Directory bytes:', report['directoryBytes'])
print('Installation report:', args.output)
if result.returncode:
    raise SystemExit(f'FAIL: isolated npm install exited {result.returncode}; no peer links or candidate code loaded')
print(f'PASS: installed fixed candidate with scripts disabled; {len(report["peers"])} existing peers linked; report read back')
