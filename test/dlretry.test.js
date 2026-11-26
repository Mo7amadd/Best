'use strict';
// A download that breaks half-way (the tunnel was switched while it ran) starts again instead of
// failing; a cancelled one or one the server refuses does not.
const test = require('node:test');
const assert = require('node:assert');

function load(fetchImpl) {
  const electronKey = require.resolve('electron');
  const saved = require.cache[electronKey];
  const sessions = {};
  require.cache[electronKey] = {
    id: electronKey, filename: electronKey, loaded: true,
    exports: {
      app: { isPackaged: false, getPath: () => require('os').tmpdir(), getVersion: () => '1.0.6' },
      session: { fromPartition: (name) => (sessions[name] ||= { setProxy: async () => {}, fetch: (url, o) => fetchImpl(name, url, o) }) },
      net: {},
    },
  };
  const key = require.resolve('../electron/updater');
  delete require.cache[key];
  const u = require('../electron/updater');
  if (saved) require.cache[electronKey] = saved; else delete require.cache[electronKey];
  delete require.cache[key];
  return u;
}
// A response whose body gives `parts` chunks, then fails when `breakAfter` is set.
function response(parts, breakAfter = 0) {
  let i = 0;
  return {
    ok: true, status: 200, url: 'x', headers: { get: () => String(parts * 4) },
    body: { getReader: () => ({ read: async () => { if (breakAfter && i >= breakAfter) throw new Error('net::ERR_CONNECTION_RESET'); if (i >= parts) return { done: true }; i++; return { done: false, value: new Uint8Array(4) }; }, cancel: async () => {} }) },
  };
}

test('a download broken half-way through the tunnel starts again and finishes', async () => {
  let calls = 0;
  const logs = [];
  let port = 1111;
  // Round 1: the tunnel breaks half-way (switched to another server) and GitHub is blocked directly;
  // round 2: through the new tunnel it works.
  const { Updater } = load(async (ses) => {
    calls++;
    if (calls === 1) { port = 2222; return response(5, 2); }
    if (ses === 'best-updates') throw new Error('net::ERR_CONNECTION_TIMED_OUT');
    return response(5);
  });
  const u = new Updater({ getProxyPort: () => port, log: (m) => logs.push(m) });
  const data = await u.fetch('https://github.com/a/b/releases/download/v1/core.zip', { binary: true });
  assert.strictEqual(data.length, 20);
  assert.strictEqual(calls, 3);
  assert.ok(logs.some((l) => /interrupted.*starting it again/.test(l)), logs.join('\n'));
});

test('a refused or cancelled download is not started again', async () => {
  let calls = 0;
  const { Updater } = load(async () => { calls++; return { ok: false, status: 404, headers: { get: () => '' } }; });
  const u = new Updater({ getProxyPort: () => 0, log: () => {} });
  await assert.rejects(u.fetch('https://x/y.zip', { binary: true }), /HTTP 404/);
  assert.strictEqual(calls, 1);
  calls = 0;
  const ctrl = new AbortController();
  const { Updater: U2 } = load(async () => { calls++; ctrl.abort(); return response(5); });
  await assert.rejects(new U2({ getProxyPort: () => 0, log: () => {} }).fetch('https://x/y.zip', { binary: true, signal: ctrl.signal }), /CANCELLED/);
  assert.strictEqual(calls, 1);
});
