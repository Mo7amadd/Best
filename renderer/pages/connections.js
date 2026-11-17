// Live connections (sing-box / mihomo): where each app connection goes, through which rule and
// outbound, how much it moved, with a button to close it. Xray has no such interface.

import { h, icon, button, toast } from '../dom.js';
import { t, num } from '../i18n.js';
import { S, ui, api, run, formatBytes } from '../app.js';

const view = { query: '', sort: 'start' };

function duration(start) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(start)) / 1000));
  return s < 60 ? `${num(s)}s` : s < 3600 ? `${num(Math.floor(s / 60))}m ${num(s % 60)}s` : `${num(Math.floor(s / 3600))}h ${num(Math.floor((s % 3600) / 60))}m`;
}

function rows() {
  const q = view.query.trim().toLowerCase();
  let list = (ui.connections || []).filter((c) => {
    if (!q) return true;
    const m = c.metadata || {};
    return `${m.host} ${m.destinationIP} ${m.processPath} ${(c.chains || []).join(' ')} ${c.rule}`.toLowerCase().includes(q);
  });
  const by = { start: (a, b) => Date.parse(b.start) - Date.parse(a.start), down: (a, b) => b.download - a.download, up: (a, b) => b.upload - a.upload };
  list = list.slice().sort(by[view.sort] || by.start);
  return list.slice(0, 500);
}

function row(c) {
  const m = c.metadata || {};
  const host = m.host || m.destinationIP || '?';
  const proc = (m.processPath || '').split(/[\\/]/).pop();
  const chain = (c.chains || []).slice().reverse().join(' → ').toLowerCase();
  return h('div', { class: 'trow crow', role: 'row' },
    h('span', { class: 'c-host', title: `${host}:${m.destinationPort}` }, h('bdi', { dir: 'ltr', class: 'mono' }, `${host}:${m.destinationPort}`), proc ? h('span', { class: 'dim' }, proc) : null),
    h('span', { class: 'dim' }, `${(m.network || '').toUpperCase()}`),
    h('span', { class: 'c-chain', title: `${c.rule || ''} ${c.rulePayload || ''}` }, chain.includes('direct') ? h('span', { class: 'pill soft' }, t('cn_direct')) : /block|reject/.test(chain) ? h('span', { class: 'pill' }, t('cn_block')) : h('span', { class: 'pill accent' }, t('cn_proxy'))),
    h('span', { class: 'mono' }, `↓ ${formatBytes(c.download)}`),
    h('span', { class: 'mono dim' }, `↑ ${formatBytes(c.upload)}`),
    h('span', { class: 'dim' }, duration(c.start)),
    h('span', null, h('button', { type: 'button', class: 'icon-btn xs', title: t('cn_close'), 'aria-label': t('cn_close'), onClick: () => run(() => api.closeConnection(c.id)) }, icon('close', 13))));
}

/** Called for every update from the core (once a second while this page is open). */
export function paintConnections() {
  const body = document.getElementById('conn-body');
  if (!body) return;
  const list = rows();
  body.replaceChildren(...(list.length ? list.map(row) : [h('div', { class: 'empty' }, h('p', null, t('cn_none')))]));
  const c = document.getElementById('conn-count');
  if (c) c.textContent = t('cn_count', { n: num((ui.connections || []).length) });
}

export function renderConnections() {
  const running = S.core.running;
  const supported = running && S.core.core !== 'xray'; // sing-box and mihomo
  if (!ui.connWatching) { ui.connWatching = true; api.watchConnections(true); }
  const head = h('div', { class: 'page-head' },
    h('div', null, h('h1', null, t('nav_connections')), h('p', null, t('cn_help'))),
    h('div', { class: 'row' },
      h('span', { id: 'conn-count', class: 'dim' }, t('cn_count', { n: num((ui.connections || []).length) })),
      button(t('cn_closeAll'), { icon: 'close', variant: 'ghost', disabled: !supported, onClick: async () => { if (await run(() => api.closeConnection('all'))) toast(t('cn_closedAll'), 'success'); } })));
  if (!supported) {
    return h('div', { class: 'page' }, head, h('section', { class: 'card card-pad' },
      h('div', { class: 'note' }, icon('info', 16), h('span', null, running ? t('cn_xray') : t('cn_notRunning')))));
  }
  const search = h('input', { class: 'input', type: 'search', placeholder: t('cn_search'), value: view.query, 'data-keep': 'conn-search', onInput: (e) => { view.query = e.target.value; paintConnections(); } });
  const sortBtn = (k, label) => h('button', { type: 'button', class: `th-sort ${view.sort === k ? 'on' : ''}`, onClick: () => { view.sort = k; paintConnections(); } }, label);
  const body = h('div', { id: 'conn-body' });
  const page = h('div', { class: 'page', 'data-scroll': 'page-conn' }, head,
    h('section', { class: 'card servers' },
      h('div', { class: 'toolbar' }, h('div', { class: 'grow' }, search)),
      h('div', { class: 'table-wrap' }, h('div', { class: 'table conn-table', role: 'table' },
        h('div', { class: 'trow thead crow', role: 'row' },
          h('span', null, t('cn_host')), h('span', null, t('cn_net')), h('span', null, t('cn_route')),
          sortBtn('down', t('download')), sortBtn('up', t('upload')), sortBtn('start', t('cn_time')), h('span')),
        body))));
  queueMicrotask(paintConnections);
  return page;
}

/** Leaving the page stops the updates. */
export function leaveConnections() {
  if (ui.connWatching) { ui.connWatching = false; api.watchConnections(false); }
}
