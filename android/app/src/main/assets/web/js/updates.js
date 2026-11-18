// Updates of Best itself (GitHub releases tagged android-v*) and of the routing data (geoip /
// geosite). Versions and checksums are read from github.com pages (the releases feed and the
// SHA256SUMS file published with each release), which have no hourly limit; the GitHub API is
// only the fallback. The native side downloads only from GitHub, keeps a file only when its
// SHA-256 is the published one, and installs Best only when the APK is signed with the same key.

import { h, icon } from '../gen/dom.js';
import { t, errText, num } from './strings.js';
import { call, on } from './bridge.js';

const TAG_PREFIX = 'android-v';
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$/;
const SAFE_TAG = /^[\w.+-]{1,100}$/;
const KNOWN_ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'];
const AUTO_EVERY = 12 * 3600 * 1000;
// Richer country lists (the same files 3x-ui and Best for Windows use), installed on request.
const GEO_EXT = {
  ir: { repo: 'Chocolate4U/Iran-v2ray-rules', files: [['geosite.dat', 'geosite_IR.dat'], ['geoip.dat', 'geoip_IR.dat']] },
  ru: { repo: 'runetfreedom/russia-v2ray-rules-dat', files: [['geosite.dat', 'geosite_RU.dat'], ['geoip.dat', 'geoip_RU.dat']] },
};
const GEO = [
  { repo: 'v2fly/geoip', asset: 'geoip.dat', sum: 'geoip.dat.sha256sum', name: 'geoip.dat' },
  { repo: 'v2fly/domain-list-community', asset: 'dlc.dat', sum: 'dlc.dat.sha256sum', name: 'geosite.dat' },
];

/** a > b by semantic versioning: 1.2.10 > 1.2.9, and 1.0.3-beta.1 < 1.0.3-beta.2 < 1.0.3. */
export function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre = ''] = String(v).replace(/^v/, '').split(/-(.*)/s);
    return { n: core.split('.').map((x) => Number.parseInt(x, 10) || 0), pre: pre ? pre.split('.') : [] };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] || 0) !== (y.n[i] || 0)) return (x.n[i] || 0) > (y.n[i] || 0) ? 1 : -1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) > Number(q) ? 1 : -1;
    if (pn !== qn) return pn ? -1 : 1;
    if (!pn && p !== q) return p > q ? 1 : -1;
  }
  return 0;
}

const sameRepo = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const downloadUrl = (repo, tag, name) => `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;

/** Tags in a releases feed, newest first (published releases and pre-releases; never drafts). */
export function tagsFromAtom(xml, repo) {
  const out = [];
  for (const m of String(xml || '').matchAll(/href="https:\/\/github\.com\/([^/"]+\/[^/"]+)\/releases\/tag\/([^"]+)"/g)) {
    if (!sameRepo(m[1], repo)) continue;
    let tag = '';
    try { tag = decodeURIComponent(m[2]); } catch { continue; }
    if (SAFE_TAG.test(tag) && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** The SHA-256 of `name` in a checksum file ("<hex>  <name>" lines, or one bare hash). */
export function digestFromSumFile(text, name) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const base = (n) => String(n).replace(/^\*/, '').split(/[\\/]/).pop();
  for (const l of lines) {
    const m = /^([0-9a-f]{64})\s+\*?(\S.*)$/i.exec(l);
    if (m && base(m[2]) === name) return m[1].toLowerCase();
  }
  if (lines.length === 1) {
    const m = /^([0-9a-f]{64})(?:\s+\*?(\S.*))?$/i.exec(lines[0]);
    if (m && (!m[2] || base(m[2]) === name)) return m[1].toLowerCase();
  }
  return '';
}

export function createUpdates(ctx) {
  const { S, render, save, showToast, glass, switchEl, ago } = ctx;
  const U = {
    phase: 'idle', // idle | checking | latest | available | downloading | ready | error
    release: null, // { version, tag, name, url, sha256, beta }
    progress: { done: 0, total: 0 },
    error: '',
    askMetered: false,
    geo: { phase: 'idle', info: null, done: 0, total: 0 },
  };

  const fetchText = async (url) => (await call('net.fetch', { url, userAgent: 'Best-Android' })).body;

  async function newestTag(repo, beta) {
    let tags = [];
    let feedOk = false;
    try {
      tags = tagsFromAtom(await fetchText(`https://github.com/${repo}/releases.atom`), repo);
      feedOk = true;
    } catch { /* the API below */ }
    let ours = tags.filter((x) => x.startsWith(TAG_PREFIX));
    if (!ours.length) {
      // The feed shows only the latest releases; Windows releases may have pushed Android's out.
      try {
        const list = JSON.parse(await fetchText(`https://api.github.com/repos/${repo}/releases?per_page=60`));
        ours = (Array.isArray(list) ? list : []).filter((r) => r && !r.draft && typeof r.tag_name === 'string').map((r) => r.tag_name).filter((x) => x.startsWith(TAG_PREFIX) && SAFE_TAG.test(x));
      } catch (e) {
        if (!feedOk) throw e;
      }
    }
    const versions = ours.map((x) => x.slice(TAG_PREFIX.length)).filter((v) => VERSION.test(v) && (beta || !v.includes('-')));
    return versions.reduce((best, v) => (!best || compareVersions(v, best) > 0 ? v : best), '');
  }

  async function check(quiet = false) {
    if (U.phase === 'checking' || U.phase === 'downloading') return;
    const repo = S.info.repo;
    if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo || '')) return;
    U.phase = 'checking';
    U.error = '';
    U.askMetered = false;
    render();
    try {
      const version = await newestTag(repo, Boolean(S.ui.updBeta));
      S.ui.updLast = Date.now();
      save('ui');
      if (!version || compareVersions(version, S.info.version || '0.0.0') <= 0) {
        U.phase = 'latest';
        U.release = null;
        return;
      }
      const tag = TAG_PREFIX + version;
      const sums = await fetchText(downloadUrl(repo, tag, 'SHA256SUMS'));
      const abi = (S.info.abis || [S.info.abi]).find((a) => KNOWN_ABIS.includes(a));
      const names = [abi && `Best-android-v${version}-${abi}.apk`, `Best-android-v${version}-universal.apk`].filter(Boolean);
      let release = null;
      for (const name of names) {
        const sha256 = digestFromSumFile(sums, name);
        if (sha256) { release = { version, tag, name, sha256, url: downloadUrl(repo, tag, name), beta: version.includes('-') }; break; }
      }
      if (!release) throw Object.assign(new Error('UPDATE_NO_FILE'), { code: 'UPDATE_NO_FILE' });
      U.release = release;
      U.phase = 'available';
    } catch (e) {
      U.phase = quiet ? 'idle' : 'error';
      U.error = e.code || 'FAILED';
    } finally {
      render();
    }
  }

  async function download(anyway = false) {
    const r = U.release;
    if (!r) return;
    if (S.ui.updWifi !== false && !anyway && (await call('net.metered').catch(() => false))) {
      U.askMetered = true;
      return render();
    }
    U.askMetered = false;
    U.phase = 'downloading';
    U.progress = { done: 0, total: 0 };
    render();
    try {
      await call('update.app', { url: r.url, sha256: r.sha256, name: r.name });
      U.phase = 'ready';
    } catch (e) {
      U.phase = 'available';
      if (e.code !== 'CANCELLED') showToast(errText(e.code), true);
    }
    render();
  }

  async function install() {
    const r = U.release;
    if (!r) return;
    try { await call('update.install', { name: r.name, sha256: r.sha256 }); } catch (e) { showToast(errText(e.code), true); }
  }

  async function geoInfo() {
    try { U.geo.info = await call('geo.info'); } catch { U.geo.info = null; }
    const ext = (U.geo.info && U.geo.info.ext) || {};
    S.geoExt = { ir: Number(ext.ir) || 0, ru: Number(ext.ru) || 0 };
    render();
  }

  async function updateGeo() {
    if (U.geo.phase === 'busy' || U.phase === 'downloading') return;
    U.geo = { ...U.geo, phase: 'busy', done: 0, total: 0 };
    render();
    try {
      const items = [];
      for (const g of GEO) {
        const tag = tagsFromAtom(await fetchText(`https://github.com/${g.repo}/releases.atom`), g.repo)[0];
        if (!tag) throw Object.assign(new Error('FAILED'), { code: 'FAILED' });
        const sha256 = digestFromSumFile(await fetchText(downloadUrl(g.repo, tag, g.sum)), g.asset);
        if (!sha256) throw Object.assign(new Error('FAILED'), { code: 'FAILED' });
        items.push({ url: downloadUrl(g.repo, tag, g.asset), sha256, name: g.name });
      }
      await call('update.geo', { items });
      showToast(t('geo_updated'));
      ctx.reconnect(); // a running connection starts again with the new data
    } catch (e) {
      if (e.code !== 'CANCELLED') showToast(errText(e.code), true);
    }
    U.geo.phase = 'idle';
    geoInfo();
  }

  /** Installs (or updates) the Iran / Russia lists: every file checked against its published SHA-256. */
  async function installExt(cc) {
    const g = GEO_EXT[cc];
    if (!g || U.geo.phase === 'busy' || U.phase === 'downloading') return;
    U.geo = { ...U.geo, phase: 'busy', done: 0, total: 0, ext: cc };
    render();
    try {
      const tag = tagsFromAtom(await fetchText(`https://github.com/${g.repo}/releases.atom`), g.repo)[0];
      if (!tag) throw Object.assign(new Error('FAILED'), { code: 'FAILED' });
      const items = [];
      for (const [asset, name] of g.files) {
        const sha256 = digestFromSumFile(await fetchText(downloadUrl(g.repo, tag, `${asset}.sha256sum`)), asset);
        if (!sha256) throw Object.assign(new Error('FAILED'), { code: 'FAILED' });
        items.push({ url: downloadUrl(g.repo, tag, asset), sha256, name });
      }
      await call('update.geo', { items });
      showToast(t('geo_updated'));
      S.geoExt = { ...S.geoExt, [cc]: Date.now() };
      ctx.reconnect();
    } catch (e) {
      if (e.code !== 'CANCELLED') showToast(errText(e.code), true);
    }
    U.geo.phase = 'idle';
    U.geo.ext = '';
    geoInfo();
  }

  on('update.progress', (d) => {
    if (!d) return;
    if (U.phase === 'downloading' && U.release && d.name === U.release.name) U.progress = { done: d.done || 0, total: d.total || 0 };
    else if (U.geo.phase === 'busy') {
      const i = GEO.findIndex((g) => g.name === d.name);
      if (i < 0 && !U.geo.ext) return;
      U.geo.done = d.done || 0;
      U.geo.total = d.total || 0;
      U.geo.step = i;
    }
    if (S.page === 'updates') render();
  });
  on('update.status', (d) => { if (d && d.error) showToast(errText(d.error), true); });

  /** Quietly, on start: at most every 12 hours, only when automatic checks are on. */
  function autoCheck() {
    if (S.ui.updAuto === false) return;
    if (Date.now() - (Number(S.ui.updLast) || 0) < AUTO_EVERY) return;
    check(true);
  }

  const hasNews = () => U.phase === 'available' || U.phase === 'ready';

  function pct(done, total) {
    return total > 0 ? Math.min(1, done / total) : 0;
  }

  function mb(n) {
    return `${num(n / (1024 * 1024), 1)} MB`;
  }

  function view() {
    const r = U.release;
    let status;
    let action = null;
    let extra = null;
    if (U.phase === 'checking') {
      status = h('span', { class: 'upd-status' }, h('span', { class: 'mini-spin' }), t('upd_checking'));
    } else if (U.phase === 'available' && r) {
      status = h('span', { class: 'upd-status on' }, t('upd_available', { v: r.version }), r.beta ? h('span', { class: 'tag' }, t('upd_testVersion')) : null);
      action = U.askMetered
        ? [h('div', { class: 'note warn' }, icon('alert', 18, 1.9), h('span', null, t('upd_metered'))),
          h('div', { class: 'btn-row' },
            h('button', { class: 'btn', style: { flex: '1' }, onClick: () => { U.askMetered = false; render(); } }, t('cancel')),
            h('button', { class: 'btn primary', style: { flex: '1' }, onClick: () => download(true) }, t('upd_anyway')))]
        : h('button', { class: 'btn primary', onClick: () => download(false) }, icon('download', 19, 2), t('upd_download'));
      extra = h('button', { class: 'link-btn', onClick: () => call('app.open', { url: `https://github.com/${S.info.repo}/releases/tag/${encodeURIComponent(r.tag)}` }).catch(() => {}) }, t('upd_notes'));
    } else if (U.phase === 'downloading' && r) {
      const p = pct(U.progress.done, U.progress.total);
      status = h('span', { class: 'upd-status on' }, t('upd_downloading', { p: U.progress.total ? `${num(Math.round(p * 100))}%` : mb(U.progress.done) }));
      action = [
        h('div', { class: 'bar' }, h('i', { style: { width: `${(p * 100).toFixed(1)}%` } })),
        h('button', { class: 'btn', onClick: () => call('update.cancel').catch(() => {}) }, t('cancel')),
      ];
    } else if (U.phase === 'ready' && r) {
      status = h('span', { class: 'upd-status on' }, icon('shield', 17, 2), t('upd_ready'));
      action = [h('small', { class: 'upd-hint' }, t('upd_verified')), h('button', { class: 'btn primary', onClick: install }, t('upd_install'))];
    } else {
      status = U.phase === 'latest'
        ? h('span', { class: 'upd-status on' }, icon('check', 17, 2.4), t('upd_latest'))
        : U.phase === 'error' ? h('span', { class: 'upd-status bad' }, errText(U.error)) : null;
      action = h('button', { class: 'btn', onClick: () => check(false) }, icon('refresh', 18, 2), t('upd_check'));
    }

    const opt = (on, label, hint, fn, key) => h('button', { class: `opt ${on ? 'on' : ''}`, onClick: fn, 'data-key': key },
      h('span', { class: 'item-main' }, h('span', null, label), hint ? h('small', null, hint) : null),
      h('span', { class: 'radio' }));
    const setUi = (patch) => { Object.assign(S.ui, patch); save('ui'); render(); };
    const g = U.geo;
    const geoWhen = g.info && g.info.at ? ago(g.info.at) : '';
    const geoP = pct(g.done, g.total);

    return h('div', { class: 'page', 'data-key': 'updates' },
      h('div', { class: 'title-row' }, h('h1', null, t('updates'))),
      glass('section', 'card upd-card', null,
        h('div', { class: 'conn-row' },
          h('span', { class: 'logo big rim' }, 'b'),
          h('div', { class: 'conn-text' },
            h('span', { class: 'conn-name' }, 'Best'),
            h('span', { class: 'conn-detail mono ltr', style: { textAlign: 'start' } }, `${S.info.version || ''} · Xray ${S.info.xray || ''}`))),
        status,
        action,
        extra,
        S.ui.updLast && (U.phase === 'latest' || U.phase === 'idle') ? h('small', { class: 'upd-hint' }, t('upd_lastCheck', { when: ago(S.ui.updLast) })) : null),
      h('div', { class: 'section-label' }, t('upd_channel')),
      glass('div', 'group', { style: { padding: '6px' } },
        opt(!S.ui.updBeta, t('upd_stable'), '', () => { setUi({ updBeta: false }); U.phase = 'idle'; check(false); }, 'stable'),
        opt(Boolean(S.ui.updBeta), t('upd_beta'), t('upd_betaHint'), () => { setUi({ updBeta: true }); U.phase = 'idle'; check(false); }, 'beta')),
      glass('div', 'group', { style: { marginTop: '10px' } },
        h('button', { class: 'item', onClick: () => setUi({ updAuto: S.ui.updAuto === false }) },
          h('div', { class: 'item-main' }, t('upd_auto')), switchEl(S.ui.updAuto !== false)),
        h('button', { class: 'item', onClick: () => setUi({ updWifi: S.ui.updWifi === false }) },
          h('div', { class: 'item-main' }, t('upd_wifi'), h('small', null, t('upd_wifiHint'))), switchEl(S.ui.updWifi !== false))),
      h('div', { class: 'section-label' }, t('geo_title')),
      glass('div', 'group', null,
        h('div', { class: 'item' },
          h('div', { class: 'item-main' },
            h('span', null, g.info && g.info.downloaded ? t('geo_downloaded', { when: geoWhen }) : t('geo_packed')),
            h('small', null, t('geo_hint')))),
        g.phase === 'busy'
          ? h('div', { class: 'item' },
            h('div', { class: 'item-main' },
              h('span', null, t('upd_downloading', { p: g.total ? `${num(Math.round(geoP * 100))}%` : mb(g.done) })),
              h('div', { class: 'bar', style: { marginTop: '8px' } }, h('i', { style: { width: `${(geoP * 100).toFixed(1)}%` } }))),
            h('button', { class: 'icon-btn', 'aria-label': t('cancel'), onClick: () => call('update.cancel').catch(() => {}) }, icon('close', 18, 1.9)))
          : h('button', { class: 'item', onClick: updateGeo },
            icon('refresh', 19, 1.8), h('div', { class: 'item-main', style: { color: 'var(--accent)' } }, t('geo_update')))),
      h('div', { class: 'section-label' }, t('geo_ext')),
      glass('div', 'group', null,
        h('div', { class: 'item' }, h('div', { class: 'item-main' }, h('small', null, t('geo_extHint')))),
        ['ir', 'ru'].map((cc) => {
          const at = Number(S.geoExt && S.geoExt[cc]) || 0;
          const busy = g.phase === 'busy' && U.geo.ext === cc;
          return h('div', { class: 'item', 'data-key': `ext-${cc}` },
            h('div', { class: 'item-main' }, h('span', null, t(`geo_${cc}`)), at ? h('small', null, t('geo_installed', { when: ago(at) })) : null),
            busy
              ? h('span', { class: 'value mono' }, g.total ? `${num(Math.round(pct(g.done, g.total) * 100))}%` : h('span', { class: 'mini-spin' }))
              : h('button', { class: 'chip', disabled: g.phase === 'busy', onClick: () => installExt(cc) }, at ? t('update') : t('geo_install')));
        })),
      h('div', { class: 'note', style: { marginTop: '12px' } }, icon('info', 18, 1.9), h('span', null, t('upd_xrayNote'))));
  }

  return { view, check, autoCheck, geoInfo, hasNews };
}
