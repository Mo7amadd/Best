'use strict';
// Parse and build proxy share links (vmess, vless, trojan, ss, socks, hysteria2, tuic, wireguard).
// Every value coming from a link is treated as untrusted: it is cleaned, length-limited and validated
// before it can reach a core config.

const {
  cleanText, safeDecodeURIComponent, decodeComponent, b64decode, b64encode,
  parsePort, parseHost, randomId, splitList, boolish, isIPv6, unsafeXrayJson,
} = require('./util');

const MAX_LINK_LENGTH = 16384;

const PROTOCOLS = ['vmess', 'vless', 'trojan', 'shadowsocks', 'socks', 'http', 'hysteria2', 'hysteria', 'tuic', 'wireguard', 'anytls', 'naive', 'masque'];
const NETWORKS = ['raw', 'ws', 'grpc', 'httpupgrade', 'xhttp', 'kcp', 'h2', 'quic'];
const SS_PLUGINS = ['obfs-local', 'v2ray-plugin'];
const SS_METHODS = [
  'aes-128-gcm', 'aes-256-gcm', 'chacha20-poly1305', 'chacha20-ietf-poly1305',
  'xchacha20-poly1305', 'xchacha20-ietf-poly1305', '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305', 'none', 'plain',
];
const VMESS_CIPHERS = ['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none', 'zero'];
const FINGERPRINTS = ['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', '360', 'qq', 'random', 'randomized', 'randomizednoalpn', 'unsafe'];
const FLOWS = ['', 'xtls-rprx-vision', 'xtls-rprx-vision-udp443'];

function normNetwork(n) {
  const v = String(n || '').toLowerCase();
  if (!v || v === 'tcp' || v === 'raw') return 'raw';
  if (v === 'splithttp' || v === 'xhttp') return 'xhttp';
  if (v === 'h2' || v === 'http') return 'h2';
  if (v === 'mkcp') return 'kcp';
  if (NETWORKS.includes(v)) return v;
  throw new Error('unsupported transport: ' + cleanText(v, 20));
}

function normTls(v) {
  const s = String(v || '').toLowerCase();
  if (s === 'tls' || s === 'xtls') return 'tls';
  if (s === 'reality') return 'reality';
  return '';
}

function pick(list, value, fallback) {
  const v = String(value || '').toLowerCase();
  return list.includes(v) ? v : fallback;
}

/** Drop empty values so stored servers stay small and readable. */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

function remarkFromHash(hash) {
  return cleanText(decodeComponent(hash), 120);
}

/** Split `scheme://userinfo@host:port/path?query#fragment` without relying on URL special-scheme rules. */
function splitUrl(link) {
  const m = /^([a-z0-9+.-]+):\/\/([^#]*)(?:#(.*))?$/is.exec(link);
  if (!m) throw new Error('not a link');
  const scheme = m[1].toLowerCase();
  let rest = m[2];
  const hash = m[3] || '';
  let query = '';
  const qi = rest.indexOf('?');
  if (qi >= 0) { query = rest.slice(qi + 1); rest = rest.slice(0, qi); }
  let path = '';
  const si = rest.indexOf('/');
  if (si >= 0) { path = rest.slice(si); rest = rest.slice(0, si); }
  let userinfo = '';
  const at = rest.lastIndexOf('@');
  if (at >= 0) { userinfo = rest.slice(0, at); rest = rest.slice(at + 1); }
  let host = rest;
  let port = '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end < 0) throw new Error('bad IPv6 address');
    port = host.slice(end + 1).replace(/^:/, '');
    host = host.slice(0, end + 1);
  } else {
    const ci = host.lastIndexOf(':');
    if (ci >= 0) { port = host.slice(ci + 1); host = host.slice(0, ci); }
  }
  const params = {};
  for (const part of query.split('&')) {
    if (!part) continue;
    const ei = part.indexOf('=');
    const k = safeDecodeURIComponent(ei >= 0 ? part.slice(0, ei) : part);
    const v = ei >= 0 ? safeDecodeURIComponent(part.slice(ei + 1)) : '';
    if (k && !(k in params)) params[k] = v;
  }
  return { scheme, userinfo, host, port, path, params, hash };
}

// Newer share-link parameters (3x-ui / Xray 26). All validated by shape before use.
const B64ISH = /^[A-Za-z0-9+/=_-]{1,8192}$/;
const PIN_LIST = /^[0-9A-Fa-f:+/=,_-]{8,2048}$/;
const CIPHER_LIST = /^[A-Za-z0-9_:,-]{1,512}$/;
const HOP_PORTS = /^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/;

function matchText(v, re, max) {
  const s = cleanText(v, max);
  return s && re.test(s) ? s : '';
}

// ---- MASQUE (Xray 26.11+): CONNECT-IP over HTTP/3 or HTTP/2. No share-link format exists.
const MASQUE_DEFAULT_PATH = '/.well-known/masque/ip/{target}/{ipproto}/';
const MASQUE_WARP_SNI = 'consumer-masque.cloudflareclient.com';
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const isIp = (x) => IPV4.test(x) || (x.includes(':') && isIPv6(x));
const isIpOrPrefix = (x) => {
  const m = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(x);
  if (!m || !isIp(m[1])) return false;
  return m[2] === undefined || Number(m[2]) <= (m[1].includes(':') ? 128 : 32);
};

/** The request path as Xray takes it: starts with "/", only the {target} / {ipproto} variables. */
function masquePath(v) {
  const p = cleanText(v, 1024);
  if (!p) return '';
  const rest = p.replace(/\{\?target,ipproto\}|\{\?ipproto,target\}|\{&target,ipproto\}|\{&ipproto,target\}|\{target\}|\{ipproto\}/g, '');
  if (!p.startsWith('/') || /[{}\s"\\]/.test(rest)) throw new Error('MASQUE: the path must start with "/" and may only use {target} and {ipproto}');
  return p;
}

/** A WARP key as PEM or base64 DER → one line of base64 (what Xray reads; PEM bodies are base64 DER). */
function warpKey(v) {
  const raw = String(v === undefined || v === null ? '' : v).slice(0, 4096);
  const b64 = raw.replace(/-----(BEGIN|END)[A-Z0-9 ]{1,40}-----/g, '').replace(/\s+/g, '');
  if (!b64) return '';
  if (!/^[A-Za-z0-9+/]{40,2048}={0,2}$/.test(b64)) throw new Error('MASQUE: a WARP key must be PEM or base64');
  return b64;
}

/** A list from an array or comma / new-line separated text. */
const listOf = (v, max) => (Array.isArray(v) ? v : String(v === undefined || v === null ? '' : v).split(/[,\n]/)).map((x) => cleanText(x, 64)).filter(Boolean).slice(0, max);

function normalizeMasque(s, input) {
  const path = masquePath(input.path);
  if (path) s.path = path;
  const host = cleanText(input.host, 260);
  if (host) {
    if (!/^(\[[0-9a-f:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/i.test(host)) throw new Error('MASQUE: invalid host');
    s.host = host;
  }
  const dns = listOf(input.remoteDns, 4);
  if (dns.some((x) => !isIp(x))) throw new Error('MASQUE: remote DNS takes IP addresses only');
  if (dns.length) s.remoteDns = dns;
  const priv = warpKey(input.warpPrivateKey);
  if (priv) {
    // WARP: Cloudflare's endpoint, signed in with an enrolled key instead of a user name / password.
    s.warpPrivateKey = priv;
    s.warpPublicKey = warpKey(input.warpPublicKey);
    const addr = listOf(input.warpAddress, 2);
    if (!s.warpPublicKey || !addr.length) throw new Error('MASQUE: WARP needs the private key, the endpoint public key and the tunnel addresses');
    if (addr.some((x) => !isIpOrPrefix(x)) || addr.filter((x) => x.includes(':')).length > 1 || addr.filter((x) => !x.includes(':')).length > 1) {
      throw new Error('MASQUE: WARP takes at most one IPv4 and one IPv6 tunnel address');
    }
    s.warpAddress = addr;
    delete s.username;
    delete s.password;
    if (!s.sni) s.sni = MASQUE_WARP_SNI;
    return;
  }
  if (s.username && s.username.includes(':')) throw new Error('MASQUE: the user name cannot contain ":"');
}

/** A JSON object given as text (e.g. fm=… finalmask). Returns compact JSON or ''. */
function jsonObjectText(v, max = 8192) {
  const s = cleanText(v, max);
  if (!s) return '';
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' && !Array.isArray(o) ? JSON.stringify(o) : '';
  } catch { return ''; }
}

function intIn(v, min, max) {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : 0;
}

function extraStreamParams(p, network) {
  return {
    authority: network === 'grpc' ? cleanText(p.authority, 253) : '',
    mtu: network === 'kcp' ? intIn(p.mtu, 576, 1460) : 0,
    tti: network === 'kcp' ? intIn(p.tti, 10, 100) : 0,
    finalmask: jsonObjectText(p.fm),
  };
}

function extraTlsParams(p) {
  return {
    ech: matchText(p.ech, B64ISH, 8192),
    pcs: matchText(p.pcs, PIN_LIST, 2048),
    vcn: cleanText(p.vcn, 253),
    cipherSuites: matchText(p.cs, CIPHER_LIST, 512),
  };
}

/** Transport + TLS fields shared by vless / trojan / vmess(url form). */
function streamFromParams(p, defaults = {}) {
  const network = normNetwork(p.type || p.net || defaults.network);
  const tls = normTls(p.security ?? defaults.security);
  const s = {
    network,
    headerType: cleanText(p.headerType, 32),
    host: cleanText(p.host, 253),
    path: cleanText(p.path, 1024),
    serviceName: cleanText(p.serviceName || (network === 'grpc' ? p.path : ''), 256),
    mode: cleanText(p.mode, 32),
    seed: cleanText(p.seed, 128),
    extra: cleanText(p.extra, 16384),
    tls,
  };
  if (network === 'grpc') s.path = '';
  Object.assign(s, extraStreamParams(p, network));
  if (tls) {
    s.sni = cleanText(p.sni || p.peer, 253);
    s.alpn = splitList(p.alpn);
    s.fingerprint = pick(FINGERPRINTS, p.fp, '');
    s.allowInsecure = boolish(p.allowInsecure ?? p.insecure);
    Object.assign(s, extraTlsParams(p));
  }
  if (tls === 'reality') {
    s.publicKey = cleanText(p.pbk || p.password, 128);
    s.shortId = cleanText(p.sid, 32);
    s.spiderX = cleanText(p.spx, 256);
    s.pqv = matchText(p.pqv, B64ISH, 8192);
    // Panels on Xray 26+ add this; that REALITY server only works with Xray clients.
    if (boolish(p['support-x25519mlkem768'])) s.pqKex = true;
    if (!s.publicKey) throw new Error('REALITY link without public key');
  }
  if (s.extra) {
    try { JSON.parse(s.extra); } catch { s.extra = ''; }
  }
  // x_padding_bytes=… is the short form of extra.xPaddingBytes.
  if (network === 'xhttp' && p.x_padding_bytes && /^\d{1,6}(-\d{1,6})?$/.test(String(p.x_padding_bytes))) {
    let extra = {};
    try { extra = s.extra ? JSON.parse(s.extra) : {}; } catch { extra = {}; }
    if (extra.xPaddingBytes === undefined) extra.xPaddingBytes = String(p.x_padding_bytes);
    s.extra = JSON.stringify(extra);
  }
  return s;
}

const XHTTP_EXTRA_KEYS = ['xPaddingBytes', 'xPaddingObfsMode', 'xPaddingKey', 'xPaddingHeader', 'xPaddingPlacement', 'xPaddingMethod',
  'uplinkHTTPMethod', 'sessionIDPlacement', 'sessionIDKey', 'sessionIDTable', 'sessionIDLength', 'sessionPlacement', 'sessionKey',
  'seqPlacement', 'seqKey', 'uplinkDataPlacement', 'uplinkDataKey', 'scMaxEachPostBytes', 'scMinPostsIntervalMs', 'uplinkChunkSize',
  'noGRPCHeader', 'xmux', 'downloadSettings', 'headers'];

function parseVless(u) {
  const uuid = cleanText(decodeComponent(u.userinfo), 128);
  if (!uuid) throw new Error('missing id');
  const p = u.params;
  return {
    protocol: 'vless',
    remark: remarkFromHash(u.hash),
    address: parseHost(u.host),
    port: parsePort(u.port),
    uuid,
    encryption: cleanText(p.encryption, 512) || 'none',
    flow: pick(FLOWS, p.flow, ''),
    ...streamFromParams(p),
  };
}

function parseTrojan(u) {
  const password = cleanText(decodeComponent(u.userinfo), 256);
  if (!password) throw new Error('missing password');
  const p = u.params;
  return {
    protocol: 'trojan',
    remark: remarkFromHash(u.hash),
    address: parseHost(u.host),
    port: parsePort(u.port),
    password,
    flow: pick(FLOWS, p.flow, ''),
    ...streamFromParams(p, { security: 'tls' }),
  };
}

function parseVmess(link) {
  const body = link.slice('vmess://'.length);
  let json = null;
  try { json = JSON.parse(b64decode(body.split('#')[0])); } catch { json = null; }
  if (!json || typeof json !== 'object') {
    // Some clients export vmess in the URL form: vmess://uuid@host:port?type=ws...
    const u = splitUrl(link);
    const v = parseVless(u);
    return { ...v, protocol: 'vmess', cipher: pick(VMESS_CIPHERS, u.params.encryption, 'auto'), encryption: undefined, flow: undefined };
  }
  const net = normNetwork(json.net);
  const p = {
    type: net,
    security: json.tls,
    headerType: json.type,
    host: json.host,
    path: json.path,
    sni: json.sni,
    alpn: json.alpn,
    fp: json.fp,
    allowInsecure: json.allowInsecure ?? json.insecure,
    mode: net === 'grpc' ? json.type : json.mode,
    authority: json.authority,
    mtu: json.mtu,
    tti: json.tti,
    ech: json.ech,
    vcn: json.vcn,
    pcs: json.pcs,
    cs: json.cs,
    fm: typeof json.fm === 'object' && json.fm ? JSON.stringify(json.fm) : json.fm,
    extra: typeof json.extra === 'object' && json.extra ? JSON.stringify(json.extra) : json.extra,
  };
  // 3x-ui merges the XHTTP "extra" keys straight into the vmess object.
  if (net === 'xhttp' && !p.extra) {
    const extra = {};
    for (const k of XHTTP_EXTRA_KEYS) if (json[k] !== undefined) extra[k] = json[k];
    if (json.x_padding_bytes) extra.xPaddingBytes = json.x_padding_bytes;
    if (Object.keys(extra).length) p.extra = JSON.stringify(extra);
  }
  if (net === 'grpc') { p.serviceName = json.path; p.headerType = ''; }
  if (net === 'kcp') p.seed = json.path;
  const stream = streamFromParams(p);
  if (net === 'kcp') stream.path = '';
  return {
    protocol: 'vmess',
    remark: cleanText(json.ps, 120),
    address: parseHost(json.add),
    port: parsePort(json.port),
    uuid: cleanText(json.id, 128),
    alterId: Number.parseInt(json.aid, 10) || 0,
    cipher: pick(VMESS_CIPHERS, json.scy, 'auto'),
    ...stream,
  };
}

function parseShadowsocks(link) {
  const hashIdx = link.indexOf('#');
  const hash = hashIdx >= 0 ? link.slice(hashIdx + 1) : '';
  let body = link.slice('ss://'.length, hashIdx >= 0 ? hashIdx : undefined);
  let method;
  let password;
  let hostPort;
  let params = {};
  const qi = body.indexOf('?');
  if (qi >= 0) {
    for (const part of body.slice(qi + 1).split('&')) {
      const [k, v = ''] = part.split('=');
      if (k) params[safeDecodeURIComponent(k)] = safeDecodeURIComponent(v);
    }
    body = body.slice(0, qi);
  }
  body = body.replace(/\/$/, '');
  const at = body.lastIndexOf('@');
  if (at >= 0) {
    let userinfo = decodeComponent(body.slice(0, at));
    if (!userinfo.includes(':')) userinfo = b64decode(userinfo);
    const ci = userinfo.indexOf(':');
    method = userinfo.slice(0, ci);
    password = userinfo.slice(ci + 1);
    hostPort = body.slice(at + 1);
  } else {
    const decoded = b64decode(body);
    const at2 = decoded.lastIndexOf('@');
    if (at2 < 0) throw new Error('bad shadowsocks link');
    const cred = decoded.slice(0, at2);
    const ci = cred.indexOf(':');
    method = cred.slice(0, ci);
    password = cred.slice(ci + 1);
    hostPort = decoded.slice(at2 + 1);
  }
  const u = splitUrl('ss://' + hostPort);
  method = String(method || '').toLowerCase();
  if (!SS_METHODS.includes(method)) throw new Error('unsupported cipher: ' + cleanText(method, 40));
  const out = {
    protocol: 'shadowsocks',
    remark: remarkFromHash(hash),
    address: parseHost(u.host),
    port: parsePort(u.port),
    cipher: method,
    password: cleanText(password, 256),
  };
  if (params.plugin) {
    const [name, ...opts] = params.plugin.split(';');
    const plugin = name === 'simple-obfs' ? 'obfs-local' : name;
    if (!SS_PLUGINS.includes(plugin)) throw new Error('unsupported shadowsocks plugin: ' + cleanText(name, 30));
    out.plugin = plugin;
    out.pluginOpts = cleanText(opts.join(';'), 512);
  }
  return out;
}

function parseHysteria(u) {
  const p = u.params;
  return {
    protocol: 'hysteria',
    remark: remarkFromHash(u.hash),
    address: parseHost(u.host),
    port: parsePort(u.port),
    password: cleanText(p.auth || decodeComponent(u.userinfo), 256),
    tls: 'tls',
    sni: cleanText(p.peer || p.sni, 253),
    alpn: splitList(p.alpn || 'hysteria'),
    allowInsecure: boolish(p.insecure),
    obfsPassword: cleanText(p.obfsParam || p.obfs, 256),
    upMbps: Number.parseInt(p.upmbps, 10) || 50,
    downMbps: Number.parseInt(p.downmbps, 10) || 100,
  };
}

function parseAnyTls(u) {
  const p = u.params;
  return {
    protocol: 'anytls',
    remark: remarkFromHash(u.hash),
    address: parseHost(u.host),
    port: parsePort(u.port || 443),
    password: cleanText(decodeComponent(u.userinfo), 256),
    tls: 'tls',
    sni: cleanText(p.sni || p.peer, 253),
    alpn: splitList(p.alpn),
    fingerprint: pick(FINGERPRINTS, p.fp, ''),
    allowInsecure: boolish(p.insecure ?? p.allowInsecure),
  };
}

function parseNaive(u, quic) {
  const info = decodeComponent(u.userinfo);
  const ci = info.indexOf(':');
  return {
    protocol: 'naive',
    remark: remarkFromHash(u.hash),
    address: parseHost(u.host),
    port: parsePort(u.port || 443),
    username: cleanText(ci >= 0 ? info.slice(0, ci) : info, 128),
    password: cleanText(ci >= 0 ? info.slice(ci + 1) : '', 256),
    tls: 'tls',
    sni: cleanText(u.params.sni, 253),
    network: quic ? 'quic' : undefined,
  };
}

function parseSocks(u) {
  let user = '';
  let pass = '';
  if (u.userinfo) {
    let info = decodeComponent(u.userinfo);
    if (!info.includes(':')) {
      try { info = b64decode(info); } catch { /* plain username */ }
    }
    const ci = info.indexOf(':');
    user = ci >= 0 ? info.slice(0, ci) : info;
    pass = ci >= 0 ? info.slice(ci + 1) : '';
  }
  return {
    protocol: 'socks',
    remark: remarkFromHash(u.hash),
    address: parseHost(u.host),
    port: parsePort(u.port),
    username: cleanText(user, 128),
    password: cleanText(pass, 256),
  };
}

function parseHysteria2(u) {
  const p = u.params;
  const auth = cleanText(decodeComponent(u.userinfo), 256);
  return {
    protocol: 'hysteria2',
    remark: remarkFromHash(u.hash),
    address: parseHost(u.host),
    port: parsePort(u.port || 443),
    password: auth,
    tls: 'tls',
    sni: cleanText(p.sni, 253),
    alpn: splitList(p.alpn),
    allowInsecure: boolish(p.insecure ?? p.allowInsecure),
    obfs: ['salamander', 'gecko'].includes(p.obfs) ? p.obfs : '',
    obfsPassword: cleanText(p['obfs-password'], 256),
    // gecko = salamander with a packet-size range (minPacketSize-maxPacketSize)
    packetSize: p.obfs === 'gecko' && intIn(p.minPacketSize, 1, 65535) && intIn(p.maxPacketSize, 1, 65535)
      ? `${intIn(p.minPacketSize, 1, 65535)}-${intIn(p.maxPacketSize, 1, 65535)}` : '',
    pcs: matchText(p.pinSHA256, PIN_LIST, 2048),
    hopPorts: matchText(p.mport, HOP_PORTS, 256),
    ech: matchText(p.ech, B64ISH, 8192),
    vcn: cleanText(p.vcn, 253),
    fingerprint: pick(FINGERPRINTS, p.fp, ''),
    finalmask: jsonObjectText(p.fm),
    upMbps: Number.parseInt(p.upmbps || p.up, 10) || 0,
    downMbps: Number.parseInt(p.downmbps || p.down, 10) || 0,
  };
}

function parseTuic(u) {
  const p = u.params;
  const info = decodeComponent(u.userinfo);
  const ci = info.indexOf(':');
  return {
    protocol: 'tuic',
    remark: remarkFromHash(u.hash),
    address: parseHost(u.host),
    port: parsePort(u.port),
    uuid: cleanText(ci >= 0 ? info.slice(0, ci) : info, 128),
    password: cleanText(ci >= 0 ? info.slice(ci + 1) : '', 256),
    tls: 'tls',
    sni: cleanText(p.sni, 253),
    alpn: splitList(p.alpn || 'h3'),
    allowInsecure: boolish(p.allow_insecure ?? p.insecure ?? p.allowInsecure),
    congestion: pick(['bbr', 'cubic', 'new_reno'], p.congestion_control, 'bbr'),
    udpRelayMode: pick(['native', 'quic'], p.udp_relay_mode, 'native'),
  };
}

function parseWireguard(u) {
  const p = u.params;
  const reserved = splitList(p.reserved, 3).map((x) => Number.parseInt(x, 10)).filter((n) => n >= 0 && n <= 255);
  return {
    protocol: 'wireguard',
    remark: remarkFromHash(u.hash),
    address: parseHost(u.host),
    port: parsePort(u.port),
    privateKey: cleanText(decodeComponent(u.userinfo), 128),
    peerPublicKey: cleanText(p.publickey || p.publicKey, 128),
    presharedKey: cleanText(p.presharedkey || p.preSharedKey, 128),
    localAddress: splitList(p.address || p.ip || '10.0.0.2/32', 4),
    reserved: reserved.length === 3 ? reserved : [],
    mtu: Number.parseInt(p.mtu, 10) || 1280,
  };
}

/** Parse one share link. Throws on anything malformed or unsupported. */
function parseLink(raw) {
  const link = cleanText(raw, MAX_LINK_LENGTH);
  if (!link) throw new Error('empty line');
  const scheme = (/^([a-z0-9+.-]+):\/\//i.exec(link) || [])[1];
  if (!scheme) throw new Error('not a share link');
  let s;
  switch (scheme.toLowerCase()) {
    case 'vmess': s = parseVmess(link); break;
    case 'vless': s = parseVless(splitUrl(link)); break;
    case 'trojan': s = parseTrojan(splitUrl(link)); break;
    case 'ss': s = parseShadowsocks(link); break;
    case 'socks': case 'socks5': s = parseSocks(splitUrl(link)); break;
    case 'hysteria2': case 'hy2': s = parseHysteria2(splitUrl(link)); break;
    case 'hysteria': s = parseHysteria(splitUrl(link)); break;
    case 'anytls': s = parseAnyTls(splitUrl(link)); break;
    case 'naive+https': s = parseNaive(splitUrl(link), false); break;
    case 'naive+quic': s = parseNaive(splitUrl(link), true); break;
    case 'tuic': s = parseTuic(splitUrl(link)); break;
    case 'wireguard': case 'wg': s = parseWireguard(splitUrl(link)); break;
    // AmneziaWG (3x-ui exports it as vpn://<base64 .conf>): neither Xray nor sing-box can run it.
    case 'vpn': case 'awg': throw new Error('AMNEZIA_UNSUPPORTED');
    default: throw new Error('unsupported link type: ' + cleanText(scheme, 20));
  }
  return normalizeServer(s);
}

const MAX_CUSTOM_CONFIG = 512 * 1024;

/** "Custom config": a full Xray or sing-box JSON the user pasted or opened, run as-is. */
function normalizeCustom(input) {
  const core = input.core === 'sing-box' ? 'sing-box' : 'xray';
  const text = String(input.config || '');
  if (text.length > MAX_CUSTOM_CONFIG) throw new Error('config too large');
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('invalid JSON'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('invalid JSON');
  let address = '';
  let port = 0;
  const ob = Array.isArray(obj.outbounds) ? obj.outbounds.find((o) => o && !['freedom', 'blackhole', 'dns', 'direct', 'block'].includes(o.protocol || o.type)) : null;
  if (ob) {
    const st = ob.settings || {};
    const v = (st.vnext && st.vnext[0]) || (st.servers && st.servers[0]) || st;
    address = v.address || ob.server || '';
    port = Number(v.port || ob.server_port) || 0;
  }
  const out = {
    id: /^[a-f0-9]{6,32}$/.test(input.id || '') ? input.id : randomId(),
    protocol: 'custom',
    remark: cleanText(input.remark, 120) || 'Custom',
    core,
    config: JSON.stringify(obj, null, 2),
    subId: cleanText(input.subId, 32),
    // From a JSON subscription: Best swaps the local inbounds for its own ports when running it.
    managedInbounds: input.managedInbounds === true,
  };
  try { out.address = parseHost(address); } catch { /* display only */ }
  if (port >= 1 && port <= 65535) out.port = port;
  if (Number.isFinite(input.delay)) out.delay = input.delay;
  if (Number.isFinite(input.speed)) out.speed = input.speed;
  if (Number.isFinite(input.udp)) out.udp = input.udp;
  for (const k of ['usageUp', 'usageDown']) if (Number.isFinite(input[k]) && input[k] >= 0) out[k] = input[k];
  return compact(out);
}

/** Local inbound ports declared by a custom config (used to know when the core is ready). */
function customInboundPorts(server) {
  try {
    const obj = JSON.parse(server.config);
    return (obj.inbounds || []).map((i) => Number(i.port || i.listen_port)).filter((p) => p > 0 && p < 65536);
  } catch { return []; }
}

/** Validate a server object (from a link, the editor or a backup) and return a clean copy. */
function normalizeServer(input) {
  if (!input || typeof input !== 'object') throw new Error('invalid server');
  const protocol = String(input.protocol || '').toLowerCase();
  if (protocol === 'custom') return normalizeCustom(input);
  if (protocol === 'group') return require('./group').normalizeGroup(input);
  if (!PROTOCOLS.includes(protocol)) throw new Error('unsupported protocol');
  const s = {
    id: /^[a-f0-9]{6,32}$/.test(input.id || '') ? input.id : randomId(),
    protocol,
    remark: cleanText(input.remark, 120),
    address: parseHost(input.address),
    port: parsePort(input.port),
    subId: cleanText(input.subId, 32),
  };
  const str = (k, max = 256) => { const v = cleanText(input[k], max); if (v) s[k] = v; };
  const num = (k, min, max) => { const n = Number(input[k]); if (Number.isFinite(n) && n >= min && n <= max && n !== 0) s[k] = Math.round(n); };

  if (['vmess', 'vless', 'tuic'].includes(protocol)) {
    str('uuid', 128);
    if (!s.uuid) throw new Error('missing id');
  }
  if (['trojan', 'shadowsocks', 'hysteria2', 'hysteria', 'tuic', 'socks', 'http', 'anytls', 'naive', 'masque'].includes(protocol)) str('password', 256);
  if (['trojan', 'shadowsocks', 'anytls'].includes(protocol) && !s.password) throw new Error('missing password');
  if (['socks', 'http', 'naive', 'masque'].includes(protocol)) str('username', 128);
  if (protocol === 'vmess') { s.cipher = pick(VMESS_CIPHERS, input.cipher, 'auto'); num('alterId', 0, 65535); }
  if (protocol === 'shadowsocks') {
    s.cipher = pick(SS_METHODS, input.cipher, '');
    if (!s.cipher) throw new Error('unsupported cipher');
    const plugin = pick(SS_PLUGINS, input.plugin, '');
    if (plugin) {
      s.plugin = plugin;
      const opts = cleanText(input.pluginOpts, 512);
      if (/^[A-Za-z0-9=;._\-/:@%]*$/.test(opts)) s.pluginOpts = opts;
    }
  }
  if (protocol === 'naive' && String(input.network) === 'quic') s.network = 'quic';
  if (protocol === 'vless') { s.encryption = cleanText(input.encryption, 512) || 'none'; }
  if (['vless', 'trojan'].includes(protocol)) { const f = pick(FLOWS, input.flow, ''); if (f) s.flow = f; }

  if (['vmess', 'vless', 'trojan', 'socks', 'http'].includes(protocol)) {
    const usesStream = ['vmess', 'vless', 'trojan'].includes(protocol);
    if (usesStream) {
      s.network = normNetwork(input.network);
      for (const k of ['headerType', 'mode']) str(k, 32);
      str('host', 253); str('path', 1024); str('serviceName', 256); str('seed', 128); str('extra', 16384);
      if (s.extra) { try { JSON.parse(s.extra); } catch { delete s.extra; } }
      // The XHTTP "extra" goes into Xray as written: refuse what could touch local files or crash the core.
      const bad = s.extra ? unsafeXrayJson(JSON.parse(s.extra), { files: true }) : '';
      if (bad) throw new Error(`XHTTP extra is not allowed: ${bad}`);
      if (s.network === 'grpc') str('authority', 253);
      if (s.network === 'kcp') { num('mtu', 576, 1460); num('tti', 10, 100); }
    }
    const tls = normTls(input.tls);
    if (tls && (usesStream || (protocol === 'http' && tls === 'tls'))) s.tls = tls;
  } else if (['hysteria2', 'hysteria', 'tuic', 'anytls', 'naive', 'masque'].includes(protocol)) {
    s.tls = 'tls';
  }
  if (s.tls) {
    str('sni', 253);
    const alpn = Array.isArray(input.alpn) ? input.alpn : splitList(input.alpn);
    const cleanAlpn = alpn.map((x) => cleanText(x, 32)).filter(Boolean).slice(0, 8);
    if (cleanAlpn.length) s.alpn = cleanAlpn;
    const fp = pick(FINGERPRINTS, input.fingerprint, '');
    if (fp) s.fingerprint = fp;
    if (boolish(input.allowInsecure)) s.allowInsecure = true;
    const ech = matchText(input.ech, B64ISH, 8192); if (ech) s.ech = ech;
    const pcs = matchText(input.pcs, PIN_LIST, 2048); if (pcs) s.pcs = pcs;
    str('vcn', 253);
    const cs = matchText(input.cipherSuites, CIPHER_LIST, 512); if (cs) s.cipherSuites = cs;
  }
  // finalmask (fm=…): Xray stream-level masks (fragment, noise, salamander, udphop…).
  if (protocol !== 'wireguard') {
    const fm = jsonObjectText(input.finalmask);
    if (fm && unsafeXrayJson(JSON.parse(fm), { files: true })) throw new Error('finalmask is not allowed');
    if (fm) s.finalmask = fm;
  }
  if (s.tls === 'reality') {
    str('publicKey', 128); str('shortId', 32); str('spiderX', 256);
    const pqv = matchText(input.pqv, B64ISH, 8192); if (pqv) s.pqv = pqv;
    if (boolish(input.pqKex)) s.pqKex = true;
    if (!s.publicKey) throw new Error('REALITY needs a public key');
  }
  if (protocol === 'hysteria2') {
    if (['salamander', 'gecko'].includes(input.obfs)) { s.obfs = input.obfs; str('obfsPassword', 256); }
    if (s.obfs === 'gecko' && /^\d{1,5}-\d{1,5}$/.test(String(input.packetSize || ''))) s.packetSize = String(input.packetSize);
    const hop = matchText(input.hopPorts, HOP_PORTS, 256); if (hop) s.hopPorts = hop;
    num('upMbps', 0, 100000); num('downMbps', 0, 100000);
  }
  if (protocol === 'hysteria') {
    str('obfsPassword', 256);
    num('upMbps', 1, 100000); num('downMbps', 1, 100000);
    if (!s.upMbps) s.upMbps = 50;
    if (!s.downMbps) s.downMbps = 100;
  }
  if (protocol === 'tuic') {
    s.congestion = pick(['bbr', 'cubic', 'new_reno'], input.congestion, 'bbr');
    s.udpRelayMode = pick(['native', 'quic'], input.udpRelayMode, 'native');
  }
  if (protocol === 'wireguard') {
    str('privateKey', 128); str('peerPublicKey', 128); str('presharedKey', 128);
    if (!s.privateKey || !s.peerPublicKey) throw new Error('WireGuard needs both keys');
    const la = Array.isArray(input.localAddress) ? input.localAddress : splitList(input.localAddress);
    s.localAddress = la.map((x) => cleanText(x, 64)).filter((x) => /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(x)).slice(0, 4);
    if (!s.localAddress.length) s.localAddress = ['10.0.0.2/32'];
    const rv = Array.isArray(input.reserved) ? input.reserved : splitList(input.reserved, 3);
    const r = rv.map((x) => Number.parseInt(x, 10)).filter((n) => n >= 0 && n <= 255);
    if (r.length === 3) s.reserved = r;
    num('mtu', 576, 9000);
  }
  if (protocol === 'masque') normalizeMasque(s, input);
  // Proxy chain: reach this server through another one (its id).
  if (/^[a-f0-9]{6,32}$/.test(input.via || '') && input.via !== s.id) s.via = input.via;
  // Keep runtime test results when re-normalizing stored servers.
  if (Number.isFinite(input.delay)) s.delay = input.delay;
  if (Number.isFinite(input.speed)) s.speed = input.speed;
  if (Number.isFinite(input.udp)) s.udp = input.udp;
  for (const k of ['usageUp', 'usageDown']) if (Number.isFinite(input[k]) && input[k] >= 0) s[k] = input[k];
  return compact(s);
}

// ---------------------------------------------------------------- building links

function q(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v === true ? '1' : Array.isArray(v) ? v.join(',') : String(v)));
  }
  return parts.length ? '?' + parts.join('&') : '';
}

function hostPart(s) {
  const h = s.address.includes(':') ? `[${s.address}]` : s.address;
  return `${h}:${s.port}`;
}

function streamParams(s) {
  const net = s.network || 'raw';
  const p = {
    type: net === 'raw' ? 'tcp' : net,
    security: s.tls || 'none',
    headerType: s.headerType,
    host: s.host,
    path: net === 'grpc' ? undefined : s.path,
    serviceName: net === 'grpc' ? s.serviceName : undefined,
    mode: s.mode,
    seed: s.seed,
    extra: s.extra,
    authority: s.authority,
    mtu: s.mtu,
    tti: s.tti,
    fm: s.finalmask,
  };
  if (s.tls) Object.assign(p, { sni: s.sni, alpn: s.alpn, fp: s.fingerprint, allowInsecure: s.allowInsecure, ech: s.ech, pcs: s.pcs, vcn: s.vcn, cs: s.cipherSuites });
  if (s.tls === 'reality') Object.assign(p, { pbk: s.publicKey, sid: s.shortId, spx: s.spiderX, pqv: s.pqv, 'support-x25519mlkem768': s.pqKex ? 'true' : undefined });
  return p;
}

/** Build a share link for a server so it can be copied, exported or shown as a QR code. */
function toLink(server) {
  const s = normalizeServer(server);
  if (s.protocol === 'custom') throw new Error('CUSTOM_NO_LINK');
  if (s.protocol === 'group') throw new Error('GROUP_NO_LINK');
  if (s.protocol === 'masque') throw new Error('MASQUE_NO_LINK');
  const name ='#' + encodeURIComponent(s.remark || s.address);
  switch (s.protocol) {
    case 'vless':
      return `vless://${encodeURIComponent(s.uuid)}@${hostPart(s)}${q({ encryption: s.encryption || 'none', flow: s.flow, ...streamParams(s) })}${name}`;
    case 'trojan':
      return `trojan://${encodeURIComponent(s.password)}@${hostPart(s)}${q({ flow: s.flow, ...streamParams(s) })}${name}`;
    case 'vmess': {
      const net = s.network || 'raw';
      const obj = {
        v: '2', ps: s.remark || '', add: s.address, port: String(s.port), id: s.uuid, aid: String(s.alterId || 0),
        scy: s.cipher || 'auto', net: net === 'raw' ? 'tcp' : net,
        type: net === 'grpc' ? (s.mode || 'gun') : (s.headerType || 'none'),
        host: s.host || '', path: net === 'grpc' ? (s.serviceName || '') : net === 'kcp' ? (s.seed || '') : (s.path || ''),
        tls: s.tls || '', sni: s.sni || '', alpn: (s.alpn || []).join(','), fp: s.fingerprint || '',
        ...(s.authority ? { authority: s.authority } : {}), ...(s.mtu ? { mtu: s.mtu } : {}), ...(s.tti ? { tti: s.tti } : {}),
        ...(s.ech ? { ech: s.ech } : {}), ...(s.pcs ? { pcs: s.pcs } : {}), ...(s.vcn ? { vcn: s.vcn } : {}), ...(s.cipherSuites ? { cs: s.cipherSuites } : {}),
        ...(s.finalmask ? { fm: s.finalmask } : {}), ...(s.extra ? { extra: JSON.parse(s.extra) } : {}),
      };
      return 'vmess://' + b64encode(JSON.stringify(obj));
    }
    case 'shadowsocks': {
      const user = s.cipher.startsWith('2022-')
        ? `${encodeURIComponent(s.cipher)}:${encodeURIComponent(s.password)}`
        : b64encode(`${s.cipher}:${s.password}`, true);
      const plugin = s.plugin ? `/?plugin=${encodeURIComponent([s.plugin, s.pluginOpts].filter(Boolean).join(';'))}` : '';
      return `ss://${user}@${hostPart(s)}${plugin}${name}`;
    }
    case 'hysteria':
      return `hysteria://${hostPart(s)}${q({
        protocol: 'udp', auth: s.password, peer: s.sni, insecure: s.allowInsecure, upmbps: s.upMbps, downmbps: s.downMbps,
        alpn: s.alpn, obfsParam: s.obfsPassword,
      })}${name}`;
    case 'anytls':
      return `anytls://${encodeURIComponent(s.password)}@${hostPart(s)}/${q({ sni: s.sni, alpn: s.alpn, fp: s.fingerprint, insecure: s.allowInsecure })}${name}`;
    case 'naive': {
      const auth = s.username ? `${encodeURIComponent(s.username)}:${encodeURIComponent(s.password || '')}@` : '';
      return `naive+${s.network === 'quic' ? 'quic' : 'https'}://${auth}${hostPart(s)}${q({ sni: s.sni })}${name}`;
    }
    case 'socks': {
      const auth = s.username ? b64encode(`${s.username}:${s.password || ''}`, true) + '@' : '';
      return `socks://${auth}${hostPart(s)}${name}`;
    }
    case 'http': {
      const auth = s.username ? `${encodeURIComponent(s.username)}:${encodeURIComponent(s.password || '')}@` : '';
      return `${s.tls ? 'https' : 'http'}://${auth}${hostPart(s)}${name}`;
    }
    case 'hysteria2':
      return `hysteria2://${encodeURIComponent(s.password || '')}@${hostPart(s)}/${q({
        sni: s.sni, alpn: s.alpn, insecure: s.allowInsecure, obfs: s.obfs, 'obfs-password': s.obfsPassword,
        minPacketSize: s.packetSize ? s.packetSize.split('-')[0] : undefined, maxPacketSize: s.packetSize ? s.packetSize.split('-')[1] : undefined,
        pinSHA256: s.pcs, mport: s.hopPorts, ech: s.ech, vcn: s.vcn, fp: s.fingerprint, fm: s.finalmask,
      })}${name}`;
    case 'tuic':
      return `tuic://${encodeURIComponent(s.uuid)}:${encodeURIComponent(s.password || '')}@${hostPart(s)}${q({
        sni: s.sni, alpn: s.alpn, allow_insecure: s.allowInsecure, congestion_control: s.congestion, udp_relay_mode: s.udpRelayMode,
      })}${name}`;
    case 'wireguard':
      return `wireguard://${encodeURIComponent(s.privateKey)}@${hostPart(s)}/${q({
        publickey: s.peerPublicKey, presharedkey: s.presharedKey, address: s.localAddress, reserved: s.reserved, mtu: s.mtu,
      })}${name}`;
    default:
      throw new Error('cannot build link');
  }
}

/** Fingerprint used for "remove duplicates": same endpoint + credentials + transport. */
function serverKey(s) {
  if (s.protocol === 'custom') return 'custom|' + s.config;
  if (s.protocol === 'group') return 'group|' + s.id;
  return [s.protocol, s.address, s.port, s.uuid || s.password || s.privateKey || '', s.network || '', s.path || s.serviceName || '', s.host || '', s.tls || ''].join('|');
}

// What describes a server's name, place or results, not how to connect to it.
const NOT_CONNECTION = new Set(['id', 'subId', 'remark', 'delay', 'speed', 'udp', 'usageUp', 'usageDown']);
const same = (x, y) => JSON.stringify(x === undefined ? null : x) === JSON.stringify(y === undefined ? null : y);
/**
 * True when two servers connect in exactly the same way (every setting: SNI, Reality keys, flow,
 * fingerprint…), whatever their names. Test results of a server are only kept across a
 * subscription update when this holds; serverKey() is looser and only keeps the server's place.
 */
function sameConnection(a, b) {
  let x; let y;
  try { x = normalizeServer({ ...a, id: 'x' }); y = normalizeServer({ ...b, id: 'x' }); } catch { return false; }
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (!NOT_CONNECTION.has(k) && !same(x[k], y[k])) return false;
  }
  return true;
}

/** Short human description of the transport, e.g. "WS + TLS". */
function transportLabel(s) {
  if (s.protocol === 'custom') return s.core === 'sing-box' ? 'sing-box JSON' : 'Xray JSON';
  if (s.protocol === 'group') return `${(s.members || []).length + (s.memberSub ? 1 : 0)} × ${s.strategy}`;
  if (['hysteria2', 'hysteria', 'tuic'].includes(s.protocol)) return 'QUIC';
  if (s.protocol === 'wireguard') return 'UDP';
  if (s.protocol === 'naive') return s.network === 'quic' ? 'QUIC' : 'HTTPS';
  if (s.protocol === 'anytls') return 'TCP + TLS';
  if (s.protocol === 'masque') return `${s.warpPrivateKey ? 'WARP · ' : ''}${(s.alpn || []).length === 1 && s.alpn[0] === 'h2' ? 'HTTP/2' : 'HTTP/3'}`;
  if (s.protocol === 'shadowsocks' && s.plugin) return s.plugin === 'v2ray-plugin' ? 'v2ray-plugin' : 'obfs';
  if (['shadowsocks', 'socks', 'http'].includes(s.protocol) && !s.network) return s.tls ? 'TCP + TLS' : 'TCP';
  const net = (s.network || 'raw') === 'raw' ? 'TCP' : s.network === 'httpupgrade' ? 'HTTPUpgrade' : s.network === 'kcp' ? 'mKCP' : s.network.toUpperCase();
  return s.tls === 'reality' ? `${net} + REALITY` : s.tls ? `${net} + TLS` : net;
}

module.exports = {
  PROTOCOLS, NETWORKS, SS_METHODS, SS_PLUGINS, VMESS_CIPHERS, FINGERPRINTS, FLOWS,
  parseLink, normalizeServer, toLink, serverKey, sameConnection, transportLabel, splitUrl, customInboundPorts,
};
