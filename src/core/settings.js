'use strict';
// Default settings + validation. Anything loaded from disk or sent from the UI goes through
// sanitizeSettings / sanitizeRouting so a bad value can never reach a core config.

const { cleanText, randomId } = require('./util');

const DEFAULT_SETTINGS = Object.freeze({
  language: 'en',
  theme: 'dark',
  accent: 'green',
  density: 'comfortable',
  sidebarCollapsed: false, // side menu shows icons only
  uiZoom: 1, // whole-window size: 0.9 / 1 / 1.1 / 1.25
  hiddenCols: [], // server table columns the user hid
  socksPort: 10808,
  httpPort: 10809,
  pacPort: 10810,
  allowLan: false,
  lanSocksPort: 10820, // LAN sharing has its own ports (with the LAN password)
  lanHttpPort: 10821,
  lanUser: '',
  lanPass: '',
  logLevel: 'warning',
  sniffing: true,
  mux: false,
  muxConcurrency: 8,
  fragment: false,
  fragmentPackets: 'tlshello',
  fragmentLength: '100-200',
  fragmentInterval: '10-20',
  remoteDns: 'https://1.1.1.1/dns-query',
  directDns: 'localhost',
  tunStack: 'mixed',
  tunMtu: 9000,
  tunStrictRoute: true,
  tunIpv6: false, // many servers have no IPv6 exit: with it on, IPv6-first apps would hang; off = refused at once, no leak
  proxyBypass: 'localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>',
  autoStart: false,
  startMinimized: false,
  autoConnect: false,
  closeToTray: true,
  globalHotkey: true,
  autoCheckUpdates: true,
  betaUpdates: false, // also install test versions (GitHub pre-releases)
  statsEnabled: true, // live speed and traffic counters
  webdavUrl: '', // WebDAV backups (password kept in the encrypted secrets file)
  webdavUser: '',
  webdavPass: '',
  webdavDir: 'Best',
  defaultFingerprint: '', // TLS fingerprint for servers whose link has none ('' = leave as is)
  hy2UpMbps: 0, // Hysteria2 bandwidth when the link has none (0 = automatic)
  hy2DownMbps: 0,
  sbMux: false, // sing-box multiplex (the server must support it)
  sbMuxProtocol: 'h2mux',
  sbMuxMax: 4,
  sbMuxPadding: false,
  hotkeys: { toggleProxy: 'Control+Alt+B', showWindow: '', proxyOn: '', proxyOff: '', toggleTun: '', disconnect: '' },
  coreFor: {}, // protocol → 'xray' | 'sing-box' (missing = automatic)
  tunExclude: '', // addresses / ranges that never enter TUN
  logToFile: false, // also write logs to files in the data folder (kept 7 days)
  bindInterface: '', // network adapter for outgoing connections (empty = Windows decides)
  sendThrough: '', // local source IP for outgoing connections
  dnsHosts: '', // "domain ip" lines answered by the tunnel's own DNS
  useSystemHosts: false, // also use C:\Windows\System32\drivers\etc\hosts
  dnsIpv4Only: false, // ask DNS for IPv4 addresses only
  tunFakeIp: false, // TUN: FakeIP (experimental)
  showExitIp: true, // after connecting, look up the exit address through the tunnel
  ipCheckUrl: 'https://www.cloudflare.com/cdn-cgi/trace',
  udpTestTarget: 'pool.ntp.org:123', // NTP server asked during the UDP test
  subUserAgent: '', // empty = "Best/<version>" (see main.js)
  subViaProxy: true,
  subHwid: true, // send a device id to panels that limit devices (see src/core/hwid.js)
  subHwidName: '', // device name shown in the panel; empty = "Windows PC"
  subAutoUpdateHours: 0,
  testUrl: 'https://www.gstatic.com/generate_204',
  speedTestUrl: 'https://speed.cloudflare.com/__down?bytes=25000000',
  testTimeout: 6000,
  testConcurrency: 8,
  proxyMode: 'off',
  lastOnMode: 'on',
  tun: false,
});

const DEFAULT_ROUTING = Object.freeze({
  mode: 'global',
  // ISO 3166 code of the user's own country (sites and IPs there go direct). Empty = detect.
  country: '',
  domainStrategy: 'AsIs',
  blockAds: true,
  rules: [],
});

const ENUMS = {
  language: ['fa', 'en', 'ru', 'zh'],
  theme: ['dark', 'light', 'midnight', 'graphite', 'paper', 'sky', 'system'],
  accent: ['green', 'blue', 'purple', 'orange', 'pink'],
  density: ['comfortable', 'compact'],
  logLevel: ['debug', 'info', 'warning', 'error', 'none'],
  fragmentPackets: ['tlshello', '1-1', '1-2', '1-3', '1-5'],
  tunStack: ['mixed', 'gvisor', 'system'],
  proxyMode: ['off', 'on', 'pac', 'keep'],
  lastOnMode: ['on', 'pac'],
};

function int(v, min, max, def) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
}

function range(v, def) {
  const s = cleanText(v, 16);
  return /^\d{1,5}(-\d{1,5})?$/.test(s) ? s : def;
}

function httpUrl(v, def) {
  const s = cleanText(v, 512);
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : def;
  } catch { return def; }
}

function dnsAddr(v, def) {
  const s = cleanText(v, 256);
  if (s === 'localhost') return s;
  if (/^(https|tls|quic|tcp|udp|h2c):\/\/[A-Za-z0-9.\-:[\]_/%?=&]+$/.test(s)) return s;
  if (/^[0-9a-fA-F:.]+$/.test(s)) return s;
  return def;
}

function sanitizeSettings(input) {
  const src = input && typeof input === 'object' ? input : {};
  const d = DEFAULT_SETTINGS;
  const out = { ...d };
  for (const [k, list] of Object.entries(ENUMS)) {
    if (list.includes(src[k])) out[k] = src[k];
  }
  for (const k of ['allowLan', 'sniffing', 'mux', 'fragment', 'tunStrictRoute', 'tunIpv6', 'autoStart', 'startMinimized', 'autoConnect', 'closeToTray', 'globalHotkey', 'autoCheckUpdates', 'betaUpdates', 'subViaProxy', 'subHwid', 'tun', 'statsEnabled', 'showExitIp', 'useSystemHosts', 'dnsIpv4Only', 'tunFakeIp', 'logToFile', 'sbMux', 'sbMuxPadding', 'sidebarCollapsed']) {
    if (typeof src[k] === 'boolean') out[k] = src[k];
  }
  out.socksPort = int(src.socksPort, 1025, 65535, d.socksPort);
  out.httpPort = int(src.httpPort, 1025, 65535, d.httpPort);
  out.pacPort = int(src.pacPort, 1025, 65535, d.pacPort);
  out.lanSocksPort = int(src.lanSocksPort, 1025, 65535, d.lanSocksPort);
  out.lanHttpPort = int(src.lanHttpPort, 1025, 65535, d.lanHttpPort);
  if (new Set([out.socksPort, out.httpPort, out.pacPort, out.lanSocksPort, out.lanHttpPort]).size < 5) {
    out.socksPort = d.socksPort; out.httpPort = d.httpPort; out.pacPort = d.pacPort;
    out.lanSocksPort = d.lanSocksPort; out.lanHttpPort = d.lanHttpPort;
  }
  out.lanUser = cleanText(src.lanUser, 64);
  out.lanPass = cleanText(src.lanPass, 128);
  out.muxConcurrency = int(src.muxConcurrency, 1, 128, d.muxConcurrency);
  out.fragmentLength = range(src.fragmentLength, d.fragmentLength);
  out.fragmentInterval = range(src.fragmentInterval, d.fragmentInterval);
  out.remoteDns = dnsAddr(src.remoteDns, d.remoteDns);
  out.directDns = dnsAddr(src.directDns, d.directDns);
  out.tunMtu = int(src.tunMtu, 1280, 65535, d.tunMtu);
  const bypass = cleanText(src.proxyBypass ?? d.proxyBypass, 4096);
  out.proxyBypass = /^[A-Za-z0-9.*;:<>_\-[\]]*$/.test(bypass) ? bypass : d.proxyBypass;
  // The old default (a v2rayN name) becomes automatic again; a name the user typed is kept.
  out.subUserAgent = String(src.subUserAgent || '') === 'v2rayN/7.15.0' ? '' : cleanText(src.subUserAgent ?? d.subUserAgent, 128);
  out.subHwidName = cleanText(src.subHwidName ?? d.subHwidName, 40).replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim();
  out.subAutoUpdateHours = int(src.subAutoUpdateHours, 0, 720, 0);
  out.testUrl = httpUrl(src.testUrl, d.testUrl);
  out.speedTestUrl = httpUrl(src.speedTestUrl, d.speedTestUrl);
  out.defaultFingerprint = ['', 'chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random', 'randomized'].includes(src.defaultFingerprint) ? src.defaultFingerprint : '';
  out.hy2UpMbps = int(src.hy2UpMbps, 0, 100000, 0);
  out.hy2DownMbps = int(src.hy2DownMbps, 0, 100000, 0);
  out.sbMuxProtocol = ['h2mux', 'smux', 'yamux'].includes(src.sbMuxProtocol) ? src.sbMuxProtocol : 'h2mux';
  out.sbMuxMax = int(src.sbMuxMax, 1, 32, 4);
  // Global shortcuts: Electron accelerators such as "Control+Alt+B" ('' = none).
  const ACC = /^((Control|Alt|Shift|Super)\+){1,3}([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Home|End|Insert|Delete|PageUp|PageDown|Up|Down|Left|Right)$/;
  const hk = src.hotkeys && typeof src.hotkeys === 'object' ? src.hotkeys : d.hotkeys;
  out.hotkeys = Object.fromEntries(Object.keys(d.hotkeys).map((k) => [k, ACC.test(String(hk[k] || '')) ? String(hk[k]) : (hk[k] === undefined ? d.hotkeys[k] : '')]));
  out.webdavUrl = /^https?:\/\/[^\s"'<>]{3,500}$/i.test(String(src.webdavUrl || '')) ? String(src.webdavUrl) : '';
  out.webdavUser = cleanText(src.webdavUser, 128);
  out.webdavPass = cleanText(src.webdavPass, 256);
  out.webdavDir = /^[\w .-]{1,64}$/.test(String(src.webdavDir || '')) ? String(src.webdavDir) : 'Best';
  out.uiZoom = [0.9, 1, 1.1, 1.25].includes(Number(src.uiZoom)) ? Number(src.uiZoom) : 1;
  out.hiddenCols = (Array.isArray(src.hiddenCols) ? src.hiddenCols : []).filter((c) => ['num', 'address', 'port', 'protocol', 'delay', 'speed'].includes(c));
  const coreFor = src.coreFor && typeof src.coreFor === 'object' ? src.coreFor : {};
  out.coreFor = Object.fromEntries(Object.entries(coreFor).filter(([k, v]) => /^[a-z0-9]{2,12}$/.test(k) && ['xray', 'sing-box', 'mihomo'].includes(v)));
  out.tunExclude = String(src.tunExclude || '').split(/[\s,]+/).filter((x) => /^[0-9a-fA-F:.]{2,45}(\/\d{1,3})?$/.test(x)).slice(0, 200).join('\n');
  out.bindInterface = cleanText(src.bindInterface, 64).replace(/["'`<>]/g, '');
  out.sendThrough = /^[0-9a-fA-F:.]{2,45}$/.test(String(src.sendThrough || '')) ? String(src.sendThrough) : '';
  out.dnsHosts = typeof src.dnsHosts === 'string' ? src.dnsHosts.replace(/[^\S\n]+/g, ' ').slice(0, 20000) : '';
  out.ipCheckUrl = /^https:\/\//i.test(String(src.ipCheckUrl || '')) ? httpUrl(src.ipCheckUrl, d.ipCheckUrl) : d.ipCheckUrl;
  const udpTarget = cleanText(src.udpTestTarget, 260);
  out.udpTestTarget = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]{1,253}):\d{1,5}$/.test(udpTarget) ? udpTarget : d.udpTestTarget;
  out.testTimeout = int(src.testTimeout, 1000, 30000, d.testTimeout);
  out.testConcurrency = int(src.testConcurrency, 1, 32, d.testConcurrency);
  return out;
}

// Routing (profiles, rules, migration) lives in routing.js.
const { sanitizeRouting, sanitizeRule } = require('./routing');

module.exports = { DEFAULT_SETTINGS, DEFAULT_ROUTING, ENUMS, sanitizeSettings, sanitizeRouting, sanitizeRule };
