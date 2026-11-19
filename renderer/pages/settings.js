// Settings page.

import { h, icon, button, toggle, select, field, segmented, confirmDialog, passwordDialog, modal, toast, ltr } from '../dom.js';
import { t, locale } from '../i18n.js';
import { S, ui, api, run } from '../app.js';

const set = (patch) => run(() => api.setSettings(patch));

/** Text / number input that saves when the user leaves the field (or presses Enter). */
function commitInput(key, { type = 'text', ltrDir = true, min, max, placeholder, secret } = {}) {
  return h('input', {
    class: `input ${ltrDir ? 'mono' : ''}`, type: secret ? 'password' : type, value: String(S.settings[key] ?? ''),
    dir: ltrDir ? 'ltr' : undefined, min, max, placeholder, spellcheck: 'false', autocomplete: 'off', 'data-keep': `set-${key}`,
    onChange: (e) => {
      const v = type === 'number' ? Number(e.currentTarget.value) : e.currentTarget.value;
      if (v !== S.settings[key]) set({ [key]: v });
    },
    onKeydown: (e) => { if (e.key === 'Enter') e.currentTarget.blur(); },
  });
}

/** Pick a backup on the WebDAV server, then restore it with its password. */
async function davRestoreDialog() {
  const list = await run(() => api.davList());
  if (!list) return;
  if (!list.length) { toast(t('webdav_empty'), 'warning'); return; }
  const fmt = (ms) => (ms ? new Date(ms).toLocaleString(locale()) : '');
  modal({
    title: t('webdavRestore'),
    body: h('div', { class: 'grp-list' }, list.map((b) => h('button', {
      type: 'button', class: 'grp-row', style: { textAlign: 'start', background: 'none', border: 0, color: 'inherit', width: '100%' },
      onClick: async () => {
        document.querySelector('.overlay')?.remove();
        if (!(await confirmDialog({ title: t('importBackup'), message: t('importBackup_confirm'), confirmLabel: t('importBackup'), danger: true }))) return;
        let r = await run(() => api.davRestore(b.name));
        while (r && r.needPassword) {
          const pw = await passwordDialog({ title: t('importBackup'), message: t('backup_pw_enter') });
          if (!pw) return;
          r = await api.importBackup(pw).catch((e) => {
            const bad = /BACKUP_BAD_PASSWORD/.test(String(e && e.message));
            toast(bad ? t('BACKUP_BAD_PASSWORD') : String(e && e.message), 'error');
            return bad ? { needPassword: true } : false;
          });
        }
        if (r) toast(t('t_backupRestored'), 'success');
      },
    }, icon('file', 16), h('span', { class: 'grow mono' }, b.name), h('span', { class: 'dim' }, fmt(b.modified))))),
    actions: [{ label: t('close'), onClick: (close) => close() }],
  });
}

/** Store (UWP) apps allowed to use the local proxy (Windows loopback exemption). */
async function storeAppsDialog() {
  const apps = await run(() => api.listStoreApps());
  if (!apps) return;
  const chosen = new Set(apps.filter((a) => a.exempt).map((a) => a.pfn));
  const before = new Set(chosen);
  const pretty = (n) => (/^[0-9A-Za-z]+\./.test(n) && n.indexOf('.') < n.length - 1 ? n.slice(n.indexOf('.') + 1) : n);
  const list = h('div', { class: 'grp-list', style: { maxHeight: '360px' } });
  let q = '';
  const paint = () => {
    const qq = q.toLowerCase();
    list.replaceChildren(...apps.filter((a) => !qq || a.pfn.toLowerCase().includes(qq)).map((a) => h('label', { class: 'grp-row' },
      h('input', { type: 'checkbox', checked: chosen.has(a.pfn), onChange: (e) => { if (e.target.checked) chosen.add(a.pfn); else chosen.delete(a.pfn); } }),
      h('span', { class: 'grow' }, pretty(a.name)),
      h('span', { class: 'dim mono', style: { fontSize: '11px' } }, a.pfn))));
  };
  paint();
  const search = h('input', { class: 'input', type: 'search', placeholder: t('searchList'), onInput: (e) => { q = e.target.value; paint(); } });
  modal({
    title: t('sec_uwp'), wide: true,
    body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('uwp_dialog')), h('div', { class: 'row' },
      h('div', { class: 'grow' }, search),
      button(t('uwp_all'), { size: 'sm', variant: 'ghost', onClick: () => { apps.forEach((a) => chosen.add(a.pfn)); paint(); } }),
      button(t('uwp_none'), { size: 'sm', variant: 'ghost', onClick: () => { chosen.clear(); paint(); } })), list),
    actions: [
      { label: t('cancel'), onClick: (close) => close() },
      { label: t('uwp_apply'), variant: 'primary', onClick: async (close) => {
        const add = [...chosen].filter((p) => !before.has(p));
        const remove = [...before].filter((p) => !chosen.has(p));
        close();
        if (!add.length && !remove.length) return;
        const ok = await run(() => api.setStoreApps(add, remove));
        toast(ok ? t('uwp_done', { n: chosen.size }) : t('uwp_declined'), ok ? 'success' : 'warning');
      } },
    ],
  });
}

// --------------------------------------------------------------------------- search
// Searches what the page shows (labels, help texts, notes, buttons, placeholders, setting keys),
// so anything added to Settings later is found without extra work. The list floats over the page
// (outside the redrawn area); choosing a result scrolls to it and makes it glow for a moment.

const norm = (v) => String(v || '').toLowerCase()
  .replace(/[\u064A\u0649]/g, 'ی').replace(/\u0643/g, 'ک').replace(/[\u200c\u200f\u200e]/g, '').replace(/\s+/g, ' ').trim();

function settingTargets() {
  const out = [];
  for (const card of document.querySelectorAll('.settings > .card')) {
    const section = card.querySelector('h2')?.textContent.trim() || '';
    for (const el of card.querySelectorAll('.field, .switch-row, .note, .card > .row, .kvtable')) {
      if (el.closest('.field') && el.closest('.field') !== el) continue; // a field's own parts belong to the field
      if (el.closest('.switch-row') && el.closest('.switch-row') !== el) continue;
      const label = (el.querySelector(':scope > .field-label, :scope > .txt > span:first-child')?.textContent
        || [...el.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).join(' · ')
        || el.textContent).trim().replace(/\s+/g, ' ').slice(0, 90);
      const extra = [...el.querySelectorAll('[placeholder], [aria-label], [title], [data-keep], [data-s]')]
        .map((x) => [x.getAttribute('placeholder'), x.getAttribute('aria-label'), x.getAttribute('title'), (x.getAttribute('data-keep') || '').replace(/^set-|^hk-/, ''), x.getAttribute('data-s')].join(' ')).join(' ');
      out.push({ el, section, label, text: norm(`${section} ${el.textContent} ${el.getAttribute('data-s') || ''} ${extra}`) });
    }
  }
  return out;
}

let findList = null;
let findItems = [];
let findIndex = 0;
function closeFind() {
  if (findList) findList.remove();
  findList = null; findItems = []; findIndex = 0;
  document.removeEventListener('mousedown', outsideFind, true);
}
function outsideFind(e) { if (findList && !findList.contains(e.target) && !e.target.closest('.set-find')) closeFind(); }

function findSettings(input) {
  const q = norm(input.value);
  if (!q) { closeFind(); return; }
  const words = q.split(' ');
  // the setting's own name first, then its section, then help texts and notes
  const rank = (x) => (words.every((w) => norm(x.label).includes(w)) ? 0 : words.every((w) => norm(x.section).includes(w)) ? 1 : 2);
  findItems = settingTargets().filter((x) => words.every((w) => x.text.includes(w)))
    .map((x, i) => ({ x, r: rank(x), i })).sort((a, b) => a.r - b.r || a.i - b.i).map((o) => o.x).slice(0, 12);
  findIndex = 0;
  if (!findList) {
    findList = h('div', { class: 'set-find-list', id: 'set-find-list', role: 'listbox' });
    document.body.append(findList);
    document.addEventListener('mousedown', outsideFind, true);
  }
  const r = input.getBoundingClientRect();
  Object.assign(findList.style, { top: `${Math.round(r.bottom + 6)}px`, left: `${Math.round(r.left)}px`, width: `${Math.round(Math.max(r.width, 340))}px` });
  if (r.left + Math.max(r.width, 340) > window.innerWidth - 8) findList.style.left = `${Math.round(window.innerWidth - Math.max(r.width, 340) - 8)}px`;
  paintFind();
}

function paintFind() {
  if (!findList) return;
  findList.replaceChildren(...(findItems.length ? findItems.map((x, i) => h('button', {
    type: 'button', class: `set-find-item ${i === findIndex ? 'on' : ''}`, role: 'option', 'aria-selected': String(i === findIndex),
    onMousedown: (e) => e.preventDefault(), // keep the search box focused until the jump
    onClick: () => goToSetting(x),
  }, h('span', { class: 'set-find-label' }, x.label), h('span', { class: 'set-find-sec' }, x.section)))
    : [h('div', { class: 'set-find-none' }, t('set_noResult'))]));
}

function findKeys(e) {
  if (e.key === 'Escape') { if (findList) { e.preventDefault(); e.stopPropagation(); closeFind(); } return; }
  if (!findItems.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    findIndex = (findIndex + (e.key === 'ArrowDown' ? 1 : findItems.length - 1)) % findItems.length;
    paintFind();
    findList.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    goToSetting(findItems[findIndex]);
  }
}

/** Smoothly scroll the page so `el` is in the middle. (The built-in smooth scrolling does not run in
 *  the app window, so it is animated here, 0.35 s.) */
function scrollToCenter(el) {
  const page = el.closest('[data-scroll]');
  if (!page) return;
  const pr = page.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  const from = page.scrollTop;
  const to = Math.max(0, Math.min(page.scrollHeight - page.clientHeight, from + (er.top - pr.top) - (page.clientHeight - er.height) / 2));
  if (Math.abs(to - from) < 2) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { page.scrollTop = to; return; }
  const start = performance.now();
  const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - ((-2 * p + 2) ** 3) / 2);
  const step = (now) => {
    const p = Math.min(1, (now - start) / 350);
    page.scrollTop = from + (to - from) * ease(p);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function goToSetting(x) {
  closeFind();
  const el = x.el.isConnected ? x.el : null;
  if (!el) return;
  scrollToCenter(el);
  el.classList.remove('set-flash');
  void el.offsetWidth; // restart the glow if the same one is chosen twice
  el.classList.add('set-flash');
  setTimeout(() => el.classList.remove('set-flash'), 2200);
  const control = el.querySelector('input:not([type="checkbox"]), textarea, button.select-btn, button[role="switch"]');
  if (control) setTimeout(() => control.focus({ preventScroll: true }), 450);
}

/** Records a key combination ("Control+Alt+B"); Backspace / Delete clears it. */
function hotkeyInput(action) {
  const cur = (S.settings.hotkeys || {})[action] || '';
  const show = (acc) => acc.replace('Control', 'Ctrl');
  const el = h('input', { class: 'input mono', dir: 'ltr', readonly: true, value: show(cur), placeholder: t('hk_none'), 'data-keep': `hk-${action}` });
  el.addEventListener('keydown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const save = (acc) => run(() => api.setSettings({ hotkeys: { ...(S.settings.hotkeys || {}), [action]: acc } }));
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey) { el.value = ''; save(''); return; }
    if (e.key === 'Escape') { el.blur(); return; }
    let key = '';
    if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
    else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
    else if (/^F([1-9]|1\d|2[0-4])$/.test(e.key)) key = e.key;
    else if (['Space', 'Home', 'End', 'Insert', 'Delete', 'PageUp', 'PageDown'].includes(e.code)) key = e.code;
    else if (/^Arrow(Up|Down|Left|Right)$/.test(e.code)) key = e.code.slice(5);
    const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
    if (!key || !mods.length) { el.value = mods.length ? `${mods.map(show).join('+')}+…` : el.value; return; }
    const acc = [...mods, key].join('+');
    el.value = show(acc);
    save(acc);
  });
  return el;
}

function switchRow(key, label, sub, { disabled } = {}) {
  return h('div', { class: 'switch-row', 'data-s': key },
    h('div', { class: 'txt' }, h('span', null, label), sub ? h('span', null, sub) : null),
    toggle(S.settings[key], (v) => set({ [key]: v }), { label, disabled }));
}

const THEMES = [
  { id: 'dark', a: '#0B0E12', b: '#151A21' },
  { id: 'midnight', a: '#080C18', b: '#111933' },
  { id: 'graphite', a: '#101010', b: '#1C1C1C' },
  { id: 'light', a: '#ECEEF2', b: '#FFFFFF' },
  { id: 'system', a: '#0B0E12', b: '#FFFFFF' },
];
const ACCENTS = { green: '#3DD68C', blue: '#5AA9FF', purple: '#B48CFF', orange: '#FF9F43', pink: '#FF6FAE' };

function card(title, ic, ...children) {
  return h('section', { class: 'card' }, h('h2', null, icon(ic, 18), title), ...children);
}

export function renderSettings() {
  const st = S.settings;
  const v = ui.versions || {};

  const appearance = card(t('sec_appearance'), 'eye',
    field(t('language'), segmented([{ value: 'fa', label: 'فارسی' }, { value: 'en', label: 'English' }, { value: 'ru', label: 'Русский' }, { value: 'zh', label: '中文' }], st.language, (x) => set({ language: x }), { label: t('language') })),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('theme')),
      h('div', { class: 'themes', role: 'group', 'aria-label': t('theme') }, THEMES.map((th) => h('button', {
        type: 'button', class: 'theme-opt', 'aria-pressed': String(st.theme === th.id), onClick: () => set({ theme: th.id }),
      }, h('span', { class: 'theme-swatch', 'aria-hidden': 'true' }, h('span', { style: { background: th.a } }), h('span', { style: { background: th.b } })), t(`theme_${th.id}`))))),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('accent')),
      h('div', { class: 'accents', role: 'group', 'aria-label': t('accent') }, Object.entries(ACCENTS).map(([id, c]) => h('button', {
        type: 'button', class: 'accent-opt', 'aria-pressed': String(st.accent === id), 'aria-label': id, title: id,
        style: { background: c }, onClick: () => set({ accent: id }),
      })))),
    field(t('density'), segmented(['comfortable', 'compact'].map((x) => ({ value: x, label: t(`density_${x}`) })), st.density, (x) => set({ density: x }), { label: t('density') })),
    field(t('uiZoom'), segmented([0.9, 1, 1.1, 1.25].map((x) => ({ value: x, label: `${Math.round(x * 100)}%` })), st.uiZoom || 1, (x) => set({ uiZoom: x }), { label: t('uiZoom') })),
    field(t('visibleCols'), h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px 14px' } }, ['address', 'port', 'protocol', 'delay', 'speed'].map((c) => h('label', { class: 'row', style: { gap: '6px' } },
      h('input', { type: 'checkbox', checked: !(st.hiddenCols || []).includes(c), onChange: (e) => { const s = new Set(st.hiddenCols || []); if (e.target.checked) s.delete(c); else s.add(c); set({ hiddenCols: [...s] }); } }),
      t(`col_${c}`))))));

  const startup = card(t('sec_startup'), 'play',
    h('div', null,
      switchRow('autoStart', t('autoStart')),
      switchRow('startMinimized', t('startMinimized')),
      switchRow('statsEnabled', t('statsEnabled')), switchRow('closeToTray', t('closeToTray')),
      switchRow('globalHotkey', t('globalHotkey'))),
    st.globalHotkey ? h('div', { class: 'grid2' }, ['toggleProxy', 'showWindow', 'proxyOn', 'proxyOff', 'toggleTun', 'disconnect'].map((k) => field(t(`hk_${k}`), hotkeyInput(k)))) : null,
    st.globalHotkey ? h('div', { class: 'field-help' }, t('hk_help')) : null);

  const local = card(t('sec_local'), 'servers',
    h('div', { class: 'note' }, icon('info', 16), h('div', { class: 'stack', style: { gap: '6px' } }, h('span', null, t('local_help')), h('span', { class: 'dim' }, t('local_help_apps', { socks: st.socksPort })))),
    h('div', { class: 'grid3' },
      field(t('socksPort'), commitInput('socksPort', { type: 'number', min: 1025, max: 65535 })),
      field(t('httpPort'), commitInput('httpPort', { type: 'number', min: 1025, max: 65535 })),
      field(t('pacPort'), commitInput('pacPort', { type: 'number', min: 1025, max: 65535 }))),
    switchRow('allowLan', t('allowLan')),
    st.allowLan ? h('div', { class: 'note warn' }, icon('alert', 16), h('span', null, t('allowLan_warn'))) : null,
    st.allowLan ? h('div', { class: 'grid2' },
      field(t('lanSocksPort'), commitInput('lanSocksPort', { type: 'number', min: 1025, max: 65535 })),
      field(t('lanHttpPort'), commitInput('lanHttpPort', { type: 'number', min: 1025, max: 65535 })),
      field(t('lanUser'), commitInput('lanUser')),
      field(t('lanPass'), commitInput('lanPass', { secret: true }))) : null,
    st.allowLan ? h('div', { class: 'field-help' }, t('lanPorts_help')) : null,
    field(t('proxyBypass'), commitInput('proxyBypass')));

  const core = card(t('sec_core'), 'bolt',
    field(t('logLevel'), select(['debug', 'info', 'warning', 'error', 'none'].map((x) => ({ value: x, label: x })), st.logLevel, (x) => set({ logLevel: x }))),
    switchRow('logToFile', t('logToFile'), t('logToFile_help')),
    h('div', { class: 'grid3' },
      field(t('defaultFingerprint'), select(['', 'chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random', 'randomized'].map((x) => ({ value: x, label: x || t('none') })), st.defaultFingerprint || '', (x) => set({ defaultFingerprint: x }))),
      field(t('hy2Up'), commitInput('hy2UpMbps', { type: 'number', min: 0, max: 100000, placeholder: '0' })),
      field(t('hy2Down'), commitInput('hy2DownMbps', { type: 'number', min: 0, max: 100000, placeholder: '0' }))),
    h('div', { class: 'field-help' }, t('defaults_help')),
    switchRow('sbMux', t('sbMux'), t('sbMux_help')),
    st.sbMux ? h('div', { class: 'grid3' },
      field(t('sbMuxProtocol'), select(['h2mux', 'smux', 'yamux'].map((x) => ({ value: x, label: x })), st.sbMuxProtocol, (x) => set({ sbMuxProtocol: x }))),
      field(t('sbMuxMax'), commitInput('sbMuxMax', { type: 'number', min: 1, max: 32 })),
      h('div', { style: { alignSelf: 'end' } }, switchRow('sbMuxPadding', t('sbMuxPadding')))) : null,
    h('div', { class: 'grid2' },
      field(t('bindInterface'), commitInput('bindInterface', { placeholder: t('auto') }), { help: t('bindInterface_help') }),
      field(t('sendThrough'), commitInput('sendThrough', { placeholder: t('auto') }), { help: t('sendThrough_help') })),
    h('div', { class: 'section-label', style: { marginTop: '6px' } }, t('coreFor')),
    h('div', { class: 'grid2' }, ['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria2', 'tuic', 'anytls', 'wireguard', 'socks', 'http'].map((p) => field(p === 'shadowsocks' ? 'Shadowsocks' : p.toUpperCase(),
      select([{ value: '', label: t('auto') }, { value: 'xray', label: 'Xray' }, { value: 'sing-box', label: 'sing-box' }, { value: 'mihomo', label: S.mihomo ? 'mihomo' : `mihomo (${t('upd_notInstalled')})` }], (st.coreFor || {})[p] || '', (v) => {
        const next = { ...(st.coreFor || {}) };
        if (v) next[p] = v; else delete next[p];
        set({ coreFor: next });
      })))),
    h('div', { class: 'field-help' }, t('coreFor_help')),
    h('div', null,
      switchRow('sniffing', t('sniffing')),
      switchRow('mux', t('mux'))),
    st.mux ? field(t('muxConcurrency'), commitInput('muxConcurrency', { type: 'number', min: 1, max: 128 })) : null,
    switchRow('fragment', t('fragment'), t('fragment_help')),
    st.fragment ? h('div', { class: 'grid3' },
      field(t('fragmentPackets'), select(['tlshello', '1-1', '1-2', '1-3', '1-5'].map((x) => ({ value: x, label: x })), st.fragmentPackets, (x) => set({ fragmentPackets: x }))),
      field(t('fragmentLength'), commitInput('fragmentLength')),
      field(t('fragmentInterval'), commitInput('fragmentInterval'))) : null);

  const dns = card(t('sec_dns'), 'globe',
    h('div', { class: 'note' }, icon('shield', 16), h('span', null, t('dns_help'))),
    field(t('remoteDns'), commitInput('remoteDns', { placeholder: 'https://1.1.1.1/dns-query' })),
    field(t('directDns'), commitInput('directDns', { placeholder: 'localhost' })),
    field(t('dnsHosts'), (() => {
      const ta = h('textarea', { class: 'input mono', rows: 4, dir: 'ltr', spellcheck: 'false', placeholder: 'example.com 1.2.3.4\nads.example 0.0.0.0', 'data-keep': 'set-dnsHosts' });
      ta.value = st.dnsHosts || '';
      ta.addEventListener('change', () => { if (ta.value !== S.settings.dnsHosts) set({ dnsHosts: ta.value }); });
      return ta;
    })(), { help: t('dnsHosts_help') }),
    h('div', null,
      switchRow('useSystemHosts', t('useSystemHosts')),
      switchRow('dnsIpv4Only', t('dnsIpv4Only')),
      switchRow('tunFakeIp', t('tunFakeIp'))));

  const tun = card(t('sec_tun'), 'shield',
    h('div', { class: 'note' }, icon('info', 16), h('span', null, t('tun_help'))),
    h('div', { class: `note ${S.isAdmin ? 'good' : 'warn'}` }, icon(S.isAdmin ? 'check' : 'alert', 16),
      h('span', { class: 'grow' }, S.isAdmin ? t('adminYes') : t('adminNo')),
      S.isAdmin ? null : button(t('runAsAdmin'), { size: 'sm', onClick: () => api.relaunchAdmin() })),
    S.secureCores === false ? h('div', { class: 'note warn' }, icon('alert', 16), h('span', null, t(S.portable ? 'tunPortableWarn' : 'tunUserInstallWarn'))) : null,
    switchRow('tun', t('tunMode'), null, { disabled: !S.isAdmin }),
    h('div', { class: 'grid2' },
      field(t('tunStack'), select(['mixed', 'gvisor', 'system'].map((x) => ({ value: x, label: x })), st.tunStack, (x) => set({ tunStack: x }))),
      field(t('tunMtu'), commitInput('tunMtu', { type: 'number', min: 1280, max: 65535 }))),
    h('div', null,
      switchRow('tunStrictRoute', t('tunStrictRoute')),
      switchRow('tunIpv6', t('tunIpv6'))),
    field(t('tunExclude'), (() => {
      const ta = h('textarea', { class: 'input mono', rows: 3, dir: 'ltr', spellcheck: 'false', placeholder: '192.168.0.0/16\n203.0.113.10', 'data-keep': 'set-tunExclude' });
      ta.value = st.tunExclude || '';
      ta.addEventListener('change', () => { if (ta.value !== S.settings.tunExclude) set({ tunExclude: ta.value }); });
      return ta;
    })(), { help: t('tunExclude_help') }));

  const subsTests = card(t('sec_subsTests'), 'refresh',
    field(t('subUserAgent'), commitInput('subUserAgent', { placeholder: `Best/${S.version}` }), { help: t('subUserAgent_help') }),
    switchRow('subViaProxy', t('subViaProxy')),
    switchRow('subHwid', t('subHwid'), t('subHwid_d')),
    st.subHwid ? field(t('subHwidName'), commitInput('subHwidName', { placeholder: 'Windows PC' }), { help: t('subHwidName_help') }) : null,
    field(t('subAutoUpdateHours'), commitInput('subAutoUpdateHours', { type: 'number', min: 0, max: 720 })),
    field(t('testUrl'), commitInput('testUrl')),
    field(t('speedTestUrl'), commitInput('speedTestUrl')),
    switchRow('showExitIp', t('showExitIp')),
    field(t('ipCheckUrl'), commitInput('ipCheckUrl', { placeholder: 'https://www.cloudflare.com/cdn-cgi/trace' }), { help: t('ipCheckUrl_help') }),
    field(t('udpTestTarget'), commitInput('udpTestTarget', { placeholder: 'pool.ntp.org:123' }), { help: t('udpTestTarget_help') }),
    h('div', { class: 'grid2' },
      field(t('testTimeout'), commitInput('testTimeout', { type: 'number', min: 1000, max: 30000 })),
      field(t('testConcurrency'), commitInput('testConcurrency', { type: 'number', min: 1, max: 32 }))));

  const uwp = card(t('sec_uwp'), 'shield',
    h('div', { class: 'note' }, icon('info', 16), h('span', null, t('uwp_help'))),
    h('div', { class: 'row' }, button(t('uwp_choose'), { icon: 'edit', onClick: storeAppsDialog })));

  const data = card(t('sec_data'), 'folder',
    h('div', { class: `note ${S.encrypted ? 'good' : 'warn'}` }, icon(S.encrypted ? 'shield' : 'alert', 16), h('span', null, S.encrypted ? t('encryptionOn') : t('encryptionOff'))),
    S.portable ? h('div', { class: 'note' }, icon('folder', 16), h('span', null, t('portableOn'))) : null,
    h('div', { class: 'note' }, icon('shield', 16), h('span', null, t('backup_warn'))),
    h('div', { class: 'row' },
      button(t('exportBackup'), {
        icon: 'download',
        onClick: async () => {
          const pw = await passwordDialog({ title: t('exportBackup'), message: t('backup_pw_set'), confirm: true });
          if (pw && await run(() => api.exportBackup(pw))) toast(t('t_backupSaved'), 'success');
        },
      }),
      button(t('importBackup'), {
        icon: 'upload',
        onClick: async () => {
          if (!(await confirmDialog({ title: t('importBackup'), message: t('importBackup_confirm'), confirmLabel: t('importBackup'), danger: true }))) return;
          let r = await run(() => api.importBackup());
          // Encrypted backup: ask for its password (again after a wrong one).
          while (r && r.needPassword) {
            const pw = await passwordDialog({ title: t('importBackup'), message: t('backup_pw_enter') });
            if (!pw) return;
            r = await api.importBackup(pw).catch((e) => {
              const bad = /BACKUP_BAD_PASSWORD/.test(String(e && e.message));
              toast(bad ? t('BACKUP_BAD_PASSWORD') : String(e && e.message), 'error');
              return bad ? { needPassword: true } : false;
            });
          }
          if (r) toast(t('t_backupRestored'), 'success');
        },
      }),
      button(t('openDataFolder'), { icon: 'folder', variant: 'ghost', onClick: () => api.openDataFolder() })),
    h('div', { class: 'section-label', style: { marginTop: '8px' } }, 'WebDAV'),
    field(t('webdavUrl'), commitInput('webdavUrl', { placeholder: 'https://cloud.example.com/remote.php/dav/files/me' }), { help: t('webdav_help') }),
    h('div', { class: 'grid3' },
      field(t('username'), commitInput('webdavUser')),
      field(t('password'), commitInput('webdavPass', { secret: true })),
      field(t('webdavDir'), commitInput('webdavDir', { placeholder: 'Best' }))),
    h('div', { class: 'row' },
      button(t('webdavUpload'), { icon: 'upload', disabled: !st.webdavUrl, onClick: async () => {
        const pw = await passwordDialog({ title: t('webdavUpload'), message: t('backup_pw_set'), confirm: true });
        if (!pw) return;
        const name = await run(() => api.davUpload(pw));
        if (name) toast(t('webdav_uploaded', { d: name }), 'success');
      } }),
      button(t('webdavRestore'), { icon: 'download', disabled: !st.webdavUrl, onClick: davRestoreDialog })));

  const about = card(t('sec_about'), 'info',
    h('dl', { class: 'kvtable' },
      h('dt', null, t('version')), h('dd', null, ltr(S.version)),
      h('dt', null, t('xrayVersion')), h('dd', null, ltr(v.xray || '—')),
      h('dt', null, t('singboxVersion')), h('dd', null, ltr(v.singbox || '—'))),
    );

  return h('div', { class: 'page', 'data-scroll': 'page-settings' },
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('settings_title'))),
      h('div', { class: 'set-find' }, icon('search', 16), h('input', {
        class: 'input', type: 'search', placeholder: t('set_search'), autocomplete: 'off', spellcheck: 'false', 'data-keep': 'set-find',
        'aria-label': t('set_search'), 'aria-autocomplete': 'list', 'aria-controls': 'set-find-list',
        onInput: (e) => findSettings(e.currentTarget),
        onFocus: (e) => { if (e.currentTarget.value.trim()) findSettings(e.currentTarget); },
        onKeydown: (e) => findKeys(e),
      }))),
    h('div', { class: 'settings' }, appearance, startup, local, core, dns, tun, uwp, subsTests, data, about));
}
