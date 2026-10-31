"""One pinned private test dependency, never a system package installation.

Verify Ubuntu's cached signed Release -> Packages -> fixed .deb SHA-256 chain.
Read only usr/bin/rg from the verified archive; never run maintainer scripts or
extract other paths. Download and extracted binary use separate new directories.
The runner copies this checked binary into each new run; the candidate uploads
it through the existing helper FS channel into that run's private helper HOME.
"""
import argparse
from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path
import secrets
import stat
import subprocess
import tarfile
from urllib.request import HTTPSHandler, ProxyHandler, build_opener

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'artifacts/m1/t106'
VERSION = '14.1.0-1'
ARCH = 'arm64'
PACKAGE_SHA = '71fe8a5667bc87d2bca175a3426c6ec518e0679cc821d23ae7056de7096f04de'
PACKAGE_BYTES = 1455230
FILENAME = 'pool/universe/r/rust-ripgrep/ripgrep_14.1.0-1_arm64.deb'
URL = 'https://ports.ubuntu.com/ubuntu-ports/' + FILENAME
INDEX_BASE = Path('/var/lib/apt/lists/ap-singapore-1-ad-1.clouds.ports.ubuntu.com_ubuntu-ports_dists_noble')
KEYRING = Path('/usr/share/keyrings/ubuntu-archive-keyring.gpg')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save(path, value):
    with path.open('x', encoding='utf-8') as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
    assert json.loads(path.read_text()) == value


def object_id(st):
    return st.st_dev, st.st_ino, st.st_mode


def open_child(parent, name, directory):
    before = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if stat.S_ISLNK(before.st_mode):
        raise ValueError('T106_TOOL_CACHE_SYMLINK')
    if not (stat.S_ISDIR(before.st_mode) if directory else stat.S_ISREG(before.st_mode)):
        raise ValueError('T106_TOOL_CACHE_UNSAFE_TYPE')
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | (os.O_DIRECTORY if directory else os.O_NONBLOCK)
    fd = os.open(name, flags, dir_fd=parent)
    try:
        after = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if object_id(before) != object_id(os.fstat(fd)) or object_id(after) != object_id(before):
            raise ValueError('T106_TOOL_CACHE_OBJECT_CHANGED')
        return fd
    except BaseException:
        os.close(fd)
        raise


@contextmanager
def walk_at(parent, parts, directory=False):
    opened = []
    try:
        for i, part in enumerate(parts):
            fd = open_child(parent, part, directory or i < len(parts) - 1)
            opened.append((parent, part, fd))
            parent = fd
        yield parent
        # Keep every ancestor open and recheck its un-resolved directory entry.
        # All file reads below use these anchored descriptors, not rebuilt paths.
        for ancestor, name, fd in opened:
            if object_id(os.stat(name, dir_fd=ancestor, follow_symlinks=False)) != object_id(os.fstat(fd)):
                raise ValueError('T106_TOOL_CACHE_OBJECT_CHANGED')
    finally:
        for _, _, fd in reversed(opened):
            os.close(fd)


@contextmanager
def directory_at(path):
    path = Path(path)
    if '..' in path.parts:
        raise ValueError('T106_TOOL_CACHE_UNSAFE_PATH')
    if not path.is_absolute():
        path = Path.cwd() / path
    root = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        with walk_at(root, path.parts[1:], directory=True) as fd:
            yield fd
    finally:
        os.close(root)


def read_at(parent, relative, maximum):
    parts = Path(relative).parts
    if not parts or Path(relative).is_absolute() or '..' in parts:
        raise ValueError('T106_TOOL_CACHE_UNSAFE_PATH')
    with walk_at(parent, parts) as fd:
        before = os.fstat(fd)
        if before.st_size > maximum:
            raise ValueError('T106_TOOL_CACHE_SIZE_LIMIT')
        chunks, total = [], 0
        while total <= maximum:
            chunk = os.read(fd, min(262144, maximum + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        after = os.fstat(fd)
        if (object_id(before), before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                object_id(after), after.st_size, after.st_mtime_ns, after.st_ctime_ns) or total != before.st_size:
            raise ValueError('T106_TOOL_CACHE_OBJECT_CHANGED')
        data = b''.join(chunks)
        identity = {'device': before.st_dev, 'inode': before.st_ino, 'bytes': total, 'sha256': digest(data)}
        return data, identity


def binary_from_bytes(data):
    if len(data) != PACKAGE_BYTES or digest(data) != PACKAGE_SHA:
        raise ValueError('T106_TOOL_PACKAGE_DIGEST_MISMATCH')
    # dpkg receives the exact immutable bytes just hashed, not a reopened pathname.
    result = subprocess.run(['dpkg-deb', '--fsys-tarfile', '-'], input=data, cwd=ROOT,
                            capture_output=True, timeout=15)
    if result.returncode:
        raise ValueError('T106_TOOL_ARCHIVE_READ_FAILED')
    with tarfile.open(fileobj=io.BytesIO(result.stdout), mode='r:') as archive:
        members = [m for m in archive.getmembers() if m.name == './usr/bin/rg']
        if len(members) != 1 or not members[0].isfile() or not 100000 < members[0].size < 6 * 1024**2:
            raise ValueError('T106_TOOL_ARCHIVE_ENTRY_REJECTED')
        return archive.extractfile(members[0]).read()


def binary_from_package(package):
    package = Path(package)
    with directory_at(package.parent) as parent:
        data, _ = read_at(parent, package.name, PACKAGE_BYTES)
    return binary_from_bytes(data)


def load_cached(manifest):
    manifest = Path(manifest)  # Deliberately do NOT resolve away links.
    with directory_at(manifest.parent) as parent:
        raw, manifest_id = read_at(parent, manifest.name, 65536)
        package, package_id = read_at(parent, 'download/ripgrep.deb', PACKAGE_BYTES)
        binary, binary_id = read_at(parent, 'extracted/rg', 6 * 1024**2)
    row = json.loads(raw)
    expected = binary_from_bytes(package)
    if binary != expected or row['binarySha256'] != digest(expected) or row['binaryBytes'] != len(binary):
        raise ValueError('T106_TOOL_BINARY_DIGEST_MISMATCH')
    if row['packageSha256'] != PACKAGE_SHA or row['sourceUrl'] != URL or row['packageBytes'] != PACKAGE_BYTES:
        raise ValueError('T106_TOOL_PROVENANCE_MISMATCH')
    metadata = {**row, 'manifest': str(manifest), 'binary': str(manifest.parent / 'extracted/rg'), 'reused': True,
                'verifiedInputs': {'manifest': manifest_id, 'package': package_id, 'binary': binary_id}}
    return metadata, binary


def verify_cached(manifest):
    return load_cached(manifest)[0]


def signed_metadata(directory):
    release = Path(str(INDEX_BASE) + '_InRelease')
    packages = Path(str(INDEX_BASE) + '_universe_binary-arm64_Packages')
    verified = directory / 'Release.verified'
    command = ['gpgv', '--keyring', str(KEYRING), '--status-fd', '1', '--output', str(verified), str(release)]
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=10)
    save(directory / 'signature-check.json', {'command': command, 'exitCode': result.returncode,
                                             'stdout': result.stdout, 'stderr': result.stderr})
    if result.returncode or '[GNUPG:] VALIDSIG ' not in result.stdout:
        raise ValueError('T106_TOOL_METADATA_SIGNATURE_FAILED')
    data = packages.read_bytes()
    entries = [line.split() for line in verified.read_text().splitlines() if line.strip().endswith('universe/binary-arm64/Packages')]
    if not any(v == [digest(data), str(len(data)), 'universe/binary-arm64/Packages'] for v in entries):
        raise ValueError('T106_TOOL_PACKAGE_INDEX_DIGEST_MISMATCH')
    blocks = []
    for block in data.decode().split('\n\n'):
        fields = dict(line.split(': ', 1) for line in block.splitlines() if line and not line.startswith(' ') and ': ' in line)
        if fields.get('Package') == 'ripgrep' and fields.get('Version') == VERSION and fields.get('Architecture') == ARCH:
            blocks.append(fields)
    if len(blocks) != 1 or blocks[0].get('SHA256') != PACKAGE_SHA or blocks[0].get('Filename') != FILENAME:
        raise ValueError('T106_TOOL_SIGNED_PACKAGE_PIN_MISMATCH')
    with (directory / 'InRelease').open('xb') as handle:
        handle.write(release.read_bytes())
    return {'inReleaseSha256': digest(release.read_bytes()), 'keyringSha256': digest(KEYRING.read_bytes()),
            'packagesSha256': digest(data), 'packagesBytes': len(data), 'packageStanza': blocks[0],
            'signatureCheck': str(directory / 'signature-check.json')}


def ensure_tool(*, with_bytes=False):
    os.umask(0o077)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    cached = sorted(OUTPUT.glob('tools-rg14-*/manifest.json'))
    if cached:
        verified = load_cached(cached[-1])
        return verified if with_bytes else verified[0]
    directory = OUTPUT / ('tools-rg14-' + secrets.token_hex(6))
    directory.mkdir(mode=0o700)
    # Download and extraction destinations are separate new empty directories;
    # this source is outside both, and must be invoked with Python -I.
    download, extracted = directory / 'download', directory / 'extracted'
    download.mkdir(mode=0o700)
    extracted.mkdir(mode=0o700)
    try:
        metadata = signed_metadata(directory)
        installed = subprocess.run(['dpkg-query', '-W', '-f=${Version} ${Architecture}', 'ripgrep'],
                                   cwd=ROOT, capture_output=True, text=True, timeout=5)
        package = download / 'ripgrep.deb'
        archived = [p for p in Path('/var/cache/apt/archives').glob('ripgrep*.deb') if digest(p.read_bytes()) == PACKAGE_SHA]
        if archived:
            data = archived[0].read_bytes()
            source = 'existing-exact-package-cache'
        else:
            opener = build_opener(ProxyHandler({}), HTTPSHandler())
            with opener.open(URL, timeout=30) as response:
                data = response.read(PACKAGE_BYTES + 1)
            source = 'fixed-https-download'
        with package.open('xb') as handle:
            handle.write(data)
        binary = binary_from_package(package)
        installed_matches = Path('/usr/bin/rg').read_bytes() == binary
        # Prefer the already installed bytes only AFTER independent archive match.
        with (extracted / 'rg').open('xb') as handle:
            handle.write(binary)
        (extracted / 'rg').chmod(0o700)
        version = subprocess.run([str(extracted / 'rg'), '--version'], cwd=ROOT,
                                 env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, capture_output=True, text=True, timeout=5)
        if version.returncode or not version.stdout.startswith('ripgrep 14.1.0\n'):
            raise ValueError('T106_TOOL_LOCAL_VERSION_MISMATCH')
        row = {'sourceUrl': URL, 'packageVersion': VERSION, 'architecture': ARCH,
               'packageSha256': PACKAGE_SHA, 'packageBytes': len(data), 'binarySha256': digest(binary),
               'binaryBytes': len(binary), 'actualLocalVersion': version.stdout, 'versionExitCode': version.returncode,
               'existingInstalledPackage': installed.stdout, 'existingBinaryByteMatched': installed_matches,
               'acquisition': source, 'independentSignedMetadata': metadata,
               'scope': 'private per-run test dependency, not frozen-image or global installation'}
        save(directory / 'manifest.json', row)
        metadata, verified_bytes = load_cached(directory / 'manifest.json')
        metadata['reused'] = False
        return (metadata, verified_bytes) if with_bytes else metadata
    except Exception as error:
        save(directory / 'failure.json', {'type': type(error).__name__,
                                         'code': str(error) if str(error).startswith('T106_') else None,
                                         'sourceUrl': URL, 'packageSha256': PACKAGE_SHA})
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare'])
    parser.parse_args()
    tool = ensure_tool()
    print(json.dumps({k: tool[k] for k in ('manifest', 'packageSha256', 'binarySha256', 'binaryBytes', 'reused')}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('T106_TOOL_PREPARATION_FAILED ' + type(error).__name__)
        raise SystemExit(1)
