"""Fixed read-only worker, sent through the bound helper command channel.
No network, installation, repository mutation, or central filesystem fallback.
"""
import fnmatch
import hashlib
import json
import os
import selectors
import stat
import subprocess
import sys
import time

LIMIT = 196608
DEADLINE = time.monotonic() + 12


def check(condition, code):
    if not condition:
        raise ValueError(code)


def deadline():
    check(time.monotonic() < DEADLINE, 'read-deadline')


def path_at(root, relative=''):
    check(isinstance(relative, str) and not relative.startswith('/') and '\\' not in relative
          and '\0' not in relative and all(p not in ('', '.', '..') for p in relative.split('/'))
          if relative else relative == '', 'path-outside-binding')
    current = root
    for part in relative.split('/') if relative else []:
        check(part != '.agent-studio-binding.json', 'reserved-path')
        current = os.path.join(current, part)
        check(not os.path.islink(current), 'symlink-unsupported')
    check(os.path.commonpath([root, os.path.realpath(current)]) == root, 'path-outside-binding')
    return current


def git(repo, args, allowed=(0,)):
    deadline()
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_SYSTEM='/dev/null', GIT_CONFIG_GLOBAL='/dev/null',
               GIT_TERMINAL_PROMPT='0', GIT_OPTIONAL_LOCKS='0', GIT_PAGER='cat', LC_ALL='C.UTF-8')
    command = ['git', '--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false',
               '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false', '-C', repo] + args
    proc = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    chunks, total = {1: [], 2: []}, 0
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(proc.stdout, selectors.EVENT_READ, 1)
            selector.register(proc.stderr, selectors.EVENT_READ, 2)
            while selector.get_map():
                deadline()
                for key, _ in selector.select(.1):
                    data = os.read(key.fd, 16384)
                    if not data:
                        selector.unregister(key.fileobj)
                        continue
                    total += len(data)
                    check(total <= LIMIT, 'git-output-limit')
                    chunks[key.data].append(data)
        proc.wait(timeout=max(.1, DEADLINE - time.monotonic()))
        check(proc.returncode in allowed, 'git-command-failed')
        return proc.returncode, b''.join(chunks[1]).decode('utf-8', 'strict')
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=2)
        proc.stdout.close()
        proc.stderr.close()


def repository(root, relative):
    repo = path_at(root, relative)
    check(os.path.isdir(repo), 'not-directory')
    metadata = os.path.join(repo, '.git')
    if not os.path.lexists(metadata):
        return repo, None
    check(not os.path.islink(metadata) and os.path.isdir(metadata), 'linked-git-dir-unsupported')
    for name in ('config', 'objects', 'refs', 'HEAD', 'index'):
        check(not os.path.islink(os.path.join(metadata, name)), 'linked-git-metadata-unsupported')
    check(not os.path.lexists(os.path.join(metadata, 'objects/info/alternates')), 'git-alternates-unsupported')
    with open(os.path.join(metadata, 'config'), 'rb') as handle:
        config = handle.read(65537)
    check(len(config) <= 65536 and b'[include' not in config.lower(), 'git-config-unsupported')
    _, top = git(repo, ['rev-parse', '--show-toplevel'])
    check(top.rstrip('\n') == repo, 'git-root-mismatch')
    _, branch = git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], (0, 1))
    code, head = git(repo, ['rev-parse', '--verify', 'HEAD'], (0, 128))
    info = os.stat(metadata)
    identity = hashlib.sha256(f'{repo}\0{info.st_dev}\0{info.st_ino}'.encode()).hexdigest()
    return repo, {'root': repo, 'repo_id': identity, 'branch': branch.rstrip('\n') or None,
                  'detached': not bool(branch), 'unborn': code != 0, 'head': head.strip() if code == 0 else None}


def git_read(root, payload):
    repo, identity = repository(root, payload.get('repo', ''))
    method = payload['method']
    if identity is None:
        check(method in ('git.status', 'git.worktrees'), 'not-a-repository')
        return {'isRepo': False, 'entries': [], 'repositories': [], 'truncated': False, 'complete': True}
    expected = payload.get('repo_id')
    check(expected is None or expected == identity['repo_id'], 'repository-changed')
    common = {**identity, 'isRepo': True, 'complete': True, 'truncated': False, 'limitBytes': LIMIT}
    if method in ('git.status', 'git.worktrees'):
        _, raw = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'])
        fields, rows, index = raw.split('\0'), [], 0
        while index < len(fields) and fields[index]:
            value = fields[index]
            index += 1
            check(len(value) >= 4, 'invalid-git-status')
            xy, path = value[:2], value[3:]
            if path == '.agent-studio-binding.json':
                continue
            path_at(repo, path)
            row = {'path': path, 'xy': xy}
            if 'R' in xy or 'C' in xy:
                check(index < len(fields), 'invalid-git-status')
                row['originalPath'] = fields[index]
                path_at(repo, fields[index])
                index += 1
            rows.append(row)
        for staged, key in [(False, 'unstaged'), (True, 'staged')]:
            _, counts = git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all', '--numstat', '-z'] + (['--cached'] if staged else []) + ['--'])
            by_path = {}
            for value in counts.split('\0'):
                if not value:
                    continue
                add, remove, path = value.split('\t', 2)
                by_path[path] = {'binary': True} if add == '-' else {'additions': int(add), 'deletions': int(remove)}
            for row in rows:
                if row['path'] in by_path:
                    row[key] = by_path[row['path']]
        check(len(rows) <= 1000, 'git-entry-limit')
        return {**common, 'entries': rows, 'repositories': [repo]}
    check(method in ('git.diff', 'git.diff-head'), 'unsupported-git-read')
    args = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all', '--no-color', '--unified=3']
    if method == 'git.diff-head':
        check(not identity['unborn'], 'unborn-head-diff-unavailable')
        args += ['HEAD']
    elif payload.get('staged'):
        args += ['--cached']
    args += ['--']
    if payload.get('path') is not None:
        path_at(repo, payload['path'])
        args.append(payload['path'])
    _, diff = git(repo, args)
    return {**common, 'diff': diff, 'side': 'index' if payload.get('staged') else 'worktree'}


def search(root, payload):
    query, mode = payload['query'], payload['mode']
    check(isinstance(query, str) and 0 < len(query) <= 256 and '\0' not in query, 'invalid-query')
    check(mode in ('name', 'content'), 'invalid-search-mode')
    patterns = payload.get('exclude', [])
    check(isinstance(patterns, list) and len(patterns) <= 32 and all(isinstance(p, str) and len(p) <= 256 for p in patterns), 'invalid-exclude')
    matches, dirs, hits, reasons = [], [], [], set()
    visited, scanned_bytes, emitted_bytes = 0, 0, 0
    stack = [('', 0)]
    while stack:
        relative, depth = stack.pop()
        deadline()
        with os.scandir(path_at(root, relative)) as entries:
            # Bound materialization, including directories full of excluded names.
            children = []
            for entry in entries:
                visited += 1
                if visited > 5000:
                    reasons.add('entry-limit')
                    break
                children.append(entry.name)
        for name in sorted(children):
            path = '/'.join(p for p in (relative, name) if p)
            if name in ('.git', '.agent-studio-binding.json') or any(fnmatch.fnmatchcase(path, p) or fnmatch.fnmatchcase(name, p) for p in patterns):
                continue
            absolute = os.path.join(root, path)
            if os.path.islink(absolute):
                reasons.add('symlink-skipped')
                continue
            metadata = os.lstat(path_at(root, path))
            is_dir = stat.S_ISDIR(metadata.st_mode)
            if is_dir:
                if depth < 24:
                    stack.append((path, depth + 1))
                else:
                    reasons.add('depth-limit')
            elif not stat.S_ISREG(metadata.st_mode):
                reasons.add('special-file-skipped')
                continue
            found = []
            if mode == 'name':
                if query.casefold() in path.casefold():
                    found = [{'path': absolute, 'line': None, 'isDir': is_dir}]
            elif not is_dir:
                if metadata.st_size > LIMIT:
                    reasons.add('file-size-limit')
                    continue
                scanned_bytes += metadata.st_size
                if scanned_bytes > 8 * 1024 * 1024:
                    reasons.add('scan-byte-limit')
                    break
                with open(path_at(root, path), 'rb') as handle:
                    data = handle.read(LIMIT + 1)
                    after = os.fstat(handle.fileno())
                check((metadata.st_ino, metadata.st_size, metadata.st_mtime_ns, metadata.st_ctime_ns) ==
                      (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'search-file-changed')
                if b'\0' in data:
                    reasons.add('binary-skipped')
                    continue
                try:
                    text = data.decode('utf-8', 'strict')
                except UnicodeDecodeError:
                    reasons.add('encoding-skipped')
                    continue
                for line, text in enumerate(text.splitlines(), 1):
                    column = text.casefold().find(query.casefold())
                    if column >= 0:
                        found.append({'path': absolute, 'line': line, 'column': column + 1,
                                      'preview': text[:240], 'isDir': False})
                        if len(found) >= 200:
                            reasons.add('match-limit')
                            break
            for hit in found:
                emitted_bytes += len(json.dumps(hit).encode())
                if len(hits) >= 200 or emitted_bytes > 98304:
                    reasons.add('match-limit')
                    break
                hits.append(hit)
                if hit['path'] not in matches:
                    matches.append(hit['path'])
                    if hit['isDir']:
                        dirs.append(hit['path'])
            if 'match-limit' in reasons:
                break
        if reasons.intersection({'entry-limit', 'match-limit', 'scan-byte-limit'}):
            break
    return {'matches': matches, 'dirs': dirs, 'hits': hits, 'mode': mode, 'complete': not reasons,
            'truncated': bool(reasons), 'reasons': sorted(reasons), 'visited': visited,
            'limits': {'entries': 5000, 'matches': 200, 'fileBytes': LIMIT, 'scanBytes': 8388608, 'depth': 24},
            'engine': 'bounded-python-literal-utf8', 'caseSensitive': False}


def main():
    root, payload = sys.argv[1], json.loads(sys.argv[2])
    check(os.getcwd() == root and os.path.realpath(root) == root, 'worker-root-mismatch')
    if payload['method'].startswith('git.'):
        result = git_read(root, payload)
    elif payload['method'] == 'fs.search':
        result = search(root, payload)
    else:
        raise ValueError('unknown-read-method')
    wire = json.dumps({'ok': True, 'value': result}, ensure_ascii=False)
    check(len(wire.encode()) <= 262144, 'result-limit')
    print(wire, flush=True)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(json.dumps({'ok': False, 'error': str(error) if isinstance(error, ValueError) else type(error).__name__}), flush=True)
        sys.exit(1)
