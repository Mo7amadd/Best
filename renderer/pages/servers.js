// Servers page: connection card, server table, collapsible log strip.

import { h, icon, button, segmented, toggle, select, showMenu, toast, confirmDialog, modal, ltr, mount } from '../dom.js';
import { t, num, IS_MAC } from '../i18n.js';
import {
  S, ui, api, render, run, newTesting, flagOf, serverName, delayTier, maskAddress, groupsList, serversInGroup, formatBytes, formatRate, countryName, localSet, go,
} from '../app.js';
import { openEditor } from './editor.js';
import { openSubEditor } from './subs.js';
import { logLine } from './logs.js';
import { profileName } from './routing.js';

// --------------------------------------------------------------------------- connection card
function connectionCard() {
  const active = S.servers.find((s) => s.id === S.activeId);
  const running = Boolean(S.core.running);
  const st = S.settings;
  // Like v2rayN there is no power button: choosing a server starts the core, and the system proxy
  // (or TUN) decides whether traffic actually goes through it.
  const engaged = running && (st.proxyMode === 'on' || st.proxyMode === 'pac' || st.tun);
  let statusText;
  let statusCls = '';
  if (ui.busy) statusText = t('connecting');
  else if (!active) statusText = t('st_noServer');
  else if (!running) { statusText = t('st_stopped'); statusCls = 'warn'; }
  else if (st.tun) { statusText = t('st_tun'); statusCls = 'on'; }
  else if (st.proxyMode === 'on') { statusText = t('st_proxyOn'); statusCls = 'on'; }
  else if (st.proxyMode === 'pac') { statusText = t('st_pac'); statusCls = 'on'; }
  else statusText = t('st_ready', { socks: st.socksPort, http: st.httpPort });
  // With TUN on every program goes through the tunnel: the proxy mode note would mislead then.
  const help = st.tun ? t('proxyHelp_tun') : t(`proxyHelp_${st.proxyMode}`, { socks: `127.0.0.1:${st.socksPort}`, http: `127.0.0.1:${st.httpPort}` });
  // Start when the core is off; Disconnect stops it completely (proxy port, TUN, system proxy set by Best).
  const startBtn = active && !running && !ui.busy
    ? button(t('st_start'), { size: 'sm', icon: 'play', onClick: () => useServer(active.id) })
    : running && !ui.busy
      ? button(t('disconnect'), { size: 'sm', icon: 'power', variant: 'ghost', onClick: () => run(() => api.disconnect()) })
      : null;

  const tags = active ? [
    h('span', { class: 'chip' }, protoLabel(active)),
    h('span', { class: 'chip' }, transportText(active)),
    active.address ? h('span', { class: 'chip' }, h('bdi', { dir: 'ltr', class: 'ltr mono' }, ui.hideAddr ? maskAddress(active.address) : active.address, active.port ? `:${active.port}` : '')) : null,
    active.subId ? h('span', { class: 'chip' }, (S.subs.find((x) => x.id === active.subId) || {}).name || '') : null,
    active.core || S.core.core ? h('span', { class: 'chip' }, (S.core.running && S.core.serverId === active.id ? S.core.core : active.core) === 'xray' ? 'Xray' : 'sing-box') : null,
  ] : [];

  const tunCtl = h('div', { class: 'ctl' },
    h('span', { class: 'section-label', id: 'tun-label' }, t('tunMode')),
    h('button', {
      type: 'button', class: 'tun-btn', role: 'switch', 'aria-checked': String(st.tun), 'aria-labelledby': 'tun-label',
      disabled: !S.tunAvailable,
      title: !S.tunAvailable && IS_MAC ? t('tunNeedsAdmin') : undefined, // why it is off on macOS
      onClick: () => run(() => api.setSettings({ tun: !st.tun })),
    }, h('span', { class: 'switch', 'aria-hidden': 'true', 'aria-checked': String(st.tun) }, h('span', { class: 'switch-knob' })), st.tun ? t('on') : t('off')));

  return h('section', { class: `card conn conn-nopower ${engaged ? 'engaged' : ''}`, 'aria-label': t('connect') },
    h('div', { class: 'conn-info' },
      h('div', { class: `status ${statusCls}` }, h('span', { class: 'dot' }), h('span', null, statusText), startBtn),
      h('div', { class: 'conn-name' },
        h('span', { class: 'name' }, active ? serverName(active) : t('noServerSelected')),
        active && active.delay > 0 ? h('span', { class: 'ms' }, `${num(active.delay)} ${t('ms')}`) : null),
      // the speed / exit IP line sits next to the tags when there is room (wraps below otherwise)
      h('div', { class: 'conn-meta' },
      h('div', { class: 'conn-tags' }, tags),
      running && st.statsEnabled !== false ? h('div', { class: 'conn-stats', 'aria-live': 'off' },
        h('span', { class: 'rate down', title: t('download') }, icon('down', 14), h('b', { id: 'st-down', class: 'mono' }, ui.stats ? formatRate(ui.stats.downSpeed) : '—')),
        h('span', { class: 'rate up', title: t('upload') }, icon('up', 14), h('b', { id: 'st-up', class: 'mono' }, ui.stats ? formatRate(ui.stats.upSpeed) : '—')),
        h('span', { id: 'st-session', class: 'dim' }, ui.stats ? t('st_session', { down: formatBytes(ui.stats.down), up: formatBytes(ui.stats.up) }) : ''),
        exitIpChip(),
        active && (active.usageDown || active.usageUp) ? h('span', { class: 'dim', title: t('st_serverTotal_help') }, t('st_serverTotal', { n: formatBytes((active.usageDown || 0) + (active.usageUp || 0)) })) : null) : null)),
    h('div', { class: 'conn-controls' },
      h('div', { class: 'ctl ctl-proxy' },
        h('span', { class: 'section-label', id: 'proxy-label' }, t('systemProxy')),
        segmented(['off', 'on', 'pac', 'keep'].map((m) => ({ value: m, label: t(`proxy_${m}`) })), st.proxyMode, (m) => run(() => api.setProxyMode(m)), { label: t('systemProxy') })),
      h('div', { class: 'ctl ctl-routing' },
        h('span', { class: 'section-label', id: 'routing-cap' }, t('routing')),
        select(S.routing.profiles.map((p) => ({ value: p.id, label: `${profileName(p)}${p.base === 'bypass-local' && S.routing.country ? ` ${flagOf(S.routing.country)}` : ''}` })),
          S.routing.activeId, (v) => run(() => api.setRouting({ activeId: v })), { id: 'routing-sel', 'aria-labelledby': 'routing-cap' })),
      tunCtl,
      // One line under all three controls (wraps only in a narrow window): what the proxy mode
      // means, and the way to TUN.
      h('div', { class: 'conn-notes' },
        h('span', { class: 'help' }, help),
        // the way to TUN: "Run as administrator" on Windows, "Install helper service" on macOS
        !S.tunAvailable ? h('button', { type: 'button', class: 'link-btn', onClick: () => api.relaunchAdmin() }, t('runAsAdmin')) : null)));
}

/** "Exit IP 🇩🇪 1.2.3.4": the address websites see (checked through the tunnel after connecting). */
function exitIpChip() {
  if (S.settings.showExitIp === false) return null;
  const x = S.exitInfo;
  const refresh = h('button', { type: 'button', class: 'icon-btn xs', title: t('exitIp_refresh'), 'aria-label': t('exitIp_refresh'), disabled: Boolean(x && x.checking), onClick: () => run(() => api.checkExitIp()) }, icon('refresh', 13));
  let value;
  if (!x || x.checking) value = h('span', { class: 'dim' }, h('span', { class: 'spinner xs' }), ' ', t('exitIp_checking'));
  else if (x.error) value = h('span', { class: 'dim', title: x.error }, t('exitIp_unknown'));
  else value = h('span', { class: 'exit-ip', title: x.cc ? countryName(x.cc) : '' }, x.cc ? `${flagOf(x.cc)} ` : '', h('bdi', { dir: 'ltr', class: 'ltr mono' }, ui.hideAddr ? maskAddress(x.ip) : x.ip));
  return h('span', { class: 'exit-ip-line' }, h('span', { class: 'dim' }, `${t('exitIp')}:`), value, refresh);
}

// --------------------------------------------------------------------------- table
function sortedList() {
  const q = ui.query.trim().toLowerCase();
  let list = serversInGroup();
  if (q) list = list.filter((s) => `${s.remark} ${s.address} ${s.port} ${s.protocol} ${s.transport}`.toLowerCase().includes(q));
  const { key, dir } = ui.sort;
  if (key) {
    const val = (s) => {
      if (key === 'name') return serverName(s).toLowerCase();
      const v = s[key];
      return v === undefined ? Infinity : v < 0 ? Infinity - 1 : v;
    };
    list = list.slice().sort((a, b) => {
      const A = val(a); const B = val(b);
      if (key === 'speed') { const x = (b.speed || -1) - (a.speed || -1); return dir * x; }
      return dir * (A < B ? -1 : A > B ? 1 : 0);
    });
  }
  return list;
}

function liveCell(s, cls) {
  const t0 = ui.testing.started.get(s.id);
  if (t0 === undefined) return h('span', { class: `${cls} queued` }, h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), h('span', { class: 'dim' }, t('queued')));
  if (ui.testing.kind === 'speed') {
    const v = ui.testing.live.get(s.id);
    return h('span', { class: `${cls} live` }, h('span', { class: 'spinner' }), h('span', { class: 'live-val' }, v === undefined ? '…' : `${num(v)} ${t('mbps')}`));
  }
  return h('span', { class: `${cls} live` }, h('span', { class: 'spinner' }),
    h('span', { class: 'live-ms delay-ms', dataset: { liveId: s.id } }, `${num(Math.round(performance.now() - t0))} ${t('ms')}`));
}

const delayKinds = ['real', 'tcping'];
/** The UDP column appears once any server has a UDP result (or a UDP test is running). */
const showUdp = () => ui.testing.kind === 'udp' || S.servers.some((s) => s.udp !== undefined);

function delayCell(s) {
  if (ui.testing.ids.has(s.id) && delayKinds.includes(ui.testing.kind)) return liveCell(s, 'cell-delay');
  if (s.delay === undefined) return h('span', { class: 'cell-delay dim' }, '—');
  if (s.delay < 0) return h('span', { class: 'cell-delay' }, h('span', { class: 'bars' }, h('span'), h('span'), h('span')), h('span', { class: 'fail' }, t('failed')));
  const tier = delayTier(s.delay);
  return h('span', { class: `cell-delay ${ui.testing.justDone.has(s.id) ? 'pop' : ''}` },
    h('span', { class: `bars t${tier}`, 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
    h('span', { class: 'delay-ms' }, `${num(s.delay)} ${t('ms')}`),
    h('span', { class: 'delay-label' }, tier === 3 ? t('fast') : tier === 2 ? t('fair') : t('slow')));
}

function udpCell(s) {
  if (ui.testing.ids.has(s.id) && ui.testing.kind === 'udp') return liveCell(s, 'cell-udp');
  if (s.udp === undefined) return h('span', { class: 'cell-udp dim' }, '—');
  if (s.udp < 0) return h('span', { class: 'cell-udp fail', title: t('udp_failed') }, t('udp_no'));
  return h('span', { class: `cell-udp delay-ms ${ui.testing.justDone.has(s.id) ? 'pop' : ''}` }, `${num(s.udp)} ${t('ms')}`);
}

function speedCell(s) {
  if (ui.testing.ids.has(s.id) && ui.testing.kind === 'speed') return liveCell(s, 'cell-speed');
  if (s.speed === undefined) return h('span', { class: 'cell-speed dim' }, '—');
  if (s.speed < 0) return h('span', { class: 'fail' }, t('failed'));
  return h('span', { class: `cell-speed ${ui.testing.justDone.has(s.id) ? 'pop' : ''}` }, `${num(s.speed)} ${t('mbps')}`);
}

/** Protocol badge / transport text; groups show their size and how they choose. */
function protoLabel(s) { return s.protocol === 'shadowsocks' ? 'SS' : s.protocol === 'group' ? t('grp_badge') : s.protocol.toUpperCase(); }
function transportText(s) {
  if (s.protocol !== 'group') return s.via ? `${s.transport} → ${t('chain_badge')}` : s.transport;
  const n = (s.members || []).length;
  return `${s.memberSub ? `${n ? `${num(n)} + ` : ''}${(S.subs.find((x) => x.id === s.memberSub) || {}).name || ''}` : num(n)} · ${t(`grp_s_${s.strategy || 'leastPing'}`)}`;
}

// Columns: the user can hide any but the name (header right-click or Settings); widths follow the window.
const COL_WIDTH = {
  name: 'minmax(170px, 1.7fr)', address: 'minmax(110px, 1.3fr)', port: 'minmax(56px, .5fr)', protocol: 'minmax(130px, 1.1fr)',
  delay: 'minmax(150px, 1.15fr)', udp: 'minmax(70px, .6fr)', speed: 'minmax(80px, .8fr)',
};
const OPTIONAL_COLS = ['address', 'port', 'protocol', 'delay', 'speed'];
function visibleCols(udp) {
  const hidden = new Set(S.settings.hiddenCols || []);
  return ['name', ...['address', 'port', 'protocol', 'delay'].filter((c) => !hidden.has(c)), ...(udp ? ['udp'] : []), ...(hidden.has('speed') ? [] : ['speed'])];
}
export function columnsMenu(at) {
  const hidden = new Set(S.settings.hiddenCols || []);
  showMenu(at, OPTIONAL_COLS.map((c) => ({
    label: t(c === 'address' ? 'col_address' : `col_${c}`), icon: hidden.has(c) ? null : 'check', checked: !hidden.has(c),
    onClick: () => { if (hidden.has(c)) hidden.delete(c); else hidden.add(c); run(() => api.setSettings({ hiddenCols: [...hidden] })); },
  })));
}

/** Drag a row onto another to move it there (only in the list's own order, without search). */
let dragId = '';
const canDrag = () => !ui.sort.key && !ui.query.trim();

function row(s, list, udp) {
  const cols = visibleCols(udp);
  const isActive = s.id === S.activeId;
  const sub = s.subId ? S.subs.find((x) => x.id === s.subId) : null;
  const cls = `trow srow ${isActive ? 'active' : ''} ${ui.selected.has(s.id) ? 'sel' : ''}`;
  return h('div', {
    class: cls, role: 'row', tabindex: '0', 'aria-selected': String(ui.selected.has(s.id)), dataset: { id: s.id }, 'data-key': `s-${s.id}`,
    onClick: (e) => clickRow(e, s, list),
    onDblclick: () => useServer(s.id),
    onContextmenu: (e) => {
      e.preventDefault();
      if (!ui.selected.has(s.id)) { ui.selected = new Set([s.id]); render(); }
      rowMenu({ x: e.clientX, y: e.clientY }, s);
    },
    draggable: canDrag() ? 'true' : undefined,
    onDragstart: (e) => { dragId = s.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s.id); e.currentTarget.classList.add('dragging'); },
    onDragend: (e) => { e.currentTarget.classList.remove('dragging'); document.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before')); },
    onDragover: (e) => { if (dragId && dragId !== s.id) { e.preventDefault(); e.currentTarget.classList.add('drop-before'); } },
    onDragleave: (e) => e.currentTarget.classList.remove('drop-before'),
    onDrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove('drop-before'); if (dragId && dragId !== s.id) run(() => api.moveServer(dragId, `before:${s.id}`)); dragId = ''; },
  },
  ...cellsOf(s, sub, isActive, cols));
}

// --------------------------------------------------------------------------- virtual list
// A long list (a big subscription can hold thousands) draws only the rows on screen plus a margin;
// two spacers stand for the rest, so search, live numbers and test results stay instant.
const VIRTUAL_MIN = 150;
const OVERSCAN = 15;
const vw = { start: 0, end: 60, rowH: 43, gap: 2 }; // rowH = distance from one row to the next

function rowsWindow(list, udp) {
  if (list.length <= VIRTUAL_MIN) return list.map((s) => row(s, list, udp));
  const start = Math.max(0, Math.min(vw.start, list.length - 1));
  const end = Math.min(list.length, Math.max(vw.end, start + 1));
  requestAnimationFrame(() => { if (updateWindow()) vrender(); }); // the list or the window size may have changed
  return [
    h('div', { class: 'vspace', 'data-key': 'v-top', 'aria-hidden': 'true', style: { height: `${Math.max(0, start * vw.rowH - vw.gap)}px` } }),
    ...list.slice(start, end).map((s) => row(s, list, udp)),
    h('div', { class: 'vspace', 'data-key': 'v-bot', 'aria-hidden': 'true', style: { height: `${Math.max(0, (list.length - end) * vw.rowH - vw.gap)}px` } }),
  ];
}

function scrollerOf(el) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** Work out which rows are on screen; true when the drawn window has to move. */
function updateWindow() {
  const top = document.querySelector('.servers .table [data-key="v-top"]');
  if (!top) return false;
  const first = top.nextElementSibling;
  const second = first && first.nextElementSibling;
  if (first && second && first.classList.contains('srow') && second.classList.contains('srow')) {
    const pitch = second.getBoundingClientRect().top - first.getBoundingClientRect().top;
    vw.gap = parseFloat(getComputedStyle(top.parentElement).rowGap) || 0;
    if (pitch > 10 && Math.abs(pitch - vw.rowH) > 0.5) { vw.rowH = pitch; vw.start = -1; } // density or zoom changed: redraw
  }
  const sc = scrollerOf(top);
  const view = sc ? sc.getBoundingClientRect() : { top: 0, bottom: innerHeight };
  const listTop = top.getBoundingClientRect().top; // where row 0 would be (the spacer stands for the rows above)
  const from = Math.max(0, Math.floor((view.top - listTop) / vw.rowH));
  const to = Math.max(from + 1, Math.ceil((view.bottom - listTop) / vw.rowH));
  if (vw.start >= 0 && from >= vw.start && to <= vw.end) return false;
  vw.start = Math.max(0, from - OVERSCAN);
  vw.end = to + OVERSCAN;
  return true;
}

/** Redraw after the window moved, keeping keyboard focus on the same server row. */
function vrender() {
  const a = document.activeElement;
  const fid = a && a.classList && a.classList.contains('srow') ? a.dataset.id : '';
  render();
  if (fid && document.activeElement !== a) {
    const el = document.querySelector(`.srow[data-id="${fid}"]`);
    if (el) el.focus({ preventScroll: true });
  }
}

let vPending = false;
const onViewChange = () => {
  if (vPending) return;
  vPending = true;
  requestAnimationFrame(() => { vPending = false; if (updateWindow()) vrender(); });
};
document.addEventListener('scroll', onViewChange, { capture: true, passive: true });
window.addEventListener('resize', onViewChange);

/** Focus a row, scrolling it into the drawn window first when the list is virtual. */
function revealRow(id, list) {
  let el = document.querySelector(`.srow[data-id="${id}"]`);
  const top = document.querySelector('.servers .table [data-key="v-top"]');
  if (!el && top) {
    const i = list.findIndex((s) => s.id === id);
    const sc = scrollerOf(top);
    if (i >= 0 && sc) {
      const y = top.getBoundingClientRect().top + i * vw.rowH;
      const v = sc.getBoundingClientRect();
      if (y < v.top) sc.scrollTop -= v.top - y; else if (y + vw.rowH > v.bottom) sc.scrollTop += y + vw.rowH - v.bottom;
      updateWindow(); vrender();
      el = document.querySelector(`.srow[data-id="${id}"]`);
    }
  }
  if (el) { el.focus(); el.scrollIntoView({ block: 'nearest' }); }
}

function cellsOf(s, sub, isActive, cols) {
  const cell = {
  name: () => h('span', { class: 'cell-name', role: 'cell' },
    h('span', { class: 'n1', title: serverName(s) }, serverName(s)),
    ui.group === 'all' ? h('span', { class: 'n2' }, sub ? sub.name : t('group_manual')) : null,
    isActive ? h('span', { class: `pill ${S.core.running ? 'accent' : 'soft'}` }, t('inUse')) : null),
  address: () => h('span', { class: 'cell-addr', role: 'cell', title: ui.hideAddr ? '' : s.address }, ui.hideAddr ? maskAddress(s.address) : s.address),
  port: () => h('span', { class: 'cell-port', role: 'cell' }, s.port ? String(s.port) : '—'),
  protocol: () => h('span', { class: 'cell-proto', role: 'cell' }, h('span', { class: 'proto' }, protoLabel(s)), h('span', { class: 'tr', title: transportText(s) }, transportText(s)),
    s.plain ? h('span', { class: 'plain-badge', title: `${t('unencrypted')} — ${t('unencrypted_warn')}`, 'aria-label': t('unencrypted'), role: 'img' }, icon('alert', 14)) : null),
  delay: () => h('span', { role: 'cell', class: 'delay-slot' }, delayCell(s)),
  udp: () => h('span', { role: 'cell', class: 'udp-slot' }, udpCell(s)),
  speed: () => h('span', { role: 'cell', class: 'speed-slot' }, speedCell(s)),
  };
  return cols.map((c) => cell[c]());
}

/** Overall progress of a running test: "Real delay · 12 / 26" with a bar and a stop button. */
function testProgress() {
  const T = ui.testing;
  if (!T.kind) return null;
  const pct = T.total ? Math.round((T.done / T.total) * 100) : 0;
  return h('div', { class: 'test-progress', id: 'test-progress', role: 'status' },
    h('span', { class: 'spinner' }),
    h('span', { class: 'tp-label' }, t(T.kind === 'speed' ? 'test_speed' : T.kind === 'tcping' ? 'test_tcping' : T.kind === 'udp' ? 'test_udp' : 'test_real')),
    h('span', { class: 'tp-count', id: 'tp-count' }, t('tp_count', { done: num(T.done), total: num(T.total) })),
    h('span', { class: 'tp-bar' }, h('span', { id: 'tp-fill', style: { width: `${pct}%` } })),
    button(t('test_cancel'), { size: 'sm', variant: 'ghost', icon: 'pause', onClick: () => api.cancelTest() }));
}

function updateProgress() {
  const T = ui.testing;
  const c = document.getElementById('tp-count');
  if (c) c.textContent = t('tp_count', { done: num(T.done), total: num(T.total) });
  const f = document.getElementById('tp-fill');
  if (f) f.style.width = `${T.total ? Math.round((T.done / T.total) * 100) : 0}%`;
}

// Tick the live millisecond counters of servers that are being tested right now.
setInterval(() => {
  if (!ui.testing.kind || !ui.testing.started.size) return;
  const now = performance.now();
  document.querySelectorAll('.live-ms').forEach((el) => {
    const t0 = ui.testing.started.get(el.dataset.liveId);
    if (t0 !== undefined) el.textContent = `${num(Math.round(now - t0))} ${t('ms')}`;
  });
}, 50);

/** Called for every streamed test event: update just that row's cells and the progress bar. */
export function onTestResult(id) {
  updateProgress();
  const el = document.querySelector(`.srow[data-id="${id}"]`);
  const s = S.servers.find((x) => x.id === id);
  if (!el || !s) return;
  // While a server is still running only the number changes: rebuilding the cell would restart
  // the spinner animation on every progress tick.
  const T = ui.testing;
  const running = T.ids.has(id) && T.started.has(id);
  const d = el.querySelector('.delay-slot');
  if (d && !(running && delayKinds.includes(T.kind) && d.querySelector('.live-ms'))) mount(d, delayCell(s));
  const u = el.querySelector('.udp-slot');
  if (u && !(running && T.kind === 'udp' && u.querySelector('.live-ms'))) mount(u, udpCell(s));
  const sp = el.querySelector('.speed-slot');
  const liveVal = sp && sp.querySelector('.live-val');
  if (running && T.kind === 'speed' && liveVal) {
    const v = T.live.get(id);
    liveVal.textContent = v === undefined ? '…' : `${num(v)} ${t('mbps')}`;
  } else if (sp) {
    mount(sp, speedCell(s));
  }
}

function clickRow(e, s, list) {
  if (e.shiftKey && ui.lastClicked) {
    const a = list.findIndex((x) => x.id === ui.lastClicked);
    const b = list.findIndex((x) => x.id === s.id);
    if (a >= 0 && b >= 0) {
      const [from, to] = a < b ? [a, b] : [b, a];
      if (!e.ctrlKey && !(IS_MAC && e.metaKey)) ui.selected = new Set();
      for (let i = from; i <= to; i++) ui.selected.add(list[i].id);
    }
  } else if (e.ctrlKey || e.metaKey) {
    if (ui.selected.has(s.id)) ui.selected.delete(s.id); else ui.selected.add(s.id);
    ui.lastClicked = s.id;
  } else {
    ui.selected = new Set([s.id]);
    ui.lastClicked = s.id;
  }
  render();
  const el = document.querySelector(`.srow[data-id="${s.id}"]`);
  if (el) el.focus();
}

async function useServer(id) {
  ui.busy = true;
  render();
  await run(() => api.selectServer(id));
  ui.busy = false;
  render();
}

function selectedIds() { return [...ui.selected]; }

async function deleteSelected() {
  const ids = selectedIds();
  if (!ids.length) return;
  const ok = await confirmDialog({ title: t('confirmDeleteTitle'), message: t('confirmDelete', { n: num(ids.length) }), confirmLabel: t('delete'), danger: true });
  if (!ok) return;
  await run(() => api.removeServers(ids));
  ui.selected.clear();
  toast(t('t_removed', { n: num(ids.length) }), 'success');
}

async function shareServer(id) {
  const r = await run(() => api.getQr(id));
  if (!r) return;
  modal({
    title: t('share_title'),
    body: h('div', { class: 'qr-box' },
      h('img', { src: r.dataUrl, alt: 'QR' }),
      h('div', { class: 'note warn' }, icon('alert', 16), h('span', null, t('share_warn'))),
      h('div', { class: 'ed-preview', style: { width: '100%' } }, h('div', { class: 'link' }, r.link))),
    actions: [
      { label: t('copy'), onClick: async () => { await api.copy(r.link); toast(t('copied'), 'success'); } },
      { label: t('close'), variant: 'primary', onClick: (c) => c() },
    ],
  });
}

function rowMenu(at, s) {
  const many = ui.selected.size > 1;
  const ids = selectedIds();
  const custom = s.protocol === 'custom';
  const noLink = custom || s.protocol === 'masque'; // no share-link format
  showMenu(at, [
    !many && { label: t('m_connect'), icon: 'power', onClick: () => useServer(s.id) },
    !many && { label: t('m_edit'), icon: 'edit', onClick: () => openEditor(s.id) },
    !many && !noLink && { label: t('m_share'), icon: 'qr', onClick: () => shareServer(s.id) },
    !noLink && { label: t('m_copyLink'), icon: 'copy', onClick: async () => { const n = await run(() => api.copyLinks(ids)); toast(t('t_linksCopied', { n: num(n || 0) }), 'success'); } },
    !many && { label: t('m_duplicate'), icon: 'copy', onClick: () => run(() => api.duplicateServer(s.id)) },
    'sep',
    { label: t('m_testReal'), icon: 'bolt', onClick: () => startTest(ids, 'real') },
    { label: t('m_testSpeed'), icon: 'gauge', onClick: () => startTest(ids, 'speed') },
    { label: t('m_testUdp'), icon: 'globe', onClick: () => startTest(ids, 'udp') },
    ...(!many ? ['sep',
      { label: t('m_moveTop'), icon: 'up', onClick: () => run(() => api.moveServer(s.id, 'top')) },
      { label: t('m_moveUp'), icon: 'up', onClick: () => run(() => api.moveServer(s.id, 'up')) },
      { label: t('m_moveDown'), icon: 'down', onClick: () => run(() => api.moveServer(s.id, 'down')) },
      { label: t('m_moveBottom'), icon: 'down', onClick: () => run(() => api.moveServer(s.id, 'bottom')) }] : []),
    'sep',
    { label: t('m_delete'), icon: 'trash', danger: true, onClick: deleteSelected },
  ].filter(Boolean));
}

function startTest(ids, kind) {
  if (!ids.length) return;

  ui.testing = newTesting(kind, ids);
  render();
  api.runTest(ids, kind);
}

async function useFastest() {
  const pickBest = () => {
    const list = serversInGroup().filter((s) => s.delay > 0);
    if (!list.length) { toast(t('t_noFastest'), 'warning'); return; }
    const best = list.reduce((a, b) => (b.delay < a.delay ? b : a));
    ui.busy = true; render();
    run(async () => {
      await api.selectServer(best.id);
    }).finally(() => { ui.busy = false; render(); });
  };
  const group = serversInGroup();
  if (!group.some((s) => s.delay > 0)) {
    ui.afterTest = pickBest;
    startTest(group.filter((s) => s.protocol !== 'custom' && s.protocol !== 'group').map((s) => s.id), 'real');
  } else pickBest();
}

async function importResult(promise) {
  const r = await run(() => promise);
  if (!r) return;
  if (r.needPermission) { toast(t('t_screenPermission'), 'warning'); return; }
  if (r.notFound) { toast(t('t_noQr'), 'warning'); return; }
  if (r.subs) {
    for (const s of r.subs) {
      if (s.ok) toast(t('t_subAdded', { name: s.name, n: num(s.count) }), 'success');
      else toast(t('t_subFailed', { name: s.name, e: s.error }), 'error', 7000);
    }
    const last = r.subs[r.subs.length - 1];
    if (last) { ui.group = last.id; localSet('group', last.id); render(); }
    return;
  }
  if (!r.added) toast(r.dup ? t('t_importedDup', { added: num(0), dup: num(r.dup) }) : t('t_nothingImported'), r.dup ? 'info' : 'warning');
  else toast(r.dup ? t('t_importedDup', { added: num(r.added), dup: num(r.dup) }) : t('t_imported', { added: num(r.added) }), 'success');
  if (r.amnezia) toast(t('AMNEZIA_UNSUPPORTED'), 'warning', 7000);
  else if (r.errors) toast(t('t_importErrors', { n: num(r.errors) }), 'warning');
}

function addMenu(anchor) {
  showMenu(anchor, [
    { label: t('add_clipboard'), icon: 'clipboard', onClick: () => importResult(api.importClipboard()) },
    { label: t('add_scan'), icon: 'scan', onClick: () => importResult(api.scanScreen()) },
    { label: t('add_file'), icon: 'file', onClick: () => importResult(api.openConfigFile()) },
    'sep',
    { label: t('add_manual'), icon: 'plus', onClick: () => openEditor(null) },
    { label: t('add_custom'), icon: 'code', onClick: () => openEditor(null, { protocol: 'custom' }) },
    { label: t('add_group'), icon: 'servers', onClick: () => openEditor(null, { protocol: 'group' }) },
  ]);
}

function testMenu(anchor) {
  const ids = (ui.selected.size ? selectedIds() : sortedList().map((s) => s.id));
  const testing = ui.testing.kind;
  showMenu(anchor, [
    { label: t('test_real'), icon: 'bolt', onClick: () => startTest(ids, 'real') },
    { label: t('test_tcping'), icon: 'link', onClick: () => startTest(ids, 'tcping') },
    { label: t('test_speed'), icon: 'gauge', onClick: () => startTest(ids, 'speed') },
    { label: t('test_udp'), icon: 'globe', onClick: () => startTest(ids, 'udp') },
    'sep',
    { label: t('test_cancel'), icon: 'pause', disabled: !testing, onClick: () => api.cancelTest() },
    { label: t('test_clear'), icon: 'close', onClick: () => run(() => api.clearResults()) },
    'sep',
    { label: t('removeDuplicates'), icon: 'copy', onClick: async () => { const n = await run(() => api.removeDuplicates()); toast(t('t_removed', { n: num(n || 0) }), 'success'); } },
    { label: t('removeFailed'), icon: 'trash', danger: true, onClick: async () => { const n = await run(() => api.removeFailed()); toast(t('t_removed', { n: num(n || 0) }), 'success'); } },
  ]);
}

async function updateGroup() {
  const ids = ui.group === 'all' || ui.group === 'manual' ? undefined : [ui.group];
  const btn = document.querySelector('[data-keep="update-btn"]');
  if (btn) btn.disabled = true;
  const res = await run(() => api.updateSubs(ids));
  if (btn) btn.disabled = false;
  for (const r of res || []) {
    const sub = S.subs.find((s) => s.id === r.id) || { name: '' };
    if (r.ok) toast(t('t_subUpdated', { name: sub.name, n: num(r.count) }), 'success');
    else toast(t('t_subFailed', { name: sub.name, e: r.error }), 'error', 7000);
  }
}

function subInfo(sub) {
  const i = sub.info || {};
  const used = (i.upload || 0) + (i.download || 0);
  let exp = t('never');
  if (i.expire) {
    const days = Math.ceil((i.expire * 1000 - Date.now()) / 86400000);
    exp = days < 0 ? t('expired') : t('daysLeft', { n: num(days) });
  }
  return h('div', null, h('div', { class: 'subinfo' },
    h('b', null, sub.name),
    h('span', { class: 'usage' }, `${t('traffic')}: `,
      i.total
        ? [h('span', { class: 'usage-bar' }, h('span', { style: { width: `${Math.min(100, (used / i.total) * 100)}%` } })), `${formatBytes(used)} / ${formatBytes(i.total)}`]
        : [h('span', { class: 'usage-bar unlimited', title: t('unlimited') }, h('span')), `${used ? formatBytes(used) : formatBytes(0)} / ∞`]),
    h('span', null, `${t('expires')}: ${exp}`),
    ...(sub.notice ? [] : (sub.infoNodes || []).slice(0, 3).map((n) => h('span', { class: 'dim' }, n))),
    h('span', { class: 'grow' }),
    ...subLinks(sub)),
    subNotices(sub));
}

/** Panel links (support / web page): opened in the browser only on click. */
export function subLinks(sub) {
  return [
    sub.supportUrl ? button(t('sub_support'), { size: 'sm', variant: 'ghost', icon: 'info', title: sub.supportUrl, onClick: () => api.openSubLink(sub.id, 'support') }) : null,
    sub.webPageUrl ? button(t('sub_webPage'), { size: 'sm', variant: 'ghost', icon: 'globe', title: sub.webPageUrl, onClick: () => api.openSubLink(sub.id, 'web') }) : null,
  ];
}

/** Panel announcement and the expired / out-of-data message. */
export function subNotices(sub) {
  // Plain http to a public host (a local / LAN panel never leaves this network).
  const plain = /^http:\/\//i.test(sub.url || '') && !/^http:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/i.test(sub.url);
  if (!sub.notice && !sub.announce && !plain) return null;
  return h('div', { class: 'sub-notices' },
    plain ? h('div', { class: 'note warn' }, icon('alert', 16), h('span', null, t('sub_httpWarn'))) : null,
    sub.notice ? h('div', { class: 'note warn' }, icon('alert', 16), h('span', null, `${t('sub_blocked')} ${sub.notice}`)) : null,
    sub.announce ? h('div', { class: 'note' }, icon('info', 16), h('span', null, sub.announce)) : null);
}

function tableKeys(e, list) {
  const ids = list.map((s) => s.id);
  const cur = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.id : '';
  const idx = ids.indexOf(cur);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = ids[Math.max(0, Math.min(ids.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (!next) return;
    if (e.shiftKey) ui.selected.add(next); else ui.selected = new Set([next]);
    ui.lastClicked = next;
    render();
    revealRow(next, list);
  } else if (e.key === 'Enter' && cur) {
    useServer(cur);
  } else if (e.key === 'Delete' || (IS_MAC && e.key === 'Backspace' && e.metaKey)) { // macOS: ⌘⌫, as in Finder
    deleteSelected();
  } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyA') {
    e.preventDefault(); ui.selected = new Set(ids); render();
  } else if (e.key === 'F2' && cur) {
    openEditor(cur);
  }
}

function sortHeader(key, label) {
  const active = ui.sort.key === key;
  return h('button', {
    type: 'button', class: `sort ${active ? 'active' : ''} ${active && ui.sort.dir < 0 ? 'desc' : ''}`,
    'aria-pressed': String(active),
    onClick: () => {
      if (!active) ui.sort = { key, dir: 1 };
      else if (ui.sort.dir === 1) ui.sort = { key, dir: -1 };
      else ui.sort = { key: '', dir: 1 };
      render();
    },
  }, label, icon('chevron', 12, 2.4));
}

function serversCard() {
  const list = sortedList();
  const groups = groupsList();
  const currentSub = S.subs.find((s) => s.id === ui.group);
  const testing = Boolean(ui.testing.kind);

  const head = h('div', { class: 'servers-head' },
    h('div', { class: 'tabs', role: 'group', 'aria-label': t('nav_subs') },
      groups.map((g) => h('button', {
        type: 'button', class: 'tab', 'aria-pressed': String(ui.group === g.id),
        onClick: () => { ui.group = g.id; localSet('group', g.id); ui.selected.clear(); render(); },
      }, g.name, g.count ? h('span', { class: 'count' }, num(g.count)) : null)),
      h('button', { type: 'button', class: 'tab tab-add', 'aria-label': t('addSub'), title: t('addSub'), onClick: () => openSubEditor(null) }, icon('plus', 16))),
    h('div', { class: 'toolbar' },
      h('label', { class: 'search' }, icon('search', 16), h('span', { class: 'sr-only' }, t('search')),
        h('input', {
          type: 'search', value: ui.query, placeholder: t('search'), 'data-keep': 'search',
          onInput: (e) => { ui.query = e.target.value; render(); },
        })),
      button(t('add'), { icon: 'plus', onClick: (e) => addMenu(e.currentTarget) }),
      h('div', { class: 'split' },
        h('button', { type: 'button', class: 'btn split-main', disabled: testing, title: IS_MAC ? '⌘R' : 'Ctrl+R', onClick: () => serverActions.test('real') }, icon('bolt', 16), h('span', null, t('test_real'))),
        h('button', { type: 'button', class: 'btn split-more', 'aria-label': t('test_more'), title: t('test_more'), onClick: (e) => testMenu(e.currentTarget) }, icon('chevron', 16, 2.2))),
      h('button', { type: 'button', class: 'btn', 'data-keep': 'update-btn', disabled: !S.subs.length, onClick: updateGroup }, icon('refresh', 16), h('span', null, t('update'))),
      button(t('useFastest'), { variant: 'primary', icon: 'bolt', onClick: useFastest, disabled: testing })));

  const bulk = ui.selected.size > 1 ? h('div', { class: 'bulkbar' },
    h('span', { class: 'grow' }, t('selected', { n: num(ui.selected.size) })),
    button(t('test_real'), { size: 'sm', icon: 'bolt', onClick: () => startTest(selectedIds(), 'real') }),
    button(t('m_copyLink'), { size: 'sm', icon: 'copy', onClick: async () => { const n = await run(() => api.copyLinks(selectedIds())); toast(t('t_linksCopied', { n: num(n || 0) }), 'success'); } }),
    button(t('m_delete'), { size: 'sm', icon: 'trash', variant: 'danger', onClick: deleteSelected }),
    button(t('clearSelection'), { size: 'sm', variant: 'ghost', onClick: () => { ui.selected.clear(); render(); } })) : null;

  let content;
  const groupEmpty = serversInGroup().length === 0;
  if (groupEmpty) {
    content = currentSub
      ? h('div', { class: 'empty' }, h('h3', null, t('emptySub')), button(t('updateThisSub', { name: currentSub.name }), { icon: 'refresh', onClick: updateGroup }))
      : h('div', { class: 'empty' }, h('h3', null, t('emptyGroup')), h('p', null, t('emptyGroupHelp')),
        h('div', { class: 'row' },
          button(t('add_clipboard'), { variant: 'primary', icon: 'clipboard', onClick: () => importResult(api.importClipboard()) }),
          button(t('addSub'), { icon: 'subs', onClick: () => openSubEditor(null) })));
  } else if (!list.length) {
    content = h('div', { class: 'empty' }, h('p', null, t('noMatch', { q: ui.query })));
  } else {
    const udp = showUdp();
    const cols = visibleCols(udp);
    const head = {
      name: () => h('span', { role: 'columnheader' }, sortHeader('name', t('col_name'))),
      address: () => h('span', { role: 'columnheader', class: 'th-addr' }, t('col_address'),
          h('button', {
            type: 'button', class: 'th-eye', 'aria-pressed': String(ui.hideAddr),
            title: ui.hideAddr ? t('showAddresses') : t('hideAddresses'), 'aria-label': ui.hideAddr ? t('showAddresses') : t('hideAddresses'),
            onClick: () => { ui.hideAddr = !ui.hideAddr; localSet('hideAddr', ui.hideAddr ? '1' : '0'); render(); },
          }, icon(ui.hideAddr ? 'eyeOff' : 'eye', 15))),
      port: () => h('span', { role: 'columnheader' }, t('col_port')),
      protocol: () => h('span', { role: 'columnheader' }, t('col_protocol')),
      delay: () => h('span', { role: 'columnheader' }, sortHeader('delay', t('col_delay'))),
      udp: () => h('span', { role: 'columnheader', title: t('udp_help') }, sortHeader('udp', t('col_udp'))),
      speed: () => h('span', { role: 'columnheader' }, sortHeader('speed', t('col_speed'))),
    };
    content = h('div', { class: `table ${udp ? 'has-udp' : ''}`, role: 'table', 'aria-label': t('nav_servers'), style: { '--cols': cols.map((c) => COL_WIDTH[c]).join(' ') } },
      h('div', { class: 'trow thead', role: 'row', title: t('cols_hint'), onContextmenu: (e) => { e.preventDefault(); columnsMenu({ x: e.clientX, y: e.clientY }); } }, ...cols.map((c) => head[c]())),
      rowsWindow(list, udp));
  }

  return h('section', { class: 'card servers', 'aria-label': t('nav_servers') },
    head,
    currentSub ? subInfo(currentSub) : null,
    testProgress(),
    bulk,
    h('div', { class: 'table-wrap', 'data-scroll': 'servers', onKeydown: (e) => tableKeys(e, list) }, content));
}

/** Actions reachable from app-wide keyboard shortcuts. */
export const serverActions = {
  test(kind) {
    const ids = ui.selected.size ? selectedIds() : sortedList().filter((s) => s.protocol !== 'custom').map((s) => s.id);
    startTest(ids, kind);
  },
  useFastest,
  updateSubs: updateGroup,
  importClipboard: () => importResult(api.importClipboard()),
  copySelected() {
    if (!ui.selected.size) return false;
    run(() => api.copyLinks(selectedIds())).then((n) => toast(t('t_linksCopied', { n: num(n || 0) }), 'success'));
    return true;
  },
  scanScreen: () => importResult(api.scanScreen()),
  focusSearch() { const el = document.querySelector('[data-keep="search"]'); if (el) { el.focus(); el.select(); } },
  toggleLogs() { ui.logsOpen = !ui.logsOpen; render(); },
};

// --------------------------------------------------------------------------- log strip
function logStrip() {
  const last = ui.logs[ui.logs.length - 1];
  return h('section', { class: 'logstrip', 'aria-label': t('logs') },
    h('div', { class: 'logstrip-head' },
      icon('logs', 16),
      h('span', { class: `logstrip-last ${last ? '' : 'is-empty'}`, id: 'log-last' }, last ? `${last.time}  ${last.text}` : t('noLogs')),
      button(ui.logsOpen ? t('hideLogs') : t('showLogs'), { size: 'sm', onClick: () => { ui.logsOpen = !ui.logsOpen; render(); } }),
      button('', { size: 'sm', icon: 'logs', variant: 'ghost', title: t('nav_logs'), onClick: () => go('logs') })),
    ui.logsOpen ? h('div', { class: 'logstrip-body', id: 'log-strip-body', 'data-scroll': 'logstrip' }, ui.logs.slice(-200).map(logLine)) : null);
}

export function renderServers() {
  const page = h('div', { class: 'page', 'data-scroll': 'page-servers' }, connectionCard(), serversCard(), logStrip());
  queueMicrotask(() => {
    const b = document.getElementById('log-strip-body');
    if (b && !b.dataset.scrolled) { b.scrollTop = b.scrollHeight; }
  });
  return page;
}
