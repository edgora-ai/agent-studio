// Deterministic local protocol regression: current T-106 publisher plus the
// current candidate's verbatim observe() consumer. No remote workload or sleep fix.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const scripts = dirname(fileURLToPath(import.meta.url));
const root = join(scripts, '../..');
const all = readFileSync(join(scripts, 't106_candidate.mjs'), 'utf8');
const source = all.slice(all.indexOf('async function observe('), all.indexOf('async function test('));
assert.ok(source.startsWith('async function observe('));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const consume = new AsyncFunction('env', `const {assert,join,run,writeFileSync,existsSync,readFileSync,delay,report}=env;let seq=0;${source};return observe('atomic-publication-regression');`);
function deadline(promise) {
  let timer;
  const bounded = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('T106_REGRESSION_DEADLINE')), 10000); });
  return Promise.race([promise, bounded]).finally(() => clearTimeout(timer));
}
function environment(run, report, wait = delay) {
  return { assert, join, run, writeFileSync, existsSync, readFileSync, delay: wait, report };
}

test('real publisher hides a deterministically paused partial write from the current consumer', async () => {
  const run = mkdtempSync(join(root, 'artifacts/m1/t106/publication-test-'));
  const response = join(run, 'observe-001.response.json');
  const report = { observations: [] };
  let settled = false, paused = false, confirmWaiting, confirmPartial;
  const waiting = new Promise(resolve => { confirmWaiting = resolve; });
  const partial = new Promise(resolve => { confirmPartial = resolve; });
  const consumed = consume(environment(run, report, ms => {
    if (paused) confirmWaiting();
    return delay(ms);
  })).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  assert.ok(existsSync(join(run, 'observe-001.request.json')));
  const child = spawn('python3', ['-I', join(scripts, 't106_boundary_test.py'), 'publish-fixture', response],
    { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (stdout.includes('partial-write-barrier')) { paused = true; confirmPartial(); }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  try {
    await deadline(partial);
    await deadline(waiting); // Consumer actually polls while the writer is held.
    assert.equal(settled, false);
    assert.equal(report.observations.length, 0);
    assert.equal(existsSync(response), false);
    const pending = readdirSync(run).filter(name => name.endsWith('.pending'));
    assert.equal(pending.length, 1);
    assert.equal(readFileSync(join(run, pending[0]), 'utf8'), '{');
    child.stdin.end('finish\n');
    const result = await deadline(consumed);
    if (result.error) throw result.error;
    assert.equal(result.value.remote.synthetic, '完整 UTF-8 '.repeat(1000));
    assert.deepEqual(await deadline(exited), { code: 0, signal: null }, stderr);
    assert.equal(report.observations.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(response, 'utf8')), result.value);
    assert.equal(readdirSync(run).filter(name => name.endsWith('.pending')).length, 0);
    writeFileSync(join(run, 'regression.json'), JSON.stringify({ partialWriteHeld: true, consumerPolledWhileHeld: true,
      consumedBeforePublication: false, completeReadback: true, publisherExitCode: 0 }), { flag: 'wx' });
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await deadline(exited); }
  }
});

test('consumer still rejects a malformed final receipt rather than swallowing JSON errors', async () => {
  const run = mkdtempSync(join(root, 'artifacts/m1/t106/publication-negative-'));
  writeFileSync(join(run, 'observe-001.response.json'), '{', { flag: 'wx' });
  const report = { observations: [] };
  await assert.rejects(() => consume(environment(run, report)), SyntaxError);
  assert.equal(report.observations.length, 0);
});
