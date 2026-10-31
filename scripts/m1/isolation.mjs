import assert from 'node:assert/strict';
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptRoot = realpathSync(fileURLToPath(new URL('.', import.meta.url)));
const environmentKeys = ['CI', 'DSH_HOME', 'HOME', 'LANG', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME'];
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

function requireWriteDenied(path) {
  if (process.permission.has('fs.write', path)) {
    fail('T103_DEPENDENCY_WRITE_ALLOWED', `Write permission unexpectedly covers ${path}`);
  }
  // O_WRONLY neither creates nor truncates: even a broken boundary cannot change this file.
  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY);
  } catch (error) {
    if (error.code === 'ERR_ACCESS_DENIED' && error.permission === 'FileSystemWrite') return error.code;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  fail('T103_DEPENDENCY_WRITE_ALLOWED', `A write-only open unexpectedly succeeded: ${path}`);
}

export function prepareIsolation(candidateRoot, installedDsh, testRoot) {
  if (!candidateRoot || !installedDsh || !testRoot) {
    fail('T103_ARGUMENTS', 'Expected CANDIDATE_ROOT INSTALLED_DSH NEW_TEST_ROOT');
  }
  if (!process.permission) fail('T103_PERMISSION_REQUIRED', 'Node --permission is required');
  const runtime = dirname(dirname(candidateRoot));
  for (const path of [candidateRoot, installedDsh, runtime]) {
    assert.equal(path, realpathSync(path), 'Installation paths must be absolute and canonical');
  }
  assert.equal(candidateRoot, join(runtime, 'node_modules', 'dsh-ssh-remote'));
  assert.equal(testRoot, resolve(testRoot), 'Run root must be absolute');
  assert.equal(dirname(testRoot), runtime, 'Run root must be a direct child of the isolated runtime');
  const writeFlags = process.execArgv.filter(arg => arg.startsWith('--allow-fs-write'));
  const expectedWriteFlags = [`--allow-fs-write=${testRoot}`, `--allow-fs-write=${testRoot}/*`];
  if (writeFlags.length !== 2 || !expectedWriteFlags.every(flag => writeFlags.includes(flag))) {
    fail('T103_UNSAFE_WRITE_GRANT', 'Only the brand-new run root and its slash-delimited descendants may be writable');
  }
  const expectedFlags = ['--permission', ...[installedDsh, runtime, scriptRoot].map(path => `--allow-fs-read=${path}`), ...expectedWriteFlags].sort();
  assert.deepEqual([...process.execArgv].sort(), expectedFlags, 'Use the saved runner; extra Node flags are forbidden');
  assert.equal(process.permission.has('child'), false);
  assert.equal(process.permission.has('fs.write', testRoot), true);
  for (const path of [installedDsh, runtime, join(runtime, 'node_modules'), candidateRoot]) {
    assert.equal(process.permission.has('fs.write', path), false, `Dependency directory must not be writable: ${path}`);
  }
  if (existsSync(testRoot)) fail('T103_RUN_ROOT_EXISTS', 'Refusing an existing run root, including a symlink');
  if (Object.keys(process.env).some(key => !environmentKeys.includes(key))) {
    fail('T103_INHERITED_ENVIRONMENT', 'Only the runner environment allowlist is permitted');
  }
  assert.equal(process.env.HOME, join(testRoot, 'home'));
  assert.equal(process.env.DSH_HOME, join(testRoot, 'dsh-home'));
  assert.equal(process.env.TMPDIR, join(testRoot, 'tmp'));
  assert.equal(process.env.XDG_CONFIG_HOME, join(testRoot, 'home', '.config'));
  assert.equal(process.env.XDG_CACHE_HOME, join(testRoot, 'home', '.cache'));
  assert.equal(process.env.CI, 'true');
  assert.equal(process.env.LANG, 'C.UTF-8');

  const candidate = JSON.parse(readFileSync(join(candidateRoot, 'package.json'), 'utf8'));
  assert.equal(candidate.name, 'dsh-ssh-remote');
  assert.equal(candidate.version, '0.13.3');
  const candidateWriteDenied = requireWriteDenied(join(candidateRoot, 'package.json'));
  const peerWriteDenials = [];
  for (const name of Object.keys(candidate.peerDependencies)) {
    assert.match(name, /^@deepseek-ai\/[a-z0-9-]+$/);
    const alias = join(runtime, 'node_modules', name);
    const direct = realpathSync(join(installedDsh, 'node_modules', name));
    assert.equal(realpathSync(alias), direct, `Peer alias must resolve to the selected SDK: ${name}`);
    peerWriteDenials.push({
      name,
      direct: requireWriteDenied(join(direct, 'package.json')),
      alias: requireWriteDenied(join(alias, 'package.json')),
    });
  }
  assert.ok(peerWriteDenials.length > 0);
  // No candidate/provider code or run-directory creation occurs before all denials pass.
  mkdirSync(testRoot);
  for (const name of ['home', 'dsh-home', 'workspace', 'tmp']) mkdirSync(join(testRoot, name));
  return {
    writeRoot: testRoot,
    writeGrantCount: writeFlags.length,
    dependencyDirectoriesNotWritable: true,
    candidateWriteDenied,
    peerWriteDenials,
    childProcessDenied: true,
    environmentAllowlisted: true,
    brandNewRunRoot: true,
    osSandbox: false,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  console.log(JSON.stringify(prepareIsolation(...process.argv.slice(2)), null, 2));
}
