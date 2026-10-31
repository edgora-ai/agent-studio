import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installNetworkGuard } from './network_guard.mjs';
import { prepareIsolation } from './isolation.mjs';

const [root, installedDsh, testRoot] = process.argv.slice(2);
const isolation = prepareIsolation(root, installedDsh, testRoot);
const output = join(testRoot, 'import-result.json');
const networkAttempts = installNetworkGuard();
const report = { task: 'T-103', nodeVersion: process.versions.node, stage: 'module-import', isolation, passed: false };
try {
  const candidate = await import(pathToFileURL(join(root, 'lib/index.js')));
  assert.equal(candidate.name, 'dsh-ssh-remote');
  assert.equal(typeof candidate.apply, 'function');
  assert.equal(typeof candidate.Config, 'function');
  assert.deepEqual(candidate.inject, ['fs', 'subprocess']);
  assert.deepEqual(networkAttempts, []);
  report.exports = Object.keys(candidate).sort();
  report.passed = true;
} catch (error) {
  report.error = { code: error.code ?? null, message: error.message };
  process.exitCode = 1;
}
report.networkAttempts = networkAttempts;
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), report);
console.log(JSON.stringify(report, null, 2));
