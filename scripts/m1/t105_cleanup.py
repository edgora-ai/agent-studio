"""Gracefully stop only a T-105-owned helper daemon; keep its release and data.

Executed with python3 -I inside the dedicated workspace by the control-plane
observer, after the candidate's real session/disposer has closed. The candidate
has an intentional 600-second daemon idle lifetime; SSH exit is not termination.
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


def processes(helper):
    rows = []
    for path in Path('/proc').glob('[0-9]*'):
        try:
            args = (path / 'cmdline').read_bytes().split(b'\0')
            if str(helper).encode() not in args:
                continue
            stat = (path / 'stat').read_text().split()
            rows.append({'pid': int(path.name), 'startTick': stat[21], 'kind': 'daemon' if b'daemon' in args else 'other'})
        except FileNotFoundError:
            continue
    return rows


def main():
    home = Path(sys.argv[1])
    if not re.fullmatch(r'/tmp/t105-[a-z0-9-]+/home', str(home)):
        raise ValueError('T105_CLEANUP_OUTSIDE_SYNTHETIC_ROOT')
    helper = home / '.local/share/dsh-remote-helper/releases' / SHA / 'helper.py'
    before = processes(helper)
    if not before:
        print(json.dumps({'before': [], 'after': [], 'action': 'already-exited'}))
        return
    if len(before) != 1 or before[0]['kind'] != 'daemon':
        raise ValueError('T105_CLEANUP_NOT_QUIESCENT')
    if hashlib.sha256(helper.read_bytes()).hexdigest() != SHA:
        raise ValueError('T105_CLEANUP_HELPER_HASH_CHANGED')
    signal.alarm(20)
    sys.dont_write_bytecode = True
    os.environ['HOME'] = str(home)
    os.environ['DSH_REMOTE_HELPER_RUNTIME_DIR'] = str(home.parent / 'runtime')
    spec = importlib.util.spec_from_file_location('t105_verified_helper', helper)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    sock = module.socket_connect(module.runtime_socket_path(None))
    try:
        sock.settimeout(5)
        outgoing, incoming = module.authenticate_socket(sock, module.transport_key(module.runtime_socket_path(None)), False)
        source, destination = sock.makefile('rb'), sock.makefile('wb')
        try:
            reader = module.AuthenticatedReader(source, incoming)
            writer = module.AuthenticatedWriter(destination, outgoing)
            hello = json.loads(reader.readline(module.MAX_FRAME))
            if hello['method'] != 'server/hello' or hello['params']['helperVersion'] != '0.13.1':
                raise ValueError('T105_CLEANUP_WRONG_HELPER')
            for ident, method, params in [
                ('t105-cleanup-init', 'initialize', {'clientId': 't105-cleanup', 'protocol': {'min': 1, 'max': 1}}),
                ('t105-cleanup-stop', 'admin/shutdown', {}),
            ]:
                writer.write((json.dumps({'dshRpc': module.PROTOCOL, 'id': ident, 'method': method, 'params': params}) + '\n').encode())
                writer.flush()
                reply = json.loads(reader.readline(module.MAX_FRAME))
                if reply.get('id') != ident or 'error' in reply:
                    raise ValueError('T105_CLEANUP_RPC_REJECTED')
            if reply['result'].get('shuttingDown') is not True:
                raise ValueError('T105_CLEANUP_UNACKNOWLEDGED')
        finally:
            source.close()
            destination.close()
    finally:
        sock.close()
    deadline = time.monotonic() + 8
    while processes(helper) and time.monotonic() < deadline:
        time.sleep(0.1)
    after = processes(helper)
    # Preserve PID/start-time evidence: zombies are not running, but are not reaped.
    retained = []
    for row in before:
        path = Path('/proc') / str(row['pid']) / 'stat'
        if path.exists():
            stat = path.read_text().split()
            if stat[21] == row['startTick']:
                retained.append({'pid': row['pid'], 'state': stat[2], 'startTick': stat[21]})
    if after:
        raise ValueError('T105_CLEANUP_STILL_RUNNING')
    print(json.dumps({'action': 'authenticated-admin-shutdown', 'acknowledged': True,
                      'before': before, 'after': after, 'unreaped': retained,
                      'releaseRetained': helper.exists(), 'dataDeleted': False}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('T105_CLEANUP_FAILED ' + type(error).__name__, file=sys.stderr)
        raise SystemExit(1)
