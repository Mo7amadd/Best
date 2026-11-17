// Updates page: Xray, sing-box, GeoIP, GeoSite (and a placeholder for app updates).

import { h, icon, button, toggle, toast, confirmDialog, ltr } from '../dom.js';
import { t, num, locale } from '../i18n.js';
import { S, ui, api, run, render, go } from '../app.js';

const ROWS = [
  { id: 'xray', name: 'Xray', desc: 'upd_xray_d', repo: 'XTLS/Xray-core' },
  { id: 'singbox', name: 'sing-box', desc: 'upd_singbox_d', repo: 'SagerNet/sing-box' },
  { id: 'mihomo', name: 'mihomo', desc: 'upd_mihomo_d', repo: 'MetaCubeX/mihomo', optional: true },
  { id: 'geoip', name: 'GeoIP', desc: 'upd_geoip_d', repo: 'v2fly/geoip' },
  { id: 'geosite', name: 'GeoSite', desc: 'upd_geosite_d', repo: 'v2fly/domain-list-community' },
  { id: 'geoIr', name: 'Iran rules 🇮🇷', desc: 'upd_geoIr_d', repo: 'Chocolate4U/Iran-v2ray-rules', optional: true },
  { id: 'geoRu', name: 'Russia rules 🇷🇺', desc: 'upd_geoRu_d', repo: 'runetfreedom/russia-v2ray-rules-dat', optional: true },
];

export function availableUpdates() {
  const items = (S.updates && S.updates.items) || {};
  return ROWS.filter((r) => items[r.id] && items[r.id].available);
}

async function applyOne(id) {
  const ok = await run(() => api.applyUpdate(id));
  if (ok === true) toast(t('upd_done', { name: ROWS.find((r) => r.id === id).name }), 'success');
  api.versions().then((v) => { ui.versions = v; render(); });
}

export async function applyAll() {
  const r = await run(() => api.applyAllUpdates());
  if (r) {
    if (r.updated) toast(t('upd_doneAll', { n: num(r.updated) }), 'success');
    if (r.failed.length) toast(t('upd_failedSome', { n: num(r.failed.length) }), 'error', 7000);
  }
  api.versions().then((v) => { ui.versions = v; render(); });
}

function statusOf(item, id) {
  if (!item) return h('span', { class: 'dim' }, '—');
  if (item.optional && !item.installed && !item.busy) return h('span', { class: 'dim' }, t('upd_notInstalled'));
  if (item.busy) {
    return h('div', { class: 'upd-progress', 'data-progress': id || '' },
      h('span', { class: 'spinner' }),
      h('span', { class: 'tp-bar' }, h('span', { style: { width: `${item.progress || 0}%` } })),
      h('span', { class: 'mono dim' }, `${num(item.progress || 0)}%`),
      id ? h('button', {
        type: 'button', class: 'icon-btn xs upd-cancel', title: t('upd_cancel'), 'aria-label': t('upd_cancel'),
        hidden: (item.progress || 0) >= (id === 'app' ? 100 : 90),
        onClick: async (e) => { e.currentTarget.disabled = true; if (await run(() => api.cancelUpdate(id))) toast(t('upd_cancelled'), 'info'); },
      }, icon('close', 13)) : null);
  }
  if (item.error) return h('span', { class: 'upd-err', title: item.error }, icon('alert', 14), t(item.error === 'CHECKSUM_MISMATCH' ? 'upd_badHash' : /^UPDATE_(START_FAILED|UAC_DECLINED)/.test(item.error) ? 'upd_installFailed' : 'upd_error'));
  if (item.available) return h('span', { class: 'pill accent' }, t('upd_available'));
  if (item.latest) return h('span', { class: 'upd-ok' }, icon('check', 14), t('upd_upToDate'));
  return h('span', { class: 'dim' }, t('upd_notChecked'));
}

function row(r) {
  const item = (S.updates && S.updates.items && S.updates.items[r.id]) || null;
  const current = item && item.current ? (item.current === 'bundled' ? t('upd_bundled') : item.current) : '—';
  return h('div', { class: 'upd-row' },
    h('div', { class: 'upd-name' },
      h('b', null, r.name),
      h('span', { class: 'dim' }, t(r.desc)),
      h('span', { class: 'upd-repo' }, ltr(`github.com/${r.repo}`, 'mono'))),
    h('div', { class: 'upd-ver' },
      h('span', { class: 'dim' }, t('upd_current')), h('b', null, ltr(current, 'mono')),
      item && item.custom ? h('span', { class: 'chip' }, t('upd_updatedCopy')) : null),
    h('div', { class: 'upd-ver' },
      h('span', { class: 'dim' }, t('upd_latest')), h('b', null, ltr(item && item.latest ? item.latest : '—', 'mono'))),
    h('div', { class: 'upd-status' }, statusOf(item, r.id)),
    h('div', { class: 'upd-actions' },
      item && item.optional && !item.installed
        ? button(t('upd_install'), { size: 'sm', variant: 'primary', icon: 'download', disabled: item.busy, onClick: () => applyOne(r.id) })
        : null,
      item && item.optional && item.installed
        ? button(t('upd_remove'), { size: 'sm', variant: 'ghost', disabled: item.busy, onClick: () => run(() => api.resetUpdate(r.id)) })
        : null,
      item && item.optional && !item.installed ? null : button(t('update'), { size: 'sm', variant: item && item.available ? 'primary' : '', icon: 'download', disabled: !item || item.busy || !item.available, onClick: () => applyOne(r.id) }),
      item && item.custom ? button(t('upd_reset'), {
        size: 'sm', variant: 'ghost', disabled: item.busy,
        onClick: async () => {
          if (await confirmDialog({ title: t('upd_reset'), message: t('upd_reset_confirm', { name: r.name }), confirmLabel: t('upd_reset') })) {
            await run(() => api.resetUpdate(r.id));
            api.versions().then((v) => { ui.versions = v; render(); });
          }
        },
      }) : null));
}

/** A newer Best is waiting (going back from a test version is the user's own choice, not an update). */
function appNewer() {
  const a = S.appUpdate;
  return Boolean(a && a.configured && a.available && !a.back);
}

/** How many updates are waiting: shown on the menu. */
export function updateCount() {
  return availableUpdates().length + (appNewer() ? 1 : 0);
}

function bannerItems() {
  const list = availableUpdates().map((r) => ({ key: r.id, name: r.name, version: S.updates.items[r.id].latest }));
  if (appNewer()) list.unshift({ key: 'app', name: 'Best', version: S.appUpdate.latest });
  return list;
}

// Closed with ×: those versions never show the bar again (also after a restart); only a newer
// version brings it back once. The number on the menu stays.
const CLOSED = 'best.updatesBannerClosed';
function closedVersions() {
  try { const v = JSON.parse(localStorage.getItem(CLOSED) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

export function updatesBanner() {
  if (ui.page === 'updates') return null;
  const list = bannerItems();
  const closed = new Set([...closedVersions(), ...String(ui.updatesBannerClosed || '').split(',')]);
  if (!list.length || list.every((x) => closed.has(`${x.key}@${x.version}`))) return null;
  const onlyData = !list.some((x) => x.key === 'app');
  return h('div', { class: 'upd-banner', role: 'status', 'data-key': 'upd-banner' },
    icon('download', 18),
    h('span', { class: 'grow' }, h('b', null, t('upd_bannerTitle')), ' ', ltr(list.map((x) => `${x.name} ${x.version}`).join(' · '))),
    onlyData ? button(t('upd_updateAll'), { size: 'sm', variant: 'primary', onClick: applyAll }) : null,
    button(t('upd_view'), { size: 'sm', variant: onlyData ? undefined : 'primary', onClick: () => go('updates') }),
    h('button', {
      type: 'button', class: 'icon-btn upd-banner-close', title: t('close'), 'aria-label': t('close'),
      onClick: () => {
        try { localStorage.setItem(CLOSED, JSON.stringify(list.map((x) => `${x.key}@${x.version}`))); } catch { /* only for this session */ }
        ui.updatesBannerClosed = list.map((x) => `${x.key}@${x.version}`).join(',');
        render();
      },
    }, icon('close', 16)));
}

function appStatus() {
  const a = S.appUpdate || {};
  if (!a.configured) return h('span', { class: 'chip', title: t('upd_appNoRepo_help') }, t('upd_appNoRepo'));
  if (a.back && a.available && !a.busy && !a.error) return h('span', { class: 'pill accent' }, t('upd_backAvailable'));
  return statusOf({ ...a, optional: false, installed: true }, 'app');
}

export function renderUpdates() {
  const st = S.updates || { checking: false, checkedAt: 0, items: {} };
  if (!ui.updatesAutoChecked && !st.checking) {
    // Opening the page always refreshes the status.
    ui.updatesAutoChecked = true;
    api.checkUpdates().catch(() => {});
  }
  const any = availableUpdates().length > 0;
  const checked = st.checkedAt ? new Date(st.checkedAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) : '';
  return h('div', { class: 'page', 'data-scroll': 'page-updates' },
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, t('nav_updates')), h('p', null, t('upd_help'))),
      h('div', { class: 'row' },
        h('span', { class: 'dim', style: { fontSize: '12px' } }, st.checking ? t('upd_checking') : checked ? t('upd_checkedAt', { time: checked }) : ''),
        button(t('upd_checkNow'), { icon: 'refresh', disabled: st.checking, onClick: () => run(() => api.checkUpdates()) }),
        button(t('upd_updateAll'), { variant: 'primary', icon: 'download', disabled: !any, onClick: applyAll }))),
    h('section', { class: 'card upd-list' },
      ROWS.map(row),
      h('div', { class: 'upd-row upd-app' },
        h('div', { class: 'upd-name' }, h('b', null, 'Best'), h('span', { class: 'dim' }, t('upd_app_d'))),
        h('div', { class: 'upd-ver' }, h('span', { class: 'dim' }, t('upd_current')), h('b', null, ltr(S.version, 'mono'))),
        h('div', { class: 'upd-ver' }, h('span', { class: 'dim' }, t('upd_latest')), h('b', null, ltr((S.appUpdate && S.appUpdate.latest) || '—', 'mono')), /-/.test((S.appUpdate && S.appUpdate.latest) || '') ? h('span', { class: 'pill soft' }, t('upd_betaBadge')) : null),
        h('div', { class: 'upd-status' }, appStatus()),
        h('div', { class: 'upd-actions' }, S.appUpdate && S.appUpdate.available && S.appUpdate.back
          ? button(t('upd_goBack'), {
            size: 'sm', variant: 'primary', icon: 'download', disabled: S.appUpdate.busy,
            onClick: async () => {
              if (await confirmDialog({ title: t('upd_goBack'), message: t('upd_goBack_confirm', { from: S.version, to: S.appUpdate.latest }), confirmLabel: t('upd_goBack') })) {
                run(() => api.installAppUpdate());
              }
            },
          })
          : S.appUpdate && S.appUpdate.available
          ? button(t('update'), { size: 'sm', variant: 'primary', icon: 'download', disabled: S.appUpdate.busy, onClick: () => run(() => api.installAppUpdate()) })
          : null))),
    h('section', { class: 'card card-pad stack' },
      h('div', { class: 'switch-row' },
        h('div', { class: 'txt' }, h('span', null, t('upd_auto')), h('span', null, t('upd_auto_d'))),
        toggle(S.settings.autoCheckUpdates, (v) => run(() => api.setSettings({ autoCheckUpdates: v })), { label: t('upd_auto') })),
      h('div', { class: 'switch-row' },
        h('div', { class: 'txt' }, h('span', null, t('upd_beta')), h('span', null, t('upd_beta_d'))),
        toggle(S.settings.betaUpdates, (v) => run(() => api.setSettings({ betaUpdates: v })), { label: t('upd_beta') })),
      h('div', { class: 'note good' }, icon('shield', 16), h('span', null, t('upd_security')))));
}
