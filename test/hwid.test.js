'use strict';
// Device id for panels that limit devices (src/core/hwid.js).
const test = require('node:test');
const assert = require('node:assert');
const { newSecret, validSecret, hwidFor, hwidHeaders, hwidStatus } = require('../src/core/hwid');
const { sanitizeSettings, DEFAULT_SETTINGS } = require('../src/core/settings');

const REMNAWAVE = /^[a-zA-Z0-9=-]{10,64}$/; // what the panel accepts; anything else is ignored

test('the id: accepted by the panel, stable per panel, different between panels', () => {
  const secret = newSecret();
  assert.ok(validSecret(secret));
  const a = hwidFor(secret, 'https://panel.example.com:2096/sub/abc');
  assert.match(a, REMNAWAVE);
  assert.strictEqual(a.length, 32);
  // the same panel (another path or token, other case): the same id, so it stays one device
  assert.strictEqual(hwidFor(secret, 'https://PANEL.example.com/sub/other-token'), a);
  // another panel cannot link it to the first
  assert.notStrictEqual(hwidFor(secret, 'https://other.example.net/sub/abc'), a);
  // another computer (another secret): another id
  assert.notStrictEqual(hwidFor(newSecret(), 'https://panel.example.com/sub/abc'), a);
});

test('headers: Windows, its version, a neutral name unless the user chose one; nothing when off', () => {
  const secret = newSecret();
  const h = hwidHeaders({ secret, url: 'https://p.example/sub', osVersion: '10.0.26300', model: '' });
  assert.deepStrictEqual(Object.keys(h).sort(), ['x-device-model', 'x-device-os', 'x-hwid', 'x-ver-os']);
  assert.strictEqual(h['x-device-os'], 'Windows');
  assert.strictEqual(h['x-ver-os'], '10.0.26300');
  assert.strictEqual(h['x-device-model'], 'Windows PC');
  assert.strictEqual(hwidHeaders({ secret, url: 'https://p.example/', model: '  Office   laptop ' })['x-device-model'], 'Office laptop');
  // header values stay plain ASCII (no line breaks to inject more headers)
  const bad = hwidHeaders({ secret, url: 'https://p.example/', model: 'PC\r\nX-Evil: 1 کامپیوتر', osVersion: '10\n0' });
  assert.ok(Object.values(bad).every((v) => /^[\x20-\x7e]+$/.test(v)), JSON.stringify(bad));
  assert.deepStrictEqual(hwidHeaders({ enabled: false, secret, url: 'https://p.example/' }), {});
  assert.deepStrictEqual(hwidHeaders({ secret: 'short', url: 'https://p.example/' }), {});
});

test("the panel's answer: device limit reached, id required, or nothing", () => {
  const from = (o) => (n) => o[n];
  assert.strictEqual(hwidStatus(from({ 'x-hwid-active': 'true', 'x-hwid-max-devices-reached': 'true' })), 'limit');
  assert.strictEqual(hwidStatus(from({ 'x-hwid-limit': 'TRUE' })), 'limit'); // older name (v2RayTun)
  assert.strictEqual(hwidStatus(from({ 'x-hwid-active': 'true', 'x-hwid-not-supported': 'true' })), 'required');
  assert.strictEqual(hwidStatus(from({ 'x-hwid-active': 'true' })), '');
  assert.strictEqual(hwidStatus(from({})), '');
});

test('settings: on by default; the device name is short plain text', () => {
  assert.strictEqual(DEFAULT_SETTINGS.subHwid, true);
  const s = sanitizeSettings({ subHwid: false, subHwidName: 'My PC  کامپیوتر\r\n' + 'x'.repeat(80) });
  assert.strictEqual(s.subHwid, false);
  assert.ok(s.subHwidName.length <= 40 && /^[\x20-\x7e]*$/.test(s.subHwidName), JSON.stringify(s.subHwidName));
  // letters that cannot be sent are dropped without leaving spaces behind
  assert.strictEqual(sanitizeSettings({ subHwidName: 'Pixel 8 گوشی من' }).subHwidName, 'Pixel 8');
  assert.strictEqual(sanitizeSettings({ subHwidName: 'لپ‌تاپ Office  PC' }).subHwidName, 'Office PC');
});
