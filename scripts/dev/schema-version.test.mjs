import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CURRENT_SCHEMA_VERSION, Store} from '../../packages/dsh-agent-studio/store.mjs';

// These tests never import operational integration scripts: several of those
// deliberately restart a preview or dispatch work at module evaluation time.
test('current schema constant matches a fresh migration and every recorded step', t => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'agent-studio-test-schema-')));
  t.after(() => store.close());
  assert.ok(Number.isSafeInteger(CURRENT_SCHEMA_VERSION) && CURRENT_SCHEMA_VERSION > 0);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, CURRENT_SCHEMA_VERSION);
  const steps = store.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => row.version);
  assert.deepEqual(steps, Array.from({length: CURRENT_SCHEMA_VERSION}, (_, index) => index + 1));
  assert.equal(store.db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
});

test('opening the current schema again preserves principal and migration history', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-studio-test-schema-'));
  const original = new Store(root);
  const principal = original.principal;
  const history = original.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  original.close();
  const reopened = new Store(root);
  try {
    assert.equal(reopened.principal, principal);
    assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(reopened.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), history);
  } finally { reopened.close(); }
});

for (const file of ['local.integration.mjs', 'acp.integration.mjs', 'environment.integration.mjs', 'core.verify.mjs']) {
  test(`${file} gates the current schema without executing operational code`, () => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /import\s*\{CURRENT_SCHEMA_VERSION\}\s*from\s*['"]\.\.\/\.\.\/packages\/dsh-agent-studio\/store\.mjs['"]/);
    const gates = [...source.matchAll(/assert\.equal\([^;\n]*?\.user_version\s*,\s*([^)]+)\)/g)];
    assert.equal(gates.length, 1, 'Each current-runtime script must explicitly gate the schema');
    assert.equal(gates[0][1].trim(), 'CURRENT_SCHEMA_VERSION');
    assert.doesNotMatch(source, /\bschema:\s*\d+\b/, 'Current report metadata must not retain a stale schema literal');
  });
}
