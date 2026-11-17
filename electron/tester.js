'use strict';
// Latency (TCP ping and real delay through the proxy) and download speed tests.

const net = require('net');
const tls = require('tls');
const http = require('http');
const dgram = require('dgram');

function tcping(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const sock = net.connect({ host, port, timeout });
    const done = (ms) => { sock.destroy(); resolve(ms); };
    sock.once('connect', () => done(Number((process.hrtime.bigint() - start) / 1000000n)));
    sock.once('timeout', () => done(-1));
    sock.once('error', () => done(-1));
  });
}

/**
 * GET `url` through the local HTTP proxy on `port`.
 * https URLs use CONNECT + TLS (certificate is verified), http URLs use an absolute-URI request.
 * Resolves { status, ms (time to response headers), bytes, seconds }.
 */
function getViaProxy(port, url, { timeout = 6000, maxBytes = 0, maxSeconds = 0, onProgress = null } = {}) {
  const u = new URL(url);
  const start = process.hrtime.bigint();
  const elapsed = () => Number(process.hrtime.bigint() - start) / 1e6;
  return new Promise((resolve, reject) => {
    let settled = false;
    let cleanup = () => {};
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      if (err) reject(err); else resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('timeout')), timeout + (maxSeconds * 1000));

    const readResponse = (res) => {
      const ms = Math.round(elapsed());
      let bytes = 0;
      let lastTick = 0;
      const t0 = process.hrtime.bigint();
      const end = () => finish(null, { status: res.statusCode, ms, bytes, seconds: Number(process.hrtime.bigint() - t0) / 1e9 });
      res.on('data', (chunk) => {
        bytes += chunk.length;
        const secs = Number(process.hrtime.bigint() - t0) / 1e9;
        if (onProgress && secs - lastTick >= 0.25) { lastTick = secs; onProgress(bytes, secs); }
        if ((maxBytes && bytes >= maxBytes) || (maxSeconds && secs >= maxSeconds)) { res.destroy(); end(); }
      });
      res.on('end', end);
      res.on('error', end);
      res.on('close', end);
    };

    if (u.protocol === 'http:') {
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: u.toString(), headers: { Host: u.host, 'User-Agent': 'Mozilla/5.0' } }, readResponse);
      cleanup = () => req.destroy();
      req.on('error', (e) => finish(e));
      req.end();
      return;
    }
    const connect = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: `${u.hostname}:${u.port || 443}`, headers: { Host: `${u.hostname}:${u.port || 443}` } });
    cleanup = () => connect.destroy();
    connect.on('error', (e) => finish(e));
    connect.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); finish(new Error(`proxy ${res.statusCode}`)); return; }
      const secure = tls.connect({ socket, servername: u.hostname, ALPNProtocols: ['http/1.1'] });
      cleanup = () => { secure.destroy(); socket.destroy(); };
      secure.on('error', (e) => finish(e));
      secure.once('secureConnect', () => {
        const req = http.request({
          createConnection: () => secure, host: u.hostname, method: 'GET', path: u.pathname + u.search,
          headers: { Host: u.host, 'User-Agent': 'Mozilla/5.0', Connection: 'close' },
        }, readResponse);
        req.on('error', (e) => finish(e));
        req.end();
      });
    });
    connect.end();
  });
}

async function realDelay(port, url, timeout) {
  try {
    const r = await getViaProxy(port, url, { timeout });
    return r.status >= 200 && r.status < 400 ? r.ms : -1;
  } catch {
    return -1;
  }
}

/** Download for up to `seconds` and return MB/s (decimal megabytes), or -1 on failure. */
async function speedTest(port, url, seconds = 8, onProgress = null) {
  try {
    const r = await getViaProxy(port, url, { timeout: 8000, maxSeconds: seconds, maxBytes: 200 * 1024 * 1024, onProgress });
    if (!r.bytes || r.seconds <= 0) return -1;
    return Math.round((r.bytes / r.seconds / 1e6) * 100) / 100;
  } catch {
    return -1;
  }
}

/**
 * UDP test: send an NTP query to `target` (host:port) through the local SOCKS5 inbound on `port`
 * (UDP ASSOCIATE) and return the milliseconds until the first answer, or -1. Tells whether the
 * server carries UDP at all (calls, games, QUIC) and how fast.
 */
function udpDelay(port, target = 'pool.ntp.org:123', timeout = 6000) {
  const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(String(target).trim());
  const host = m ? m[1] : 'pool.ntp.org';
  const dport = m ? Number(m[2]) : 123;
  return new Promise((resolve) => {
    let settled = false;
    let udp = null;
    let resend = null;
    let start = 0n;
    let stage = 0;
    let buf = Buffer.alloc(0);
    const tcp = net.connect({ host: '127.0.0.1', port });
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearInterval(resend);
      tcp.destroy();
      if (udp) { try { udp.close(); } catch { /* closed */ } }
      resolve(v);
    };
    const timer = setTimeout(() => done(-1), timeout);
    tcp.on('error', () => done(-1));
    tcp.on('close', () => done(-1)); // the UDP association lives as long as this connection
    tcp.on('connect', () => tcp.write(Buffer.from([5, 1, 0]))); // SOCKS5, no authentication
    tcp.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 5 || buf[1] !== 0) { done(-1); return; }
        buf = buf.subarray(2);
        stage = 1;
        tcp.write(Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0])); // UDP ASSOCIATE
      }
      if (stage === 1) {
        if (buf.length < 4) return;
        if (buf[1] !== 0) { done(-1); return; }
        const atyp = buf[3];
        const alen = atyp === 1 ? 4 : atyp === 4 ? 16 : atyp === 3 ? 1 + (buf[4] || 0) : -1;
        if (alen < 0) { done(-1); return; }
        if (buf.length < 4 + alen + 2) return;
        let relay = '127.0.0.1';
        if (atyp === 1) relay = Array.from(buf.subarray(4, 8)).join('.');
        else if (atyp === 4) relay = buf.subarray(4, 20).toString('hex').match(/.{4}/g).join(':');
        if (relay === '0.0.0.0' || /^0+(:0+)*$/.test(relay)) relay = '127.0.0.1';
        const relayPort = buf.readUInt16BE(4 + alen);
        stage = 2;
        const name = Buffer.from(host);
        const ntp = Buffer.alloc(48); ntp[0] = 0x1b; // NTP v3 client request
        const packet = Buffer.concat([Buffer.from([0, 0, 0, 3, name.length]), name, Buffer.from([dport >> 8, dport & 255]), ntp]);
        udp = dgram.createSocket(relay.includes(':') ? 'udp6' : 'udp4');
        udp.on('error', () => done(-1));
        udp.on('message', (msg) => { if (msg.length > 10) done(Math.round(Number(process.hrtime.bigint() - start) / 1e6)); });
        start = process.hrtime.bigint();
        const fire = () => udp.send(packet, relayPort, relay, () => {});
        fire();
        resend = setInterval(fire, 1500); // UDP may drop a packet; ask again
      }
    });
  });
}

async function pool(items, concurrency, fn, isCancelled) {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length && !isCancelled()) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

module.exports = { tcping, realDelay, speedTest, udpDelay, getViaProxy, pool };
