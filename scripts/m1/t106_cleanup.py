"""Authenticated teardown of exactly one T-106-owned helper HOME.

T-105's cleanup requires a quiescent daemon only. After T-106's intentional lost
connection, completed tasks retain supervisors/guardians for the 600s session
retention. This entry uses the SAME hash-verified helper authentication and
admin/shutdown protocol, but first checks every retained PID's precise run
ownership, UID, ancestry and start tick. It is teardown, never a success path.
T-105 code is unchanged. No direct kill, arbitrary process stop or file deletion.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import sys
import time

SHA = 'c853353b330d790813fdd2a2d641c9a4738c6b96f50b53c2f4aa53acec31901f'


def stat_record(path):
    text = path.read_text()
    fields = text[text.rfind(')') + 2:].split()
    return {'state': fields[0], 'ppid': int(fields[1]), 'pgid': int(fields[2]), 'startTick': fields[19]}


def inspect(helper, base, token):
    rows = []
    probe = str(base / 'project/probe.py').encode()
    for path in Path('/proc').glob('[0-9]*'):
        try:
            args = (path / 'cmdline').read_bytes().split(b'\0')
            helper_owned = str(helper).encode() in args
            task_owned = probe in args and token.encode() in args
            if not helper_owned and not task_owned:
                continue
            st = stat_record(path / 'stat')
            uid = int(next(line for line in (path / 'status').read_text().splitlines() if line.startswith('Uid:')).split()[1])
            cwd = os.readlink(path / 'cwd')
            if uid != 1000:
                raise ValueError('T106_CLEANUP_WRONG_UID')
            if helper_owned and b'daemon' in args:
                kind = 'daemon'
            elif helper_owned and b'supervise-exec' in args and task_owned:
                kind = 'owned-supervisor-or-guardian'
            elif task_owned and not helper_owned:
                kind = 'owned-workload'
            else:
                raise ValueError('T106_CLEANUP_UNREVIEWED_PROCESS')
            if kind != 'daemon' and cwd not in (str(base / 'project'), str(base / 'project/cwd space')):
                raise ValueError('T106_CLEANUP_WRONG_CWD')
            rows.append({'pid': int(path.name), **st, 'kind': kind, 'uid': uid})
        except FileNotFoundError:
            continue
    return rows


def main():
    home, token = Path(sys.argv[1]), sys.argv[2]
    if not re.fullmatch('[a-f0-9]{24}', token) or str(home) != '/tmp/t105-' + token + '/home':
        raise ValueError('T106_CLEANUP_OUTSIDE_OWNED_HOME')
    base = Path('/workspace') / ('t106-' + token)
    helper = home / '.local/share/dsh-remote-helper/releases' / SHA / 'helper.py'
    before = inspect(helper, base, token)
    if not before:
        print(json.dumps({'before': [], 'after': [], 'action': 'already-exited', 'dataDeleted': False}))
        return
    if not home.exists() or home.resolve() != home or helper.is_symlink():
        raise ValueError('T106_CLEANUP_UNTRUSTED_PATH')
    if hashlib.sha256(helper.read_bytes()).hexdigest() != SHA or helper.stat().st_size != 217238:
        raise ValueError('T106_CLEANUP_HELPER_HASH_CHANGED')
    daemons = [r for r in before if r['kind'] == 'daemon']
    if len(daemons) != 1:
        raise ValueError('T106_CLEANUP_DAEMON_AMBIGUOUS')
    by_pid = {r['pid']: r for r in before}
    for row in before:
        current, seen = row, set()
        while current['kind'] != 'daemon':
            if current['pid'] in seen or current['ppid'] not in by_pid:
                raise ValueError('T106_CLEANUP_ANCESTRY_UNKNOWN')
            seen.add(current['pid'])
            current = by_pid[current['ppid']]
    signal.alarm(25)
    sys.dont_write_bytecode = True
    os.environ['HOME'] = str(home)
    os.environ['DSH_REMOTE_HELPER_RUNTIME_DIR'] = str(home.parent / 'runtime')
    spec = importlib.util.spec_from_file_location('t106_verified_helper', helper)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    sock = module.socket_connect(module.runtime_socket_path(None))
    try:
        sock.settimeout(8)
        outgoing, incoming = module.authenticate_socket(sock, module.transport_key(module.runtime_socket_path(None)), False)
        source, destination = sock.makefile('rb'), sock.makefile('wb')
        try:
            reader = module.AuthenticatedReader(source, incoming)
            writer = module.AuthenticatedWriter(destination, outgoing)
            hello = json.loads(reader.readline(module.MAX_FRAME))
            if hello['method'] != 'server/hello' or hello['params']['helperVersion'] != '0.13.1':
                raise ValueError('T106_CLEANUP_WRONG_HELPER')
            for ident, method, params in [
                ('t106-cleanup-init', 'initialize', {'clientId': 't106-cleanup', 'protocol': {'min': 1, 'max': 1}}),
                ('t106-cleanup-stop', 'admin/shutdown', {}),
            ]:
                writer.write((json.dumps({'dshRpc': module.PROTOCOL, 'id': ident, 'method': method, 'params': params}) + '\n').encode())
                writer.flush()
                reply = json.loads(reader.readline(module.MAX_FRAME))
                if reply.get('id') != ident or 'error' in reply:
                    raise ValueError('T106_CLEANUP_RPC_REJECTED')
            if reply['result'].get('shuttingDown') is not True:
                raise ValueError('T106_CLEANUP_UNACKNOWLEDGED')
        finally:
            source.close()
            destination.close()
    finally:
        sock.close()
    end = time.monotonic() + 8
    while True:
        retained = []
        for row in before:
            try:
                current = stat_record(Path('/proc') / str(row['pid']) / 'stat')
                if current['startTick'] == row['startTick']:
                    retained.append({'pid': row['pid'], **current})
            except FileNotFoundError:
                continue
        if not retained or time.monotonic() >= end:
            break
        time.sleep(0.1)
    after = inspect(helper, base, token)
    print(json.dumps({'action': 'authenticated-admin-shutdown', 'acknowledged': True, 'before': before,
                      'after': after, 'unreaped': retained, 'releaseRetained': helper.exists(), 'dataDeleted': False}))
    if after or retained:
        raise SystemExit(1)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('T106_CLEANUP_FAILED ' + type(error).__name__, file=sys.stderr)
        raise SystemExit(1)
