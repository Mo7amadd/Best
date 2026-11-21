// App-wide keyboard shortcuts. Matched by physical key (e.code) so they also work with a
// Persian keyboard layout.

import { h, modal } from './dom.js';
import { t, IS_MAC } from './i18n.js';
import { S, ui, api, go, render, run, toggleSidebar } from './app.js';
import { serverActions } from './pages/servers.js';
import { openEditor } from './pages/editor.js';
import { focusSettingsSearch } from './pages/settings.js';

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
  ['Ctrl+F', 'sc_search', (e) => e.ctrlKey && !e.shiftKey && e.code === 'KeyF', (e) => (ui.page === 'settings' ? focusSettingsSearch() : onServers(() => serverActions.focusSearch())(e)), true],
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

// macOS: ⌘ takes the place of Ctrl (the page sees ⌘ as ctrlKey below), and the keys are written as
// symbols. ⇧⌘Q is macOS' own "Log Out", so the screen QR scan is ⌥⌘Q there.
const MAC_SCAN = (e) => e.ctrlKey && e.altKey && !e.shiftKey && e.code === 'KeyQ';
const MAC_LABELS = { sc_scan: '⌥⌘Q' };
/** "Ctrl+Shift+F" → "⇧⌘F" on macOS (modifiers in Apple's order); unchanged on Windows. */
export function keysLabel(keys, label) {
  if (!IS_MAC) return keys;
  if (MAC_LABELS[label]) return MAC_LABELS[label];
  return keys.replace(/(?:(?:Ctrl|Alt|Shift)\+)+[^\s·+]+/g, (combo) => {
    const parts = combo.split('+');
    const key = parts.pop();
    const glyph = [['Alt', '⌥'], ['Shift', '⇧'], ['Ctrl', '⌘']].filter(([m]) => parts.includes(m)).map(([, g]) => g).join('');
    return glyph + (key === 'Enter' ? '↩' : key);
  });
}
/** The event as the matchers expect it: on macOS ⌘ counts as Ctrl, and the Control key as nothing. */
function asWindowsKeys(e) {
  if (!IS_MAC) return e;
  return { code: e.code, key: e.key, altKey: e.altKey, shiftKey: e.shiftKey, ctrlKey: e.metaKey && !e.ctrlKey, metaKey: false };
}

export function showShortcuts() {
  if (document.querySelector('.modal')) return;
  modal({
    title: t('sc_title'),
    wide: true,
    body: h('dl', { class: 'kvtable shortcuts' },
      SHORTCUTS.filter(([, label], i) => SHORTCUTS.findIndex((x) => x[1] === label) === i).flatMap(([keys, label]) => [h('dt', null, t(label)), h('dd', null, h('kbd', { dir: 'ltr' }, keysLabel(keys, label)))])),
    actions: [{ label: t('close'), variant: 'primary', onClick: (c) => c() }],
  });
}

export function installShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (!S.settings || e.repeat) return;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement && document.activeElement.tagName);
    const inDialog = Boolean(document.querySelector('.overlay'));
    const k = asWindowsKeys(e);
    for (const [, label, match, action, whileTyping] of SHORTCUTS) {
      const hit = IS_MAC && label === 'sc_scan' ? MAC_SCAN : match;
      if (!hit || !action || !hit(k)) continue;
      if ((typing && !whileTyping) || (inDialog && action !== showShortcuts)) return;
      e.preventDefault();
      action(e);
      return;
    }
  });
}
