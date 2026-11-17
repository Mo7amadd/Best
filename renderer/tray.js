// Tray popover: quick connect, fastest servers, system proxy mode.

import { h, mount, icon, segmented, button } from './dom.js';
import { t, setLanguage, num } from './i18n.js';

const api = window.best;
let S = null;
let busy = false;

function theme(settings) {
  let th = settings.theme;
  if (th === 'system') th = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = th;
  document.documentElement.dataset.accent = settings.accent;
  setLanguage(settings.language);
}

function tier(ms) { return ms < 300 ? 3 : ms < 700 ? 2 : 1; }

function render() {
  if (!S) return;
  const on = Boolean(S.core.running) && (S.settings.proxyMode === 'on' || S.settings.proxyMode === 'pac' || S.settings.tun);
  const active = S.servers.find((s) => s.id === S.activeId);
  const fastest = S.servers.filter((s) => s.delay > 0 && s.id !== S.activeId).sort((a, b) => a.delay - b.delay).slice(0, 4);
  const ap = S.routing.profiles.find((p) => p.id === S.routing.activeId) || {};
  const routeLabel = ap.builtin ? t({ 'p-local': 'mode_bypassLocal', 'p-global': 'mode_global', 'p-direct': 'mode_direct' }[ap.id]) : ap.name;

  mount(document.getElementById('tray'),
    h('div', { class: 'tray-head' },
      h('div', { class: 'tray-brand' }, h('img', { src: 'logo.png', alt: '' }), 'Best'),
      h('span', { class: `tray-status ${on ? 'on' : ''}` }, h('span', { class: 'dot' }), on ? t('connected') : t('off'))),
    h('div', { class: 'tray-conn' },
      h('button', {
        type: 'button', class: `power ${on ? 'on' : ''} ${busy ? 'busy' : ''}`, 'aria-label': t('sc_toggle'), title: t('sc_toggle'), disabled: busy || (!on && !active),
        onClick: async () => { busy = true; render(); try { await api.toggleProxy(); } finally { busy = false; render(); } },
      }, icon('power', 22, 2.4)),
      h('div', { class: 'info' },
        h('b', null, active ? (active.remark || active.address) : t('noServerSelected')),
        active ? h('span', null, `${active.protocol.toUpperCase()} · ${active.transport}${active.delay > 0 ? ` · ${num(active.delay)} ${t('ms')}` : ''}`) : null)),
    h('div', { class: 'tray-list' },
      h('span', { class: 'section-label', style: { padding: '0 4px' } }, t('fastestRightNow')),
      fastest.length ? fastest.map((s) => h('button', {
        type: 'button', class: 'tray-item',
        onClick: async () => { busy = true; render(); try { await api.selectServer(s.id); if (!S.core.running) await api.connect(s.id); } finally { busy = false; render(); } },
      },
      h('span', { class: `bars t${tier(s.delay)}`, 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
      h('span', { class: 'nm' }, s.remark || s.address),
      h('span', { class: 'ms' }, `${num(s.delay)} ${t('ms')}`))) : h('span', { class: 'dim', style: { padding: '6px 4px', fontSize: '12px' } }, t('notTested'))),
    h('div', { class: 'stack', style: { gap: '8px' } },
      h('span', { class: 'section-label', style: { padding: '0 4px' } }, t('systemProxy')),
      segmented(['off', 'on', 'pac'].map((m) => ({ value: m, label: t(`proxy_${m}`) })), S.settings.proxyMode, (m) => api.setProxyMode(m), { small: true }),
      h('div', { class: 'tray-meta' },
        h('span', null, `${t('routing')}: `, h('b', null, routeLabel)),
        h('span', null, 'TUN: ', h('b', null, S.settings.tun ? t('on') : t('off'))))),
    h('div', { class: 'tray-foot' },
      button(t('openApp'), { onClick: () => api.showMain() }),
      S.core.running || S.core.tun ? button(t('disconnect'), { variant: 'ghost', onClick: async () => { busy = true; render(); try { await api.disconnect(); } finally { busy = false; render(); } } }) : null,
      button(t('quit'), { variant: 'ghost', onClick: () => api.quit() })));
}

api.getState().then((st) => { S = st; theme(S.settings); render(); });
api.on('state', (st) => { S = st; theme(S.settings); render(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') api.hideTray(); });
