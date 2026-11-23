'use strict';
// Best — main process.

const {
  app, BrowserWindow, ipcMain, protocol, net: enet, session, Menu, Tray, nativeImage, screen,
  clipboard, dialog, shell, desktopCapturer, nativeTheme, globalShortcut, systemPreferences,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const { execFile, spawn } = require('child_process');
const SYS32 = require('path').join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const SYS_PS = require('path').join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'); // full path: never a powershell.exe from the current folder
const IS_MAC = process.platform === 'darwin';
const macApp = IS_MAC ? require('./mac/app') : null;
const { pathToFileURL } = require('url');
const QRCode = require('qrcode');
const jsQR = require('jsqr');

const { readJson, writeJson, dataDir, canEncrypt, allowKeychainReset } = require('./store');
const { StatsPoller } = require('./stats');
const loopback = require('./loopback');
const appUpd = require('./appupdate');
const { davClient } = require('./webdav');
const { CoreManager } = require('./cores');
const { applySystemProxy } = require('./sysproxy');
const { PacServer } = require('./pac');
const tester = require('./tester');
const { Updater, extInstalled, mihomoInstalled, setElevated, cleanupOldCores, protectedInstall, allCoreExes } = require('./updater');
const trayI18n = require('./tray-i18n');
const { normalizeServer, toLink, serverKey, sameConnection, transportLabel, customInboundPorts, parseLink } = require('../src/core/links');
const { parseContent, parseUserInfo, splitInfoNodes, updateOutcome } = require('../src/core/subscription');
const hwid = require('../src/core/hwid');
const { serverHasIpv6 } = require('./ipv6probe');
const { sanitizeSettings, sanitizeRouting, DEFAULT_ROUTING, DEFAULT_SETTINGS } = require('../src/core/settings');
const { effectiveRouting, importRules, exportRules, profileFromPanelRouting } = require('../src/core/routing');
const { needsSingBox, isUnencrypted, hysteriaNeedsXray } = require('../src/core/xray-config');
const { singBoxOutbound } = require('../src/core/singbox-config');
const { pickCore } = require('../src/core/group');
const { parseHosts } = require('../src/core/dns');
const { canMihomo } = require('../src/core/mihomo-config');
const { xrayTestConfig } = require('../src/core/custom');
const { cleanText, randomId, checkSs2022Key } = require('../src/core/util');

const RENDERER = path.join(__dirname, '..', 'renderer');
const ICONS = app.isPackaged ? path.join(process.resourcesPath, 'icons') : path.join(__dirname, '..', 'resources', 'icons');
const APP_ORIGIN = 'app://best';
const MAX_SUB_BYTES = 10 * 1024 * 1024;

// Portable mode (like v2rayN): a file named "portable" next to Best.exe keeps all data in .\data.
// Data is still encrypted with Windows DPAPI, so it opens only on the same Windows account;
// use Settings › Export backup to move it to another computer.
const PORTABLE = app.isPackaged && fs.existsSync(path.join(path.dirname(process.execPath), 'portable'));
if (PORTABLE) app.setPath('userData', path.join(path.dirname(process.execPath), 'data'));

// Development only: keep test data apart from a real installation (ignored in the packaged app).
if (!app.isPackaged && process.env.BEST_DEV_DATA) app.setPath('userData', process.env.BEST_DEV_DATA);

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ------------------------------------------------------------------ state
// Plain settings can be read right away; encrypted files need the app to be ready (DPAPI).
let settings = sanitizeSettings(macFirstRunDefaults(readJson('settings.json', {})));

/** macOS: the system-wide shortcut uses ⌘ (Command+Option+B), not Control, until the user picks one. */
function macFirstRunDefaults(saved) {
  if (!IS_MAC || !saved || typeof saved !== 'object' || saved.hotkeys !== undefined) return saved;
  return { ...saved, hotkeys: { ...DEFAULT_SETTINGS.hotkeys, toggleProxy: 'Super+Alt+B' } };
}
// No routing file yet = first run (then "my country" is taken from Windows once; "Not set" chosen later stays).
const firstRouting = readJson('routing.json', null) === null;
let routing = sanitizeRouting(readJson('routing.json', DEFAULT_ROUTING));
let servers = [];
let activeId = '';
let subs = [];

function loadEncryptedState() {
  const serverDb = readJson('servers.dat', { servers: [], activeId: '' });
  servers = [];
  for (const s of serverDb.servers || []) { try { servers.push(normalizeServer(s)); } catch { /* drop invalid */ } }
  activeId = servers.some((s) => s.id === serverDb.activeId) ? serverDb.activeId : '';
  subs = (readJson('subs.dat', { subs: [] }).subs || []).map(sanitizeSub).filter(Boolean);
  if (subs.some((x) => !x.name)) { nameSubs(); saveSubs(); }
  const secrets = readJson('secrets.dat', null);
  if (secrets && typeof secrets.lanPass === 'string') settings = sanitizeSettings({ ...settings, lanPass: secrets.lanPass, webdavPass: secrets.webdavPass || '' });
  else if (settings.lanPass) saveSettings(); // move a password from the old plain settings.json
}
/**
 * loadEncryptedState, but on macOS a Keychain that does not give the key (the user pressed Deny,
 * or it is locked) does not lose anything: the user may try again, start empty (the old files are
 * set aside untouched) or quit. False when Best quits.
 */
function loadEncryptedStateAsking() {
  for (;;) {
    try { loadEncryptedState(); return true; } catch (e) {
      if (e.code !== 'KEYCHAIN_LOCKED') throw e;
      const t = trayI18n(settings.language);
      const choice = dialog.showMessageBoxSync({
        type: 'warning', title: 'Best', message: t.kcTitle, detail: t.kcDetail,
        buttons: [t.kcRetry, t.kcEmpty, t.quit], defaultId: 0, cancelId: 2, noLink: true,
      });
      if (choice === 1) { allowKeychainReset(); continue; }
      // Chromium remembers a refused Keychain for the life of the process: asking again needs a
      // fresh start (macOS then shows its own prompt once more).
      if (choice === 0) app.relaunch();
      quitting = true;
      app.exit(0);
      return false;
    }
  }
}

let isAdmin = false;
// macOS: TUN runs through Best's helper service: 'ready', 'outdated' (install again) or 'missing'.
let macTunHelper = 'missing';
const macTun = () => require('./mac/tun');
/** Can TUN be turned on? Windows: Best runs as administrator; macOS: the helper service answers. */
function tunAvailable() { return IS_MAC ? macTunHelper === 'ready' : isAdmin; }
let mainWin = null;
let trayWin = null;
let tray = null;
let trayMenu = null; // the tray's right-click menu (rebuilt by updateTray)
let quitting = false;
let testRun = null;
let subTimer = null;

const cores = new CoreManager();
let updater = null;
let updateTimer = null;
const pac = new PacServer();

/** "Subscription 3" / "اشتراک ۳": first free number. */
function nextSubName(taken = subs) {
  const fa = settings.language === 'fa';
  const word = fa ? 'اشتراک' : settings.language === 'ru' ? 'Подписка' : settings.language === 'zh' ? '订阅' : 'Subscription';
  const digits = (n) => (fa ? String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]) : String(n));
  for (let n = 1; n < 1000; n++) {
    const name = `${word} ${digits(n)}`;
    if (!taken.some((x) => x.name === name)) return name;
  }
  return word;
}

/** Fill in automatic names (after loading, or for new subscriptions). */
function nameSubs() {
  for (const s of subs) if (!s.name) s.name = nextSubName(subs.filter((x) => x !== s));
}

/** Panels such as Marzban / 3x-ui send their title as "profile-title" (optionally base64). */
function decodeProfileTitle(v, max = 60) {
  if (!v) return '';
  let t = String(v).trim();
  if (/^base64:/i.test(t)) { try { t = Buffer.from(t.slice(7), 'base64').toString('utf8'); } catch { return ''; } }
  return cleanText(t, max);
}

/** Content-Disposition: attachment; filename*=UTF-8''<title> (Clash style) → title. */
function dispositionTitle(v) {
  const m = /filename*=UTF-8''([^;]+)/i.exec(v || '') || /filename="?([^";]+)"?/i.exec(v || '');
  if (!m) return '';
  let t = m[1];
  try { t = decodeURIComponent(t); } catch { /* keep raw */ }
  return cleanText(t.replace(/.(ya?ml|json|txt)$/i, ''), 60);
}

/** Only plain http(s) links coming from a panel may ever be opened (and only when the user clicks). */
function safeWebUrl(v) {
  try {
    const u = new URL(String(v || '').trim());
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password ? u.toString().slice(0, 500) : '';
  } catch { return ''; }
}

/**
 * A user's name filter: kept only when it is a valid regular expression without the shapes that can
 * take exponential time (a repeated group such as "(a|aa)+", or back-references). Such a pattern
 * would freeze the whole app while a subscription is updated. Plain filters like "US|DE|🇩🇪" stay fine.
 */
function validRegex(v) {
  const s = cleanText(v, 200);
  if (!s) return '';
  if (/\)\??[*+{]|\\[1-9]|\\k</.test(s)) return '';
  try { new RegExp(s, 'iu'); return s; } catch { return ''; }
}

function sanitizeSub(s) {
  if (!s || typeof s !== 'object') return null;
  let url = '';
  try {
    const u = new URL(String(s.url || ''));
    if (u.protocol === 'https:' || u.protocol === 'http:') url = u.toString();
  } catch { /* invalid */ }
  if (!url) return null;
  const info = s.info && typeof s.info === 'object' ? s.info : {};
  return {
    id: /^[a-f0-9]{6,32}$/.test(s.id || '') ? s.id : randomId(),
    // Old versions named subscriptions after their host; such names become automatic again.
    name: cleanText(s.name, 60) && cleanText(s.name, 60) !== new URL(url).hostname ? cleanText(s.name, 60) : '',
    autoName: s.autoName === true || !cleanText(s.name, 60) || cleanText(s.name, 60) === new URL(url).hostname,
    url,
    enabled: s.enabled !== false,
    userAgent: cleanText(s.userAgent, 128),
    compatUa: s.compatUa === true, // this panel needed the compatible client name
    // Extra links merged into this subscription, and name filters (regular expressions).
    moreUrls: (Array.isArray(s.moreUrls) ? s.moreUrls : String(s.moreUrls || '').split(/[\s,]+/))
      .map((x) => { try { const u = new URL(String(x).trim()); return /^https?:$/.test(u.protocol) ? u.toString() : ''; } catch { return ''; } })
      .filter(Boolean).slice(0, 10),
    via: /^[a-f0-9]{6,32}$/.test(s.via || '') ? s.via : '', // every server of this subscription is reached through this one
    filter: validRegex(s.filter),
    exclude: validRegex(s.exclude),
    autoUpdateHours: Number.isInteger(s.autoUpdateHours) && s.autoUpdateHours >= 0 && s.autoUpdateHours <= 720 ? s.autoUpdateHours : 0,
    lastUpdate: Number.isFinite(s.lastUpdate) ? s.lastUpdate : 0,
    info: {
      upload: Number(info.upload) || 0, download: Number(info.download) || 0,
      total: Number(info.total) || 0, expire: Number(info.expire) || 0,
    },
    infoNodes: Array.isArray(s.infoNodes) ? s.infoNodes.map((x) => cleanText(x, 120)).slice(0, 10) : [],
    error: cleanText(s.error, 200),
    notice: cleanText(s.notice, 300),
    panelInterval: Number.isInteger(s.panelInterval) && s.panelInterval > 0 && s.panelInterval <= 720 ? s.panelInterval : 0,
    supportUrl: safeWebUrl(s.supportUrl),
    webPageUrl: safeWebUrl(s.webPageUrl),
    announce: cleanText(s.announce, 500),
  };
}

function saveServers() { writeJson('servers.dat', { servers, activeId }, { encrypt: true }); }
function saveSubs() { writeJson('subs.dat', { subs }, { encrypt: true }); }
/** settings.json stays readable; the LAN proxy password goes to the encrypted secrets.dat. */
function saveSettings() {
  const { lanPass, webdavPass, ...plain } = settings;
  writeJson('settings.json', plain);
  writeJson('secrets.dat', { lanPass: lanPass || '', webdavPass: webdavPass || '' }, { encrypt: true });
}

// ------------------------------------------------------------------ encrypted backups
// AES-256-GCM with a key derived from the user's password (scrypt). Without the password the
// file is useless; a wrong password or any change to the file is detected by GCM.
const KDF = { N: 2 ** 15, r: 8, p: 1 };
function backupKey(password, salt, kdf) {
  return crypto.scryptSync(password.normalize('NFC'), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 128 * 1024 * 1024 });
}
function encryptBackup(plain, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', backupKey(password, salt, KDF), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    app: 'best-encrypted', version: 1, cipher: 'aes-256-gcm',
    kdf: { name: 'scrypt', ...KDF, salt: salt.toString('base64') },
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
  };
}
function decryptBackup(box, password) {
  const k = box && box.kdf;
  if (!k || k.name !== 'scrypt' || box.cipher !== 'aes-256-gcm' || ![2 ** 14, 2 ** 15, 2 ** 16, 2 ** 17].includes(k.N) || k.r !== 8 || k.p !== 1) throw new Error('INVALID_BACKUP');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', backupKey(password, Buffer.from(k.salt, 'base64'), k), Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8');
  } catch { throw new Error('BACKUP_BAD_PASSWORD'); }
}
/** Active routing profile for the cores, plus which optional country rule files are installed. */
function effRouting() {
  return { ...effectiveRouting(routing), geoExt: { ir: extInstalled('geoIr'), ru: extInstalled('geoRu') } };
}
function saveRouting() { writeJson('routing.json', routing); }

function activeServer() { return servers.find((s) => s.id === activeId) || null; }

function publicServer(s) {
  // The UI never needs raw keys for the list; the editor asks for a single server explicitly.
  return {
    id: s.id, protocol: s.protocol, remark: s.remark || '', address: s.address || '', port: s.port || 0,
    subId: s.subId || '', network: s.network || '', tls: s.tls || '', transport: transportLabel(s),
    core: coreOf(s),
    via: s.via || '', members: s.protocol === 'group' ? s.members : undefined, memberSub: s.memberSub, strategy: s.strategy,
    delay: s.delay, speed: s.speed, udp: s.udp, usageUp: s.usageUp, usageDown: s.usageDown, plain: isUnencrypted(s),
  };
}

function snapshot() {
  return {
    settings, routing, activeId, isAdmin, tunAvailable: tunAvailable(), tunHelper: IS_MAC ? macTunHelper : '',
    servers: servers.map(publicServer),
    subs,
    core: cores.state,
    updates: updater ? updater.state : null,
    appUpdate,
    encrypted: canEncrypt(),
    portable: PORTABLE,
    exitInfo,
    // Cores run as administrator only from a folder normal programs cannot change (all-users install).
    // macOS: TUN never runs the cores from a user folder as root (it will use its helper's own copy).
    secureCores: !app.isPackaged || IS_MAC || protectedInstall(),
    mihomo: mihomoInstalled(),
    version: app.getVersion(),
    defaults: DEFAULT_SETTINGS, // Settings marks what differs from these
  };
}

function send(channel, payload, includeTray = true) {
  for (const w of [mainWin, includeTray ? trayWin : null]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function broadcast() {
  send('state', snapshot());
  updateTray();
}

function toast(kind, key, detail = '') {
  send('toast', { kind, key, detail: cleanText(detail, 300) });
}

// ------------------------------------------------------------------ connection

async function connect(id) {
  const server = servers.find((s) => s.id === (id || activeId));
  if (!server) throw new Error('NO_SERVER');
  activeId = server.id;
  saveServers();
  let effective = settings;
  effective = tunSettings(effective);
  if (server.protocol === 'custom' && !server.managedInbounds) {
    const p = customInboundPorts(server);
    if (p[0]) effective = { ...effective, socksPort: p[0] };
  }
  if (settings.tun && !tunAvailable()) {
    settings = { ...settings, tun: false };
    saveSettings();
    toast('warning', 'tunNeedsAdmin');
  }
  exitInfo = null;
  const plan = planFor(server);
  if (plan) cores.log('app', `${plan.members ? `group of ${plan.members.length}` : 'chain'}${plan.front ? ` through ${plan.front.remark || plan.front.address}` : ''} on ${plan.core}`);
  await cores.start(withDefaults(server), effective, effRouting(), { tun: settings.tun, plan, core: plan ? '' : coreOf(server) });
  await applyProxyMode();
  broadcast();
  if (settings.showExitIp) checkExitIp().catch(() => {});
  guardTunIpv6(effective.socksPort).catch(() => {});
}

// ------------------------------------------------------------------ TUN and IPv6
// With "IPv6 through the tunnel" on and a server that has no IPv6 exit, IPv6-first programs hang:
// TUN accepts their connection and the server cannot carry it, so they never fall back to IPv4.
// After connecting, the server is asked once (through Best's own port, with an IPv4 check); without
// IPv6, TUN refuses IPv6 for this connection, the way it does with the option off. The setting itself
// is not changed: the next connection (another server) is asked again.
let ipv6Seq = 0;
async function guardTunIpv6(socksPort) {
  const seq = ++ipv6Seq;
  if (!settings.tun || !settings.tunIpv6 || !cores.state.tun || !cores.state.running) return;
  const serverId = cores.state.serverId;
  const has = await serverHasIpv6(socksPort || settings.socksPort);
  // Changed meanwhile (another server, TUN or the option switched): that change decides.
  if (seq !== ipv6Seq || cores.state.serverId !== serverId || !cores.state.tun || !settings.tun || !settings.tunIpv6) return;
  if (has !== false) {
    if (has === null) cores.log('app', 'IPv6 check through the server gave no answer (IPv4 failed too); TUN left as it is');
    return;
  }
  const server = servers.find((s) => s.id === serverId);
  cores.log('app', 'this server has no IPv6: TUN refuses IPv6 for this connection, so programs use IPv4 at once');
  try {
    await cores.startTun({ ...tunSettings(), tunIpv6: false });
    toast('info', 'tunIpv6Off', server ? (server.remark || server.address) : '');
  } catch (e) { reportConnectError(e); }
  broadcast();
}

// ------------------------------------------------------------------ exit IP
// After connecting, ask (through the tunnel) which address the internet sees: Cloudflare's trace
// page by default (plain "ip=…" and "loc=CC" lines); JSON services such as ipinfo / ip-api also work.
let exitInfo = null; // { ip, cc, serverId, at } or { error, serverId }
let exitSeq = 0;
async function checkExitIp() {
  const seq = ++exitSeq;
  const serverId = cores.state.serverId;
  if (!cores.state.running) { exitInfo = null; broadcast(); return null; }
  exitInfo = { checking: true, serverId };
  broadcast();
  let info;
  try {
    const ses = session.fromPartition('best-ip');
    await ses.setProxy({ proxyRules: `http=127.0.0.1:${settings.httpPort};https=127.0.0.1:${settings.httpPort}` });
    const res = await ses.fetch(settings.ipCheckUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = (await res.text()).slice(0, 20000);
    let ip = ''; let cc = '';
    if (/^\s*\{/.test(text)) {
      const j = JSON.parse(text);
      ip = j.ip || j.query || j.ip_addr || '';
      cc = j.country_code || j.countryCode || (typeof j.country === 'string' && j.country.length === 2 ? j.country : '') || '';
    } else {
      ip = (/^ip=(.+)$/m.exec(text) || [])[1] || '';
      cc = (/^loc=([A-Za-z]{2})$/m.exec(text) || [])[1] || '';
    }
    ip = String(ip).trim();
    if (!net.isIP(ip)) throw new Error('no address in the answer');
    info = { ip, cc: /^[A-Za-z]{2}$/.test(cc) ? cc.toLowerCase() : '', serverId, at: Date.now() };
  } catch (e) {
    info = { error: cleanText(e.message, 120), serverId };
  }
  if (seq !== exitSeq) return null; // a newer check (or a reconnect) won
  exitInfo = cores.state.running && cores.state.serverId === serverId ? info : null;
  broadcast();
  return exitInfo;
}

/**
 * Groups and chains: which servers take part and on which core. Returns null for a plain server.
 * A front server is used as it is (no chain of chains); groups and full JSON configs cannot be fronts.
 */
function planFor(server) {
  if (server.protocol === 'custom') return null;
  const byId = (id) => servers.find((x) => x.id === id);
  let members = null;
  if (server.protocol === 'group') {
    const ids = [...new Set([...(server.members || []), ...(server.memberSub ? servers.filter((x) => x.subId === server.memberSub).map((x) => x.id) : [])])];
    members = ids.map(byId).filter((s) => s && s.protocol !== 'group' && s.protocol !== 'custom').slice(0, 200).map(withDefaults);
    if (!members.length) throw new Error('GROUP_EMPTY');
  }
  const sub = server.subId ? subs.find((x) => x.id === server.subId) : null;
  const viaId = server.protocol === 'group' ? '' : server.via || (sub && sub.via) || '';
  const front = viaId && viaId !== server.id ? withDefaults(byId(viaId)) : null;
  if (viaId && !front) throw new Error('CHAIN_FRONT_MISSING');
  if (front && (front.protocol === 'group' || front.protocol === 'custom')) throw new Error('CHAIN_BAD_FRONT');
  if (!members && !front) return null;
  const canSingBox = (s) => { if (hysteriaNeedsXray(s)) return false; try { singBoxOutbound(s); return true; } catch { return false; } };
  const core = pickCore([...(members || [server]), ...(front ? [front] : [])], { needsSingBox, canSingBox });
  return { core, members, main: members ? null : withDefaults(server), front, strategy: server.strategy || 'leastPing' };
}

/** Custom hosts from Settings, plus the Windows hosts file when asked (its localhost lines skipped). */
function hostsMap() {
  let map = {};
  if (settings.useSystemHosts) {
    try {
      const file = IS_MAC ? '/etc/hosts' : path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
      map = parseHosts(fs.readFileSync(file, 'utf8').slice(0, 512 * 1024), { skipLocal: true });
    } catch { /* unreadable: ignore */ }
  }
  return { ...map, ...parseHosts(settings.dnsHosts) };
}

/**
 * Server names given as domains. With TUN on, the cores look them up through Windows' DNS, which
 * TUN captures and would send into the tunnel that is still waiting for that very answer: nothing
 * connects. TUN answers these names with the normal (local) DNS instead. All servers are listed,
 * so switching servers does not restart TUN.
 */
function serverDomains() {
  const out = new Set();
  for (const s of servers) {
    const a = String(s.address || '').trim().toLowerCase().replace(/\.$/, '');
    if (a && a.length <= 253 && /^[a-z0-9.-]+$/.test(a) && /[a-z]/.test(a) && a.includes('.')) out.add(a);
  }
  return [...out].sort().slice(0, 5000);
}

/** Settings the TUN front-end needs on top of the saved ones. */
function tunSettings(base = settings) {
  return { ...base, hostsMap: hostsMap(), tunServerDomains: serverDomains(), tunCorePaths: allCoreExes() };
}

/** Defaults from Settings for what a link leaves out (applied to the copies the cores receive). */
function withDefaults(s) {
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

/**
 * Which core runs a server: the user's choice for its protocol when that core can run it,
 * otherwise automatic (Xray whenever possible).
 */
function coreOf(s) {
  if (s.protocol === 'custom') return s.core;
  if (s.protocol === 'group') return '';
  const auto = needsSingBox(s) ? 'sing-box' : 'xray';
  const pref = (settings.coreFor || {})[s.protocol];
  if (pref === 'mihomo' && mihomoInstalled() && canMihomo(s)) return 'mihomo';
  if (pref === 'sing-box' && !hysteriaNeedsXray(s)) { try { singBoxOutbound(s); return 'sing-box'; } catch { return auto; } }
  if (pref === 'xray' && (!needsSingBox(s) || (s.protocol === 'hysteria2' && !s.hopPorts))) return 'xray';
  return auto;
}

// ------------------------------------------------------------------ log file (optional)
let logBuffer = [];
function logToFile(entry) {
  if (!settings.logToFile) return;
  logBuffer.push(`${new Date().toISOString()} [${entry.level}] ${entry.source}: ${entry.text}`);
}
setInterval(() => {
  if (!logBuffer.length) return;
  const lines = logBuffer; logBuffer = [];
  try {
    const dir = path.join(dataDir(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `best-${new Date().toISOString().slice(0, 10)}.log`), `${lines.join('\n')}\n`);
  } catch { /* disk full / no access: drop */ }
}, 2000);
/** Log files older than 7 days are removed. */
function pruneLogFiles() {
  try {
    const dir = path.join(dataDir(), 'logs');
    for (const f of fs.readdirSync(dir)) {
      if (/^best-\d{4}-\d{2}-\d{2}\.log$/.test(f) && Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > 7 * 86400000) fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch { /* no folder yet */ }
}

/** Traffic actually goes through Best: core running and system proxy (or TUN) pointing at it. */
function isEngaged() {
  return Boolean(cores.state.running) && (settings.proxyMode === 'on' || settings.proxyMode === 'pac' || Boolean(cores.state.tun));
}

/** The on/off switch (tray, Ctrl+Enter, Ctrl+Alt+B): toggles the system proxy, starting the core if needed. */
async function toggleProxy() {
  const turnOn = !(settings.proxyMode === 'on' || settings.proxyMode === 'pac');
  if (turnOn && !cores.state.running) {
    if (!activeServer()) { toast('warning', 'NO_SERVER'); return false; }
    await connect(activeId);
  }
  const next = turnOn ? (settings.lastOnMode === 'pac' ? 'pac' : 'on') : 'off';
  if (turnOn) settings = { ...settings, lastOnMode: next };
  await ipcActions.setProxyMode(next);
  return true;
}

async function disconnect() {
  exitInfo = null; exitSeq++;
  await cores.stop();
  await safeApplyProxy('off');
  broadcast();
}

// We only ever clear a system proxy that Best itself set (remembered across crashes),
// so another VPN or proxy the user runs is never disturbed.
let proxyApplied = Boolean(readJson('runtime.json', {}).proxyApplied);

function setProxyApplied(v) {
  proxyApplied = v;
  writeJson('runtime.json', { proxyApplied: v });
}

async function safeApplyProxy(mode) {
  if (mode === 'off' && !proxyApplied) return;
  try {
    await applySystemProxy(mode, settings);
    setProxyApplied(mode === 'on' || mode === 'pac');
  } catch (e) {
    cores.log('app', `system proxy error: ${e.message}`);
    if (e.message === 'MAC_PROXY_ADMIN') toast('error', 'MAC_PROXY_ADMIN'); // macOS standard account
    else toast('error', 'proxyError', e.message);
  }
}

async function applyProxyMode() {
  const mode = settings.proxyMode;
  if (mode === 'pac') {
    try { await pac.start(settings, effRouting()); } catch (e) { toast('error', 'pacError', e.message); return; }
  } else {
    await pac.stop();
  }
  if (!cores.state.running || mode === 'keep') {
    await safeApplyProxy('off');
    return;
  }
  await safeApplyProxy(mode);
}

async function restartIfRunning() {
  if (cores.state.running && activeServer()) {
    try { await connect(activeId); } catch (e) { reportConnectError(e); }
  }
}

function reportConnectError(e) {
  const msg = String(e && e.message || e);
  cores.log('app', `connect failed: ${msg}`);
  const [code, ...rest] = msg.split(':');
  const known = ['PORT_BUSY', 'CORE_FAILED', 'TUN_FAILED', 'NO_SERVER', 'SS_BAD_KEY'];
  toast('error', known.includes(code) ? code : 'CORE_FAILED', known.includes(code) ? rest.join(':') : msg);
  broadcast();
}

let lastCoreError = '';
// ------------------------------------------------------------------ live traffic
const statsPoller = new StatsPoller();
let pollingFor = null;
let lastStats = null;
let usageDirty = false;
function syncStats() {
  const target = cores.state.running ? cores.statsTarget || null : null;
  if (target === pollingFor) return;
  pollingFor = target;
  if (target) statsPoller.start(target); else statsPoller.stop();
}
let watchingConnections = false;
statsPoller.on('connections', (list) => {
  if (!watchingConnections) return;
  // Only what the page shows (no full process paths beyond the file name).
  send('connections', list.slice(0, 1000).map((c) => ({
    id: c.id, start: c.start, upload: c.upload, download: c.download, chains: c.chains, rule: c.rule, rulePayload: c.rulePayload,
    metadata: { host: c.metadata && c.metadata.host, destinationIP: c.metadata && c.metadata.destinationIP, destinationPort: c.metadata && c.metadata.destinationPort, network: c.metadata && c.metadata.network, processPath: c.metadata && String(c.metadata.processPath || '').split(/[\\/]/).pop() },
  })), false);
});
statsPoller.on('stats', (st, delta) => {
  lastStats = st;
  send('stats', st);
  // Per-server usage (proxied bytes only), saved once a minute.
  if (st && delta && (delta.proxyUp || delta.proxyDown)) {
    const s = servers.find((x) => x.id === cores.state.serverId);
    if (s) { s.usageUp = (s.usageUp || 0) + delta.proxyUp; s.usageDown = (s.usageDown || 0) + delta.proxyDown; usageDirty = true; }
  }
  updateTrayTooltip();
});
setInterval(() => { if (usageDirty) { usageDirty = false; saveServers(); } }, 60000);

function fmtRate(b) {
  return b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB/s` : `${Math.round(b / 1e3)} KB/s`;
}

cores.on('state', (st) => {
  syncStats();
  if (!st.running && exitInfo) exitInfo = null;
  // A core or TUN that dies on its own is reported once (it used to be silent).
  if (st.error && st.error !== lastCoreError && ['CORE_EXITED', 'CORE_EXITED_TUN', 'TUN_EXITED'].includes(st.error)) toast('error', st.error);
  lastCoreError = st.error || '';
  broadcast();
});
cores.on('log', (entry) => { send('log', entry, false); logToFile(entry); });

// ------------------------------------------------------------------ servers

function addServers(list, { subId = '' } = {}) {
  const existing = new Set(servers.map(serverKey));
  let added = 0;
  let dup = 0;
  for (const s of list) {
    const clean = normalizeServer({ ...s, id: undefined, subId: subId || s.subId || '' });
    if (existing.has(serverKey(clean))) { dup++; continue; }
    existing.add(serverKey(clean));
    servers.push(clean);
    added++;
  }
  saveServers();
  return { added, dup };
}

/** http(s) lines in pasted text are subscription links: add them as subscriptions and fetch them. */
async function importSubscriptionUrls(lines) {
  const added = [];
  for (const line of lines) {
    const existing = subs.find((s) => s.url === line);
    if (existing) { added.push(existing); continue; }
    const sub = sanitizeSub({ url: line });
    if (sub && !sub.name) sub.name = nextSubName();
    if (!sub) continue;
    subs.push(sub);
    added.push(sub);
  }
  saveSubs();
  broadcast();
  const results = await updateSubs(added.map((s) => s.id));
  broadcast();
  return results.map((r) => ({ ...r, name: (subs.find((s) => s.id === r.id) || {}).name || '' }));
}

async function importText(text, subId = '') {
  const urlLines = String(text || '').split(/\s+/).map((l) => l.trim()).filter((l) => /^https?:\/\/[^\s]+$/i.test(l)).slice(0, 20);
  const r = parseContent(text);
  if (!r.servers.length && urlLines.length) {
    const subResults = await importSubscriptionUrls(urlLines);
    return { added: 0, dup: 0, errors: 0, subs: subResults };
  }
  if (!r.servers.length) {
    // Maybe it is a full Xray / sing-box JSON config.
    const trimmed = String(text || '').trim();
    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed);
        const core = obj.route || obj.endpoints || (Array.isArray(obj.outbounds) && obj.outbounds.some((o) => o && o.type)) ? 'sing-box' : 'xray';
        const s = normalizeServer({ protocol: 'custom', core, config: trimmed, remark: 'Custom config', subId, managedInbounds: true });
        servers.push(s);
        saveServers();
        broadcast();
        return { added: 1, dup: 0, errors: 0 };
      } catch { /* fall through */ }
    }
  }
  const res = addServers(r.servers, { subId });
  broadcast();
  return { ...res, errors: r.errors.length, amnezia: r.errors.some((e) => e.error === 'AMNEZIA_UNSUPPORTED') };
}

async function scanScreenQr() {
  // macOS: screen pictures need "Screen Recording". Its status reads "denied" until it is given, also
  // before macOS ever asked; the first scan goes ahead so that macOS asks (and lists Best in
  // System Settings). After that, a missing permission opens the right System Settings page.
  if (IS_MAC && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    const asked = path.join(app.getPath('userData'), 'screen-permission-asked');
    if (fs.existsSync(asked)) {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture').catch(() => {});
      return { added: 0, dup: 0, errors: 0, notFound: true, needPermission: true };
    }
    try { fs.writeFileSync(asked, ''); } catch { /* asked again next time */ }
  }
  const displays = screen.getAllDisplays();
  const maxW = Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor)));
  const maxH = Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor)));
  const hidden = [];
  for (const w of [mainWin, trayWin]) if (w && w.isVisible()) { hidden.push(w); w.hide(); }
  await new Promise((r) => setTimeout(r, 350));
  let found = [];
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: maxW, height: maxH } });
    for (const src of sources) {
      const img = src.thumbnail;
      const { width, height } = img.getSize();
      if (!width) continue;
      const bgra = img.toBitmap();
      const rgba = new Uint8ClampedArray(bgra.length);
      for (let i = 0; i < bgra.length; i += 4) { rgba[i] = bgra[i + 2]; rgba[i + 1] = bgra[i + 1]; rgba[i + 2] = bgra[i]; rgba[i + 3] = 255; }
      const code = jsQR(rgba, width, height, { inversionAttempts: 'attemptBoth' });
      if (code && code.data) found.push(code.data);
    }
  } finally {
    for (const w of hidden) w.show();
  }
  if (!found.length) return { added: 0, dup: 0, errors: 0, notFound: true };
  return importText(found.join('\n'));
}

// ------------------------------------------------------------------ tests

function freeBasePort(count) {
  const tryOne = (base) => new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(base, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
  return (async () => {
    for (let i = 0; i < 20; i++) {
      const base = 41000 + Math.floor(Math.random() * (60000 - 41000 - count));
      if (await tryOne(base) && await tryOne(base + count - 1)) return base;
    }
    throw new Error('no free ports');
  })();
}

async function runTests(ids, kind) {
  if (testRun) testRun.cancelled = true;
  const run = { cancelled: false };
  testRun = run;
  const list = servers.filter((s) => ids.includes(s.id) && s.protocol !== 'group'); // a group is tested through its members
  const field = kind === 'speed' ? 'speed' : kind === 'udp' ? 'udp' : 'delay';
  const socks = kind === 'udp'; // UDP needs SOCKS inbounds (UDP ASSOCIATE)
  for (const s of list) delete s[field];
  send('test', { kind, running: true, ids: list.map((s) => s.id) });
  const report = (s, value) => { s[field] = value; send('test-result', { id: s.id, field, value }); };
  const started = (s) => send('test-start', { id: s.id, kind });
  const progress = (s) => (bytes, secs) => { if (secs > 0) send('test-progress', { id: s.id, field: 'speed', value: Math.round((bytes / secs / 1e6) * 100) / 100 }); };
  const delayOf = async (s, port) => { started(s); return tester.realDelay(port, settings.testUrl, settings.testTimeout); };
  const speedOf = async (s, port) => { started(s); return tester.speedTest(port, settings.speedTestUrl, 8, progress(s)); };
  const udpOf = async (s, port) => { started(s); return tester.udpDelay(port, settings.udpTestTarget, settings.testTimeout); };
  const measure = (s, port) => (kind === 'speed' ? speedOf(s, port) : kind === 'udp' ? udpOf(s, port) : delayOf(s, port));

  try {
    if (kind === 'tcping') {
      await tester.pool(list, 16, async (s) => { started(s); report(s, s.address && s.port ? await tester.tcping(s.address, s.port, settings.testTimeout) : -1); }, () => run.cancelled);
    } else {
      const groups = { xray: [], 'sing-box': [], mihomo: [] };
      const customs = [];
      for (const s of list) {
        if (s.protocol === 'custom') { customs.push(s); continue; }
        // A server whose config cannot be built (e.g. a bad Shadowsocks 2022 key) would stop the
        // whole batch core from starting: fail it on its own and keep it out of the batch.
        try { checkSs2022Key(s); } catch { report(s, -1); continue; }
        groups[coreOf(s)].push(s);
      }
      // Full JSON configs (custom / JSON subscriptions): each runs in its own test core with a
      // single local HTTP inbound. sing-box configs fall back to a TCP ping of their server.
      await tester.pool(customs, 4, async (s) => {
        if (s.core !== 'xray') {
          if (kind === 'udp') return; // not measurable for full sing-box configs
          started(s); report(s, s.address && s.port ? await tester.tcping(s.address, s.port, settings.testTimeout) : -1); return;
        }
        try {
          const port = await freeBasePort(1);
          const h = await cores.startRawTest(xrayTestConfig(JSON.parse(s.config), port, { socks }), 'xray', port);
          try { report(s, await measure(s, port)); } finally { await h.stop(); }
        } catch { report(s, -1); }
      }, () => run.cancelled);
      for (const kindCore of ['xray', 'sing-box', 'mihomo']) {
        const all = groups[kindCore];
        for (let i = 0; i < all.length && !run.cancelled; i += 64) {
          const chunk = all.slice(i, i + 64);
          let handle;
          try {
            const base = await freeBasePort(chunk.length * 2);
            handle = await cores.startTestCore(chunk.map(withDefaults), settings, kindCore, base, { socks });
          } catch (e) {
            cores.log('app', `test core failed: ${e.message}`);
            // One bad server can break the whole batch: fall back to testing one by one.
            for (const s of chunk) {
              if (run.cancelled) break;
              try {
                const base = await freeBasePort(2);
                const h = await cores.startTestCore([withDefaults(s)], settings, kindCore, base, { socks });
                const v = await measure(s, h.ports[0]);
                await h.stop();
                report(s, v);
              } catch { report(s, -1); }
            }
            continue;
          }
          try {
            if (kind === 'speed') {
              for (let j = 0; j < chunk.length && !run.cancelled; j++) report(chunk[j], await speedOf(chunk[j], handle.ports[j]));
            } else {
              await tester.pool(chunk.map((s, j) => [s, j]), settings.testConcurrency,
                async ([s, j]) => report(s, await measure(s, handle.ports[j])), () => run.cancelled);
            }
          } finally {
            await handle.stop();
          }
        }
      }
    }
  } finally {
    if (testRun === run) testRun = null;
    saveServers();
    send('test', { kind, running: false });
    broadcast();
  }
}

// ------------------------------------------------------------------ subscriptions

// Subscription User-Agent: Best names itself; the compatible name is only a per-panel fallback.
const BEST_UA = `Best/${app.getVersion()}`;
const COMPAT_UA = 'v2rayN/7.15.0';

let fetchChain = Promise.resolve();
/** One request at a time: the proxy setting belongs to the whole 'best-net' session. */
function fetchText(url, opts) {
  const run = fetchChain.then(() => fetchTextNow(url, opts));
  fetchChain = run.catch(() => {});
  return run;
}

let httpsOnlyFetch = false;
let downgradeBlocked = false;
const guardedSessions = new WeakSet();
function guardHttpsOnly(ses) {
  if (guardedSessions.has(ses)) return;
  guardedSessions.add(ses);
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*'] }, (details, cb) => {
    if (httpsOnlyFetch) { downgradeBlocked = true; cb({ cancel: true }); } else cb({});
  });
}

/**
 * This computer's secret for the device id sent to panels (src/core/hwid.js). Its own encrypted
 * file, never part of a backup: restored on another computer it would make two devices one.
 */
let deviceSecret = '';
function getDeviceSecret() {
  if (hwid.validSecret(deviceSecret)) return deviceSecret;
  const stored = readJson('device.dat', null);
  if (stored && hwid.validSecret(stored.secret)) deviceSecret = stored.secret;
  else { deviceSecret = hwid.newSecret(); writeJson('device.dat', { secret: deviceSecret }, { encrypt: true }); }
  return deviceSecret;
}

async function fetchTextNow(url, { userAgent, viaProxy }) {
  const ses = session.fromPartition('best-net');
  await ses.setProxy(viaProxy ? { proxyRules: `http=127.0.0.1:${settings.httpPort};https=127.0.0.1:${settings.httpPort}` } : { mode: 'direct' });
  // An https subscription may never be moved to plain http by a redirect (the server list and the
  // panel token could be read or changed on the way): while it is fetched, every http request of
  // this session is refused. (Requests run one at a time, see fetchText.)
  guardHttpsOnly(ses);
  httpsOnlyFetch = /^https:/i.test(url);
  let res;
  try {
    res = await ses.fetch(url, {
      headers: {
        'User-Agent': userAgent || settings.subUserAgent || BEST_UA, Accept: '*/*',
        ...hwid.hwidHeaders({
          enabled: settings.subHwid, secret: settings.subHwid ? getDeviceSecret() : '', url, model: settings.subHwidName,
          // macOS: its own version (os.release() is the Darwin kernel's), "macOS" / "Mac" for the panel.
          ...(IS_MAC ? { os: 'macOS', osVersion: process.getSystemVersion(), defaultModel: 'Mac' } : { osVersion: os.release() }),
        }),
      },
      redirect: 'follow', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    if (httpsOnlyFetch && downgradeBlocked) throw new Error('INSECURE_REDIRECT');
    throw e;
  } finally { httpsOnlyFetch = false; downgradeBlocked = false; }
  // A panel that limits devices says why it refused (Remnawave: 404 without an id).
  const device = hwid.hwidStatus((n) => res.headers.get(n));
  if (!res.ok) throw new Error(device === 'limit' ? 'HWID_LIMIT' : device === 'required' ? 'HWID_REQUIRED' : `HTTP ${res.status}`);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_SUB_BYTES) { reader.cancel(); throw new Error('response too large'); }
    chunks.push(Buffer.from(value));
  }
  const hdr = (n) => res.headers.get(n) || '';
  return {
    text: Buffer.concat(chunks).toString('utf8'),
    userInfo: hdr('subscription-userinfo'),
    title: decodeProfileTitle(hdr('profile-title')) || dispositionTitle(hdr('content-disposition')),
    interval: Number.parseInt(hdr('profile-update-interval'), 10) || 0,
    supportUrl: safeWebUrl(hdr('support-url')),
    webPageUrl: safeWebUrl(hdr('profile-web-page-url')),
    announce: decodeProfileTitle(hdr('announce'), 500),
    routing: hdr('routing-enable').toLowerCase() === 'false' ? '' : hdr('routing'),
    device,
  };
}

/**
 * A panel can send a routing profile ("Routing" header). It is added to Routing › profiles under
 * the subscription's name and refreshed with each update, but never switched on automatically.
 */
function applyPanelRouting(sub, header) {
  if (!header) return;
  const spec = profileFromPanelRouting(header);
  if (!spec || !spec.rules.length) return;
  const id = `p-s-${sub.id}`;
  const before = routing.profiles.find((p) => p.id === id);
  const exists = Boolean(before);
  const profile = { id, name: spec.name || sub.name, base: 'global', blockAds: false, rules: spec.rules, source: sub.id };
  const profiles = exists ? routing.profiles.map((p) => (p.id === id ? { ...profile, name: p.name || profile.name } : p)) : [...routing.profiles, profile];
  routing = sanitizeRouting({ ...routing, profiles });
  saveRouting();
  if (!exists) toast('info', 'panelRoutingAdded', profile.name);
  if (routing.activeId === id) {
    const after = routing.profiles.find((p) => p.id === id);
    const sig = (p) => JSON.stringify((p && p.rules || []).map((r) => [r.outbound, r.domain, r.ip]));
    if (sig(before) !== sig(after)) {
      // The active profile changed under the user: say so instead of switching silently.
      toast('info', 'panelRoutingChanged', after.name);
      restartIfRunning().catch(() => {});
    }
  }
}

async function updateSub(sub) {
  const tryProxy = cores.state.running;
  // While traffic goes through Best, a failed fetch through the tunnel never falls back to a direct
  // request: that would show the panel address (and an http:// token) to the local network.
  const order = settings.subViaProxy && tryProxy ? (isEngaged() ? [true] : [true, false]) : tryProxy ? [false, true] : [false];
  const fetchWith = async (userAgent, url = sub.url) => {
    let lastErr;
    for (const viaProxy of order) {
      try { return await fetchText(url, { userAgent, viaProxy }); } catch (e) { lastErr = e; }
    }
    throw lastErr;
  };
  // Best introduces itself as "Best/<version>". Only when a panel gives that name nothing usable
  // (a web page, an empty list) is the request repeated once with the widely supported client name,
  // and that subscription keeps using it.
  const autoUa = !sub.userAgent && !settings.subUserAgent;
  let result;
  let parsed;
  try {
    result = await fetchWith(sub.userAgent || settings.subUserAgent || (sub.compatUa ? COMPAT_UA : BEST_UA));
    parsed = parseContent(result.text, { subId: sub.id });
    if (autoUa && !sub.compatUa && !parsed.servers.length) {
      const again = await fetchWith(COMPAT_UA).catch(() => null);
      const reparsed = again && parseContent(again.text, { subId: sub.id });
      if (reparsed && reparsed.servers.length) { result = again; parsed = reparsed; sub.compatUa = true; }
    }
    // Extra links of the same subscription (same client name); their servers are added to the list.
    for (const extra of sub.moreUrls || []) {
      try {
        const more = await fetchWith(sub.userAgent || settings.subUserAgent || (sub.compatUa ? COMPAT_UA : BEST_UA), extra);
        const p = parseContent(more.text, { subId: sub.id });
        parsed = { ...parsed, servers: [...parsed.servers, ...p.servers], errors: [...parsed.errors, ...p.errors] };
      } catch (e) {
        cores.log('app', `subscription ${sub.name}: extra link failed (${cleanText(e.message, 80)})`);
      }
    }
  } catch (e) {
    sub.error = cleanText(e && e.message, 200);
    saveSubs();
    throw e;
  }
  const split = splitInfoNodes(parsed.servers);
  const info = split.info;
  // Name filters: keep only matching names, then drop excluded ones.
  const keep = validRegex(sub.filter) ? new RegExp(sub.filter, 'iu') : null;
  const drop = validRegex(sub.exclude) ? new RegExp(sub.exclude, 'iu') : null;
  const seen = new Set();
  const real = split.servers.filter((s) => {
    const name = (s.remark || '').slice(0, 120);
    if (keep && !keep.test(name)) return false;
    if (drop && drop.test(name)) return false;
    const k = serverKey(s); // the same server from two links only once
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (split.servers.length && !real.length && (keep || drop)) {
    sub.error = 'FILTER_EMPTY';
    saveSubs();
    throw new Error('FILTER_EMPTY');
  }
  // Panel metadata (sent with every response, also when the subscription is blocked).
  sub.panelInterval = result.interval > 0 && result.interval <= 720 ? result.interval : 0;
  sub.supportUrl = result.supportUrl;
  sub.webPageUrl = result.webPageUrl;
  sub.announce = result.announce;
  applyPanelRouting(sub, result.routing);
  if (sub.autoName && result.title) sub.name = result.title;
  const outcome = updateOutcome({ servers: real.length, info: info.length, errors: parsed.errors.length, device: result.device });
  // Expired / out of data: panels such as 3x-ui then return only info entries. Keep the old
  // servers (so nothing silently disappears) and show the panel's message instead.
  if (outcome === 'notice') {
    sub.notice = info.slice(0, 3).join(' · ');
    sub.infoNodes = info.slice(0, 10);
    sub.lastUpdate = Date.now();
    sub.error = '';
    saveSubs();
    return { count: servers.filter((s) => s.subId === sub.id).length, errors: parsed.errors.length, notice: sub.notice };
  }
  sub.notice = '';
  if (outcome !== 'replace') {
    // Nothing usable (empty, the device limit, or links none of which could be read): the old
    // servers stay and the reason is shown.
    sub.error = outcome;
    saveSubs();
    throw new Error(sub.error);
  }
  // Replace this subscription's servers. The same server keeps its id (and so the selection) and its
  // usage; its test results stay only when nothing but the name changed (a new SNI or Reality key
  // makes an old result meaningless).
  const old = new Map(servers.filter((s) => s.subId === sub.id).map((s) => [serverKey(s), s]));
  const fresh = real.map((s) => {
    const prev = old.get(serverKey(s));
    if (!prev) return s;
    const kept = { ...s, id: prev.id, usageUp: prev.usageUp, usageDown: prev.usageDown };
    return sameConnection(prev, s) ? { ...kept, delay: prev.delay, speed: prev.speed, udp: prev.udp } : kept;
  });
  const firstIdx = servers.findIndex((s) => s.subId === sub.id);
  const others = servers.filter((s) => s.subId !== sub.id);
  const at = firstIdx < 0 ? others.length : servers.slice(0, firstIdx).filter((s) => s.subId !== sub.id).length;
  servers = [...others.slice(0, at), ...fresh, ...others.slice(at)];
  if (activeId && !servers.some((s) => s.id === activeId)) activeId = '';
  const ui = parseUserInfo(result.userInfo);
  sub.info = { upload: ui.upload || 0, download: ui.download || 0, total: ui.total || 0, expire: ui.expire || 0 };
  sub.infoNodes = info.slice(0, 10);
  sub.lastUpdate = Date.now();
  sub.error = '';
  saveServers();
  saveSubs();
  return { count: fresh.length, errors: parsed.errors.length };
}

async function updateSubs(ids) {
  const list = subs.filter((s) => (ids ? ids.includes(s.id) : s.enabled));
  const results = [];
  for (const sub of list) {
    try { results.push({ id: sub.id, ok: true, ...(await updateSub(sub)) }); } catch (e) { results.push({ id: sub.id, ok: false, error: cleanText(e.message, 200) }); }
    broadcast();
  }
  return results;
}

function scheduleSubUpdates() {
  clearInterval(subTimer);
  subTimer = setInterval(() => {
    const now = Date.now();
    const due = subs.filter((s) => {
      const hours = s.autoUpdateHours || settings.subAutoUpdateHours || s.panelInterval;
      return s.enabled && hours > 0 && now - s.lastUpdate > hours * 3600 * 1000;
    });
    if (due.length) updateSubs(due.map((s) => s.id)).catch(() => {});
  }, 10 * 60 * 1000);
}

// ------------------------------------------------------------------ admin / startup

/**
 * macOS: install (or bring up to date) the TUN helper service after macOS' password prompt. It
 * keeps its own root-owned copy of the sing-box shipped in Best.app.
 */
async function installTunHelper() {
  const t = trayI18n(settings.language);
  try {
    await macTun().installHelper(CoreManager.bundledSingBox(), t.tunHelperPrompt);
    macTunHelper = 'ready';
    cores.log('app', 'TUN helper installed');
    toast('info', 'TUN_HELPER_INSTALLED');
    return true;
  } catch (e) {
    if (e.message === 'TUN_HELPER_CANCELLED') toast('warning', 'TUN_HELPER_CANCELLED');
    else { cores.log('app', `TUN helper: ${e.message}`); toast('error', 'TUN_HELPER_FAILED', e.message.replace(/^TUN_HELPER_FAILED:/, '')); }
    macTunHelper = await macTun().helperStatus(CoreManager.bundledSingBox());
    return false;
  } finally { broadcast(); }
}

/** macOS: ask the helper again (it may have been installed or removed outside Best). */
async function refreshTunHelper() {
  if (!IS_MAC) return '';
  const now = await macTun().helperStatus(CoreManager.bundledSingBox());
  if (now !== macTunHelper) { macTunHelper = now; broadcast(); }
  return now;
}

/** macOS: remove the TUN helper service (TUN is turned off first). */
async function removeTunHelper() {
  if (!IS_MAC) return false;
  if (settings.tun) await ipcActions.setSettings({ tun: false });
  try {
    await macTun().removeHelper(trayI18n(settings.language).tunHelperRemovePrompt);
  } catch (e) {
    if (e.message !== 'TUN_HELPER_CANCELLED') toast('error', 'TUN_HELPER_FAILED', e.message.replace(/^TUN_HELPER_FAILED:/, ''));
    return false;
  }
  macTunHelper = await macTun().helperStatus(CoreManager.bundledSingBox());
  cores.log('app', 'TUN helper removed');
  broadcast();
  return true;
}

function checkAdmin() {
  // macOS: Best never runs as root; TUN there goes through the helper service (installTunHelper).
  if (IS_MAC) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(path.join(SYS32, 'net.exe'), ['session'], { windowsHide: true, timeout: 5000 }, (err) => resolve(!err));
  });
}

async function relaunchAsAdmin() {
  if (IS_MAC) return installTunHelper(); // macOS: no "run as administrator"; TUN gets its helper service instead
  const exePath = process.execPath;
  const args = app.isPackaged ? [] : [path.join(__dirname, '..')];
  const argList = args.map((a) => `'${a.replace(/['‘’‚‛]/g, "$&$&")}'`).join(',');
  const script = `Start-Process -FilePath '${exePath.replace(/['‘’‚‛]/g, "$&$&")}' ${argList ? `-ArgumentList ${argList}` : ''} -Verb RunAs`;
  const wasRunning = cores.state.running;
  // Free the ports and the single-instance lock for the elevated copy, then WAIT until Windows has
  // actually started it (the UAC prompt was accepted) before quitting. Quitting right away killed
  // the helper before the prompt could appear.
  await cleanupBeforeExit();
  app.releaseSingleInstanceLock();
  try {
    await new Promise((resolve, reject) => {
      execFile(SYS_PS, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 120000 },
        (err) => (err ? reject(err) : resolve()));
    });
  } catch (e) {
    // UAC prompt was cancelled (or failed): stay open and put everything back.
    app.requestSingleInstanceLock();
    cleanedUp = false;
    cores.log('app', `run as administrator cancelled: ${String(e.message || e).split('\n')[0].slice(0, 160)}`);
    toast('warning', 'adminCancelled');
    if (wasRunning && activeServer()) await connect(activeId).catch(reportConnectError);
    else await applyProxyMode().catch(() => {});
    return false;
  }
  quitting = true;
  app.exit(0);
  return true;
}

/** System-wide shortcuts (Settings › Startup): each action can have its own key combination. */
const HOTKEY_ACTIONS = {
  toggleProxy: () => toggleProxy(),
  showWindow: async () => showMain(),
  proxyOn: async () => { if (!(settings.proxyMode === 'on' || settings.proxyMode === 'pac')) await toggleProxy(); },
  proxyOff: async () => { if (settings.proxyMode === 'on' || settings.proxyMode === 'pac') await toggleProxy(); },
  toggleTun: async () => { if (tunAvailable()) await ipcActions.setSettings({ tun: !settings.tun }); else toast('warning', 'tunNeedsAdmin'); },
  disconnect: () => disconnect(),
};
function applyGlobalHotkey() {
  globalShortcut.unregisterAll();
  if (!settings.globalHotkey) return;
  const failed = [];
  for (const [action, acc] of Object.entries(settings.hotkeys || {})) {
    if (!acc || !HOTKEY_ACTIONS[action]) continue;
    let ok = false;
    try { ok = globalShortcut.register(acc, () => { HOTKEY_ACTIONS[action]().catch(reportConnectError); }); } catch { ok = false; }
    if (!ok) failed.push(acc);
  }
  if (failed.length) toast('warning', 'globalHotkeyFail', failed.join(', '));
}

function createUpdater() {
  updater = new Updater({
    getProxyPort: () => (cores.state.running ? settings.httpPort : 0),
    // Stop the tunnel while files are swapped, then bring it back.
    // Only the proxy core restarts; a running TUN keeps its executable (moved aside) and keeps blocking.
    beforeSwap: async () => { const was = cores.state.running; if (was) await cores.stopMain(); return was; },
    afterSwap: async (_id, was) => { if (was && activeServer()) await connect(activeId).catch(reportConnectError); },
    log: (m) => cores.log('app', m),
  });
  updater.on('state', () => broadcast());
  updater.on('progress', (id, p) => sendProgress(id, p));
  scheduleUpdateChecks();
}

// Checked at start-up and then every hour while Best runs (GitHub allows 60 anonymous requests an hour).
function scheduleUpdateChecks() {
  clearInterval(updateTimer);
  if (!settings.autoCheckUpdates) return;
  setTimeout(() => checkAll().catch(() => {}), 8000);
  updateTimer = setInterval(() => checkAll().catch(() => {}), 60 * 60 * 1000);
}

/** Download progress: only the bar moves (at most 5 times a second per item), nothing is rebuilt. */
const progressSent = new Map();
function sendProgress(id, value) {
  const last = progressSent.get(id) || { at: 0, value: -1 };
  const now = Date.now();
  if (value === last.value || (now - last.at < 200 && value < 100)) return;
  progressSent.set(id, { at: now, value });
  send('progress', { id, value }, false);
}

// ------------------------------------------------------------------ updates of Best itself
let appUpdate = { configured: appUpd.REPO_OK, latest: '', available: false, busy: false, progress: 0, error: '' };
let appUpdateInfo = null;
async function checkAppUpdate() {
  if (!appUpd.REPO_OK) return;
  try {
    appUpdateInfo = await appUpd.checkApp(updater, PORTABLE, settings.betaUpdates);
    appUpdate = { ...appUpdate, latest: (appUpdateInfo && appUpdateInfo.latest) || '', available: Boolean(appUpdateInfo && appUpdateInfo.available), back: Boolean(appUpdateInfo && appUpdateInfo.back), error: '' };
  } catch (e) {
    appUpdate = { ...appUpdate, error: cleanText(e.message, 200) };
  }
  broadcast();
}
async function checkAll() {
  const r = await updater.check();
  await checkAppUpdate();
  return r;
}
let appUpdateAbort = null;
async function installAppUpdate() {
  if (!appUpdateInfo || !appUpdateInfo.available || appUpdate.busy) return false;
  appUpdate = { ...appUpdate, busy: true, progress: 0, error: '' };
  broadcast();
  appUpdateAbort = new AbortController();
  const signal = appUpdateAbort.signal;
  try {
    const how = await appUpd.applyApp(updater, appUpdateInfo, PORTABLE, (p) => { appUpdate.progress = Math.round(p * 100); sendProgress('app', appUpdate.progress); }, signal);
    if (how === 'manual') {
      // macOS, Best cannot replace itself where it runs: the checked new app waits in Downloads.
      cores.log('app', `Best ${appUpdateInfo.latest} verified and put in Downloads (this copy cannot replace itself here)`);
      appUpdate = { ...appUpdate, busy: false, progress: 0, error: '' };
      broadcast();
      toast('info', 'UPDATE_MAC_MANUAL', appUpdateInfo.latest);
      return false;
    }
    cores.log('app', `update to Best ${appUpdateInfo.latest} verified; restarting into the new version`);
    quitting = true;
    setTimeout(() => app.quit(), 300);
    return true;
  } catch (e) {
    if (signal.aborted) {
      cores.log('app', 'update of Best cancelled');
      appUpdate = { ...appUpdate, busy: false, progress: 0, error: '' };
      broadcast();
      return false;
    }
    appUpdate = { ...appUpdate, busy: false, error: cleanText(e.message, 200) };
    broadcast();
    throw e;
  } finally { appUpdateAbort = null; }
}

function applyLoginItem() {
  if (!app.isPackaged) return;
  if (IS_MAC) {
    let ok = false;
    try { ok = macApp.setOpenAtLogin(settings.autoStart); } catch (e) { cores.log('app', `login item: ${e.message}`); }
    if (!ok && settings.autoStart) toast('warning', 'MAC_MOVE_TO_APPS');
    return;
  }
  app.setLoginItemSettings({ openAtLogin: settings.autoStart, args: ['--hidden'] });
}

let cleanedUp = false;
async function cleanupBeforeExit() {
  if (cleanedUp) return;
  cleanedUp = true;
  if (testRun) testRun.cancelled = true;
  if (usageDirty) { usageDirty = false; saveServers(); }
  await cores.stop();
  await safeApplyProxy('off');
  await pac.stop();
}

// ------------------------------------------------------------------ windows

const THEME_BG = { dark: '#0E1116', midnight: '#0B1020', graphite: '#151515', light: '#F5F6F8', paper: '#F6F3EE', sky: '#EEF3F9' };
const LIGHT_THEMES = new Set(['light', 'paper', 'sky']);

function themeBg() {
  const t = settings.theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : settings.theme;
  return THEME_BG[t] || THEME_BG.dark;
}

function overlayColors() {
  const t = settings.theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : settings.theme;
  return LIGHT_THEMES.has(t) ? { color: themeBg(), symbolColor: '#1F2430', height: 40 } : { color: themeBg(), symbolColor: '#C9D1DB', height: 40 };
}

function webPrefs() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: false,
    devTools: !app.isPackaged,
  };
}

function createMainWindow(show) {
  mainWin = new BrowserWindow({
    width: 1320, height: 880, minWidth: 940, minHeight: 620, show: false,
    title: 'Best', backgroundColor: themeBg(), icon: path.join(ICONS, 'app.png'),
    // Windows draws its buttons over the page's top 40 px (titleBarOverlay); macOS shows its three
    // window buttons at the top left, placed in the middle of the same 40 px.
    ...(IS_MAC
      ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 13 } }
      : { titleBarStyle: 'hidden', titleBarOverlay: overlayColors() }),
    webPreferences: webPrefs(),
  });
  mainWin.loadURL(`${APP_ORIGIN}/index.html`);
  mainWin.webContents.on('did-finish-load', () => { try { mainWin.webContents.setZoomFactor(settings.uiZoom || 1); } catch { /* closed */ } });
  // An update through the updater task that did not arrive: say so once (the old version is running).
  mainWin.webContents.once('did-finish-load', () => { const v = appUpd.failedTaskUpdate(); if (v) setTimeout(() => toast('error', 'UPDATE_TASK_FAILED', v), 1500); });
  mainWin.once('ready-to-show', () => { if (show) mainWin.show(); });
  // macOS: coming back to the window, the TUN helper's state is read again (cheap: one local request)
  if (IS_MAC) mainWin.on('focus', () => { refreshTunHelper().catch(() => {}); });
  mainWin.on('close', (e) => {
    if (!quitting && settings.closeToTray) { e.preventDefault(); mainWin.hide(); }
  });
  mainWin.on('closed', () => { mainWin = null; });
}

function showMain() {
  if (!mainWin) createMainWindow(true);
  else { if (mainWin.isMinimized()) mainWin.restore(); mainWin.show(); mainWin.focus(); }
}

function createTrayWindow() {
  trayWin = new BrowserWindow({
    width: 360, height: 600, show: false, frame: false, resizable: false, movable: false,
    skipTaskbar: true, alwaysOnTop: true, backgroundColor: themeBg(), roundedCorners: true,
    webPreferences: webPrefs(),
  });
  trayWin.loadURL(`${APP_ORIGIN}/tray.html`);
  trayWin.on('blur', () => { if (trayWin && !trayWin.webContents.isDevToolsOpened()) { trayWin.hide(); trayHiddenAt = Date.now(); } });
  trayWin.on('closed', () => { trayWin = null; });
}

let trayHiddenAt = 0;
function toggleTrayWindow() {
  if (!trayWin) createTrayWindow();
  if (trayWin.isVisible()) { trayWin.hide(); return; }
  // macOS: a click on the menu bar icon first takes the focus from the open small window (which
  // then hides itself); that click is meant to close it, not to open it again.
  if (IS_MAC && Date.now() - trayHiddenAt < 300) return;
  const tb = tray.getBounds();
  const disp = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y });
  const wa = disp.workArea;
  const [w, h] = trayWin.getSize();
  let x = Math.round(tb.x + tb.width / 2 - w / 2);
  let y = tb.y > wa.y + wa.height / 2 ? Math.round(tb.y - h - 8) : Math.round(tb.y + tb.height + 8);
  x = Math.min(Math.max(x, wa.x + 8), wa.x + wa.width - w - 8);
  y = Math.min(Math.max(y, wa.y + 8), wa.y + wa.height - h - 8);
  trayWin.setPosition(x, y, false);
  trayWin.show();
  trayWin.focus();
}

function trayImage() {
  const state = isEngaged() ? (cores.state.tun ? 'tun' : 'on') : 'off';
  const file = IS_MAC ? macApp.trayIconFile(ICONS, state) : path.join(ICONS, `tray-${state}.png`);
  const img = nativeImage.createFromPath(file);
  if (IS_MAC && !img.isEmpty()) img.setTemplateImage(true);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

function updateTrayTooltip() {
  if (!tray) return;
  const t = trayI18n(settings.language);
  const s = activeServer();
  const speed = isEngaged() && lastStats ? `
↓ ${fmtRate(lastStats.downSpeed)}  ↑ ${fmtRate(lastStats.upSpeed)}` : '';
  tray.setToolTip(`Best — ${isEngaged() ? `${t.connected}: ${s ? s.remark || s.address : ''}` : t.disconnected}${speed}`.slice(0, 127));
}

function updateTray() {
  if (!tray) return;
  const t = trayI18n(settings.language);
  tray.setImage(trayImage());
  const s = activeServer();
  updateTrayTooltip();
  // Status badge on the Best button in the taskbar (Windows only; macOS shows it in the menu bar icon).
  if (!IS_MAC && mainWin && !mainWin.isDestroyed()) {
    try {
      if (isEngaged()) {
        const badge = nativeImage.createFromPath(path.join(ICONS, cores.state.tun ? 'overlay-tun.png' : 'overlay-on.png'));
        mainWin.setOverlayIcon(badge, t.connected);
      } else {
        mainWin.setOverlayIcon(null, '');
      }
    } catch { /* overlay icons are best effort */ }
  }
  const modeItem = (mode, label) => ({ label, type: 'radio', checked: settings.proxyMode === mode, click: () => ipcActions.setProxyMode(mode) });
  const profileItem = (p) => ({ label: p.builtin ? ({ 'p-local': t.bypassLocal, 'p-global': t.global, 'p-direct': t.direct }[p.id] || p.name) : p.name, type: 'radio', checked: routing.activeId === p.id, click: () => ipcActions.setRouting({ activeId: p.id }) });
  const recent = servers.filter((x) => x.subId === (s ? s.subId : '') || !s).slice(0, 25);
  trayMenu = Menu.buildFromTemplate([
    { label: isEngaged() ? t.proxyOff : t.proxyOn, click: () => toggleProxy().catch(reportConnectError) },
    { label: t.disconnect, enabled: cores.state.running || cores.state.tun, click: () => disconnect().catch(reportConnectError) },
    { type: 'separator' },
    { label: t.systemProxy, submenu: [modeItem('off', t.off), modeItem('on', t.on), modeItem('pac', 'PAC'), modeItem('keep', t.keep)] },
    { label: t.routing, submenu: routing.profiles.map(profileItem) },
    { label: 'TUN', type: 'checkbox', checked: settings.tun, enabled: tunAvailable(), click: (item) => ipcActions.setSettings({ tun: item.checked }) },
    { label: t.servers, submenu: recent.length ? recent.map((x) => ({ label: (x.remark || x.address).slice(0, 60), type: 'radio', checked: x.id === activeId, click: () => connect(x.id).catch(reportConnectError) })) : [{ label: '—', enabled: false }] },
    { label: t.updateSubs, click: () => updateSubs().then(() => broadcast()).catch(() => {}) },
    { type: 'separator' },
    { label: t.open, click: showMain },
    { label: t.quit, click: () => { quitting = true; app.quit(); } },
  ]);
  // macOS: a menu set on the icon would open on every click (no small window); there it opens on a
  // right-click only, like the Windows tray.
  if (!IS_MAC) tray.setContextMenu(trayMenu);
}

function createTray() {
  tray = new Tray(trayImage());
  tray.on('click', toggleTrayWindow);
  tray.on('double-click', showMain);
  if (IS_MAC) tray.on('right-click', () => { if (trayMenu) tray.popUpContextMenu(trayMenu); });
  updateTray();
}

// ------------------------------------------------------------------ IPC

const ipcActions = {
  async setProxyMode(mode) {
    if (!['off', 'on', 'pac', 'keep'].includes(mode)) return;
    settings = { ...settings, proxyMode: mode, lastOnMode: mode === 'on' || mode === 'pac' ? mode : settings.lastOnMode };
    saveSettings();
    await applyProxyMode();
    broadcast();
  },
  async setRouting(patch) {
    routing = sanitizeRouting({ ...routing, ...patch });
    saveRouting();
    pac.update(settings, effRouting());
    broadcast();
    await restartIfRunning();
  },
  async setSettings(patch) {
    const before = settings;
    settings = sanitizeSettings({ ...settings, ...patch });
    if (settings.tun && !tunAvailable()) { settings.tun = false; toast('warning', 'tunNeedsAdmin'); }
    // LAN sharing never runs as an open proxy: without a user name / password, one is made up
    // (shown in Settings, can be changed there).
    if (settings.allowLan && (!settings.lanUser || !settings.lanPass)) {
      settings = { ...settings, lanUser: settings.lanUser || 'best', lanPass: settings.lanPass || crypto.randomBytes(9).toString('base64url') };
      toast('warning', 'lanAuthMade');
    }
    saveSettings();
    if (before.autoStart !== settings.autoStart) applyLoginItem();
    if (before.globalHotkey !== settings.globalHotkey || JSON.stringify(before.hotkeys) !== JSON.stringify(settings.hotkeys)) applyGlobalHotkey();
    if (before.autoCheckUpdates !== settings.autoCheckUpdates) scheduleUpdateChecks();
    if (before.betaUpdates !== settings.betaUpdates) checkAppUpdate(); // the other channel may have something else
    if (before.theme !== settings.theme && mainWin) {
      try { if (!IS_MAC) mainWin.setTitleBarOverlay(overlayColors()); mainWin.setBackgroundColor(themeBg()); } catch { /* ignore */ }
    }
    if (before.subAutoUpdateHours !== settings.subAutoUpdateHours) scheduleSubUpdates();
    if (before.uiZoom !== settings.uiZoom && mainWin && !mainWin.isDestroyed()) mainWin.webContents.setZoomFactor(settings.uiZoom);
    broadcast();
    const coreKeys = ['defaultFingerprint', 'hy2UpMbps', 'hy2DownMbps', 'sbMux', 'sbMuxProtocol', 'sbMuxMax', 'sbMuxPadding', 'coreFor', 'tunExclude', 'bindInterface', 'sendThrough', 'lanSocksPort', 'lanHttpPort', 'dnsHosts', 'useSystemHosts', 'dnsIpv4Only', 'tunFakeIp', 'statsEnabled', 'socksPort', 'httpPort', 'allowLan', 'lanUser', 'lanPass', 'logLevel', 'sniffing', 'mux', 'muxConcurrency',
      'fragment', 'fragmentPackets', 'fragmentLength', 'fragmentInterval', 'remoteDns', 'directDns', 'tunStack', 'tunMtu', 'tunStrictRoute', 'tunIpv6'];
    if (!settings.tun && cores.state.tun && !cores.state.running) {
      await cores.stopTun();
      broadcast();
    } else if (!before.tun && settings.tun && !cores.state.running) {
      // Like v2rayN: TUN carries all traffic by itself, so switching it on connects right away;
      // the system proxy is not needed for it (and stays as the user set it).
      if (activeServer()) {
        try { await connect(activeId); } catch (e) { settings = { ...settings, tun: false }; saveSettings(); reportConnectError(e); }
      } else toast('warning', 'NO_SERVER');
      broadcast();
    } else if (before.tun !== settings.tun && cores.state.running) {
      try {
        if (settings.tun) await cores.startTun(tunSettings()); else await cores.stopTun();
      } catch (e) { settings = { ...settings, tun: false }; saveSettings(); reportConnectError(e); }
      broadcast();
      if (settings.tun) guardTunIpv6().catch(() => {});
    } else if (coreKeys.some((k) => JSON.stringify(before[k]) !== JSON.stringify(settings[k]))) {
      await restartIfRunning();
    }
    if (['pacPort', 'httpPort', 'socksPort', 'proxyBypass'].some((k) => before[k] !== settings[k]) && cores.state.running) await applyProxyMode();
  },
};

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    const url = event.senderFrame && event.senderFrame.url;
    if (!url || !url.startsWith(APP_ORIGIN + '/')) throw new Error('forbidden');
    return fn(...args);
  });
}

function ids(v) {
  return (Array.isArray(v) ? v : [v]).map(String).filter((x) => /^[a-f0-9]{6,32}$/.test(x));
}

function registerIpc() {
  handle('state:get', () => snapshot());
  handle('logs:get', () => cores.logs);
  handle('logs:clear', () => { cores.logs = []; return true; });

  handle('core:connect', async (id) => { try { await connect(id ? ids(id)[0] : undefined); return true; } catch (e) { reportConnectError(e); return false; } });
  handle('core:disconnect', () => disconnect());
  handle('core:toggle', async () => {
    if (cores.state.running) { await disconnect(); return true; }
    try { await connect(); return true; } catch (e) { reportConnectError(e); return false; }
  });
  handle('proxy:toggle', async () => { try { return await toggleProxy(); } catch (e) { reportConnectError(e); return false; } });
  handle('core:versions', () => cores.versions());

  handle('proxy:set', (mode) => ipcActions.setProxyMode(mode));
  handle('routing:set', (patch) => ipcActions.setRouting(patch && typeof patch === 'object' ? patch : {}));
  handle('settings:set', (patch) => ipcActions.setSettings(patch && typeof patch === 'object' ? patch : {}));

  handle('server:select', async (id) => {
    const [sid] = ids(id);
    if (!servers.some((s) => s.id === sid)) return false;
    activeId = sid;
    saveServers();
    try { await connect(sid); } catch (e) { reportConnectError(e); }
    broadcast();
    return true;
  });
  handle('server:get', (id) => { const s = servers.find((x) => x.id === ids(id)[0]); return s ? { ...s } : null; });
  handle('server:save', async (input) => {
    const clean = normalizeServer(input);
    const idx = servers.findIndex((s) => s.id === clean.id);
    if (idx >= 0) servers[idx] = { ...clean, subId: servers[idx].subId };
    else servers.push(clean);
    saveServers();
    broadcast();
    if (clean.id === activeId) await restartIfRunning();
    return clean.id;
  });
  handle('server:remove', async (list) => {
    const set = new Set(ids(list));
    const wasActive = set.has(activeId);
    servers = servers.filter((s) => !set.has(s.id));
    if (wasActive) { activeId = ''; if (cores.state.running) await disconnect(); }
    saveServers();
    broadcast();
    return true;
  });
  handle('server:duplicate', (id) => {
    const s = servers.find((x) => x.id === ids(id)[0]);
    if (!s) return false;
    const copy = normalizeServer({ ...s, id: undefined, subId: '', remark: `${s.remark || s.address} (copy)` });
    servers.splice(servers.indexOf(s) + 1, 0, copy);
    saveServers();
    broadcast();
    return copy.id;
  });
  handle('server:removeDuplicates', () => {
    const seen = new Set();
    const before = servers.length;
    servers = servers.filter((s) => { const k = serverKey(s); if (seen.has(k) && s.id !== activeId) return false; seen.add(k); return true; });
    saveServers();
    broadcast();
    return before - servers.length;
  });
  handle('server:removeFailed', () => {
    const before = servers.length;
    servers = servers.filter((s) => !(s.delay === -1 && s.id !== activeId));
    saveServers();
    broadcast();
    return before - servers.length;
  });
  handle('server:move', (id, where) => {
    const idx = servers.findIndex((s) => s.id === ids(id)[0]);
    if (idx < 0) return false;
    const [s] = servers.splice(idx, 1);
    if (where === 'top') servers.unshift(s);
    else if (where === 'bottom') servers.push(s);
    else if (typeof where === 'string' && where.startsWith('before:')) {
      const at = servers.findIndex((x) => x.id === where.slice(7));
      servers.splice(at < 0 ? servers.length : at, 0, s);
    } else if (where === 'up') servers.splice(Math.max(0, idx - 1), 0, s);
    else servers.splice(Math.min(servers.length, idx + 1), 0, s);
    saveServers();
    broadcast();
    return true;
  });
  handle('server:importText', (text) => importText(String(text || '').slice(0, MAX_SUB_BYTES)));
  handle('server:importClipboard', async () => importText(String((await clipboard.readText()) || '').slice(0, MAX_SUB_BYTES)));
  handle('server:scanScreen', () => scanScreenQr());
  handle('server:openFile', async () => {
    const r = await dialog.showOpenDialog(mainWin, { properties: ['openFile'], filters: [{ name: 'Config', extensions: ['json', 'txt', 'conf'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const stat = fs.statSync(r.filePaths[0]);
    if (stat.size > 1024 * 1024) throw new Error('file too large');
    return importText(fs.readFileSync(r.filePaths[0], 'utf8'));
  });
  handle('server:link', (id) => { const s = servers.find((x) => x.id === ids(id)[0]); return s ? toLink(s) : ''; });
  handle('server:copyLinks', async (list) => {
    const set = new Set(ids(list));
    const links = servers.filter((s) => set.has(s.id) && s.protocol !== 'custom').map((s) => { try { return toLink(s); } catch { return ''; } }).filter(Boolean);
    await clipboard.writeText(links.join('\n'));
    return links.length;
  });
  handle('server:qr', async (id) => {
    const s = servers.find((x) => x.id === ids(id)[0]);
    if (!s) return null;
    const link = toLink(s);
    return { link, dataUrl: await QRCode.toDataURL(link, { margin: 2, width: 320, errorCorrectionLevel: 'M' }) };
  });
  handle('server:parse', (link) => parseLink(String(link || '')));
  handle('server:preview', (input) => {
    try {
      const s = normalizeServer(input);
      if (s.protocol === 'masque') return { noLink: 'MASQUE_NO_LINK' };
      return { link: toLink(s) };
    } catch (e) { return { error: cleanText(e.message, 200) }; }
  });
  handle('qr:make', (text) => QRCode.toDataURL(String(text || '').slice(0, 4096), { margin: 2, width: 320, errorCorrectionLevel: 'M' }));
  handle('sys:readConfigFile', async () => {
    const r = await dialog.showOpenDialog(mainWin, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json', 'txt'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    if (fs.statSync(r.filePaths[0]).size > 512 * 1024) throw new Error('file too large');
    return fs.readFileSync(r.filePaths[0], 'utf8');
  });
  handle('server:clearResults', () => { for (const s of servers) { delete s.delay; delete s.speed; delete s.udp; } saveServers(); broadcast(); return true; });

  handle('test:run', (list, kind) => {
    if (!['tcping', 'real', 'speed', 'udp'].includes(kind)) return false;
    runTests(ids(list), kind).catch((e) => cores.log('app', `test error: ${e.message}`));
    return true;
  });
  handle('test:cancel', () => { if (testRun) testRun.cancelled = true; return true; });

  handle('sub:save', (input) => {
    const clean = sanitizeSub(input);
    if (!clean) throw new Error('INVALID_URL');
    // A name typed by the user is kept; an empty one gets an automatic name again.
    const before = subs.find((x) => x.id === clean.id);
    // Saving the editor without touching an automatic name keeps it automatic.
    clean.autoName = !cleanText(input.name, 60) || Boolean(before && before.autoName && cleanText(input.name, 60) === before.name);
    if (!clean.name) {
      const prev = subs.find((x) => x.id === clean.id);
      clean.name = prev && prev.autoName ? prev.name : nextSubName(subs.filter((x) => x.id !== clean.id));
    }
    const idx = subs.findIndex((s) => s.id === clean.id);
    if (idx >= 0) subs[idx] = { ...subs[idx], ...clean, info: subs[idx].info, infoNodes: subs[idx].infoNodes, lastUpdate: subs[idx].lastUpdate };
    else subs.push(clean);
    saveSubs();
    broadcast();
    return clean.id;
  });
  handle('sub:remove', async (id, removeServers) => {
    const [sid] = ids(id);
    subs = subs.filter((s) => s.id !== sid);
    if (routing.profiles.some((p) => p.source === sid)) {
      routing = sanitizeRouting({ ...routing, profiles: routing.profiles.filter((p) => p.source !== sid) });
      saveRouting();
    }
    if (removeServers) {
      const wasActive = servers.some((s) => s.subId === sid && s.id === activeId);
      servers = servers.filter((s) => s.subId !== sid);
      if (wasActive) { activeId = ''; if (cores.state.running) await disconnect(); }
    } else {
      for (const s of servers) if (s.subId === sid) s.subId = '';
    }
    saveSubs();
    saveServers();
    broadcast();
    return true;
  });
  // Opens a panel link (support / web page) in the browser. Only URLs the panel sent for that
  // subscription, only http(s), and only after a click in the UI.
  handle('sub:open', async (id, kind) => {
    const sub = subs.find((x) => x.id === ids(id)[0]);
    const url = sub && safeWebUrl(kind === 'support' ? sub.supportUrl : kind === 'web' ? sub.webPageUrl : '');
    if (!url) return false;
    await shell.openExternal(url);
    return true;
  });
  handle('sub:update', async (list) => { const r = await updateSubs(list ? ids(list) : undefined); broadcast(); return r; });

  handle('routing:import', async (source) => {
    let text = String(source || '').trim();
    if (/^https?:\/\//i.test(text)) {
      const viaProxy = cores.state.running;
      const fallback = viaProxy && !isEngaged();
      text = (await fetchText(text, { userAgent: 'Best', viaProxy }).catch(() => (fallback ? fetchText(text, { userAgent: 'Best', viaProxy: false }) : Promise.reject(new Error('DOWNLOAD_FAILED'))))).text;
    } else if (!text) {
      text = String((await clipboard.readText()) || '');
    }
    return importRules(text.slice(0, 5 * 1024 * 1024));
  });
  handle('routing:export', async (id) => {
    const p = routing.profiles.find((x) => x.id === id);
    if (!p) return 0;
    await clipboard.writeText(JSON.stringify(exportRules(p), null, 2));
    return p.rules.length;
  });
  handle('upd:check', () => checkAll());
  handle('upd:app', () => installAppUpdate());
  handle('upd:cancel', (id) => {
    if (id === 'app') { if (!appUpdateAbort) return false; appUpdateAbort.abort(); return true; }
    return Object.keys(updater.state.items).includes(id) ? updater.cancel(id) : false;
  });
  handle('upd:apply', async (id) => { if (!Object.keys(updater.state.items).includes(id)) return false; return updater.apply(id); });
  handle('upd:applyAll', async () => {
    const ids = Object.entries(updater.state.items).filter(([, v]) => v.available).map(([k]) => k);
    const failed = [];
    let updated = 0;
    for (const id of ids) {
      try {
        if (await updater.apply(id)) updated++;
        else break; // cancelled: the rest is not started either
      } catch (e) { failed.push(id); }
    }
    return { updated, failed };
  });
  handle('upd:reset', async (id) => { if (!Object.keys(updater.state.items).includes(id)) return false; return updater.reset(id); });
  handle('net:exitIp', () => checkExitIp());
  handle('conn:watch', (on) => { watchingConnections = Boolean(on); if (!on) send('connections', [], false); return true; });
  handle('conn:close', async (id) => {
    const tgt = cores.statsTarget;
    if (!tgt || tgt.core === 'xray') return false;
    const which = id === 'all' ? '' : `/${encodeURIComponent(String(id).slice(0, 64))}`;
    await new Promise((resolve) => {
      const req = require('http').request({ host: '127.0.0.1', port: tgt.port, method: 'DELETE', path: `/connections${which}`, headers: { Authorization: `Bearer ${tgt.secret}` }, timeout: 3000 }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', resolve); req.on('timeout', () => { req.destroy(); resolve(); });
      req.end();
    });
    return true;
  });
  // Microsoft Store apps exist on Windows only (the page hides this section on macOS).
  handle('uwp:list', () => (IS_MAC ? [] : loopback.listApps()));
  handle('uwp:set', (add, remove) => (IS_MAC ? false : loopback.setExempt(add, remove)));
  handle('sys:relaunchAdmin', () => relaunchAsAdmin());
  handle('sys:tunHelperRemove', () => removeTunHelper());
  handle('sys:tunHelperCheck', () => refreshTunHelper());
  handle('sys:openDataFolder', () => shell.openPath(dataDir()));
  // Best's own GitHub page: a fixed address from package.json, nothing the page passes in.
  handle('sys:openProject', async () => {
    if (!appUpd.REPO_OK) return false;
    await shell.openExternal(`https://github.com/${appUpd.REPO}`);
    return true;
  });
  handle('sys:copy', async (text) => { await clipboard.writeText(String(text || '').slice(0, 100000)); return true; });
  handle('sys:quit', () => { quitting = true; app.quit(); });
  handle('sys:showMain', () => { showMain(); if (trayWin) trayWin.hide(); });
  handle('sys:hideTray', () => { if (trayWin) trayWin.hide(); });
  let pendingBackup = null; // an encrypted backup waiting for its password
  const backupText = (pw) => JSON.stringify(encryptBackup(JSON.stringify({ app: 'best', version: 1, settings, routing, servers, subs, activeId }), pw));
  handle('sys:exportBackup', async (password) => {
    // The backup holds every server key and subscription token, so it is always password-encrypted.
    const pw = String(password || '');
    if (pw.length < 8 || pw.length > 256) throw new Error('BACKUP_PASSWORD_SHORT');
    const r = await dialog.showSaveDialog(mainWin, { defaultPath: `best-backup-${new Date().toISOString().slice(0, 10)}.best`, filters: [{ name: 'Best backup', extensions: ['best'] }] });
    if (r.canceled || !r.filePath) return false;
    fs.writeFileSync(r.filePath, backupText(pw), { mode: 0o600 });
    return true;
  });
  // ---- WebDAV: encrypted backups on the user's own server
  const dav = () => davClient({ url: settings.webdavUrl, user: settings.webdavUser, pass: settings.webdavPass, dir: settings.webdavDir }, cores.state.running ? settings.httpPort : 0);
  handle('dav:upload', async (password) => {
    const pw = String(password || '');
    if (pw.length < 8 || pw.length > 256) throw new Error('BACKUP_PASSWORD_SHORT');
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const name = `best-backup-${stamp}.best`;
    await dav().put(name, backupText(pw));
    return name;
  });
  handle('dav:list', () => dav().list());
  handle('dav:restore', async (name) => {
    const raw = await dav().get(String(name || ''));
    let box;
    try { box = JSON.parse(raw); } catch { throw new Error('INVALID_BACKUP'); }
    if (!box || box.app !== 'best-encrypted') throw new Error('INVALID_BACKUP');
    pendingBackup = raw; // finished by sys:importBackup(password)
    return { needPassword: true };
  });
  handle('sys:importBackup', async (password) => {
    let raw;
    if (pendingBackup && password !== undefined) {
      raw = pendingBackup;
    } else {
      pendingBackup = null;
      const r = await dialog.showOpenDialog(mainWin, { properties: ['openFile'], filters: [{ name: 'Best backup', extensions: ['best', 'json'] }] });
      if (r.canceled || !r.filePaths[0]) return false;
      if (fs.statSync(r.filePaths[0]).size > 50 * 1024 * 1024) throw new Error('file too large');
      raw = fs.readFileSync(r.filePaths[0], 'utf8');
    }
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error('INVALID_BACKUP'); }
    if (data && data.app === 'best-encrypted') {
      if (password === undefined || password === null) { pendingBackup = raw; return { needPassword: true }; }
      data = JSON.parse(decryptBackup(data, String(password))); // throws BACKUP_BAD_PASSWORD
      pendingBackup = null;
    }
    if (!data || data.app !== 'best') throw new Error('INVALID_BACKUP');
    await cores.stop();
    // A backup may come from someone else: LAN sharing stays off until turned on here, and full
    // JSON configs from it always run with Best's own local ports and the untrusted parts removed.
    settings = sanitizeSettings({ ...data.settings, tun: false, allowLan: false });
    routing = sanitizeRouting(data.routing);
    servers = [];
    for (const s of data.servers || []) {
      try { servers.push(normalizeServer(s && s.protocol === 'custom' ? { ...s, managedInbounds: true } : s)); } catch { /* skip */ }
    }
    subs = (data.subs || []).map(sanitizeSub).filter(Boolean);
    nameSubs();
    activeId = servers.some((s) => s.id === data.activeId) ? data.activeId : '';
    saveSettings(); saveRouting(); saveServers(); saveSubs();
    await applyProxyMode();
    broadcast();
    return true;
  });
}

// ------------------------------------------------------------------ app lifecycle

function hardenContents(contents) {
  contents.on('will-navigate', (e, url) => { if (!url.startsWith(APP_ORIGIN + '/')) e.preventDefault(); });
  contents.on('will-redirect', (e) => e.preventDefault());
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

app.on('web-contents-created', (_e, contents) => hardenContents(contents));

app.on('second-instance', () => showMain());
// macOS: a click on Best in the Dock (or opening it again from Applications) brings the window back.
// macOS also sends this right after start; then it is ignored, so a hidden start stays hidden.
let activateFrom = Infinity;
app.on('activate', () => { if (Date.now() >= activateFrom) showMain(); });

app.on('before-quit', (e) => {
  quitting = true;
  if (!cleanedUp) {
    e.preventDefault();
    cleanupBeforeExit().finally(() => app.quit());
  }
});

app.on('window-all-closed', () => { /* keep running in the tray */ });
app.on('will-quit', () => globalShortcut.unregisterAll());

app.whenReady().then(async () => {
  if (IS_MAC) macApp.setAppMenu(); // Best, Edit (⌘C / ⌘V in text fields) and Window menus
  else Menu.setApplicationMenu(null);
  app.setAppUserModelId('com.best.client');

  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setProxy({ mode: 'direct' });

  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    if (u.host !== 'best') return new Response('not found', { status: 404 });
    const file = path.normalize(path.join(RENDERER, decodeURIComponent(u.pathname)));
    if (!file.startsWith(RENDERER + path.sep) || !fs.existsSync(file)) return new Response('not found', { status: 404 });
    return enet.fetch(pathToFileURL(file).toString());
  });

  if (!loadEncryptedStateAsking()) return;
  if (firstRouting && !routing.country) {
    // First run: "my country" = the country Windows is set to.
    const cc = String(app.getLocaleCountryCode() || '').toLowerCase();
    if (/^[a-z]{2}$/.test(cc)) { routing = sanitizeRouting({ ...routing, country: cc }); saveRouting(); }
  }
  await CoreManager.killOrphans();
  isAdmin = await checkAdmin();
  if (IS_MAC) macTunHelper = await macTun().helperStatus(CoreManager.bundledSingBox());
  pruneLogFiles();
  setElevated(isAdmin);
  cleanupOldCores();
  if (settings.tun && !tunAvailable()) { settings = { ...settings, tun: false }; saveSettings(); }
  if (settings.allowLan && (!settings.lanUser || !settings.lanPass)) { settings = { ...settings, lanUser: settings.lanUser || 'best', lanPass: settings.lanPass || crypto.randomBytes(9).toString('base64url') }; saveSettings(); }
  createUpdater();
  registerIpc();
  createTray();
  const hidden = process.argv.includes('--hidden') || settings.startMinimized;
  createMainWindow(!hidden);
  activateFrom = Date.now() + 1500;
  applyLoginItem();
  scheduleSubUpdates();
  applyGlobalHotkey();
  nativeTheme.on('updated', () => {
    if (settings.theme !== 'system') return;
    // Windows switched between light and dark: the minimize / maximize / close buttons that Windows
    // draws over the page follow too (they only changed with Best's own theme switch before).
    if (mainWin && !mainWin.isDestroyed()) {
      try { if (!IS_MAC) mainWin.setTitleBarOverlay(overlayColors()); mainWin.setBackgroundColor(themeBg()); } catch { /* ignore */ }
    }
    broadcast();
  });

  if (activeServer()) {
    try { await connect(activeId); } catch (e) { reportConnectError(e); }
  } else {
    await safeApplyProxy('off');
  }
});

process.on('uncaughtException', (e) => { try { cores.log('app', `error: ${e.stack || e.message}`); } catch { /* ignore */ } });
