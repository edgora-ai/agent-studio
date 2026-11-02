#!/usr/bin/env node
// Explicit binding pin: --expected-version 5 [--ids file] [--binding-id id].
// Original sidebar routes; bounded file writes, no browser or lifecycle.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {acceptanceReport, assertBindingIds, assertRemoteSelection, assertReadback, assertVersion, assertSearch, assertReference, fileScope, sidebarClient, unprefixedCode, isMain, remoteMain} from './acceptance-contracts.mjs';

export async function runT205({ids, expectedVersion, rpc, sidebar, auth, fetch, uuid = randomUUID, onPass}) {
  const run = uuid(), dir = 't205-remote-' + run, relative = dir + '/中文 file.txt', marker = 'T205_REMOTE_' + run;
  return acceptanceReport('T-205 remote sidebar prerequisites on an explicitly pinned single channel; server routes only', ids, run, async pass => {
    assertBindingIds(ids, expectedVersion);
    await assertRemoteSelection(rpc, ids);
    const side = sidebar ?? sidebarClient({auth, ids, fetch});
    const scope = fileScope(ids), absolute = ids.target_root + '/' + relative;
    const original = 'remote original\n' + marker + '\n', updated = 'remote updated\n' + marker + '\n';
    await rpc('fs.mkdir', {...scope, path: dir, operation_id: uuid()});
    const first = await rpc('fs.write', {...scope, path: relative, operation_id: uuid(), encoding: 'utf8', data: original, expected_version: null});
    assertVersion(first.version);
    assertReadback(await rpc('fs.read', {...scope, path: relative}), original, first.version);
    const found = await side.call('fs.search', {query: 'content:' + marker});
    assertSearch(found, ids, absolute);
    const reference = await side.call('reference.create', {path: absolute});
    assertReference(reference, ids, absolute, original, first.version);
    const tree = await side.call('fs.tree', {path: ids.target_root + '/' + dir});
    assert.equal(tree.path, ids.target_root + '/' + dir, 'sidebar tree root mismatch');
    assert.notEqual(tree.truncated, true, 'sidebar tree truncated');
    assert.ok(Array.isArray(tree.entries) && tree.entries.some(entry => entry.name === '中文 file.txt' && entry.path === absolute && entry.isDir === false), 'sidebar tree bound file missing');
    pass('remote sidebar tree/search/reference retain exact bound identity/path/snapshot', {dir, identity: found.identity, binding_id: ids.binding_id});

    // HostFiles records timestamp -> strong-version associations only on reads.
    // An invented mtime fails before provider dispatch and is NOT proof of CAS.
    const baseline = await side.call('fs.read', {path: absolute});
    assert.equal(baseline.kind, 'text', 'sidebar read is not text');
    assert.equal(baseline.content, original, 'sidebar initial readback mismatch');
    assert.ok(Number.isFinite(baseline.mtimeMs), 'sidebar baseline timestamp missing');
    const saved = await side.write({path: absolute, expectedMtimeMs: baseline.mtimeMs, content: updated});
    assert.equal(saved.status, 200, 'valid sidebar CAS save failed');
    assert.equal(saved.body?.ok, true, 'valid sidebar CAS envelope missing');
    assert.equal(saved.body.value?.ok, true, 'valid sidebar CAS result missing');
    assert.ok(Number.isFinite(saved.body.value.mtimeMs), 'saved sidebar baseline missing');
    assert.notEqual(saved.body.value.mtimeMs, baseline.mtimeMs, 'timestamp collision prevents unambiguous stale CAS proof');
    const current = assertReadback(await rpc('fs.read', {...scope, path: relative}), updated);
    assert.notEqual(current.version, first.version, 'valid sidebar save did not change strong version');
    const latest = await side.call('fs.read', {path: absolute});
    assert.equal(latest.content, updated, 'sidebar saved readback mismatch');
    assert.equal(latest.mtimeMs, saved.body.value.mtimeMs, 'sidebar saved baseline changed');
    const conflict = await side.write({path: absolute, expectedMtimeMs: baseline.mtimeMs, content: 'lost'});
    assert.equal(conflict.status, 409, 'stale sidebar save did not conflict');
    assert.equal(conflict.body?.ok, false, 'stale sidebar failure envelope missing');
    assert.equal(conflict.body.error?.code, 'conflict', '409 was not a provider stale-version CAS conflict');
    assertReadback(await rpc('fs.read', {...scope, path: relative}), updated, current.version);
    pass('original sidebar save succeeds on a real baseline, then rejects that stale baseline via provider CAS without losing latest bytes', {status: 409, code: conflict.body.error.code, stale_mtime_ms: baseline.mtimeMs, current_mtime_ms: latest.mtimeMs, sha256: current.sha256, version: current.version});

    let opener;
    try { await side.call('open.external', {action: 'reveal', path: absolute, realm: 'local'}); }
    catch (error) { opener = error.code; }
    assert.ok(['provider-unavailable', 'denied', 'not-enabled'].includes(unprefixedCode(opener)), 'remote local opener was not explicitly rejected: ' + opener);
    pass('remote session local-opener route is explicitly rejected instead of dispatching centrally', {code: opener});
    await assertRemoteSelection(rpc, ids);
  }, onPass);
}

if (isMain(import.meta.url)) await remoteMain('t205', 't205-remote-prereq-', runT205);
