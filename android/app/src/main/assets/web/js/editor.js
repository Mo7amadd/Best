// Config editor: a full page with fields grouped like the Windows editor (basic, login, transport,
// security), a share-link box that fills every field from a pasted link, and JSON for custom
// configs. Every save goes through the shared core's normalizeServer, exactly as on Windows.

import { h, icon } from '../gen/dom.js';
import { t, isRtl, num } from './strings.js';

const Core = globalThis.BestCore;

const PROTOCOLS = [
  ['vless', 'VLESS'], ['vmess', 'VMess'], ['trojan', 'Trojan'], ['shadowsocks', 'Shadowsocks'],
  ['hysteria2', 'Hysteria2'], ['tuic', 'TUIC'], ['anytls', 'AnyTLS'], ['naive', 'Naive'], ['wireguard', 'WireGuard'], ['socks', 'SOCKS'], ['http', 'HTTP'], ['custom', 'JSON'], ['group', ''],
];
const STRATEGIES = ['leastPing', 'random', 'roundRobin', 'leastLoad'];
const NETWORKS = [['raw', 'TCP'], ['ws', 'WS'], ['grpc', 'gRPC'], ['httpupgrade', 'HTTPUpgrade'], ['xhttp', 'XHTTP'], ['kcp', 'mKCP'], ['h2', 'H2']];
const SS_METHODS = ['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', 'xchacha20-ietf-poly1305', '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305', 'none'];
const VMESS_CIPHERS = ['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none', 'zero'];
const FINGERPRINTS = ['', 'chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random', 'randomized'];
const STREAM = ['vmess', 'vless', 'trojan'];
const OWN_TLS = ['hysteria2', 'tuic', 'anytls', 'naive'];

function blank(protocol) {
  const base = { protocol, remark: '', address: '', port: 443 };
  if (protocol === 'vless') return { ...base, uuid: '', encryption: 'none', network: 'raw', tls: 'reality', fingerprint: 'chrome' };
  if (protocol === 'vmess') return { ...base, uuid: '', cipher: 'auto', network: 'ws', tls: 'tls' };
  if (protocol === 'trojan') return { ...base, password: '', network: 'raw', tls: 'tls' };
  if (protocol === 'shadowsocks') return { ...base, port: 8388, cipher: 'aes-256-gcm', password: '' };
  if (protocol === 'socks') return { ...base, port: 1080 };
  if (protocol === 'http') return { ...base, port: 8080 };
  if (protocol === 'hysteria2') return { ...base, password: '' };
  if (protocol === 'tuic') return { ...base, uuid: '', password: '', congestion: 'bbr', udpRelayMode: 'native', alpn: ['h3'] };
  if (protocol === 'anytls') return { ...base, password: '', fingerprint: 'chrome' };
  if (protocol === 'naive') return { ...base, username: '', password: '' };
  if (protocol === 'wireguard') return { ...base, port: 2408, privateKey: '', peerPublicKey: '', localAddress: ['10.0.0.2/32'], mtu: 1280 };
  if (protocol === 'group') return { protocol, remark: '', strategy: 'leastPing', members: [], memberSub: '' };
  if (protocol === 'custom') {
    return { protocol, remark: '', core: 'xray', config: JSON.stringify({ log: { loglevel: 'warning' }, outbounds: [{ tag: 'proxy', protocol: 'vless', settings: {} }, { tag: 'direct', protocol: 'freedom' }] }, null, 2) };
  }
  return base;
}

/** Core error text → a sentence in the UI language. */
function editError(message) {
  const m = String(message || '');
  if (/address/i.test(m)) return t('ed_e_address');
  if (/port/i.test(m)) return t('ed_e_port');
  if (/missing id/i.test(m)) return t('ed_e_uuid');
  if (/missing password/i.test(m)) return t('ed_e_password');
  if (/REALITY/i.test(m)) return t('ed_e_reality');
  if (/WireGuard/i.test(m)) return t('ed_e_wg');
  if (/JSON|config too large/i.test(m)) return t('ed_e_json');
  if (/cipher/i.test(m)) return t('ed_e_cipher');
  return t('ed_e_bad');
}

export function createEditor(ctx) {
  const { S, render, save, showToast, glass, switchEl } = ctx;

  /** Opens the editor for a config (id) or a new one. */
  function open(id) {
    const original = id ? S.servers.find((s) => s.id === id) : null;
    if (id && !original) return;
    const draft = original ? JSON.parse(JSON.stringify(original)) : blank('vless');
    S.edit = { id: original ? original.id : '', subId: original ? original.subId || '' : '', draft, err: '', link: '', q: '', back: S.page };
    S.sheet = null;
    S.page = 'editor';
    render();
  }

  function close() {
    const back = (S.edit && S.edit.back) || 'configs';
    S.edit = null;
    S.page = back === 'editor' ? 'configs' : back;
    render();
  }

  function saveDraft() {
    const e = S.edit;
    let server;
    try {
      server = Core.links.normalizeServer({ ...e.draft, id: e.id || undefined, subId: e.subId || '' });
    } catch (err) {
      e.err = editError(err && err.message);
      render();
      return;
    }
    if (e.id) {
      const i = S.servers.findIndex((s) => s.id === e.id);
      if (i >= 0) S.servers[i] = server; else S.servers.push(server);
      delete S.delays[e.id];
      delete S.speeds[e.id];
    } else {
      S.servers.push(server);
      if (!S.ui.selected) S.ui.selected = server.id;
    }
    save('servers');
    save('ui');
    const wasSelected = S.ui.selected === server.id;
    close();
    showToast(t('ed_saved'));
    if (wasSelected) ctx.reconnect();
  }

  function fillFromLink() {
    const e = S.edit;
    const text = String(e.link || '').trim();
    if (!text) return;
    try {
      const parsed = Core.links.parseLink(text);
      e.draft = { ...parsed, remark: parsed.remark || e.draft.remark || '' };
      e.err = '';
      e.link = '';
    } catch (err) {
      e.err = editError(err && err.message);
    }
    render();
  }

  function view() {
    const e = S.edit;
    if (!e) return null;
    const d = e.draft;
    const p = d.protocol;
    const set = (k, v) => { d[k] = v; e.err = ''; };

    const field = (label, control, hint) => h('div', { class: 'field' }, h('label', null, label), control, hint ? h('small', null, hint) : null);
    const text = (k, label, opts = {}) => field(label, h('input', {
      class: opts.plain ? '' : 'ltr mono', type: opts.number ? 'number' : 'text', inputmode: opts.number ? 'numeric' : undefined,
      autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', placeholder: opts.placeholder || '',
      value: Array.isArray(d[k]) ? d[k].join(', ') : d[k] ?? '', 'data-key': `f-${k}`,
      onInput: (ev) => {
        const v = ev.target.value;
        set(k, opts.number ? (v === '' ? '' : Number(v)) : opts.list ? v.split(',').map((x) => x.trim()).filter(Boolean) : v);
      },
    }), opts.hint);
    const select = (k, label, options) => field(label, h('select', {
      'data-key': `f-${k}`,
      onChange: (ev) => { set(k, ev.target.value); render(); },
    }, options.map((o) => {
      const [v, l] = Array.isArray(o) ? o : [o, o || t('f_none')];
      return h('option', { value: v, selected: String(d[k] ?? '') === v }, l);
    })));
    const chips = (k, options, after) => h('div', { class: 'pick' }, options.map(([v, l]) => h('button', {
      class: String(d[k] ?? '') === v ? 'on' : '', 'data-key': `${k}-${v}`,
      onClick: () => { set(k, v); if (after) after(v); render(); },
    }, l)));
    const toggle = (k, label, warn) => h('button', { class: 'item', onClick: () => { set(k, !d[k]); render(); } },
      h('div', { class: 'item-main' }, label, warn && d[k] ? h('small', { style: { color: 'var(--fair)' } }, warn) : null), switchEl(Boolean(d[k])));
    const section = (title, ...children) => [
      h('div', { class: 'section-label' }, title),
      glass('div', 'group ed-group', null, ...children),
    ];

    const body = [];
    if (!e.id) {
      body.push(...section(t('ed_protocol'), chips('protocol', PROTOCOLS.map(([v, l]) => [v, v === 'group' ? t('ed_group') : l]), (v) => {
        e.draft = { ...blank(v), remark: d.remark || '', address: d.address || '', ...(v === 'custom' ? {} : { port: d.port || blank(v).port }) };
      })));
    }
    if (e.subId) body.push(h('div', { class: 'note warn', style: { marginTop: '10px' } }, icon('alert', 18, 1.9), h('span', null, t('ed_subNote'))));

    if (p === 'group') {
      body.push(...groupBody(e, d, { text, chips, section }));
    } else if (p === 'custom') {
      body.push(...section(t('ed_basic'), text('remark', t('f_remark'), { plain: true })));
      body.push(h('div', { class: 'note', style: { marginTop: '10px' } }, icon('info', 18, 1.9), h('span', null, t('ed_customHint'))));
      body.push(h('div', { class: 'field', style: { marginTop: '10px' } },
        h('label', null, t('f_config')),
        h('textarea', { class: 'ltr json', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'data-key': 'f-config', value: d.config || '', onInput: (ev) => set('config', ev.target.value) })));
    } else {
      body.push(...section(t('ed_basic'),
        text('remark', t('f_remark'), { plain: true }),
        h('div', { class: 'two' }, text('address', t('f_address'), { placeholder: 'example.com' }), text('port', t('f_port'), { number: true }))));

      const auth = [];
      if (['vmess', 'vless', 'tuic'].includes(p)) auth.push(text('uuid', t('f_uuid'), { placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' }));
      if (p === 'vmess') auth.push(h('div', { class: 'two' }, select('cipher', t('f_cipher'), VMESS_CIPHERS), text('alterId', t('f_alterId'), { number: true })));
      if (p === 'vless') auth.push(select('flow', t('f_flow'), ['', 'xtls-rprx-vision', 'xtls-rprx-vision-udp443']), text('encryption', t('f_encryption')));
      if (p === 'trojan') auth.push(select('flow', t('f_flow'), ['', 'xtls-rprx-vision']));
      if (p === 'shadowsocks') auth.push(select('cipher', t('f_cipher'), SS_METHODS));
      if (['socks', 'http', 'naive'].includes(p)) auth.push(text('username', t('f_username')));
      if (['trojan', 'shadowsocks', 'socks', 'http', 'hysteria2', 'tuic', 'anytls', 'naive'].includes(p)) auth.push(text('password', t('f_password')));
      if (p === 'hysteria2') {
        auth.push(select('obfs', t('f_obfs'), [['', t('f_none')], ['salamander', 'salamander']]));
        if (d.obfs) auth.push(text('obfsPassword', t('f_obfsPassword')));
        auth.push(text('hopPorts', t('f_hopPorts'), { placeholder: '20000-30000' }));
        auth.push(h('div', { class: 'two' }, text('upMbps', t('f_upMbps'), { number: true }), text('downMbps', t('f_downMbps'), { number: true })));
      }
      if (p === 'tuic') auth.push(select('congestion', t('f_congestion'), ['bbr', 'cubic', 'new_reno']));
      if (p === 'wireguard') {
        auth.push(
          text('privateKey', t('f_privateKey')),
          text('peerPublicKey', t('f_peerPublicKey')),
          text('presharedKey', t('f_presharedKey')),
          text('localAddress', t('f_localAddress'), { list: true, placeholder: '172.16.0.2/32, fd01::2/128' }),
          h('div', { class: 'two' }, text('reserved', t('f_reserved'), { list: true, placeholder: '0,0,0' }), text('mtu', t('f_mtu'), { number: true })));
      }
      if (auth.length) body.push(...section(t('ed_auth'), ...auth));

      if (STREAM.includes(p)) {
        const net = d.network || 'raw';
        const rows = [chips('network', NETWORKS)];
        if (net === 'raw') {
          rows.push(select('headerType', t('f_headerType'), [['', t('f_none')], ['http', 'http']]));
          if (d.headerType === 'http') rows.push(text('host', t('f_host')), text('path', t('f_path'), { placeholder: '/' }));
        }
        if (['ws', 'httpupgrade', 'h2', 'xhttp'].includes(net)) rows.push(text('host', t('f_host')), text('path', t('f_path'), { placeholder: '/' }));
        if (net === 'grpc') rows.push(text('serviceName', t('f_serviceName')), select('mode', t('f_mode'), [['', 'gun'], ['multi', 'multi']]));
        if (net === 'xhttp') rows.push(select('mode', t('f_mode'), [['', t('f_auto')], ['packet-up', 'packet-up'], ['stream-up', 'stream-up'], ['stream-one', 'stream-one']]));
        if (net === 'kcp') rows.push(text('seed', 'Seed'));
        body.push(...section(t('ed_transport'), ...rows));
      }

      const own = OWN_TLS.includes(p);
      if (STREAM.includes(p) || p === 'http' || own) {
        const tls = own ? 'tls' : d.tls || '';
        const rows = [];
        if (!own) rows.push(chips('tls', p === 'http' ? [['', t('f_none')], ['tls', 'TLS']] : [['', t('f_none')], ['tls', 'TLS'], ['reality', 'REALITY']]));
        if (!tls && ['vless', 'trojan', 'vmess'].includes(p)) rows.push(h('div', { class: 'note warn' }, icon('alert', 18, 1.9), h('span', null, t('ed_unencrypted'))));
        if (tls) {
          rows.push(text('sni', t('f_sni'), { placeholder: d.address || '' }));
          if (tls === 'tls' && p !== 'naive') rows.push(text('alpn', t('f_alpn'), { list: true, placeholder: 'h2, http/1.1' }));
          if (!own || p === 'anytls') rows.push(select('fingerprint', t('f_fingerprint'), FINGERPRINTS));
          if (tls === 'reality') rows.push(text('publicKey', t('f_publicKey')), h('div', { class: 'two' }, text('shortId', t('f_shortId')), text('spiderX', t('f_spiderX'), { placeholder: '/' })));
          if (tls === 'tls' && p !== 'naive') rows.push(toggle('allowInsecure', t('f_allowInsecure'), t('f_allowInsecureWarn')));
        }
        body.push(...section(t('ed_security'), ...rows));
      }
    }

    // Chain: reach this config through another one.
    if (p !== 'group' && p !== 'custom') {
      const fronts = S.servers.filter((x) => x.protocol !== 'group' && x.protocol !== 'custom' && x.id !== e.id);
      body.push(...section(t('ed_via'),
        h('div', { class: 'field' },
          h('select', { 'data-key': 'f-via', onChange: (ev) => { set('via', ev.target.value); } },
            h('option', { value: '', selected: !d.via }, t('viaNone')),
            fronts.slice(0, 300).map((x) => h('option', { value: x.id, selected: d.via === x.id }, ctx.nameOf(x)))),
          h('small', null, t('ed_viaHint')))));
    }

    let link = '';
    if (p !== 'custom' && p !== 'group') {
      try { link = Core.links.toLink(Core.links.normalizeServer({ ...d, id: e.id || undefined })); } catch { link = ''; }
    }
    if (p !== 'group') {
      body.push(...section(t('ed_link'),
        h('div', { class: 'field' },
          h('textarea', { class: 'ltr', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'data-key': 'f-link', placeholder: link || 'vless://…', value: e.link || '', onInput: (ev) => { e.link = ev.target.value; } }),
          h('small', null, t('ed_linkHint'))),
        h('button', { class: 'item', onClick: fillFromLink }, icon('link', 19, 1.8), h('div', { class: 'item-main', style: { color: 'var(--accent)' } }, t('ed_readLink')))));
    }

    return h('div', { class: 'page editor', 'data-key': 'editor' },
      h('div', { class: 'title-row' },
        glass('button', 'round-btn sm back', { 'aria-label': t('close'), onClick: close },
          h('span', { style: { display: 'inline-flex', transform: `rotate(${isRtl() ? -90 : 90}deg)` } }, icon('chevron', 20, 2))),
        h('h1', null, e.id ? t('ed_edit') : t('ed_new')),
        h('button', { class: 'btn primary sm', onClick: saveDraft }, t('save'))),
      e.err ? h('div', { class: 'note bad', role: 'alert' }, icon('alert', 18, 1.9), h('span', null, e.err)) : null,
      body);
  }

  /** Group: its name, how a member is picked, and the members (or every config of a subscription). */
  function groupBody(e, d, { text, chips, section }) {
    const members = new Set(d.members || []);
    const q = String(e.q || '').trim().toLowerCase();
    const pool = S.servers.filter((x) => x.protocol !== 'group' && x.protocol !== 'custom' && x.id !== e.id);
    const shown = pool
      .filter((x) => !q || `${ctx.nameOf(x)} ${x.address || ''}`.toLowerCase().includes(q))
      .sort((a, b) => Number(members.has(b.id)) - Number(members.has(a.id)))
      .slice(0, 300);
    const toggleMember = (id) => {
      if (members.has(id)) members.delete(id); else members.add(id);
      d.members = [...members];
      e.err = '';
      render();
    };
    return [
      ...section(t('ed_basic'),
        text('remark', t('f_remark'), { plain: true }),
        h('div', { class: 'field' }, h('label', null, t('f_strategy')), chips('strategy', STRATEGIES.map((v) => [v, t(`strat_${v}`)])))),
      ...section(t('f_members'),
        h('div', { class: 'field' }, h('label', null, t('f_memberSub')),
          h('select', { 'data-key': 'f-memberSub', onChange: (ev) => { d.memberSub = ev.target.value; render(); } },
            h('option', { value: '', selected: !d.memberSub }, t('f_none')),
            S.subs.map((sub) => h('option', { value: sub.id, selected: d.memberSub === sub.id }, sub.name || t('subLink'))))),
        h('div', { class: 'field' }, h('label', null, t('f_fallback')),
          h('select', { 'data-key': 'f-fallback', onChange: (ev) => { d.fallback = ev.target.value; } },
            h('option', { value: '', selected: !d.fallback }, t('fallbackNone')),
            pool.slice(0, 300).map((x) => h('option', { value: x.id, selected: d.fallback === x.id }, ctx.nameOf(x))))),
        h('div', { class: 'field' },
          h('label', null, `${t('chooseMembers')} · ${t('membersN', { n: num(members.size) })}`),
          h('input', { type: 'search', placeholder: t('search'), autocomplete: 'off', value: e.q || '', 'data-key': 'f-q', onInput: (ev) => { e.q = ev.target.value; render(); } })),
        h('div', { class: 'group', style: { background: 'transparent', margin: '0 -12px -12px' } },
          shown.map((x) => h('button', { class: 'item', 'data-key': `m-${x.id}`, onClick: () => toggleMember(x.id) },
            h('div', { class: 'item-main' }, h('span', null, ctx.nameOf(x)), h('small', null, x.address || '')),
            h('span', { class: `check ${members.has(x.id) ? 'on' : ''}` }, members.has(x.id) ? icon('check', 14, 3) : null))))),
    ];
  }

  return { open, close, view };
}
