'use strict';
const { checkSs2022Key } = require('./util');
// mihomo (Clash.Meta) — the optional third core. Best's server model → a mihomo proxy, Best's
// routing → mihomo rules. Local ports stay on 127.0.0.1; the controller (live traffic and
// connections) listens on 127.0.0.1 with a random secret.

function tlsFields(s, p) {
  if (!s.tls) return;
  p.tls = true;
  p.servername = s.sni || s.host || s.address;
  if (s.alpn && s.alpn.length) p.alpn = s.alpn;
  if (s.fingerprint) p['client-fingerprint'] = s.fingerprint === 'randomized' ? 'random' : s.fingerprint;
  if (s.allowInsecure) p['skip-cert-verify'] = true;
  if (s.tls === 'reality') p['reality-opts'] = { 'public-key': s.publicKey, 'short-id': s.shortId || '' };
}

function transport(s, p) {
  const net = s.network || 'raw';
  if (net === 'raw') {
    if (s.headerType === 'http') {
      p.network = 'http';
      p['http-opts'] = { method: 'GET', path: [s.path || '/'], ...(s.host ? { headers: { Host: s.host.split(',').map((h) => h.trim()) } } : {}) };
    }
    return;
  }
  if (net === 'ws' || net === 'httpupgrade') {
    p.network = 'ws';
    p['ws-opts'] = { path: s.path || '/', ...(s.host ? { headers: { Host: s.host } } : {}), ...(net === 'httpupgrade' ? { 'v2ray-http-upgrade': true } : {}) };
  } else if (net === 'grpc') {
    p.network = 'grpc';
    p['grpc-opts'] = { 'grpc-service-name': s.serviceName || '' };
  } else if (net === 'h2') {
    p.network = 'h2';
    p['h2-opts'] = { path: s.path || '/', ...(s.host ? { host: s.host.split(',').map((x) => x.trim()) } : {}) };
  } else if (net === 'xhttp') {
    p.network = 'xhttp';
    p['xhttp-opts'] = { path: s.path || '/', ...(s.host ? { host: s.host } : {}), ...(s.mode ? { mode: s.mode } : {}) };
  } else {
    throw new Error(`mihomo does not support the ${net} transport`);
  }
}

/** One Best server → one mihomo proxy entry. */
function mihomoProxy(s, name = 'proxy') {
  checkSs2022Key(s);
  if (s.tls === 'reality' && s.pqKex) throw new Error('mihomo cannot connect to this REALITY server (Xray 26+)');
  const base = { name, server: s.address, port: s.port, udp: true };
  let p;
  switch (s.protocol) {
    case 'vless': p = { ...base, type: 'vless', uuid: s.uuid, ...(s.encryption && s.encryption !== 'none' ? { encryption: s.encryption } : {}), ...(s.flow ? { flow: 'xtls-rprx-vision' } : {}), 'packet-encoding': 'xudp' }; tlsFields(s, p); transport(s, p); return p;
    case 'vmess': p = { ...base, type: 'vmess', uuid: s.uuid, alterId: s.alterId || 0, cipher: s.cipher || 'auto' }; tlsFields(s, p); transport(s, p); return p;
    case 'trojan':
      if (!s.tls) throw new Error('mihomo runs Trojan only with TLS'); // plain Trojan stays on Xray / sing-box
      p = { ...base, type: 'trojan', password: s.password }; tlsFields(s, p); transport(s, p); return p;
    case 'shadowsocks':
      p = { ...base, type: 'ss', cipher: s.cipher, password: s.password };
      if (s.plugin === 'obfs-local' || s.plugin === 'simple-obfs') p.plugin = 'obfs';
      if (s.plugin === 'v2ray-plugin') p.plugin = 'v2ray-plugin';
      if (p.plugin) p['plugin-opts'] = s.pluginOpts && typeof s.pluginOpts === 'object' ? s.pluginOpts : {};
      return p;
    case 'hysteria2':
      p = { ...base, type: 'hysteria2', password: s.password || '', sni: s.sni || s.address, ...(s.allowInsecure ? { 'skip-cert-verify': true } : {}) };
      if (s.obfs === 'salamander') { p.obfs = 'salamander'; p['obfs-password'] = s.obfsPassword || ''; }
      if (s.hopPorts) p.ports = s.hopPorts;
      if (s.upMbps) p.up = `${s.upMbps} Mbps`;
      if (s.downMbps) p.down = `${s.downMbps} Mbps`;
      if (s.alpn && s.alpn.length) p.alpn = s.alpn;
      return p;
    case 'tuic':
      return { ...base, type: 'tuic', uuid: s.uuid, password: s.password || '', sni: s.sni || s.address, alpn: s.alpn && s.alpn.length ? s.alpn : ['h3'], 'congestion-controller': s.congestion || 'bbr', 'udp-relay-mode': s.udpRelayMode || 'native', ...(s.allowInsecure ? { 'skip-cert-verify': true } : {}) };
    case 'wireguard':
      return { ...base, type: 'wireguard', 'private-key': s.privateKey, 'public-key': s.peerPublicKey, ...(s.preSharedKey ? { 'pre-shared-key': s.preSharedKey } : {}), ip: (s.localAddress || []).find((a) => !a.includes(':'))?.split('/')[0], ...((s.localAddress || []).some((a) => a.includes(':')) ? { ipv6: s.localAddress.find((a) => a.includes(':')).split('/')[0] } : {}), mtu: s.mtu || 1280, ...(s.reserved ? { reserved: s.reserved } : {}) };
    case 'socks':
      p = { ...base, type: 'socks5', ...(s.username ? { username: s.username, password: s.password || '' } : {}) };
      if (s.tls) p.tls = true;
      return p;
    case 'http':
      p = { ...base, type: 'http', ...(s.username ? { username: s.username, password: s.password || '' } : {}) };
      if (s.tls) { p.tls = true; p.sni = s.sni || s.address; }
      return p;
    case 'anytls':
      return { ...base, type: 'anytls', password: s.password || '', sni: s.sni || s.address, ...(s.fingerprint ? { 'client-fingerprint': s.fingerprint } : {}), ...(s.allowInsecure ? { 'skip-cert-verify': true } : {}) };
    case 'hysteria':
      return { ...base, type: 'hysteria', 'auth-str': s.password || '', sni: s.sni || s.address, up: `${s.upMbps || 50} Mbps`, down: `${s.downMbps || 100} Mbps`, ...(s.obfs ? { obfs: s.obfs } : {}), ...(s.allowInsecure ? { 'skip-cert-verify': true } : {}) };
    default:
      throw new Error(`mihomo does not support ${s.protocol}`);
  }
}

/** Can mihomo run this server? */
function canMihomo(s) { try { mihomoProxy(s); return true; } catch { return false; } }

// --------------------------------------------------------------------------- rules
const TARGET = { proxy: 'proxy', direct: 'DIRECT', block: 'REJECT' };

// A comma or bracket inside a value would end the mihomo rule early and let the rest choose the
// target ("regexp:.*,DIRECT"): such values are skipped. (DOMAIN-REGEX keeps commas out as well.)
const SAFE_VALUE = (v) => typeof v === 'string' && v.length > 0 && v.length <= 500 && !/[,()\r\n]/.test(v);

function conditions(r) {
  r = { ...r, domain: (r.domain || []).filter(SAFE_VALUE), ip: (r.ip || []).filter(SAFE_VALUE), port: (r.port || []).filter((p) => SAFE_VALUE(String(p))), process: (r.process || []).filter(SAFE_VALUE) };
  const groups = [];
  const dom = [];
  for (const d of r.domain || []) {
    const [kind, ...rest] = d.includes(':') ? d.split(':') : ['', d];
    const v = rest.join(':');
    if (!kind) dom.push(`DOMAIN-KEYWORD,${d}`);
    else if (kind === 'geosite') dom.push(`GEOSITE,${v}`);
    else if (kind === 'domain') dom.push(`DOMAIN-SUFFIX,${v}`);
    else if (kind === 'full') dom.push(`DOMAIN,${v}`);
    else if (kind === 'keyword') dom.push(`DOMAIN-KEYWORD,${v}`);
    else if (kind === 'regexp') dom.push(`DOMAIN-REGEX,${v}`);
  }
  if (dom.length) groups.push(dom);
  const ip = (r.ip || []).map((x) => (x.startsWith('geoip:') ? `GEOIP,${x.slice(6)},no-resolve` : `${x.includes(':') ? 'IP-CIDR6' : 'IP-CIDR'},${x.includes('/') ? x : `${x}/${x.includes(':') ? 128 : 32}`},no-resolve`));
  if (ip.length) groups.push(ip);
  if ((r.port || []).length) groups.push(r.port.map((p) => `DST-PORT,${p}`));
  if ((r.process || []).length) groups.push(r.process.map((p) => `PROCESS-NAME,${p}`));
  if (r.network && r.network !== 'tcp,udp') groups.push([`NETWORK,${r.network.toUpperCase()}`]);
  return groups;
}

/** A Best rule (AND of its matchers, OR inside each) → mihomo rule lines. */
function ruleLines(r) {
  const groups = conditions(r);
  const target = TARGET[r.outbound];
  if (!groups.length || !target) return [];
  if (groups.length === 1) return groups[0].map((c) => (c.endsWith(',no-resolve') ? `${c.slice(0, -11)},${target},no-resolve` : `${c},${target}`));
  const part = (g) => (g.length === 1 ? `(${g[0].replace(/,no-resolve$/, '')})` : `(OR,(${g.map((c) => `(${c.replace(/,no-resolve$/, '')})`).join(',')}))`);
  return [`AND,(${groups.map(part).join(',')}),${target}`];
}

/** Full mihomo config. `geoSiteCat` = the geosite category for "my country" (if any). */
function buildMihomoConfig(server, settings, routing, { controller, geoSiteCat = '' } = {}) {
  const proxy = mihomoProxy(server, 'proxy');
  const rules = [];
  for (const r of routing.rules || []) if (r.enabled) rules.push(...ruleLines(r));
  if (routing.blockAds) rules.push('GEOSITE,category-ads-all,REJECT');
  rules.push('GEOIP,private,DIRECT,no-resolve', 'DOMAIN,localhost,DIRECT');
  const cc = routing.country;
  if (routing.mode === 'bypass-local' && /^[a-z]{2}$/.test(cc || '')) {
    if (geoSiteCat) rules.push(`GEOSITE,${geoSiteCat},DIRECT`);
    rules.push(`DOMAIN-SUFFIX,${cc},DIRECT`, `GEOIP,${cc},DIRECT`);
  }
  rules.push(routing.mode === 'direct' ? 'MATCH,DIRECT' : 'MATCH,proxy');
  const directDns = !settings.directDns || settings.directDns === 'localhost' ? 'system' : settings.directDns;
  const cfg = {
    'mixed-port': 0,
    'socks-port': settings.socksPort,
    port: settings.httpPort,
    'bind-address': '127.0.0.1',
    'allow-lan': false,
    mode: 'rule',
    'log-level': { debug: 'debug', info: 'info', warning: 'warning', error: 'error', none: 'silent' }[settings.logLevel] || 'warning',
    ipv6: true,
    'unified-delay': true,
    'geodata-mode': true,
    'geo-auto-update': false,
    'external-controller': controller ? `127.0.0.1:${controller.port}` : '',
    secret: controller ? controller.secret : '',
    profile: { 'store-selected': false, 'store-fake-ip': false },
    dns: {
      enable: true,
      ipv6: !settings.dnsIpv4Only,
      'enhanced-mode': 'redir-host',
      'respect-rules': true,
      nameserver: [settings.remoteDns || 'https://1.1.1.1/dns-query'],
      'proxy-server-nameserver': [directDns],
      ...(settings.hostsMap && Object.keys(settings.hostsMap).length ? {} : {}),
    },
    ...(settings.hostsMap && Object.keys(settings.hostsMap).length ? { hosts: Object.fromEntries(Object.entries(settings.hostsMap).map(([d, ips]) => [d, ips.length === 1 ? ips[0] : ips])) } : {}),
    proxies: [proxy],
    rules,
  };
  if (settings.allowLan) {
    const users = settings.lanUser ? [{ username: settings.lanUser, password: settings.lanPass || '' }] : [];
    cfg.listeners = [
      { name: 'socks-lan', type: 'socks', port: settings.lanSocksPort, listen: '0.0.0.0', udp: true, users },
      { name: 'http-lan', type: 'http', port: settings.lanHttpPort, listen: '0.0.0.0', users },
    ];
    // LAN devices must not reach services that only listen on this computer.
    // Without no-resolve, names are looked up first, so a name pointing at 127.0.0.1 is caught too.
    cfg.rules.unshift(...['socks-lan', 'http-lan'].flatMap((n) => [`AND,((IN-NAME,${n}),(DOMAIN,localhost)),REJECT`, `AND,((IN-NAME,${n}),(IP-CIDR,127.0.0.0/8)),REJECT`, `AND,((IN-NAME,${n}),(IP-CIDR,0.0.0.0/32)),REJECT`, `AND,((IN-NAME,${n}),(IP-CIDR6,::1/128)),REJECT`]));
  }
  return cfg;
}

/** Test config: one local listener per server, each bound to its own proxy. */
function buildMihomoTestConfig(servers, basePort, { socks = false } = {}) {
  return {
    'log-level': 'error', mode: 'rule', 'allow-lan': false, 'bind-address': '127.0.0.1', 'geodata-mode': true, 'geo-auto-update': false,
    profile: { 'store-selected': false },
    proxies: servers.map((s, i) => mihomoProxy(s, `p-${i}`)),
    listeners: servers.map((s, i) => ({ name: `in-${i}`, type: socks ? 'socks' : 'http', port: basePort + i, listen: '127.0.0.1', proxy: `p-${i}`, ...(socks ? { udp: true } : {}) })),
    rules: ['MATCH,DIRECT'],
  };
}

module.exports = { buildMihomoTestConfig, buildMihomoConfig, mihomoProxy, canMihomo, ruleLines };
