'use strict';
const { checkSs2022Key } = require('./util');
// Build sing-box (1.12+ schema) configs.
//  - buildSingBoxConfig: sing-box as the proxy core (used for Hysteria2 / TUIC).
//  - buildTunConfig:     sing-box TUN front-end that captures all system traffic and hands it
//                        to the local core's SOCKS inbound (same approach as v2rayN).
//  - buildSingBoxTestConfig: per-server HTTP inbounds for latency / speed tests.

const RULESET_BASE = 'https://raw.githubusercontent.com/SagerNet';
const { singBoxCountryRuleSets } = require('./country');

function tlsBlock(s) {
  if (!s.tls) return undefined;
  const tls = { enabled: true, server_name: s.sni || s.host || s.address };
  if (s.allowInsecure) tls.insecure = true;
  if (s.alpn && s.alpn.length) tls.alpn = s.alpn;
  if (s.fingerprint && !['hysteria2', 'tuic'].includes(s.protocol)) {
    tls.utls = { enabled: true, fingerprint: s.fingerprint === 'random' || s.fingerprint === 'randomized' ? 'random' : s.fingerprint };
  }
  if (s.tls === 'reality') {
    tls.reality = { enabled: true, public_key: s.publicKey, short_id: s.shortId || '' };
    if (!tls.utls) tls.utls = { enabled: true, fingerprint: 'chrome' };
  }
  return tls;
}

function transportBlock(s) {
  const net = s.network || 'raw';
  if (net === 'raw') {
    if (s.headerType === 'http') return { type: 'http', host: s.host ? s.host.split(',').map((h) => h.trim()) : [], path: s.path || '/' };
    return undefined;
  }
  if (net === 'ws') {
    const t = { type: 'ws', path: s.path || '/' };
    if (s.host) t.headers = { Host: s.host };
    const m = /[?&]ed=(\d+)/.exec(s.path || '');
    if (m) { t.path = (s.path || '/').replace(/[?&]ed=\d+/, ''); t.max_early_data = Number(m[1]); t.early_data_header_name = 'Sec-WebSocket-Protocol'; }
    return t;
  }
  if (net === 'grpc') return { type: 'grpc', service_name: s.serviceName || '' };
  if (net === 'httpupgrade') return { type: 'httpupgrade', host: s.host || '', path: s.path || '/' };
  if (net === 'h2') return { type: 'http', host: s.host ? s.host.split(',').map((h) => h.trim()) : [], path: s.path || '/' };
  if (net === 'quic') return { type: 'quic' };
  throw new Error(`sing-box does not support the ${net} transport`);
}

/** sing-box multiplex (set by the app on the server copy as `sbMux`); never with Vision flow. */
function withMux(o, s) {
  if (s.sbMux && !s.flow) o.multiplex = { enabled: true, protocol: s.sbMux.protocol, max_connections: s.sbMux.max, padding: Boolean(s.sbMux.padding) };
  return o;
}

function singBoxOutbound(s, tag = 'proxy') {
  checkSs2022Key(s);
  // Things only Xray can do: the REALITY of Xray 26+ servers and VLESS Encryption.
  if (s.tls === 'reality' && s.pqKex) throw new Error('sing-box cannot connect to this REALITY server (Xray 26+)');
  if (s.protocol === 'vless' && s.encryption && s.encryption !== 'none') throw new Error('sing-box does not support VLESS Encryption');
  const base = { tag, server: s.address, server_port: s.port };
  const withTls = (o) => { const t = tlsBlock(s); if (t) o.tls = t; return o; };
  const withTransport = (o) => { const t = transportBlock(s); if (t) o.transport = t; return o; };
  switch (s.protocol) {
    case 'vmess':
      return withMux(withTransport(withTls({ type: 'vmess', ...base, uuid: s.uuid, security: !s.cipher || s.cipher === 'auto' ? 'aes-128-gcm' : s.cipher, alter_id: s.alterId || 0 })), s);
    case 'vless': {
      const o = { type: 'vless', ...base, uuid: s.uuid, packet_encoding: 'xudp' };
      if (s.flow) o.flow = 'xtls-rprx-vision';
      return withMux(withTransport(withTls(o)), s);
    }
    case 'trojan':
      return withMux(withTransport(withTls({ type: 'trojan', ...base, password: s.password })), s);
    case 'shadowsocks': {
      const o = { type: 'shadowsocks', ...base, method: s.cipher, password: s.password };
      if (s.plugin) { o.plugin = s.plugin; o.plugin_opts = s.pluginOpts || ''; }
      return o;
    }
    case 'hysteria': {
      const o = {
        type: 'hysteria', ...base, up_mbps: s.upMbps || 50, down_mbps: s.downMbps || 100,
        tls: tlsBlock({ ...s, tls: 'tls', alpn: s.alpn && s.alpn.length ? s.alpn : ['hysteria'] }),
      };
      if (s.password) o.auth_str = s.password;
      if (s.obfsPassword) o.obfs = s.obfsPassword;
      return o;
    }
    case 'anytls':
      return { type: 'anytls', ...base, password: s.password, tls: tlsBlock({ ...s, tls: 'tls' }) };
    case 'naive': {
      const o = { type: 'naive', ...base, tls: { enabled: true, server_name: s.sni || s.address } };
      if (s.username) { o.username = s.username; o.password = s.password || ''; }
      if (s.network === 'quic') o.quic = true;
      return o;
    }
    case 'socks': {
      const o = { type: 'socks', ...base, version: '5' };
      if (s.username) { o.username = s.username; o.password = s.password || ''; }
      return o;
    }
    case 'http': {
      const o = withTls({ type: 'http', ...base });
      if (s.username) { o.username = s.username; o.password = s.password || ''; }
      return o;
    }
    case 'hysteria2': {
      const o = { type: 'hysteria2', ...base, password: s.password || '', tls: tlsBlock({ ...s, tls: 'tls' }) };
      if (s.obfs) o.obfs = { type: 'salamander', password: s.obfsPassword || '' };
      // Port hopping (mport=20000-30000,443): sing-box wants "from:to" ranges.
      if (s.hopPorts) o.server_ports = s.hopPorts.split(',').map((r) => (r.includes('-') ? r.replace('-', ':') : `${r}:${r}`));
      if (s.upMbps) o.up_mbps = s.upMbps;
      if (s.downMbps) o.down_mbps = s.downMbps;
      return o;
    }
    case 'tuic': {
      const tls = tlsBlock({ ...s, tls: 'tls' });
      if (!tls.alpn) tls.alpn = ['h3'];
      return {
        type: 'tuic', ...base, uuid: s.uuid, password: s.password || '',
        congestion_control: s.congestion || 'bbr', udp_relay_mode: s.udpRelayMode || 'native', tls,
      };
    }
    default:
      throw new Error(`sing-box outbound for ${s.protocol} is not supported`);
  }
}

function wireguardEndpoint(s, tag = 'proxy') {
  const peer = { address: s.address, port: s.port, public_key: s.peerPublicKey, allowed_ips: ['0.0.0.0/0', '::/0'] };
  if (s.presharedKey) peer.pre_shared_key = s.presharedKey;
  if (s.reserved) peer.reserved = s.reserved;
  return { type: 'wireguard', tag, address: s.localAddress || ['10.0.0.2/32'], private_key: s.privateKey, peers: [peer], mtu: s.mtu || 1280 };
}

function ruleSets(routing) {
  const sets = [];
  const add = (tag, repo, file) => sets.push({
    type: 'remote', tag, format: 'binary',
    url: `${RULESET_BASE}/${repo}/rule-set/${file}`,
    download_detour: 'proxy', update_interval: '7d',
  });
  const local = routing.mode === 'bypass-local' ? singBoxCountryRuleSets(routing.country) : null;
  if (local) for (const s of local.sets) add(s.tag, s.repo, s.file);
  if (routing.blockAds) add('geosite-category-ads-all', 'sing-geosite', 'geosite-category-ads-all.srs');
  return sets;
}

function dohServer(addr) {
  try {
    const u = new URL(addr);
    const host = u.hostname.replace(/^[|]$/g, '');
    const port = u.port ? { server_port: Number(u.port) } : {};
    if (u.protocol === 'https:') return { type: 'https', server: host, ...port, path: u.pathname && u.pathname !== '/' ? u.pathname : '/dns-query' };
    if (u.protocol === 'h3:') return { type: 'h3', server: host, ...port, path: u.pathname && u.pathname !== '/' ? u.pathname : '/dns-query' };
    if (u.protocol === 'tls:') return { type: 'tls', server: host, ...port };
    if (u.protocol === 'quic:') return { type: 'quic', server: host, ...port };
    if (u.protocol === 'tcp:') return { type: 'tcp', server: host, ...port };
    if (u.protocol === 'h2c:') return { type: 'https', server: host, ...port, path: u.pathname && u.pathname !== '/' ? u.pathname : '/dns-query' };
    if (u.protocol === 'udp:') return { type: 'udp', server: host, ...port };
  } catch { /* plain IP */ }
  return { type: 'udp', server: addr };
}

function userRouteRules(routing) {
  const out = [];
  for (const r of routing.rules || []) {
    if (!r.enabled) continue;
    const rule = {};
    // geosite:/geoip: lists are Xray data files; sing-box rules use plain domains / CIDRs only.
    const domains = (r.domain || []).filter((v) => !/^(geosite|ext):/.test(v));
    const ips = (r.ip || []).filter((v) => !v.startsWith('geoip:'));
    if ((r.domain || []).length && !domains.length) continue;
    if ((r.ip || []).length && !ips.length) continue;
    if (domains.length) {
      const suffix = []; const full = []; const keyword = []; const regex = [];
      for (const v of domains) {
        if (v.startsWith('full:')) full.push(v.slice(5));
        else if (v.startsWith('keyword:')) keyword.push(v.slice(8));
        else if (v.startsWith('regexp:')) regex.push(v.slice(7));
        else if (v.startsWith('domain:')) suffix.push(v.slice(7));
        else suffix.push(v);
      }
      if (suffix.length) rule.domain_suffix = suffix;
      if (full.length) rule.domain = full;
      if (keyword.length) rule.domain_keyword = keyword;
      if (regex.length) rule.domain_regex = regex;
    }
    if (ips.length) rule.ip_cidr = ips;
    if ((r.port || []).length) {
      const ports = []; const ranges = [];
      for (const v of r.port) { if (v.includes('-')) ranges.push(v.replace('-', ':')); else ports.push(Number(v)); }
      if (ports.length) rule.port = ports;
      if (ranges.length) rule.port_range = ranges;
    }
    if ((r.process || []).length) rule.process_name = r.process;
    if (r.network) rule.network = r.network.split(',');
    if ((r.protocol || []).length) rule.protocol = r.protocol;
    if (!Object.keys(rule).length) continue;
    if (r.outbound === 'block') rule.action = 'reject';
    else rule.outbound = r.outbound;
    out.push(rule);
  }
  return out;
}

/** sing-box as the proxy core with local SOCKS + HTTP inbounds (mirrors the Xray inbounds). */
function buildSingBoxConfig(server, settings, routing, { clashApi = null } = {}) {
  const users = settings.lanUser ? [{ username: settings.lanUser, password: settings.lanPass || '' }] : undefined;
  const inbounds = [
    { type: 'socks', tag: 'socks-in', listen: '127.0.0.1', listen_port: settings.socksPort },
    { type: 'http', tag: 'http-in', listen: '127.0.0.1', listen_port: settings.httpPort },
    ...(settings.allowLan ? [
      { type: 'socks', tag: 'socks-lan', listen: '0.0.0.0', listen_port: settings.lanSocksPort, ...(users ? { users } : {}) },
      { type: 'http', tag: 'http-lan', listen: '0.0.0.0', listen_port: settings.lanHttpPort, ...(users ? { users } : {}) },
    ] : []),
  ];
  const isWg = server.protocol === 'wireguard';
  const local = routing.mode === 'bypass-local' ? singBoxCountryRuleSets(routing.country) : null;
  const config = {
    log: { level: settings.logLevel === 'warning' ? 'warn' : settings.logLevel === 'none' ? 'panic' : settings.logLevel, timestamp: true },
    dns: {
      servers: [
        { tag: 'remote', ...dohServer(settings.remoteDns), detour: 'proxy' },
        { tag: 'local', type: 'local' },
      ],
      rules: local ? [
        ...(local.sets.length > 1 ? [{ rule_set: [local.sets[1].tag], server: 'local' }] : []),
        { domain_suffix: [local.suffix], server: 'local' },
      ] : [],
      final: routing.mode === 'direct' ? 'local' : 'remote',
      strategy: settings.dnsIpv4Only ? 'ipv4_only' : routing.singboxStrategy || 'prefer_ipv4',
    },
    inbounds,
    outbounds: [
      ...(isWg ? [] : [singBoxOutbound(server)]),
      { type: 'direct', tag: 'direct' },
    ],
    route: {
      rules: [
        { action: 'sniff' },
        { protocol: 'dns', action: 'hijack-dns' },
        // With LAN sharing on, other devices must not reach services that only listen on this computer.
        // Names are resolved first for LAN traffic, so a name pointing at 127.0.0.1 is caught too.
        ...(settings.allowLan ? [{ inbound: ['socks-lan', 'http-lan'], action: 'resolve' }, { inbound: ['socks-lan', 'http-lan'], ip_cidr: ['127.0.0.0/8', '::1/128', '0.0.0.0/32', '::/128'], action: 'reject' }, { inbound: ['socks-lan', 'http-lan'], domain: ['localhost'], action: 'reject' }] : []),
        ...userRouteRules(routing),
        ...(routing.blockAds ? [{ rule_set: ['geosite-category-ads-all'], action: 'reject' }] : []),
        { ip_is_private: true, outbound: 'direct' },
        ...(local
          ? [{ domain_suffix: [local.suffix], outbound: 'direct' }, { rule_set: local.sets.map((s) => s.tag), outbound: 'direct' }]
          : []),
      ],
      rule_set: ruleSets(routing),
      final: routing.mode === 'direct' ? 'direct' : 'proxy',
      auto_detect_interface: true,
      default_domain_resolver: 'local',
    },
    experimental: { cache_file: { enabled: true, path: 'cache.db' } },
  };
  if (isWg) config.endpoints = [wireguardEndpoint(server)];
  if (!config.route.rule_set.length) delete config.route.rule_set;
  if (addHosts(config, settings)) {
    // Tunneled connections to these names are resolved here (with the hosts) before they are sent.
    config.route.rules.splice(1, 0, { domain: Object.keys(settings.hostsMap), action: 'resolve' });
  }
  return clashApi ? withClashApi(config, clashApi) : config;
}

/**
 * TUN front-end. Everything is captured by the TUN device; the core processes themselves are
 * sent direct (otherwise they would loop), private ranges stay local, the rest goes to the local
 * core's SOCKS inbound where the real routing (bypass Iran, block ads, user rules) happens.
 * DNS is hijacked and resolved through the tunnel, so it cannot leak to the ISP.
 */
function buildTunConfig(settings) {
  const config = buildTunBase(settings);
  const hasHosts = addHosts(config, settings);
  // Server names are answered by the normal DNS (after the user's own hosts entries): the cores
  // look them up through Windows, and sending that question into the tunnel would deadlock.
  const names = (settings.tunServerDomains || []).filter((d) => typeof d === 'string' && /^[a-z0-9.-]{1,253}$/.test(d));
  if (names.length) {
    const rules = config.dns.rules || [];
    rules.splice(hasHosts ? 1 : 0, 0, { domain: names, server: 'local' });
    config.dns.rules = rules;
  }
  if (settings.tunFakeIp) {
    // FakeIP: apps get an address from 198.18.0.0/15 at once and the real name travels through the
    // tunnel (no real DNS answer needed locally). Those addresses must never be treated as LAN.
    config.dns.servers.push({ type: 'fakeip', tag: 'fakeip', inet4_range: '198.18.0.0/15', inet6_range: 'fc00::/18' });
    config.dns.rules = [...(config.dns.rules || []), { query_type: ['A', 'AAAA'], server: 'fakeip' }];
    const i = config.route.rules.findIndex((r) => r.ip_is_private);
    config.route.rules.splice(i < 0 ? config.route.rules.length : i, 0, { ip_cidr: ['198.18.0.0/15', 'fc00::/18'], outbound: 'proxy' });
  }
  return config;
}

/**
 * Best's own cores must go out directly (their traffic already is the tunnel). Matched by full
 * program path (any letter case), so another program merely named xray.exe does not get past TUN.
 * Without the list (tests, other callers) the file names are used.
 */
function coreProcessRule(paths) {
  // Full paths only: C:\… (Windows) or /… (macOS).
  const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && (/^[a-z]:\\/i.test(p) || /^\/[^\0\n]+$/.test(p)) && p.length < 400);
  if (!list.length) return { process_name: ['xray.exe', 'sing-box.exe', 'mihomo.exe'], outbound: 'direct' };
  const esc = (s) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  return { process_path_regex: [`(?i)^(${list.map(esc).join('|')})$`], outbound: 'direct' };
}

function buildTunBase(settings) {
  // The IPv6 address (and so the ::/0 route) is always set: with IPv6 off, IPv6 traffic is captured
  // and refused below instead of slipping past the tunnel on a dual-stack network.
  const address = ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'];
  return {
    log: { level: 'warn', timestamp: true },
    dns: {
      servers: [
        { tag: 'remote', ...dohServer(settings.remoteDns), detour: 'proxy' },
        { tag: 'local', type: 'local' },
      ],
      final: 'remote',
      strategy: settings.tunIpv6 && !settings.dnsIpv4Only ? 'prefer_ipv4' : 'ipv4_only',
    },
    inbounds: [{
      type: 'tun', tag: 'tun-in', interface_name: 'BestTun', address, mtu: settings.tunMtu || 9000,
      auto_route: true, strict_route: settings.tunStrictRoute !== false, stack: settings.tunStack || 'mixed',
      ...(settings.tunExclude ? { route_exclude_address: settings.tunExclude.split(/\s+/).filter(Boolean).map((x) => (x.includes('/') ? x : `${x}/${x.includes(':') ? 128 : 32}`)) } : {}),
    }],
    outbounds: [
      { type: 'socks', tag: 'proxy', server: '127.0.0.1', server_port: settings.socksPort, version: '5' },
      { type: 'direct', tag: 'direct' },
    ],
    route: {
      rules: [
        coreProcessRule(settings.tunCorePaths),
        { action: 'sniff' },
        { protocol: 'dns', action: 'hijack-dns' },
        ...(settings.tunIpv6 ? [] : [{ ip_version: 6, action: 'reject' }]),
        { ip_is_private: true, outbound: 'direct' },
      ],
      final: 'proxy',
      auto_detect_interface: true,
      default_domain_resolver: 'local',
    },
  };
}

/** Server names (domains) the outbounds and WireGuard peers of a sing-box config connect to. */
function serverNames(config) {
  const isName = (a) => typeof a === 'string' && a.includes('.') && /[a-z]/i.test(a) && /^[a-z0-9.-]{1,253}$/i.test(a);
  const out = new Set();
  for (const o of [...(config.outbounds || []), ...(config.endpoints || [])]) {
    if (isName(o.server)) out.add(o.server.toLowerCase());
    for (const p of o.peers || []) if (isName(p.address)) out.add(p.address.toLowerCase());
  }
  return [...out];
}

/**
 * Server addresses already looked up through Windows (a fraction of a second). sing-box's own
 * resolver asks every DNS server Windows lists, and many PCs list dead ones (fec0:0:0:ffff::1…),
 * so its first answer can take 5 s: the first page after connecting would wait that long. The name
 * stays in the config (TLS / SNI unchanged); a name not in `ips` is resolved as before. The user's
 * own hosts entries keep priority.
 */
function useServerIps(config, ips) {
  const own = new Set(Object.keys(((config.dns && config.dns.servers) || []).find((s) => s.tag === 'hosts')?.predefined || {}));
  const map = {};
  for (const [name, list] of Object.entries(ips || {})) {
    if (own.has(name) || !/^[a-z0-9.-]{1,253}$/.test(name) || !Array.isArray(list)) continue;
    const good = list.filter((ip) => typeof ip === 'string' && /^[0-9a-f.:]{2,45}$/i.test(ip)).slice(0, 8);
    if (good.length) map[name] = good;
  }
  const names = Object.keys(map);
  if (!names.length || !config.dns) return config;
  // Added last and only used through its rule: the first DNS server is sing-box's default for every
  // other name (WireGuard looks up the sites it opens itself).
  const servers = config.dns.servers || [];
  if (!config.dns.final && servers[0]) config.dns.final = servers[0].tag;
  config.dns.servers = [...servers, { type: 'hosts', tag: 'server-ips', predefined: map }];
  config.dns.rules = [{ domain: names, server: 'server-ips' }, ...(config.dns.rules || [])]; // names never overlap the user's hosts
  for (const o of config.outbounds || []) if (map[String(o.server || '').toLowerCase()]) o.domain_resolver = 'server-ips';
  // WireGuard peers ignore domain_resolver; they need no name either (no TLS), so take the address.
  for (const e of config.endpoints || []) for (const p of e.peers || []) { const ip = map[String(p.address || '').toLowerCase()]; if (ip) p.address = ip.find((x) => !x.includes(':')) || ip[0]; }
  return config;
}

/** Custom hosts as a sing-box "hosts" DNS server answering first. Returns true when added. */
function addHosts(config, settings) {
  const hosts = settings.hostsMap || {};
  const names = Object.keys(hosts);
  if (!names.length) return false;
  config.dns.servers.unshift({ type: 'hosts', tag: 'hosts', predefined: hosts });
  config.dns.rules = [{ domain: names, server: 'hosts' }, ...(config.dns.rules || [])];
  return true;
}

/** Live traffic / connections API, only on 127.0.0.1 and protected by a random secret. */
function withClashApi(config, { port, secret }) {
  config.experimental = { ...(config.experimental || {}), clash_api: { external_controller: `127.0.0.1:${port}`, secret } };
  return config;
}

function buildSingBoxTestConfig(servers, basePort, { socks = false } = {}) {
  const inbounds = [];
  const outbounds = [];
  const endpoints = [];
  const rules = [];
  servers.forEach((s, i) => {
    inbounds.push({ type: socks ? 'socks' : 'http', tag: `in-${i}`, listen: '127.0.0.1', listen_port: basePort + i });
    if (s.protocol === 'wireguard') endpoints.push(wireguardEndpoint(s, `out-${i}`));
    else outbounds.push(singBoxOutbound(s, `out-${i}`));
    rules.push({ inbound: [`in-${i}`], outbound: `out-${i}` });
  });
  outbounds.push({ type: 'direct', tag: 'direct' });
  const cfg = {
    log: { level: 'error' },
    dns: { servers: [{ tag: 'local', type: 'local' }] },
    inbounds, outbounds,
    route: { rules, final: 'direct', default_domain_resolver: 'local' },
  };
  if (endpoints.length) cfg.endpoints = endpoints;
  return cfg;
}

module.exports = { buildSingBoxConfig, buildTunConfig, buildSingBoxTestConfig, singBoxOutbound, wireguardEndpoint, withClashApi, serverNames, useServerIps };
