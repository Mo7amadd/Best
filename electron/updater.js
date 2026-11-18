'use strict';
// Core and geo-data updates.
//  - Only the official GitHub repositories below are ever contacted (HTTPS).
//  - Every download is checked against the SHA-256 the project publishes; no match, no install.
//  - New cores are run once ("version") before they replace anything.
//  - Updated files live in the user's profile; the copies bundled with Best are never modified,
//    so "Restore bundled version" always works.
//  - Elevated (TUN) runs never execute a core from a folder a normal program could write to: with
//    the all-users install (Program Files) they use the bundled cores or updates stored next to
//    them (resources\cores-updated), which only an administrator can change.
//  - A core is replaced by moving the old file aside, never by stopping it: a running TUN keeps
//    its (old) executable and is not interrupted.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const EventEmitter = require('events');
const { app, session, net } = require('electron');

const MAX_DOWNLOAD = 200 * 1024 * 1024;
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

const COMPONENTS = {
  xray: { repo: 'XTLS/Xray-core', asset: () => 'Xray-windows-64.zip', kind: 'core' },
  singbox: { repo: 'SagerNet/sing-box', asset: (tag) => `sing-box-${tag.replace(/^v/, '')}-windows-amd64.zip`, kind: 'core' },
  // Optional third core (Clash.Meta), installed on demand from Updates.
  mihomo: { repo: 'MetaCubeX/mihomo', asset: (tag) => `mihomo-windows-amd64-compatible-${tag}.zip`, kind: 'core', optional: true },
  geoip: { repo: 'v2fly/geoip', asset: () => 'geoip.dat', sum: 'geoip.dat.sha256sum', kind: 'geo', file: 'geoip.dat' },
  geosite: { repo: 'v2fly/domain-list-community', asset: () => 'dlc.dat', sum: 'dlc.dat.sha256sum', kind: 'geo', file: 'geosite.dat' },
  // Optional country rule files, used as ext:geosite_XX.dat / ext:geoip_XX.dat (same sources as 3x-ui).
  geoIr: { repo: 'Chocolate4U/Iran-v2ray-rules', kind: 'ext', optional: true, files: [['geosite.dat', 'geosite_IR.dat'], ['geoip.dat', 'geoip_IR.dat']] },
  geoRu: { repo: 'runetfreedom/russia-v2ray-rules-dat', kind: 'ext', optional: true, files: [['geosite.dat', 'geosite_RU.dat'], ['geoip.dat', 'geoip_RU.dat']] },
};

// GitHub's API allows 60 requests an hour per address without an account, and many users share
// one address (mobile operators, the same VPN server). So versions and checksums are read from
// github.com itself, which has no such limit: the "latest release" redirect, the releases feed and
// the checksum files published next to the downloads. The API is only the fallback.
const SAFE_TAG = /^[\w.+-]{1,100}$/;
const sameRepo = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
function downloadUrl(repo, tag, name) {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}
/** ".../owner/repo/releases/tag/v1.2.3" (where /releases/latest leads) → "v1.2.3", else ''. */
function tagFromReleaseUrl(url, repo) {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/tag\/([^/?#]+)\/?$/.exec(String(url || ''));
  if (!m || !sameRepo(m[1], repo)) return '';
  let tag = '';
  try { tag = decodeURIComponent(m[2]); } catch { return ''; }
  return SAFE_TAG.test(tag) ? tag : '';
}
/** Tags in the releases feed (published releases and pre-releases; drafts are never in it). */
function tagsFromAtom(xml, repo) {
  const out = [];
  for (const m of String(xml || '').matchAll(/href="https:\/\/github\.com\/([^/"]+\/[^/"]+)\/releases\/tag\/([^"]+)"/g)) {
    if (!sameRepo(m[1], repo)) continue;
    let tag = '';
    try { tag = decodeURIComponent(m[2]); } catch { continue; }
    if (SAFE_TAG.test(tag) && !out.includes(tag)) out.push(tag);
  }
  return out;
}
/**
 * The SHA-256 of `assetName` in a published checksum file: "SHA2-256= <hex>" (Xray's .dgst),
 * "<hex>  <name>" lines (sha256sum, SHA256SUMS), or one bare hash. A list of several files must name
 * the file; '' when it is not there.
 */
function digestFromSumFile(text, assetName) {
  const s = String(text || '');
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const base = (n) => String(n).replace(/^\*/, '').split(/[\\/]/).pop();
  for (const l of lines) {
    const m = /^([0-9a-f]{64})\s+\*?(\S.*)$/i.exec(l);
    if (m && base(m[2]) === assetName) return m[1].toLowerCase();
  }
  const dgst = /SHA2?-256\s*=\s*([0-9a-f]{64})/i.exec(s);
  if (dgst) return dgst[1].toLowerCase();
  if (lines.length === 1) {
    const m = /^([0-9a-f]{64})(?:\s+\*?(\S.*))?$/i.exec(lines[0]);
    if (m && (!m[2] || base(m[2]) === assetName)) return m[1].toLowerCase();
  }
  return '';
}
/** An HTTP answer that means "GitHub's API limit for this address is used up". */
const rateLimited = (e) => /HTTP (403|429)/.test(String(e && e.message));

function bundledDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'cores') : path.join(__dirname, '..', 'resources', 'cores');
}
function userCoresDir() { return path.join(app.getPath('userData'), 'cores'); }

let elevated = false;
/** Told once at start-up whether Best runs as administrator. */
function setElevated(v) { elevated = Boolean(v); }

/** Installed for all users under Program Files (folder writable by administrators only)? */
function protectedInstall() {
  if (!app.isPackaged) return false;
  if (fs.existsSync(path.join(path.dirname(process.execPath), 'portable'))) return false;
  const here = path.resolve(process.resourcesPath).toLowerCase();
  return [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    .filter(Boolean).some((r) => here.startsWith(path.resolve(r).toLowerCase() + path.sep));
}
function protectedCoresDir() { return path.join(process.resourcesPath, 'cores-updated'); }
/** Admin-only locations are used when elevated in a Program Files install. */
function adminOnly() { return elevated && protectedInstall(); }
/**
 * Working files of the cores (sing-box cache, mihomo config, app update download). When elevated in a
 * Program Files install they live there too, out of reach of programs running without admin rights.
 */
function runRoot() { return adminOnly() ? path.join(process.resourcesPath, 'run') : app.getPath('userData'); }
/** Where new core versions are written. */
function coreTargetDir() { return adminOnly() ? protectedCoresDir() : userCoresDir(); }
function stagingRoot() { return adminOnly() ? path.join(process.resourcesPath, 'update-staging') : path.join(app.getPath('userData'), 'update-staging'); }
const coreSub = (core) => (core === 'xray' ? 'xray' : core === 'mihomo' ? 'mihomo' : 'sing-box');
const exeName = (core) => (core === 'xray' ? 'xray.exe' : core === 'mihomo' ? 'mihomo.exe' : 'sing-box.exe');
/** Updater id → core name. */
const coreOfId = (id) => (id === 'singbox' ? 'sing-box' : id);
/** Is the optional mihomo core installed? */
function mihomoInstalled() { return fs.existsSync(coreExe('mihomo')); }
function userGeoDir() { return path.join(app.getPath('userData'), 'geo'); }

/** Path of the core executable that will be used (an updated copy wins over the bundled one). */
function coreExe(core) {
  const name = path.join(coreSub(core), exeName(core));
  const bundled = path.join(bundledDir(), name);
  if (adminOnly()) {
    const p = path.join(protectedCoresDir(), name);
    return fs.existsSync(p) ? p : bundled;
  }
  // Normal runs: the most recently installed update, wherever it was installed.
  const found = [userCoresDir(), ...(protectedInstall() ? [protectedCoresDir()] : [])]
    .map((d) => path.join(d, name)).filter((p) => fs.existsSync(p));
  if (!found.length) return bundled;
  return found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

/** Every place a core of ours can run from (for cleaning up after a crash). */
function allCoreExes() {
  const out = [];
  for (const d of [bundledDir(), userCoresDir(), ...(app.isPackaged ? [protectedCoresDir()] : [])]) {
    for (const core of ['xray', 'sing-box', 'mihomo']) {
      const file = exeName(core);
      out.push(path.join(d, core, file), path.join(d, `${core}.prev`, file));
    }
  }
  return out;
}

/**
 * Put new files into `destDir`, moving the current ones to `<destDir>.prev`. Windows allows moving a
 * running executable, so a core that is still running (TUN) keeps working from its new place.
 */
function swapFiles(destDir, files) {
  const prevDir = `${destDir}.prev`;
  try { fs.rmSync(prevDir, { recursive: true, force: true }); } catch {
    // An older copy there is still running: park it under another name (cleaned up at start-up).
    fs.renameSync(prevDir, `${destDir}.old-${Date.now()}`);
  }
  fs.mkdirSync(prevDir, { recursive: true });
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of fs.readdirSync(destDir)) fs.renameSync(path.join(destDir, name), path.join(prevDir, name));
  for (const [name, src] of files) fs.copyFileSync(src, path.join(destDir, name));
}

/** Remove parked copies left by earlier updates (best effort; a running one is skipped). */
function cleanupOldCores() {
  for (const root of [userCoresDir(), ...(adminOnly() ? [protectedCoresDir()] : [])]) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const n of names) {
      if (/\.old-\d+$/.test(n)) { try { fs.rmSync(path.join(root, n), { recursive: true, force: true }); } catch { /* still running */ } }
    }
  }
}

/** Folder Xray reads geoip.dat / geosite.dat from. */
function geoDir() {
  const d = userGeoDir();
  return fs.existsSync(path.join(d, 'geoip.dat')) && fs.existsSync(path.join(d, 'geosite.dat')) ? d : path.join(bundledDir(), 'xray');
}

/** Optional country rule files present (Iran / Russia)? */
function extInstalled(id) {
  const c = COMPONENTS[id];
  return Boolean(c && c.kind === 'ext' && c.files.every(([, t]) => fs.existsSync(path.join(userGeoDir(), t))));
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function run(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 120000, ...opts }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).slice(0, 300))) : resolve(String(stdout))));
  });
}

class Updater extends EventEmitter {
  constructor({ getProxyPort, beforeSwap, afterSwap, log }) {
    super();
    this.getProxyPort = getProxyPort; // () => http port of the running core, or 0
    this.beforeSwap = beforeSwap; // async (component) => wasRunning
    this.afterSwap = afterSwap; // async (component, wasRunning) => void
    this.log = log;
    this.state = { checkedAt: 0, checking: false, items: {} };
    for (const [k, c] of Object.entries(COMPONENTS)) this.state.items[k] = { current: '', latest: '', available: false, busy: false, progress: 0, error: '', custom: false, optional: Boolean(c.optional), installed: !c.optional };
    this.meta = this.readMeta();
    this.aborts = new Map(); // id → AbortController while its download runs
  }

  /** Stop a running download. Nothing is replaced: files are only swapped after a full, verified download. */
  cancel(id) {
    const c = this.aborts.get(id);
    if (!c) return false;
    c.abort();
    return true;
  }

  metaFile() { return path.join(app.getPath('userData'), 'updates.json'); }
  readMeta() { try { return JSON.parse(fs.readFileSync(this.metaFile(), 'utf8')); } catch { return {}; } }
  writeMeta() { fs.writeFileSync(this.metaFile(), JSON.stringify(this.meta, null, 2)); }

  set(id, patch) {
    const before = this.state.items[id] || {};
    this.state.items[id] = { ...before, ...patch };
    // A download reports progress many times a second: that alone only moves the bar (see main.js),
    // a full state update would rebuild the whole window each time and swallow clicks and scrolling.
    const keys = Object.keys(patch);
    if (keys.length === 1 && keys[0] === 'progress') {
      if (before.progress !== patch.progress) this.emit('progress', id, patch.progress);
      return;
    }
    this.emit('state', this.state);
  }

  /** `maxBytes` / `timeoutMs`: limits for one download (Best's own update is larger than a core). */
  /** `head`: only follow the redirects and return the final address (no body). */
  async fetch(url, { binary = false, head = false, onProgress, maxBytes = MAX_DOWNLOAD, timeoutMs = 600000, signal = null } = {}) {
    // Try through the tunnel first when it is up (GitHub is often blocked), then direct.
    const port = this.getProxyPort();
    const attempts = port ? [`http=127.0.0.1:${port};https=127.0.0.1:${port}`, null] : [null];
    let lastErr;
    for (const rules of attempts) {
      try {
        const ses = session.fromPartition('best-updates');
        await ses.setProxy(rules ? { proxyRules: rules } : { mode: 'direct' });
        const api = url.startsWith('https://api.github.com/');
        const res = await ses.fetch(url, {
          method: head ? 'HEAD' : 'GET',
          headers: { 'User-Agent': `Best/${app.getVersion()}`, Accept: binary ? 'application/octet-stream' : api ? 'application/vnd.github+json' : '*/*' },
          redirect: 'follow', credentials: 'omit', cache: 'no-store',
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(binary ? timeoutMs : 20000)]) : AbortSignal.timeout(binary ? timeoutMs : 20000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (head) return res.url;
        if (!binary) return await res.text();
        const total = Number(res.headers.get('content-length')) || 0;
        if (total > maxBytes) throw new Error('file too large');
        const reader = res.body.getReader();
        const chunks = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (signal && signal.aborted) { reader.cancel().catch(() => {}); throw new Error('CANCELLED'); }
          if (size > maxBytes) { reader.cancel(); throw new Error('file too large'); }
          chunks.push(Buffer.from(value));
          if (onProgress && total) onProgress(size / total);
        }
        return Buffer.concat(chunks);
      } catch (e) {
        if (signal && signal.aborted) throw new Error('CANCELLED'); // do not retry the direct route
        lastErr = e;
      }
    }
    throw lastErr;
  }

  /**
   * Where `url` redirects to, without following it ('' when it does not redirect). Electron's fetch
   * does not tell the final address, so this uses net.request; tunnel first, then direct, like fetch.
   */
  async redirectTarget(url) {
    const port = this.getProxyPort();
    let lastErr;
    for (const rules of port ? [`http=127.0.0.1:${port};https=127.0.0.1:${port}`, null] : [null]) {
      try {
        const ses = session.fromPartition('best-updates');
        await ses.setProxy(rules ? { proxyRules: rules } : { mode: 'direct' });
        return await new Promise((resolve, reject) => {
          const req = net.request({ url, method: 'HEAD', session: ses, redirect: 'manual', credentials: 'omit', useSessionCookies: false });
          const timer = setTimeout(() => { req.abort(); reject(new Error('timed out')); }, 20000);
          const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
          req.setHeader('User-Agent', `Best/${app.getVersion()}`);
          req.on('redirect', (status, method, to) => { done(resolve)(String(to || '')); req.abort(); });
          req.on('response', (res) => { res.on('data', () => {}); res.on('error', () => {}); (res.statusCode < 400 ? done(resolve) : done(reject))(res.statusCode < 400 ? '' : new Error(`HTTP ${res.statusCode}`)); });
          req.on('error', done(reject));
          req.end();
        });
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  /** Tag of the latest release: github.com's own redirect (no API limit), else the API. */
  async latestTag(repo) {
    try {
      const tag = tagFromReleaseUrl(await this.redirectTarget(`https://github.com/${repo}/releases/latest`), repo);
      if (tag) return tag;
    } catch { /* the API below */ }
    return (await this.latestRelease(repo)).tag_name;
  }

  /** Tags of the recent published releases and pre-releases: the feed (no API limit), else the API. */
  async releaseTags(repo) {
    try {
      const tags = tagsFromAtom(await this.fetch(`https://github.com/${repo}/releases.atom`), repo);
      if (tags.length) return tags;
    } catch { /* the API below */ }
    return (await this.releases(repo)).filter((r) => r && !r.draft).map((r) => r.tag_name);
  }

  /** SHA-256 of `assetName` from a checksum file published in that release ('' when none). */
  async publishedDigest(repo, tag, sumName, assetName) {
    try { return digestFromSumFile(await this.fetch(downloadUrl(repo, tag, sumName)), assetName); } catch { return ''; }
  }

  /**
   * The latest release for an install: the API's answer when it gives one; when its limit is used up,
   * the tag from github.com with no asset list (then only published checksum files are trusted).
   */
  async releaseInfo(repo) {
    try { return await this.latestRelease(repo); } catch (e) {
      if (!rateLimited(e)) throw e;
      return { tag_name: await this.latestTag(repo), assets: null, repo, limited: true };
    }
  }

  /** One release by its tag (API; also pre-releases, never drafts). */
  async releaseByTag(repo, tag) {
    const json = JSON.parse(await this.fetch(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`));
    if (!json || typeof json.tag_name !== 'string') throw new Error('bad release data');
    return json;
  }

  /** The most recent releases and pre-releases (newest first), for the test-version channel. */
  async releases(repo) {
    const json = JSON.parse(await this.fetch(`https://api.github.com/repos/${repo}/releases?per_page=20`));
    if (!Array.isArray(json)) throw new Error('bad release data');
    return json;
  }

  async latestRelease(repo) {
    const json = JSON.parse(await this.fetch(`https://api.github.com/repos/${repo}/releases/latest`));
    if (!json || typeof json.tag_name !== 'string') throw new Error('bad release data');
    return json;
  }

  async currentVersion(id) {
    const c = COMPONENTS[id];
    if (c.kind === 'core') {
      if (id === 'mihomo' && !mihomoInstalled()) return '';
      const out = await run(coreExe(coreOfId(id)), [id === 'mihomo' ? '-v' : 'version']).catch(() => '');
      return (id === 'xray' ? /Xray ([\d.]+)/ : id === 'mihomo' ? /v(\d+\.\d+\.\d+)/ : /version ([\d.]+)/).exec(out)?.[1] || '';
    }
    return (this.meta[id] && this.meta[id].tag) || '';
  }

  /** Check all components. Returns the list of ids with an update available. */
  async check() {
    if (this.state.checking) return [];
    this.state.checking = true;
    this.emit('state', this.state);
    const found = [];
    for (const [id, c] of Object.entries(COMPONENTS)) {
      try {
        // No API request here (see latestTag): checking costs nothing of GitHub's hourly limit.
        const tag = await this.latestTag(c.repo);
        const current = await this.currentVersion(id);
        let available;
        if (c.kind === 'core') {
          if (c.optional) this.set(id, { installed: Boolean(current) });
          available = Boolean(current) && tag.replace(/^v/, '') !== current;
        } else if (c.kind === 'ext') {
          const installed = extInstalled(id);
          this.set(id, { installed });
          available = installed && current !== tag;
        } else {
          // Geo files have no version inside; compare the active file's hash with the published one.
          let digest = await this.publishedDigest(c.repo, tag, c.sum, c.asset(tag));
          if (!digest) {
            const rel = await this.latestRelease(c.repo);
            const asset = rel.assets.find((a) => a.name === c.asset(rel.tag_name));
            digest = (asset && /^sha256:([0-9a-f]{64})$/.exec(asset.digest || '')?.[1]) || '';
          }
          const localHash = await sha256File(path.join(geoDir(), c.file)).catch(() => '');
          available = Boolean(digest) && digest !== localHash;
        }
        this.set(id, { current: current || (c.kind === 'geo' ? 'bundled' : ''), latest: tag, available, error: '', custom: c.kind === 'ext' ? false : this.isCustom(id) });
        if (available) found.push(id);
      } catch (e) {
        this.set(id, { error: String(e.message || e).slice(0, 200) });
      }
    }
    this.state.checking = false;
    this.state.checkedAt = Date.now();
    this.emit('state', this.state);
    return found;
  }

  isCustom(id) {
    if (id === 'mihomo') return false;
    if (id === 'xray' || id === 'singbox') return !coreExe(coreOfId(id)).startsWith(bundledDir() + path.sep);
    return Boolean(this.meta[id]);
  }

  async expectedDigest(rel, assetName, sumName) {
    if (!rel.assets) {
      // API limit used up: the fixed download address, and only a checksum file published in the
      // release (Xray: .dgst, geo files: .sha256sum). sing-box and mihomo publish none: try later.
      const asset = { name: assetName, browser_download_url: downloadUrl(rel.repo, rel.tag_name, assetName) };
      for (const sum of [...new Set([sumName, `${assetName}.dgst`, `${assetName}.sha256sum`].filter(Boolean))]) {
        const digest = await this.publishedDigest(rel.repo, rel.tag_name, sum, assetName);
        if (digest) return { asset, digest };
      }
      throw new Error('GITHUB_LIMIT');
    }
    const asset = rel.assets.find((a) => a.name === assetName);
    if (!asset) throw new Error(`release has no ${assetName}`);
    const m = /^sha256:([0-9a-f]{64})$/.exec(asset.digest || '');
    if (m) return { asset, digest: m[1] };
    // Older releases: use the checksum file published next to the asset.
    const sumAsset = rel.assets.find((a) => a.name === (sumName || `${assetName}.dgst`));
    if (!sumAsset) throw new Error('no published checksum');
    const text = await this.fetch(sumAsset.browser_download_url);
    const d = /(?:SHA2?-256\s*=\s*|^)([0-9a-f]{64})/im.exec(text);
    if (!d) throw new Error('checksum file unreadable');
    return { asset, digest: d[1].toLowerCase() };
  }

  async apply(id) {
    const c = COMPONENTS[id];
    if (!c || this.state.items[id].busy) return false;
    this.set(id, { busy: true, progress: 0, error: '' });
    const staging = path.join(stagingRoot(), `${id}-${Date.now()}`);
    let wasRunning = false;
    const ctrl = new AbortController();
    this.aborts.set(id, ctrl);
    const signal = ctrl.signal;
    try {
      const rel = await this.releaseInfo(c.repo);
      if (c.kind === 'ext') {
        const got = [];
        for (let i = 0; i < c.files.length; i++) {
          const [assetName, target] = c.files[i];
          const { asset, digest } = await this.expectedDigest(rel, assetName);
          const data = await this.fetch(asset.browser_download_url, { binary: true, signal, onProgress: (p) => this.set(id, { progress: Math.round(((i + p) / c.files.length) * 90) }) });
          const hash = crypto.createHash('sha256').update(data).digest('hex');
          if (hash !== digest) throw new Error('CHECKSUM_MISMATCH');
          got.push([target, data]);
        }
        this.log(`update ${id}: ${rel.tag_name} verified`);
        this.aborts.delete(id); // from here on files are replaced: no cancelling half-way
        const dir = userGeoDir();
        fs.mkdirSync(dir, { recursive: true });
        const active = geoDir();
        for (const f of ['geoip.dat', 'geosite.dat']) if (!fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(active, f), path.join(dir, f));
        wasRunning = await this.beforeSwap(id);
        for (const [target, data] of got) { fs.writeFileSync(path.join(dir, `${target}.new`), data); fs.renameSync(path.join(dir, `${target}.new`), path.join(dir, target)); }
        this.meta[id] = { tag: rel.tag_name, at: Date.now() };
        this.writeMeta();
        this.set(id, { progress: 100, busy: false, available: false, installed: true, current: rel.tag_name, latest: rel.tag_name });
        return true;
      }
      const { asset, digest } = await this.expectedDigest(rel, c.asset(rel.tag_name), c.sum);
      const data = await this.fetch(asset.browser_download_url, { binary: true, signal, onProgress: (p) => this.set(id, { progress: Math.round(p * 90) }) });
      this.aborts.delete(id); // from here on files are replaced: no cancelling half-way
      const hash = crypto.createHash('sha256').update(data).digest('hex');
      if (hash !== digest) throw new Error('CHECKSUM_MISMATCH');
      this.log(`update ${id}: ${asset.name} ${rel.tag_name} verified (sha256 ${hash.slice(0, 12)}…)`);
      fs.mkdirSync(staging, { recursive: true });

      if (c.kind === 'core') {
        const zip = path.join(staging, 'pkg.zip');
        fs.writeFileSync(zip, data);
        const out = path.join(staging, 'x');
        fs.mkdirSync(out);
        await run(TAR, ['-xf', zip, '-C', out]);
        const want = id === 'xray' ? ['xray.exe'] : id === 'mihomo' ? ['mihomo.exe'] : ['sing-box.exe', 'libcronet.dll'];
        const found = {};
        const walk = (dir) => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (want.includes(e.name)) found[e.name] = p;
            else if (id === 'mihomo' && /^mihomo[\w.-]*\.exe$/i.test(e.name)) found['mihomo.exe'] = p; // released as mihomo-windows-amd64-….exe
          }
        };
        walk(out);
        if (!found[want[0]]) throw new Error('executable missing in package');
        // Run the new core once before using it.
        const ver = await run(found[want[0]], [id === 'mihomo' ? '-v' : 'version']);
        if (!/Xray|sing-box|Mihomo/i.test(ver)) throw new Error('new core did not start');
        this.set(id, { progress: 95 });
        wasRunning = await this.beforeSwap(id);
        swapFiles(path.join(coreTargetDir(), coreSub(coreOfId(id))), want.filter((n) => found[n]).map((n) => [n, found[n]]));
      } else {
        // Xray needs both geo files in one folder: seed the user folder from the active copies first.
        const dir = userGeoDir();
        fs.mkdirSync(dir, { recursive: true });
        const active = geoDir();
        for (const f of ['geoip.dat', 'geosite.dat']) {
          if (!fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(active, f), path.join(dir, f));
        }
        wasRunning = await this.beforeSwap(id);
        const tmp = path.join(dir, `${c.file}.new`);
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, path.join(dir, c.file));
        this.meta[id] = { tag: rel.tag_name, sha256: hash, at: Date.now() };
        this.writeMeta();
      }
      this.set(id, { progress: 100, busy: false, available: false, current: c.kind === 'core' ? rel.tag_name.replace(/^v/, '') : rel.tag_name, latest: rel.tag_name, custom: id !== 'mihomo', ...(c.optional ? { installed: true } : {}) });
      return true;
    } catch (e) {
      if (signal.aborted) {
        this.log(`update ${id}: cancelled`);
        this.set(id, { busy: false, progress: 0, error: '' });
        return false;
      }
      const msg = String(e.message || e).slice(0, 200);
      this.log(`update ${id} failed: ${msg}`);
      this.set(id, { busy: false, progress: 0, error: msg });
      throw new Error(msg);
    } finally {
      this.aborts.delete(id);
      fs.rmSync(staging, { recursive: true, force: true });
      await this.afterSwap(id, wasRunning).catch(() => {});
    }
  }

  /** Go back to the copy that ships with Best. */
  async reset(id) {
    const wasRunning = await this.beforeSwap(id);
    try {
      if (COMPONENTS[id] && COMPONENTS[id].kind === 'ext') {
        for (const [, target] of COMPONENTS[id].files) fs.rmSync(path.join(userGeoDir(), target), { force: true });
        delete this.meta[id];
        this.writeMeta();
        this.set(id, { installed: false, available: false, current: '' });
        return true;
      }
      if (id === 'xray' || id === 'singbox' || id === 'mihomo') {
        const destDir = path.join(coreTargetDir(), coreSub(coreOfId(id)));
        if (fs.existsSync(destDir)) {
          swapFiles(destDir, []); // the update moves aside (kept as .prev)
          try { fs.rmdirSync(destDir); } catch { /* not empty */ }
        }
      } else {
        const dir = userGeoDir();
        if (fs.existsSync(dir)) {
          const backup = `${dir}.prev`;
          fs.rmSync(backup, { recursive: true, force: true });
          fs.renameSync(dir, backup);
        }
        delete this.meta.geoip;
        delete this.meta.geosite;
        this.writeMeta();
      }
    } finally {
      await this.afterSwap(id, wasRunning);
    }
    if (id === 'mihomo') { this.set(id, { installed: false, current: '', available: false }); return true; }
    const current = await this.currentVersion(id);
    this.set(id, { current: current || 'bundled', custom: false, available: Boolean(this.state.items[id].latest) && (this.state.items[id].latest.replace(/^v/, '') !== current) });
    return true;
  }
}

module.exports = { tagFromReleaseUrl, tagsFromAtom, digestFromSumFile, downloadUrl, mihomoInstalled, Updater, coreExe, geoDir, extInstalled, COMPONENTS, setElevated, allCoreExes, cleanupOldCores, protectedInstall, adminOnly, runRoot };
