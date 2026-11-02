#!/usr/bin/env node
// Explicit binding pin, e.g. --expected-version 5 [--ids file] [--binding-id id].
// Product RPC only; bounded writes inside the selected root, no lifecycle.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {acceptanceReport, assertBindingIds, assertRemoteSelection, assertReadback, assertVersion, assertSearch, assertReference, fileScope, isMain, remoteMain, unprefixedCode} from './acceptance-contracts.mjs';

export async function runT203({ids, expectedVersion, rpc, uuid = randomUUID, onPass}) {
  const run = uuid(), dir = 't203-remote-' + run, path = dir + '/中文 file.txt', marker = 'T203_REMOTE_' + run;
  return acceptanceReport('T-203 remote acceptance on an explicitly pinned single channel; product RPC only, no lifecycle', ids, run, async pass => {
    assertBindingIds(ids, expectedVersion);
    await assertRemoteSelection(rpc, ids);
    const scope = fileScope(ids), original = marker + '\nline2\n', updated = marker + ' v2\n';
    await rpc('fs.mkdir', {...scope, path: dir, operation_id: uuid()});
    const first = await rpc('fs.write', {...scope, path, operation_id: uuid(), encoding: 'utf8', data: original, expected_version: null});
    assertVersion(first.version);
    const read1 = assertReadback(await rpc('fs.read', {...scope, path}), original, first.version);
    pass('remote write -> readback exact bytes/hash inside the selected binding root', {dir, path, sha256: read1.sha256, version: read1.version});
    const second = await rpc('fs.write', {...scope, path, operation_id: uuid(), encoding: 'utf8', data: updated, expected_version: read1.version});
    // Strong versions are opaque tokens, not numeric or lexical clocks.
    assertVersion(second.version);
    assert.notEqual(second.version, read1.version, 'strong version did not change');
    assertReadback(await rpc('fs.read', {...scope, path}), updated, second.version);
    let staleCode;
    try { await rpc('fs.write', {...scope, path, operation_id: uuid(), encoding: 'utf8', data: 'lost', expected_version: read1.version}); }
    catch (error) { staleCode = error.code; }
    assert.equal(unprefixedCode(staleCode), 'E_STALE_VERSION', 'stale version not rejected with the CAS error');
    const read2 = assertReadback(await rpc('fs.read', {...scope, path}), updated, second.version);
    pass('remote strong CAS rejects the actual stale version and preserves latest bytes/version', {staleCode, version: second.version});
    const list = await rpc('fs.list', {...scope, path: dir});
    assert.notEqual(list.truncated, true, 'directory listing truncated');
    assert.ok(Array.isArray(list.entries) && list.entries.some(entry => entry.name === '中文 file.txt'), 'exact bound filename missing');
    const absolute = ids.target_root + '/' + path;
    const search = await rpc('fs.search', {...scope, query: 'content:' + marker, paginate: false});
    assertSearch(search, ids, absolute);
    const reference = await rpc('reference.create', {...scope, path});
    const citation = assertReference(reference, ids, absolute, updated, read2.version);
    pass('remote list/search/reference retain exact binding identity and bound snapshot citation', {identity: search.identity, citation_path: citation.path, sha256: citation.sha256});
    await assertRemoteSelection(rpc, ids);
  }, onPass);
}

if (isMain(import.meta.url)) await remoteMain('t203', 't203-remote-', runT203);
