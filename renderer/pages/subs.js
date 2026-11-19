// Subscriptions page and the subscription editor drawer.

import { h, icon, button, toggle, drawer, field, input, select, confirmDialog, toast } from '../dom.js';
import { t, num, locale } from '../i18n.js';
import { S, ui, api, run, render, formatBytes, go, localSet } from '../app.js';
import { subLinks, subNotices } from './servers.js';

// Codes the main process gives for a failed subscription, in the user's language (else as sent).
const SUB_ERRORS = ['FILTER_EMPTY', 'HWID_LIMIT', 'HWID_REQUIRED', 'INSECURE_REDIRECT'];
const subError = (e) => (e === 'EMPTY' ? t('emptySub') : SUB_ERRORS.includes(e) ? t(e) : e);

export function openSubEditor(id) {
  const existing = id ? S.subs.find((s) => s.id === id) : null;
  const draft = existing
    ? { ...existing }
    : { name: '', url: '', userAgent: '', autoUpdateHours: 0, enabled: true };
  const d = drawer({ title: existing ? t('sub_edit') : t('sub_new'), width: 520 });
  const err = h('div', { class: 'ed-error', hidden: true });

  const urlInput = input(draft.url, (v) => { draft.url = v.trim(); }, { dir: 'ltr', class: 'input mono', placeholder: 'https://…' });
  d.body.append(
    h('div', { class: 'ed-section' },
      field(t('sub_name'), input(draft.name, (v) => { draft.name = v; }, { maxlength: 60, placeholder: t('sub_name_auto') }), { help: t('sub_name_help') }),
      field(t('sub_url'), urlInput),
      field(t('sub_ua'), input(draft.userAgent, (v) => { draft.userAgent = v; }, { dir: 'ltr', placeholder: S.settings.subUserAgent || `Best/${S.version}` })),
      field(t('sub_moreUrls'), (function more() {
        const ta = h('textarea', { class: 'input mono', rows: 2, dir: 'ltr', spellcheck: 'false', placeholder: 'https://…', onInput: (e) => { draft.moreUrls = e.target.value.split(/\s+/).filter(Boolean); } });
        ta.value = (draft.moreUrls || []).join('\n');
        return ta;
      })(), { help: t('sub_moreUrls_help') }),
      h('div', { class: 'grid2' },
        field(t('sub_filter'), input(draft.filter || '', (v) => { draft.filter = v; }, { dir: 'ltr', class: 'input mono', placeholder: 'DE|NL' })),
        field(t('sub_exclude'), input(draft.exclude || '', (v) => { draft.exclude = v; }, { dir: 'ltr', class: 'input mono', placeholder: 'expire|traffic' }))),
      h('div', { class: 'field-help' }, t('sub_filter_help')),
      field(t('via'), select([{ value: '', label: t('via_none') }, ...S.servers.filter((s) => s.protocol !== 'group' && s.protocol !== 'custom' && s.subId !== draft.id).map((s) => ({ value: s.id, label: s.remark || s.address }))], draft.via || '', (v) => { draft.via = v; }, { search: true }), { help: t('via_sub_help') }),
      field(t('sub_autoHours'), input(String(draft.autoUpdateHours || 0), (v) => { draft.autoUpdateHours = Number.parseInt(v, 10) || 0; }, { type: 'number', min: 0, max: 720, dir: 'ltr' })),
      h('div', { class: 'switch-row' }, h('div', { class: 'txt' }, h('span', null, t('sub_enabled'))),
        (function sw() { const el = toggle(draft.enabled, (v) => { draft.enabled = v; el.setAttribute('aria-checked', String(v)); }, { label: t('sub_enabled') }); return el; })())),
    err);

  const save = async (andUpdate) => {
    err.hidden = true;
    try {
      const newId = await api.saveSub(draft);
      d.close();
      if (andUpdate) {
        const [r] = await api.updateSubs([newId]);
        const sub = S.subs.find((s) => s.id === newId) || draft;
        if (r && r.ok) toast(t('t_subUpdated', { name: sub.name, n: num(r.count) }), 'success');
        else if (r) toast(t('t_subFailed', { name: sub.name, e: subError(r.error) }), 'error', 7000);
        ui.group = newId;
        localSet('group', newId);
        go('servers');
      } else toast(t('t_saved'), 'success');
    } catch (e) {
      const msg = String(e.message || e);
      err.replaceChildren(icon('alert', 16), h('span', null, msg.includes('INVALID_URL') ? t('INVALID_URL') : msg));
      err.hidden = false;
    }
  };
  d.foot.append(
    button(t('cancel'), { variant: 'ghost', onClick: d.close }),
    h('span', { class: 'grow' }),
    button(t('save'), { onClick: () => save(false) }),
    button(`${t('save')} + ${t('update')}`, { variant: 'primary', icon: 'refresh', onClick: () => save(true) }));
  urlInput.focus();
}

async function removeSub(sub) {
  const box = h('input', { type: 'checkbox', id: 'rm-servers', checked: true });
  const ok = await confirmDialog({
    title: t('sub_removeTitle'), message: t('sub_removeBody', { name: sub.name }), confirmLabel: t('delete'), danger: true,
    extra: h('label', { class: 'row', for: 'rm-servers' }, box, t('sub_removeServers')),
  });
  if (ok) await run(() => api.removeSub(sub.id, box.checked));
}

async function updateOne(sub, btn) {
  btn.disabled = true;
  const [r] = (await run(() => api.updateSubs([sub.id]))) || [];
  btn.disabled = false;
  if (r && r.ok) toast(t('t_subUpdated', { name: sub.name, n: num(r.count) }), 'success');
  else if (r) toast(t('t_subFailed', { name: sub.name, e: subError(r.error) }), 'error', 7000);
}

function subCard(sub) {
  const count = S.servers.filter((s) => s.subId === sub.id).length;
  const i = sub.info || {};
  const used = (i.upload || 0) + (i.download || 0);
  let exp = t('never');
  if (i.expire) {
    const days = Math.ceil((i.expire * 1000 - Date.now()) / 86400000);
    exp = days < 0 ? t('expired') : t('daysLeft', { n: num(days) });
  }
  let host = '';
  try { host = new URL(sub.url).host; } catch { host = sub.url; }
  const last = sub.lastUpdate ? new Date(sub.lastUpdate).toLocaleString(locale()) : t('subs_neverUpdated');
  const hours = sub.autoUpdateHours || S.settings.subAutoUpdateHours;
  const updBtn = button(t('update'), { size: 'sm', icon: 'refresh', onClick: (e) => updateOne(sub, e.currentTarget) });
  return h('article', { class: 'card sub-card' },
    h('div', { class: 'sub-top' },
      h('div', { class: 'names' }, h('h3', null, sub.name), h('div', { class: 'sub-url', title: host }, host)),
      toggle(sub.enabled, (v) => run(() => api.saveSub({ ...sub, enabled: v })), { label: t('sub_enabled') })),
    h('div', { class: 'sub-meta' },
      h('div', null, t('nav_servers'), h('b', null, t('subs_servers', { n: num(count) }))),
      h('div', null, t('traffic'), h('b', null, i.total ? `${formatBytes(used)} / ${formatBytes(i.total)}` : `${formatBytes(used)} / ∞`)),
      h('div', null, t('expires'), h('b', null, exp)),
      h('div', null, t('subs_auto'), h('b', null, hours ? t('subs_everyHours', { n: num(hours) }) : t('subs_manual'))),
      h('div', { style: { gridColumn: '1 / -1' } }, t('subs_lastUpdate'), h('b', null, last))),
    i.total
      ? h('div', { class: 'usage-bar', style: { width: '100%' } }, h('span', { style: { width: `${Math.min(100, (used / i.total) * 100)}%` } }))
      : h('div', { class: 'usage-bar unlimited', style: { width: '100%' }, title: t('unlimited') }, h('span')),
    sub.error ? h('div', { class: 'sub-err' }, subError(sub.error)) : null,
    subNotices(sub),
    sub.supportUrl || sub.webPageUrl ? h('div', { class: 'row' }, subLinks(sub)) : null,
    h('div', { class: 'sub-actions' },
      updBtn,
      button(t('nav_servers'), { size: 'sm', icon: 'servers', onClick: () => { ui.group = sub.id; localSet('group', sub.id); go('servers'); } }),
      button(t('edit'), { size: 'sm', icon: 'edit', onClick: () => openSubEditor(sub.id) }),
      button(t('delete'), { size: 'sm', icon: 'trash', variant: 'danger', onClick: () => removeSub(sub) })));
}

export function renderSubs() {
  return h('div', { class: 'page', 'data-scroll': 'page-subs' },
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, t('subs_title')), h('p', null, t('subs_help'))),
      h('div', { class: 'row' },
        h('button', {
          type: 'button', class: 'btn', disabled: !S.subs.length,
          onClick: async (e) => {
            const b = e.currentTarget; b.disabled = true;
            const res = await run(() => api.updateSubs());
            b.disabled = false;
            for (const r of res || []) {
              const sub = S.subs.find((s) => s.id === r.id) || { name: '' };
              if (r.ok) toast(t('t_subUpdated', { name: sub.name, n: num(r.count) }), 'success');
              else toast(t('t_subFailed', { name: sub.name, e: subError(r.error) }), 'error', 7000);
            }
          },
        }, icon('refresh', 16), h('span', null, t('subs_updateAll'))),
        button(t('addSub'), { variant: 'primary', icon: 'plus', onClick: () => openSubEditor(null) }))),
    S.subs.length
      ? h('div', { class: 'sub-list' }, S.subs.map(subCard))
      : h('div', { class: 'card empty' }, h('h3', null, t('subs_empty')), button(t('addSub'), { variant: 'primary', icon: 'plus', onClick: () => openSubEditor(null) })));
}

export { render };
