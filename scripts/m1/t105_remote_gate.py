"""Inline, read-only preflight on the very SSH process that will exec the helper.

This file is sent as a Python -I -c argument, not installed on the workspace.
The gate consumes exactly one acknowledgement line, leaving helper stdin intact.
It is not a same-UID security boundary and never authenticates from a new marker.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import pwd
import signal
import sys


def observation(root):
    marker = Path('/run/agent-studio/identity.json')
    return {
        'marker': json.loads(marker.read_text()),
        'uid': os.getuid(), 'user': pwd.getpwuid(os.getuid()).pw_name,
        'root': str(Path(root).resolve(strict=True)),
        'channel': {key: os.environ.get(key) for key in (
            'CODER_WORKSPACE_ID', 'CODER_WORKSPACE_NAME',
            'CODER_WORKSPACE_AGENT_NAME', 'CODER_WORKSPACE_OWNER_NAME')},
    }


def main():
    payload = json.loads(base64.b64decode(sys.argv[1]))
    signal.alarm(30)
    before = observation(payload['root'])
    line = json.dumps(before, sort_keys=True, separators=(',', ':')).encode()
    print(line.decode(), flush=True)
    ack = bytearray()
    while len(ack) <= 128:
        char = os.read(0, 1)
        if not char:
            raise SystemExit(78)
        ack += char
        if char == b'\n':
            break
    expected_ack = b'DISPATCH ' + hashlib.sha256(line).hexdigest().encode() + b'\n'
    if bytes(ack) != expected_ack or observation(payload['root']) != before:
        raise SystemExit(78)
    # This process cannot reconnect or resolve the alias again between check and exec.
    signal.alarm(0)
    if payload['mode'] == 'probe':
        print(json.dumps({'identityAccepted': True}), flush=True)
        return
    home = Path(payload['remoteHome'])
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.environ['HOME'] = str(home)
    os.environ['DSH_REMOTE_HELPER_RUNTIME_DIR'] = str(home.parent / 'runtime')
    os.environ['DSH_REMOTE_HELPER_ALLOW_SHUTDOWN'] = '1'
    # The owner token is never sent here. Do not forward Agent credentials to helper.
    os.environ.pop('CODER_AGENT_TOKEN', None)
    os.environ.pop('CODER_SESSION_TOKEN', None)
    os.chdir('/workspace')
    os.execl('/bin/sh', 'sh', '-c', payload['command'])


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Do not echo environment, payload, urllib errors or secret-bearing diagnostics.
        print('T105_REMOTE_GATE_FAILED ' + type(error).__name__, file=sys.stderr)
        raise SystemExit(78)
