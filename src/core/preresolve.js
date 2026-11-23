'use strict';
// Pre-resolving a subscription's server names (an option of each subscription): when it updates,
// every server given by name gets the IP that a chosen resolver gives for it. For panels that hand
// out their entry addresses through their own DNS, and for networks whose DNS answers are changed.
// The name stays as the TLS server name (SNI) and the HTTP Host, so TLS and CDNs keep working.
// Only the parts without network access live here; the main process sends the queries.

const { isIPv6 } = require('./util');

// The resolvers on offer: "" = off, "localhost" = this computer's DNS, or DoH by IP (a DoH server
// given by name would first need a lookup by the very DNS this option is meant to avoid).
// (Quad9 by IP answers only HTTP/2 and Node's fetch speaks HTTP/1.1: not offered.)
const PRE_RESOLVERS = ['', 'localhost', 'https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'];

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const isIp = (a) => IPV4.test(a) || (String(a).includes(':') && isIPv6(a));
// A real name: letters somewhere, no IP literal.
const isName = (a) => typeof a === 'string' && !isIp(a) && /^[a-z0-9.-]{1,253}$/i.test(a) && /[a-z]/i.test(a) && a.includes('.');

/**
 * An address a server may be moved to: a public IP. A resolver (or a subscription that controls
 * its own DNS) must not be able to point servers at this computer or at devices on the LAN.
 */
function isPublicIp(ip) {
  if (IPV4.test(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)));
  }
  if (!isIPv6(ip)) return false;
  const v = ip.toLowerCase().replace(/%.*$/, '');
  if (v === '::' || v === '::1') return false;
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (m) return isPublicIp(m[1]);
  return !/^(f[cd]|fe[89ab]|ff)/.test(v) && !v.startsWith('64:ff9b:') && !v.startsWith('2001:db8');
}

// ---- DNS wire format (RFC 1035), only what a lookup of A / AAAA needs

/** A query for `name` (type 1 = A, 28 = AAAA). */
function dnsQuery(name, type, id = 0) {
  const labels = String(name).replace(/\.$/, '').split('.');
  if (!labels.length || labels.some((l) => !l || l.length > 63 || !/^[a-z0-9-]+$/i.test(l))) throw new Error('bad name');
  const parts = [Buffer.from([id >> 8 & 255, id & 255, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0])];
  for (const l of labels) parts.push(Buffer.from([l.length]), Buffer.from(l, 'ascii'));
  parts.push(Buffer.from([0, type >> 8, type & 255, 0, 1])); // end of the name, QTYPE, QCLASS IN
  return Buffer.concat(parts);
}

/** Skips a (possibly compressed) name at `i`; returns the offset after it. */
function skipName(buf, i) {
  for (let guard = 0; guard < 128; guard++) {
    if (i >= buf.length) throw new Error('short answer');
    const len = buf[i];
    if (len === 0) return i + 1;
    if ((len & 0xc0) === 0xc0) return i + 2;
    i += len + 1;
  }
  throw new Error('bad name');
}

/** The addresses of `type` in a DNS answer (empty on any error code or malformed answer). */
function dnsAnswers(buf, type) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return [];
    if ((buf[3] & 15) !== 0) return []; // RCODE
    const qd = buf.readUInt16BE(4);
    const an = buf.readUInt16BE(6);
    let i = 12;
    for (let q = 0; q < qd; q++) i = skipName(buf, i) + 4;
    const out = [];
    for (let a = 0; a < an && a < 64; a++) {
      i = skipName(buf, i);
      const t = buf.readUInt16BE(i);
      const len = buf.readUInt16BE(i + 8);
      const data = buf.subarray(i + 10, i + 10 + len);
      if (data.length !== len) break;
      if (t === 1 && type === 1 && len === 4) out.push([...data].join('.'));
      if (t === 28 && type === 28 && len === 16) {
        const g = [];
        for (let k = 0; k < 16; k += 2) g.push(data.readUInt16BE(k).toString(16));
        out.push(g.join(':')); // all eight groups: a valid address everywhere, no shortening needed
      }
      i += 10 + len;
    }
    return out;
  } catch { return []; }
}

// Settings that carry the server's name for TLS / HTTP, by protocol and transport.
const OWN_TLS = ['hysteria2', 'hysteria', 'tuic', 'anytls', 'naive', 'masque'];
const HOST_NETWORKS = ['ws', 'httpupgrade', 'xhttp', 'h2'];

/**
 * The same server, dialled at `ip`, still introducing itself with its name: TLS keeps the name as
 * SNI, and HTTP transports keep it as Host (a CDN picks the site by it). Values the link set
 * itself are left alone. Returns the server unchanged when the IP is not a public one.
 */
function applyResolved(s, ip) {
  if (!s || !isName(s.address) || !isPublicIp(ip)) return s;
  const name = s.address;
  const out = { ...s, address: ip, resolvedFrom: name };
  if ((s.tls === 'tls' || OWN_TLS.includes(s.protocol)) && !s.sni) out.sni = name;
  const httpHost = HOST_NETWORKS.includes(s.network) || ((s.network || 'raw') === 'raw' && s.headerType === 'http');
  if (httpHost && !s.host && ['vmess', 'vless', 'trojan'].includes(s.protocol)) out.host = name;
  return out;
}

/**
 * Resolve every server name of a list with `resolve(name) → Promise<ip | ''>` (a few at a time,
 * each name once). Servers whose name gave nothing usable stay as they were.
 */
async function preResolveServers(list, resolve, { max = 300, parallel = 6 } = {}) {
  const names = [...new Set(list.filter((s) => s && !['custom', 'group'].includes(s.protocol) && isName(s.address)).map((s) => s.address.toLowerCase()))].slice(0, max);
  const ips = new Map();
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const n = names[next++];
      let ip = '';
      try { ip = String((await resolve(n)) || ''); } catch { ip = ''; }
      if (isPublicIp(ip)) ips.set(n, ip);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, names.length) }, worker));
  return list.map((s) => (s && isName(s.address) && ips.has(s.address.toLowerCase()) ? applyResolved(s, ips.get(s.address.toLowerCase())) : s));
}

module.exports = { PRE_RESOLVERS, isPublicIp, dnsQuery, dnsAnswers, applyResolved, preResolveServers };
