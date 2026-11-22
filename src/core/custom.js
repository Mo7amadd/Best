'use strict';
// Helpers for full JSON configs (custom servers and JSON subscriptions).
//
// A JSON config that comes from outside (a subscription, the clipboard, a QR code, a file) is not
// trusted: only the parts that describe how to reach the server are kept. Anything that could open
// a listener, write files, give the remote side a way back into this computer or the LAN
// (Xray "reverse", api, metrics, sing-box clash_api / external_ui, services, tailscale…) is dropped.

const { unsafeXrayJson } = require('./util');

const XRAY_KEEP = ['dns', 'routing', 'outbounds', 'policy', 'observatory', 'burstObservatory', 'fakedns'];
const SB_KEEP = ['dns', 'route', 'outbounds', 'endpoints'];
const XRAY_LEVELS = ['debug', 'info', 'warning', 'error', 'none'];
const SB_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'panic'];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const asList = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

// Only outbound kinds that just carry traffic to a server. Everything else is dropped — e.g.
// sing-box "tor" (starts a program from executable_path), "ssh" (reads key files), Xray "loopback".
const XRAY_OUT = ['freedom', 'blackhole', 'dns', 'vless', 'vmess', 'trojan', 'shadowsocks', 'socks', 'http', 'wireguard', 'hysteria', 'masque'];
const SB_OUT = ['direct', 'block', 'dns', 'selector', 'urltest', 'socks', 'http', 'shadowsocks', 'vmess', 'trojan', 'naive', 'wireguard', 'hysteria', 'shadowtls', 'vless', 'tuic', 'hysteria2', 'anytls'];
const SB_ENDPOINTS = ['wireguard'];

/**
 * An Xray outbound from an untrusted config: a carrying protocol, and nothing at any depth that
 * util.unsafeXrayJson refuses (XDRIVE "local" / "template", a non-XHTTP "downloadSettings").
 * A stream settings value that is not an object is refused too (Xray would not read it).
 */
function xrayOutboundAllowed(o) {
  if (!isObj(o) || !XRAY_OUT.includes(o.protocol)) return false;
  if (Object.keys(o).some((k) => k.toLowerCase() === 'streamsettings' && o[k] !== null && !isObj(o[k]))) return false;
  return !unsafeXrayJson(o);
}

/**
 * Remove, at any depth, keys that make a core read or write local files or run programs
 * (sing-box *_path / *_directory / executable*, openconnect wrappers, Xray masterKeyLog and TLS
 * certificateFile / keyFile, which would read any file as a client certificate) or that
 * send connection details elsewhere (Xray rule webhooks) or open a way back in (Xray "reverse").
 * Asset references that climb out of the asset folder ("ext:../x.dat:tag") are dropped too.
 */
function stripDangerous(v, depth = 0) {
  if (depth > 40) return undefined;
  if (Array.isArray(v)) return v.map((x) => stripDangerous(x, depth + 1)).filter((x) => x !== undefined);
  if (typeof v === 'string') return /^ext(-domain|-ip)?:.*(\.\.|[\\/])/i.test(v) ? undefined : v;
  if (!isObj(v)) return v;
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (/(_path|_directory|_dir)$/i.test(k) || /^executable/i.test(k) || /^(masterKeyLog|certificateFile|keyFile|webhook|reverse|wrapper_path|csd|hip|tncc|extra_args|torrc)$/i.test(k)) continue;
    const c = stripDangerous(val, depth + 1);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

/**
 * Xray and sing-box read JSON with Go, which matches a key whatever its letter case and lets a
 * later duplicate win: {"protocol": "vless", "Protocol": "loopback"} runs a loopback outbound.
 * Keep only that last spelling of every key (at any depth), so the checks below see what the
 * core will see; a section kept under another spelling is then simply not found and dropped.
 */
function lastSpelling(v, depth = 0) {
  if (depth > 60) return undefined;
  if (Array.isArray(v)) return v.map((x) => lastSpelling(x, depth + 1)).filter((x) => x !== undefined);
  if (!isObj(v)) return v;
  const keys = Object.keys(v).filter((k) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype');
  const last = new Map(keys.map((k) => [k.toLowerCase(), k]));
  const out = {};
  for (const k of keys) {
    if (last.get(k.toLowerCase()) !== k) continue;
    const c = lastSpelling(v[k], depth + 1);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

/** Keep only the trusted top-level sections of an untrusted config. `ownTags` = Best's inbound tags. */
function sanitizeConfig(config, core, ownTags = []) {
  const src = isObj(config) ? lastSpelling(config) : {};
  const out = {};
  if (core === 'xray') {
    for (const k of XRAY_KEEP) if (src[k] !== undefined) out[k] = JSON.parse(JSON.stringify(src[k]));
    const level = isObj(src.log) && XRAY_LEVELS.includes(src.log.loglevel) ? src.log.loglevel : 'warning';
    out.log = { loglevel: level };
    if (isObj(out.policy)) delete out.policy.system; // traffic statistics only make sense with the api
    if (isObj(out.routing) && Array.isArray(out.routing.rules)) {
      // Rules bound to inbounds Best does not create (api, reverse bridges…) are dropped.
      out.routing.rules = out.routing.rules.filter((r) => isObj(r) && asList(r.inboundTag).every((t) => ownTags.includes(t)));
    }
    if (Array.isArray(out.outbounds)) out.outbounds = out.outbounds.filter(xrayOutboundAllowed);
  } else {
    for (const k of SB_KEEP) if (src[k] !== undefined) out[k] = JSON.parse(JSON.stringify(src[k]));
    const level = isObj(src.log) && SB_LEVELS.includes(src.log.level) ? src.log.level : 'warn';
    out.log = { level, timestamp: false };
    if (Array.isArray(out.endpoints)) {
      // WireGuard endpoints are fine as outbounds, but must not listen; tailscale joins a tailnet.
      out.endpoints = out.endpoints.filter((e) => isObj(e) && SB_ENDPOINTS.includes(e.type)).map((e) => { const c = { ...e }; delete c.listen_port; return c; });
    }
    if (isObj(out.dns) && Array.isArray(out.dns.servers)) {
      // A "hosts" server may list files to read; tailscale / resolved need things Best never starts.
      out.dns.servers = out.dns.servers.filter((x) => isObj(x) && !['tailscale', 'resolved'].includes(x.type)).map((x) => { const c = { ...x }; if (c.type === 'hosts') delete c.path; return c; });
    }
    if (isObj(out.route)) {
      if (Array.isArray(out.route.rules)) {
        out.route.rules = out.route.rules.filter((r) => isObj(r) && asList(r.inbound).every((t) => ownTags.includes(t)));
      }
      if (Array.isArray(out.route.rule_set)) {
        // Remote and inline rule sets only: a "local" one would read any file on disk.
        out.route.rule_set = out.route.rule_set.filter((r) => isObj(r) && (r.type === 'remote' || r.type === 'inline'));
      }
    }
    if (Array.isArray(out.outbounds)) out.outbounds = out.outbounds.filter((o) => isObj(o) && SB_OUT.includes(o.type));
  }
  return stripDangerous(out);
}

/**
 * Replace the local inbounds of an untrusted config with Best's own SOCKS / HTTP ports and drop
 * everything that is not needed to reach the server (see sanitizeConfig). Any other inbound —
 * including a TUN device — is dropped: TUN is only ever started by Best itself.
 */
function withOwnInbounds(config, core, settings, { stats = null } = {}) {
  const ins = isObj(config) && Array.isArray(config.inbounds) ? config.inbounds.filter(isObj) : [];
  const listen = '127.0.0.1';
  const auth = null; // local ports never ask for a password; LAN ports are added below
  const tagOf = (i, fallback) => (typeof i.tag === 'string' && /^[\w.-]{1,64}$/.test(i.tag) ? i.tag : fallback);
  let inbounds;
  if (core === 'xray') {
    const s = ins.find((i) => i.protocol === 'socks') || {};
    const hIn = ins.find((i) => i.protocol === 'http') || {};
    const socksTag = tagOf(s, 'socks');
    const httpTag = tagOf(hIn, socksTag === 'http' ? 'http-in' : 'http');
    const sniffing = isObj(s.sniffing) ? { enabled: Boolean(s.sniffing.enabled), destOverride: asList(s.sniffing.destOverride).filter((x) => ['http', 'tls', 'quic', 'fakedns'].includes(x)), routeOnly: Boolean(s.sniffing.routeOnly) } : undefined;
    inbounds = [
      { tag: socksTag, protocol: 'socks', listen, port: settings.socksPort, sniffing, settings: { udp: true, auth: auth ? 'password' : 'noauth', ...(auth ? { accounts: [auth] } : {}) } },
      { tag: httpTag, protocol: 'http', listen, port: settings.httpPort, sniffing, settings: auth ? { accounts: [auth] } : {} },
    ];
  } else {
    const users = auth ? [{ username: auth.user, password: auth.pass }] : undefined;
    const sIn = ins.find((x) => x.type === 'socks') || {};
    const hIn = ins.find((x) => x.type === 'http') || {};
    const socksTag = tagOf(sIn, 'socks-in');
    const httpTag = tagOf(hIn, socksTag === 'http-in' ? 'http-in-2' : 'http-in');
    inbounds = [
      { type: 'socks', tag: socksTag, listen, listen_port: settings.socksPort, ...(users ? { users } : {}) },
      { type: 'http', tag: httpTag, listen, listen_port: settings.httpPort, ...(users ? { users } : {}) },
    ];
  }
  if (settings.allowLan) {
    const lanAuth = settings.lanUser ? { user: settings.lanUser, pass: settings.lanPass || '' } : null;
    if (core === 'xray') {
      inbounds.push(
        { tag: 'socks-lan', protocol: 'socks', listen: '0.0.0.0', port: settings.lanSocksPort, settings: { udp: true, auth: lanAuth ? 'password' : 'noauth', ...(lanAuth ? { accounts: [lanAuth] } : {}) } },
        { tag: 'http-lan', protocol: 'http', listen: '0.0.0.0', port: settings.lanHttpPort, settings: lanAuth ? { accounts: [lanAuth] } : {} });
    } else {
      const users = lanAuth ? [{ username: lanAuth.user, password: lanAuth.pass }] : undefined;
      inbounds.push(
        { type: 'socks', tag: 'socks-lan', listen: '0.0.0.0', listen_port: settings.lanSocksPort, ...(users ? { users } : {}) },
        { type: 'http', tag: 'http-lan', listen: '0.0.0.0', listen_port: settings.lanHttpPort, ...(users ? { users } : {}) });
    }
  }
  const cfg = sanitizeConfig(config, core, inbounds.map((i) => i.tag));
  cfg.inbounds = inbounds;
  if (settings.allowLan) {
    // LAN devices must not reach services that only listen on this computer.
    if (core === 'xray') {
      cfg.outbounds = [...(cfg.outbounds || []), { tag: 'best-lan-block', protocol: 'blackhole' }];
      cfg.routing = isObj(cfg.routing) ? cfg.routing : {};
      cfg.routing.rules = [{ type: 'field', inboundTag: ['socks-lan', 'http-lan'], ip: ['127.0.0.0/8', '::1/128'], outboundTag: 'best-lan-block' }, { type: 'field', inboundTag: ['socks-lan', 'http-lan'], domain: ['full:localhost'], outboundTag: 'best-lan-block' }, ...(cfg.routing.rules || [])];
      // Names that point at this computer are only caught after resolving: every direct (freedom)
      // outbound checks the address it finally dials.
      for (const o of cfg.outbounds) {
        if (!isObj(o) || o.protocol !== 'freedom') continue;
        const st = isObj(o.settings) ? o.settings : {};
        o.settings = { ...st, finalRules: [require('./xray-config').LOOPBACK_FINAL_RULE, ...(Array.isArray(st.finalRules) ? st.finalRules : [])] };
      }
    } else {
      cfg.route = isObj(cfg.route) ? cfg.route : {};
      cfg.route.rules = [{ inbound: ['socks-lan', 'http-lan'], action: 'resolve' }, { inbound: ['socks-lan', 'http-lan'], ip_cidr: ['127.0.0.0/8', '::1/128', '0.0.0.0/32', '::/128'], action: 'reject' }, { inbound: ['socks-lan', 'http-lan'], domain: ['localhost'], action: 'reject' }, ...(cfg.route.rules || [])];
    }
  }
  // Best's own live-traffic endpoint (loopback only), added after the untrusted parts were removed.
  if (stats && core === 'xray') require('./xray-config').withXrayStats(cfg, stats.port);
  else if (stats) require('./singbox-config').withClashApi(cfg, stats);
  return cfg;
}

/** A sanitised copy of an Xray config with a single local HTTP inbound on `port`, for delay / speed tests. */
function xrayTestConfig(config, port, { socks = false } = {}) {
  const cfg = sanitizeConfig(config, 'xray', ['best-test-in']);
  cfg.inbounds = [socks
    ? { tag: 'best-test-in', protocol: 'socks', listen: '127.0.0.1', port, settings: { auth: 'noauth', udp: true, ip: '127.0.0.1' } }
    : { tag: 'best-test-in', protocol: 'http', listen: '127.0.0.1', port, settings: {} }];
  cfg.log = { loglevel: 'error' };
  return cfg;
}

/**
 * A full config the user keeps "as written" (own inbounds). It still must not be able to write
 * files, run programs, open control APIs or reverse tunnels: those parts are removed even here,
 * because such a config can also arrive from a backup file or be planted in the data folder.
 */
function hardenRaw(config, core) {
  const c = isObj(config) ? lastSpelling(JSON.parse(JSON.stringify(config))) : {};
  if (core === 'xray') {
    for (const k of ['api', 'reverse', 'metrics', 'stats']) delete c[k];
    c.log = { loglevel: isObj(c.log) && XRAY_LEVELS.includes(c.log.loglevel) ? c.log.loglevel : 'warning' };
    if (isObj(c.policy)) delete c.policy.system;
    if (Array.isArray(c.outbounds)) c.outbounds = c.outbounds.filter(xrayOutboundAllowed);
    if (Array.isArray(c.inbounds)) c.inbounds = c.inbounds.filter((i) => isObj(i) && ['socks', 'http', 'mixed', 'dokodemo-door', 'tunnel'].includes(i.protocol));
  } else {
    for (const k of ['experimental', 'services', 'certificate']) delete c[k];
    c.log = { level: isObj(c.log) && SB_LEVELS.includes(c.log.level) ? c.log.level : 'warn', timestamp: false };
    if (Array.isArray(c.outbounds)) c.outbounds = c.outbounds.filter((o) => isObj(o) && SB_OUT.includes(o.type));
    if (Array.isArray(c.endpoints)) c.endpoints = c.endpoints.filter((e) => isObj(e) && SB_ENDPOINTS.includes(e.type));
    if (Array.isArray(c.inbounds)) c.inbounds = c.inbounds.filter((i) => isObj(i) && ['socks', 'http', 'mixed', 'direct'].includes(i.type));
    if (isObj(c.route) && Array.isArray(c.route.rule_set)) c.route.rule_set = c.route.rule_set.filter((r) => isObj(r) && (r.type === 'remote' || r.type === 'inline'));
    if (isObj(c.dns) && Array.isArray(c.dns.servers)) c.dns.servers = c.dns.servers.filter((x) => isObj(x) && !['tailscale', 'resolved'].includes(x.type)).map((x) => { const y = { ...x }; if (y.type === 'hosts') delete y.path; return y; });
  }
  return stripDangerous(c);
}

module.exports = { withOwnInbounds, xrayTestConfig, sanitizeConfig, hardenRaw, stripDangerous };
