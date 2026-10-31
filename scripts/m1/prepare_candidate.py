"""Download the approved fixed asset, verify it, and safely inspect/extract it."""
import hashlib
import json
import pathlib
import tarfile
import tempfile
import urllib.error
import urllib.request

base = pathlib.Path('artifacts/m1/t103').resolve()
metadata = json.loads(pathlib.Path('docs/implementation/evidence/t101-candidate-metadata.json').read_text())
version = next(item for item in metadata['sshRemote']['versions'] if item['tag'] == 'v0.13.3')
asset = next(item for item in version['assets'] if item['name'] == 'dsh-ssh-remote-0.13.3.tgz')
if asset['id'] != 689590055 or asset['size'] > 2 * 1024 * 1024:
    raise SystemExit('FAIL: asset identity or declared size outside approved scope')
(base / 'downloads').mkdir(parents=True, exist_ok=True)
download = pathlib.Path(tempfile.mkdtemp(prefix='asset-', dir=base / 'downloads'))
archive_path = download / asset['name']
url = 'https://github.com/CrazyShout/dsh-ssh-remote/releases/download/v0.13.3/' + asset['name']
request = urllib.request.Request(url, headers={'User-Agent': 'Agent-Studio-T103-audit'})
try:
    with urllib.request.urlopen(request, timeout=60) as response, archive_path.open('xb') as handle:
        transferred = 0
        while chunk := response.read(65536):
            transferred += len(chunk)
            if transferred > 2 * 1024 * 1024:
                raise SystemExit('FAIL: public download exceeded approved archive size cap')
            handle.write(chunk)
except urllib.error.HTTPError as error:
    raise SystemExit(f'FAIL: anonymous public download returned HTTP {error.code}') from error
except urllib.error.URLError as error:
    raise SystemExit(f'FAIL: anonymous public download failed ({type(error.reason).__name__})') from error
data = archive_path.read_bytes()
actual_hash = hashlib.sha256(data).hexdigest()
if len(data) != asset['size'] or actual_hash != asset['publishedSha256']:
    raise SystemExit(f'FAIL: archive integrity mismatch; observed {len(data)} bytes, sha256={actual_hash}')

(base / 'extracted').mkdir(parents=True, exist_ok=True)
extracted = pathlib.Path(tempfile.mkdtemp(prefix='candidate-', dir=base / 'extracted'))
entries = []
names = set()
with tarfile.open(archive_path, 'r:gz') as archive:
    members = archive.getmembers()
    if len(members) > 2000 or sum(member.size for member in members) > 16 * 1024 * 1024:
        raise SystemExit('FAIL: archive exceeds entry or expanded-size budget')
    for member in members:
        name = pathlib.PurePosixPath(member.name)
        if name.is_absolute() or '..' in name.parts or not name.parts or name.parts[0] != 'package' or '\\' in member.name or member.name in names:
            raise SystemExit(f'FAIL: unsafe or duplicate archive path {member.name!r}')
        if not member.isfile() and not member.isdir():
            raise SystemExit(f'FAIL: archive contains non-regular entry {member.name!r}')
        if member.size > 10 * 1024 * 1024:
            raise SystemExit(f'FAIL: oversized archive member {member.name!r}')
        names.add(member.name)
        entries.append({'path': member.name, 'size': member.size, 'kind': 'file' if member.isfile() else 'directory'})
    package_member = archive.getmember('package/package.json')
    if package_member.size > 1024 * 1024:
        raise SystemExit('FAIL: oversized package metadata')
    package_handle = archive.extractfile(package_member)
    if package_handle is None:
        raise SystemExit('FAIL: package metadata is not a regular file')
    package = json.loads(package_handle.read())
    if package.get('name') != 'dsh-ssh-remote' or package.get('version') != '0.13.3' or package.get('license') != 'MIT':
        raise SystemExit('FAIL: archive package identity differs from fixed metadata')
    for member in members:
        destination = extracted.joinpath(*pathlib.PurePosixPath(member.name).parts)
        if not destination.resolve().is_relative_to(extracted):
            raise SystemExit('FAIL: extraction path escapes its new empty directory')
        if member.isdir():
            destination.mkdir(parents=True, exist_ok=True)
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        source = archive.extractfile(member)
        if source is None:
            raise SystemExit('FAIL: regular archive member cannot be read')
        with source, destination.open('xb') as target:
            content = source.read(member.size + 1)
            if len(content) != member.size:
                raise SystemExit('FAIL: archive member length differs from metadata')
            target.write(content)

report = {
    'task': 'T-103', 'assetId': asset['id'], 'archive': str(archive_path.relative_to(pathlib.Path.cwd())),
    'sourceCommit': version['commit'], 'size': len(data), 'sha256': actual_hash,
    'entryCount': len(entries), 'expandedBytes': sum(item['size'] for item in entries),
    'extractedRoot': str(extracted.relative_to(pathlib.Path.cwd())),
    'package': package, 'entries': entries, 'packageCodeExecuted': False,
}
report_path = base / 'archive-inspection.json'
with report_path.open('x', encoding='utf-8') as handle:
    json.dump(report, handle, ensure_ascii=False, indent=2)
    handle.write('\n')
if json.loads(report_path.read_text()) != report:
    raise SystemExit('FAIL: archive inspection report readback differs')
print(f'PASS: downloaded and independently hashed {len(data)} bytes, sha256={actual_hash}')
print(f'PASS: {len(entries)} regular/directory entries, {report["expandedBytes"]} expanded bytes; no links or escaping paths')
print(f'Extracted root: {report["extractedRoot"]}')
print('Package metadata for static review:')
print(json.dumps(package, ensure_ascii=False, indent=2))
print(f'Report: {report_path.relative_to(pathlib.Path.cwd())}')
