// App-wide keyboard shortcuts. Matched by physical key (e.code) so they also work with a
// Persian keyboard layout.

import { h, modal } from './dom.js';
import { t } from './i18n.js';
import { S, ui, api, go, render, run, toggleSidebar } from './app.js';
import { serverActions } from './pages/servers.js';
import { openEditor } from './pages/editor.js';

const PAGES = ['servers', 'subs', 'routing', 'connections', 'logs', 'updates', 'settings'];

function onServers(fn) {
  return () => {
    if (ui.page !== 'servers') { go('servers'); setTimeout(fn, 0); } else fn();
  };
}

/** [keys label, i18n key, matcher, action, allowWhileTyping] */
export const SHORTCUTS = [
  ['Ctrl+Enter', 'sc_toggle', (e) => e.ctrlKey && !e.shiftKey && e.code === 'Enter', () => run(() => api.toggleProxy()), true],
  ['Ctrl+Alt+B', 'sc_global', null, null],
  ['Ctrl+B', 'sc_sidebar', (e) => e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyB', () => toggleSidebar()],
  ['Ctrl+1 … 7', 'sc_pages', (e) => e.ctrlKey && !e.shiftKey && /^Digit[1-7]$/.test(e.code), (e) => go(PAGES[Number(e.code.slice(5)) - 1])],
  ['Ctrl+F', 'sc_search', (e) => e.ctrlKey && !e.shiftKey && e.code === 'KeyF', onServers(() => serverActions.focusSearch()), true],
  ['Ctrl+N', 'sc_new', (e) => e.ctrlKey && !e.shiftKey && e.code === 'KeyN', () => openEditor(null)],
  ['Ctrl+V', 'sc_paste', (e) => e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyV', onServers(() => serverActions.importClipboard())],
  ['Ctrl+Shift+V', 'sc_paste', (e) => e.ctrlKey && e.shiftKey && e.code === 'KeyV', onServers(() => serverActions.importClipboard()), true],
  ['Ctrl+C', 'sc_copyLinks',
    (e) => e.ctrlKey && !e.shiftKey && e.code === 'KeyC' && ui.page === 'servers' && ui.selected.size > 0 && !String(window.getSelection() || ''),
    () => serverActions.copySelected()],
  ['Ctrl+Shift+Q', 'sc_scan', (e) => e.ctrlKey && e.shiftKey && e.code === 'KeyQ', onServers(() => serverActions.scanScreen())],
  ['Ctrl+R', 'sc_testReal', (e) => e.ctrlKey && !e.shiftKey && e.code === 'KeyR', onServers(() => serverActions.test('real'))],
  ['Ctrl+T', 'sc_testTcp', (e) => e.ctrlKey && !e.shiftKey && e.code === 'KeyT', onServers(() => serverActions.test('tcping'))],
  ['Ctrl+Shift+S', 'sc_testSpeed', (e) => e.ctrlKey && e.shiftKey && e.code === 'KeyS', onServers(() => serverActions.test('speed'))],
  ['Ctrl+Shift+F', 'sc_fastest', (e) => e.ctrlKey && e.shiftKey && e.code === 'KeyF', onServers(() => serverActions.useFastest()), true],
  ['Ctrl+U', 'sc_update', (e) => e.ctrlKey && !e.shiftKey && e.code === 'KeyU', onServers(() => serverActions.updateSubs())],
  ['Ctrl+L', 'sc_logs', (e) => e.ctrlKey && !e.shiftKey && e.code === 'KeyL', onServers(() => serverActions.toggleLogs())],
  ['Alt+1 … 4', 'sc_proxy', (e) => e.altKey && !e.ctrlKey && /^Digit[1-4]$/.test(e.code), (e) => run(() => api.setProxyMode(['off', 'on', 'pac', 'keep'][Number(e.code.slice(5)) - 1]))],
  ['Ctrl+,', 'sc_settings', (e) => e.ctrlKey && e.code === 'Comma', () => go('settings'), true],
  ['↑ ↓ · Enter · Delete · F2', 'sc_table', null, null],
  ['Ctrl+A', 'sc_tableSel', null, null],
  ['F1 · Ctrl+/', 'sc_help', (e) => e.code === 'F1' || (e.ctrlKey && e.code === 'Slash'), showShortcuts, true],
];

export function showShortcuts() {
  if (document.querySelector('.modal')) return;
  modal({
    title: t('sc_title'),
    wide: true,
    body: h('dl', { class: 'kvtable shortcuts' },
      SHORTCUTS.filter(([, label], i) => SHORTCUTS.findIndex((x) => x[1] === label) === i).flatMap(([keys, label]) => [h('dt', null, t(label)), h('dd', null, h('kbd', { dir: 'ltr' }, keys))])),
    actions: [{ label: t('close'), variant: 'primary', onClick: (c) => c() }],
  });
}

export function installShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (!S.settings || e.repeat) return;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement && document.activeElement.tagName);
    const inDialog = Boolean(document.querySelector('.overlay'));
    for (const [, , match, action, whileTyping] of SHORTCUTS) {
      if (!match || !action || !match(e)) continue;
      if ((typing && !whileTyping) || (inDialog && action !== showShortcuts)) return;
      e.preventDefault();
      action(e);
      return;
    }
  });
}
