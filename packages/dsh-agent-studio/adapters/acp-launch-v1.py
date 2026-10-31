#!/usr/bin/env python3
"""Versioned bound-process bootstrap, not an ACP agent or a sandbox.

The authenticated host supplies this immutable manifest, never a browser path.
No credential value is in argv, identity output, or error diagnostics.
"""
import base64
import hashlib
import json
import os
import re
import stat
import sys


def require(condition):
    if not condition:
        raise ValueError("ACP launch contract rejected")


def regular_digest(path, limit=536870912):
    require(os.path.isabs(path) and os.path.realpath(path) == path)
    info = os.lstat(path)
    require(stat.S_ISREG(info.st_mode) and info.st_size <= limit)
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1048576), b""):
            digest.update(chunk)
    return digest.hexdigest()


def private_directory(path):
    require(os.path.isabs(path))
    os.makedirs(path, mode=0o700, exist_ok=True)
    info = os.lstat(path)
    require(stat.S_ISDIR(info.st_mode) and os.path.realpath(path) == path and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0)


def main():
    require(len(sys.argv) == 2 and len(sys.argv[1]) <= 49152)
    raw = base64.b64decode(sys.argv[1], validate=True)
    manifest = json.loads(raw)
    require(set(manifest) == {"version", "binding_id", "binding_version", "task_id", "instance_id", "root", "backend_id", "executable", "executable_sha256", "argv", "files", "private_home", "environment", "credential_names", "bootstrap_sha256"})
    require(manifest["version"] == 1 and re.fullmatch(r"binding-[a-f0-9-]{36}", manifest["binding_id"]) and isinstance(manifest["binding_version"], int) and manifest["binding_version"] > 0)
    require(re.fullmatch(r"[a-z][a-z0-9-]{0,70}", manifest["backend_id"]) is not None)
    root = manifest["root"]
    require(os.path.isabs(root) and os.path.realpath(root) == root and os.getcwd() == root)
    home_root = manifest["private_home"]
    require(home_root == os.environ.get("HOME"))
    private_directory(home_root)
    require(regular_digest(os.path.realpath(sys.executable)) == manifest["bootstrap_sha256"])
    executable = manifest["executable"]
    require(regular_digest(executable) == manifest["executable_sha256"] and os.access(executable, os.X_OK))
    argv = manifest["argv"]
    require(isinstance(argv, list) and 1 <= len(argv) <= 64 and argv[0] == executable and all(isinstance(v, str) and len(v) <= 16384 and "\0" not in v for v in argv))
    require(isinstance(manifest["files"], list) and len(manifest["files"]) <= 8)
    for item in manifest["files"]:
        require(set(item) == {"path", "sha256"} and item["path"].startswith(root + "/"))
        require(regular_digest(item["path"], 16777216) == item["sha256"])
    home = os.path.join(home_root, "acp", manifest["backend_id"])
    private_directory(os.path.join(home_root, "acp"))
    private_directory(home)
    environment = {"PATH": "/usr/bin:/bin:/usr/local/bin", "HOME": home, "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}
    for key, dirname in [("XDG_CONFIG_HOME", "config"), ("XDG_CACHE_HOME", "cache"), ("XDG_DATA_HOME", "data"), ("XDG_STATE_HOME", "state"), ("TMPDIR", "tmp")]:
        directory = os.path.join(home, dirname)
        private_directory(directory)
        environment[key] = directory
    supplied, names = manifest["environment"], manifest["credential_names"]
    require(isinstance(supplied, dict) and isinstance(names, list) and len(names) <= 8 and len(set(names)) == len(names) and len(supplied) <= 16)
    for key in list(supplied) + names:
        require(isinstance(key, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{1,79}", key) and key not in environment and not re.match(r"(?:LD_|DYLD_|PYTHON|NODE_|CODER_|SSH_|DSH_|BASH_ENV$|ENV$)", key))
    require(not any(key in supplied for key in names))
    for key, value in supplied.items():
        require(not re.search(r"TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY", key) and isinstance(value, str) and len(value) <= 8192 and "\0" not in value)
        environment[key] = value
    for key in names:
        value = os.environ.get(key)
        require(isinstance(value, str) and 0 < len(value) <= 16384 and "\0" not in value)
        environment[key] = value
    start_ticks = open("/proc/self/stat", encoding="utf-8").read().split(") ")[1].split()[19]
    identity = {"studio_acp_launch": 1, "task_id": manifest["task_id"], "instance_id": manifest["instance_id"], "binding_id": manifest["binding_id"], "version": manifest["binding_version"], "pid": os.getpid(), "start_ticks": start_ticks, "cwd": os.getcwd(), "home": home, "environment_keys": sorted(environment), "executable": executable, "executable_sha256": manifest["executable_sha256"], "manifest_sha256": hashlib.sha256(raw).hexdigest()}
    sys.stdout.write(json.dumps(identity, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    os.execve(executable, argv, environment)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Do not quote paths, manifest bytes, or credential-bearing OS errors.
        sys.stderr.write("ACP_LAUNCH_REJECTED:" + type(error).__name__ + "\n")
        sys.exit(70)
