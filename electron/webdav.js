'use strict';
// Backups to the user's own WebDAV server (Nextcloud, ownCloud, a NAS, …). Only already-encrypted
// backups are uploaded (the password never leaves this computer). https is required, except for
// a server in the local network.

const { session } = require('electron');

const net = require('net');

/** A server inside the local network: a private / loopback IP, "localhost" or a single-label .local name.
 *  (Names like 192.168.evil.com or localhost.example.com are NOT private.) */
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || /^[a-z0-9-]{1,63}\.local$/.test(h)) return true;
  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  if (net.isIPv6(h)) return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
  return false;
}
const PRIVATE_HOST = { test: isPrivateHost };

function davClient({ url, user, pass, dir }, proxyPort) {
  let base;
  try { base = new URL(url); } catch { throw new Error('WEBDAV_URL'); }
  if (!(base.protocol === 'https:' || (base.protocol === 'http:' && PRIVATE_HOST.test(base.hostname)))) throw new Error('WEBDAV_URL');
  if (base.username || base.password) throw new Error('WEBDAV_URL'); // credentials belong in their own fields
  const root = `${base.toString().replace(/\/+$/, '')}/${encodeURIComponent(dir || 'Best')}/`;
  const auth = user ? `Basic ${Buffer.from(`${user}:${pass || ''}`).toString('base64')}` : '';
  const ses = session.fromPartition('best-webdav');

  async function req(method, target, { body, headers = {}, okStatus = [200, 201, 204, 207] } = {}) {
    await ses.setProxy(proxyPort ? { proxyRules: `http=127.0.0.1:${proxyPort};https=127.0.0.1:${proxyPort}` } : { mode: 'direct' });
    const res = await ses.fetch(target, {
      method, body, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { ...(auth ? { Authorization: auth } : {}), 'User-Agent': 'Best', ...headers },
    });
    if (res.status === 401 || res.status === 403) throw new Error('WEBDAV_AUTH');
    if (!okStatus.includes(res.status)) throw new Error(`WebDAV HTTP ${res.status}`);
    return res;
  }

  return {
    async ensureDir() { await req('MKCOL', root, { okStatus: [200, 201, 204, 405] }); }, // 405 = exists
    async put(name, text) {
      await this.ensureDir();
      await req('PUT', root + encodeURIComponent(name), { body: text, headers: { 'Content-Type': 'application/octet-stream' } });
    },
    /** Backups in the folder, newest first: [{ name, modified }]. */
    async list() {
      const res = await req('PROPFIND', root, { headers: { Depth: '1', 'Content-Type': 'application/xml' }, body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/></d:prop></d:propfind>', okStatus: [207, 404] });
      if (res.status === 404) return [];
      const xml = (await res.text()).slice(0, 2 * 1024 * 1024);
      const out = [];
      for (const block of xml.split(/<(?:[a-z]+:)?response[\s>]/i).slice(1)) {
        const href = (/<(?:[a-z]+:)?href>([^<]+)</i.exec(block) || [])[1] || '';
        const name = decodeURIComponent(href.replace(/\/+$/, '').split('/').pop() || '');
        if (!/^best-backup-[\w.-]{1,80}\.best$/.test(name)) continue;
        const mod = (/<(?:[a-z]+:)?getlastmodified>([^<]+)</i.exec(block) || [])[1] || '';
        out.push({ name, modified: Date.parse(mod) || 0 });
      }
      return out.sort((a, b) => b.modified - a.modified || b.name.localeCompare(a.name)).slice(0, 50);
    },
    async get(name) {
      if (!/^best-backup-[\w.-]{1,80}\.best$/.test(name)) throw new Error('INVALID_BACKUP');
      const res = await req('GET', root + encodeURIComponent(name));
      const len = Number(res.headers.get('content-length')) || 0;
      if (len > 50 * 1024 * 1024) throw new Error('file too large');
      const text = await res.text();
      if (text.length > 50 * 1024 * 1024) throw new Error('file too large');
      return text;
    },
  };
}

module.exports = { davClient, isPrivateHost };
