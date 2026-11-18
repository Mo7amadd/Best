'use strict';
// Android configs, built on the Windows app's xray-config.js so both apps connect the same way.
// Differences on Android:
//  - Traffic arrives from the VPN interface (Xray's own "tun" inbound reading the fd that
//    VpnService gives), never from local SOCKS / HTTP ports: on a phone every app can reach
//    127.0.0.1, so Best opens no such port at all.
//  - DNS queries from apps (port 53 into the tunnel) are answered by Xray's DNS, with the same
//    servers and routing as everything else, so nothing leaks to the network's resolver.
//  - IPv6: the tunnel always takes IPv6 too (otherwise it would bypass the VPN); when IPv6 is off
//    it is refused inside the tunnel at once, just like the Windows TUN.
//  - Traffic counters are read in-process by the app; no metrics / API listener is opened.

const x = require('../../../src/core/xray-config');
const sb = require('../../../src/core/singbox-config');
const G = require('../../../src/core/group');
const { parseHosts } = require('../../../src/core/dns');
const { effectiveRouting } = require('../../../src/core/routing');

const TUN_TAG = 'tun-in';

class AndroidConfigError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function tunInbound(settings) {
  // FakeDNS: apps get addresses from a private pool and Xray puts the real name back, so the
  // server resolves it (fast first connection, no DNS answer to wait for).
  const fake = Boolean(settings.fakeDns);
  return {
    tag: TUN_TAG,
    protocol: 'tun',
    settings: { name: 'xray0', mtu: Number(settings.vpnMtu) || 1500 },
    sniffing: settings.sniffing || fake
      ? { enabled: true, destOverride: fake ? ['http', 'tls', 'quic', 'fakedns'] : ['http', 'tls', 'quic'], routeOnly: !fake }
      : { enabled: false },
  };
}

/** Rules can match a process only on desktop; on Android those matchers are dropped. */
function mobileRouting(routing) {
  const rules = (routing.rules || [])
    .map((r) => ({ ...r, process: [] }))
    .filter((r) => (r.domain && r.domain.length) || (r.ip && r.ip.length) || (r.port && r.port.length) || r.network || (r.protocol && r.protocol.length));
  return { ...routing, rules };
}

const BRIDGE_TAG = 'proxy';
const randomPort = () => 20000 + Math.floor(Math.random() * 30000);

// ---------------------------------------------------------------- shared preparation

/**
 * Settings as the builders need them on Android: no LAN sharing, the user's hosts lines parsed.
 * Android 9 and older (`sdk` < 29) have an old list of root certificates that Xray can't extend
 * (its Go runtime copies the environment before the app can set SSL_CERT_FILE), so DNS over
 * HTTPS fails there with "certificate signed by unknown authority". There the same DNS server is
 * asked over TCP instead; the questions still travel inside the proxy, encrypted up to the server.
 */
function prepSettings(settings, sdk = 0, extra = {}) {
  let hostsMap = {};
  try { hostsMap = parseHosts(settings.dnsHosts || ''); } catch { hostsMap = {}; }
  let remoteDns = settings.remoteDns;
  const doh = /^https:\/\/(\[[0-9a-f:]+\]|[^/:?#]+)/i.exec(String(remoteDns || ''));
  if (sdk > 0 && sdk < 29 && doh) remoteDns = `tcp://${doh[1]}:53`;
  // IPv6 off: it is refused inside the tunnel (no leak), so DNS must not hand out IPv6 addresses
  // either. Otherwise apps such as Chrome connect to a site's IPv6 address, see the connection
  // closed at once ("empty response") and never try its IPv4 address.
  const dnsIpv4Only = Boolean(settings.dnsIpv4Only) || !settings.tunIpv6;
  // LAN sharing only with its user name / password (the page creates them when it is turned on).
  const allowLan = Boolean(settings.allowLan && settings.lanUser && settings.lanPass);
  return { ...settings, ...extra, remoteDns, dnsIpv4Only, allowLan, fragment: Boolean(settings.fragment), hostsMap };
}

/** Defaults from Settings for what a link leaves out (same as withDefaults on Windows). */
function withDefaults(s, settings) {
  if (!s || s.protocol === 'custom' || s.protocol === 'group') return s;
  const o = { ...s };
  if (settings.defaultFingerprint && !o.fingerprint && (o.tls === 'tls' || o.tls === 'reality')) o.fingerprint = settings.defaultFingerprint;
  if (o.protocol === 'hysteria2') {
    if (!o.upMbps && settings.hy2UpMbps) o.upMbps = settings.hy2UpMbps;
    if (!o.downMbps && settings.hy2DownMbps) o.downMbps = settings.hy2DownMbps;
  }
  if (settings.sbMux) o.sbMux = { protocol: settings.sbMuxProtocol, max: settings.sbMuxMax, padding: settings.sbMuxPadding };
  return o;
}

function routingFor(routing, country, ext = {}) {
  const eff = effectiveRouting(routing);
  if (!eff.country && /^[a-z]{2}$/.test(country)) eff.country = country;
  eff.geoExt = { ir: Boolean(ext.ir), ru: Boolean(ext.ru) };
  return mobileRouting(eff);
}

/** A built Xray config made into the VPN's: the VPN interface instead of local ports, DNS from apps answered by Xray. */
function androidize(config, settings) {
  if (settings.mode === 'proxy') return proxyize(config, settings);
  const keep = (i) => String(i.tag || '').startsWith('loop-in') || (settings.allowLan && /-lan$/.test(String(i.tag || '')));
  config.inbounds = [tunInbound(settings), ...(config.inbounds || []).filter(keep)];
  config.outbounds.push({ tag: 'dns-out', protocol: 'dns' });
  const first = [{ type: 'field', inboundTag: [TUN_TAG], port: '53', outboundTag: 'dns-out' }];
  if (!settings.tunIpv6) first.push({ type: 'field', inboundTag: [TUN_TAG], ip: ['::/0'], outboundTag: 'block' });
  config.routing.rules.unshift(...first);
  if (settings.fakeDns) withFakeDns(config);
  if (settings.preferIpv6 && settings.tunIpv6) preferV6(config);
  withStats(config);
  return config;
}

/**
 * "Proxy only": no VPN interface. Apps with their own proxy settings use SOCKS / HTTP on
 * 127.0.0.1 (and, with LAN sharing on, the password-protected LAN ports).
 */
function proxyize(config, settings) {
  const keep = (i) => /^(socks|http)-in$/.test(String(i.tag || '')) || String(i.tag || '').startsWith('loop-in') || (settings.allowLan && /-lan$/.test(String(i.tag || '')));
  config.inbounds = (config.inbounds || []).filter(keep);
  if (settings.preferIpv6 && settings.tunIpv6) preferV6(config);
  withStats(config);
  return config;
}

function withFakeDns(config) {
  config.fakedns = [{ ipPool: '198.18.0.0/15', poolSize: 65535 }];
  const dns = config.dns || (config.dns = { servers: [] });
  dns.servers = ['fakedns', ...(dns.servers || [])];
}

/** "Prefer IPv6": direct connections try a site's IPv6 address first. */
function preferV6(config) {
  for (const o of config.outbounds || []) {
    if (o.protocol === 'freedom' && o.tag === 'direct') {
      o.streamSettings = { ...(o.streamSettings || {}), sockopt: { ...((o.streamSettings || {}).sockopt || {}), domainStrategy: 'UseIPv6v4' } };
    }
  }
}

/** Group with a fallback config: used when every member fails the health check. */
function withFallback(config, fallback, settings) {
  const b = config.routing && Array.isArray(config.routing.balancers) && config.routing.balancers.find((x) => x.tag === 'proxy');
  if (!b || !fallback) return config;
  config.outbounds.push(x.proxyOutbound(fallback, settings, 'fb-0'));
  b.fallbackTag = 'fb-0';
  return config;
}

/**
 * The connection config for the VPN service. `routing` is the stored profile model (the same as
 * on Windows); its active profile is used. `country`: the phone's region, used for "my country
 * direct" when the user has not chosen one. `loopbackPort`: a free local port, needed only for
 * VLESS / Trojan without TLS (see xray-config).
 */
function buildAndroidConfig(server, settings, routing, { loopbackPort = 0, country = '', sdk = 0 } = {}) {
  if (server && server.protocol === 'custom') return customConfig(server, settings);
  if (!server || server.protocol === 'group') throw new AndroidConfigError('UNSUPPORTED_ON_ANDROID');
  if (x.needsSingBox(server)) throw new AndroidConfigError('NEEDS_SINGBOX');
  const s = prepSettings(settings, sdk);
  return androidize(x.buildXrayConfig(withDefaults(server, settings), s, routingFor(routing, country), { loopbackPort }), s);
}

function withStats(config) {
  config.stats = {};
  config.policy = {
    ...(config.policy || {}),
    system: { ...((config.policy && config.policy.system) || {}), statsOutboundUplink: true, statsOutboundDownlink: true },
  };
}

/**
 * The user's own Xray config (JSON). Its outbounds, routing and DNS are kept as written; its
 * inbounds are replaced by the VPN interface, and anything that would open a local listener on
 * the phone (api, metrics) is removed. Configs written for sing-box need the sing-box core.
 */
function parseCustom(server) {
  if (server.core && server.core !== 'xray') throw new AndroidConfigError('NEEDS_SINGBOX');
  let c;
  try { c = JSON.parse(server.config); } catch { throw new AndroidConfigError('CORE_CONFIG'); }
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new AndroidConfigError('CORE_CONFIG');
  const outbounds = (Array.isArray(c.outbounds) ? c.outbounds : []).filter((o) => o && typeof o === 'object' && !Array.isArray(o));
  if (!outbounds.length) throw new AndroidConfigError('CORE_CONFIG');
  delete c.api;
  delete c.metrics;
  delete c.reverse;
  c.outbounds = outbounds;
  return c;
}

function customConfig(server, settings) {
  const c = parseCustom(server);
  c.inbounds = [tunInbound(settings)];
  const tags = new Set(c.outbounds.map((o) => o.tag));
  if (!tags.has('dns-out')) c.outbounds.push({ tag: 'dns-out', protocol: 'dns' });
  const routing = c.routing && typeof c.routing === 'object' && !Array.isArray(c.routing) ? c.routing : {};
  routing.rules = Array.isArray(routing.rules) ? routing.rules : [];
  const first = [{ type: 'field', inboundTag: [TUN_TAG], port: '53', outboundTag: 'dns-out' }];
  if (!settings.tunIpv6) {
    if (!tags.has('best-block-v6')) c.outbounds.push({ tag: 'best-block-v6', protocol: 'blackhole' });
    first.push({ type: 'field', inboundTag: [TUN_TAG], ip: ['::/0'], outboundTag: 'best-block-v6' });
  }
  routing.rules.unshift(...first);
  c.routing = routing;
  withStats(c);
  return c;
}

// ---------------------------------------------------------------- groups and chains

/**
 * Groups (one of several configs: the fastest, or spread over all) and chains (a config reached
 * through another one, `via`, also set for a whole subscription). Same rules as planFor on
 * Windows; null for a plain config. `ctx` = { servers, subs }.
 */
function planFor(server, settings, ctx = {}) {
  if (!server || server.protocol === 'custom') return null;
  const servers = ctx.servers || [];
  const subs = ctx.subs || [];
  const byId = (id) => servers.find((s) => s.id === id);
  let members = null;
  if (server.protocol === 'group') {
    const ids = [...new Set([...(server.members || []), ...(server.memberSub ? servers.filter((s) => s.subId === server.memberSub).map((s) => s.id) : [])])];
    members = ids.map(byId).filter((s) => s && s.protocol !== 'group' && s.protocol !== 'custom').slice(0, 200).map((s) => withDefaults(s, settings));
    if (!members.length) throw new AndroidConfigError('GROUP_EMPTY');
  }
  const sub = server.subId ? subs.find((s) => s.id === server.subId) : null;
  const viaId = server.protocol === 'group' ? '' : server.via || (sub && sub.via) || '';
  const front = viaId && viaId !== server.id ? byId(viaId) : null;
  if (viaId && viaId !== server.id && !front) throw new AndroidConfigError('CHAIN_FRONT_MISSING');
  if (front && (front.protocol === 'group' || front.protocol === 'custom')) throw new AndroidConfigError('CHAIN_BAD_FRONT');
  if (!members && !front) return null;
  const canSingBox = (s) => { try { sb.singBoxOutbound(s); return true; } catch { return s.protocol === 'wireguard'; } };
  let core;
  try {
    core = G.pickCore([...(members || [server]), ...(front ? [front] : [])], { needsSingBox: x.needsSingBox, canSingBox });
  } catch (e) {
    throw new AndroidConfigError(/MIXED/.test(e.message) ? 'GROUP_MIXED_CORES' : 'GROUP_BAD_MEMBER');
  }
  const fb = members && server.fallback ? byId(server.fallback) : null;
  const fallback = fb && fb.protocol !== 'group' && fb.protocol !== 'custom' && !x.needsSingBox(fb) && !x.needsLoopback(fb) ? withDefaults(fb, settings) : null;
  return { core, members, main: members ? null : withDefaults(server, settings), front: front ? withDefaults(front, settings) : null, strategy: server.strategy || 'leastPing', fallback };
}

// ---------------------------------------------------------------- sing-box next to Xray
// Configs Xray can't open (TUIC, AnyTLS, Naive, old Hysteria, H2 / QUIC transports, SS plugins)
// are opened by sing-box, run beside Xray. Xray still owns the VPN interface, DNS and routing; its
// "proxy" outbound becomes SOCKS to sing-box on 127.0.0.1. The native side picks that port and a
// random user name / password and writes them into both configs (the page never sees them), so
// other apps on the phone can't use the local port.

const isName = (a) => /[a-z]/i.test(a) && /^[a-z0-9.-]{1,253}$/i.test(a);

/** Server names sing-box will connect to; looked up by Android first (see useServerIps). */
function serverNamesOf(server, settings = {}, ctx = {}) {
  let list = [server];
  try {
    const plan = planFor(server, settings, ctx);
    if (plan) list = [...(plan.members || [plan.main]), ...(plan.front ? [plan.front] : [])];
  } catch { /* reported when connecting */ }
  return [...new Set(list.filter(Boolean).map((s) => String(s.address || '').toLowerCase()).filter(isName))].slice(0, 8);
}

/** sing-box config for one server, a group and / or a chain (no inbound: the native side adds it). */
function singBoxConfig(plan, settings, ips = {}) {
  const cfg = {
    log: { level: 'error', timestamp: false },
    dns: { servers: [{ tag: 'local', type: 'local' }] },
    outbounds: [],
    route: { final: BRIDGE_TAG, default_domain_resolver: 'local' },
  };
  const group = Array.isArray(plan.members) && plan.members.length > 0;
  const first = group ? plan.members[0] : plan.main;
  try {
    if (first.protocol === 'wireguard') cfg.endpoints = [sb.wireguardEndpoint(first, BRIDGE_TAG)];
    else cfg.outbounds.push(sb.singBoxOutbound(first, BRIDGE_TAG));
    cfg.outbounds.push({ type: 'direct', tag: 'direct' });
    if (group) G.singBoxGroup(cfg, plan.members, settings, sb);
    if (plan.front) G.singBoxChain(cfg, plan.front, sb, group ? plan.members.map((_, i) => `m-${i}`) : [BRIDGE_TAG]);
  } catch (e) {
    if (e instanceof AndroidConfigError) throw e;
    throw new AndroidConfigError('UNSUPPORTED_ON_ANDROID');
  }
  return sb.useServerIps(cfg, ips);
}

/** Xray side when sing-box opens the server: the "proxy" outbound is SOCKS to it (placeholder login). */
function bridgeXray(server, settings, routing, country, sdk = 0, extra = {}, ext = {}) {
  const bridge = { id: server.id, protocol: 'socks', remark: server.remark, address: '127.0.0.1', port: 1, username: 'best', password: 'best' };
  const s = prepSettings(settings, sdk, extra);
  return androidize(x.buildXrayConfig(bridge, s, routingFor(routing, country, ext), {}), s);
}

/**
 * Everything the VPN runs for `server`: { xray, singbox }. singbox is null when Xray opens the
 * server(s) itself. `ips`: addresses Android looked up for serverNamesOf(server). `ctx`:
 * { servers, subs } for groups and chains.
 */
function buildAndroidSession(server, settings, routing, { loopbackPort = 0, country = '', ips = {}, ctx = {}, sdk = 0, mode = 'vpn', mtu = 1500, fakeDns = false, preferIpv6 = false, ext = {} } = {}) {
  if (!server) throw new AndroidConfigError('UNSUPPORTED_ON_ANDROID');
  const extra = { mode: mode === 'proxy' ? 'proxy' : 'vpn', vpnMtu: mtu, fakeDns: Boolean(fakeDns) && mode !== 'proxy', preferIpv6: Boolean(preferIpv6) };
  if (server.protocol === 'custom') {
    if (extra.mode === 'proxy') throw new AndroidConfigError('UNSUPPORTED_ON_ANDROID');
    return { xray: customConfig(server, { ...settings, ...extra }), singbox: null };
  }
  const plan = planFor(server, settings, ctx) || { core: x.needsSingBox(server) ? 'sing-box' : 'xray', members: null, main: withDefaults(server, settings), front: null };
  if (plan.core === 'sing-box') {
    return { xray: bridgeXray(server, settings, routing, country, sdk, extra, ext), singbox: singBoxConfig(plan, settings, ips) };
  }
  const s = prepSettings(settings, sdk, extra);
  const r = routingFor(routing, country, ext);
  const main = plan.main;
  const mainLoop = main && x.needsLoopback(main) ? loopbackPort || randomPort() : 0;
  if (!plan.members && !plan.front) {
    return { xray: androidize(x.buildXrayConfig(main, s, r, { loopbackPort: mainLoop }), s), singbox: null };
  }
  const loopPorts = (plan.members || []).map((m) => (x.needsLoopback(m) ? randomPort() : 0));
  const frontLoopPort = plan.front && x.needsLoopback(plan.front) ? randomPort() : 0;
  const config = G.buildComposite(plan, s, r, { loopPorts, loopbackPort: mainLoop, frontLoopPort });
  if (plan.fallback) withFallback(config, plan.fallback, s);
  return { xray: androidize(config, s), singbox: null };
}

/**
 * Delay test config: just the server's outbound (the library starts it without any inbound,
 * dials through it in-process and closes it). Servers that need the local forwarder can't be
 * measured this way and report UNSUPPORTED.
 */
function buildDelayConfig(server, settings) {
  if (server && server.protocol === 'custom') {
    const c = parseCustom(server);
    c.inbounds = [];
    return { ...c, log: { loglevel: 'none' } };
  }
  if (!server || server.protocol === 'group') throw new AndroidConfigError('UNSUPPORTED_ON_ANDROID');
  if (x.needsSingBox(server)) throw new AndroidConfigError('NEEDS_SINGBOX');
  // VLESS / Trojan without TLS dial the local forwarder inside the same core (as when connected);
  // the native side then runs a full core for the test, since the quick in-process check drops inbounds.
  const lp = x.needsLoopback(server) ? randomPort() : 0;
  const outbounds = [x.proxyOutbound(lp ? x.viaLoopback(server, lp) : server, settings, 'proxy'), { tag: 'direct', protocol: 'freedom' }];
  if (lp) {
    outbounds.push({ tag: 'loop-out', protocol: 'freedom' });
    return {
      log: { loglevel: 'none' },
      inbounds: [x.loopbackInbound(server, lp, 'loop-in')],
      outbounds,
      routing: { domainStrategy: 'AsIs', rules: [{ type: 'field', inboundTag: ['loop-in'], outboundTag: 'loop-out' }] },
    };
  }
  if (settings.fragment && server.tls === 'tls') {
    outbounds.push({ tag: 'fragment', protocol: 'freedom', settings: { fragment: { packets: settings.fragmentPackets || 'tlshello', length: settings.fragmentLength || '100-200', interval: settings.fragmentInterval || '10-20' } } });
  }
  return { log: { loglevel: 'none' }, outbounds };
}

/**
 * Test config: { core: 'xray' | 'singbox', config }. Groups are not measured as a whole (their
 * members are); a chain is measured through its front server.
 */
function buildTestConfig(server, settings, ips = {}, ctx = {}) {
  if (!server || server.protocol === 'group') throw new AndroidConfigError('SKIP');
  if (server.protocol === 'custom') return { core: 'xray', config: buildDelayConfig(server, settings) };
  const plan = planFor(server, settings, ctx) || { core: x.needsSingBox(server) ? 'sing-box' : 'xray', members: null, main: withDefaults(server, settings), front: null };
  if (plan.core === 'sing-box') return { core: 'singbox', config: singBoxConfig(plan, settings, ips) };
  const s = prepSettings(settings);
  const config = buildDelayConfig(plan.main, s);
  if (plan.front) {
    if (x.needsLoopback(plan.front)) throw new AndroidConfigError('SKIP');
    const keep = { inbounds: config.inbounds, routing: config.routing };
    config.inbounds = [];
    config.routing = { rules: [] };
    G.xrayChain(config, plan.front, s, x, ['proxy'], 0);
    delete config.inbounds;
    delete config.routing;
    if (keep.inbounds) Object.assign(config, keep);
  }
  return { core: 'xray', config };
}

/** Whether connecting to `server` starts sing-box. */
function needsSingBox(server, settings = {}, ctx = {}) {
  if (!server || server.protocol === 'custom') return false;
  try {
    const plan = planFor(server, settings, ctx);
    if (plan) return plan.core === 'sing-box';
  } catch { return false; }
  return server.protocol !== 'group' && x.needsSingBox(server);
}

module.exports = { buildAndroidConfig, buildDelayConfig, buildAndroidSession, buildTestConfig, serverNamesOf, needsSingBox, planFor, AndroidConfigError, TUN_TAG };
