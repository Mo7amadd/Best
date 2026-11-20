'use strict';
// Does the connected server reach IPv6? Asked through Best's own local SOCKS port (so through the
// server), with an IPv4 check next to it: when even IPv4 fails the network is just slow or down,
// and nothing is concluded.
// Used for TUN with "IPv6 through the tunnel" on: many servers have no IPv6 exit, and then
// IPv6-first programs hang (TUN accepts their connection, the server cannot carry it, and they never
// fall back to IPv4). Such a server gets IPv6 refused at once instead.

const net = require('net');
const tls = require('tls');

// Cloudflare's resolver answers TLS on 443 at both addresses, with a certificate for this name.
const TARGET_V4 = { host: '1.1.1.1', name: 'one.one.one.one' };
const TARGET_V6 = { host: '2606:4700:4700::1111', name: 'one.one.one.one' };

/** "2606:4700::1111" → its 16 bytes ("::" expanded). */
function ipv6Bytes(ip) {
  const [head, tail = ''] = String(ip).split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const groups = String(ip).includes('::') ? [...a, ...Array(8 - a.length - b.length).fill('0'), ...b] : a;
  if (groups.length !== 8) throw new Error('bad IPv6 address');
  return Buffer.from(groups.flatMap((h) => { const n = parseInt(h, 16); return [n >> 8, n & 255]; }));
}

/** One TLS handshake to `target` through the SOCKS5 port (no login: the local port has none). */
function tlsThroughSocks(socksPort, target, timeoutMs = 7000) {
  return new Promise((resolve) => {
    let done = false;
    let sock = null;
    let secure = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (secure) secure.destroy(); } catch { /* closed */ }
      try { if (sock) sock.destroy(); } catch { /* closed */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const addr = net.isIPv6(target.host)
      ? Buffer.concat([Buffer.from([4]), ipv6Bytes(target.host)])
      : Buffer.from([1, ...target.host.split('.').map(Number)]);
    sock = net.connect(socksPort, '127.0.0.1');
    sock.on('error', () => finish(false));
    let step = 0;
    let buf = Buffer.alloc(0);
    sock.on('connect', () => sock.write(Buffer.from([5, 1, 0])));
    sock.on('data', (d) => {
      if (step === 0) {
        if (d[0] !== 5 || d[1] !== 0) return finish(false);
        step = 1;
        sock.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, Buffer.from([443 >> 8, 443 & 255])]));
        return;
      }
      if (step === 1) {
        buf = Buffer.concat([buf, d]);
        if (buf.length < 2) return;
        if (buf[1] !== 0) return finish(false);
        step = 2;
        sock.removeAllListeners('data');
        secure = tls.connect({ socket: sock, servername: target.name, ALPNProtocols: ['http/1.1'] }, () => finish(true));
        secure.on('error', () => finish(false));
      }
    });
  });
}

/**
 * true: the server reaches IPv6; false: IPv4 works through it but IPv6 does not (asked twice);
 * null: not known (IPv4 failed too, or the port did not answer).
 */
async function serverHasIpv6(socksPort, { timeoutMs = 7000, probe = tlsThroughSocks } = {}) {
  const [v4, v6] = await Promise.all([probe(socksPort, TARGET_V4, timeoutMs), probe(socksPort, TARGET_V6, timeoutMs)]);
  if (v6) return true;
  if (!v4) return null;
  // IPv4 fine, IPv6 not: once more before deciding (a single lost handshake is not enough).
  return (await probe(socksPort, TARGET_V6, timeoutMs)) ? true : false;
}

module.exports = { serverHasIpv6, tlsThroughSocks, ipv6Bytes, TARGET_V4, TARGET_V6 };
