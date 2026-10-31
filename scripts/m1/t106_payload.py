"""Bounded synthetic workloads uploaded and executed ONLY by the T-106 provider.

No credentials, network, arbitrary paths or daemonization. Every process has a
25 second bound; process IDs and the 24-hex run token permit independent /proc
observation. A transport exit is never treated as remote termination.
"""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time


def emit(kind, **fields):
    value = {'event': kind, 'pid': os.getpid(), 'pgid': os.getpgrp(), **fields}
    print(json.dumps(value, ensure_ascii=False), flush=True)
    return value


def stored(name, value):
    with Path(name).open('x', encoding='utf-8') as handle:
        json.dump(value, handle, ensure_ascii=False)
        handle.flush()
        os.fsync(handle.fileno())


def deadline(signum, frame):
    raise TimeoutError('T106_WORKLOAD_DEADLINE')


def command(token):
    value = emit('command-ready', uid=os.getuid(), cwd=os.getcwd(), host=os.uname().nodename,
                 argv=sys.argv[3:], env=os.environ.get('T106_VALUE'), token=token,
                 isatty=[os.isatty(n) for n in (0, 1, 2)])
    stored('command-identity.json', value)
    print('stderr exact: quotes \'" and UTF-8 中文', file=sys.stderr, flush=True)
    if sys.stdin.readline() != 'finish\n':
        raise RuntimeError('T106_UNEXPECTED_COMMAND_INPUT')
    print('stdout finished', flush=True)
    raise SystemExit(17)


def cancel_child(token):
    def term(signum, frame):
        stored('cancel-child-term.json', {'pid': os.getpid(), 'signal': signum, 'token': token})
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, term)
    stored('cancel-child-ready.json', emit('cancel-child-ready', token=token))
    while True:
        signal.pause()


def cancel_parent(token):
    seen = []
    signal.signal(signal.SIGTERM, lambda signum, frame: seen.append(signum))
    child = subprocess.Popen([sys.executable, '-I', __file__, 'cancel-child', token])
    try:
        end = time.monotonic() + 5
        while not Path('cancel-child-ready.json').exists() and time.monotonic() < end:
            time.sleep(0.02)
        if not Path('cancel-child-ready.json').exists():
            raise RuntimeError('T106_CHILD_READY_DEADLINE')
        stored('cancel-parent-ready.json', emit('cancel-parent-ready', child=child.pid, token=token))
        while not seen:
            time.sleep(0.02)
        # No signal forwarding: child's TERM record proves provider group delivery.
        code = child.wait(timeout=5)
        stored('cancel-parent-reaped.json', emit('cancel-parent-reaped', child=child.pid,
               childExit=code, signals=seen, forwardedSignal=False, token=token))
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=5)
            print('T106 emergency owned-child cleanup', file=sys.stderr, flush=True)


def terminal(token):
    signal.signal(signal.SIGTTOU, signal.SIG_IGN)
    ready_read, ready_write = os.pipe()
    child = os.fork()
    if child == 0:
        signal.alarm(25)  # alarm is not inherited by fork.
        os.close(ready_read)
        os.setpgid(0, 0)
        def interrupt(signum, frame):
            stored('pty-child-signal.json', emit('pty-child-signal', signal=signum, token=token))
            raise SystemExit(23)
        signal.signal(signal.SIGINT, interrupt)
        os.write(ready_write, b'R')
        os.close(ready_write)
        while os.tcgetpgrp(0) != os.getpgrp():
            time.sleep(0.01)
        size = os.get_terminal_size(0)
        stored('pty-ready.json', emit('pty-ready', parent=os.getppid(), token=token,
               isatty=[os.isatty(n) for n in (0, 1, 2)], rows=size.lines, cols=size.columns, foreground=os.tcgetpgrp(0)))
        while True:
            line = sys.stdin.readline().rstrip('\n')
            if line.startswith('input '):
                emit('pty-input', text=line[6:])
            elif line == 'size':
                size = os.get_terminal_size(0)
                stored('pty-resize.json', emit('pty-resize', rows=size.lines, cols=size.columns))
            else:
                raise RuntimeError('T106_UNEXPECTED_PTY_INPUT')
    os.close(ready_write)
    reaped = False
    try:
        if os.read(ready_read, 1) != b'R':
            raise RuntimeError('T106_PTY_CHILD_NOT_READY')
        os.close(ready_read)
        os.tcsetpgrp(0, child)
        pid, status = os.waitpid(child, 0)
        reaped = True
        os.tcsetpgrp(0, os.getpgrp())
        stored('pty-parent-reaped.json', emit('pty-parent-reaped', child=pid,
               childExit=os.waitstatus_to_exitcode(status), foreground=os.tcgetpgrp(0), token=token))
    finally:
        if not reaped:
            try:
                os.kill(child, signal.SIGTERM)
                os.waitpid(child, 0)
            except ProcessLookupError:
                print('T106 PTY child already gone during cleanup', file=sys.stderr, flush=True)


def uncertain(token):
    # An append exposes repeated execution even if the exclusive record rejects it.
    with Path('uncertain-count.txt').open('a', encoding='ascii') as handle:
        handle.write(token + '\n')
        handle.flush()
        os.fsync(handle.fileno())
    stored('uncertain-effect.json', emit('uncertain-started', token=token))
    time.sleep(3)
    stored('uncertain-finished.json', {'pid': os.getpid(), 'token': token})


def main():
    mode, token = sys.argv[1:3]
    if not re.fullmatch('[a-f0-9]{24}', token):
        raise ValueError('T106_INVALID_RUN_TOKEN')
    root = Path('/workspace') / ('t106-' + token) / 'project'
    if Path.cwd().resolve() not in (root, root / 'cwd space'):
        raise ValueError('T106_OUTSIDE_SYNTHETIC_PROJECT')
    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(25)
    {'command': command, 'cancel': cancel_parent, 'cancel-child': cancel_child,
     'pty': terminal, 'uncertain': uncertain}[mode](token)


if __name__ == '__main__':
    main()
