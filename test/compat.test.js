'use strict';
// Links and subscriptions other clients write (fixed in v2rayN 8.0 too): WebSocket early data in
// sing-box, the old all-base64 SOCKS link, SIP008 subscriptions and the Hysteria2 hop interval.
const test = require('node:test');
const assert = require('node:assert');
const { parseLink, toLink, normalizeServer } = require('../src/core/links');
const { parseContent } = require('../src/core/subscription');
const { singBoxOutbound } = require('../src/core/singbox-config');
const { proxyOutbound } = require('../src/core/xray-config');
const { mihomoProxy } = require('../src/core/mihomo-config');
const { DEFAULT_SETTINGS } = require('../src/core/settings');

const ID = 'b831381d-6324-4d53-ad4f-8cda48b30811';
const b64 = (x) => Buffer.from(x).toString('base64');

test('sing-box WebSocket: early data comes out of the path, the rest of the query stays', () => {
  const path = (p) => singBoxOutbound(parseLink(`vless://${ID}@1.2.3.4:443?type=ws&security=tls&sni=a.com&path=${encodeURIComponent(p)}#x`)).transport;
  assert.deepStrictEqual([path('/ws?ed=2048&key=v').path, path('/ws?ed=2048&key=v').max_early_data], ['/ws?key=v', 2048]);
  assert.strictEqual(path('/ws?a=1&ed=2048').path, '/ws?a=1');
  assert.strictEqual(path('/ws?a=1&ed=2048&b=2').path, '/ws?a=1&b=2');
  assert.strictEqual(path('/ws?ed=2048').path, '/ws');
  assert.strictEqual(path('?ed=2048').path, '/');
  assert.deepStrictEqual([path('/ws?bed=5').path, path('/ws?bed=5').max_early_data], ['/ws?bed=5', undefined]);
});

test('SOCKS: the old link with everything in base64 imports', () => {
  const s = parseLink(`socks://${b64('admin:admin@1.2.3.4:1080')}#demo`);
  assert.deepStrictEqual([s.address, s.port, s.username, s.password, s.remark], ['1.2.3.4', 1080, 'admin', 'admin', 'demo']);
  // base64 holding "/" and "=", URL-safe base64, no credentials, IPv6, "@" and ":" in the password.
  assert.strictEqual(parseLink('socks://dXNlcjpxd2VydHk/QDEuMi4zLjQ6MTA4MA==#x').password, 'qwerty?');
  assert.strictEqual(parseLink(`socks://${b64('u:p>?@example.com:1080').replace(/\+/g, '-').replace(/\//g, '_')}#x`).password, 'p>?');
  assert.deepStrictEqual([parseLink(`socks://${b64('1.2.3.4:1080')}`).port, parseLink(`socks://${b64('1.2.3.4:1080')}`).username], [1080, undefined]);
  assert.strictEqual(parseLink(`socks://${b64('u:p@[2001:db8::1]:1080')}#x`).address, '2001:db8::1');
  assert.strictEqual(parseLink(`socks://${b64('u:p@ss:w@1.2.3.4:1080')}#x`).password, 'p@ss:w');
  // The current forms are unchanged; base64 that is not an address still fails.
  assert.strictEqual(parseLink('socks://u:p@1.2.3.4:1080#x').username, 'u');
  assert.strictEqual(parseLink(`socks://${b64('u:p')}@1.2.3.4:1080#x`).password, 'p');
  assert.throws(() => parseLink(`socks://${b64('hello world')}#x`));
});

test('SIP008 subscriptions: the document or the bare list, numeric or quoted ports', () => {
  const doc = {
    version: 1,
    servers: [
      { id: 'x', remarks: 'A', server: '1.2.3.4', server_port: 8388, password: 'p1', method: 'aes-256-gcm' },
      { remarks: 'B', server: 'example.com', server_port: '443', password: 'p2', method: 'chacha20-ietf-poly1305', plugin: 'obfs-local', plugin_opts: 'obfs=http;obfs-host=a.com' },
      { remarks: 'C', server: '5.6.7.8', server_port: 1, password: 'p', method: 'aes-128-gcm', plugin: 'kcptun' },
    ],
  };
  for (const text of [JSON.stringify(doc), b64(JSON.stringify(doc))]) {
    const r = parseContent(text, { subId: 's1' });
    assert.deepStrictEqual(r.servers.map((s) => [s.protocol, s.remark, s.address, s.port, s.cipher, s.plugin, s.subId]), [
      ['shadowsocks', 'A', '1.2.3.4', 8388, 'aes-256-gcm', undefined, 's1'],
      ['shadowsocks', 'B', 'example.com', 443, 'chacha20-ietf-poly1305', 'obfs-local', 's1'],
    ]);
    // A plugin Best does not have is reported, never silently left out.
    assert.match(r.errors.map((e) => e.error).join(), /kcptun/);
  }
  assert.strictEqual(parseContent(JSON.stringify(doc.servers.slice(0, 1))).servers[0].port, 8388);
  // Full JSON configs are still JSON configs.
  assert.strictEqual(parseContent(JSON.stringify({ outbounds: [{ protocol: 'freedom' }] })).servers[0].protocol, 'custom');
});

test('Hysteria2 hop interval: a number or a range, for every core and back through the link', () => {
  const hy = (hi) => parseLink(`hysteria2://p@1.2.3.4:443?sni=a.com&mport=20000-30000&hopInterval=${hi}#x`);
  const r = hy('5-15');
  assert.strictEqual(r.hopInterval, '5-15');
  assert.deepStrictEqual([singBoxOutbound(r).hop_interval, singBoxOutbound(r).hop_interval_max], ['5s', '15s']);
  const xray = (s) => proxyOutbound({ ...s, obfs: 'gecko', obfsPassword: 'z' }, DEFAULT_SETTINGS).streamSettings.finalmask.udp.find((m) => m.type === 'udphop').settings;
  assert.strictEqual(xray(r).interval, '5-15');
  assert.strictEqual(xray(hy('30')).interval, 30);
  assert.deepStrictEqual([singBoxOutbound(hy('20s')).hop_interval, singBoxOutbound(hy('20s')).hop_interval_max], ['20s', undefined]);
  assert.strictEqual(parseLink(toLink(r)).hopInterval, '5-15');
  assert.strictEqual(mihomoProxy(r)['hop-interval'], 5);
  // Below 5 seconds, reversed, not a number, or without port hopping: left to the core default.
  for (const bad of ['3-10', '15-5', 'abc', '']) assert.strictEqual(hy(bad).hopInterval, undefined, bad);
  assert.strictEqual(normalizeServer({ protocol: 'hysteria2', address: 'a.com', port: 443, password: 'p', hopInterval: '10' }).hopInterval, undefined);
});
