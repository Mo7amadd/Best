// Best for Android — UI. Data handling and configs come from the shared core (globalThis.BestCore,
// the same code as the Windows app); this file only draws screens and talks to the native side.
// Every text from configs / subscriptions is set as text (h() never uses innerHTML).

import { h, mount, icon } from '../gen/dom.js';
import { t, setLang, isRtl, errText, num, LANGS } from './strings.js';
import { call, on } from './bridge.js';
import { createEditor } from './editor.js';
import { createUpdates } from './updates.js';
import { createMore } from './more.js';
import { NOTICES } from './notices.js';

const Core = globalThis.BestCore;
const root = document.getElementById('app');

const MAX_SERVERS = 5000;
const SPARK_POINTS = 40;
const PROTO_LABEL = { vless: 'VLESS', vmess: 'VMess', trojan: 'Trojan', shadowsocks: 'Shadowsocks', hysteria2: 'Hysteria2', hysteria: 'Hysteria', tuic: 'TUIC', wireguard: 'WireGuard', socks: 'SOCKS', http: 'HTTP', anytls: 'AnyTLS', naive: 'Naive', custom: 'JSON', group: 'Group' };

const S = {
  ready: false,
  info: {},
  page: 'configs',
  sheet: null, // { type, ... }
  toast: null, // { text, err }
  settings: Core.settings.sanitizeSettings({}),
  routing: Core.settings.sanitizeRouting({}),
  servers: [],
  subs: [],
  ui: { selected: '', tab: 'all', glass: true, sortFast: false, appMode: 'all', apps: [], metric: 'delay', updBeta: false, updAuto: true, updWifi: true, updLast: 0, logConnections: false, mode: 'vpn', bootConnect: false, allowTasker: false, vpnMtu: 1500, fakeDns: false, preferIpv6: false, autoTest: false, autoDelete: false, listView: 'list', hiddenSubs: [] },
  exit: null, // { ip, cc } of the running connection
  lanIp: null,
  geoExt: { ir: 0, ru: 0 },
  apps: null, // installed launcher apps, loaded when the picker opens
  pull: 0, // pull-to-update distance in px
  refreshing: false,
  vpn: { phase: 'idle', name: '', forMs: 0, error: null },
  vpnSince: 0,
  traffic: { up: 0, down: 0 },
  spark: [],
  delays: {}, // server id → ms | 'test' | 'fail'
  speeds: {}, // server id → MB/s | 'test' | 'fail'
  testing: null, // { kind, done, n } while a test runs
  query: '', // search text (configs page)
  searching: false,
  edit: null, // the config editor's state
  busy: {}, // subscription id → true while downloading
};

// ------------------------------------------------------------------ storage

const saveTimers = {};
function save(name) {
  clearTimeout(saveTimers[name]);
  saveTimers[name] = setTimeout(() => {
    const data = { settings: S.settings, routing: S.routing, servers: S.servers, subs: S.subs, ui: S.ui }[name];
    call('store.write', { name, text: JSON.stringify(data) }).catch((e) => showToast(errText(e.code), true));
  }, 250);
}

async function readJson(name) {
  try {
    const text = await call('store.read', { name });
    return text ? JSON.parse(text) : null;
  } catch { return null; }
}

function cleanServers(list) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (out.length >= MAX_SERVERS) break;
    try { out.push(Core.links.normalizeServer(s)); } catch { /* dropped: not a valid config */ }
  }
  return out;
}

/**
 * A user's name filter: kept only when it is a valid regular expression without the shapes that
 * can take exponential time (as on Windows: a repeated group, back-references).
 */
function validRegex(v) {
  const s = Core.util.cleanText(v || '', 200);
  if (!s) return '';
  if (/\)\??[*+{]|\\[1-9]|\\k</.test(s)) return '';
  try { new RegExp(s, 'iu'); return s; } catch { return ''; }
}

const httpUrl = (v) => { try { const u = new URL(String(v || '').trim()); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.toString() : ''; } catch { return ''; } };
const ID = /^[a-f0-9]{6,40}$/;

/** Subscriptions with the same fields as Best for Windows, so backups move both ways. */
function cleanSubs(list) {
  return (Array.isArray(list) ? list : []).filter((x) => x && typeof x === 'object' && httpUrl(x.url)).slice(0, 100).map((x) => ({
    id: typeof x.id === 'string' && /^[\w-]{4,40}$/.test(x.id) ? x.id : Core.util.randomId(),
    name: Core.util.cleanText(x.name || '', 60),
    autoName: x.autoName === true || !x.name,
    url: httpUrl(x.url),
    enabled: x.enabled !== false,
    userAgent: Core.util.cleanText(x.userAgent || '', 128),
    compatUa: x.compatUa === true,
    moreUrls: (Array.isArray(x.moreUrls) ? x.moreUrls : String(x.moreUrls || '').split(/[\s,]+/)).map(httpUrl).filter(Boolean).slice(0, 10),
    via: ID.test(x.via || '') ? x.via : '',
    filter: validRegex(x.filter),
    exclude: validRegex(x.exclude),
    autoUpdateHours: Number.isInteger(x.autoUpdateHours) && x.autoUpdateHours >= 0 && x.autoUpdateHours <= 720 ? x.autoUpdateHours : 0,
    updatedAt: Number(x.updatedAt) || Number(x.lastUpdate) || 0,
    notice: Core.util.cleanText(x.notice || '', 300),
    supportUrl: httpUrl(x.supportUrl).slice(0, 500),
    webPageUrl: httpUrl(x.webPageUrl).slice(0, 500),
    announce: Core.util.cleanText(x.announce || '', 500),
    infoNodes: (Array.isArray(x.infoNodes) ? x.infoNodes : []).map((n) => Core.util.cleanText(String(n || ''), 120)).filter(Boolean).slice(0, 5),
    info: x.info && typeof x.info === 'object' ? Core.subscription.parseUserInfo(Object.entries(x.info).map(([k, v]) => `${k}=${v}`).join(';')) : {},
  }));
}

async function load() {
  const [settings, routing, servers, subs, ui] = await Promise.all(['settings', 'routing', 'servers', 'subs', 'ui'].map(readJson));
  S.settings = Core.settings.sanitizeSettings(settings || {});
  S.routing = Core.settings.sanitizeRouting(routing || {});
  S.servers = cleanServers(servers);
  S.subs = cleanSubs(subs);
  if (ui && typeof ui === 'object') {
    S.ui.selected = typeof ui.selected === 'string' ? ui.selected : '';
    S.ui.tab = typeof ui.tab === 'string' ? ui.tab : 'all';
    S.ui.glass = ui.glass !== false;
    S.ui.sortFast = ui.sortFast === true;
    S.ui.appMode = ['all', 'include', 'exclude'].includes(ui.appMode) ? ui.appMode : 'all';
    S.ui.apps = Array.isArray(ui.apps) ? ui.apps.filter((p) => typeof p === 'string' && /^[A-Za-z][\w.]{1,254}$/.test(p)).slice(0, 500) : [];
    S.ui.metric = ui.metric === 'speed' ? 'speed' : 'delay';
    S.ui.updBeta = ui.updBeta === true;
    S.ui.updAuto = ui.updAuto !== false;
    S.ui.updWifi = ui.updWifi !== false;
    S.ui.updLast = Number(ui.updLast) || 0;
    S.ui.logConnections = ui.logConnections === true;
    S.ui.mode = ui.mode === 'proxy' ? 'proxy' : 'vpn';
    for (const k of ['bootConnect', 'allowTasker', 'fakeDns', 'preferIpv6', 'autoTest', 'autoDelete']) S.ui[k] = ui[k] === true;
    S.ui.vpnMtu = Number.isInteger(ui.vpnMtu) && ui.vpnMtu >= 1280 && ui.vpnMtu <= 9000 ? ui.vpnMtu : 1500;
    S.ui.listView = ui.listView === 'grid' ? 'grid' : 'list';
    S.ui.hiddenSubs = Array.isArray(ui.hiddenSubs) ? ui.hiddenSubs.filter((id) => typeof id === 'string' && S.subs.some((x) => x.id === id)).slice(0, 100) : [];
  }
}

/** The phone's region ("ir", "ru"…), used for "my country" when none is chosen. */
function phoneRegion() {
  const m = /[-_]([A-Za-z]{2})\b/.exec(String(S.info.locale || ''));
  return m ? m[1].toLowerCase() : '';
}

function countryName(cc) {
  if (!cc) return '';
  try { return new Intl.DisplayNames([S.settings.language], { type: 'region' }).of(cc.toUpperCase()) || cc.toUpperCase(); } catch { return cc.toUpperCase(); }
}

/** Routing / app choices take effect at once: a running connection is restarted with them. */
let reconnectTimer = 0;
function applyToConnection() {
  clearTimeout(reconnectTimer);
  if (S.vpn.phase !== 'connected') return;
  reconnectTimer = setTimeout(() => { if (S.vpn.phase === 'connected') connect(); }, 700);
}

/** Starts a running connection again at once (its config or routing data changed). */
function reconnect() {
  clearTimeout(reconnectTimer);
  if (S.vpn.phase === 'connected') connect();
}

// ------------------------------------------------------------------ helpers

const nameOf = (s) => (s && (s.remark || s.address)) || '';
/** What the library says ("Lib v40, Xray-core v26.11.9") as the Xray version alone: "26.11.9". */
const xrayVersion = () => { const v = String(S.info.xray || ''); const m = /Xray-core\s+v?([\w.+-]+)/i.exec(v); return m ? m[1] : v; };
const protoOf = (s) => PROTO_LABEL[s.protocol] || String(s.protocol || '').toUpperCase();
// Short protocol tag of the two-column view.
const SHORT_PROTO = { vless: 'VLESS', vmess: 'VMESS', trojan: 'TROJAN', shadowsocks: 'SS', hysteria2: 'HY2', hysteria: 'HY', tuic: 'TUIC', wireguard: 'WG', anytls: 'ANYTLS', naive: 'NAIVE', socks: 'SOCKS', http: 'HTTP', group: 'GROUP', custom: 'JSON' };
const shortProto = (s) => SHORT_PROTO[s.protocol] || String(s.protocol || '').toUpperCase().slice(0, 6);
const subOf = (s) => (s.protocol === 'group'
  ? `${t('ed_group')} · ${t('membersN', { n: num((s.members || []).length) })} · ${t(`strat_${s.strategy || 'leastPing'}`)}`
  : `${protoOf(s)} · ${Core.links.transportLabel(s)}`);
const selectedServer = () => S.servers.find((s) => s.id === S.ui.selected) || null;

/** Configs of subscriptions the user switched off (Subscriptions › Show in configs) stay out of the lists. */
const subShown = (sub) => !(S.ui.hiddenSubs || []).includes(sub.id);
const shownServers = () => { const hidden = new Set(S.ui.hiddenSubs || []); return hidden.size ? S.servers.filter((s) => !s.subId || !hidden.has(s.subId)) : S.servers; };

function setSubShown(sub, on) {
  const hidden = new Set(S.ui.hiddenSubs || []);
  if (on) hidden.delete(sub.id); else hidden.add(sub.id);
  S.ui.hiddenSubs = [...hidden];
  // The chosen config was in it: the first config still shown takes its place.
  const sel = selectedServer();
  if (!on && sel && sel.subId === sub.id) { const next = shownServers()[0]; S.ui.selected = next ? next.id : ''; }
  save('ui');
  render();
}

function visibleServers() {
  let list;
  if (S.ui.tab === 'all') list = shownServers();
  else if (S.ui.tab === 'manual') list = S.servers.filter((s) => !s.subId);
  else list = S.servers.filter((s) => s.subId === S.ui.tab);
  const q = S.searching ? S.query.trim().toLowerCase() : '';
  if (q) list = list.filter((s) => `${nameOf(s)} ${s.address || ''} ${protoOf(s)} ${Core.links.transportLabel(s)}`.toLowerCase().includes(q));
  if (!S.ui.sortFast) return list;
  const speed = S.ui.metric === 'speed';
  const score = speed
    ? (s) => (typeof S.speeds[s.id] === 'number' ? -S.speeds[s.id] : S.speeds[s.id] === 'fail' ? 1e9 : 1e8)
    : (s) => (typeof S.delays[s.id] === 'number' ? S.delays[s.id] : S.delays[s.id] === 'fail' ? 1e9 : 1e8);
  return list.slice().sort((a, b) => score(a) - score(b));
}

function rate(bps) {
  if (bps >= 1024 * 1024) return [num(bps / (1024 * 1024), 1), 'MB/s'];
  if (bps >= 1024) return [num(Math.round(bps / 1024)), 'KB/s'];
  return [num(bps), 'B/s'];
}

// An amount kept in one piece inside right-to-left text ("۹۹٫۴ GB", never "GB ۹۹٫۴").
const isolate = (text) => `\u2068${text}\u2069`;

function bytes(n) {
  if (n >= 1024 ** 3) return isolate(`${num(n / 1024 ** 3, 1)} GB`);
  if (n >= 1024 ** 2) return isolate(`${num(n / 1024 ** 2, 1)} MB`);
  return isolate(`${num(Math.round(n / 1024))} KB`);
}

function clock(ms) {
  const s = Math.floor(ms / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function ago(ts) {
  if (!ts) return t('never');
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return t('justNow');
  if (m < 60) return t('minAgo', { n: num(m) });
  if (m < 48 * 60) return t('hAgo', { n: num(Math.floor(m / 60)) });
  return t('dAgo', { n: num(Math.floor(m / 1440)) });
}

let toastTimer = 0;
/** One line on the Logs page (source "Best"): what the user was told, and quiet background work. */
function logApp(level, text) {
  call('logs.add', { level, text: String(text || '').slice(0, 400) }).catch(() => {});
}

function showToast(text, err = false) {
  if (text !== t('copied')) logApp(err ? 'error' : 'info', text);
  S.toast = { text, err };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { S.toast = null; render(); }, 2600);
  render();
}

function openSheet(sheet) { S.sheet = sheet; render(); }
function closeSheet() { S.sheet = null; render(); }

// ------------------------------------------------------------------ connection

async function connect() {
  const server = selectedServer() || visibleServers()[0];
  if (!server) return showToast(t('selectFirst'), true);
  S.ui.selected = server.id;
  save('ui');
  let built;
  try {
    const loopbackPort = Core.xray.needsLoopback(server) ? 20000 + Math.floor(Math.random() * 30000) : 0;
    const ctx = { servers: S.servers, subs: S.subs };
    const ips = await serverIps(server);
    built = Core.android.buildSession(server, S.settings, S.routing, {
      loopbackPort, country: phoneRegion(), ips, ctx, sdk: Number(S.info.sdk) || 0,
      mode: S.ui.mode, mtu: S.ui.vpnMtu, fakeDns: S.ui.fakeDns, preferIpv6: S.ui.preferIpv6, ext: S.geoExt,
    });
  } catch (e) {
    return showToast(errText(e.code || 'FAILED'), true);
  }
  try {
    await call('vpn.start', {
      config: JSON.stringify(built.xray),
      singbox: built.singbox ? JSON.stringify(built.singbox) : null,
      name: nameOf(server),
      appMode: S.ui.apps.length ? S.ui.appMode : 'all',
      apps: S.ui.apps,
      ipv6: Boolean(S.settings.tunIpv6),
      logAccess: Boolean(S.ui.logConnections),
      mode: S.ui.mode,
      mtu: S.ui.vpnMtu,
      text: { connected: t('connected'), connecting: t('connecting'), disconnect: t('disconnect') },
    });
  } catch (e) {
    showToast(errText(e.code), true);
  }
}

/** For configs sing-box opens: their server names, looked up by Android (see NativeBridge.resolve). */
async function serverIps(server) {
  const ctx = { servers: S.servers, subs: S.subs };
  if (!Core.android.needsSingBox(server, S.settings, ctx)) return {};
  const names = Core.android.serverNames(server, S.settings, ctx);
  if (!names.length) return {};
  try { return (await call('net.resolve', { names })) || {}; } catch { return {}; }
}

function toggleConnect() {
  const p = S.vpn.phase;
  if (p === 'stopping') return; // still disconnecting: the next tap connects
  if (p === 'connected' || p === 'connecting') call('vpn.stop').catch(() => {});
  else connect();
}

function select(id) {
  if (S.ui.selected === id) return;
  S.ui.selected = id;
  save('ui');
  render();
  // Switching configs while connected moves the connection to the new one.
  if (S.vpn.phase === 'connected') connect();
}

/**
 * Tests the configs of the current list, all from Best directly (it is outside the VPN), so a
 * running connection is not disturbed:
 *  - "real":  an HTTP request through each config (what using it feels like)
 *  - "tcp":   only how fast the server's port answers (quick; says nothing about the proxy)
 *  - "udp":   one NTP question over UDP through the config (calls, games, QUIC)
 *  - "speed": a download through each config, one after another (they share the bandwidth)
 */
async function testAll(kind = 'real', only = null) {
  if (S.testing) return;
  const speed = kind === 'speed';
  const results = speed ? S.speeds : S.delays;
  const list = only || visibleServers();
  if (!list.length) return;
  S.ui.metric = speed ? 'speed' : 'delay';
  save('ui');
  for (const s of list) results[s.id] = 'test';
  const run = { kind, done: 0, n: list.length, stop: false };
  S.testing = run;
  render();
  const queue = [...list];
  const one = async (s) => {
    if (kind === 'tcp') {
      const r = await call('net.tcping', { host: s.address, port: Number(s.port), timeout: S.settings.testTimeout });
      return r && r.ms >= 0 ? Math.max(1, r.ms) : 'fail';
    }
    let built;
    try {
      built = Core.android.buildTestConfig(s, S.settings, await serverIps(s), { servers: S.servers, subs: S.subs });
    } catch (e) {
      if (e.code === 'SKIP') return undefined; // groups: their members are measured instead
      throw e;
    }
    const config = JSON.stringify(built.config);
    const core = built.core;
    if (speed) {
      const r = await call('probe.speed', { config, core, url: S.settings.speedTestUrl, seconds: 6 });
      return r && r.mbps > 0 ? r.mbps : 'fail';
    }
    if (kind === 'udp') {
      const r = await call('probe.udp', { config, core, target: S.settings.udpTestTarget, timeout: S.settings.testTimeout });
      return r && r.ms > 0 ? r.ms : 'fail';
    }
    const r = await call('core.delay', { config, core, url: S.settings.testUrl, timeout: S.settings.testTimeout });
    return r && r.ms > 0 ? r.ms : 'fail';
  };
  const worker = async () => {
    for (let s = queue.shift(); s && !run.stop; s = queue.shift()) {
      try {
        const v = await one(s);
        if (v === undefined) delete results[s.id]; else results[s.id] = v;
      } catch { results[s.id] = 'fail'; }
      run.done++;
      render();
    }
  };
  const width = { tcp: 12, real: Math.max(1, Math.min(32, Number(S.settings.testConcurrency) || 6)), udp: 3, speed: 1 }[kind] || 4;
  await Promise.all(Array.from({ length: Math.min(width, list.length) }, worker));
  // Stopped: configs that were not reached lose their spinner.
  for (const s of list) if (results[s.id] === 'test') delete results[s.id];
  if (S.testing === run) S.testing = null;
  render();
}

/** Configs of the list whose last test failed are removed (a subscription's return with its next update). */
function deleteFailed(list = visibleServers(), quiet = false) {
  const map = S.ui.metric === 'speed' ? S.speeds : S.delays;
  const ids = new Set(list.filter((s) => map[s.id] === 'fail').map((s) => s.id));
  if (!ids.size) { if (!quiet) showToast(t('nothingToDelete')); return 0; }
  S.servers = S.servers.filter((s) => !ids.has(s.id));
  if (ids.has(S.ui.selected)) S.ui.selected = '';
  for (const id of ids) { delete S.delays[id]; delete S.speeds[id]; }
  save('servers');
  save('ui');
  showToast(t('deletedN', { n: num(ids.size) }));
  return ids.size;
}

/** The same server (same connection details) kept once in the list. */
function deleteDuplicates() {
  const seen = new Set();
  const drop = new Set();
  for (const s of visibleServers()) {
    let k = '';
    try { k = Core.links.serverKey(s); } catch { continue; }
    if (seen.has(k)) drop.add(s.id); else seen.add(k);
  }
  if (!drop.size) return showToast(t('nothingToDelete'));
  S.servers = S.servers.filter((s) => !drop.has(s.id));
  if (drop.has(S.ui.selected)) S.ui.selected = '';
  save('servers');
  save('ui');
  showToast(t('deletedN', { n: num(drop.size) }));
}

async function copyAllLinks() {
  const links = [];
  for (const s of visibleServers()) { try { links.push(Core.links.toLink(s)); } catch { /* groups / JSON have no link */ } }
  if (!links.length) return showToast(t('nothingFound'), true);
  await call('clip.write', { text: links.join('\n'), sensitive: true }).catch(() => {});
  showToast(t('copiedN', { n: num(links.length) }));
}

/** After a subscription update: test its configs (and drop the failed ones) when the user asked for it. */
async function afterSubUpdate(sub) {
  if (!S.ui.autoTest) return;
  const list = S.servers.filter((s) => s.subId === sub.id);
  await testAll('real', list);
  if (S.ui.autoDelete) deleteFailed(list, true);
}

function stopTests() {
  if (!S.testing) return;
  S.testing.stop = true;
  if (S.testing.kind === 'speed') call('probe.cancel').catch(() => {});
  render();
}

function useFastest() {
  const speed = S.ui.metric === 'speed';
  const map = speed ? S.speeds : S.delays;
  const best = visibleServers().filter((s) => typeof map[s.id] === 'number').sort((a, b) => (speed ? map[b.id] - map[a.id] : map[a.id] - map[b.id]))[0];
  closeSheet();
  if (best) select(best.id);
}

// ------------------------------------------------------------------ adding configs

/** Text from the clipboard or "Share → Best": share links, a subscription body, or a subscription URL. */
async function importText(text) {
  const raw = String(text || '').trim();
  if (!raw) return showToast(t('clipboardEmpty'), true);
  if (/^https?:\/\/\S+$/i.test(raw)) return openSheet({ type: 'addSub', url: raw, name: '' });
  const parsed = Core.subscription.parseContent(raw);
  const { servers } = Core.subscription.splitInfoNodes(parsed.servers || []);
  const keys = new Set(S.servers.map(Core.links.serverKey));
  const fresh = servers.filter((s) => !keys.has(Core.links.serverKey(s))).slice(0, MAX_SERVERS - S.servers.length);
  if (!fresh.length) return showToast(servers.length ? t('alreadyAdded') : t('nothingFound'), !servers.length);
  S.servers.push(...fresh);
  if (!selectedServer()) S.ui.selected = fresh[0].id;
  S.sheet = null;
  save('servers');
  save('ui');
  showToast(fresh.length === 1 ? t('added1') : t('addedN', { n: num(fresh.length) }));
}

/**
 * Text another app shared with Best: any app can send it, so nothing is added before the user
 * says yes (the same question as a best:// link). A subscription link opens "Add subscription".
 */
function askShared(text) {
  const raw = String(text || '').trim().slice(0, 200000);
  if (!raw) return;
  S.page = 'configs';
  if (/^https?:\/\/\S+$/i.test(raw)) return openSheet({ type: 'addSub', url: raw, name: '' });
  const parsed = Core.subscription.parseContent(raw);
  const { servers } = Core.subscription.splitInfoNodes(parsed.servers || []);
  if (servers.length) openSheet({ type: 'linkImport', text: raw, names: servers.slice(0, 8).map(nameOf), n: servers.length });
  else showToast(t('nothingFound'), true);
}

/** How many config links (vless://, vmess://, JSON…) a text holds; the last text is remembered (drawn every second while connected). */
let linksMemo = { text: null, n: 0 };
function countLinks(text) {
  if (linksMemo.text !== text) {
    let n = 0;
    try { n = Core.subscription.splitInfoNodes(Core.subscription.parseContent(text).servers || []).servers.length; } catch { n = 0; }
    linksMemo = { text, n };
  }
  return linksMemo.n;
}

async function fromClipboard() {
  try { await importText(await call('clip.read')); } catch (e) { showToast(errText(e.code), true); }
}

/** Camera, a photo or a file: whatever text comes back is added like clipboard text. */
async function fromPicker(method) {
  closeSheet();
  try {
    const args = method === 'pick.scan' ? { hint: t('scanHint'), torch: t('torch'), close: t('close') } : {};
    const text = await call(method, args);
    if (text) await importText(text);
  } catch (e) {
    showToast(errText(e.code), true);
  }
}

async function downloadSub(sub) {
  S.busy[sub.id] = true;
  render();
  try {
    const ua = sub.userAgent || S.settings.subUserAgent || '';
    const direct = !S.settings.subViaProxy;
    // Panels that limit devices (Remnawave …) get a device id; the native side makes it per panel.
    const hwid = S.settings.subHwid !== false;
    const deviceName = String(S.settings.subHwidName || '');
    const res = await call('net.fetch', { url: sub.url, userAgent: ua, direct, hwid, deviceName });
    let all = Core.subscription.parseContent(res.body, { subId: sub.id }).servers || [];
    // Extra links of the same subscription: their configs join this list.
    for (const extra of sub.moreUrls || []) {
      try {
        const more = await call('net.fetch', { url: extra, userAgent: ua, direct, hwid, deviceName });
        all = all.concat(Core.subscription.parseContent(more.body, { subId: sub.id }).servers || []);
      } catch { /* one link failing doesn't stop the others */ }
    }
    const split = Core.subscription.splitInfoNodes(all);
    // Name filters: keep only matching names, then drop excluded ones; the same config once.
    const keep = validRegex(sub.filter) ? new RegExp(sub.filter, 'iu') : null;
    const drop = validRegex(sub.exclude) ? new RegExp(sub.exclude, 'iu') : null;
    const seen = new Set();
    const servers = (split.servers || []).filter((s) => {
      const name = (s.remark || '').slice(0, 120);
      if ((keep && !keep.test(name)) || (drop && drop.test(name))) return false;
      const k = Core.links.serverKey(s);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if ((split.servers || []).length && !servers.length && (keep || drop)) throw Object.assign(new Error('FILTER_EMPTY'), { code: 'FILTER_EMPTY' });
    sub.info = Core.subscription.parseUserInfo(res.userInfo || '');
    // What the panel says about itself: support / web page links, announcement, info entries.
    sub.supportUrl = httpUrl(res.supportUrl).slice(0, 500);
    sub.webPageUrl = httpUrl(res.webPageUrl).slice(0, 500);
    sub.announce = Core.util.cleanText(res.announce ? decodeTitle(res.announce) : '', 500);
    sub.infoNodes = (split.info || []).map((n) => Core.util.cleanText(String(n || ''), 120)).filter(Boolean).slice(0, 5);
    // Expired / out of data: panels then send only info entries. The old configs stay, the
    // panel's message is shown.
    const info = split.info || [];
    if (!servers.length && info.length) {
      sub.notice = info.slice(0, 3).join(' · ').slice(0, 300);
      sub.updatedAt = Date.now();
      save('subs');
      return S.servers.filter((s) => s.subId === sub.id).length;
    }
    if (!servers.length) {
      // An empty answer with the panel's device-limit flag: say that, not "empty".
      const code = res.device === 'limit' ? 'HWID_LIMIT' : res.device === 'required' ? 'HWID_REQUIRED' : 'EMPTY';
      throw Object.assign(new Error(code), { code });
    }
    sub.notice = '';
    // Keep the selection on the same config after an update (same connection details).
    const old = S.servers.find((s) => s.id === S.ui.selected && s.subId === sub.id);
    // Test results move over to the same configs (same connection details) in the new list.
    const prevDelay = new Map(S.servers.filter((s) => s.subId === sub.id && S.delays[s.id] !== undefined).map((s) => [Core.links.serverKey(s), S.delays[s.id]]));
    for (const s of servers) { const d = prevDelay.get(Core.links.serverKey(s)); if (d !== undefined && d !== 'test') S.delays[s.id] = d; }
    const kept = S.servers.filter((s) => s.subId !== sub.id);
    S.servers = [...kept, ...servers].slice(0, MAX_SERVERS);
    if (old) {
      const same = servers.find((s) => Core.links.serverKey(s) === Core.links.serverKey(old));
      if (same) S.ui.selected = same.id;
    }
    if (!selectedServer()) S.ui.selected = servers[0].id;
    sub.updatedAt = Date.now();
    if ((sub.autoName || !sub.name) && res.title) {
      const title = Core.util.cleanText(decodeTitle(res.title), 60);
      if (title) { sub.name = title; sub.autoName = true; }
    }
    save('servers');
    save('subs');
    save('ui');
    return servers.length;
  } finally {
    delete S.busy[sub.id];
    render();
  }
}

/** profile-title may be "base64:…". */
function decodeTitle(v) {
  const m = /^base64:(.+)$/i.exec(String(v));
  if (!m) return String(v);
  try { return new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0))); } catch { return ''; }
}

async function addSub(url, name) {
  const sub = cleanSubs([{ id: Core.util.randomId(), name: Core.util.cleanText(name || '', 60), url: url.trim() }])[0];
  if (!sub) return showToast(errText('BAD_URL'), true);
  S.subs.push(sub);
  try {
    const n = await downloadSub(sub);
    S.sheet = null;
    S.page = 'configs';
    S.ui.tab = sub.id;
    save('ui');
    showToast(t('addedN', { n: num(n) }));
  } catch (e) {
    S.subs = S.subs.filter((x) => x !== sub);
    showToast(errText(e.code), true);
  }
}

async function updateSub(sub) {
  try {
    const n = await downloadSub(sub);
    showToast(t('addedN', { n: num(n) }));
    afterSubUpdate(sub);
  } catch (e) {
    showToast(errText(e.code), true);
  }
}

/** Updates the subscriptions behind the current list (every subscription on "All"). */
/** The subscriptions the list on screen comes from ("Manual" and an empty list: none). */
const subsOfTab = () => (S.ui.tab === 'all' ? S.subs : S.subs.filter((x) => x.id === S.ui.tab)).filter((x) => x.enabled !== false);

async function refreshSubs() {
  const subs = subsOfTab();
  if (!subs.length) return showToast(t('noSubHere'), true);
  S.refreshing = true;
  render();
  let failed = null;
  const done = [];
  for (const sub of subs) {
    try { await downloadSub(sub); done.push(sub); } catch (e) { failed = e; }
  }
  S.refreshing = false;
  showToast(failed ? errText(failed.code) : t('subsUpdated'), Boolean(failed));
  for (const sub of done) await afterSubUpdate(sub);
}

/** Subscriptions older than the chosen interval are updated quietly (on start, then hourly). */
async function autoUpdateSubs() {
  const hours = Number(S.settings.subAutoUpdateHours) || 0;
  if (!hours || S.refreshing) return;
  for (const sub of S.subs.filter((x) => x.enabled !== false && Date.now() - (x.updatedAt || 0) > (x.autoUpdateHours || hours) * 3600000)) {
    try {
      await downloadSub(sub);
      logApp('info', `${sub.name || t('subLink')}: ${t('subsUpdated')}`);
      await afterSubUpdate(sub);
    } catch (e) { logApp('warning', `${sub.name || t('subLink')}: ${errText(e.code)}`); /* tried again next hour */ }
  }
}

// Pull the list down (when it is at the top) to update that subscription. Only in one
// subscription's own tab (not "All", not "Manual"), and only after a long, deliberate pull:
// the finger has to travel about 230 px, and nothing happens when it goes back up before letting go.
const PULL_GO = 96;
let pullFrom = null;
function pullStart(e) {
  const ownTab = S.ui.tab !== 'all' && S.ui.tab !== 'manual' && subsOfTab().length > 0;
  pullFrom = e.currentTarget.scrollTop <= 0 && !S.refreshing && !S.sheet && ownTab ? e.touches[0].clientY : null;
}
function pullMove(e) {
  if (pullFrom === null) return;
  const d = Math.round(Math.max(0, Math.min(300, e.touches[0].clientY - pullFrom)) * 0.42);
  if (d !== S.pull) { S.pull = d; render(); }
}
function pullEnd() {
  if (pullFrom === null) return;
  pullFrom = null;
  const go = S.pull >= PULL_GO;
  S.pull = 0;
  render();
  if (go) refreshSubs();
}

function saveSubEdit(sub, d) {
  const next = cleanSubs([{ ...sub, ...d, name: d.name, autoName: !String(d.name || '').trim(), moreUrls: String(d.moreUrls || '') }])[0];
  if (!next || !httpUrl(d.url)) return showToast(errText('BAD_URL'), true);
  if ((String(d.filter || '').trim() && !next.filter) || (String(d.exclude || '').trim() && !next.exclude)) return showToast(t('invalidValue'), true);
  const changed = ['url', 'filter', 'exclude', 'userAgent'].some((k) => String(next[k] || '') !== String(sub[k] || '')) || next.moreUrls.join() !== (sub.moreUrls || []).join();
  Object.assign(sub, next, { id: sub.id, info: sub.info, updatedAt: sub.updatedAt });
  save('subs');
  closeSheet();
  if (sub.via !== next.via) applyToConnection();
  if (changed && sub.enabled !== false) updateSub(sub); else applyToConnection();
}

function removeSub(sub) {
  S.subs = S.subs.filter((x) => x.id !== sub.id);
  S.servers = S.servers.filter((s) => s.subId !== sub.id);
  if (S.ui.tab === sub.id) S.ui.tab = 'all';
  save('subs');
  save('servers');
  save('ui');
  closeSheet();
}

function removeServer(id) {
  S.servers = S.servers.filter((s) => s.id !== id);
  if (S.ui.selected === id) S.ui.selected = '';
  delete S.delays[id];
  delete S.speeds[id];
  save('servers');
  save('ui');
  closeSheet();
}

// ------------------------------------------------------------------ views

function glass(tag, cls, props, ...children) {
  return h(tag, { ...(props || {}), class: `glass ${cls}` }, ...children);
}

function navBar() {
  const items = [['configs', 'servers', t('configs')], ['subs', 'subs', t('subs')], ['routing', 'routing', t('routing')], ['updates', 'download', t('updates')], ['settings', 'settings', t('settings')]];
  return glass('nav', 'nav', null, items.map(([id, ic, label]) => h('button', {
    class: S.page === id ? 'on' : '', 'aria-label': label, 'data-key': id,
    onClick: () => { S.page = id; S.sheet = null; if (id === 'updates') updates.geoInfo(); if (id === 'settings' && S.settings.allowLan) refreshLanIp(); render(); },
  }, icon(ic, 21, 1.8), label, id === 'updates' && updates.hasNews() ? h('i', { class: 'badge' }) : null)));
}

function sparkline() {
  const pts = S.spark.length ? S.spark : [0];
  const max = Math.max(...pts, 1);
  const w = 326;
  const step = w / (SPARK_POINTS - 1);
  const off = SPARK_POINTS - pts.length;
  const xy = pts.map((v, i) => `${((off + i) * step).toFixed(1)},${(36 - (v / max) * 30).toFixed(1)}`);
  const line = `M${xy.join(' L')}`;
  const area = `${line} L${w},40 L${(off * step).toFixed(1)},40 Z`;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('viewBox', `0 0 ${w} 40`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const grad = document.createElementNS(ns, 'linearGradient');
  grad.setAttribute('id', 'spk');
  grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0'); grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
  for (const [o, op] of [['0', '.35'], ['1', '0']]) {
    const st = document.createElementNS(ns, 'stop');
    st.setAttribute('offset', o);
    st.setAttribute('stop-color', 'var(--accent)');
    st.setAttribute('stop-opacity', op);
    grad.append(st);
  }
  const defs = document.createElementNS(ns, 'defs');
  defs.append(grad);
  const a = document.createElementNS(ns, 'path');
  a.setAttribute('d', area);
  a.setAttribute('fill', 'url(#spk)');
  const l = document.createElementNS(ns, 'path');
  l.setAttribute('d', line);
  l.setAttribute('fill', 'none');
  l.setAttribute('stroke', 'var(--accent)');
  l.setAttribute('stroke-width', '1.8');
  l.setAttribute('stroke-linejoin', 'round');
  l.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(defs, a, l);
  return svg;
}

function connCard() {
  const p = S.vpn.phase;
  const on = p === 'connected';
  const busy = p === 'connecting' || p === 'stopping';
  const server = selectedServer();
  const status = p === 'connecting' ? t('connecting') : p === 'stopping' ? t('disconnecting') : on ? t('connected') : t('notConnected');
  const name = on || busy ? (S.vpn.name || nameOf(server)) : (server ? nameOf(server) : t('noConfigs'));
  const exit = on && S.exit ? ` · ${t('exitAt', { ip: S.exit.ip, cc: S.exit.cc })}` : '';
  const detail = on ? `${clock(Date.now() - S.vpnSince)}${exit}` : server ? subOf(server) : t('noConfigsHint');
  const [down, downU] = rate(S.traffic.down);
  const [up, upU] = rate(S.traffic.up);
  return glass('section', 'conn', null,
    h('div', { class: 'conn-row' },
      h('button', { class: `power ${on ? 'on' : ''}`, 'aria-label': on ? t('disconnect') : t('connect'), onClick: toggleConnect },
        busy ? h('span', { class: 'spin' }, spinnerRing()) : null,
        icon('power', 24, 2)),
      h('div', { class: 'conn-text' },
        h('span', { class: `conn-status ${on ? 'on' : ''}` }, status),
        h('span', { class: 'conn-name' }, name),
        h('span', { class: `conn-detail ${on ? 'mono' : ''}` }, detail)),
      on ? h('div', { class: 'speeds mono' },
        h('span', { class: 'down ltr' }, `${down} `, h('small', null, `${downU} ↓`)),
        h('span', { class: 'up ltr' }, `${up} `, h('small', null, `${upU} ↑`))) : null),
    on ? sparkline() : null);
}

function spinnerRing() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 58 58');
  svg.setAttribute('width', '58');
  svg.setAttribute('height', '58');
  const c = document.createElementNS(ns, 'circle');
  for (const [k, v] of [['cx', 29], ['cy', 29], ['r', 26], ['fill', 'none'], ['stroke', 'var(--accent)'], ['stroke-width', 2.5], ['stroke-linecap', 'round'], ['stroke-dasharray', '40 124']]) c.setAttribute(k, v);
  svg.append(c);
  return svg;
}

function tabs() {
  const manual = S.servers.filter((s) => !s.subId).length;
  const items = [['all', t('all'), shownServers().length]];
  // "Manual" only while there is a config added by hand; it comes back with the first one.
  if (manual) items.push(['manual', t('manual'), manual]);
  for (const sub of S.subs.filter(subShown)) items.push([sub.id, sub.name || t('subLink'), S.servers.filter((s) => s.subId === sub.id).length]);
  if (!items.some(([id]) => id === S.ui.tab)) S.ui.tab = 'all';
  // Each tab as wide as its name (no "moha @…"); the row scrolls sideways when they don't all fit.
  // The capsule stays still; only its inside scrolls, so its rounded edge is never cut.
  return glass('div', 'seg sm tabs-wrap', { 'data-key': 'tabs' },
    h('div', { class: 'tabs-scroll' },
      items.map(([id, label, count]) => h('button', {
        class: S.ui.tab === id ? 'on' : '', 'data-key': id,
        onClick: () => { S.ui.tab = id; save('ui'); render(); },
      }, h('b', { dir: 'auto' }, label), h('span', null, num(count))))));
}

function delayCell(s) {
  if (S.ui.metric === 'speed') {
    const v = S.speeds[s.id];
    if (v === 'test') return h('span', { class: 'delay mono' }, h('span', { class: 'mini-spin' }));
    if (v === 'fail') return h('span', { class: 'delay mono' }, h('span', { class: 'dot bad' }), t('fail'));
    if (typeof v === 'number') return h('span', { class: 'delay mono ltr' }, h('span', { class: `dot ${v >= 1 ? '' : 'fair'}` }), `${num(v, v < 10 ? 2 : 1)} MB/s`);
    return h('span', { class: 'delay' });
  }
  const d = S.delays[s.id];
  if (d === 'test') return h('span', { class: 'delay mono' }, h('span', { class: 'mini-spin' }));
  if (d === 'fail') return h('span', { class: 'delay mono' }, h('span', { class: 'dot bad' }), t('fail'));
  if (typeof d === 'number') return h('span', { class: 'delay mono ltr' }, h('span', { class: `dot ${d < 250 ? '' : 'fair'}` }), `${num(d)} ms`);
  return h('span', { class: 'delay' });
}

function viewConfigs() {
  const list = visibleServers();
  const idx = list.findIndex((s) => s.id === S.ui.selected);
  // Two columns (Settings › Config list): small cards, the chosen one lit; the list keeps its sliding puck.
  const grid = S.ui.listView === 'grid';
  const rows = list.map((s) => h('button', {
    class: `row ${grid && s.id === S.ui.selected ? 'on' : ''}`, 'data-key': s.id,
    onClick: () => select(s.id),
    onContextmenu: (e) => { e.preventDefault(); openSheet({ type: 'row', id: s.id }); },
  },
  grid
    ? [h('span', { class: 'row-name' }, nameOf(s)), h('span', { class: 'row-foot' }, h('span', { class: 'row-tag mono' }, shortProto(s)), delayCell(s))]
    : [h('span', { class: 'row-main' },
      h('span', { class: 'row-name' }, nameOf(s)),
      h('span', { class: 'row-sub' }, subOf(s))),
    delayCell(s)]));
  const showPull = S.pull > 0 || S.refreshing;
  return h('div', { class: 'configs', 'data-key': 'configs' },
    // One pill in the gap above the list (the list moves down with the finger): icon, and what
    // letting go would do, so the text never lies over the configs.
    showPull ? h('div', { class: 'pull', 'data-key': 'pull' },
      glass('span', `pull-pill ${S.refreshing ? 'spin' : ''} ${!S.refreshing && S.pull >= PULL_GO ? 'go' : ''}`, {
        role: 'status',
        style: { transform: `translateY(${S.refreshing ? 6 : Math.max(0, S.pull - 46)}px)`, opacity: String(S.refreshing ? 1 : Math.max(0, Math.min(1, (S.pull - 30) / 16))) }, // shown once the gap fits it
      },
      h('span', { class: 'pull-icon', style: { transform: `rotate(${S.refreshing ? 0 : S.pull * 4}deg)` } }, icon('refresh', 17, 2)),
      h('span', null, S.refreshing ? t('updating') : S.pull >= PULL_GO ? t('pullUpdate') : t('pulling')))) : null,
    h('div', { class: 'list-scroll', onTouchstart: pullStart, onTouchmove: pullMove, onTouchend: pullEnd, onTouchcancel: pullEnd },
      list.length
        ? h('div', { class: `list ${grid ? 'grid' : ''}`, style: { transform: `translateY(${S.refreshing ? 52 : S.pull}px)`, transition: S.pull ? 'none' : 'transform .3s' } },
          grid ? null : h('span', { class: 'puck', style: { transform: `translateY(${Math.max(idx, 0) * 64}px)`, opacity: idx < 0 ? '0' : '1' } }),
          rows)
        : S.searching && S.query.trim()
          ? h('div', { class: 'empty' }, h('span', { class: 'empty-icon' }, icon('search', 28, 1.7)), h('b', null, t('noResults')))
          : h('div', { class: 'empty' },
            h('span', { class: 'empty-icon' }, icon('servers', 28, 1.7)),
            h('b', null, t('noConfigs')),
            h('span', null, t('noConfigsHint')))),
    h('div', { class: 'configs-top' },
      S.searching
        ? h('header', { class: 'brand', 'data-key': 'search' },
          glass('label', 'searchbox sm', null,
            icon('search', 18, 2),
            h('input', {
              type: 'search', placeholder: t('searchConfigs'), autocomplete: 'off', spellcheck: 'false', value: S.query, 'data-key': 'q', enterkeyhint: 'search',
              onInput: (e) => { S.query = e.target.value; render(); },
            })),
          glass('button', 'round-btn sm plain', { 'aria-label': t('close'), onClick: closeSearch }, icon('close', 19, 2)))
        : h('header', { class: 'brand', 'data-key': 'brand' },
          h('span', { class: 'logo rim' }, 'b'),
          h('span', { class: 'brand-name' }, 'Best'),
          glass('div', 'capsule sm', null,
            h('button', { class: 'icon-btn', 'aria-label': t('search'), onClick: openSearch }, icon('search', 20, 1.9)),
            h('button', { class: 'icon-btn', 'aria-label': t('add'), onClick: () => openSheet({ type: 'add' }) }, icon('plus', 21, 1.8)))),
      S.searching ? null : connCard(),
      h('div', { class: 'toolbar' },
        tabs(),
        S.testing
          ? glass('button', 'round-btn sm stop', { 'aria-label': t('stopTests'), onClick: stopTests },
            h('span', { class: 'ring-spin' }), icon('close', 16, 2.4))
          : glass('button', 'round-btn sm', { 'aria-label': t('testTitle'), onClick: () => openSheet({ type: 'test' }) }, icon('bolt', 19, 1.8))),
      S.searching ? null : subStrip()));
}

/** Traffic and time of a subscription, as the strip and the details sheet show them. */
function subUsage(sub) {
  const info = sub.info || {};
  const used = (info.upload || 0) + (info.download || 0);
  const pct = info.total ? Math.min(1, used / info.total) : 0;
  const days = info.expire ? Math.ceil((info.expire * 1000 - Date.now()) / 86400000) : null;
  const warn = pct > 0.85 || (days !== null && days < 7);
  const amount = t('usedOf', { used: bytes(used), total: info.total ? bytes(info.total) : '∞' });
  const time = days === null ? t('noExpiry') : days > 0 ? t('daysLeft', { n: num(days) }) : t('expired');
  return { info, used, pct, days, warn, amount, time };
}

/** One line under the tabs of a subscription's own tab: traffic, time left; tap for the details. */
function subStrip() {
  const sub = S.subs.find((x) => x.id === S.ui.tab);
  if (!sub) return null;
  const u = subUsage(sub);
  return h('button', { class: 'sub-strip', 'data-key': 'sub-strip', 'aria-label': t('subDetails'), onClick: () => openSheet({ type: 'subInfo', id: sub.id }) },
    h('span', { class: `usage-bar ${u.info.total ? '' : 'unlimited'} ${u.warn ? 'warn' : ''}` }, h('span', { style: { width: `${u.info.total ? Math.max(2, u.pct * 100) : 100}%` } })),
    h('span', { class: 'sub-strip-text ltr-num' }, `${u.amount} · `, h('span', { style: u.warn ? { color: 'var(--fair)' } : null }, u.time)),
    sub.announce || sub.supportUrl || sub.webPageUrl || (sub.infoNodes || []).length ? h('span', { class: 'sub-strip-more' }, icon('info', 16, 1.9)) : icon('chevron', 16, 1.9));
}

function openSearch() {
  S.searching = true;
  render();
  requestAnimationFrame(() => { const el = root.querySelector('.searchbox input'); if (el) el.focus(); });
}

function closeSearch() {
  S.searching = false;
  S.query = '';
  if (document.activeElement) document.activeElement.blur();
  render();
}

function viewSubs() {
  const cards = S.subs.map((sub) => {
    const info = sub.info || {};
    const used = (info.upload || 0) + (info.download || 0);
    const pct = info.total ? Math.min(1, used / info.total) : 0;
    const days = info.expire ? Math.ceil((info.expire * 1000 - Date.now()) / 86400000) : null;
    const warn = pct > 0.85 || (days !== null && days < 7);
    const count = S.servers.filter((s) => s.subId === sub.id).length;
    const C = 2 * Math.PI * 23;
    return glass('article', `card ${subShown(sub) ? '' : 'sub-off'}`, { 'data-key': sub.id, onClick: (e) => { if (!e.target.closest('button')) openSheet({ type: 'subInfo', id: sub.id }); } },
      h('div', { class: 'conn-row' },
        info.total ? h('div', { class: 'ring' }, ringSvg(pct, warn, C), h('span', { class: 'mono' }, `${num(Math.round(pct * 100))}%`)) : null,
        h('div', { class: 'conn-text' },
          h('span', { class: 'conn-name' }, sub.name || t('subLink')),
          h('span', { class: 'conn-detail' }, t('usedOf', { used: bytes(used), total: info.total ? bytes(info.total) : '∞' })),
          h('span', { class: 'conn-detail', style: warn ? { color: 'var(--fair)' } : null }, days === null ? t('noExpiry') : days > 0 ? t('daysLeft', { n: num(days) }) : t('expired'))),
        h('span', { class: 'sub-actions' },
          h('button', { class: 'icon-btn sm', 'aria-label': t('update'), onClick: () => updateSub(sub), disabled: S.busy[sub.id] },
            S.busy[sub.id] ? h('span', { class: 'mini-spin' }) : icon('refresh', 17, 1.9)),
          h('button', { class: 'icon-btn sm', 'aria-label': t('edit'), onClick: () => openSheet({ type: 'editSub', id: sub.id, draft: { ...sub, moreUrls: (sub.moreUrls || []).join('\n') } }) }, icon('edit', 17, 1.9)),
          h('button', { class: 'icon-btn sm', 'aria-label': t('delete'), onClick: () => openSheet({ type: 'removeSub', id: sub.id }) }, icon('trash', 17, 1.9)))),
      h('div', { class: 'chips' },
        h('span', { class: 'chip' }, t('configsN', { n: num(count) })),
        h('span', { class: 'chip' }, t('subUpdated', { when: ago(sub.updatedAt) })),
        h('button', { class: 'sub-show', 'aria-label': t('subShow'), onClick: () => setSubShown(sub, !subShown(sub)) },
          h('span', null, t('subShow')), switchEl(subShown(sub)))),
      sub.notice ? h('div', { class: 'note warn' }, icon('info', 18, 1.9), h('span', null, sub.notice)) : null);
  });
  return h('div', { class: 'page', 'data-key': 'subs' },
    h('div', { class: 'title-row' },
      h('h1', null, t('subscriptions')),
      glass('div', 'capsule sm', null, h('button', { class: 'icon-btn', 'aria-label': t('subAdd'), onClick: () => openSheet({ type: 'addSub', url: '', name: '' }) }, icon('plus', 21, 1.8)))),
    cards.length ? cards : h('div', { class: 'empty' }, h('span', { class: 'empty-icon' }, icon('subs', 28, 1.7)), h('b', null, t('subEmpty'))));
}

function ringSvg(pct, warn, C) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '56'); svg.setAttribute('height', '56'); svg.setAttribute('viewBox', '0 0 56 56');
  const mk = (stroke, dash) => {
    const c = document.createElementNS(ns, 'circle');
    for (const [k, v] of [['cx', 28], ['cy', 28], ['r', 23], ['fill', 'none'], ['stroke', stroke], ['stroke-width', 5], ['stroke-linecap', 'round']]) c.setAttribute(k, v);
    if (dash) { c.setAttribute('stroke-dasharray', dash); c.setAttribute('transform', 'rotate(-90 28 28)'); }
    return c;
  };
  svg.append(mk('var(--track)'), mk(warn ? 'var(--fair)' : 'var(--accent)', `${(pct * C).toFixed(1)} ${C.toFixed(1)}`));
  return svg;
}

function switchEl(onState) {
  return h('span', { class: `switch ${onState ? 'on' : ''}`, role: 'switch', 'aria-checked': String(Boolean(onState)) });
}

function activeProfile(r = S.routing) {
  return r.profiles.find((p) => p.id === r.activeId) || r.profiles[0];
}

/** Changes routing through the shared sanitizer, saves it and applies it to a running connection. */
function setRouting(change) {
  const next = JSON.parse(JSON.stringify(S.routing));
  change(next);
  S.routing = Core.settings.sanitizeRouting(next);
  save('routing');
  render();
  applyToConnection();
}

const COUNTRIES = ['ir', 'ru', 'cn', 'tr', 'af', 'iq', 'ae', 'pk', 'in', 'by', 'kz', 'uz', 'ua', 'de', 'gb', 'us'];

function viewRouting() {
  const p = activeProfile();
  const cc = S.routing.country || phoneRegion();
  const modes = [
    ['p-global', 'globe', t('modeGlobal'), t('modeGlobalHint')],
    ['p-local', 'routing', t('modeLocal'), t('modeLocalHint', { country: countryName(cc) || '—' })],
    ['p-direct', 'power', t('modeDirect'), t('modeDirectHint')],
  ];
  const opt = (on, ic, label, hint, fn, key) => h('button', { class: `opt ${on ? 'on' : ''}`, onClick: fn, 'data-key': key },
    h('span', { class: 'opt-icon' }, icon(ic, 19, 1.8)),
    h('span', { class: 'item-main' }, h('span', null, label), hint ? h('small', null, hint) : null),
    h('span', { class: 'radio' }));
  const appModes = [['all', 'servers', t('appsAll')], ['include', 'check', t('appsInclude')], ['exclude', 'close', t('appsExclude')]];
  const target = (r) => [...r.domain, ...r.ip, ...r.port.map((x) => `:${x}`)].join(', ') || r.remark || '—';
  return h('div', { class: 'page', 'data-key': 'routing' },
    h('div', { class: 'title-row' }, h('h1', null, t('routing'))),
    h('div', { class: 'section-label' }, t('mode')),
    glass('div', 'group', { style: { padding: '6px' } },
      modes.map(([id, ic, label, hint]) => opt(S.routing.activeId === id, ic, label, hint, () => setRouting((r) => { r.activeId = id; }), id))),
    glass('div', 'group', { style: { marginTop: '10px' } },
      p.base === 'bypass-local' ? h('button', { class: 'item', onClick: () => openSheet({ type: 'country' }) },
        h('div', { class: 'item-main' }, t('myCountry')),
        h('span', { class: 'value' }, S.routing.country ? countryName(S.routing.country) : t('autoCountry', { country: countryName(cc) || '—' })),
        h('span', { style: { display: 'inline-flex', color: 'var(--text3)', transform: `rotate(${isRtl() ? 90 : -90}deg)` } }, icon('chevron', 16, 2))) : null,
      h('button', { class: 'item', onClick: () => setRouting((r) => { const x = activeProfile(r); x.blockAds = !x.blockAds; }) },
        h('div', { class: 'item-main' }, t('blockAds')), switchEl(p.blockAds))),
    h('div', { class: 'section-label' }, t('appsTitle')),
    glass('div', 'group', { style: { padding: '6px' } },
      appModes.map(([id, ic, label]) => opt(S.ui.appMode === id, ic, label, '', () => { S.ui.appMode = id; save('ui'); render(); applyToConnection(); }, id)),
      S.ui.appMode !== 'all' ? h('button', { class: 'item', style: { borderTop: '0' }, onClick: () => openSheet({ type: 'apps', q: '' }) },
        h('div', { class: 'item-main', style: { color: 'var(--accent)' } }, t('chooseApps')),
        h('span', { class: 'value' }, S.ui.apps.length ? t('appsChosen', { n: num(S.ui.apps.length) }) : '')) : null),
    h('div', { class: 'section-label' }, t('myRules')),
    glass('div', 'group', null,
      p.rules.length ? p.rules.map((r) => h('div', { class: 'item', 'data-key': r.id },
        h('div', { class: 'item-main mono ltr', style: { fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, target(r)),
        h('span', { class: `tag ${r.outbound}` }, t({ proxy: 'outProxy', direct: 'outDirect', block: 'outBlock' }[r.outbound])),
        h('button', { class: 'icon-btn', 'aria-label': t('delete'), onClick: () => setRouting((x) => { const ap = activeProfile(x); ap.rules = ap.rules.filter((y) => y.id !== r.id); }) }, icon('trash', 17, 1.8))))
        : h('div', { class: 'item' }, h('div', { class: 'item-main' }, h('small', null, t('noRules')))),
      h('button', { class: 'item', onClick: () => openSheet({ type: 'rule', text: '', out: 'direct' }) },
        icon('plus', 19, 1.8), h('div', { class: 'item-main', style: { color: 'var(--accent)' } }, t('addRule')))));
}

function setApps(list) {
  S.ui.apps = [...new Set(list)].filter((p) => /^[A-Za-z][\w.]{1,254}$/.test(p)).slice(0, 500);
  save('ui');
  render();
  applyToConnection();
}

/** Apps made for Iran: an "ir." package, or a Persian name. */
function isIranianApp(a) {
  return /^ir\./.test(String(a.pkg)) || /[\u0600-\u06FF]/.test(String(a.label));
}

function toggleApp(pkg) {
  S.ui.apps = S.ui.apps.includes(pkg) ? S.ui.apps.filter((p) => p !== pkg) : [...S.ui.apps, pkg].slice(0, 500);
  save('ui');
  render();
  applyToConnection();
}

function addRuleFromSheet(sh) {
  const domain = [];
  const ip = [];
  for (const line of String(sh.text || '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean)) {
    if (/^(geoip:|[0-9a-fA-F:.]+(\/\d{1,3})?$)/.test(line) && /[.:]/.test(line)) ip.push(line); else domain.push(line);
  }
  const rule = Core.routing.sanitizeRule({ enabled: true, outbound: sh.out, domain, ip });
  if (!rule || (!rule.domain.length && !rule.ip.length)) return showToast(t('ruleBad'), true);
  setRouting((r) => { activeProfile(r).rules.push(rule); });
  closeSheet();
}

function chevron() {
  return h('span', { style: { display: 'inline-flex', color: 'var(--text3)', transform: `rotate(${isRtl() ? 90 : -90}deg)` } }, icon('chevron', 16, 2));
}

function setUi(patch) {
  Object.assign(S.ui, patch);
  save('ui');
  render();
}

/** LAN sharing always has a user name and a random password (made when it is first turned on). */
function toggleLan() {
  const on = !S.settings.allowLan;
  const patch = { allowLan: on };
  if (on && (!S.settings.lanUser || !S.settings.lanPass)) {
    patch.lanUser = 'best';
    patch.lanPass = Core.util.randomId() + Core.util.randomId();
  }
  S.settings = Core.settings.sanitizeSettings({ ...S.settings, ...patch });
  save('settings');
  if (on) refreshLanIp();
  render();
  applyToConnection();
}

async function refreshLanIp() {
  try { S.lanIp = await call('net.lanIp'); } catch { S.lanIp = null; }
  render();
}

function viewSettings() {
  const sw = (onState) => switchEl(onState);
  const setS = (patch) => {
    S.settings = Core.settings.sanitizeSettings({ ...S.settings, ...patch });
    save('settings');
    applyLook();
    render();
    if ('showExitIp' in patch && patch.showExitIp && S.vpn.phase === 'connected') checkExit();
  };
  return h('div', { class: 'page', 'data-key': 'settings' },
    h('div', { class: 'title-row' }, h('h1', null, t('settings'))),
    h('div', { class: 'section-label' }, t('appearance')),
    glass('div', 'group', null,
      h('div', { class: 'item' }, h('div', { class: 'item-main' }, t('language'))),
      h('div', { class: 'item', style: { borderTop: '0', paddingTop: '0' } },
        h('div', { class: 'pick' }, LANGS.map(([code, label]) => h('button', { class: S.settings.language === code ? 'on' : '', 'data-key': code, onClick: () => setS({ language: code }) }, label)))),
      h('div', { class: 'item' }, h('div', { class: 'item-main' }, t('theme')),
        h('div', { class: 'pick' }, [['dark', t('dark')], ['light', t('light')]].map(([v, label]) => h('button', { class: S.settings.theme === v ? 'on' : '', 'data-key': v, onClick: () => setS({ theme: v }) }, label)))),
      h('button', { class: 'item', onClick: () => { S.ui.glass = !S.ui.glass; save('ui'); applyLook(); render(); } },
        h('div', { class: 'item-main' }, t('glass'), h('small', null, t('glassHint'))), sw(S.ui.glass)),
      h('div', { class: 'item' }, h('div', { class: 'item-main' }, t('listLook'), h('small', null, t('listLookHint'))),
        h('div', { class: 'pick' }, [['list', t('listRows')], ['grid', t('listGrid')]].map(([v, label]) => h('button', {
          class: (S.ui.listView === 'grid' ? 'grid' : 'list') === v ? 'on' : '', 'data-key': `list-${v}`, onClick: () => { S.ui.listView = v; save('ui'); render(); },
        }, label))))),
    h('div', { class: 'section-label' }, t('connection')),
    glass('div', 'group', null,
      h('div', { class: 'item' }, h('div', { class: 'item-main' }, t('modeTitle'),
        h('small', null, S.ui.mode === 'proxy' ? t('modeProxyHint', { socks: S.settings.socksPort, http: S.settings.httpPort }) : t('modeVpnHint'))),
        h('div', { class: 'pick' }, [['vpn', t('modeVpn')], ['proxy', t('modeProxy')]].map(([v, label]) => h('button', {
          class: S.ui.mode === v ? 'on' : '', 'data-key': `mode-${v}`,
          onClick: () => { setUi({ mode: v }); applyToConnection(); },
        }, label)))),
      h('button', { class: 'item', onClick: () => setS({ tunIpv6: !S.settings.tunIpv6 }) },
        h('div', { class: 'item-main' }, t('ipv6'), h('small', null, t('ipv6Hint'))), sw(S.settings.tunIpv6)),
      h('button', { class: 'item', onClick: () => setUi({ bootConnect: !S.ui.bootConnect }) },
        h('div', { class: 'item-main' }, t('bootConnect'), h('small', null, t('bootConnectHint'))), sw(S.ui.bootConnect)),
      h('button', { class: 'item', onClick: () => setS({ showExitIp: !S.settings.showExitIp }) },
        h('div', { class: 'item-main' }, t('showExitIp'), h('small', null, t('showExitIpHint'))), sw(S.settings.showExitIp)),
      h('button', { class: 'item', onClick: toggleLan },
        h('div', { class: 'item-main' }, t('lanShare'), h('small', null, t('lanShareHint'))), sw(S.settings.allowLan)),
      S.settings.allowLan ? h('div', { class: 'item' },
        h('div', { class: 'item-main' },
          h('span', { class: 'ltr mono', style: { fontSize: '13px', textAlign: 'start' } }, S.lanIp ? t('lanInfo', { ip: S.lanIp, socks: S.settings.lanSocksPort, http: S.settings.lanHttpPort }) : t('lanNoWifi')),
          h('small', { class: 'ltr mono', style: { textAlign: 'start' } }, `${t('lanUser')}: ${S.settings.lanUser}   ${t('lanPass')}: ${S.settings.lanPass}`)),
        h('button', { class: 'icon-btn', 'aria-label': t('copyLink'), onClick: async () => { await call('clip.write', { text: `${S.settings.lanUser}:${S.settings.lanPass}`, sensitive: true }).catch(() => {}); showToast(t('copied')); } }, icon('copy', 18, 1.9))) : null,
      h('button', { class: 'item', onClick: () => setUi({ allowTasker: !S.ui.allowTasker }) },
        h('div', { class: 'item-main' }, t('allowTasker'), h('small', null, t('allowTaskerHint'))), sw(S.ui.allowTasker)),
      h('div', { class: 'item' }, h('div', { class: 'item-main' }, t('autoUpdate'))),
      h('div', { class: 'item', style: { borderTop: '0', paddingTop: '0' } },
        h('div', { class: 'pick even' }, [0, 6, 12, 24].map((n) => h('button', {
          class: Number(S.settings.subAutoUpdateHours) === n ? 'on' : '', 'data-key': `au${n}`,
          onClick: () => { setS({ subAutoUpdateHours: n }); autoUpdateSubs(); },
        }, n ? t('hoursShort', { n: num(n) }) : t('off')))))),
    glass('div', 'group', { style: { marginTop: '10px' } },
      h('button', { class: 'item', onClick: () => { S.page = 'advanced'; render(); } }, icon('settings', 19, 1.8),
        h('div', { class: 'item-main' }, t('adv'), h('small', null, t('advHint'))), chevron()),
      h('button', { class: 'item', onClick: () => { S.page = 'logs'; more.startLogs(); render(); } }, icon('info', 19, 1.8),
        h('div', { class: 'item-main' }, t('logs'), h('small', null, t('logsHint'))), chevron())),
    h('div', { class: 'section-label' }, t('backupTitle')),
    glass('div', 'group', null,
      h('button', { class: 'item', onClick: () => more.exportSheet('file') }, icon('upload', 19, 1.8),
        h('div', { class: 'item-main' }, t('backupExport'), h('small', null, t('backupExportHint')))),
      h('button', { class: 'item', onClick: () => more.importFile() }, icon('download', 19, 1.8),
        h('div', { class: 'item-main' }, t('backupImport'), h('small', null, t('backupImportHint')))),
      h('button', { class: 'item', onClick: () => { S.page = 'webdav'; render(); } }, icon('folder', 19, 1.8),
        h('div', { class: 'item-main' }, t('webdav'), h('small', null, t('webdavHint'))), chevron())),
    h('div', { class: 'section-label' }, t('about')),
    glass('div', 'group', null,
      h('div', { class: 'item' }, h('div', { class: 'item-main' }, 'Best'), h('span', { class: 'value mono ltr' }, S.info.version || '')),
      h('div', { class: 'item' }, h('div', { class: 'item-main' }, 'Xray'), h('span', { class: 'value mono ltr' }, xrayVersion())),
      h('div', { class: 'item' }, h('div', { class: 'item-main' }, 'sing-box'), h('span', { class: 'value mono ltr' }, S.info.singbox || '—')),
      h('button', { class: 'item', onClick: () => openSheet({ type: 'licenses' }) }, icon('info', 19, 1.8),
        h('div', { class: 'item-main' }, t('licenses'), h('small', null, t('licensesHint'))), chevron())));
}

function viewSheet() {
  const sh = S.sheet;
  if (!sh) return null;
  let title = '';
  let body = [];
  if (sh.type === 'add') {
    title = t('addTitle');
    const tile = (ic, label, hint, fn) => h('button', { class: 'tile', onClick: fn, disabled: !fn }, h('span', { class: 'badge-icon' }, icon(ic, 19, 1.8)), h('span', null, h('b', null, label), h('br'), h('small', null, fn ? hint : t('soon'))));
    body = [
      h('div', { class: 'tiles' },
        tile('clipboard', t('clipboard'), t('clipboardHint'), fromClipboard),
        tile('scan', t('scanQr'), t('scanQrHint'), () => fromPicker('pick.scan')),
        tile('qr', t('qrPhoto'), t('qrPhotoHint'), () => fromPicker('pick.photo')),
        tile('file', t('openFile'), t('openFileHint'), () => fromPicker('pick.file'))),
      h('button', { class: 'wide', onClick: () => openSheet({ type: 'addSub', url: '', name: '' }) },
        h('span', { class: 'badge-icon' }, icon('subs', 19, 1.8)),
        h('span', { class: 'item-main' }, h('b', null, t('subLink')), h('small', null, t('subLinkHint')))),
      h('button', { class: 'wide', onClick: () => editor.open('') },
        h('span', { class: 'badge-icon' }, icon('edit', 19, 1.8)),
        h('span', { class: 'item-main' }, h('b', null, t('newConfig')), h('small', null, t('newConfigHint')))),
    ];
  } else if (sh.type === 'addSub') {
    // A subscription link, or config links pasted here by mistake: those are added as configs
    // instead of leaving the button grey with no word why.
    const busy = Boolean(sh.busy);
    const raw = String(sh.url || '').trim().slice(0, 200000);
    const isUrl = /^https?:\/\/\S+$/i.test(raw);
    const links = raw && !isUrl ? countLinks(raw) : 0;
    const insecure = isUrl && /^http:\/\//i.test(raw);
    title = links ? t('addTitle') : t('subAdd');
    const go = async () => {
      if (sh.busy) return;
      if (links) return importText(raw);
      if (!isUrl) return;
      sh.busy = true; render();
      await addSub(raw, sh.name);
      if (S.sheet === sh) { sh.busy = false; render(); }
    };
    // The keyboard's Enter / Go key adds too (Shift+Enter still starts a new line).
    const enter = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } };
    body = [
      h('div', { class: 'field' }, h('label', null, links ? t('configLinks') : t('subUrl')),
        h('textarea', { class: 'ltr short', rows: '2', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'go', value: sh.url || '', placeholder: 'https://', 'data-key': 'sub-url', onInput: (e) => { sh.url = e.target.value; render(); }, onKeyDown: enter }),
        h('small', null, t('subUrlHint'))),
      links ? null : h('div', { class: 'field' }, h('label', null, t('subName')),
        h('input', { type: 'text', autocomplete: 'off', enterkeyhint: 'go', value: sh.name || '', 'data-key': 'sub-name', onInput: (e) => { sh.name = e.target.value; }, onKeyDown: enter })),
      insecure ? h('div', { class: 'note warn' }, icon('alert', 18, 1.9), h('span', null, t('subHttpWarn'))) : null,
      raw && !isUrl && !links ? h('div', { class: 'note warn' }, icon('alert', 18, 1.9), h('span', null, t('nothingFound'))) : null,
      h('button', { class: 'btn primary', disabled: busy || (!isUrl && !links), onClick: go },
        busy ? t('subAdding') : links === 1 ? t('addConfig1') : links ? t('addConfigsN', { n: num(links) }) : t('subAdd')),
    ];
  } else if (sh.type === 'test') {
    title = t('testTitle');
    const opt = (ic, label, hint, fn) => h('button', { class: 'wide', onClick: fn, disabled: !fn },
      h('span', { class: 'badge-icon' }, icon(ic, 19, 1.8)),
      h('span', { class: 'item-main' }, h('b', null, label), h('small', null, fn ? hint : t('soon'))));
    body = [
      opt('bolt', t('testReal'), t('testRealHint'), () => { closeSheet(); testAll('real'); }),
      opt('gauge', t('testTcp'), t('testTcpHint'), () => { closeSheet(); testAll('tcp'); }),
      opt('download', t('testSpeed'), t('testSpeedHint'), () => { closeSheet(); testAll('speed'); }),
      opt('globe', t('testUdp'), t('testUdpHint'), () => { closeSheet(); testAll('udp'); }),
      h('div', { class: 'group' },
        h('button', { class: 'item', onClick: () => { S.ui.sortFast = !S.ui.sortFast; save('ui'); render(); } },
          h('div', { class: 'item-main' }, t('sortFastest')), switchEl(S.ui.sortFast)),
        h('button', { class: 'item', onClick: useFastest }, icon('check', 19, 1.8), h('div', { class: 'item-main' }, t('useFastest'))),
        h('button', { class: 'item', onClick: () => { S.delays = {}; S.speeds = {}; S.ui.metric = 'delay'; save('ui'); closeSheet(); } }, icon('trash', 19, 1.8), h('div', { class: 'item-main' }, t('clearResults')))),
      h('div', { class: 'group' },
        h('button', { class: 'item', onClick: () => { closeSheet(); deleteFailed(); } }, icon('close', 19, 1.8), h('div', { class: 'item-main' }, t('delFailed'))),
        h('button', { class: 'item', onClick: () => { closeSheet(); deleteDuplicates(); } }, icon('copy', 19, 1.8), h('div', { class: 'item-main' }, t('delDup'))),
        h('button', { class: 'item', onClick: () => { closeSheet(); copyAllLinks(); } }, icon('link', 19, 1.8), h('div', { class: 'item-main' }, t('copyAll')))),
    ];
  } else if (sh.type === 'subInfo') {
    const sub = S.subs.find((x) => x.id === sh.id);
    if (!sub) return null;
    const u = subUsage(sub);
    title = sub.name || t('subLink');
    const row = (label, value, style) => h('div', { class: 'item' }, h('div', { class: 'item-main' }, label), h('span', { class: 'value', style }, value));
    const open = (url) => call('app.openPanel', { url }).catch(() => showToast(errText('BAD_URL'), true));
    body = [
      h('div', { class: 'sub-usage' },
        h('span', { class: `usage-bar big ${u.info.total ? '' : 'unlimited'} ${u.warn ? 'warn' : ''}` }, h('span', { style: { width: `${u.info.total ? Math.max(2, u.pct * 100) : 100}%` } })),
        h('div', { class: 'sub-usage-text' }, h('b', null, u.amount), u.info.total ? h('span', null, `${num(Math.round(u.pct * 100))}%`) : h('span', null, t('unlimited')))),
      glass('div', 'group', null,
        row(t('download'), bytes(u.info.download || 0)),
        row(t('upload'), bytes(u.info.upload || 0)),
        row(t('expires'), u.info.expire ? `${new Date(u.info.expire * 1000).toLocaleDateString(S.settings.language === 'fa' ? 'fa-IR' : S.settings.language)} · ${u.time}` : t('noExpiry'), u.warn ? { color: 'var(--fair)' } : null),
        row(t('subUpdatedLabel'), sub.updatedAt ? ago(sub.updatedAt) : '—'),
        row(t('configsLabel'), num(S.servers.filter((s) => s.subId === sub.id).length))),
      sub.announce ? h('div', { class: 'note' }, icon('info', 18, 1.9), h('span', null, sub.announce)) : null,
      sub.notice ? h('div', { class: 'note warn' }, icon('alert', 18, 1.9), h('span', null, sub.notice)) : null,
      (sub.infoNodes || []).length ? glass('div', 'group', null, sub.infoNodes.map((n, i) => h('div', { class: 'item', 'data-key': `in${i}` }, h('div', { class: 'item-main' }, h('small', null, n))))) : null,
      sub.supportUrl || sub.webPageUrl ? h('div', { class: 'two-btn' },
        sub.supportUrl ? h('button', { class: 'btn', onClick: () => open(sub.supportUrl) }, icon('info', 18, 1.9), t('subSupport')) : null,
        sub.webPageUrl ? h('button', { class: 'btn', onClick: () => open(sub.webPageUrl) }, icon('link', 18, 1.9), t('subWebPage')) : null) : null,
      h('button', { class: 'btn primary', disabled: S.busy[sub.id], onClick: () => { closeSheet(); updateSub(sub); } }, icon('refresh', 18, 1.9), t('update')),
    ];
  } else if (sh.type === 'licenses') {
    title = t('licenses');
    body = [glass('div', 'group', null, h('div', { class: 'item log-line ltr', dir: 'ltr', style: { wordBreak: 'normal', overflowWrap: 'anywhere' } }, NOTICES))];
  } else if (sh.type === 'country') {
    title = t('myCountry');
    const auto = phoneRegion();
    const row = (cc, label) => h('button', { class: `opt ${S.routing.country === cc ? 'on' : ''}`, 'data-key': cc || 'auto', onClick: () => { setRouting((r) => { r.country = cc; }); closeSheet(); } },
      h('span', { class: 'item-main' }, label), h('span', { class: 'radio' }));
    body = [h('div', { class: 'group', style: { padding: '6px' } },
      row('', t('autoCountry', { country: countryName(auto) || '—' })),
      COUNTRIES.map((cc) => row(cc, countryName(cc))))];
  } else if (sh.type === 'apps') {
    title = t('chooseApps');
    if (!S.apps) {
      call('apps.list').then((list) => { S.apps = Array.isArray(list) ? list : []; render(); }).catch(() => { S.apps = []; render(); });
      body = [h('div', { class: 'empty' }, h('span', { class: 'mini-spin' }))];
    } else {
      const q = String(sh.q || '').trim().toLowerCase();
      const chosen = new Set(S.ui.apps);
      const list = S.apps
        .filter((a) => !q || String(a.label).toLowerCase().includes(q) || String(a.pkg).includes(q))
        .sort((a, b) => Number(chosen.has(b.pkg)) - Number(chosen.has(a.pkg)));
      body = [
        h('div', { class: 'field' }, h('input', { type: 'search', placeholder: t('searchApps'), value: sh.q || '', autocomplete: 'off', onInput: (e) => { sh.q = e.target.value; render(); } })),
        h('div', { class: 'chips' },
          h('button', { class: 'chip', onClick: () => setApps(S.apps.map((a) => a.pkg)) }, t('appsAll2')),
          h('button', { class: 'chip', onClick: () => setApps([]) }, t('appsNone')),
          h('button', { class: 'chip', onClick: () => setApps(S.apps.map((a) => a.pkg).filter((p) => !chosen.has(p))) }, t('appsInvert')),
          h('button', { class: 'chip', onClick: () => setApps([...chosen, ...S.apps.filter(isIranianApp).map((a) => a.pkg)]) }, t('appsIran')),
          h('button', { class: 'chip', onClick: async () => { await call('clip.write', { text: S.ui.apps.join('\n'), sensitive: false }).catch(() => {}); showToast(t('copied')); } }, t('appsExport')),
          h('button', { class: 'chip', onClick: async () => {
            const text = String((await call('clip.read').catch(() => '')) || '');
            const known = new Set(S.apps.map((a) => a.pkg));
            const list = text.split(/[\s,;]+/).filter((x) => known.has(x));
            setApps([...new Set([...S.ui.apps, ...list])]);
            showToast(t('appsImported', { n: num(list.length) }));
          } }, t('appsImport'))),
        h('div', { class: 'group' }, list.slice(0, 300).map((a) => h('button', { class: 'item', 'data-key': a.pkg, onClick: () => toggleApp(a.pkg) },
          a.icon && /^data:image\/png;base64,/.test(a.icon) ? h('img', { class: 'app-icon', src: a.icon, alt: '' }) : h('span', { class: 'app-icon' }),
          h('div', { class: 'item-main' }, a.label, h('small', { class: 'ltr' }, a.pkg)),
          h('span', { class: `check ${chosen.has(a.pkg) ? 'on' : ''}` }, chosen.has(a.pkg) ? icon('check', 14, 3) : null)))),
        h('button', { class: 'btn primary', onClick: closeSheet }, t('done')),
      ];
    }
  } else if (sh.type === 'rule') {
    title = t('addRule');
    body = [
      h('div', { class: 'field' }, h('label', null, t('ruleTarget')),
        h('textarea', { class: 'ltr', spellcheck: 'false', autocomplete: 'off', value: sh.text || '', onInput: (e) => { sh.text = e.target.value; } }),
        h('small', null, t('ruleTargetHint'))),
      h('div', { class: 'pick' }, [['proxy', t('outProxy')], ['direct', t('outDirect')], ['block', t('outBlock')]].map(([v, label]) =>
        h('button', { class: sh.out === v ? 'on' : '', 'data-key': v, onClick: () => { sh.out = v; render(); } }, label))),
      h('button', { class: 'btn primary', onClick: () => addRuleFromSheet(sh) }, t('save')),
    ];
  } else if (sh.type === 'removeSub') {
    const sub = S.subs.find((x) => x.id === sh.id);
    if (!sub) return null;
    title = t('delete');
    body = [
      h('div', { class: 'note' }, h('span', null, t('removeSubQ', { name: sub.name || t('subLink') }))),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', style: { flex: '1' }, onClick: closeSheet }, t('cancel')),
        h('button', { class: 'btn primary', style: { flex: '1', background: 'var(--bad)', boxShadow: 'none' }, onClick: () => removeSub(sub) }, t('delete'))),
    ];
  } else if (sh.type === 'row') {
    const s = S.servers.find((x) => x.id === sh.id);
    if (!s) return null;
    title = nameOf(s);
    let link = '';
    try { link = Core.links.toLink(s); } catch { link = ''; }
    body = [
      h('div', { class: 'group' },
        h('button', { class: 'item', onClick: () => editor.open(s.id) }, icon('edit', 19, 1.8), h('div', { class: 'item-main' }, t('edit'))),
        link ? h('button', { class: 'item', onClick: () => openSheet({ type: 'qr', id: s.id, link }) }, icon('qr', 19, 1.8), h('div', { class: 'item-main' }, t('showQr'))) : null,
        link ? h('button', { class: 'item', onClick: async () => { await call('clip.write', { text: link, sensitive: true }).catch(() => {}); closeSheet(); showToast(t('copied')); } },
          icon('copy', 19, 1.8), h('div', { class: 'item-main' }, t('copyLink'))) : null,
        link ? h('button', { class: 'item', onClick: () => { call('app.share', { text: link }).catch(() => {}); closeSheet(); } },
          icon('link', 19, 1.8), h('div', { class: 'item-main' }, t('share'))) : null,
        h('button', { class: 'item', style: { color: 'var(--bad)' }, onClick: () => removeServer(s.id) },
          icon('trash', 19, 1.8), h('div', { class: 'item-main' }, t('delete')))),
    ];
  }
  else if (sh.type === 'linkImport') {
    title = t('linkConfig');
    body = [
      h('div', { class: 'group' }, sh.names.map((n, i) => h('div', { class: 'item', 'data-key': `li${i}` }, h('div', { class: 'item-main' }, n)))),
      sh.n > sh.names.length ? h('small', { class: 'upd-hint' }, t('configsN', { n: num(sh.n) })) : null,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', style: { flex: '1' }, onClick: closeSheet }, t('cancel')),
        h('button', { class: 'btn primary', style: { flex: '1' }, onClick: () => importText(sh.text) }, t('addAll'))),
    ];
  } else if (sh.type === 'editSub') {
    const sub = S.subs.find((x) => x.id === sh.id);
    if (!sub) return null;
    const d = sh.draft;
    title = t('subEdit');
    const input = (k, label, opts = {}) => h('div', { class: 'field' }, h('label', null, label),
      h(opts.area ? 'textarea' : 'input', { class: `${opts.plain ? '' : 'ltr'} ${opts.short ? 'short' : ''}`, type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', placeholder: opts.placeholder || '', value: d[k] || '', 'data-key': `es-${k}`, onInput: (e) => { d[k] = e.target.value; } }),
      opts.hint ? h('small', null, opts.hint) : null);
    const fronts = S.servers.filter((x) => x.protocol !== 'group' && x.protocol !== 'custom' && x.subId !== sub.id);
    body = [
      h('div', { class: 'group' },
        h('button', { class: 'item', onClick: () => { d.enabled = d.enabled === false; render(); } },
          h('div', { class: 'item-main' }, t('subEnabled')), switchEl(d.enabled !== false))),
      input('name', t('subName'), { plain: true }),
      input('url', t('subUrl'), { placeholder: 'https://' }),
      input('moreUrls', t('subMore'), { area: true, short: true, hint: t('subMoreHint') }),
      input('filter', t('subFilter'), { hint: t('subFilterHint') }),
      input('exclude', t('subExclude')),
      input('userAgent', t('subUaOwn'), { placeholder: S.settings.subUserAgent || 'Best' }),
      h('div', { class: 'field' }, h('label', null, t('subVia')),
        h('select', { 'data-key': 'es-via', onChange: (e) => { d.via = e.target.value; } },
          h('option', { value: '', selected: !d.via }, t('viaNone')),
          fronts.slice(0, 300).map((x) => h('option', { value: x.id, selected: d.via === x.id }, nameOf(x)))),
        h('small', null, t('subViaHint'))),
      h('button', { class: 'btn primary', onClick: () => saveSubEdit(sub, d) }, t('save')),
    ];
  } else if (sh.type === 'qr') {
    const s = S.servers.find((x) => x.id === sh.id);
    if (!s) return null;
    title = nameOf(s);
    if (sh.img === undefined) {
      sh.img = null;
      call('qr.make', { text: sh.link }).then((url) => { sh.img = typeof url === 'string' && url.startsWith('data:image/png;base64,') ? url : ''; render(); }).catch(() => { sh.img = ''; render(); });
    }
    body = [
      h('div', { class: 'qr-box' }, sh.img ? h('img', { src: sh.img, alt: t('showQr') }) : h('span', { class: 'mini-spin' })),
      h('div', { class: 'note warn' }, icon('alert', 18, 1.9), h('span', null, t('qrWarn'))),
    ];
  }
  if (!body.length) {
    const own = more.sheet(sh);
    if (!own) return null;
    ({ title, body } = own);
  }
  return [
    h('div', { class: 'scrim', 'data-key': 'scrim', onClick: closeSheet }),
    h('section', { class: 'sheet', 'data-key': `sheet-${sh.type}`, role: 'dialog', 'aria-label': title },
      h('span', { class: 'grab' }),
      h('div', { class: 'sheet-head' },
        h('h2', null, title),
        h('button', { class: 'icon-btn', 'aria-label': t('close'), onClick: closeSheet }, icon('close', 18, 1.9))),
      h('div', { class: 'sheet-body' }, body)),
  ];
}

function view() {
  const on = S.vpn.phase === 'connected';
  let page;
  if (S.page === 'subs') page = viewSubs();
  else if (S.page === 'routing') page = viewRouting();
  else if (S.page === 'updates') page = updates.view();
  else if (S.page === 'settings') page = viewSettings();
  else if (S.page === 'editor' && S.edit) page = editor.view();
  else if (S.page === 'advanced') page = more.viewAdvanced();
  else if (S.page === 'webdav') page = more.viewWebdav();
  else if (S.page === 'logs') page = more.viewLogs();
  else page = viewConfigs();
  return [
    h('div', { class: `aurora g ${on ? 'off' : ''}`, 'data-key': 'aurora-g' }),
    h('div', { class: `aurora a ${on ? '' : 'off'}`, 'data-key': 'aurora-a' }),
    h('div', { class: 'aurora b', 'data-key': 'aurora-b' }),
    page,
    ['editor', 'advanced', 'webdav', 'logs'].includes(S.page) ? null : navBar(),
    viewSheet(),
    S.toast ? glass('div', `toast ${S.toast.err ? 'err' : ''}`, { role: 'status', 'data-key': 'toast' },
      h('span', { class: 'tick' }, icon(S.toast.err ? 'close' : 'check', 15, 2.8)), S.toast.text) : null,
  ];
}

const ctx = { S, render: () => render(), save, showToast, glass, switchEl, ago, reconnect, applyToConnection, openSheet, closeSheet, cleanServers, cleanSubs, applyLook: () => applyLook(), nameOf, xrayVersion };
const editor = createEditor(ctx);
const updates = createUpdates(ctx);
const more = createMore(ctx);

let frame = 0;
function render() {
  if (!S.ready || frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    mount(root, view());
    syncListTop();
    showChosenTab();
  });
}

/** The chosen config tab, when the row scrolls sideways, is kept fully in sight. */
function showChosenTab() {
  const row = root.querySelector('.tabs-scroll');
  const on = row && row.querySelector('button.on');
  if (!on) return;
  const r = row.getBoundingClientRect();
  const b = on.getBoundingClientRect();
  // 16 px from the edges, clear of their fade.
  if (b.left < r.left + 16) row.scrollLeft -= r.left + 16 - b.left;
  else if (b.right > r.right - 16) row.scrollLeft += b.right - (r.right - 16);
}

/** The list scrolls under the fixed top part; its first row starts right below it. */
let topObserver = null;
function syncListTop() {
  const top = root.querySelector('.configs-top');
  const box = root.querySelector('.configs');
  if (!top || !box) return;
  const apply = () => box.style.setProperty('--list-top', `${Math.round(top.getBoundingClientRect().height + 12)}px`);
  apply();
  if (topObserver && topObserver.__el === top) return;
  if (topObserver) topObserver.disconnect();
  topObserver = new ResizeObserver(apply);
  topObserver.__el = top;
  topObserver.observe(top);
}

function applyLook() {
  setLang(S.settings.language);
  const html = document.documentElement;
  html.lang = S.settings.language;
  html.dir = isRtl() ? 'rtl' : 'ltr';
  const dark = S.settings.theme === 'light' ? false : S.settings.theme === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : true;
  html.dataset.theme = dark ? 'dark' : 'light';
  html.dataset.glass = S.ui.glass ? 'on' : 'off';
  call('app.bars', { light: !dark }).catch(() => {});
}

// ------------------------------------------------------------------ native events

/** Which address and country sites see now (through the connection). */
async function checkExit() {
  if (!S.settings.showExitIp || S.vpn.phase !== 'connected') return;
  try {
    const r = await call('net.fetch', { url: S.settings.ipCheckUrl || 'https://www.cloudflare.com/cdn-cgi/trace', userAgent: '' });
    const body = String(r.body || '').slice(0, 4000);
    let ip = (/^ip=(.+)$/m.exec(body) || [])[1] || '';
    let cc = (/^loc=(\w+)$/m.exec(body) || [])[1] || '';
    if (!ip) { try { const j = JSON.parse(body); ip = j.ip || j.query || ''; cc = j.country_code || j.countryCode || j.country || ''; } catch { /* not JSON */ } }
    if (ip && S.vpn.phase === 'connected') { S.exit = { ip: Core.util.cleanText(ip, 45), cc: Core.util.cleanText(cc, 3).toUpperCase() }; render(); }
  } catch { /* shown when it works */ }
}

function setVpn(v) {
  if (!v) return;
  const was = S.vpn.phase;
  S.vpn = v;
  if (v.phase !== 'connected') S.exit = null;
  if (v.phase === 'connected' && was !== 'connected') {
    S.vpnSince = Date.now() - (v.forMs || 0);
    S.spark = [];
    S.traffic = { up: 0, down: 0 };
    setTimeout(checkExit, 1200);
  }
  if (v.phase === 'error' && v.error) showToast(errText(v.error), true);
  render();
}

on('vpn.state', setVpn);
on('vpn.traffic', (d) => {
  S.traffic = { up: d.up || 0, down: d.down || 0 };
  S.spark.push(d.down || 0);
  if (S.spark.length > SPARK_POINTS) S.spark.shift();
  render();
});
on('insets', (d) => {
  const st = document.documentElement.style;
  st.setProperty('--top', `${d.top || 0}px`);
  st.setProperty('--bottom', `${d.bottom || 0}px`);
});
on('back', () => {
  if (S.sheet) return closeSheet();
  if (S.page === 'editor') return editor.close();
  if (['advanced', 'webdav', 'logs'].includes(S.page)) { S.page = 'settings'; return render(); }
  if (S.searching) return closeSearch();
  if (S.page !== 'configs') { S.page = 'configs'; return render(); }
  call('app.exit').catch(() => {});
});
/** best://install-sub?url=…&name=…, best://install-config?url=<links>, or "scan:" (launcher shortcut). Always asks first. */
async function takeLink() {
  const link = await call('intent.link').catch(() => null);
  if (!link) return;
  if (link === 'scan:') return fromPicker('pick.scan');
  // Older WebViews don't split "best://install-sub?…" into host and query, so it is done here.
  const m = /^(?:best|v2rayng):\/\/([a-z-]+)\/?(?:\?(.*))?$/i.exec(String(link).trim());
  if (!m) return;
  const host = m[1].toLowerCase();
  const params = new URLSearchParams(m[2] || '');
  const target = params.get('url') || '';
  const u = { hostname: host, searchParams: params };
  S.page = 'configs';
  if (u.hostname === 'install-sub' && /^https?:\/\//i.test(target)) {
    openSheet({ type: 'addSub', url: target, name: Core.util.cleanText(u.searchParams.get('name') || '', 60) });
  } else if (u.hostname === 'install-config' && target) {
    const parsed = Core.subscription.parseContent(target);
    const { servers } = Core.subscription.splitInfoNodes(parsed.servers || []);
    if (servers.length) openSheet({ type: 'linkImport', text: target, names: servers.slice(0, 8).map(nameOf), n: servers.length });
    else showToast(t('nothingFound'), true);
  }
}

on('link', () => takeLink());

on('shared', async () => {
  const text = await call('intent.take').catch(() => null);
  if (text) askShared(text);
});

// The connected-time clock.
setInterval(() => { if (S.vpn.phase === 'connected' && S.page === 'configs') render(); }, 1000);

async function start() {
  try {
    const hello = await call('hello');
    S.info = hello.info || {};
    if (hello.insets) {
      document.documentElement.style.setProperty('--top', `${hello.insets.top || 0}px`);
      document.documentElement.style.setProperty('--bottom', `${hello.insets.bottom || 0}px`);
    }
    await load();
    call('singbox.version').then((v) => { S.info.singbox = typeof v === 'string' ? v.slice(0, 40) : ''; render(); }).catch(() => {});
    applyLook();
    S.ready = true;
    setVpn(hello.vpn);
    const shared = await call('intent.take').catch(() => null);
    if (shared) askShared(shared);
    takeLink();
    call('geo.info').then((g) => { if (g && g.ext) S.geoExt = { ir: Number(g.ext.ir) || 0, ru: Number(g.ext.ru) || 0 }; }).catch(() => {});
    autoUpdateSubs();
    setInterval(autoUpdateSubs, 3600000);
    updates.autoCheck();
  } catch (e) {
    S.ready = true;
    applyLook();
    showToast(errText(e.code), true);
  }
  render();
}

start();
