import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dgram from 'node:dgram';
import dns from 'node:dns';

// Standard-JavaScript test guards, not an OS sandbox or a defense against hostile native code.
export function installNetworkGuard() {
  const attempts = [];
  const deny = kind => function () {
    attempts.push(kind);
    const error = new Error(`T-103 network operation denied: ${kind}`);
    error.code = 'T103_NETWORK_DENIED';
    throw error;
  };
  net.Socket.prototype.connect = deny('net.connect');
  net.Server.prototype.listen = deny('net.listen');
  net.connect = deny('net.connect');
  net.createConnection = deny('net.createConnection');
  tls.connect = deny('tls.connect');
  http.request = deny('http.request');
  http.get = deny('http.get');
  https.request = deny('https.request');
  https.get = deny('https.get');
  http2.connect = deny('http2.connect');
  dgram.createSocket = deny('dgram.createSocket');
  for (const name of ['bind', 'connect', 'send', 'sendto']) {
    if (typeof dgram.Socket.prototype[name] === 'function') dgram.Socket.prototype[name] = deny(`dgram.Socket.${name}`);
  }
  for (const [label, target] of [
    ['dns', dns], ['dns.promises', dns.promises],
    ['dns.Resolver', dns.Resolver.prototype],
    ['dns.promises.Resolver', dns.promises.Resolver.prototype],
  ]) {
    for (const name of Object.getOwnPropertyNames(target)) {
      if (/^(?:lookup|resolve)/.test(name) || name === 'reverse') {
        if (typeof target[name] === 'function') target[name] = deny(`${label}.${name}`);
      }
    }
  }
  globalThis.fetch = deny('fetch');
  if ('WebSocket' in globalThis) globalThis.WebSocket = deny('WebSocket');
  syncBuiltinESMExports();
  // Missing/invalid arguments ensure these self-tests cannot issue requests if a patch regresses.
  for (const probe of [
    () => globalThis.fetch(), () => net.connect(), () => dns.resolveTxt(),
    () => dns.promises.resolveTxt(),
    () => dns.Resolver.prototype.resolve4.call({}),
    () => dns.promises.Resolver.prototype.resolve4.call({}),
  ]) assert.throws(probe, { code: 'T103_NETWORK_DENIED' });
  assert.deepEqual(attempts, ['fetch', 'net.connect', 'dns.resolveTxt', 'dns.promises.resolveTxt', 'dns.Resolver.resolve4', 'dns.promises.Resolver.resolve4']);
  attempts.length = 0;
  return attempts;
}
