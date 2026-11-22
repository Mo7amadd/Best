'use strict';
// MASQUE (Xray 26.11+, CONNECT-IP over HTTP/3 or HTTP/2): a server from the editor or a backup is
// validated like any other, becomes the same outbound 3x-ui puts in its JSON subscriptions, and
// runs on Xray only. There is no share-link format, so none is ever made up.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { normalizeServer, toLink, transportLabel } = require('../src/core/links');
const { buildXrayConfig, proxyOutbound, needsSingBox } = require('../src/core/xray-config');
const { singBoxOutbound } = require('../src/core/singbox-config');
const { sanitizeConfig } = require('../src/core/custom');
const { DEFAULT_SETTINGS } = require('../src/core/settings');
const { sanitizeRouting, effectiveRouting } = require('../src/core/routing');

const base = { protocol: 'masque', remark: 'm', address: 'example.com', port: 443 };
const P256 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const warpKeys = {
  warpPrivateKey: P256.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  warpPublicKey: P256.publicKey.export({ type: 'spki', format: 'pem' }),
};

test('MASQUE with a user name and password (a 3x-ui client)', () => {
  const s = normalizeServer({ ...base, username: 'best-test-all', password: 'p:w', path: '/.well-known/masque/ip/*/*/', alpn: 'h3', remoteDns: '9.9.9.9, 2620:fe::fe' });
  assert.deepStrictEqual([s.tls, s.username, s.password, s.path, s.alpn, s.remoteDns], ['tls', 'best-test-all', 'p:w', '/.well-known/masque/ip/*/*/', ['h3'], ['9.9.9.9', '2620:fe::fe']]);
  assert.strictEqual(needsSingBox(s), false);
  const ob = proxyOutbound(s, DEFAULT_SETTINGS);
  assert.deepStrictEqual(ob.settings, { address: 'example.com', port: 443, remoteDNS: ['9.9.9.9', '2620:fe::fe'] });
  assert.deepStrictEqual(ob.streamSettings.masqueSettings, { path: '/.well-known/masque/ip/*/*/', user: 'best-test-all', pass: 'p:w' });
  assert.deepStrictEqual([ob.protocol, ob.streamSettings.network, ob.streamSettings.security, ob.streamSettings.tlsSettings.serverName], ['masque', 'masque', 'tls', 'example.com']);
  assert.strictEqual(ob.mux, undefined);
  assert.strictEqual(transportLabel(s), 'HTTP/3');
  assert.strictEqual(transportLabel({ ...s, alpn: ['h2'] }), 'HTTP/2');
  // Default path: left to Xray. No share link, and sing-box has no MASQUE client.
  assert.strictEqual(normalizeServer(base).path, undefined);
  assert.throws(() => toLink(s), /MASQUE_NO_LINK/);
  assert.throws(() => singBoxOutbound(s));
});

test('MASQUE: values Xray would refuse are refused when saving', () => {
  for (const bad of [
    { path: 'masque' }, { path: '/masque/{dns}/' }, { path: '/a"b' },
    { username: 'a:b', password: 'p' },
    { host: 'example.com/path' }, { host: 'a b' },
    { remoteDns: 'dns.google' },
    { warpPrivateKey: 'not a key!' },
    { ...warpKeys }, // no tunnel address
    { ...warpKeys, warpAddress: '172.16.0.2, 172.16.0.3' },
    { ...warpKeys, warpAddress: 'abc' },
  ]) assert.throws(() => normalizeServer({ ...base, ...bad }), undefined, JSON.stringify(bad).slice(0, 80));
  for (const ok of ['/.well-known/masque/ip/{target}/{ipproto}/', '/masque/ip{?target,ipproto}', '/x']) assert.strictEqual(normalizeServer({ ...base, path: ok }).path, ok);
  assert.strictEqual(normalizeServer({ ...base, host: 'example.com:8443' }).host, 'example.com:8443');
});

test('MASQUE over Cloudflare WARP: PEM keys become one line, no password is sent', () => {
  const s = normalizeServer({ ...base, address: '162.159.198.1', username: 'u', password: 'p', ...warpKeys, warpAddress: ['172.16.0.2', '2606:4700:110:8a36::2/128'] });
  assert.match(s.warpPrivateKey, /^[A-Za-z0-9+/]+=*$/);
  assert.strictEqual(Buffer.from(s.warpPublicKey, 'base64').toString('base64'), s.warpPublicKey);
  assert.deepStrictEqual([s.username, s.password, s.sni], [undefined, undefined, 'consumer-masque.cloudflareclient.com']);
  const ms = proxyOutbound(s, DEFAULT_SETTINGS).streamSettings.masqueSettings;
  assert.deepStrictEqual(Object.keys(ms), ['warp']);
  assert.deepStrictEqual(ms.warp.address, ['172.16.0.2', '2606:4700:110:8a36::2/128']);
  assert.strictEqual(transportLabel(s), 'WARP · HTTP/3');
  // The base64 still holds the same key.
  const der = Buffer.from(s.warpPrivateKey, 'base64');
  assert.strictEqual(crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).asymmetricKeyDetails.namedCurve, 'prime256v1');
});

test('a 3x-ui JSON subscription with a MASQUE outbound is kept', () => {
  const panel = {
    outbounds: [{ tag: 'proxy', protocol: 'masque', settings: { address: 'example.com', port: 31526 }, streamSettings: { network: 'masque', security: 'tls', tlsSettings: { serverName: 'example.com', alpn: ['h3'] }, masqueSettings: { user: 'u', pass: 'p', path: '/.well-known/masque/ip/*/*/' } } }, { tag: 'direct', protocol: 'freedom' }],
  };
  assert.deepStrictEqual(sanitizeConfig(panel, 'xray', []).outbounds.map((o) => o.protocol), ['masque', 'freedom']);
});

// Xray itself accepts what Best builds (skipped where the core is not in the project).
const XRAY = path.join(__dirname, '..', 'resources', 'cores', 'xray', process.platform === 'win32' ? 'xray.exe' : 'xray');
test('Xray accepts the MASQUE configs Best builds', { skip: !fs.existsSync(XRAY) && 'no Xray core here' }, () => {
  const routing = effectiveRouting(sanitizeRouting({}));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'best-masque-'));
  try {
    for (const [name, srv] of [
      ['user', { ...base, username: 'u', password: 'p', alpn: 'h2', remoteDns: '1.1.1.1' }],
      ['warp', { ...base, ...warpKeys, warpAddress: '172.16.0.2, 2606:4700:110:8a36::2' }],
    ]) {
      const file = path.join(dir, `${name}.json`);
      fs.writeFileSync(file, JSON.stringify(buildXrayConfig(normalizeServer(srv), DEFAULT_SETTINGS, routing, {})));
      const out = execFileSync(XRAY, ['run', '-test', '-c', file], { encoding: 'utf8', cwd: path.dirname(XRAY) });
      assert.match(out, /Configuration OK/, name);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
