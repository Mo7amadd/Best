// Server editor: a side drawer with a protocol picker, "paste a link to fill", numbered section
// cards, a Form/JSON switch and a live share-link preview. Every save is validated in the main
// process (normalizeServer) – the UI never builds configs itself.

import { h, icon, button, segmented, toggle, select, drawer, field, toast, modal, debounce } from '../dom.js';
import { t } from '../i18n.js';
import { S, api, run, serverName } from '../app.js';

const PROTOCOLS = [
  ['vless', 'VLESS'], ['vmess', 'VMess'], ['trojan', 'Trojan'], ['shadowsocks', 'Shadowsocks'],
  ['hysteria2', 'Hysteria2'], ['tuic', 'TUIC'], ['wireguard', 'WireGuard'], ['anytls', 'AnyTLS'],
  ['naive', 'Naive'], ['masque', 'MASQUE'], ['hysteria', 'Hysteria'], ['socks', 'SOCKS'], ['http', 'HTTP'], ['custom', 'JSON'], ['group', 'Group'],
];
const GROUP_STRATEGIES = ['leastPing', 'random', 'roundRobin', 'leastLoad'];
const NETWORKS = [['raw', 'TCP'], ['ws', 'WS'], ['grpc', 'gRPC'], ['httpupgrade', 'HTTPUpgrade'], ['xhttp', 'XHTTP'], ['kcp', 'mKCP'], ['h2', 'H2'], ['quic', 'QUIC']];
const SS_METHODS = ['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', 'xchacha20-ietf-poly1305', '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305', 'none'];
const VMESS_CIPHERS = ['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none', 'zero'];
const FINGERPRINTS = ['', 'chrome', 'firefox', 'safari', 'ios', 'android', 'edge', '360', 'qq', 'random', 'randomized'];
const STREAM = ['vmess', 'vless', 'trojan'];
const OWN_TLS = ['hysteria2', 'hysteria', 'tuic', 'anytls', 'naive', 'masque'];
const MASQUE_PATH = '/.well-known/masque/ip/{target}/{ipproto}/';
const HIDDEN_KEYS = ['id', 'delay', 'speed', 'udp', 'usageUp', 'usageDown', 'subId'];

function blank(protocol) {
  const base = { protocol, remark: '', address: '', port: 443 };
  if (protocol === 'vless') return { ...base, uuid: '', encryption: 'none', network: 'raw', tls: 'reality', fingerprint: 'chrome' };
  if (protocol === 'vmess') return { ...base, uuid: '', cipher: 'auto', network: 'ws', tls: 'tls' };
  if (protocol === 'trojan') return { ...base, password: '', network: 'raw', tls: 'tls' };
  if (protocol === 'shadowsocks') return { ...base, port: 8388, cipher: 'aes-256-gcm', password: '' };
  if (protocol === 'socks') return { ...base, port: 1080 };
  if (protocol === 'http') return { ...base, port: 8080 };
  if (protocol === 'hysteria2') return { ...base, password: '' };
  if (protocol === 'hysteria') return { ...base, password: '', upMbps: 50, downMbps: 100 };
  if (protocol === 'tuic') return { ...base, uuid: '', password: '', congestion: 'bbr', udpRelayMode: 'native', alpn: ['h3'] };
  if (protocol === 'wireguard') return { ...base, port: 2408, privateKey: '', peerPublicKey: '', localAddress: ['10.0.0.2/32'], mtu: 1280 };
  if (protocol === 'anytls') return { ...base, password: '', fingerprint: 'chrome' };
  if (protocol === 'naive') return { ...base, username: '', password: '' };
  if (protocol === 'masque') return { ...base, username: '', password: '', alpn: ['h3'] };
  if (protocol === 'group') return { protocol, remark: '', strategy: 'leastPing', members: [], memberSub: '' };
  if (protocol === 'custom') {
    return { protocol, remark: '', core: 'xray', config: JSON.stringify({ log: { loglevel: 'warning' }, inbounds: [{ tag: 'socks-in', protocol: 'socks', listen: '127.0.0.1', port: S.settings.socksPort, settings: { udp: true } }], outbounds: [] }, null, 2) };
  }
  return base;
}

export async function openEditor(id, preset) {
  let original = null;
  if (id) {
    original = await run(() => api.getServer(id));
    if (!original) return;
  }
  let draft = original ? { ...original } : blank((preset && preset.protocol) || 'vless');
  let mode = 'form';
  let jsonText = '';
  const d = drawer({ title: original ? t('ed_edit') : t('ed_new'), width: 600 });
  const err = h('div', { class: 'ed-error', hidden: true });
  const preview = h('div', { class: 'ed-preview' });

  const set = (k, v) => { draft[k] = v; refreshPreview(); };
  const text = (k, attrs = {}) => {
    const el = h('input', {
      class: `input ${attrs.mono === false ? '' : 'mono'}`, value: Array.isArray(draft[k]) ? draft[k].join(',') : (draft[k] ?? ''),
      dir: attrs.mono === false ? undefined : 'ltr', spellcheck: 'false', autocomplete: 'off', type: attrs.type || 'text', placeholder: attrs.placeholder,
      onInput: (e) => set(k, attrs.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : attrs.list ? e.target.value.split(',').map((x) => x.trim()).filter(Boolean) : e.target.value),
    });
    return el;
  };
  const pick = (k, options, rerender = false) => select(options.map((o) => (Array.isArray(o) ? { value: o[0], label: o[1] } : { value: o, label: o || t('none') })), draft[k] ?? '', (v) => { set(k, v); if (rerender) renderBody(); });
  const sw = (k, label, warn) => h('div', { class: 'switch-row' },
    h('div', { class: 'txt' }, h('span', null, label), warn && draft[k] ? h('span', { style: { color: 'var(--fair)' } }, warn) : null),
    toggle(Boolean(draft[k]), (v) => { set(k, v); renderBody(); }, { label }));

  const section = (n, title, ...children) => h('section', { class: 'ed-section' }, h('h3', null, h('span', { class: 'num' }, String(n)), title), ...children);

  function authSection() {
    const p = draft.protocol;
    const rows = [];
    if (['vmess', 'vless', 'tuic'].includes(p)) rows.push(field(t('f_uuid'), text('uuid', { placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' }), { full: true }));
    if (p === 'vmess') rows.push(field(t('f_cipher'), pick('cipher', VMESS_CIPHERS)), field(t('f_alterId'), text('alterId', { type: 'number' })));
    if (p === 'vless') rows.push(field(t('f_flow'), pick('flow', ['', 'xtls-rprx-vision', 'xtls-rprx-vision-udp443'])), field(t('f_encryption'), text('encryption')));
    if (p === 'shadowsocks') rows.push(field(t('f_cipher'), pick('cipher', SS_METHODS)));
    if (['socks', 'http', 'naive'].includes(p)) rows.push(field(t('f_username'), text('username')));
    if (['trojan', 'shadowsocks', 'socks', 'http', 'hysteria2', 'hysteria', 'tuic', 'anytls', 'naive'].includes(p)) rows.push(field(t('f_password'), text('password'), { full: !['socks', 'http', 'naive', 'tuic'].includes(p) }));
    if (p === 'shadowsocks') {
      rows.push(field(t('f_plugin'), pick('plugin', ['', 'obfs-local', 'v2ray-plugin'], true)));
      if (draft.plugin) rows.push(field(t('f_pluginOpts'), text('pluginOpts', { placeholder: draft.plugin === 'obfs-local' ? 'obfs=http;obfs-host=www.bing.com' : 'mode=websocket;tls;host=example.com;path=/' })));
    }
    if (p === 'hysteria2') rows.push(field(t('f_obfs'), pick('obfs', ['', 'salamander', 'gecko'], true)));
    if (p === 'hysteria2' && draft.obfs === 'gecko') rows.push(field(t('f_packetSize'), text('packetSize', { placeholder: '100-1200' })));
    if (p === 'hysteria2') rows.push(field(t('f_hopPorts'), text('hopPorts', { placeholder: '20000-30000' })));
    if ((p === 'hysteria2' && draft.obfs) || p === 'hysteria') rows.push(field(t('f_obfsPassword'), text('obfsPassword')));
    if (p === 'hysteria2' || p === 'hysteria') rows.push(field(t('f_upMbps'), text('upMbps', { type: 'number' })), field(t('f_downMbps'), text('downMbps', { type: 'number' })));
    if (p === 'tuic') rows.push(field(t('f_congestion'), pick('congestion', ['bbr', 'cubic', 'new_reno'])), field(t('f_udpRelayMode'), pick('udpRelayMode', ['native', 'quic'])));
    if (p === 'wireguard') {
      rows.push(
        field(t('f_privateKey'), text('privateKey'), { full: true }),
        field(t('f_peerPublicKey'), text('peerPublicKey'), { full: true }),
        field(t('f_presharedKey'), text('presharedKey'), { full: true }),
        field(t('f_localAddress'), text('localAddress', { list: true, placeholder: '172.16.0.2/32, fd01::2/128' }), { full: true }),
        field(t('f_reserved'), text('reserved', { list: true, placeholder: '0,0,0' })),
        field(t('f_mtu'), text('mtu', { type: 'number' })));
    }
    if (p === 'naive') rows.push(h('div', { class: 'field full' }, sw('__quic', t('f_quic'))));
    if (p === 'masque') return masqueAuth();
    return rows.length ? section(2, t('ed_auth'), h('div', { class: 'grid2' }, rows)) : null;
  }

  /** MASQUE: a user name / password (3x-ui: the client's email and password) or a WARP registration. */
  function masqueAuth() {
    const warp = Boolean(draft.__warp);
    const rows = warp
      ? [
        field(t('f_warpPrivateKey'), keyArea('warpPrivateKey', '-----BEGIN PRIVATE KEY-----'), { full: true }),
        field(t('f_warpPublicKey'), keyArea('warpPublicKey', '-----BEGIN PUBLIC KEY-----'), { full: true }),
        field(t('f_warpAddress'), text('warpAddress', { list: true, placeholder: '172.16.0.2, 2606:4700:110:8a36::2' }), { full: true }),
      ]
      : [field(t('f_username'), text('username')), field(t('f_password'), text('password'))];
    rows.push(
      field(t('f_path'), text('path', { placeholder: MASQUE_PATH }), { full: true }),
      field(t('f_host'), text('host', { placeholder: draft.address || '' })),
      field(t('f_remoteDns'), text('remoteDns', { list: true, placeholder: '1.1.1.1, 2606:4700:4700::1111' }), { help: t('f_remoteDns_help') }));
    return section(2, t('ed_auth'),
      h('div', { class: 'note' }, icon('info', 16), h('span', null, t('masque_help'))),
      h('div', { class: 'switch-row' },
        h('div', { class: 'txt' }, h('span', null, t('f_warp')), h('span', { class: 'dim' }, t('f_warp_help'))),
        toggle(warp, (v) => { draft.__warp = v; refreshPreview(); renderBody(); }, { label: t('f_warp') })),
      h('div', { class: 'grid2' }, rows));
  }

  /** A multi-line key (PEM), kept as typed; the main process turns it into one line of base64. */
  function keyArea(k, placeholder) {
    const ta = h('textarea', { class: 'input mono', rows: 3, dir: 'ltr', spellcheck: 'false', placeholder, onInput: (e) => set(k, e.target.value) });
    ta.value = draft[k] || '';
    return ta;
  }

  function transportSection() {
    if (!STREAM.includes(draft.protocol)) return null;
    const net = draft.network || 'raw';
    const rows = [];
    if (net === 'raw') {
      rows.push(field(t('f_headerType'), pick('headerType', ['', 'http'], true)));
      if (draft.headerType === 'http') rows.push(field(t('f_host'), text('host')), field(t('f_path'), text('path', { placeholder: '/' })));
    }
    if (['ws', 'httpupgrade', 'h2', 'xhttp'].includes(net)) rows.push(field(t('f_host'), text('host')), field(t('f_path'), text('path', { placeholder: '/' })));
    if (net === 'grpc') rows.push(field(t('f_serviceName'), text('serviceName')), field(t('f_mode'), pick('mode', [['', 'gun'], ['multi', 'multi']])), field(t('f_authority'), text('authority')));
    if (net === 'xhttp') {
      rows.push(field(t('f_mode'), pick('mode', [['', 'auto'], ['packet-up', 'packet-up'], ['stream-up', 'stream-up'], ['stream-one', 'stream-one']])));
      const ta = h('textarea', { class: 'input mono', rows: 4, spellcheck: 'false', placeholder: '{ "xPaddingBytes": "100-1000" }', onInput: (e) => set('extra', e.target.value) });
      ta.value = draft.extra || '';
      rows.push(field(t('f_extra'), ta, { full: true }));
    }
    if (net === 'kcp') rows.push(field(t('f_seed'), text('seed')), field('MTU', text('mtu', { type: 'number', placeholder: '1350' })), field('TTI', text('tti', { type: 'number', placeholder: '20' })));
    return section(3, t('ed_transport'),
      segmented(NETWORKS.map(([v, l]) => ({ value: v, label: l })), net, (v) => { set('network', v); renderBody(); }, { label: t('f_network'), small: true }),
      rows.length ? h('div', { class: 'grid2' }, rows) : null);
  }

  function securitySection() {
    const p = draft.protocol;
    const own = OWN_TLS.includes(p);
    if (!STREAM.includes(p) && p !== 'http' && !own) return null;
    const options = own ? null : p === 'http' ? [['', t('none')], ['tls', 'TLS']] : [['', t('none')], ['tls', 'TLS'], ['reality', 'REALITY']];
    const tls = own ? 'tls' : draft.tls || '';
    const rows = [];
    if (tls) {
      rows.push(field(t('f_sni'), text('sni', { placeholder: draft.address || '' })));
      if (tls === 'tls' && p !== 'naive') rows.push(field(t('f_alpn'), text('alpn', { list: true, placeholder: p === 'masque' ? 'h3' : 'h2,http/1.1' })));
      if (!['hysteria2', 'hysteria', 'tuic', 'naive'].includes(p)) rows.push(field(t('f_fingerprint'), pick('fingerprint', FINGERPRINTS)));
      if (tls === 'reality') {
        rows.push(field(t('f_publicKey'), text('publicKey'), { full: true }), field(t('f_shortId'), text('shortId')), field(t('f_spiderX'), text('spiderX', { placeholder: '/' })));
        rows.push(field(t('f_pqv'), text('pqv'), { full: true, help: t('f_pqv_help') }));
      }
      if (tls === 'tls' && p !== 'naive') {
        rows.push(field(t('f_pcs'), text('pcs', { placeholder: 'sha256 hex' }), { full: true, help: t('f_pcs_help') }));
        rows.push(field('ECH', text('ech'), { full: true, help: t('f_ech_help') }));
        rows.push(field(t('f_vcn'), text('vcn')), field(t('f_cs'), text('cipherSuites')));
      }
    }
    return section(STREAM.includes(p) ? 4 : 3, t('ed_security'),
      options ? segmented(options.map(([v, l]) => ({ value: v, label: l })), tls, (v) => { set('tls', v); renderBody(); }, { label: t('f_tls') }) : null,
      !tls && ['vless', 'trojan'].includes(p) ? h('div', { class: 'note warn' }, icon('alert', 16), h('span', null, t('unencrypted_warn'))) : null,
      rows.length ? h('div', { class: 'grid2' }, rows) : null,
      tls === 'tls' && p !== 'naive' ? sw('allowInsecure', t('f_allowInsecure'), t('f_allowInsecure_warn')) : null,
      [...STREAM, 'hysteria2'].includes(p) ? finalmaskField() : null);
  }

  function finalmaskField() {
    const ta = h('textarea', { class: 'input mono', rows: 3, spellcheck: 'false', placeholder: '{"tcp":[{"type":"fragment","settings":{"packets":"tlshello","length":"100-200"}}]}', onInput: (e) => set('finalmask', e.target.value) });
    ta.value = draft.finalmask || '';
    return field('finalmask (fm)', ta, { full: true, help: t('f_fm_help') });
  }

  function customBody() {
    const ta = h('textarea', { class: 'input json-area', spellcheck: 'false', onInput: (e) => set('config', e.target.value) });
    ta.value = draft.config || '';
    return [
      section(1, t('ed_basic'), h('div', { class: 'grid2' },
        field(t('f_remark'), text('remark', { mono: false })),
        field(t('f_core'), pick('core', [['xray', 'Xray'], ['sing-box', 'sing-box']])))),
      h('div', { class: 'note' }, icon('info', 16), h('span', null, t('ed_custom_help'))),
      h('div', { class: 'note warn' }, icon('alert', 16), h('span', null, t('ed_custom_warn'))),
      h('section', { class: 'ed-section' },
        h('div', { class: 'row' }, h('h3', { class: 'grow' }, t('f_config')),
          button(t('copy'), { size: 'sm', icon: 'copy', onClick: async () => { await api.copy(draft.config || ''); toast(t('copied'), 'success'); } }),
          button(t('ed_openFile'), { size: 'sm', icon: 'file', onClick: async () => { const txt = await run(() => api.readConfigFile()); if (txt) { draft.config = txt; renderBody(); } } }),
          button(t('ed_format'), { size: 'sm', icon: 'code', onClick: () => { try { draft.config = JSON.stringify(JSON.parse(draft.config), null, 2); renderBody(); } catch (e) { showErr(e.message); } } })),
        ta),
    ];
  }

  /** Servers that can take part in a group or act as the front of a chain. */
  const plainServers = () => S.servers.filter((s) => s.protocol !== 'group' && s.protocol !== 'custom' && s.id !== draft.id);

  /** "Connect through": reach this server via another one (proxy chain). */
  function viaField() {
    const opts = [{ value: '', label: t('via_none') }, ...plainServers().map((s) => ({ value: s.id, label: serverName(s), search: `${s.address} ${s.protocol}` }))];
    return field(t('via'), select(opts, draft.via || '', (v) => set('via', v), { search: true }), { full: true, help: t('via_help') });
  }

  function groupBody() {
    const members = new Set(draft.members || []);
    const q = { text: '' };
    const listBox = h('div', { class: 'grp-list', role: 'group', 'aria-label': t('grp_members') });
    const count = h('span', { class: 'dim' });
    const paint = () => {
      const qq = q.text.trim().toLowerCase();
      const rows = plainServers().filter((s) => !qq || `${serverName(s)} ${s.address}`.toLowerCase().includes(qq));
      listBox.replaceChildren(...rows.map((s) => {
        const box = h('input', { type: 'checkbox', checked: members.has(s.id), onChange: (e) => { if (e.target.checked) members.add(s.id); else members.delete(s.id); draft.members = [...members]; count.textContent = t('grp_selected', { n: members.size }); } });
        const sub = s.subId ? (S.subs.find((x) => x.id === s.subId) || {}).name : '';
        return h('label', { class: 'grp-row' }, box, h('span', { class: 'grow' }, serverName(s)), h('span', { class: 'dim' }, sub || s.protocol.toUpperCase()));
      }));
      count.textContent = t('grp_selected', { n: members.size });
    };
    paint();
    const search = h('input', { class: 'input', type: 'search', placeholder: t('search'), onInput: (e) => { q.text = e.target.value; paint(); } });
    return [
      section(1, t('ed_basic'), h('div', { class: 'grid2' },
        field(t('f_remark'), text('remark', { mono: false }), { full: true }),
        field(t('grp_strategy'), select(GROUP_STRATEGIES.map((x) => ({ value: x, label: t(`grp_s_${x}`) })), draft.strategy || 'leastPing', (v) => { set('strategy', v); renderBody(); }), { full: true, help: t(`grp_s_${draft.strategy || 'leastPing'}_help`) }))),
      section(2, t('grp_members'),
        field(t('grp_memberSub'), select([{ value: '', label: t('via_none') }, ...S.subs.map((x) => ({ value: x.id, label: x.name }))], draft.memberSub || '', (v) => set('memberSub', v)), { help: t('grp_memberSub_help') }),
        h('div', { class: 'row' }, h('div', { class: 'grow' }, search), count),
        listBox),
      h('div', { class: 'note' }, icon('info', 16), h('span', null, t('grp_help'))),
    ];
  }

  function protocolPicker() {
    return h('div', { class: 'ed-protos', role: 'group', 'aria-label': t('col_protocol') },
      PROTOCOLS.map(([v, l]) => h('button', {
        type: 'button', class: 'ed-proto', 'aria-pressed': String(draft.protocol === v),
        onClick: () => {
          if (draft.protocol === v) return;
          const keep = { remark: draft.remark, address: draft.address, port: draft.port };
          draft = { ...blank(v), ...(v === 'custom' ? { remark: draft.remark } : keep), id: draft.id };
          mode = 'form';
          renderBody();
        },
      }, l)));
  }

  function pasteBox() {
    const inp = h('input', { class: 'input mono', dir: 'ltr', placeholder: t('ed_pasteLink'), spellcheck: 'false' });
    const fill = async () => {
      const link = inp.value.trim();
      if (!link) return;
      try {
        const s = await api.parseLink(link);
        draft = { ...s, id: draft.id };
        mode = 'form';
        renderBody();
      } catch (e) { showErr(cleanErr(e)); }
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') fill(); });
    inp.addEventListener('paste', () => setTimeout(fill, 0));
    return h('div', { class: 'ed-paste' }, h('div', { class: 'grow' }, inp), button(t('ed_fill'), { icon: 'link', onClick: fill }));
  }

  function jsonBody() {
    const copy = { ...draft };
    for (const k of HIDDEN_KEYS) delete copy[k];
    delete copy.__quic;
    delete copy.__warp;
    jsonText =JSON.stringify(copy, null, 2);
    const ta = h('textarea', { class: 'input json-area', spellcheck: 'false', onInput: (e) => { jsonText = e.target.value; tryJson(false); } });
    ta.value = jsonText;
    return [
      h('div', { class: 'row' },
        h('span', { class: 'section-label grow' }, 'JSON'),
        button(t('copy'), { size: 'sm', icon: 'copy', onClick: async () => { await api.copy(ta.value); toast(t('copied'), 'success'); } }),
        button(t('ed_format'), { size: 'sm', icon: 'code', onClick: () => { try { ta.value = JSON.stringify(JSON.parse(ta.value), null, 2); jsonText = ta.value; } catch (e) { showErr(e.message); } } })),
      ta,
    ];
  }

  function tryJson(rerender) {
    try {
      const obj = JSON.parse(jsonText);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('JSON');
      draft = { ...obj, id: draft.id };
      err.hidden = true;
      refreshPreview();
      if (rerender) renderBody();
      return true;
    } catch (e) { showErr(e.message); return false; }
  }

  function renderBody() {
    // Worked out once per server (not on every redraw, which would undo the QUIC switch).
    if (draft.protocol === 'naive' && draft.__quic === undefined) draft.__quic = draft.network === 'quic';
    if (draft.protocol === 'masque' && draft.__warp === undefined) draft.__warp = Boolean(draft.warpPrivateKey);
    const custom = draft.protocol === 'custom';
    const group = draft.protocol === 'group';
    const parts = [protocolPicker()];
    if (group) {
      parts.push(...groupBody(), err);
      preview.replaceChildren();
      d.body.replaceChildren(...parts.filter(Boolean));
      return;
    }
    if (!custom) {
      parts.push(pasteBox());
      parts.push(segmented([{ value: 'form', label: t('ed_form') }, { value: 'json', label: t('ed_json') }], mode, (m) => {
        if (m === 'form' && !tryJson(false)) return false;
        mode = m; renderBody();
      }, { small: true }));
    }
    if (custom) parts.push(...customBody());
    else if (mode === 'json') parts.push(...jsonBody());
    else {
      parts.push(section(1, t('ed_basic'), h('div', { class: 'grid2' },
        field(t('f_remark'), text('remark', { mono: false }), { full: true }),
        field(t('f_address'), text('address', { placeholder: 'example.com' })),
        field(t('f_port'), text('port', { type: 'number' })),
        viaField())));
      parts.push(authSection(), transportSection(), securitySection());
    }
    parts.push(err, preview);
    d.body.replaceChildren(...parts.filter(Boolean));
    refreshPreview();
  }

  function cleanErr(e) { return String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
  function showErr(msg) { err.replaceChildren(icon('alert', 16), h('span', null, msg)); err.hidden = false; }

  function outgoing() {
    const o = { ...draft };
    if (o.protocol === 'naive') { o.network = o.__quic ? 'quic' : ''; }
    if (o.protocol === 'masque') {
      // Only the chosen way of signing in is sent: WARP keys or a user name / password.
      const drop = o.__warp ? ['username', 'password'] : ['warpPrivateKey', 'warpPublicKey', 'warpAddress'];
      for (const k of drop) delete o[k];
    }
    delete o.__quic;
    delete o.__warp;
    return o;
  }

  const refreshPreview = debounce(async () => {
    if (draft.protocol === 'group') return;
    if (draft.protocol === 'custom') {
      preview.replaceChildren(h('span', { class: 'section-label' }, t('ed_linkPreview')), h('div', { class: 'dim' }, t('ed_noLink')));
      return;
    }
    let r;
    try { r = await api.previewServer(outgoing()); } catch (e) { r = { error: cleanErr(e) }; }
    if (r.error) {
      preview.replaceChildren(h('span', { class: 'section-label' }, t('ed_linkPreview')), h('div', { class: 'ed-error' }, icon('alert', 14), h('span', null, r.error)));
      return;
    }
    if (r.noLink) {
      // Valid, but the protocol has no share-link format (MASQUE).
      preview.replaceChildren(h('span', { class: 'section-label' }, t('ed_linkPreview')), h('div', { class: 'dim' }, t(r.noLink)));
      return;
    }
    preview.replaceChildren(
      h('div', { class: 'row' }, h('span', { class: 'section-label grow' }, t('ed_linkPreview')),
        button(t('copy'), { size: 'sm', icon: 'copy', variant: 'ghost', onClick: async () => { await api.copy(r.link); toast(t('copied'), 'success'); } }),
        button('QR', { size: 'sm', icon: 'qr', variant: 'ghost', onClick: async () => {
          const url = await run(() => api.makeQr(r.link));
          if (url) modal({ title: t('share_title'), body: h('div', { class: 'qr-box' }, h('img', { src: url, alt: 'QR' }), h('div', { class: 'note warn' }, icon('alert', 16), h('span', null, t('share_warn')))), actions: [{ label: t('close'), variant: 'primary', onClick: (c) => c() }] });
        } })),
      h('div', { class: 'link' }, r.link));
  }, 250);

  d.foot.append(
    button(t('cancel'), { variant: 'ghost', onClick: d.close }),
    h('span', { class: 'grow' }),
    button(t('save'), {
      variant: 'primary', icon: 'check',
      onClick: async () => {
        if (mode === 'json' && !tryJson(false)) return;
        try {
          await api.saveServer(outgoing());
          toast(t('t_saved'), 'success');
          d.close();
        } catch (e) { showErr(cleanErr(e)); }
      },
    }));

  renderBody();
}
