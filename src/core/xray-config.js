'use strict';
const { checkSs2022Key } = require('./util');
// Build Xray-core JSON configs from normalized servers + settings + routing.

const XRAY_PROTOCOLS = ['vmess', 'vless', 'trojan', 'shadowsocks', 'socks', 'http', 'wireguard'];

const { xrayCountryRules, securityBlockRules } = require('./country');

/**
 * Hysteria2 normally runs on sing-box; Xray 26 has its own Hysteria2 client, used when the link asks
 * for something only Xray does (gecko obfs, a pinned certificate, ECH, finalmask masks).
 */
function hysteriaNeedsXray(s) {
  return s.protocol === 'hysteria2' && Boolean(s.obfs === 'gecko' || s.pcs || s.ech || s.vcn || s.finalmask);
}

/** Xray dropped H2/QUIC transports and never had SS plugins, AnyTLS, Naive, TUIC → sing-box. */
function needsSingBox(server) {
  if (hysteriaNeedsXray(server)) return false;
  return !XRAY_PROTOCOLS.includes(server.protocol)
    || ['h2', 'quic'].includes(server.network)
    || (server.protocol === 'shadowsocks' && Boolean(server.plugin));
}

const PRIVATE_ADDR = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|localhost$|::1$|f[cd][0-9a-f]{2}:)/i;

/** VLESS / Trojan with no TLS: unencrypted on the wire. */
function isUnencrypted(s) {
  return ['vless', 'trojan'].includes(s.protocol) && !s.tls;
}

/**
 * Xray 26 refuses VLESS/Trojan without TLS to public addresses. For servers the user explicitly
 * added anyway, the outbound dials a local forwarder (127.0.0.1) inside the same Xray instance,
 * which relays the bytes to the real server. Nothing else changes; the UI marks them unencrypted.
 */
function needsLoopback(s) {
  return isUnencrypted(s) && !PRIVATE_ADDR.test(s.address);
}

function loopbackInbound(s, port, tag) {
  return {
    tag, protocol: 'dokodemo-door', listen: '127.0.0.1', port,
    settings: { address: s.address, port: s.port, network: 'tcp,udp' },
  };
}

/** The same server, dialled through the local forwarder, keeping the real Host / authority. */
function viaLoopback(s, port) {
  return { ...s, address: '127.0.0.1', port, host: s.host || s.address, __authority: s.host || s.address };
}

/** ECH, certificate pinning and cipher suites (newer 3x-ui links). A pin replaces allowInsecure. */
function applyTlsExtras(tls, s) {
  if (s.ech) tls.echConfigList = s.ech;
  if (s.pcs) tls.pinnedPeerCertSha256 = s.pcs;
  if (s.vcn) tls.verifyPeerCertByName = s.vcn;
  if (s.cipherSuites) tls.cipherSuites = s.cipherSuites;
  if (s.allowInsecure && !s.pcs) tls.allowInsecure = true;
}

/** finalmask from the link (fm=…), merged with masks Best adds itself (e.g. Hysteria obfs). */
function applyFinalMask(ss, s, extra) {
  let fm = null;
  if (s.finalmask) { try { fm = JSON.parse(s.finalmask); } catch { fm = null; } }
  if (extra) {
    fm = fm || {};
    for (const k of ['tcp', 'udp']) if (extra[k]) fm[k] = [...(Array.isArray(fm[k]) ? fm[k] : []), ...extra[k]];
  }
  if (fm && typeof fm === 'object' && Object.keys(fm).length) ss.finalmask = fm;
}

/** Hysteria2 through Xray 26 native outbound (same shape 3x-ui generates for its JSON subscriptions). */
function hysteriaOutbound(s, tag) {
  const tls = { serverName: s.sni || s.address, alpn: s.alpn && s.alpn.length ? s.alpn : ['h3'] };
  if (s.fingerprint) tls.fingerprint = s.fingerprint;
  applyTlsExtras(tls, s);
  const udp = [];
  if (s.obfs && s.obfsPassword) {
    const settings = { password: s.obfsPassword };
    if (s.obfs === 'gecko' && s.packetSize) settings.packetSize = s.packetSize;
    udp.push({ type: 'salamander', settings });
  }
  if (s.hopPorts) udp.push({ type: 'udphop', settings: { mode: 'intervalRemote', remotePorts: s.hopPorts } });
  const ss = { network: 'hysteria', security: 'tls', tlsSettings: tls, hysteriaSettings: { version: 2, auth: s.password || '' } };
  applyFinalMask(ss, s, udp.length ? { udp } : null);
  return { tag, protocol: 'hysteria', settings: { version: 2, address: s.address, port: s.port }, streamSettings: ss };
}

function streamSettings(s, settings) {
  if (s.protocol === 'wireguard') return undefined;
  const network = s.network || 'raw';
  const ss = { network, security: s.tls || 'none' };
  if (network === 'raw' && s.headerType === 'http') {
    ss.rawSettings = {
      header: {
        type: 'http',
        request: { path: [(s.path || '/')], headers: s.host ? { Host: s.host.split(',').map((h) => h.trim()) } : {} },
      },
    };
  } else if (network === 'ws') {
    ss.wsSettings = { path: s.path || '/', host: s.host || '' };
  } else if (network === 'httpupgrade') {
    ss.httpupgradeSettings = { path: s.path || '/', host: s.host || '' };
  } else if (network === 'grpc') {
    ss.grpcSettings = { serviceName: s.serviceName || '', multiMode: s.mode === 'multi' };
    if (s.__authority || s.authority) ss.grpcSettings.authority = s.__authority || s.authority;
  } else if (network === 'xhttp') {
    ss.xhttpSettings = { path: s.path || '/', host: s.host || '', mode: s.mode || 'auto' };
    if (s.extra) { try { ss.xhttpSettings.extra = JSON.parse(s.extra); } catch { /* ignored */ } }
  } else if (network === 'kcp') {
    ss.kcpSettings = {};
    if (s.mtu) ss.kcpSettings.mtu = s.mtu;
    if (s.tti) ss.kcpSettings.tti = s.tti;
  }
  if (s.tls === 'tls') {
    ss.tlsSettings = {
      serverName: s.sni || s.host || s.address,
      fingerprint: s.fingerprint || 'chrome',
    };
    if (s.alpn && s.alpn.length) ss.tlsSettings.alpn = s.alpn;
    applyTlsExtras(ss.tlsSettings, s);
  } else if (s.tls === 'reality') {
    ss.realitySettings = {
      serverName: s.sni || '',
      fingerprint: s.fingerprint || 'chrome',
      password: s.publicKey,
      shortId: s.shortId || '',
      spiderX: s.spiderX || '',
    };
    if (s.pqv) ss.realitySettings.mldsa65Verify = s.pqv;
  }
  applyFinalMask(ss, s);
  if (settings && settings.fragment && s.tls === 'tls') {
    ss.sockopt = { dialerProxy: 'fragment' };
  }
  return ss;
}

function outboundSettings(s) {
  switch (s.protocol) {
    case 'vmess':
      return { vnext: [{ address: s.address, port: s.port, users: [{ id: s.uuid, security: s.cipher || 'auto' }] }] };
    case 'vless':
      return { vnext: [{ address: s.address, port: s.port, users: [{ id: s.uuid, encryption: s.encryption || 'none', flow: s.flow || '' }] }] };
    case 'trojan':
      return { servers: [{ address: s.address, port: s.port, password: s.password }] };
    case 'shadowsocks':
      return { servers: [{ address: s.address, port: s.port, method: s.cipher, password: s.password }] };
    case 'socks':
    case 'http': {
      const server = { address: s.address, port: s.port };
      if (s.username) server.users = [{ user: s.username, pass: s.password || '' }];
      return { servers: [server] };
    }
    case 'wireguard': {
      const peer = {
        endpoint: `${s.address.includes(':') ? `[${s.address}]` : s.address}:${s.port}`,
        publicKey: s.peerPublicKey,
        allowedIPs: ['0.0.0.0/0', '::/0'],
      };
      if (s.presharedKey) peer.preSharedKey = s.presharedKey;
      const out = { secretKey: s.privateKey, address: s.localAddress || ['10.0.0.2/32'], peers: [peer], mtu: s.mtu || 1280 };
      if (s.reserved) out.reserved = s.reserved;
      return out;
    }
    default:
      throw new Error(`Xray does not support ${s.protocol}`);
  }
}

function proxyOutbound(s, settings, tag = 'proxy') {
  checkSs2022Key(s);
  if (s.protocol === 'hysteria2') return hysteriaOutbound(s, tag);
  const ob = { tag, protocol: s.protocol, settings: outboundSettings(s) };
  const ss = streamSettings(s, settings);
  if (ss) ob.streamSettings = ss;
  if (settings && settings.mux && !s.flow && ['vmess', 'vless', 'trojan', 'shadowsocks'].includes(s.protocol)) {
    ob.mux = { enabled: true, concurrency: settings.muxConcurrency || 8 };
  }
  return ob;
}

function fragmentOutbound(settings) {
  return {
    tag: 'fragment',
    protocol: 'freedom',
    settings: {
      fragment: {
        packets: settings.fragmentPackets || 'tlshello',
        length: settings.fragmentLength || '100-200',
        interval: settings.fragmentInterval || '10-20',
      },
    },
  };
}

function userRules(routing) {
  const rules = [];
  for (const r of routing.rules || []) {
    if (!r.enabled) continue;
    // All matchers of one rule must match together (AND), as in Xray / v2rayN.
    const rule = { type: 'field', outboundTag: r.outbound };
    if (r.domain && r.domain.length) rule.domain = r.domain;
    if (r.ip && r.ip.length) rule.ip = r.ip;
    if (r.port && r.port.length) rule.port = r.port.join(',');
    if (r.process && r.process.length) rule.process = r.process;
    if (r.network) rule.network = r.network;
    if (r.protocol && r.protocol.length) rule.protocol = r.protocol;
    if (Object.keys(rule).length > 2) rules.push(rule);
  }
  return rules;
}

function routingRules(routing) {
  const rules = [];
  // DNS queries to the remote resolver always go through the proxy.
  rules.push(...userRules(routing));
  if (routing.blockAds) {
    rules.push({ type: 'field', domain: ['geosite:category-ads-all'], outboundTag: 'block' });
    const sec = securityBlockRules(routing.geoExt);
    if (sec) {
      rules.push({ type: 'field', domain: sec.domains, outboundTag: 'block' });
      rules.push({ type: 'field', ip: sec.ips, outboundTag: 'block' });
    }
  }
  rules.push({ type: 'field', ip: ['geoip:private'], outboundTag: 'direct' });
  rules.push({ type: 'field', domain: ['full:localhost'], outboundTag: 'direct' });
  const local = routing.mode === 'bypass-local' ? xrayCountryRules(routing.country, routing.geoExt) : null;
  if (local) {
    rules.push({ type: 'field', domain: local.domains, outboundTag: 'direct' });
    rules.push({ type: 'field', ip: local.ips, outboundTag: 'direct' });
  } else if (routing.mode === 'direct') {
    rules.push({ type: 'field', network: 'tcp,udp', outboundTag: 'direct' });
  }
  return rules;
}

/**
 * DNS address from Settings → Xray's own notation. Xray reads "udp://8.8.8.8" as a domain name
 * (nothing resolves), and has no DoT / DoQ / h2c for queries sent through the proxy: those use
 * DNS over TCP to the same host instead (inside the tunnel it is protected anyway).
 */
function xrayDnsServer(addr) {
  const s = String(addr || '');
  const m = /^(udp|tls|quic|h2c|tcp):\/\/(\[[0-9a-f:]+\]|[^/:]+)(?::(\d{1,5}))?/i.exec(s);
  if (!m) return s;
  const host = m[2].replace(/^\[|\]$/g, '');
  const kind = m[1].toLowerCase();
  if (kind === 'udp') return m[3] ? { address: host, port: Number(m[3]) } : host;
  if (kind === 'tcp') return s;
  return `tcp://${m[2]}:53`;
}

function dnsConfig(settings, routing) {
  // "Everything direct": the sites see this connection anyway, so the normal (local) DNS is used —
  // a remote DoH server reached directly may be blocked where the user is.
  const servers = [xrayDnsServer(routing.mode === 'direct' ? (settings.directDns || 'localhost') : (settings.remoteDns || 'https://1.1.1.1/dns-query'))];
  const local = routing.mode === 'bypass-local' ? xrayCountryRules(routing.country, routing.geoExt) : null;
  if (local) {
    const d = xrayDnsServer(settings.directDns || 'localhost');
    servers.push({ ...(typeof d === 'object' ? d : { address: d }), domains: local.domains, skipFallback: true });
  }
  const dns = { servers, queryStrategy: settings.dnsIpv4Only ? 'UseIPv4' : 'UseIP', tag: 'dns-internal' };
  const hosts = settings.hostsMap || {};
  if (Object.keys(hosts).length) dns.hosts = Object.fromEntries(Object.entries(hosts).map(([d, ips]) => [`full:${d}`, ips.length === 1 ? ips[0] : ips]));
  return dns;
}

/**
 * Custom hosts for tunneled traffic: a copy of the proxy outbound resolves these names itself
 * (with the hosts above) before sending, so the server connects to the chosen address.
 */
function applyHostsRoute(config, settings) {
  const hosts = Object.keys(settings.hostsMap || {});
  const proxy = config.outbounds.find((o) => o.tag === 'proxy');
  if (!hosts.length || !proxy) return;
  config.outbounds.push({ ...JSON.parse(JSON.stringify(proxy)), tag: 'proxy-hosts', targetStrategy: settings.dnsIpv4Only ? 'UseIPv4' : 'UseIP' });
  config.routing.rules.push({ type: 'field', domain: hosts.map((d) => `full:${d}`), outboundTag: 'proxy-hosts' });
}

/**
 * Local inbounds (127.0.0.1, no password) and, with LAN sharing on, separate LAN inbounds
 * (0.0.0.0, with the LAN user name / password when set) on their own ports.
 */
function inbounds(settings) {
  const sniffing = settings.sniffing
    ? { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: true }
    : { enabled: false };
  const pair = (listen, socksPort, httpPort, tagSuffix, auth) => [
    { tag: `socks-${tagSuffix}`, protocol: 'socks', listen, port: socksPort, settings: { auth: auth ? 'password' : 'noauth', udp: true, ...(auth ? { accounts: [auth] } : {}) }, sniffing },
    { tag: `http-${tagSuffix}`, protocol: 'http', listen, port: httpPort, settings: auth ? { accounts: [auth] } : {}, sniffing },
  ];
  const out = pair('127.0.0.1', settings.socksPort, settings.httpPort, 'in', null);
  if (settings.allowLan) {
    const auth = settings.lanUser ? { user: settings.lanUser, pass: settings.lanPass || '' } : null;
    out.push(...pair('0.0.0.0', settings.lanSocksPort, settings.lanHttpPort, 'lan', auth));
  }
  return out;
}

/**
 * Main config: local socks/http inbounds → selected server.
 * `loopbackPort` is a free local port, required when needsLoopback(server).
 */
/** freedom "finalRules" entry: never dial this computer itself (used while LAN sharing is on). */
const LOOPBACK_FINAL_RULE = Object.freeze({ action: 'block', ip: ['127.0.0.0/8', '::1/128', '0.0.0.0/32', '::/128'] });

function buildXrayConfig(server, settings, routing, { loopbackPort = 0, statsPort = 0 } = {}) {
  const loop = needsLoopback(server);
  if (loop && !loopbackPort) throw new Error('loopback port required');
  const outbounds = [
    proxyOutbound(loop ? viaLoopback(server, loopbackPort) : server, settings),
    { tag: 'direct', protocol: 'freedom', streamSettings: { sockopt: { domainStrategy: 'UseIP' } } },
    { tag: 'block', protocol: 'blackhole' },
  ];
  // The routing rule below only sees addresses written as IPs: a name that points at this computer
  // (localtest.me, a LAN DNS trick…) would slip through on a direct route. freedom checks the
  // address it finally dials, after the name was resolved.
  if (settings.allowLan) outbounds[1].settings = { finalRules: [LOOPBACK_FINAL_RULE] };
  if (settings.fragment) outbounds.push(fragmentOutbound(settings));
  const ins = inbounds(settings);
  const rules = routingRules(routing);
  // With LAN sharing on, other devices must not reach services that only listen on this computer.
  if (settings.allowLan) rules.unshift({ type: 'field', inboundTag: ['socks-lan', 'http-lan'], ip: ['127.0.0.0/8', '::1/128'], outboundTag: 'block' }, { type: 'field', inboundTag: ['socks-lan', 'http-lan'], domain: ['full:localhost'], outboundTag: 'block' });
  // Internal DNS traffic follows the same policy as everything else (through the proxy by default).
  rules.unshift({ type: 'field', inboundTag: ['dns-internal'], outboundTag: routing.mode === 'direct' ? 'direct' : 'proxy' });
  if (loop) {
    ins.push(loopbackInbound(server, loopbackPort, 'loop-in'));
    // Plain freedom (system resolver) so resolving the server name never depends on the tunnel itself.
    outbounds.push({ tag: 'loop-out', protocol: 'freedom' });
    rules.unshift({ type: 'field', inboundTag: ['loop-in'], outboundTag: 'loop-out' });
  }
  const config = {
    log: { loglevel: settings.logLevel || 'warning', dnsLog: false },
    dns: dnsConfig(settings, routing),
    inbounds: ins,
    outbounds,
    routing: { domainStrategy: routing.domainStrategy || 'AsIs', rules },
    policy: { system: { statsOutboundUplink: false, statsOutboundDownlink: false } },
  };
  applyHostsRoute(config, settings);
  return statsPort ? withXrayStats(config, statsPort) : config;
}

/** Live traffic counters, readable only on 127.0.0.1:port (/debug/vars). */
function withXrayStats(config, port) {
  config.stats = {};
  config.metrics = { tag: 'metrics', listen: `127.0.0.1:${port}` };
  config.policy = { ...(config.policy || {}), system: { ...((config.policy && config.policy.system) || {}), statsOutboundUplink: true, statsOutboundDownlink: true } };
  return config;
}

/**
 * Test config: one local HTTP inbound per server (127.0.0.1:basePort+i) routed to its own outbound.
 * Servers that need the local forwarder get one on basePort+count+i, so reserve 2×count ports.
 * Used for "real delay" and speed tests without touching the running connection.
 */
function buildXrayTestConfig(servers, settings, basePort, { socks = false } = {}) {
  const inb = [];
  const outb = [];
  const rules = [];
  const n = servers.length;
  let anyLoop = false;
  servers.forEach((s, i) => {
    inb.push(socks
      ? { tag: `in-${i}`, protocol: 'socks', listen: '127.0.0.1', port: basePort + i, settings: { auth: 'noauth', udp: true, ip: '127.0.0.1' } }
      : { tag: `in-${i}`, protocol: 'http', listen: '127.0.0.1', port: basePort + i, settings: {} });
    if (needsLoopback(s)) {
      anyLoop = true;
      const lp = basePort + n + i;
      inb.push(loopbackInbound(s, lp, `loop-in-${i}`));
      rules.push({ type: 'field', inboundTag: [`loop-in-${i}`], outboundTag: 'loop-out' });
      outb.push(proxyOutbound(viaLoopback(s, lp), settings, `out-${i}`));
    } else {
      outb.push(proxyOutbound(s, settings, `out-${i}`));
    }
    rules.push({ type: 'field', inboundTag: [`in-${i}`], outboundTag: `out-${i}` });
  });
  outb.push({ tag: 'direct', protocol: 'freedom' });
  if (anyLoop) outb.push({ tag: 'loop-out', protocol: 'freedom' });
  if (settings.fragment) outb.push(fragmentOutbound(settings));
  return {
    log: { loglevel: 'error' },
    inbounds: inb,
    outbounds: outb,
    routing: { domainStrategy: 'AsIs', rules },
  };
}

module.exports = { viaLoopback, loopbackInbound, withXrayStats, buildXrayConfig, buildXrayTestConfig, needsSingBox, hysteriaNeedsXray, needsLoopback, isUnencrypted, proxyOutbound, XRAY_PROTOCOLS, LOOPBACK_FINAL_RULE };
