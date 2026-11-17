'use strict';
// Clash / Mihomo subscriptions (YAML "proxies:" list) → Best server objects.
// Every converted entry goes through normalizeServer(), so the same validation applies as for links.

const YAML = require('yaml');
const { normalizeServer } = require('./links');
const { cleanText } = require('./util');

const MAX_YAML = 5 * 1024 * 1024;

function looksLikeClash(text) {
  return /^proxies\s*:/m.test(String(text || '').slice(0, 200000));
}

const first = (v) => (Array.isArray(v) ? v[0] : v);
const mbps = (v) => Number.parseInt(String(v || '').replace(/[^0-9]/g, ''), 10) || 0;

/** Transport fields from network + *-opts. */
function transport(p) {
  const net = String(p.network || 'tcp').toLowerCase();
  if (net === 'ws') {
    const o = p['ws-opts'] || {};
    return { network: 'ws', path: o.path || '/', host: (o.headers && (o.headers.Host || o.headers.host)) || '' };
  }
  if (net === 'grpc') {
    const o = p['grpc-opts'] || {};
    return { network: 'grpc', serviceName: o['grpc-service-name'] || '' };
  }
  if (net === 'h2') {
    const o = p['h2-opts'] || {};
    return { network: 'h2', host: first(o.host) || '', path: o.path || '/' };
  }
  if (net === 'http') {
    const o = p['http-opts'] || {};
    const host = o.headers && (o.headers.Host || o.headers.host);
    return { network: 'raw', headerType: 'http', path: first(o.path) || '/', host: first(host) || '' };
  }
  if (net === 'xhttp') {
    const o = p['xhttp-opts'] || {};
    return { network: 'xhttp', path: o.path || '/', host: o.host || '', mode: o.mode || '' };
  }
  if (net === 'httpupgrade') {
    const o = p['http-upgrade-opts'] || p['ws-opts'] || {};
    return { network: 'httpupgrade', path: o.path || '/', host: (o.headers && o.headers.Host) || o.host || '' };
  }
  return { network: 'raw' };
}

function tls(p, forced = false) {
  const reality = p['reality-opts'];
  const on = forced || p.tls === true || Boolean(reality);
  if (!on) return { tls: '' };
  const out = {
    tls: reality ? 'reality' : 'tls',
    sni: p.servername || p.sni || '',
    fingerprint: p['client-fingerprint'] || '',
    alpn: Array.isArray(p.alpn) ? p.alpn : [],
    allowInsecure: p['skip-cert-verify'] === true,
  };
  if (reality) { out.publicKey = reality['public-key'] || ''; out.shortId = reality['short-id'] || ''; }
  if (p['ech-opts'] && p['ech-opts'].config) out.ech = p['ech-opts'].config;
  return out;
}

function convert(p) {
  const base = { remark: cleanText(p.name, 120), address: p.server, port: p.port };
  switch (String(p.type || '').toLowerCase()) {
    case 'vless':
      return { ...base, protocol: 'vless', uuid: p.uuid, flow: p.flow || '', encryption: p.encryption || 'none', ...transport(p), ...tls(p) };
    case 'vmess':
      return { ...base, protocol: 'vmess', uuid: p.uuid, alterId: p.alterId || 0, cipher: p.cipher || 'auto', ...transport(p), ...tls(p) };
    case 'trojan':
      return { ...base, protocol: 'trojan', password: p.password, ...transport(p), ...tls({ ...p, servername: p.sni || p.servername }, true) };
    case 'ss': {
      const s = { ...base, protocol: 'shadowsocks', cipher: p.cipher, password: p.password };
      const o = p['plugin-opts'] || {};
      if (p.plugin === 'obfs') { s.plugin = 'obfs-local'; s.pluginOpts = `obfs=${o.mode || 'http'}${o.host ? `;obfs-host=${o.host}` : ''}`; }
      else if (p.plugin === 'v2ray-plugin') { s.plugin = 'v2ray-plugin'; s.pluginOpts = [`mode=${o.mode || 'websocket'}`, o.tls ? 'tls' : '', o.host ? `host=${o.host}` : '', o.path ? `path=${o.path}` : ''].filter(Boolean).join(';'); }
      else if (p.plugin) throw new Error(`unsupported plugin ${cleanText(p.plugin, 20)}`);
      return s;
    }
    case 'hysteria2':
      return {
        ...base, protocol: 'hysteria2', password: p.password || p.auth || '', ...tls(p, true),
        obfs: p.obfs === 'salamander' ? 'salamander' : '', obfsPassword: p['obfs-password'] || '',
        hopPorts: p.ports ? String(p.ports).replace(/\s/g, '') : '', upMbps: mbps(p.up), downMbps: mbps(p.down),
      };
    case 'hysteria':
      return { ...base, protocol: 'hysteria', password: p['auth-str'] || p.auth || '', ...tls(p, true), obfsPassword: p.obfs || '', upMbps: mbps(p.up), downMbps: mbps(p.down) };
    case 'tuic':
      return {
        ...base, protocol: 'tuic', uuid: p.uuid, password: p.password || '', ...tls(p, true),
        congestion: p['congestion-controller'] || 'bbr', udpRelayMode: p['udp-relay-mode'] || 'native',
      };
    case 'wireguard': {
      if (p['amnezia-wg-option']) throw new Error('AMNEZIA_UNSUPPORTED');
      const addr = [p.ip && (String(p.ip).includes('/') ? p.ip : `${p.ip}/32`), p.ipv6 && (String(p.ipv6).includes('/') ? p.ipv6 : `${p.ipv6}/128`)].filter(Boolean);
      return {
        ...base, protocol: 'wireguard', privateKey: p['private-key'], peerPublicKey: p['public-key'], presharedKey: p['pre-shared-key'] || '',
        localAddress: addr, reserved: Array.isArray(p.reserved) ? p.reserved : [], mtu: p.mtu || 1280,
      };
    }
    case 'socks5':
      return { ...base, protocol: 'socks', username: p.username || '', password: p.password || '' };
    case 'http':
      return { ...base, protocol: 'http', username: p.username || '', password: p.password || '', ...(p.tls ? tls(p, true) : {}) };
    case 'anytls':
      return { ...base, protocol: 'anytls', password: p.password, ...tls(p, true) };
    default:
      throw new Error(`unsupported type ${cleanText(p.type, 20)}`);
  }
}

/** Returns { servers, errors } for a Clash/Mihomo YAML document. */
function parseClash(text) {
  if (String(text).length > MAX_YAML) throw new Error('file too large');
  // Plain data only: no custom tags, no aliases blow-up.
  const doc = YAML.parse(String(text), { maxAliasCount: 100, customTags: [], uniqueKeys: false });
  const list = doc && Array.isArray(doc.proxies) ? doc.proxies.slice(0, 5000) : [];
  const servers = [];
  const errors = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    try { servers.push(normalizeServer(convert(p))); } catch (e) { errors.push({ line: cleanText(p.name, 60), error: cleanText(e.message, 120) }); }
  }
  return { servers, errors };
}

module.exports = { parseClash, looksLikeClash };
