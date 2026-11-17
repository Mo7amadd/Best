// Tiny DOM toolkit. Text is always set with textContent – never innerHTML – so names that come
// from subscriptions (untrusted) can never inject markup or script.

import { t } from './i18n.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Event handlers live in el.__on and are reached through one listener per event type, so when the
// window is redrawn (see mount) an element that stays on screen simply takes the new handlers.
function dispatch(e) {
  const fn = e.currentTarget.__on && e.currentTarget.__on[e.type];
  if (fn) return fn.call(e.currentTarget, e);
  return undefined;
}
function listen(el, type, fn) {
  if (!el.__on) el.__on = {};
  if (!(type in el.__on)) el.addEventListener(type, dispatch);
  el.__on[type] = fn;
}

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') { for (const [p, val] of Object.entries(v)) { if (p.startsWith('--')) el.style.setProperty(p, val); else el.style[p] = val; } }
      else if (k.startsWith('on') && typeof v === 'function') listen(el, k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = Boolean(v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

/**
 * Draw `children` into `el`. Instead of throwing the old elements away, the new tree is compared
 * with what is on screen and only the differences are applied: an element that stays keeps its
 * focus, scroll position, running animations and hover state, so a redraw between mouse-down and
 * mouse-up no longer swallows the click. Elements are matched by position, or by data-key
 * when it is set. An element marked data-fresh is always replaced.
 */
export function mount(el, ...children) {
  const next = [];
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    next.push(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  morphChildren(el, next);
  return el;
}

const keyOf = (n) => (n.nodeType === 1 ? (n.getAttribute('data-key') || '') : ''); // not id: some ids are generated per draw
function sameKind(a, b) {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType !== 1) return true;
  return a.tagName === b.tagName && a.namespaceURI === b.namespaceURI && keyOf(a) === keyOf(b)
    && !a.hasAttribute('data-fresh') && !b.hasAttribute('data-fresh');
}

function morphChildren(parent, next) {
  const old = [...parent.childNodes];
  let i = 0;
  for (const n of next) {
    const o = old[i];
    if (o && sameKind(o, n)) { morphNode(o, n); i++; continue; }
    const k = keyOf(n);
    const at = k ? old.findIndex((x, idx) => idx > i && x.nodeType === 1 && x.tagName === n.tagName && keyOf(x) === k) : -1;
    if (at > 0) {
      const f = old[at];
      old.splice(at, 1);
      parent.insertBefore(f, o || null);
      old.splice(i, 0, f);
      morphNode(f, n);
    } else {
      parent.insertBefore(n, o || null);
      old.splice(i, 0, n);
    }
    i++;
  }
  for (let r = old.length - 1; r >= i; r--) old[r].remove();
}

const TRANSIENT = new Set(['set-flash', 'dragging', 'drop-before']);

function morphNode(o, n) {
  if (o.nodeType !== 1) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; return; }
  // attributes (class, style, aria-*, data-* …): the new tree is the truth — except short-lived
  // classes added by code after drawing (a highlight, a drag in progress), which a redraw keeps
  for (const { name, value } of [...n.attributes]) {
    let v = value;
    if (name === 'class') {
      const keep = [...o.classList].filter((c) => TRANSIENT.has(c) && !n.classList.contains(c));
      if (keep.length) v = `${value} ${keep.join(' ')}`.trim();
    }
    if (o.getAttribute(name) !== v) o.setAttribute(name, v);
  }
  for (const { name } of [...o.attributes]) {
    if (n.hasAttribute(name)) continue;
    if (name === 'class') { const keep = [...o.classList].filter((c) => TRANSIENT.has(c)); if (keep.length) { o.setAttribute('class', keep.join(' ')); continue; } }
    o.removeAttribute(name);
  }
  // handlers
  const on = n.__on || {};
  for (const type of Object.keys(on)) listen(o, type, on[type]);
  if (o.__on) for (const type of Object.keys(o.__on)) if (!(type in on)) o.__on[type] = null;
  // form state: never overwrite what the user is typing
  if (o.tagName === 'INPUT' || o.tagName === 'TEXTAREA' || o.tagName === 'SELECT') {
    if (o.type === 'checkbox' || o.type === 'radio') { if (o.checked !== n.checked) o.checked = n.checked; }
    else if (o !== document.activeElement && !o.__editing && o.value !== n.value) o.value = n.value; // __editing: arrows held down
    if (o.tagName === 'TEXTAREA') return;
  }
  morphChildren(o, [...n.childNodes]);
}

/** Left-to-right isolated text (addresses, ports, keys) inside an RTL page. */
export function ltr(text, cls = '') { return h('bdi', { dir: 'ltr', class: `ltr ${cls}` }, text); }

// --------------------------------------------------------------------------- icons
const PATHS = {
  servers: ['M3 4h18v7H3z', 'M3 13h18v7H3z', 'M7 7.5h.01M7 16.5h.01'],
  subs: ['M12 3l9 5-9 5-9-5 9-5z', 'M3 13l9 5 9-5'],
  routing: ['M8.5 6H15a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h6.5', 'circle:6,6,2.5', 'circle:18,18,2.5'],
  logs: ['M3 4h18v16H3z', 'M7 9l3 3-3 3M13 15h4'],
  settings: ['M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12', 'circle:16,6,2', 'circle:10,12,2', 'circle:18,18,2'],
  power: ['M12 3v9', 'M6.3 6.3a8 8 0 1 0 11.4 0'],
  plus: ['M12 5v14M5 12h14'],
  search: ['circle:11,11,7', 'M20 20l-3.5-3.5'],
  bolt: ['M13 3L5 14h6l-1 7 8-11h-6l1-7z'],
  gauge: ['M4 16a8 8 0 1 1 16 0', 'M12 16l4-5'],
  refresh: ['M20 11a8 8 0 0 0-14.9-3M4 13a8 8 0 0 0 14.9 3', 'M5 3v5h5M19 21v-5h-5'],
  chevron: ['M6 9l6 6 6-6'],
  more: ['circle:5,12,1.3', 'circle:12,12,1.3', 'circle:19,12,1.3'],
  close: ['M6 6l12 12M18 6L6 18'],
  copy: ['M8 8h12v12H8z', 'M16 8V4H4v12h4'],
  qr: ['M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z', 'M14 14h2v2h-2zM18 18h2v2h-2zM14 18h2v2h-2zM18 14h2v2h-2z'],
  edit: ['M4 20h4L19 9l-4-4L4 16v4z', 'M14 6l4 4'],
  trash: ['M4 7h16', 'M10 11v6M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'circle:12,12,3'],
  eyeOff: ['M3 3l18 18', 'M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6', 'M9.9 9.9a3 3 0 0 0 4.2 4.2'],
  shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z', 'M9 12l2 2 4-4'],
  upload: ['M12 16V4M7 9l5-5 5 5', 'M4 20h16'],
  download: ['M12 4v12M7 11l5 5 5-5', 'M4 20h16'],
  folder: ['M3 6h6l2 2h10v11H3z'],
  clipboard: ['M9 4h6v3H9z', 'M8 5H5v16h14V5h-3'],
  scan: ['M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4', 'M7 12h10'],
  file: ['M6 3h8l4 4v14H6z', 'M14 3v4h4'],
  code: ['M8 8l-4 4 4 4M16 8l4 4-4 4'],
  up: ['M6 15l6-6 6 6'],
  down: ['M6 9l6 6 6-6'],
  pause: ['M8 5v14M16 5v14'],
  play: ['M7 4l13 8-13 8z'],
  check: ['M5 12l5 5 9-10'],
  alert: ['M12 3l10 18H2L12 3z', 'M12 10v4M12 17h.01'],
  info: ['circle:12,12,9', 'M12 11v6M12 7.5h.01'],
  sidebar: ['M4 5h16v14H4z', 'M9 5v14'],
  pin: ['M9 4h6l-1 6 3 3v1H7v-1l3-3-1-6z', 'M12 14v6'],
  globe: ['circle:12,12,9', 'M3 12h18', 'M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
};

export function icon(name, size = 18, stroke = 1.9) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', stroke);
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  for (const d of PATHS[name] || []) {
    let node;
    if (d.startsWith('circle:')) {
      const [cx, cy, r] = d.slice(7).split(',');
      node = document.createElementNS(SVG_NS, 'circle');
      node.setAttribute('cx', cx); node.setAttribute('cy', cy); node.setAttribute('r', r);
    } else {
      node = document.createElementNS(SVG_NS, 'path');
      node.setAttribute('d', d);
    }
    svg.append(node);
  }
  return svg;
}

export function button(label, { icon: ic, variant = '', onClick, title, disabled, ariaLabel, size } = {}) {
  return h('button', {
    type: 'button', class: `btn ${variant} ${size || ''}`.trim(), onClick, title, disabled,
    'aria-label': ariaLabel || (label ? undefined : title),
  }, ic ? icon(ic, size === 'sm' ? 15 : 16) : null, label ? h('span', null, label) : null);
}

export function segmented(options, value, onChange, { label, small } = {}) {
  return h('div', { class: `seg ${small ? 'seg-sm' : ''}`, role: 'group', 'aria-label': label },
    options.map((o) => h('button', {
      type: 'button', class: 'seg-btn', 'aria-pressed': String(o.value === value),
      onClick: () => { if (o.value !== value) onChange(o.value); },
    }, o.label)));
}

export function toggle(checked, onChange, { label, disabled, id } = {}) {
  return h('button', {
    type: 'button', role: 'switch', class: 'switch', 'aria-checked': String(Boolean(checked)), 'aria-label': label, disabled, id,
    onClick: () => onChange(!checked),
  }, h('span', { class: 'switch-knob' }));
}

/** Themed dropdown (replaces the native <select>, whose popup cannot be styled on Windows). */
export function select(options, value, onChange, attrsIn = {}) {
  const { search, ...attrs } = attrsIn; // search: show a filter box (default: long lists)
  const current = options.find((o) => o.value === value) || options[0] || { label: '' };
  const btn = h('button', {
    type: 'button', class: 'input select-btn', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', ...attrs,
  }, h('span', { class: 'select-label' }, current.label), icon('chevron', 16, 2.2));
  const open = () => {
    btn.setAttribute('aria-expanded', 'true');
    showMenu(btn, options.map((o) => ({
      label: o.label, icon: o.value === value ? 'check' : null, checked: o.value === value, search: o.search,
      onClick: () => { if (o.value !== value) onChange(o.value); },
    })), { minWidth: btn.offsetWidth, onClose: () => btn.setAttribute('aria-expanded', 'false'), role: 'listbox', search: search ?? options.length > 15 });
  };
  btn.addEventListener('click', open);
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
  });
  return btn;
}

// --------------------------------------------------------------------------- floating UI

let openMenu = null;
let openMenuClose = null;
let openMenuAnchor = null;
// A click on the button that opened the menu closes it (mousedown closes it first; this stops the
// click that follows from opening it again).
// The button is recognised by its look (class + text) too, because a re-render may have replaced it.
let closedBy = { sig: '', at: -1e9 };
const anchorSig = (el) => `${el.className}|${el.textContent}`;
export function closeMenu() {
  if (openMenu) {
    openMenu.remove(); openMenu = null; openMenuAnchor = null;
    const cb = openMenuClose; openMenuClose = null;
    if (cb) cb();
  }
}

/**
 * Show a popup menu. items: [{label, icon, onClick, danger, disabled, checked} | 'sep'].
 * opts: { minWidth, onClose, role }
 */
export function showMenu(anchorOrPoint, items, opts = {}) {
  if (anchorOrPoint instanceof Element && performance.now() - closedBy.at < 500 && closedBy.sig === anchorSig(anchorOrPoint)) {
    closedBy = { sig: '', at: -1e9 };
    return;
  }
  closeMenu();
  const itemRole = opts.role === 'listbox' ? 'option' : 'menuitem';
  const menu = h('div', { class: `menu ${opts.role === 'listbox' ? 'menu-list' : ''}`, role: opts.role || 'menu', style: opts.minWidth ? { minWidth: `${opts.minWidth}px` } : null },
    items.map((it) => (it === 'sep' ? h('div', { class: 'menu-sep', role: 'separator' }) : h('button', {
      type: 'button', role: itemRole, class: `menu-item ${it.danger ? 'danger' : ''} ${it.checked ? 'checked' : ''}`, disabled: it.disabled,
      'aria-selected': itemRole === 'option' ? String(Boolean(it.checked)) : undefined,
      onClick: () => { closeMenu(); it.onClick(); },
    }, it.icon ? icon(it.icon, 16) : h('span', { class: 'icon-space' }), h('span', null, it.label)))));
  let searchBox = null;
  if (opts.search) {
    // Long lists (countries…) get a filter box; typing anywhere in the list goes to it.
    const norm = (s) => String(s || '').toLocaleLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ي/g, 'ی').replace(/ك/g, 'ک');
    const buttons = [...menu.querySelectorAll('.menu-item')];
    const texts = items.filter((it) => it !== 'sep').map((it, i) => norm(`${buttons[i].textContent} ${it.search || ''}`));
    const empty = h('div', { class: 'menu-empty', hidden: true }, t('noResults'));
    searchBox = h('input', {
      class: 'input menu-search', type: 'search', placeholder: t('searchList'), spellcheck: 'false', autocomplete: 'off',
      onInput: () => {
        const q = norm(searchBox.value).trim();
        let shown = 0;
        buttons.forEach((b, i) => { const ok = !q || texts[i].includes(q); b.hidden = !ok; if (ok) shown++; });
        empty.hidden = shown > 0;
      },
      onKeydown: (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); const f = buttons.find((b) => !b.hidden); if (f) f.focus(); }
        else if (e.key === 'Enter') { e.preventDefault(); const f = buttons.find((b) => !b.hidden); if (f) f.click(); }
      },
    });
    menu.prepend(h('div', { class: 'menu-search-wrap' }, searchBox));
    menu.append(empty);
  }
  document.body.append(menu);
  openMenu = menu;
  openMenuAnchor = anchorOrPoint instanceof Element ? anchorOrPoint : null;
  openMenuClose = opts.onClose || null;
  const mw = menu.offsetWidth; const mh = menu.offsetHeight;
  let x; let y; let above = 0;
  if (anchorOrPoint instanceof Element) {
    const r = anchorOrPoint.getBoundingClientRect();
    const rtl = document.documentElement.dir === 'rtl';
    x = rtl ? r.right - mw : r.left;
    y = r.bottom + 6;
    if (y + mh > window.innerHeight - 8) { y = r.top - mh - 6; above = r.top - 6; }
  } else {
    x = anchorOrPoint.x; y = anchorOrPoint.y;
    if (document.documentElement.dir === 'rtl') x -= mw;
  }
  x = Math.max(8, Math.min(x, window.innerWidth - mw - 8));
  y = Math.max(8, Math.min(y, window.innerHeight - mh - 8));
  menu.style.left = `${x}px`;
  // Opened upwards: pin the bottom edge to the button so a filtered (shorter) list stays attached.
  if (above) {
    menu.style.bottom = `${window.innerHeight - above}px`;
    menu.style.maxHeight = `${above - 8}px`;
  } else menu.style.top = `${y}px`;
  const first = menu.querySelector('.menu-item.checked') || menu.querySelector('.menu-item:not([disabled])');
  if (searchBox) {
    searchBox.focus();
    if (first) first.scrollIntoView({ block: 'center' });
  } else if (first) first.focus();
  menu.addEventListener('keydown', (e) => {
    const list = [...menu.querySelectorAll('.menu-item:not([disabled])')].filter((b) => !b.hidden);
    const i = list.indexOf(document.activeElement);
    if (searchBox && e.target !== searchBox && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      searchBox.focus(); // the typed character lands in the search box
      return;
    }
    if (searchBox && e.target === searchBox) { if (e.key === 'Escape') closeMenu(); return; }
    if (!list.length) return;
    if (e.key === 'ArrowUp' && searchBox && i === 0) { e.preventDefault(); searchBox.focus(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
    if (e.key === 'Escape') closeMenu();
  });
}

document.addEventListener('mousedown', (e) => {
  if (!openMenu || openMenu.contains(e.target)) return;
  const btn = e.target instanceof Element ? e.target.closest('button') : null;
  if (openMenuAnchor && btn && (openMenuAnchor.contains(btn) || anchorSig(btn) === anchorSig(openMenuAnchor))) closedBy = { sig: anchorSig(btn), at: performance.now() };
  closeMenu();
});
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);

const toastHost = () => document.getElementById('toasts') || document.body.appendChild(h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' }));

export function toast(message, kind = 'info', ms = 4200) {
  const el = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(kind === 'error' ? 'alert' : kind === 'success' ? 'check' : kind === 'warning' ? 'alert' : 'info', 16),
    h('span', null, message));
  toastHost().append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, ms);
}

/** Modal dialog. Returns { close, el }. Focus is trapped inside while open. */
export function modal({ title, body, actions = [], wide = false, onClose }) {
  const prev = document.activeElement;
  const titleId = `m-${Math.random().toString(36).slice(2)}`;
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); if (onClose) onClose(); if (prev && prev.focus) prev.focus(); };
  const dialog = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div', { class: 'modal-head' },
      h('h2', { id: titleId }, title),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('close'), onClick: close }, icon('close', 18))),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-actions' }, actions.map((a) => button(a.label, { variant: a.variant, onClick: () => a.onClick(close) }))) : null);
  const overlay = h('div', { class: 'overlay', onMousedown: (e) => { if (e.target === overlay) close(); } }, dialog);
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Tab') {
      const f = [...dialog.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  }
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  const firstInput = dialog.querySelector('input, select, textarea') || dialog.querySelector('.modal-actions .btn.primary') || dialog.querySelector('button');
  if (firstInput) firstInput.focus();
  return { close, el: dialog };
}

export function confirmDialog({ title, message, confirmLabel, danger, extra }) {
  return new Promise((resolve) => {
    let result = false;
    modal({
      title,
      body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, message), extra || null),
      actions: [
        { label: t('cancel'), onClick: (close) => close() },
        { label: confirmLabel || t('confirm'), variant: danger ? 'danger' : 'primary', onClick: (close) => { result = true; close(); } },
      ],
      onClose: () => resolve(result),
    });
  });
}

/** Ask for a password (with a second "repeat" box when `confirm`). Resolves to the password or null. */
export function passwordDialog({ title, message, confirm = false, minLength = 8 }) {
  return new Promise((resolve) => {
    let result = null;
    const mk = (label) => h('input', { class: 'input', type: 'password', autocomplete: 'new-password', spellcheck: 'false', dir: 'ltr', 'aria-label': label });
    const pw = mk(t('password'));
    const pw2 = confirm ? mk(t('password_repeat')) : null;
    const err = h('div', { class: 'field-warn', hidden: true });
    const submit = (close) => {
      const v = pw.value;
      let problem = '';
      if (confirm && v.length < minLength) problem = t('BACKUP_PASSWORD_SHORT');
      else if (confirm && v !== pw2.value) problem = t('pw_mismatch');
      else if (!v) problem = t('BACKUP_PASSWORD_SHORT');
      if (problem) { err.textContent = problem; err.hidden = false; pw.focus(); return; }
      result = v;
      close();
    };
    let closeFn = null;
    const onEnter = (e) => { if (e.key === 'Enter' && closeFn) { e.preventDefault(); submit(closeFn); } };
    pw.addEventListener('keydown', onEnter);
    if (pw2) pw2.addEventListener('keydown', onEnter);
    const m = modal({
      title,
      body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, message), field(t('password'), pw), pw2 ? field(t('password_repeat'), pw2) : null, err),
      actions: [
        { label: t('cancel'), onClick: (close) => close() },
        { label: t('confirm'), variant: 'primary', onClick: (close) => submit(close) },
      ],
      onClose: () => resolve(result),
    });
    closeFn = m.close;
    setTimeout(() => pw.focus(), 0);
  });
}

/** Side drawer that slides in from the inline-end edge. Returns { close, el, body, foot }. */
export function drawer({ title, onClose, width = 560 }) {
  const prev = document.activeElement;
  const titleId = `d-${Math.random().toString(36).slice(2)}`;
  const body = h('div', { class: 'drawer-body' });
  const foot = h('div', { class: 'drawer-foot' });
  const titleEl = h('h2', { id: titleId }, title);
  const close = () => {
    panel.classList.add('out');
    overlay.classList.add('out');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => overlay.remove(), 180);
    if (onClose) onClose();
    if (prev && prev.focus) prev.focus();
  };
  const panel = h('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, style: { width: `min(${width}px, 100vw)` } },
    h('div', { class: 'drawer-head' }, titleEl),
    body, foot);
  const overlay = h('div', { class: 'overlay drawer-overlay', onMousedown: (e) => { if (e.target === overlay) close(); } }, panel);
  function onKey(e) { if (e.key === 'Escape' && !document.querySelector('.modal')) { e.stopPropagation(); close(); } }
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  return { close, el: panel, body, foot, setTitle: (s) => { titleEl.textContent = s; } };
}

/**
 * A number box with our own up / down arrows (the built-in Windows ones cannot be styled). Holding
 * an arrow keeps counting; every step fires "input", letting go fires one "change" (so a setting
 * is saved once). The keyboard arrows and the mouse wheel work as before.
 */
export function numberBox(input) {
  // The box and its input are looked up from the pressed arrow every time: after a redraw the
  // arrows stay on screen but these handlers come from the newer drawing, whose own elements were
  // never shown. State (timer, "changed") is kept on the box element that is on screen.
  const parts = (btn) => { const box = btn.closest('.num-box'); return { box, inp: box && box.querySelector('input') }; };
  const step = (box, inp, dir) => {
    const before = inp.value;
    try { if (dir > 0) inp.stepUp(); else inp.stepDown(); } catch { return; }
    if (inp.value !== before) { box.__moved = true; inp.dispatchEvent(new Event('input', { bubbles: true })); }
  };
  const arrow = (dir) => h('button', {
    type: 'button', class: `num-step ${dir > 0 ? 'up' : 'down'}`, tabindex: '-1', 'aria-hidden': 'true',
    onPointerdown: (e) => {
      const btn = e.currentTarget;
      const { box, inp } = parts(btn);
      if (!inp || e.button !== 0 || inp.disabled) return;
      e.preventDefault(); // keep the focus where it is
      inp.__editing = true; // a redraw meanwhile must not put the saved number back
      step(box, inp, dir);
      const repeat = (delay) => { box.__timer = setTimeout(() => { const p = parts(btn); if (p.inp) step(p.box, p.inp, dir); repeat(55); }, delay); };
      repeat(400);
      // Letting go anywhere (or the window losing focus) ends it — not tied to the arrow itself.
      const stop = () => {
        window.removeEventListener('pointerup', stop, true);
        window.removeEventListener('blur', stop);
        clearTimeout(box.__timer); box.__timer = 0;
        const now = parts(btn).inp || inp;
        now.__editing = false;
        if (box.__moved) { box.__moved = false; now.dispatchEvent(new Event('change', { bubbles: true })); }
      };
      window.addEventListener('pointerup', stop, true);
      window.addEventListener('blur', stop);
    },
  }, icon('chevron', 12, 2.4));
  return h('div', { class: 'num-box' }, input, h('div', { class: 'num-steps' }, arrow(1), arrow(-1)));
}

export function field(label, control, { help, warn, id, full } = {}) {
  const fid = id || `f-${Math.random().toString(36).slice(2)}`;
  // Only a real text box / list is tied to its caption: a caption tied to a button (our menus,
  // switches) would open or flip it when the caption itself is clicked.
  const native = control && control.tagName && ['INPUT', 'SELECT', 'TEXTAREA'].includes(control.tagName);
  if (native && !control.id) control.id = fid;
  const isNumber = native && control.tagName === 'INPUT' && control.type === 'number';
  return h('div', { class: `field ${full ? 'full' : ''}` },
    native ? h('label', { class: 'field-label', for: control.id }, label) : h('span', { class: 'field-label' }, label),
    isNumber ? numberBox(control) : control,
    help ? h('div', { class: 'field-help' }, help) : null,
    warn ? h('div', { class: 'field-warn' }, icon('alert', 14), h('span', null, warn)) : null);
}

export function input(value, onInput, attrs = {}) {
  return h('input', { class: 'input', value: value ?? '', spellcheck: 'false', autocomplete: 'off', ...attrs, onInput: (e) => onInput(e.target.value) });
}

export function debounce(fn, ms = 400) {
  let tm;
  return (...a) => { clearTimeout(tm); tm = setTimeout(() => fn(...a), ms); };
}
