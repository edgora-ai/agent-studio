import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import dns, { resolveTxt as namedResolveTxt } from 'node:dns';
import dnsPromises, { resolveTxt as namedPromisesResolveTxt } from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dgram from 'node:dgram';
import { installNetworkGuard } from './network_guard.mjs';

// Replace every tested native operation BEFORE the guard. A missed patch hits a local
// sentinel, never a DNS server/socket; the expected denial code then fails the test.
let sentinelCalls = 0;
const sentinel = () => {
  sentinelCalls++;
  throw Object.assign(new Error('Offline network sentinel reached'), { code: 'T103_OFFLINE_SENTINEL' });
};
const queryNames = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTlsa', 'resolveTxt', 'reverse'];
const callbackResolver = new dns.Resolver();
const promiseResolver = new dnsPromises.Resolver();
const surfaces = [
  ['dns', dns, dns, ['lookup', 'lookupService', ...queryNames]],
  ['dns.promises', dnsPromises, dnsPromises, ['lookup', 'lookupService', ...queryNames]],
  ['dns.Resolver', dns.Resolver.prototype, callbackResolver, queryNames],
  ['dns.promises.Resolver', dnsPromises.Resolver.prototype, promiseResolver, queryNames],
];
const probes = [];
for (const [label, target, receiver, names] of surfaces) {
  for (const name of names) {
    if (typeof target[name] !== 'function') {
      assert.equal(name, 'resolveTlsa', `Unexpected missing standard DNS API: ${label}.${name}`);
      continue;
    }
    target[name] = sentinel;
    probes.push([`${label}.${name}`, () => receiver[name]('t103.invalid', () => {})]);
  }
}
for (const [label, target, name] of [
  ['net.connect', net, 'connect'], ['net.createConnection', net, 'createConnection'],
  ['net.connect', net.Socket.prototype, 'connect'], ['net.listen', net.Server.prototype, 'listen'],
  ['tls.connect', tls, 'connect'], ['http.request', http, 'request'], ['http.get', http, 'get'],
  ['https.request', https, 'request'], ['https.get', https, 'get'], ['http2.connect', http2, 'connect'],
  ['dgram.createSocket', dgram, 'createSocket'],
  ...['bind', 'connect', 'send', 'sendto'].filter(name => typeof dgram.Socket.prototype[name] === 'function').map(name => [`dgram.Socket.${name}`, dgram.Socket.prototype, name]),
  ['fetch', globalThis, 'fetch'],
  ...('WebSocket' in globalThis ? [['WebSocket', globalThis, 'WebSocket']] : []),
]) {
  target[name] = sentinel;
  probes.push([label, () => target[name]()]);
}
syncBuiltinESMExports();
const attempts = installNetworkGuard();
probes.push(['dns.resolveTxt', () => namedResolveTxt('t103.invalid', () => {})]);
probes.push(['dns.promises.resolveTxt', () => namedPromisesResolveTxt('t103.invalid')]);
for (const [label, probe] of probes) {
  const before = attempts.length;
  assert.throws(probe, { code: 'T103_NETWORK_DENIED' }, label);
  assert.equal(attempts.length, before + 1, label);
  assert.equal(attempts.at(-1), label);
}
assert.equal(sentinelCalls, 0);
console.log(JSON.stringify({ passed: true, nodeVersion: process.versions.node, realNetworkUsed: false,
  sentinelCalls, guardedCalls: probes.length, coverage: probes.map(([label]) => label) }, null, 2));
