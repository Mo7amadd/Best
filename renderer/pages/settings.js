// Settings page.

import { h, icon, button, toggle, select, field, segmented, confirmDialog, passwordDialog, modal, toast, ltr } from '../dom.js';
import { t, locale, IS_MAC } from '../i18n.js';
import { S, ui, api, run, render } from '../app.js';

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

// --------------------------------------------------------------------------- pages & menu state
// Settings is split into a few pages; the side menu lists them, and under the open page its
// subsections, with a marker that follows the scroll. The window is redrawn often (every state
// change), so what the menu shows lives here and every draw starts from it; scrolling only
// updates the few classes it changes, and writes them here too, so a redraw keeps them.

const view = {
  page: 0,          // open page
  sub: 0,           // subsection on screen
  adv: new Set(),   // "Advanced" boxes the user opened
  lock: -1,         // while we scroll to a subsection ourselves, the menu stays on it
  narrow: null,     // too narrow for the side menu: pages and subsections go to two rows on top
  bar: null,        // narrow rows: where the underline under the current subsection is
};
let lockTimer = 0;

const pageEl = () => document.querySelector('[data-scroll="page-settings"]');

/** For each subsection, the scroll position from which it counts as "on screen": when its heading
 *  passes the upper part of the page. Short subsections at the end never get there (the page ends
 *  first), so they share the last stretch of scrolling instead, in order: each one still lights up
 *  on the way down, and the last one at the very bottom. */
// (a page too short to scroll keeps the first one)
function subStarts(page) {
  const heads = [...page.querySelectorAll('.pg-body.shown .sec-head')];
  const max = page.scrollHeight - page.clientHeight;
  const pTop = page.getBoundingClientRect().top;
  const line = Math.min(160, page.clientHeight / 3);
  const at = heads.map((hd, k) => (k === 0 ? -Infinity : page.scrollTop + hd.getBoundingClientRect().top - pTop - line));
  if (max < 1) return { heads, at: at.map((a, k) => (k === 0 ? a : Infinity)), max }; // nothing to scroll: the first one
  // from the end back: the last one at the very bottom, each one before it at least about one wheel
  // step earlier (so none is skipped on the way), never later than where its heading gets
  const gap = Math.min(110, max / Math.max(1, at.length - 1));
  for (let k = at.length - 1; k > 0; k--) at[k] = Math.min(at[k], k === at.length - 1 ? max - 2 : at[k + 1] - gap);
  return { heads, at, max };
}

/** Which subsection is on screen (see subStarts). */
function spy() {
  const page = pageEl();
  if (!page || view.lock >= 0) return;
  const { heads, at } = subStarts(page);
  if (!heads.length) return;
  let i = 0;
  at.forEach((a, k) => { if (page.scrollTop >= a) i = k; });
  setSub(i);
}

/** Moves the menu to subsection i without redrawing the window. */
function setSub(i) {
  if (i === view.sub && document.querySelector('.set-nav .subs.open .sub.on')) return;
  view.sub = i;
  const open = document.querySelector('.set-nav .subs.open');
  if (open) {
    open.querySelectorAll('.sub').forEach((b, k) => { b.classList.toggle('on', k === i); b.setAttribute('aria-current', k === i ? 'location' : 'false'); });
    open.querySelector('.sub-marker')?.style.setProperty('--i', String(i));
  }
  const row = document.querySelector('.set-top .row2');
  if (row) {
    const btns = [...row.querySelectorAll('button')];
    btns.forEach((b, k) => b.classList.toggle('on', k === i));
    const b = btns[i];
    if (b && b.offsetWidth) {
      view.bar = { left: b.offsetLeft, width: b.offsetWidth };
      const bar = row.querySelector('.bar');
      if (bar) Object.assign(bar.style, { left: `${view.bar.left}px`, width: `${view.bar.width}px` });
      b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
}

/** Smooth scroll of the settings page to y (the built-in smooth scrolling does not run in the app
 *  window, so it is animated here). The menu stays on `holdSub` meanwhile. */
function scrollPageTo(y, holdSub, done) {
  const page = pageEl();
  if (!page) return;
  const from = page.scrollTop;
  const to = Math.max(0, Math.min(page.scrollHeight - page.clientHeight, y));
  view.lock = holdSub;
  clearTimeout(lockTimer);
  const finish = () => { page.scrollTop = to; view.lock = -1; if (done) done(); };
  if (Math.abs(to - from) < 2 || matchMedia('(prefers-reduced-motion: reduce)').matches) { finish(); return; }
  const dur = Math.min(450, 180 + Math.abs(to - from) / 6);
  const start = performance.now();
  const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - ((-2 * p + 2) ** 3) / 2);
  const step = (now) => {
    const p = Math.min(1, (now - start) / dur);
    page.scrollTop = from + (to - from) * ease(p);
    if (p < 1) requestAnimationFrame(step); else finish();
  };
  requestAnimationFrame(step);
  lockTimer = setTimeout(() => { view.lock = -1; }, dur + 400); // safety net if a frame never comes
}

function openPage(p) {
  closeFind();
  if (p === view.page) { goSub(0); return; }
  view.page = p; view.sub = 0; view.bar = null; view.lock = -1;
  render();
  const page = pageEl();
  if (page) page.scrollTop = 0;
  setSub(0);
}

function goSub(s) {
  const page = pageEl();
  if (!page) return;
  const { heads, at, max } = subStarts(page);
  const hd = heads[s];
  if (!hd) return;
  setSub(s);
  // its heading at the top, but never past where the menu would already show the next one
  let y = s === 0 ? 0 : page.scrollTop + hd.getBoundingClientRect().top - page.getBoundingClientRect().top - 8;
  if (s > 0) y = Math.max(Math.ceil(at[s]), Math.min(y, (at[s + 1] ?? Infinity) - 1, max));
  scrollPageTo(y, s);
}

/** The side menu needs room; below that width it turns into two rows above the page. */
function watchWidth() {
  const page = pageEl();
  if (!page || page.__setWatch) return;
  page.__setWatch = new ResizeObserver(() => {
    if (page.dataset.scroll !== 'page-settings') return; // the element now shows another page
    const narrow = page.clientWidth < 800;
    if (narrow !== view.narrow) { view.narrow = narrow; closeFind(); render(); }
  });
  page.__setWatch.observe(page);
}

// --------------------------------------------------------------------------- search
// Searches what the pages show (labels, help texts, notes, buttons, placeholders, setting keys) on
// every page, so anything added to Settings later is found without extra work. The list floats over
// the page (outside the redrawn area); choosing a result opens its page (and its "Advanced" box),
// scrolls to it and makes it glow for a moment.

const norm = (v) => String(v || '').toLowerCase()
  .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[‌‏‎]/g, '').replace(/\s+/g, ' ').trim();

function settingTargets() {
  const out = [];
  document.querySelectorAll('.set-pages > .pg-body').forEach((body, p) => {
    const pageTitle = body.querySelector('.pg-title')?.textContent.trim() || '';
    const heads = [...body.querySelectorAll('.sec-head')];
    for (const el of body.querySelectorAll('.field, .switch-row, .note, .card > .row, .kvtable')) {
      if (el.closest('.field') && el.closest('.field') !== el) continue; // a field's own parts belong to the field
      if (el.closest('.switch-row') && el.closest('.switch-row') !== el) continue;
      const sub = heads.reduce((acc, hd, k) => (hd.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING ? k : acc), 0);
      const section = `${pageTitle} › ${heads[sub]?.textContent.trim() || ''}`;
      const label = (el.querySelector(':scope > .field-label, :scope > .txt > span:first-child')?.textContent
        || [...el.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).join(' · ')
        || el.textContent).trim().replace(/\s+/g, ' ').slice(0, 90);
      const extra = [...el.querySelectorAll('[placeholder], [aria-label], [title], [data-keep], [data-s]')]
        .map((x) => [x.getAttribute('placeholder'), x.getAttribute('aria-label'), x.getAttribute('title'), (x.getAttribute('data-keep') || '').replace(/^set-|^hk-/, ''), x.getAttribute('data-s')].join(' ')).join(' ');
      out.push({ el, p, sub, adv: el.closest('.adv')?.dataset.adv || '', section, label, text: norm(`${section} ${el.textContent} ${el.getAttribute('data-s') || ''} ${extra}`) });
    }
  });
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
  // the setting's own name first, then its section, then help texts and notes; the open page first
  const rank = (x) => (words.every((w) => norm(x.label).includes(w)) ? 0 : words.every((w) => norm(x.section).includes(w)) ? 1 : 2);
  findItems = settingTargets().filter((x) => words.every((w) => x.text.includes(w)))
    .map((x, i) => ({ x, r: rank(x), i: i + (x.p === view.page ? 0 : 1e4) })).sort((a, b) => a.r - b.r || a.i - b.i).map((o) => o.x).slice(0, 12);
  findIndex = 0;
  if (!findList) {
    findList = h('div', { class: 'set-find-list', id: 'set-find-list', role: 'listbox' });
    document.body.append(findList);
    document.addEventListener('mousedown', outsideFind, true);
  }
  const r = input.getBoundingClientRect();
  const w = Math.round(Math.max(r.width, 360));
  const rtl = getComputedStyle(input).direction === 'rtl';
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, rtl ? r.right - w : r.left));
  Object.assign(findList.style, { top: `${Math.round(r.bottom + 6)}px`, left: `${Math.round(left)}px`, width: `${w}px` });
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
  if (e.key === 'Escape') { if (findList) { e.preventDefault(); e.stopPropagation(); closeFind(); } else e.currentTarget.blur(); return; }
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

function goToSetting(x) {
  closeFind();
  if (!x.el.isConnected) return;
  // open its page and its "Advanced" box first; the element itself stays (redraws keep it)
  const pageChanged = x.p !== view.page;
  if (pageChanged || (x.adv && !view.adv.has(x.adv))) {
    if (x.adv) view.adv.add(x.adv);
    if (pageChanged) { view.page = x.p; view.bar = null; }
    view.sub = x.sub;
    render();
    if (pageChanged) { const pg = pageEl(); if (pg) pg.scrollTop = 0; }
  }
  const page = pageEl();
  const el = x.el;
  if (!page || !el.isConnected) return;
  setSub(x.sub);
  const pr = page.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  scrollPageTo(page.scrollTop + (er.top - pr.top) - (page.clientHeight - er.height) / 2, x.sub);
  el.classList.remove('set-flash');
  void el.offsetWidth; // restart the glow if the same one is chosen twice
  el.classList.add('set-flash');
  setTimeout(() => el.classList.remove('set-flash'), 2200);
  const control = el.querySelector('input:not([type="checkbox"]), textarea, button.select-btn, button[role="switch"]');
  if (control) setTimeout(() => control.focus({ preventScroll: true }), 450);
}

/** Ctrl+F on the Settings page. In the side menu the box is always in sight, so the page stays put. */
export function focusSettingsSearch() {
  const input = document.querySelector('.set-find input');
  if (!input) return;
  input.focus({ preventScroll: !view.narrow });
  input.select();
}

/** Records a key combination ("Control+Alt+B"); Backspace / Delete clears it. */
function hotkeyInput(action) {
  const cur = (S.settings.hotkeys || {})[action] || '';
  // macOS writes keys as symbols (⌃⌥⇧⌘B); "Super" is the ⌘ key there.
  const MAC_KEYS = { Control: '⌃', Alt: '⌥', Shift: '⇧', Super: '⌘' };
  const show = (acc) => (IS_MAC ? acc.split('+').map((p) => MAC_KEYS[p] || p).join('') : acc.replace('Control', 'Ctrl'));
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
    if (!key || !mods.length) { el.value = mods.length ? `${mods.map(show).join(IS_MAC ? '' : '+')}${IS_MAC ? '' : '+'}…` : el.value; return; }
    const acc = [...mods, key].join('+');
    el.value = show(acc);
    save(acc);
  });
  return el;
}

const THEMES = [
  { id: 'dark', a: '#0B0E12', b: '#151A21' },
  { id: 'midnight', a: '#080C18', b: '#111933' },
  { id: 'graphite', a: '#101010', b: '#1C1C1C' },
  { id: 'light', a: '#ECEEF2', b: '#FFFFFF' },
  { id: 'paper', a: '#EEE9E1', b: '#FFFDF9' },
  { id: 'sky', a: '#E3EAF3', b: '#FFFFFF' },
  { id: 'system', a: '#0B0E12', b: '#FFFFFF' },
];
const ACCENTS = { green: '#3DD68C', blue: '#5AA9FF', purple: '#B48CFF', orange: '#FF9F43', pink: '#FF6FAE' };

// --------------------------------------------------------------------------- drawing helpers

// Settings whose default is random or simply a personal choice: no "changed" dot for these.
const NO_DOT = new Set(['language', 'lanUser', 'lanPass', 'theme', 'accent', 'density', 'uiZoom', 'hiddenCols', 'sidebarCollapsed']);
function changed(key) {
  const d = S.defaults;
  if (!d || NO_DOT.has(key) || !(key in d)) return false;
  return JSON.stringify(S.settings[key] ?? null) !== JSON.stringify(d[key] ?? null);
}
const dotTitle = (key) => (changed(key) ? t('set_changed') : undefined);

function switchRow(key, label, sub, { disabled } = {}) {
  return h('div', { class: 'switch-row', 'data-s': key },
    h('div', { class: 'txt' }, h('span', { class: changed(key) ? 'changed' : undefined, title: dotTitle(key) }, label), sub ? h('span', null, sub) : null),
    toggle(S.settings[key], (v) => set({ [key]: v }), { label, disabled }));
}

/** A field for setting `key`: its caption gets the "changed" dot. */
function fieldK(key, label, control, opts) {
  const f = field(label, control, opts);
  if (changed(key)) { const c = f.querySelector('.field-label'); c.classList.add('changed'); c.title = t('set_changed'); }
  return f;
}
const numField = (key, label, min, max, opts = {}) => fieldK(key, label, commitInput(key, { type: 'number', min, max, placeholder: opts.placeholder }), opts.help ? { help: opts.help } : undefined);
const textField = (key, label, opts = {}) => fieldK(key, label, commitInput(key, opts), opts.help ? { help: opts.help } : undefined);

function card(title, ...children) {
  return h('section', { class: 'card grp' }, title ? h('h3', null, title) : null, ...children);
}

/** A folded "Advanced" box inside a card; stays open through redraws once opened. */
function adv(id, hint, ...children) {
  const open = view.adv.has(id);
  return h('div', { class: `adv ${open ? 'open' : ''}`, 'data-adv': id },
    h('button', {
      type: 'button', class: 'adv-head', 'aria-expanded': String(open),
      onClick: (e) => {
        const box = e.currentTarget.parentElement;
        const now = !view.adv.has(id);
        if (now) view.adv.add(id); else view.adv.delete(id);
        box.classList.toggle('open', now);
        e.currentTarget.setAttribute('aria-expanded', String(now));
      },
    }, h('span', null, icon('chevron', 14), t('set_advanced')), h('span', { class: 'hint' }, hint)),
    ...children);
}

const textArea = (key, rows, placeholder) => {
  const ta = h('textarea', { class: 'input mono', rows, dir: 'ltr', spellcheck: 'false', placeholder, 'data-keep': `set-${key}` });
  ta.value = S.settings[key] || '';
  ta.addEventListener('change', () => { if (ta.value !== S.settings[key]) set({ [key]: ta.value }); });
  return ta;
};

async function exportBackup() {
  const pw = await passwordDialog({ title: t('exportBackup'), message: t('backup_pw_set'), confirm: true });
  if (pw && await run(() => api.exportBackup(pw))) toast(t('t_backupSaved'), 'success');
}
async function importBackup() {
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
}

// --------------------------------------------------------------------------- the pages

function buildPages() {
  const st = S.settings;
  const v = ui.versions || {};
  const portRange = [1025, 65535];

  return [
    { id: 'general', icon: 'settings', title: t('setp_general'), desc: t('setp_general_d'), subs: [
      [t('ss_langStart'), [
        card(null,
          field(t('language'), segmented([{ value: 'fa', label: 'فارسی' }, { value: 'en', label: 'English' }, { value: 'ru', label: 'Русский' }, { value: 'zh', label: '中文' }], st.language, (x) => set({ language: x }), { label: t('language') })),
          h('div', null,
            switchRow('autoStart', t('autoStart')),
            switchRow('startMinimized', t('startMinimized')),
            switchRow('closeToTray', t('closeToTray')))),
        card(t('grp_shortcuts'),
          switchRow('globalHotkey', t('globalHotkey')),
          st.globalHotkey ? h('div', { class: 'grid2' }, ['toggleProxy', 'showWindow', 'proxyOn', 'proxyOff', 'toggleTun', 'disconnect'].map((k) => field(t(`hk_${k}`), hotkeyInput(k)))) : null,
          st.globalHotkey ? h('div', { class: 'field-help' }, t('hk_help')) : null),
      ]],
      [t('sec_appearance'), [
        card(null,
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
          field(t('uiZoom'), segmented([0.9, 1, 1.1, 1.25].map((x) => ({ value: x, label: `${Math.round(x * 100)}%` })), st.uiZoom || 1, (x) => set({ uiZoom: x }), { label: t('uiZoom') }))),
        card(t('grp_display'),
          h('div', null,
            switchRow('statsEnabled', t('statsEnabled')),
            switchRow('showExitIp', t('showExitIp'))),
          field(t('visibleCols'), h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px 14px' } }, ['address', 'port', 'protocol', 'delay', 'speed'].map((c) => h('label', { class: 'row', style: { gap: '6px' } },
            h('input', { type: 'checkbox', checked: !(st.hiddenCols || []).includes(c), onChange: (e) => { const s = new Set(st.hiddenCols || []); if (e.target.checked) s.delete(c); else s.add(c); set({ hiddenCols: [...s] }); } }),
            t(`col_${c}`)))))),
      ]],
      [t('sec_about'), [
        card(null, h('dl', { class: 'kvtable' },
          h('dt', null, t('version')), h('dd', null, ltr(S.version)),
          h('dt', null, t('xrayVersion')), h('dd', null, ltr(v.xray || '—')),
          h('dt', null, t('singboxVersion')), h('dd', null, ltr(v.singbox || '—')))),
      ]],
    ] },

    { id: 'conn', icon: 'link', title: t('setp_conn'), desc: t('setp_conn_d'), subs: [
      [t('ss_proxyPorts'), [
        card(null,
          h('div', { class: 'note' }, icon('info', 16), h('div', { class: 'stack', style: { gap: '6px' } }, h('span', null, t('local_help')), h('span', { class: 'dim' }, t('local_help_apps', { socks: st.socksPort })))),
          h('div', { class: 'grid3' },
            numField('socksPort', t('socksPort'), ...portRange),
            numField('httpPort', t('httpPort'), ...portRange),
            numField('pacPort', t('pacPort'), ...portRange)),
          textField('proxyBypass', t('proxyBypass'))),
        // Microsoft Store apps exist on Windows only.
        IS_MAC ? null : card(t('sec_uwp'),
          h('div', { class: 'note' }, icon('info', 16), h('span', null, t('uwp_help'))),
          h('div', { class: 'row' }, button(t('uwp_choose'), { icon: 'edit', onClick: storeAppsDialog }))),
      ]],
      ['TUN', [
        // Windows: Best runs as administrator or not. macOS: the TUN helper service is installed or not
        // (or comes from an older Best and has to be installed again).
        h('div', { class: `note ${S.tunAvailable ? 'good' : 'warn'}` }, icon(S.tunAvailable ? 'check' : 'alert', 16),
          h('span', { class: 'grow' }, S.tunAvailable ? t('adminYes') : t(IS_MAC && S.tunHelper === 'outdated' ? 'tunHelperOutdated' : 'adminNo')),
          S.tunAvailable ? null : button(t('runAsAdmin'), { size: 'sm', onClick: () => api.relaunchAdmin() }),
          IS_MAC && S.tunAvailable ? button(t('tunHelperRemove'), { size: 'sm', variant: 'ghost', onClick: () => run(() => api.removeTunHelper()) }) : null),
        S.secureCores === false ? h('div', { class: 'note warn' }, icon('alert', 16), h('span', null, t(S.portable ? 'tunPortableWarn' : 'tunUserInstallWarn'))) : null,
        card(null,
          h('div', null,
            switchRow('tun', t('tunMode'), t('tun_help'), { disabled: !S.tunAvailable }),
            switchRow('tunIpv6', t('tunIpv6'), t('tunIpv6_d'))),
          fieldK('tunExclude', t('tunExclude'), textArea('tunExclude', 3, '192.168.0.0/16\n203.0.113.10'), { help: t('tunExclude_help') }),
          adv('tun', t('adv_tun'),
            h('div', { class: 'grid2' },
              fieldK('tunStack', t('tunStack'), select(['mixed', 'gvisor', 'system'].map((x) => ({ value: x, label: x })), st.tunStack, (x) => set({ tunStack: x }))),
              numField('tunMtu', t('tunMtu'), 1280, 65535)),
            switchRow('tunStrictRoute', t('tunStrictRoute')))),
      ]],
      ['DNS', [
        card(null,
          h('div', { class: 'note' }, icon('shield', 16), h('span', null, t('dns_help'))),
          textField('remoteDns', t('remoteDns'), { placeholder: 'https://1.1.1.1/dns-query' }),
          textField('directDns', t('directDns'), { placeholder: 'localhost' }),
          adv('dns', t('adv_dns'),
            fieldK('dnsHosts', t('dnsHosts'), textArea('dnsHosts', 4, 'example.com 1.2.3.4\nads.example 0.0.0.0'), { help: t('dnsHosts_help') }),
            h('div', null,
              switchRow('useSystemHosts', t('useSystemHosts')),
              switchRow('dnsIpv4Only', t('dnsIpv4Only')),
              switchRow('tunFakeIp', t('tunFakeIp'))))),
      ]],
      [t('ss_lan'), [
        card(null,
          switchRow('allowLan', t('allowLan')),
          st.allowLan ? h('div', { class: 'note warn' }, icon('alert', 16), h('span', null, t('allowLan_warn'))) : null,
          st.allowLan ? h('div', { class: 'grid2' },
            numField('lanSocksPort', t('lanSocksPort'), ...portRange),
            numField('lanHttpPort', t('lanHttpPort'), ...portRange),
            field(t('lanUser'), commitInput('lanUser')),
            field(t('lanPass'), commitInput('lanPass', { secret: true }))) : null,
          st.allowLan ? h('div', { class: 'field-help' }, t('lanPorts_help')) : null),
      ]],
    ] },

    { id: 'subs', icon: 'subs', title: t('setp_subs'), desc: t('setp_subs_d'), subs: [
      [t('ss_subs'), [
        card(null,
          numField('subAutoUpdateHours', t('subAutoUpdateHours'), 0, 720),
          h('div', null,
            switchRow('subViaProxy', t('subViaProxy')),
            switchRow('subHwid', t('subHwid'), t('subHwid_d'))),
          st.subHwid ? textField('subHwidName', t('subHwidName'), { placeholder: 'Windows PC', help: t('subHwidName_help') }) : null,
          adv('sub', t('adv_sub'),
            textField('subUserAgent', t('subUserAgent'), { placeholder: `Best/${S.version}`, help: t('subUserAgent_help') }))),
      ]],
      [t('ss_tests'), [
        card(null,
          h('div', { class: 'grid2' },
            numField('testTimeout', t('testTimeout'), 1000, 30000),
            numField('testConcurrency', t('testConcurrency'), 1, 32)),
          adv('tests', t('adv_tests'),
            textField('testUrl', t('testUrl')),
            textField('speedTestUrl', t('speedTestUrl')),
            textField('udpTestTarget', t('udpTestTarget'), { placeholder: 'pool.ntp.org:123', help: t('udpTestTarget_help') }),
            textField('ipCheckUrl', t('ipCheckUrl'), { placeholder: 'https://www.cloudflare.com/cdn-cgi/trace', help: t('ipCheckUrl_help') }))),
      ]],
    ] },

    { id: 'backup', icon: 'folder', title: t('setp_backup'), desc: t('setp_backup_d'), subs: [
      [t('ss_file'), [
        h('div', { class: `note ${S.encrypted ? 'good' : 'warn'}` }, icon(S.encrypted ? 'shield' : 'alert', 16), h('span', null, S.encrypted ? t('encryptionOn') : t('encryptionOff'))),
        S.portable ? h('div', { class: 'note' }, icon('folder', 16), h('span', null, t('portableOn'))) : null,
        card(null,
          h('div', { class: 'note' }, icon('shield', 16), h('span', null, t('backup_warn'))),
          h('div', { class: 'row' },
            button(t('exportBackup'), { icon: 'download', onClick: exportBackup }),
            button(t('importBackup'), { icon: 'upload', onClick: importBackup }),
            button(t('openDataFolder'), { icon: 'folder', variant: 'ghost', onClick: () => api.openDataFolder() }))),
      ]],
      ['WebDAV', [
        card(null,
          textField('webdavUrl', t('webdavUrl'), { placeholder: 'https://cloud.example.com/remote.php/dav/files/me', help: t('webdav_help') }),
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
            button(t('webdavRestore'), { icon: 'download', disabled: !st.webdavUrl, onClick: davRestoreDialog }))),
      ]],
    ] },

    { id: 'adv', icon: 'code', title: t('setp_adv'), desc: t('setp_adv_d'), subs: [
      [t('ss_filter'), [
        card(null,
          switchRow('fragment', t('fragment'), t('fragment_help')),
          st.fragment ? h('div', { class: 'grid3' },
            fieldK('fragmentPackets', t('fragmentPackets'), select(['tlshello', '1-1', '1-2', '1-3', '1-5'].map((x) => ({ value: x, label: x })), st.fragmentPackets, (x) => set({ fragmentPackets: x }))),
            textField('fragmentLength', t('fragmentLength')),
            textField('fragmentInterval', t('fragmentInterval'))) : null,
          switchRow('mux', t('mux')),
          st.mux ? numField('muxConcurrency', t('muxConcurrency'), 1, 128) : null,
          switchRow('sbMux', t('sbMux'), t('sbMux_help')),
          st.sbMux ? h('div', { class: 'grid3' },
            fieldK('sbMuxProtocol', t('sbMuxProtocol'), select(['h2mux', 'smux', 'yamux'].map((x) => ({ value: x, label: x })), st.sbMuxProtocol, (x) => set({ sbMuxProtocol: x }))),
            numField('sbMuxMax', t('sbMuxMax'), 1, 32),
            h('div', { style: { alignSelf: 'end' } }, switchRow('sbMuxPadding', t('sbMuxPadding')))) : null),
      ]],
      [t('ss_linkDefaults'), [
        card(null,
          h('div', { class: 'grid3' },
            fieldK('defaultFingerprint', t('defaultFingerprint'), select(['', 'chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random', 'randomized'].map((x) => ({ value: x, label: x || t('none') })), st.defaultFingerprint || '', (x) => set({ defaultFingerprint: x }))),
            numField('hy2UpMbps', t('hy2Up'), 0, 100000, { placeholder: '0' }),
            numField('hy2DownMbps', t('hy2Down'), 0, 100000, { placeholder: '0' })),
          h('div', { class: 'field-help' }, t('defaults_help'))),
      ]],
      [t('ss_cores'), [
        card(null,
          switchRow('sniffing', t('sniffing')),
          adv('cores', t('adv_cores'),
            h('div', { class: 'grid2' }, ['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria2', 'tuic', 'anytls', 'wireguard', 'socks', 'http'].map((p) => field(p === 'shadowsocks' ? 'Shadowsocks' : p.toUpperCase(),
              select([{ value: '', label: t('auto') }, { value: 'xray', label: 'Xray' }, { value: 'sing-box', label: 'sing-box' }, { value: 'mihomo', label: S.mihomo ? 'mihomo' : `mihomo (${t('upd_notInstalled')})` }], (st.coreFor || {})[p] || '', (val) => {
                const next = { ...(st.coreFor || {}) };
                if (val) next[p] = val; else delete next[p];
                set({ coreFor: next });
              })))),
            h('div', { class: 'field-help' }, t('coreFor_help')))),
      ]],
      [t('ss_network'), [
        card(null, h('div', { class: 'grid2' },
          textField('bindInterface', t('bindInterface'), { placeholder: t('auto'), help: t('bindInterface_help') }),
          textField('sendThrough', t('sendThrough'), { placeholder: t('auto'), help: t('sendThrough_help') }))),
      ]],
      [t('ss_logs'), [
        card(null,
          fieldK('logLevel', t('logLevel'), select(['debug', 'info', 'warning', 'error', 'none'].map((x) => ({ value: x, label: x })), st.logLevel, (x) => set({ logLevel: x }))),
          switchRow('logToFile', t('logToFile'), t('logToFile_help'))),
      ]],
    ] },
  ];
}

export function renderSettings() {
  const pages = buildPages();
  if (view.page >= pages.length) view.page = 0;
  if (view.narrow === null) view.narrow = window.innerWidth - (ui.sideMode === 'pinned' ? 236 : 64) - 48 < 800;
  const cur = pages[view.page];
  if (view.sub >= cur.subs.length) view.sub = 0;
  queueMicrotask(watchWidth);

  // every page is drawn (search looks into all of them); only the open one is shown
  const bodies = pages.map((pg, p) => h('div', { class: `pg-body ${p === view.page ? 'shown' : ''}`, 'data-page': pg.id },
    h('header', { class: 'pg-head' },
      h('span', { class: 'pg-tile', 'aria-hidden': 'true' }, icon(pg.icon, 20)),
      h('div', null, h('h2', { class: 'pg-title' }, pg.title), h('p', { class: 'pg-sub' }, pg.desc))),
    pg.subs.map(([title, kids]) => [h('h3', { class: 'sec-head' }, title), ...kids]),
    h('div', { class: 'pg-nav' },
      pages[p - 1] ? h('button', { type: 'button', class: 'prev', onClick: () => openPage(p - 1) },
        h('span', { class: 'pg-chev' }, icon('chevron', 16)), h('span', null, h('small', null, t('pg_prev')), pages[p - 1].title)) : null,
      pages[p + 1] ? h('button', { type: 'button', class: 'next', onClick: () => openPage(p + 1) },
        h('span', null, h('small', null, t('pg_next')), pages[p + 1].title), h('span', { class: 'pg-chev' }, icon('chevron', 16))) : null)));
  const changedPage = bodies.map((b) => Boolean(b.querySelector('.changed')));

  const nav = h('nav', { class: 'set-nav', 'aria-label': t('settings_title') }, pages.map((pg, p) => {
    const open = p === view.page;
    return [
      p === pages.length - 1 ? h('div', { class: 'sep' }) : null,
      h('button', { type: 'button', class: `pg ${open ? 'on' : ''}`, 'aria-current': open ? 'page' : 'false', onClick: () => openPage(p) },
        icon(pg.icon, 17), h('span', { class: 'grow' }, pg.title),
        h('span', { class: `mod-dot ${changedPage[p] ? 'on' : ''}`, title: changedPage[p] ? t('set_changed') : undefined })),
      h('div', { class: `subs ${open ? 'open' : ''}` }, h('div', null, h('div', { class: 'sub-line' },
        h('span', { class: 'sub-marker', style: { '--i': String(open ? view.sub : 0) } }),
        pg.subs.map(([title], s) => h('button', {
          type: 'button', class: `sub ${open && s === view.sub ? 'on' : ''}`, tabindex: open ? undefined : '-1',
          'aria-current': open && s === view.sub ? 'location' : 'false', onClick: () => goSub(s),
        }, title))))),
    ];
  }));

  const find = h('div', { class: 'set-find' }, icon('search', 16), h('input', {
    class: 'input', type: 'search', placeholder: t('set_search'), autocomplete: 'off', spellcheck: 'false', 'data-keep': 'set-find',
    'aria-label': t('set_search'), 'aria-autocomplete': 'list', 'aria-controls': 'set-find-list',
    onInput: (e) => findSettings(e.currentTarget),
    onFocus: (e) => { if (e.currentTarget.value.trim()) findSettings(e.currentTarget); },
    onKeydown: (e) => findKeys(e),
  // macOS: "⌘F" kept in this order inside right-to-left text by an isolate (a dir attribute would also
  // flip the label's own position onto the magnifier).
  }), h('kbd', { class: 'find-kbd', 'aria-hidden': 'true' }, IS_MAC ? '⁦⌘F⁩' : 'Ctrl F'));

  // narrow: pages on one row, the open page's subsections on a second one, both above the page
  const top = view.narrow ? h('div', { class: 'set-top' },
    h('div', { class: 'row1' }, pages.map((pg, p) => h('button', { type: 'button', class: p === view.page ? 'on' : '', onClick: () => openPage(p) }, pg.title))),
    h('div', { class: 'row2' }, cur.subs.map(([title], s) => h('button', { type: 'button', class: s === view.sub ? 'on' : '', onClick: () => goSub(s) }, title)),
      h('span', { class: 'bar', style: view.bar ? { left: `${view.bar.left}px`, width: `${view.bar.width}px` } : { width: '0px' } }))) : null;

  return h('div', { class: 'page', 'data-scroll': 'page-settings', onScroll: spy },
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('settings_title'))), view.narrow ? find : null),
    top,
    h('div', { class: `set-layout ${view.narrow ? 'narrow' : ''}` },
      view.narrow ? null : h('aside', { class: 'set-side' }, find, nav),
      h('div', { class: 'set-pages' }, bodies)));
}
