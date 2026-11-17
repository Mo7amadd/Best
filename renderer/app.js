// Main window: state, theme, sidebar and page routing.

import { h, mount, icon, toast, ltr } from './dom.js';
import { t, setLanguage, num } from './i18n.js';
import { renderServers, onTestResult } from './pages/servers.js';
import { renderSubs } from './pages/subs.js';
import { renderRouting } from './pages/routing.js';
import { renderLogs, appendLog } from './pages/logs.js';
import { renderConnections, paintConnections, leaveConnections } from './pages/connections.js';
import { renderSettings } from './pages/settings.js';
import { renderUpdates, availableUpdates } from './pages/updates.js';
import { installShortcuts, showShortcuts } from './shortcuts.js';

const api = window.best;

export const S = { settings: null, routing: null, servers: [], subs: [], core: {}, activeId: '', isAdmin: false, encrypted: true, exitInfo: null, secureCores: true, portable: false, version: '' };
export const ui = {
  page: 'servers',
  group: localGet('group', 'all'),
  query: '',
  sort: { key: '', dir: 1 },
  selected: new Set(),
  lastClicked: '',
  logsOpen: false,
  hideAddr: localGet('hideAddr', '0') === '1',
  testing: null,
  busy: false,
  logs: [],
  versions: null,
};

/** Live test state: which servers are queued, running (with start time) and live speed values. */
export function newTesting(kind, ids) {
  return { kind, ids: new Set(ids), total: ids.length, done: 0, started: new Map(), live: new Map(), justDone: new Set() };
}
ui.testing = newTesting('', []);

function localGet(k, d) { try { return localStorage.getItem(`best.${k}`) ?? d; } catch { return d; } }
export function localSet(k, v) { try { localStorage.setItem(`best.${k}`, v); } catch { /* ignore */ } }

export { api };

// --------------------------------------------------------------------------- helpers
export function applyTheme(settings) {
  const root = document.documentElement;
  let theme = settings.theme;
  if (theme === 'system') theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  root.dataset.theme = theme;
  root.dataset.accent = settings.accent;
  setLanguage(settings.language);
}

/** 🇩🇪 from "de". */
export function flagOf(cc) {
  if (!/^[a-z]{2}$/i.test(cc || '')) return '';
  return String.fromCodePoint(...cc.toUpperCase().split('').map((c) => 0x1F1E6 + c.charCodeAt(0) - 65));
}

export function countryName(cc) {
  if (!cc) return t('noCountry');
  try { return new Intl.DisplayNames([S.settings.language || 'en'], { type: 'region' }).of(cc.toUpperCase()) || cc.toUpperCase(); } catch { return cc.toUpperCase(); }
}

/** Every ISO 3166 country the runtime knows a name for, sorted by name. */
export function countryList() {
  const names = new Intl.DisplayNames([S.settings.language || 'en'], { type: 'region', fallback: 'none' });
  const en = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
  const out = [];
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      let name;
      try { name = names.of(code); } catch { name = undefined; }
      if (name && name !== code && !['EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'ZZ'].includes(code)) out.push({ code: code.toLowerCase(), name, en: en.of(code) || '' });
    }
  }
  return out.sort((x, y) => x.name.localeCompare(y.name, S.settings.language));
}

export function serverName(s) { return s.remark || s.address || '—'; }

export function formatBytes(b) {
  if (!b) return num(0) + ' B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${num(Math.round((b / 1024 ** i) * 10) / 10)} ${u[i]}`;
}

/** Speed in bytes per second → "1.2 MB/s". */
export function formatRate(b) { return `${formatBytes(b || 0)}/s`; }

/** Live traffic numbers (once a second): only the few text nodes that show them are touched. */
export function paintStats() {
  const st = ui.stats;
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  set('st-down', st ? formatRate(st.downSpeed) : '—');
  set('st-up', st ? formatRate(st.upSpeed) : '—');
  set('st-session', st ? t('st_session', { down: formatBytes(st.down), up: formatBytes(st.up) }) : '');
  set('side-down', st ? formatRate(st.downSpeed) : '—');
  set('side-up', st ? formatRate(st.upSpeed) : '—');
}

export function delayTier(ms) { return ms < 0 ? 0 : ms < 300 ? 3 : ms < 700 ? 2 : 1; }

/**
 * Hidden address: a blurred stand-in of the same length. The real address is not in the page at
 * all, so a screenshot or screen share cannot be sharpened to reveal it.
 */
export function maskAddress(a) {
  if (!a) return '';
  // Natural-looking stand-in text (word shapes, mixed letter widths), blurred softly.
  // Nothing of the real address is rendered.
  const SHAPES = ['ser', 'vane', 'lo', 'mira', 'tek', 'onu', 'basi', 'rel', 'ka', 'dom'];
  const len = Math.min(40, String(a).length);
  let fake = '';
  for (let i = 0; fake.length < len; i++) fake += (fake ? '.' : '') + SHAPES[(i * 7 + len) % SHAPES.length];
  return h('span', { class: 'blurred', role: 'img', 'aria-label': t('hiddenAddress'), title: t('hiddenAddress') }, fake.slice(0, len));
}

export function groupsList() {
  return [
    { id: 'all', name: t('group_all'), count: S.servers.length },
    { id: 'manual', name: t('group_manual'), count: S.servers.filter((s) => !s.subId).length },
    ...S.subs.map((s) => ({ id: s.id, name: s.name, count: S.servers.filter((x) => x.subId === s.id).length, sub: s })),
  ];
}

export function serversInGroup(group = ui.group) {
  if (group === 'all') return S.servers;
  if (group === 'manual') return S.servers.filter((s) => !s.subId);
  return S.servers.filter((s) => s.subId === group);
}

export function showError(e) {
  const msg = String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const [code, ...rest] = msg.split(':');
  const known = ['PORT_BUSY', 'CORE_FAILED', 'TUN_FAILED', 'NO_SERVER', 'INVALID_URL', 'INVALID_BACKUP', 'SS_BAD_KEY'];
  toast(known.includes(code) ? t(code, { d: rest.join(':').trim() }) : t('error', { d: msg }), 'error', 6000);
}

export async function run(fn) {
  try { return await fn(); } catch (e) { showError(e); return undefined; }
}

// --------------------------------------------------------------------------- render
const NAV = [
  { id: 'servers', icon: 'servers', label: 'nav_servers' },
  { id: 'subs', icon: 'subs', label: 'nav_subs' },
  { id: 'routing', icon: 'routing', label: 'nav_routing' },
  { id: 'connections', icon: 'globe', label: 'nav_connections' },
  { id: 'logs', icon: 'logs', label: 'nav_logs' },
  { id: 'updates', icon: 'download', label: 'nav_updates' },
  { id: 'settings', icon: 'settings', label: 'nav_settings' },
];

/**
 * Side menu: pinned (always open, the page sits next to it) or unpinned (icons only; it opens over
 * the page while the mouse rests on it or the keyboard is in it). In a narrow window it is always
 * unpinned and the pin button is hidden. Pin choice: button or Ctrl+B, remembered in Settings.
 */
const narrowQuery = window.matchMedia('(max-width: 980px)');
ui.narrow = narrowQuery.matches;
narrowQuery.addEventListener('change', (e) => { ui.narrow = e.matches; ui.sidePeek = false; render(); });
export function sidebarCollapsed() {
  return ui.narrow || Boolean(S.settings && S.settings.sidebarCollapsed);
}
export function toggleSidebar() {
  if (ui.narrow) return; // narrow window: the menu stays unpinned
  ui.sidePeekWas = Boolean(ui.sidePeek); // pinned from the open-on-hover menu: it is already wide
  // Pinning: the open menu stays open until it becomes the pinned one (closing it first made it
  // jump to the narrow strip and back). Unpinning: it closes to the strip.
  if (!S.settings.sidebarCollapsed) ui.sidePeek = false;
  // Shown at once; saving follows in the background (waiting for it delayed the animation).
  const next = !S.settings.sidebarCollapsed;
  S.settings = { ...S.settings, sidebarCollapsed: next };
  render();
  run(() => api.setSettings({ sidebarCollapsed: next }));
}

/**
 * Pinning / unpinning: the page widens or narrows smoothly instead of jumping. (The window is
 * rebuilt on every change, so a CSS transition would not run: the new menu is animated from the
 * old size by hand.) Pinning from an open-on-hover menu only moves the page — the menu is already wide.
 */
function animateSidebar(from, to) {
  const aside = document.querySelector('aside.sidebar');
  const panel = aside && aside.querySelector('.side-panel');
  if (!aside || !panel || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const opts = { duration: 200, easing: 'cubic-bezier(.645, .045, .355, 1)' }; // same 0.2 s as opening on hover
  const W = { small: 68, pinned: 236 };
  aside.animate([{ flexBasis: `${W[from]}px` }, { flexBasis: `${W[to]}px` }], opts);
  const panelFrom = from === 'small' && ui.sidePeekWas ? W.pinned : W[from];
  if (panelFrom !== W[to]) panel.animate([{ width: `${panelFrom}px` }, { width: `${W[to]}px` }], opts);
  ui.sidePeekWas = false;
}

// Opens as soon as the mouse is on the menu and closes as soon as it leaves (like 3x-ui); the
// timer only keeps one pending change at a time.
let peekTimer = 0;
let peekWanted = null; // what the pending timer will do (null: nothing pending)
// When the mouse was last pressed: focus that follows a click is not "keyboard focus".
let lastPointerDown = -1e9;
document.addEventListener('pointerdown', () => { lastPointerDown = performance.now(); }, true);
function peek(open, delay) {
  clearTimeout(peekTimer);
  peekWanted = open;
  peekTimer = setTimeout(() => {
    peekWanted = null;
    ui.sidePeek = open;
    const a = document.querySelector('aside.sidebar');
    if (a) a.classList.toggle('peek', open && a.classList.contains('small'));
  }, delay);
}

function sidebar() {
  const st = S.settings;
  const core = S.core.running ? (S.core.core === 'xray' ? `Xray ${ui.versions?.xray || ''}` : `sing-box ${ui.versions?.singbox || ''}`) : '—';
  const small = sidebarCollapsed();
  const engaged = S.core.running && (st.proxyMode === 'on' || st.proxyMode === 'pac' || st.tun);
  const statusTip = [`${t('core')}: ${core.trim()}`, `${t('localPorts')}: ${st.socksPort} · ${st.httpPort}`, `${t('lanSharing')}: ${st.allowLan ? t('on') : t('off')}`, `${t('privileges')}: ${S.isAdmin ? t('admin') : t('normalUser')}`].join('\n');
  const pin = ui.narrow ? null : h('button', {
    type: 'button', class: `side-toggle ${small ? '' : 'pinned'}`, title: `${small ? t('side_pin') : t('side_unpin')} (Ctrl+B)`, 'aria-label': small ? t('side_pin') : t('side_unpin'),
    'aria-pressed': String(!small), onClick: toggleSidebar,
  }, icon('pin', 17));
  const nav = (n) => {
    const count = n.id === 'subs' ? S.subs.length : n.id === 'updates' ? availableUpdates().length : 0;
    return h('button', {
      type: 'button', class: 'nav-btn', 'aria-current': ui.page === n.id ? 'page' : undefined, title: t(n.label), 'aria-label': t(n.label),
      onClick: () => go(n.id), // an open-on-hover menu stays open: it closes when the mouse leaves it
    }, icon(n.icon, 18), h('span', { class: 'nav-label' }, t(n.label)),
    count ? h('span', { class: `badge ${n.id === 'updates' ? 'badge-accent' : ''}`, title: n.id === 'updates' ? t('upd_available') : undefined }, num(count)) : null);
  };
  return h('aside', {
    class: `sidebar ${small ? 'small' : ''} ${small && ui.sidePeek ? 'peek' : ''}`,
    onMouseenter: small ? () => peek(true, 0) : undefined,
    // Safety net: if the window was redrawn just as the mouse came in, "enter" can be missed.
    onMousemove: small ? () => { if (!ui.sidePeek && peekWanted !== true) peek(true, 0); } : undefined,
    onMouseleave: small ? () => peek(false, 0) : undefined,
    onFocusin: small ? () => { if (performance.now() - lastPointerDown > 300) peek(true, 0); } : undefined, // keyboard (Tab) only; a mouse click must not hold it open
    onFocusout: small ? (e) => { if (!e.currentTarget.contains(e.relatedTarget)) peek(false, 0); } : undefined,
  }, h('div', { class: 'side-panel' },
  h('div', { class: 'brand' },
    h('img', { src: 'logo.png', alt: '', title: small ? `Best ${S.version}` : undefined }),
    h('div', { class: 'brand-text' }, h('div', { class: 'brand-name' }, 'Best'), h('div', { class: 'brand-sub' }, `${t('version')} ${S.version}`)),
    pin),
  h('nav', { class: 'nav', 'aria-label': 'Main' },
    NAV.map(nav),
    h('button', { type: 'button', class: 'nav-btn nav-help', title: `${t('sc_title')} (F1)`, 'aria-label': t('sc_title'), onClick: showShortcuts }, icon('info', 18), h('span', { class: 'nav-label' }, t('sc_title')))),
  small ? h('div', { class: `side-status ${engaged ? 'on' : S.core.running ? 'ready' : ''}`, title: statusTip, 'aria-label': statusTip, role: 'img' }, h('span')) : null,
  h('div', { class: 'side-card' },
    h('div', { class: 'kv' }, h('span', null, t('core')), h('b', null, ltr(core.trim(), 'mono'))),
    h('div', { class: 'kv' }, h('span', null, t('localPorts')), h('b', null, ltr(`${st.socksPort} · ${st.httpPort}`, 'mono'))),
    ...(S.settings.statsEnabled !== false && S.core.running ? [
      h('div', { class: 'kv' }, h('span', null, `↓ ${t('download')}`), h('b', { id: 'side-down', class: 'mono' }, ui.stats ? formatRate(ui.stats.downSpeed) : '—')),
      h('div', { class: 'kv' }, h('span', null, `↑ ${t('upload')}`), h('b', { id: 'side-up', class: 'mono' }, ui.stats ? formatRate(ui.stats.upSpeed) : '—'))] : []),
    h('div', { class: 'kv' }, h('span', null, t('lanSharing')), h('b', null, st.allowLan ? t('on') : t('off'))),
    h('div', { class: 'kv' }, h('span', null, t('privileges')), h('b', null, S.isAdmin ? t('admin') : t('normalUser'))))));
}

const PAGES = { connections: renderConnections, servers: renderServers, subs: renderSubs, routing: renderRouting, logs: renderLogs, updates: renderUpdates, settings: renderSettings };

export function go(page) {
  document.querySelector('.set-find-list')?.remove(); // settings search results
  if (page === 'updates' && ui.page !== 'updates') ui.updatesAutoChecked = false;
  if (ui.page === 'connections' && page !== 'connections') leaveConnections();
  ui.page = page;
  render();
  const p = document.querySelector('.page');
  if (p) p.scrollTop = 0;
}

/** Re-render everything while keeping focus, caret and scroll positions. */
export function render() {
  if (!S.settings) return;
  const active = document.activeElement;
  const keep = active && active.dataset ? active.dataset.keep : '';
  const caret = keep && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  const scrolls = {};
  document.querySelectorAll('[data-scroll]').forEach((el) => { scrolls[el.dataset.scroll] = el.scrollTop; });

  const page = h('main', { class: 'main' }, PAGES[ui.page]());
  const root = document.getElementById('app');
  const sideMode = sidebarCollapsed() ? 'small' : 'pinned';
  root.classList.toggle('side-small', sideMode === 'small');
  mount(root, sidebar(), page);
  if (ui.sideMode && ui.sideMode !== sideMode) animateSidebar(ui.sideMode, sideMode);
  ui.sideMode = sideMode;

  document.querySelectorAll('[data-scroll]').forEach((el) => { if (scrolls[el.dataset.scroll]) el.scrollTop = scrolls[el.dataset.scroll]; });
  if (keep) {
    const el = document.querySelector(`[data-keep="${keep}"]`);
    if (el) { el.focus(); if (caret) try { el.setSelectionRange(caret[0], caret[1]); } catch { /* ignore */ } }
  }
}

// The last state drawn: an update that changes nothing must not rebuild the window (a rebuild
// between mouse-down and mouse-up loses the click, and restarts running animations).
let lastStateJson = '';

function applyState(state) {
  const json = JSON.stringify(state);
  if (json === lastStateJson) return;
  lastStateJson = json;
  const langChanged = !S.settings || S.settings.language !== state.settings.language;
  Object.assign(S, state);
  for (const id of [...ui.selected]) if (!S.servers.some((s) => s.id === id)) ui.selected.delete(id);
  if (ui.group !== 'all' && ui.group !== 'manual' && !S.subs.some((s) => s.id === ui.group)) ui.group = 'all';
  applyTheme(S.settings);
  document.body.classList.toggle('compact', S.settings.density === 'compact');
  if (langChanged) document.title = 'Best';
  render();
}

// --------------------------------------------------------------------------- boot
async function boot() {
  const state = await api.getState();
  ui.logs = await api.getLogs();
  applyState(state);
  api.versions().then((v) => { ui.versions = v; render(); });
  installShortcuts();

  api.on('state', applyState);
  api.on('log', (entry) => {
    ui.logs.push(entry);
    if (ui.logs.length > 2000) ui.logs.splice(0, ui.logs.length - 2000);
    appendLog(entry);
  });
  api.on('toast', ({ kind, key, detail }) => toast(t(key, { d: detail }), kind, kind === 'error' ? 7000 : 4500));
  api.on('connections', (list) => { ui.connections = list; paintConnections(); });
  api.on('stats', (st) => {
    const had = Boolean(ui.stats);
    ui.stats = st;
    if (had !== Boolean(st)) render(); else paintStats();
  });
  api.on('test', ({ kind, running, ids }) => {
    ui.testing = running ? newTesting(kind, ids) : newTesting('', []);
    if (!running && ui.afterTest) { const f = ui.afterTest; ui.afterTest = null; f(); }
    render();
  });
  api.on('test-start', ({ id }) => {
    ui.testing.started.set(id, performance.now());
    onTestResult(id);
  });
  api.on('progress', ({ id, value }) => {
    const v = Math.max(0, Math.min(100, Number(value) || 0));
    if (id === 'app') { if (S.appUpdate) S.appUpdate.progress = v; } else if (S.updates && S.updates.items && S.updates.items[id]) S.updates.items[id].progress = v;
    document.querySelectorAll(`[data-progress="${CSS.escape(String(id))}"]`).forEach((el) => {
      const bar = el.querySelector('.tp-bar > span');
      if (bar) bar.style.width = `${v}%`;
      const pct = el.querySelector('.mono');
      if (pct) pct.textContent = `${num(v)}%`;
      const cancel = el.querySelector('.upd-cancel');
      if (cancel) cancel.hidden = v >= (id === 'app' ? 100 : 90); // files are being replaced: too late to cancel
    });
  });
  api.on('test-progress', ({ id, value }) => {
    ui.testing.live.set(id, value);
    onTestResult(id);
  });
  api.on('test-result', (r) => {
    const s = S.servers.find((x) => x.id === r.id);
    if (s) s[r.field] = r.value;
    if (ui.testing.ids.delete(r.id)) ui.testing.done++;
    ui.testing.started.delete(r.id);
    ui.testing.live.delete(r.id);
    ui.testing.justDone.add(r.id);
    onTestResult(r.id);
  });
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (S.settings.theme === 'system') applyTheme(S.settings); });
}

boot();
