"""Fixed read-only /proc observation. Parameters come from the central owned task row.

No command execution, arbitrary path traversal, Docker observer, or environment dump.
The original binding marker, UID, cwd and helper-acknowledged PID delimit the probe.
"""
import base64
import json
import os
from pathlib import Path
import sys


def observe(expected):
    root = Path(expected['root'])
    marker = json.loads((root / '.agent-studio-binding.json').read_text())
    if marker != expected['owner'] or str(root.resolve(strict=True)) != str(root):
        raise ValueError('D08_ROOT_IDENTITY')
    pid = expected['pid']
    if type(pid) is not int or pid <= 1 or os.getuid() != expected['uid']:
        raise ValueError('D08_PROCESS_SCOPE')
    proc = Path('/proc') / str(pid)
    try:
        before = (proc / 'stat').read_text().rsplit(') ', 1)[1].split()
        uid = proc.stat().st_uid
        cwd = os.readlink(proc / 'cwd')
        after = (proc / 'stat').read_text().rsplit(') ', 1)[1].split()
    except (FileNotFoundError, ProcessLookupError):
        return {'exists': False, 'pid': pid}
    if before[19] != after[19] or uid != expected['uid']:
        raise ValueError('D08_PROCESS_IDENTITY')
    if cwd != expected['cwd'] or not (cwd == str(root) or cwd.startswith(str(root) + '/')):
        raise ValueError('D08_PROCESS_CWD')
    return {'exists': True, 'pid': pid, 'start_ticks': after[19], 'pgid': int(after[2]),
            'sid': int(after[3]), 'uid': uid, 'cwd': cwd, 'state': after[0]}


if __name__ == '__main__':
    try:
        request = json.loads(base64.b64decode(sys.argv[1]))
        result = observe(request)
        print(json.dumps({'generation': request['owner']['generation'], 'operation_id': request['operation_id'],
                          'request_sha256': request['request_sha256'], 'process': result}), flush=True)
    except Exception as error:
        print(json.dumps({'error': str(error) if isinstance(error, ValueError) else type(error).__name__}), file=sys.stderr)
        raise SystemExit(78)
