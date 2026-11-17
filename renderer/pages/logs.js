// Logs page + helpers used by the log strip on the servers page.

import { h, icon, button, segmented, toast } from '../dom.js';
import { t } from '../i18n.js';
import { ui, api, render } from '../app.js';

const view = { level: 'all', query: '', paused: false };

export function logLine(e) {
  const lv = { error: 'ERR', warning: 'WARN', debug: 'DBG' }[e.level] || 'INFO';
  return h('div', { class: `logline lv-${e.level} ${e.source === 'app' ? 'src-app' : ''}` },
    h('span', { class: 't' }, e.time),
    h('span', { class: `lv lv-${e.level}` }, lv),
    h('span', { class: 's' }, e.source === 'app' ? 'Best' : e.source),
    h('span', { class: 'x' }, e.text));
}

function visible(e) {
  if (view.level === 'warning' && !['warning', 'error'].includes(e.level)) return false;
  if (view.level === 'error' && e.level !== 'error') return false;
  if (view.level === 'app' && e.source !== 'app') return false;
  if (view.query && !e.text.toLowerCase().includes(view.query.toLowerCase())) return false;
  return true;
}

/** Append one entry to whatever log views are on screen, without re-rendering the page. */
export function appendLog(entry) {
  const last = document.getElementById('log-last');
  if (last) { last.textContent = `${entry.time}  ${entry.text}`; last.classList.remove('is-empty'); }
  const strip = document.getElementById('log-strip-body');
  if (strip) {
    const atBottom = strip.scrollHeight - strip.scrollTop - strip.clientHeight < 30;
    strip.append(logLine(entry));
    while (strip.childElementCount > 300) strip.firstChild.remove();
    if (atBottom) strip.scrollTop = strip.scrollHeight;
  }
  const box = document.getElementById('logs-box');
  if (box && !view.paused && visible(entry)) {
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
    box.append(logLine(entry));
    while (box.childElementCount > 2000) box.firstChild.remove();
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
}

export function renderLogs() {
  const lines = ui.logs.filter(visible);
  const box = h('div', { class: 'logs-box', id: 'logs-box', role: 'log', 'aria-live': 'off' },
    lines.length ? lines.map(logLine) : h('div', { class: 'dim' }, t('noLogs')));
  queueMicrotask(() => { box.scrollTop = box.scrollHeight; });
  return h('div', { class: 'page logs-page' },
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('nav_logs')))),
    h('div', { class: 'row' },
      segmented([
        { value: 'all', label: t('logs_all') },
        { value: 'warning', label: 'Warning+' },
        { value: 'error', label: 'Error' },
        { value: 'app', label: 'Best' },
      ], view.level, (v) => { view.level = v; render(); }, { small: true }),
      h('label', { class: 'search grow', style: { maxWidth: '320px' } }, icon('search', 16), h('span', { class: 'sr-only' }, t('logs_search')),
        h('input', { type: 'search', value: view.query, placeholder: t('logs_search'), 'data-keep': 'logsearch', onInput: (e) => { view.query = e.target.value; render(); } })),
      h('span', { class: 'grow' }),
      button(view.paused ? t('logs_resume') : t('logs_pause'), { icon: view.paused ? 'play' : 'pause', onClick: () => { view.paused = !view.paused; render(); } }),
      button(t('logs_copy'), { icon: 'copy', onClick: async () => { await api.copy(lines.map((e) => `${e.time} [${e.source}] ${e.text}`).join('\n')); toast(t('copied'), 'success'); } }),
      button(t('logs_clear'), { icon: 'trash', onClick: async () => { await api.clearLogs(); ui.logs = []; render(); } })),
    box);
}
