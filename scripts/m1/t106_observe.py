"""Read-only independent observer; sent to the existing container with Python -I.

Never executes a success workload, follows a symlink, opens secrets, or changes
files/processes. Reads bytes only below the exact random test root, the known
helper asset/private tool/profile, and preexisting identity marker. Never reads
runtime credentials. Environment output is two presence booleans only.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import time

SHA = 'c853353b330d790813fdd2a2d641c9a4738c6b96f50b53c2f4aa53acec31901f'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_snapshot(base):
    rows = []
    if not base.exists():
        return rows
    if base.is_symlink():
        raise ValueError('T106_OBSERVER_SYMLINK_ROOT')
    def walk(directory):
        for path in sorted(directory.iterdir()):
            if len(rows) >= 1000:
                raise ValueError('T106_OBSERVER_FILE_LIMIT')
            st = path.lstat()
            row = {'path': str(path.relative_to(base))}
            if stat.S_ISLNK(st.st_mode):
                row.update(kind='symlink', target=os.readlink(path))
            elif stat.S_ISDIR(st.st_mode):
                row['kind'] = 'dir'
                rows.append(row)
                if path.name != '.git':
                    walk(path)
                continue
            elif stat.S_ISREG(st.st_mode):
                if st.st_size > 196608:
                    raise ValueError('T106_OBSERVER_BYTE_LIMIT')
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, 'rb') as handle:
                    current = os.fstat(handle.fileno())
                    if (st.st_dev, st.st_ino) != (current.st_dev, current.st_ino):
                        raise ValueError('T106_OBSERVER_FILE_REPLACED')
                    data = handle.read(196609)
                if len(data) > 196608:
                    raise ValueError('T106_OBSERVER_BYTE_LIMIT')
                row.update(kind='file', bytes=len(data), sha256=digest(data), base64=base64.b64encode(data).decode())
            else:
                raise ValueError('T106_OBSERVER_UNEXPECTED_FILE_TYPE')
            rows.append(row)
    walk(base)
    return sorted(rows, key=lambda r: r['path'])


def private_tool_snapshot(home):
    rows = {}
    for name, relative, maximum in [('binary', '.t106-tools/bin/rg', 6 * 1024**2), ('profile', '.profile', 1024)]:
        path = home / relative
        if any(p.is_symlink() for p in (path, *path.parents)):
            raise ValueError('T106_PRIVATE_TOOL_SYMLINK')
        if not path.exists():
            rows[name] = {'exists': False}
            continue
        st = path.lstat()
        if not stat.S_ISREG(st.st_mode) or st.st_size > maximum:
            raise ValueError('T106_PRIVATE_TOOL_TYPE_OR_SIZE')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as handle:
            current = os.fstat(handle.fileno())
            if (st.st_dev, st.st_ino) != (current.st_dev, current.st_ino):
                raise ValueError('T106_PRIVATE_TOOL_REPLACED')
            data = handle.read(maximum + 1)
        if len(data) != st.st_size or len(data) > maximum:
            raise ValueError('T106_PRIVATE_TOOL_SIZE_CHANGED')
        rows[name] = {'exists': True, 'bytes': len(data), 'sha256': digest(data),
                      'uid': st.st_uid, 'mode': stat.S_IMODE(st.st_mode)}
        if name == 'profile':
            rows[name]['base64'] = base64.b64encode(data).decode()
    return rows


def proc_stat(path):
    # comm may contain spaces; field indexes below are after the final ')'.
    text = path.read_text()
    fields = text[text.rfind(')') + 2:].split()
    return {'state': fields[0], 'ppid': int(fields[1]), 'pgid': int(fields[2]),
            'sid': int(fields[3]), 'tty': int(fields[4]), 'tpgid': int(fields[5]), 'startTick': fields[19]}


def observe(token, home, request):
    base = Path('/workspace') / ('t106-' + token)
    helper = home / '.local/share/dsh-remote-helper/releases' / SHA / 'helper.py'
    probe = str(base / 'project/probe.py').encode()
    groups = set(request.get('groups', []))
    rows = []
    for path in Path('/proc').glob('[0-9]*'):
        try:
            args = (path / 'cmdline').read_bytes().split(b'\0')
            st = proc_stat(path / 'stat')
            owned = probe in args and token.encode() in args
            helper_owned = str(helper).encode() in args
            if not owned and not helper_owned and st['pgid'] not in groups:
                continue
            env = (path / 'environ').read_bytes().split(b'\0')
            status = (path / 'status').read_text().splitlines()
            uid = int(next(line for line in status if line.startswith('Uid:')).split()[1])
            mode = args[args.index(probe) + 1].decode() if owned and not helper_owned else None
            rows.append({'pid': int(path.name), **st, 'uid': uid, 'cwd': os.readlink(path / 'cwd'),
                         'mode': mode, 'belongsToRun': owned or helper_owned,
                         'kind': ('daemon' if b'daemon' in args else 'supervisor-or-guardian' if b'supervise-exec' in args else 'connector')
                         if helper_owned else 'workload' if owned else 'other-group-member',
                         'ownerTokenPresent': any(v.startswith(b'CODER_SESSION_TOKEN=') for v in env),
                         'agentTokenPresent': any(v.startswith(b'CODER_AGENT_TOKEN=') for v in env)})
        except FileNotFoundError:
            continue
    tracked = []
    for row in request.get('tracked', []):
        path = Path('/proc') / str(row['pid']) / 'stat'
        try:
            current = proc_stat(path)
            tracked.append({'pid': row['pid'], 'startTick': row['startTick'],
                            'state': current['state'] if current['startTick'] == row['startTick'] else 'reused'})
        except FileNotFoundError:
            tracked.append({'pid': row['pid'], 'startTick': row['startTick'], 'state': 'gone'})
    marker = Path('/run/agent-studio/identity.json').read_bytes()
    top = []
    for path in sorted(Path('/workspace').iterdir()):
        if path.name == base.name:
            continue
        st = path.lstat()
        top.append({'name': path.name, 'mode': st.st_mode, 'size': st.st_size, 'mtimeNs': st.st_mtime_ns})
    return {'files': file_snapshot(base), 'rootExists': base.exists(), 'processes': rows, 'tracked': tracked,
            'identityMarkerSha256': digest(marker), 'nonTargetTopLevel': top, 'privateTools': private_tool_snapshot(home),
            'helper': {'exists': helper.exists(), 'sha256': digest(helper.read_bytes()) if helper.exists() else None,
                       'bytes': helper.stat().st_size if helper.exists() else None}}


def main():
    token, home_text, encoded = sys.argv[1:4]
    if not re.fullmatch('[a-f0-9]{24}', token) or home_text != '/tmp/t105-' + token + '/home':
        raise ValueError('T106_OBSERVER_SCOPE')
    request = json.loads(encoded)
    for row in request.get('tracked', []):
        if type(row['pid']) is not int or row['pid'] <= 1 or not str(row['startTick']).isdigit():
            raise ValueError('T106_OBSERVER_BAD_PID')
    wait_for = request.get('waitFor')
    if wait_for and (wait_for.startswith('/') or any(p in ('..', '.', '') for p in wait_for.split('/'))):
        raise ValueError('T106_OBSERVER_BAD_PATH')
    end = time.monotonic() + 9
    while True:
        result = observe(token, Path(home_text), request)
        ready = (not wait_for or any(f['path'] == wait_for for f in result['files']))
        gone = not request.get('waitGone') or all(r['state'] in ('gone', 'reused') for r in result['tracked'])
        if ready and gone or time.monotonic() >= end:
            result['waitSatisfied'] = ready and gone
            print(json.dumps(result, ensure_ascii=False))
            return
        time.sleep(0.1)


if __name__ == '__main__':
    main()
