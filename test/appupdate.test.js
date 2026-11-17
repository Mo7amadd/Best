'use strict';
// Updates of Best itself: version order and which release each channel offers.
const test = require('node:test');
const assert = require('node:assert');

// appupdate.js only needs app.getVersion() from Electron here.
let installed = '1.0.2';
require.cache[require.resolve('electron')] = {
  id: 'electron', filename: 'electron', loaded: true,
  exports: { app: { getVersion: () => installed }, shell: {} },
};
const { compareVersions, newer, checkApp, REPO_OK } = require('../electron/appupdate');

test('versions sort by semantic versioning, test versions before their release', () => {
  const order = ['1.0.2', '1.0.3-1', '1.0.3-alpha.1', '1.0.3-beta', '1.0.3-beta.1', '1.0.3-beta.2', '1.0.3-beta.10', '1.0.3-rc.1', '1.0.3', '1.0.10', '1.1.0', '2.0.0-beta.1', '2.0.0'];
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) {
      assert.strictEqual(compareVersions(order[i], order[j]), Math.sign(i - j), `${order[i]} vs ${order[j]}`);
    }
  }
  assert.ok(newer('v1.0.3', '1.0.2'));
  assert.ok(!newer('1.0.3-beta.1', '1.0.3'));
});

const asset = (v) => ({ name: `Best-Setup-v${v}.exe`, digest: 'sha256:' + 'a'.repeat(64), size: 100, browser_download_url: `https://example.invalid/${v}` });
const rel = (v, extra = {}) => ({ tag_name: `v${v}`, draft: false, prerelease: v.includes('-'), assets: [asset(v)], ...extra });
const fake = (latest, list) => ({ latestRelease: async () => latest, releases: async () => list });

test('official channel: only the latest official release', { skip: !REPO_OK }, async () => {
  installed = '1.0.2';
  const r = await checkApp(fake(rel('1.0.3'), [rel('1.0.4-beta.1'), rel('1.0.3')]), false, false);
  assert.deepStrictEqual([r.latest, r.available], ['1.0.3', true]);
  // GitHub never lists a pre-release as latest, but if it did it is not taken.
  const p = await checkApp(fake(rel('1.0.4-beta.1'), []), false, false);
  assert.strictEqual(p.available, false);
});

test('test channel: the newest of releases and pre-releases, never a draft', { skip: !REPO_OK }, async () => {
  installed = '1.0.2';
  const list = [rel('1.0.5-beta.1', { draft: true }), rel('1.0.4-beta.2'), rel('1.0.3'), rel('1.0.4-beta.10'), rel('nonsense'), rel('1.0.2')];
  const r = await checkApp(fake(rel('1.0.3'), list), false, true);
  assert.deepStrictEqual([r.latest, r.available], ['1.0.4-beta.10', true]);
  // once the release is out it wins over its test versions
  const r2 = await checkApp(fake(rel('1.0.4'), [...list, rel('1.0.4')]), false, true);
  assert.strictEqual(r2.latest, '1.0.4');
});

test('a test version installed: its release is an update; with test versions off, back to the official one', { skip: !REPO_OK }, async () => {
  installed = '1.0.3-beta.2';
  const up = await checkApp(fake(rel('1.0.3'), []), false, false);
  assert.deepStrictEqual([up.available, up.back], [true, false]);
  // test versions turned off while 1.0.3 is not out: the latest official release is offered as the way back
  const back = await checkApp(fake(rel('1.0.2'), []), false, false);
  assert.deepStrictEqual([back.latest, back.available, back.back], ['1.0.2', true, true]);
  // ...but not while test versions are on
  const same = await checkApp(fake(rel('1.0.2'), [rel('1.0.3-beta.2'), rel('1.0.2')]), false, true);
  assert.deepStrictEqual([same.available, same.back], [false, false]);
  // and not without a checksum
  const noSum = await checkApp(fake(rel('1.0.2', { assets: [{ ...asset('1.0.2'), digest: '' }] }), []), false, false);
  assert.strictEqual(noSum.available, false);
});

test('an official version installed: never offered an older one', { skip: !REPO_OK }, async () => {
  installed = '1.0.3';
  const r = await checkApp(fake(rel('1.0.2'), []), false, false);
  assert.deepStrictEqual([r.available, r.back], [false, false]);
  const r2 = await checkApp(fake(rel('1.0.2'), [rel('1.0.3-beta.2'), rel('1.0.2')]), false, true);
  assert.deepStrictEqual([r2.available, r2.back], [false, false]);
});

test('a release without a checksum is not offered', { skip: !REPO_OK }, async () => {
  installed = '1.0.2';
  const r = await checkApp(fake(rel('1.0.3', { assets: [{ ...asset('1.0.3'), digest: '' }] }), []), false, false);
  assert.strictEqual(r.available, false);
  const none = await checkApp(fake(rel('1.0.3'), []), true, false); // portable zip missing
  assert.strictEqual(none.available, false);
});
