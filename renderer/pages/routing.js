// Routing page: profiles (like v2rayN rule sets), compound rules, import/export, global options.

import { h, icon, button, toggle, select, drawer, field, input, segmented, confirmDialog, modal, toast, showMenu } from '../dom.js';
import { t, num } from '../i18n.js';
import { S, ui, api, run, render, flagOf, countryList } from '../app.js';

const BASES = ['bypass-local', 'global', 'direct'];
const PROTOCOLS = ['http', 'tls', 'quic', 'bittorrent'];

export function profileName(p) {
  if (!p) return '';
  if (p.builtin) return t({ 'p-local': 'mode_bypassLocal', 'p-global': 'mode_global', 'p-direct': 'mode_direct' }[p.id]);
  return p.name;
}

function baseLabel(base) {
  return t({ 'bypass-local': 'mode_bypassLocal', global: 'mode_global', direct: 'mode_direct' }[base]);
}

function editing() {
  const R = S.routing;
  return R.profiles.find((p) => p.id === ui.routingEdit) || R.profiles.find((p) => p.id === R.activeId) || R.profiles[0];
}

/** Replace one profile and save the whole routing (validated again in the main process). */
function saveProfile(profile) {
  const profiles = S.routing.profiles.map((p) => (p.id === profile.id ? profile : p));
  return run(() => api.setRouting({ profiles }));
}

function newId() {
  const b = new Uint8Array(4); crypto.getRandomValues(b);
  return `p-${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

async function addProfile(base = 'bypass-local', name = '', rules = []) {
  const p = { id: newId(), name: name || t('rt_newProfileName'), base, blockAds: true, rules };
  await run(() => api.setRouting({ profiles: [...S.routing.profiles, p] }));
  ui.routingEdit = p.id;
  render();
  return p;
}

// ------------------------------------------------------------------ rule editor

function ruleSummary(r) {
  const parts = [];
  if (r.domain.length) parts.push(`${t('rt_domain')}: ${r.domain.slice(0, 3).join(', ')}${r.domain.length > 3 ? ` +${num(r.domain.length - 3)}` : ''}`);
  if (r.ip.length) parts.push(`${t('rt_ip')}: ${r.ip.slice(0, 3).join(', ')}${r.ip.length > 3 ? ` +${num(r.ip.length - 3)}` : ''}`);
  if (r.port.length) parts.push(`${t('rt_port')}: ${r.port.join(',')}`);
  if (r.process.length) parts.push(`${t('rt_process')}: ${r.process.join(', ')}`);
  if (r.network) parts.push(`${t('rt_network')}: ${r.network.toUpperCase()}`);
  if (r.protocol.length) parts.push(`${t('rt_protocol')}: ${r.protocol.join(', ')}`);
  return parts.join('  ·  ');
}

function openRuleEditor(profile, rule) {
  const d0 = rule || { outbound: 'proxy', remark: '', enabled: true, domain: [], ip: [], port: [], process: [], network: '', protocol: [] };
  const draft = { ...d0, protocol: [...d0.protocol] };
  const d = drawer({ title: rule ? t('rule_edit') : t('rule_new'), width: 560 });
  const err = h('div', { class: 'ed-error', hidden: true }, icon('alert', 16), h('span', null, t('rule_invalid')));
  const area = (key, rows, placeholder) => {
    const ta = h('textarea', { class: 'input mono', rows, spellcheck: 'false', placeholder, onInput: (e) => { draft[key] = e.target.value.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean); } });
    ta.value = (draft[key] || []).join('\n');
    return ta;
  };
  const host = h('div');
  const paint = () => {
    host.replaceChildren(
      h('div', { class: 'ed-section' },
        field(t('rule_remark'), input(draft.remark, (v) => { draft.remark = v; }, { maxlength: 80 })),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('rule_outbound')),
          segmented(['proxy', 'direct', 'block'].map((v) => ({ value: v, label: t(`out_${v}`) })), draft.outbound, (v) => { draft.outbound = v; paint(); }, { label: t('rule_outbound') }))),
      h('div', { class: 'ed-section' },
        h('h3', null, t('rt_matchAll')),
        field(t('rt_domain'), area('domain', 5, 'example.com\nfull:a.example.com\nkeyword:bank\ngeosite:category-ads-all'), { help: t('rule_values_help_domain') }),
        field(t('rt_ip'), area('ip', 3, '10.0.0.0/8\n1.2.3.4\ngeoip:private'), { help: t('rule_values_help_ip') }),
        h('div', { class: 'grid2' },
          field(t('rt_port'), input((draft.port || []).join(','), (v) => { draft.port = v.split(',').map((x) => x.trim()).filter(Boolean); }, { class: 'input mono', dir: 'ltr', placeholder: '443,1000-2000' })),
          field(t('rt_process'), input((draft.process || []).join(','), (v) => { draft.process = v.split(',').map((x) => x.trim()).filter(Boolean); }, { class: 'input mono', dir: 'ltr', placeholder: 'telegram.exe' }))),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('rt_network')),
          segmented([{ value: '', label: t('rt_any') }, { value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' }], draft.network, (v) => { draft.network = v; paint(); }, { small: true })),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('rt_protocol')),
          h('div', { class: 'ed-protos' }, PROTOCOLS.map((p) => h('button', {
            type: 'button', class: 'ed-proto', 'aria-pressed': String(draft.protocol.includes(p)),
            onClick: () => { draft.protocol = draft.protocol.includes(p) ? draft.protocol.filter((x) => x !== p) : [...draft.protocol, p]; paint(); },
          }, p === 'bittorrent' ? 'BitTorrent' : p.toUpperCase()))))),
      err);
  };
  paint();
  d.body.append(host);
  d.foot.append(button(t('cancel'), { variant: 'ghost', onClick: d.close }), h('span', { class: 'grow' }),
    button(t('save'), {
      variant: 'primary', icon: 'check',
      onClick: async () => {
        const has = draft.domain.length || draft.ip.length || draft.port.length || draft.process.length || draft.network || draft.protocol.length;
        if (!has) { err.hidden = false; return; }
        const rules = profile.rules.slice();
        const idx = rule ? rules.findIndex((r) => r.id === rule.id) : -1;
        if (idx >= 0) rules[idx] = draft; else rules.push(draft);
        const before = profile.rules.length;
        await saveProfile({ ...profile, rules });
        const saved = S.routing.profiles.find((p) => p.id === profile.id);
        if (!saved || (idx < 0 && saved.rules.length === before)) { err.hidden = false; return; }
        d.close();
      },
    }));
}

function ruleRow(profile, r, i) {
  const rules = profile.rules;
  const move = (dir) => {
    const list = rules.slice();
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    saveProfile({ ...profile, rules: list });
  };
  return h('div', { class: 'rule' },
    toggle(r.enabled, (v) => saveProfile({ ...profile, rules: rules.map((x) => (x.id === r.id ? { ...x, enabled: v } : x)) }), { label: r.remark || t('rule_edit') }),
    h('div', { style: { minWidth: 0 } },
      h('div', { class: 'title' }, r.remark || `${t('rule_title')} ${num(i + 1)}`),
      h('div', { class: 'vals', title: ruleSummary(r) }, ruleSummary(r))),
    h('span', { class: `pill soft out-${r.outbound}` }, t(`out_${r.outbound}`)),
    h('div', { class: 'row', style: { gap: '2px', flexWrap: 'nowrap' } },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('m_moveUp'), disabled: i === 0, onClick: () => move(-1) }, icon('up', 16)),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('m_moveDown'), disabled: i === rules.length - 1, onClick: () => move(1) }, icon('down', 16)),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('edit'), onClick: () => openRuleEditor(profile, r) }, icon('edit', 16)),
      h('button', {
        type: 'button', class: 'icon-btn', 'aria-label': t('delete'),
        onClick: async () => {
          if (await confirmDialog({ title: t('delete'), message: r.remark || ruleSummary(r), confirmLabel: t('delete'), danger: true })) {
            saveProfile({ ...profile, rules: rules.filter((x) => x.id !== r.id) });
          }
        },
      }, icon('trash', 16))));
}

// ------------------------------------------------------------------ import / export

function importDialog(target) {
  const urlInput = h('input', { class: 'input mono', dir: 'ltr', placeholder: 'https://… (rules JSON)', spellcheck: 'false' });
  const err = h('div', { class: 'ed-error', hidden: true });
  const doImport = async (close, source, intoProfile) => {
    err.hidden = true;
    try {
      const { rules, name } = await api.importRules(source);
      if (intoProfile) {
        await saveProfile({ ...intoProfile, rules: [...intoProfile.rules, ...rules] });
      } else {
        await addProfile('bypass-local', name || t('rt_imported'), rules);
      }
      toast(t('rt_importedN', { n: num(rules.length) }), 'success');
      close();
    } catch (e) {
      const msg = String(e.message || e);
      err.replaceChildren(icon('alert', 16), h('span', null, /INVALID_RULES/.test(msg) ? t('rt_badRules') : msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')));
      err.hidden = false;
    }
  };
  modal({
    title: t('rt_import'),
    wide: true,
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted' }, t('rt_import_help')),
      field(t('rt_importUrl'), urlInput),
      err),
    actions: [
      { label: t('rt_fromClipboard'), onClick: (c) => doImport(c, '', target) },
      { label: target ? t('rt_addToProfile', { name: profileName(target) }) : t('rt_asNewProfile'), variant: 'primary', onClick: (c) => doImport(c, urlInput.value.trim(), target) },
    ],
  });
}

// ------------------------------------------------------------------ page

function profileCard(p) {
  const R = S.routing;
  const active = p.id === R.activeId;
  const sel = p.id === editing().id;
  return h('div', { class: `profile-card ${sel ? 'sel' : ''} ${active ? 'active' : ''}`, role: 'button', tabindex: '0',
    onClick: () => { ui.routingEdit = p.id; render(); },
    onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ui.routingEdit = p.id; render(); } } },
  h('div', { class: 'row', style: { flexWrap: 'nowrap' } },
    h('b', { class: 'grow' }, `${profileName(p)}${p.base === 'bypass-local' && R.country ? ` ${flagOf(R.country)}` : ''}`),
    p.source ? h('span', { class: 'pill soft' }, t('rt_fromPanel')) : null,
    active ? h('span', { class: 'pill accent' }, t('rt_active')) : h('button', { type: 'button', class: 'btn sm', onClick: (e) => { e.stopPropagation(); run(() => api.setRouting({ activeId: p.id })); } }, t('rt_use'))),
  h('span', { class: 'dim profile-sub' }, `${p.builtin ? '' : `${baseLabel(p.base)} · `}${t('rt_rulesN', { n: num(p.rules.length) })}${p.blockAds ? ` · ${t('rt_adsShort')}` : ''}`));
}

function profileEditor(p) {
  const R = S.routing;
  return h('section', { class: 'card card-pad stack' },
    h('div', { class: 'page-head' },
      h('div', { class: 'grow' },
        p.builtin
          ? h('h2', { class: 'card-title' }, profileName(p))
          : h('input', { class: 'input profile-name', value: p.name, maxlength: 60, 'aria-label': t('rt_profileName'), 'data-keep': `pname-${p.id}`,
            onChange: (e) => saveProfile({ ...p, name: e.target.value }) }),
        h('p', { class: 'muted', style: { margin: '4px 0 0', fontSize: '13px' } }, p.builtin ? t('rt_builtin_help') : t('customRules_help'))),
      h('div', { class: 'row' },
        p.id !== R.activeId ? button(t('rt_use'), { variant: 'primary', onClick: () => run(() => api.setRouting({ activeId: p.id })) }) : null,
        button('', {
          icon: 'more', title: t('tools'), ariaLabel: t('tools'),
          onClick: (e) => showMenu(e.currentTarget, [
            { label: t('rt_import'), icon: 'download', onClick: () => importDialog(p) },
            { label: t('rt_export'), icon: 'copy', onClick: async () => { const n = await run(() => api.exportRules(p.id)); toast(t('rt_exported', { n: num(n || 0) }), 'success'); } },
            { label: t('rt_duplicate'), icon: 'copy', onClick: () => addProfile(p.base, `${profileName(p)} (copy)`, p.rules.map((r) => ({ ...r, id: undefined }))) },
            ...(p.builtin ? [] : ['sep', {
              label: t('rt_deleteProfile'), icon: 'trash', danger: true,
              onClick: async () => {
                if (await confirmDialog({ title: t('rt_deleteProfile'), message: profileName(p), confirmLabel: t('delete'), danger: true })) {
                  ui.routingEdit = '';
                  run(() => api.setRouting({ profiles: R.profiles.filter((x) => x.id !== p.id) }));
                }
              },
            }]),
          ]),
        }))),
    p.builtin ? null : h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('rt_base')),
      segmented(BASES.map((b) => ({ value: b, label: baseLabel(b) })), p.base, (v) => saveProfile({ ...p, base: v }), { label: t('rt_base') })),
    h('div', { class: 'switch-row' },
      h('div', { class: 'txt' }, h('span', null, t('blockAds')), h('span', null, 'geosite:category-ads-all')),
      toggle(p.blockAds, (v) => saveProfile({ ...p, blockAds: v }), { label: t('blockAds') })),
    h('div', { class: 'row' },
      h('h3', { class: 'grow', style: { margin: 0, fontSize: '14px' } }, t('customRules')),
      button(t('rt_import'), { size: 'sm', icon: 'download', onClick: () => importDialog(p) }),
      button(t('addRule'), { size: 'sm', variant: 'primary', icon: 'plus', onClick: () => openRuleEditor(p, null) })),
    p.rules.length ? h('div', { class: 'rules' }, p.rules.map((r, i) => ruleRow(p, r, i))) : h('div', { class: 'dim' }, t('noRules')));
}

export function renderRouting() {
  const R = S.routing;
  const p = editing();
  return h('div', { class: 'page', 'data-scroll': 'page-routing' },
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, t('routing_title')), h('p', null, t('routing_help'))),
      h('div', { class: 'row' },
        button(t('rt_import'), { icon: 'download', onClick: () => importDialog(null) }),
        button(t('rt_newProfile'), { variant: 'primary', icon: 'plus', onClick: () => addProfile() }))),
    h('div', { class: 'profiles', role: 'list' }, R.profiles.map(profileCard)),
    profileEditor(p),
    h('section', { class: 'card card-pad stack' },
      h('h2', { class: 'card-title' }, t('rt_global')),
      h('div', { class: 'switch-row' },
        h('div', { class: 'txt' }, h('span', { id: 'country-cap' }, t('myCountry')), h('span', null, t('myCountry_help'))),
        h('div', { style: { width: '280px', flex: '0 0 auto' } }, select(
          [{ value: '', label: t('noCountry') }, ...countryList().map((c) => ({ value: c.code, label: `${flagOf(c.code)}  ${c.name}`, search: `${c.code} ${c.en}` }))],
          R.country, (v) => run(() => api.setRouting({ country: v })), { id: 'country-sel', 'aria-labelledby': 'country-cap' }))),
      h('div', { class: 'switch-row' },
        h('div', { class: 'txt' }, h('span', { id: 'ds-cap' }, t('domainStrategy')), h('span', null, 'Xray')),
        h('div', { style: { width: '280px', flex: '0 0 auto' } }, select(['AsIs', 'IPIfNonMatch', 'IPOnDemand'].map((v) => ({ value: v, label: t(`ds_${v}`) })), R.domainStrategy, (v) => run(() => api.setRouting({ domainStrategy: v })), { id: 'ds', 'aria-labelledby': 'ds-cap' }))),
      h('div', { class: 'switch-row' },
        h('div', { class: 'txt' }, h('span', { id: 'sbds-cap' }, t('sbDomainStrategy')), h('span', null, 'sing-box')),
        h('div', { style: { width: '280px', flex: '0 0 auto' } }, select(['', 'prefer_ipv4', 'prefer_ipv6', 'ipv4_only', 'ipv6_only'].map((v) => ({ value: v, label: v || t('rt_default') })), R.singboxStrategy, (v) => run(() => api.setRouting({ singboxStrategy: v })), { id: 'sbds', 'aria-labelledby': 'sbds-cap' })))));
}
