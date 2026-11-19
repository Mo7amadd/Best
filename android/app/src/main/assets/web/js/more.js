// Pages reached from Settings: Advanced settings, WebDAV backups and Logs, plus the backup sheets
// (save / restore an encrypted .best file, the same format as Best for Windows).

import { h, icon } from '../gen/dom.js';
import { t, errText, num, isRtl } from './strings.js';
import { call } from './bridge.js';
import { encryptBackup, decryptBackup } from './backup-crypto.js';

const Core = globalThis.BestCore;
const FINGERPRINTS = ['', 'chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random', 'randomized'];
const FRAG_PACKETS = ['tlshello', '1-1', '1-2', '1-3', '1-5'];
const LOG_LEVELS = ['warning', 'error', 'info', 'debug', 'none'];

export function createMore(ctx) {
  const { S, render, save, showToast, glass, switchEl, openSheet, closeSheet } = ctx;
  const L = { kind: 'access', text: '', timer: 0, loading: false };

  // ---------------------------------------------------------------- shared bits

  const back = (to = 'settings') => glass('button', 'round-btn sm back', { 'aria-label': t('close'), onClick: () => { S.page = to; render(); } },
    h('span', { style: { display: 'inline-flex', transform: `rotate(${isRtl() ? -90 : 90}deg)` } }, icon('chevron', 20, 2)));
  const pageHead = (title, to) => h('div', { class: 'title-row' }, back(to), h('h1', null, title));
  const section = (title, ...children) => [h('div', { class: 'section-label' }, title), glass('div', 'group ed-group', null, ...children)];
  const field = (label, control, hint) => h('div', { class: 'field' }, h('label', null, label), control, hint ? h('small', null, hint) : null);

  /** Changes one setting through the shared sanitizer; an invalid value is refused and said so. */
  function setSetting(k, v) {
    const next = Core.settings.sanitizeSettings({ ...S.settings, [k]: v });
    // Refused values fall back to the default: say so instead of silently changing what was typed.
    const d = Core.settings.DEFAULT_SETTINGS[k];
    if (typeof v !== 'boolean' && v !== '' && String(v) !== String(d) && String(next[k]) === String(d)) showToast(t('invalidValue'), true);
    S.settings = next;
    save('settings');
    render();
    ctx.applyToConnection();
  }
  const text = (k, label, opts = {}) => field(label, h('input', {
    class: opts.plain ? '' : 'ltr mono', type: opts.number ? 'number' : opts.password ? 'password' : 'text', inputmode: opts.number ? 'numeric' : undefined,
    autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', placeholder: opts.placeholder || '', value: String(S.settings[k] ?? ''), 'data-key': `s-${k}`,
    onChange: (e) => setSetting(k, opts.number ? Number(e.target.value) : e.target.value.trim()),
  }), opts.hint);
  const select = (k, label, options, hint) => field(label, h('select', { 'data-key': `s-${k}`, onChange: (e) => setSetting(k, e.target.value) },
    options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o || t('f_none')]; return h('option', { value: v, selected: String(S.settings[k] ?? '') === v }, l); })), hint);
  const toggle = (k, label, hint) => h('button', { class: 'item', onClick: () => setSetting(k, !S.settings[k]) },
    h('div', { class: 'item-main' }, label, hint ? h('small', null, hint) : null), switchEl(Boolean(S.settings[k])));
  // Android-only options live in the page's "ui" store.
  const setUi = (k, v) => { S.ui[k] = v; save('ui'); render(); ctx.applyToConnection(); };
  const uiToggle = (k, label, hint) => h('button', { class: 'item', onClick: () => setUi(k, !S.ui[k]) },
    h('div', { class: 'item-main' }, label, hint ? h('small', null, hint) : null), switchEl(Boolean(S.ui[k])));

  // ---------------------------------------------------------------- advanced settings

  function viewAdvanced() {
    const st = S.settings;
    return h('div', { class: 'page editor', 'data-key': 'advanced' },
      pageHead(t('adv')),
      h('div', { class: 'note' }, icon('info', 18, 1.9), h('span', null, t('advApply'))),
      ...section(t('adv_dns'),
        text('remoteDns', t('remoteDns'), { placeholder: 'https://1.1.1.1/dns-query' }),
        text('directDns', t('directDns'), { placeholder: 'localhost' }),
        field(t('dnsHosts'), h('textarea', { class: 'ltr', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'data-key': 's-dnsHosts', placeholder: 'example.com 1.2.3.4', value: st.dnsHosts || '', onChange: (e) => setSetting('dnsHosts', e.target.value) }), t('dnsHostsHint')),
        toggle('dnsIpv4Only', t('dnsIpv4Only'))),
      ...section(t('modeVpn'),
        field(t('vpnMtu'), h('input', { class: 'ltr mono', type: 'number', inputmode: 'numeric', value: String(S.ui.vpnMtu || 1500), 'data-key': 'u-mtu',
          onChange: (e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 1280 && n <= 9000) setUi('vpnMtu', n); else { showToast(t('invalidValue'), true); render(); } } })),
        uiToggle('fakeDns', t('fakeDns'), t('fakeDnsHint')),
        uiToggle('preferIpv6', t('preferIpv6'), t('preferIpv6Hint'))),
      ...section(t('adv_traffic'),
        toggle('sniffing', t('sniffing'), t('sniffingHint')),
        toggle('mux', t('mux'), t('muxHint')),
        st.mux ? text('muxConcurrency', t('muxConcurrency'), { number: true }) : null,
        toggle('fragment', t('fragment'), t('fragmentHint')),
        st.fragment ? h('div', { class: 'two' }, select('fragmentPackets', t('fragPackets'), FRAG_PACKETS), text('fragmentLength', t('fragLength'), { placeholder: '100-200' })) : null,
        st.fragment ? text('fragmentInterval', t('fragInterval'), { placeholder: '10-20' }) : null,
        select('defaultFingerprint', t('defaultFp'), FINGERPRINTS, t('defaultFpHint'))),
      ...section(t('adv_subs'),
        toggle('subViaProxy', t('subViaProxy'), t('subViaProxyHint')),
        uiToggle('autoTest', t('autoTest'), t('autoTestHint')),
        S.ui.autoTest ? uiToggle('autoDelete', t('autoDelete'), t('autoDeleteHint')) : null,
        text('subUserAgent', t('subUa'), { hint: t('subUaHint') }),
        toggle('subHwid', t('subHwid'), t('subHwidHint')),
        st.subHwid ? text('subHwidName', t('subHwidName'), { hint: t('subHwidNameHint'), placeholder: 'Android phone' }) : null),
      ...section(t('adv_tests'),
        text('testUrl', t('testUrl')),
        text('speedTestUrl', t('speedUrl')),
        h('div', { class: 'two' }, text('udpTestTarget', t('udpTarget')), text('testTimeout', t('testTimeout'), { number: true })),
        text('testConcurrency', t('testConc'), { number: true })),
      ...section(t('adv_logs'),
        select('logLevel', t('logLevel'), LOG_LEVELS),
        h('button', { class: 'item', onClick: () => { S.ui.logConnections = !S.ui.logConnections; save('ui'); render(); ctx.applyToConnection(); } },
          h('div', { class: 'item-main' }, t('logConn'), h('small', null, t('logConnHint'))), switchEl(Boolean(S.ui.logConnections)))));
  }

  // ---------------------------------------------------------------- backups

  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

  async function backupText(password) {
    const subs = S.subs.map((s) => ({ ...s, lastUpdate: s.updatedAt || 0 }));
    // The WebDAV password stays on this phone (a backup may be handed to someone else).
    const settings = { ...S.settings, webdavPass: '' };
    const plain = JSON.stringify({ app: 'best', version: 1, settings, routing: S.routing, servers: S.servers, subs, activeId: S.ui.selected });
    return JSON.stringify(await encryptBackup(plain, password));
  }

  /** Sheet: choose the backup password (twice), then save to a file or upload. */
  function exportSheet(target) { openSheet({ type: 'backupPw', target, pw1: '', pw2: '', busy: false }); }

  async function runExport(sh) {
    if (sh.pw1.length < 8) return showToast(t('pwShort'), true);
    if (sh.pw1 !== sh.pw2) return showToast(t('pwMismatch'), true);
    sh.busy = true;
    render();
    try {
      const data = await backupText(sh.pw1);
      if (sh.target === 'dav') {
        await call('dav.put', { ...davArgs(), name: `best-backup-${stamp()}.best`, text: data });
        closeSheet();
        showToast(t('davUploaded'));
        listDav();
      } else {
        const ok = await call('file.save', { name: `best-backup-${stamp().slice(0, 10)}.best`, text: data });
        closeSheet();
        if (ok) showToast(t('backupSaved'));
      }
    } catch (e) {
      sh.busy = false;
      showToast(errText(e.code), true);
      render();
    }
  }

  /** A backup file / WebDAV text: encrypted ones ask for the password, then everything asks before replacing. */
  function beginImport(raw) {
    let box;
    try { box = JSON.parse(raw); } catch { return showToast(errText('INVALID_BACKUP'), true); }
    if (box && box.app === 'best-encrypted') return openSheet({ type: 'backupOpen', box, pw: '', busy: false });
    if (box && box.app === 'best') return openSheet({ type: 'backupConfirm', data: box });
    showToast(errText('INVALID_BACKUP'), true);
  }

  async function importFile() {
    try {
      const raw = await call('pick.file', { backup: true });
      if (raw) beginImport(raw);
    } catch (e) { showToast(errText(e.code), true); }
  }

  async function runOpen(sh) {
    sh.busy = true;
    render();
    try {
      const data = JSON.parse(await decryptBackup(sh.box, sh.pw));
      if (!data || data.app !== 'best') throw Object.assign(new Error('INVALID_BACKUP'), { code: 'INVALID_BACKUP' });
      openSheet({ type: 'backupConfirm', data });
    } catch (e) {
      sh.busy = false;
      showToast(errText(e.code || 'INVALID_BACKUP'), true);
      render();
    }
  }

  function applyBackup(data) {
    // A backup may come from someone else: nothing in it can open a port on this phone, and
    // full JSON configs always run with Best's own VPN interface (see android-xray.js).
    const keepDav = { webdavUrl: S.settings.webdavUrl, webdavUser: S.settings.webdavUser, webdavPass: S.settings.webdavPass, webdavDir: S.settings.webdavDir };
    const incoming = data.settings || {};
    // Backups never hold the WebDAV password: the one on this phone stays when the server is the same.
    const sameDav = Boolean(incoming.webdavUrl) && incoming.webdavUrl === S.settings.webdavUrl && (incoming.webdavUser || '') === (S.settings.webdavUser || '');
    const dav = !incoming.webdavUrl ? keepDav : { webdavPass: sameDav ? S.settings.webdavPass : '' };
    S.settings = Core.settings.sanitizeSettings({ ...incoming, tun: false, allowLan: false, ...dav });
    S.routing = Core.settings.sanitizeRouting(data.routing || {});
    S.servers = ctx.cleanServers(data.servers);
    S.subs = ctx.cleanSubs(data.subs);
    S.ui.selected = S.servers.some((s) => s.id === data.activeId) ? data.activeId : (S.servers[0] ? S.servers[0].id : '');
    S.ui.tab = 'all';
    S.delays = {};
    S.speeds = {};
    for (const k of ['settings', 'routing', 'servers', 'subs', 'ui']) save(k);
    closeSheet();
    ctx.applyLook();
    showToast(t('backupRestored'));
    ctx.reconnect();
  }

  // ---------------------------------------------------------------- WebDAV

  const D = { list: null, loading: false };
  const davArgs = () => ({ url: S.settings.webdavUrl, user: S.settings.webdavUser, pass: S.settings.webdavPass, dir: S.settings.webdavDir });

  async function listDav() {
    D.loading = true;
    render();
    try { D.list = await call('dav.list', davArgs()); } catch (e) { D.list = null; showToast(errText(e.code), true); }
    D.loading = false;
    render();
  }

  async function restoreDav(name) {
    try { beginImport(await call('dav.get', { ...davArgs(), name })); } catch (e) { showToast(errText(e.code), true); }
  }

  function viewWebdav() {
    const ready = Boolean(S.settings.webdavUrl);
    return h('div', { class: 'page editor', 'data-key': 'webdav' },
      pageHead(t('webdav')),
      h('div', { class: 'note' }, icon('shield', 18, 1.9), h('span', null, t('davNote'))),
      ...section(t('webdav'),
        text('webdavUrl', t('dav_url'), { placeholder: 'https://cloud.example.com/remote.php/dav/files/me' }),
        h('div', { class: 'two' }, text('webdavUser', t('dav_user')), text('webdavDir', t('dav_dir'), { placeholder: 'Best' })),
        text('webdavPass', t('dav_pass'), { password: true })),
      h('div', { class: 'btn-row', style: { marginTop: '12px' } },
        h('button', { class: 'btn primary', style: { flex: '1' }, disabled: !ready, onClick: () => exportSheet('dav') }, icon('upload', 18, 2), t('backupUpload')),
        h('button', { class: 'btn', style: { flex: '1' }, disabled: !ready || D.loading, onClick: listDav }, D.loading ? h('span', { class: 'mini-spin' }) : icon('refresh', 18, 2), t('davLoad'))),
      D.list ? [
        h('div', { class: 'section-label' }, t('backupList')),
        glass('div', 'group', null,
          D.list.length ? D.list.map((b) => h('button', { class: 'item', 'data-key': b.name, onClick: () => restoreDav(b.name) },
            icon('download', 19, 1.8),
            h('div', { class: 'item-main' }, h('span', { class: 'ltr', style: { textAlign: 'start' } }, b.name), b.modified ? h('small', null, ctx.ago(b.modified)) : null)))
            : h('div', { class: 'item' }, h('div', { class: 'item-main' }, h('small', null, t('davEmpty'))))),
      ] : null);
  }

  // ---------------------------------------------------------------- logs

  async function readLogs() {
    if (S.page !== 'logs' || L.loading) return;
    L.loading = true;
    try { L.text = (await call('logs.read', { kind: L.kind })) || ''; } catch { L.text = ''; }
    L.loading = false;
    render();
  }

  function startLogs() {
    clearInterval(L.timer);
    readLogs();
    L.timer = setInterval(() => { if (S.page === 'logs') readLogs(); else clearInterval(L.timer); }, 2000);
  }

  const ACCESS = /^(\d{4}\/\d\d\/\d\d) (\d\d:\d\d:\d\d)\S* from (\S+) (accepted|rejected) (?:(tcp|udp):)?(\S+?)(?::(\d+))? \[([^\]]*)\]/;

  function viewLogs() {
    const lines = L.text.split('\n').filter(Boolean).reverse().slice(0, 400);
    let content;
    if (L.kind === 'access' && !S.ui.logConnections && !lines.length) {
      content = h('div', { class: 'note' }, icon('info', 18, 1.9), h('span', null, t('logs_connOff')));
    } else if (!lines.length) {
      content = h('div', { class: 'empty' }, h('span', { class: 'empty-icon' }, icon('info', 28, 1.7)), h('b', null, t('logs_empty')));
    } else if (L.kind === 'access') {
      content = glass('div', 'group', null, lines.map((line, i) => {
        const m = ACCESS.exec(line);
        if (!m) return h('div', { class: 'item log-line ltr', 'data-key': `l${i}` }, line.slice(0, 300));
        const route = (m[8].split('->').pop() || '').trim();
        const kind = /dns-out/.test(route) ? 'dns' : /block|reject/.test(route) || m[4] === 'rejected' ? 'block' : /direct/.test(route) ? 'direct' : 'proxy';
        // Xray writes UTC; shown in the phone's time.
        const when = new Date(`${m[1].replace(/\//g, '-')}T${m[2]}Z`);
        const time = Number.isNaN(when.getTime()) ? m[2] : when.toLocaleTimeString('en-GB', { hour12: false });
        return h('div', { class: 'item', 'data-key': `l${i}` },
          h('div', { class: 'item-main' },
            h('span', { class: 'ltr mono', style: { fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'start' } }, `${m[6]}${m[7] ? `:${m[7]}` : ''}`),
            h('small', { class: 'ltr', style: { textAlign: 'start' } }, `${time} · ${(m[5] || 'tcp').toUpperCase()}`)),
          h('span', { class: `tag ${kind}` }, kind === 'dns' ? 'DNS' : t({ proxy: 'outProxy', direct: 'outDirect', block: 'outBlock' }[kind])));
      }));
    } else {
      // Error lines start with Xray's UTC time too; shown in the phone's time.
      const local = (line) => line.replace(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)?/, (all, y, mo, d, hms) => {
        const when = new Date(`${y}-${mo}-${d}T${hms}Z`);
        if (Number.isNaN(when.getTime())) return all;
        const p = (n) => String(n).padStart(2, '0');
        return `${when.getFullYear()}/${p(when.getMonth() + 1)}/${p(when.getDate())} ${when.toLocaleTimeString('en-GB', { hour12: false })}`;
      });
      content = glass('div', 'group', null, lines.map((line, i) => h('div', { class: 'item log-line ltr', 'data-key': `l${i}` }, local(line).slice(0, 600))));
    }
    const tabs = [['access', t('logs_conn')], ['error', t('logs_err')]];
    const i = tabs.findIndex(([k]) => k === L.kind);
    return h('div', { class: 'page editor', 'data-key': 'logs' },
      pageHead(t('logs')),
      h('div', { class: 'toolbar', style: { marginBottom: '12px' } },
        glass('div', 'seg sm', null,
          h('span', { class: 'seg-ind', style: { width: 'calc((100% - 8px) / 2)', transform: `translateX(${(isRtl() ? -1 : 1) * i * 100}%)` } }),
          tabs.map(([k, label]) => h('button', { class: L.kind === k ? 'on' : '', 'data-key': k, onClick: () => { L.kind = k; L.text = ''; readLogs(); } }, label))),
        glass('button', 'round-btn sm plain', { 'aria-label': t('logs_copy'), onClick: async () => { await call('clip.write', { text: L.text.slice(-200000), sensitive: true }).catch(() => {}); showToast(t('copied')); } }, icon('copy', 18, 1.9)),
        glass('button', 'round-btn sm plain', { 'aria-label': t('logs_clear'), onClick: async () => { await call('logs.clear').catch(() => {}); L.text = ''; render(); } }, icon('trash', 18, 1.9))),
      content);
  }

  // ---------------------------------------------------------------- sheets of these pages

  function sheet(sh) {
    if (sh.type === 'backupPw') {
      return {
        title: t('backupExport'),
        body: [
          h('div', { class: 'field' }, h('label', null, t('pwNew')),
            h('input', { type: 'password', autocomplete: 'new-password', value: sh.pw1, 'data-key': 'pw1', onInput: (e) => { sh.pw1 = e.target.value; } })),
          h('div', { class: 'field' }, h('label', null, t('pwAgain')),
            h('input', { type: 'password', autocomplete: 'new-password', value: sh.pw2, 'data-key': 'pw2', onInput: (e) => { sh.pw2 = e.target.value; } })),
          h('div', { class: 'note warn' }, icon('alert', 18, 1.9), h('span', null, t('pwKeep'))),
          h('button', { class: 'btn primary', disabled: sh.busy, onClick: () => runExport(sh) }, sh.busy ? t('working') : sh.target === 'dav' ? t('backupUpload') : t('backupExport')),
        ],
      };
    }
    if (sh.type === 'backupOpen') {
      return {
        title: t('backupImport'),
        body: [
          h('div', { class: 'field' }, h('label', null, t('pwEnter')),
            h('input', { type: 'password', autocomplete: 'current-password', value: sh.pw, 'data-key': 'pwo', onInput: (e) => { sh.pw = e.target.value; } })),
          h('button', { class: 'btn primary', disabled: sh.busy, onClick: () => runOpen(sh) }, sh.busy ? t('working') : t('restore')),
        ],
      };
    }
    if (sh.type === 'backupConfirm') {
      const d = sh.data;
      return {
        title: t('backupImport'),
        body: [
          h('div', { class: 'note warn' }, icon('alert', 18, 1.9), h('span', null, t('restoreQ'))),
          h('div', { class: 'chips' },
            h('span', { class: 'chip' }, t('configsN', { n: num((d.servers || []).length) })),
            h('span', { class: 'chip' }, `${t('subscriptions')}: ${num((d.subs || []).length)}`)),
          h('div', { class: 'btn-row' },
            h('button', { class: 'btn', style: { flex: '1' }, onClick: closeSheet }, t('cancel')),
            h('button', { class: 'btn primary', style: { flex: '1' }, onClick: () => applyBackup(d) }, t('restore'))),
        ],
      };
    }
    return null;
  }

  return { viewAdvanced, viewWebdav, viewLogs, startLogs, sheet, exportSheet, importFile };
}
