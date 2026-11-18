'use strict';
// Reading versions and checksums from github.com itself (no API hourly limit): the parsers.
const test = require('node:test');
const assert = require('node:assert/strict');

require.cache[require.resolve('electron')] = { id: 'electron', filename: 'electron', loaded: true, exports: { app: { getVersion: () => '1.0.3', isPackaged: false, getPath: () => '.' }, session: {} } };
const { tagFromReleaseUrl, tagsFromAtom, digestFromSumFile, downloadUrl } = require('../electron/updater');

const H1 = '1262522266337b824f07beb8e1375786b437683b3890105469088f8e17e0a69d';
const H2 = 'eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2';

test('the "latest release" redirect gives the tag, only for the same repository', () => {
  assert.equal(tagFromReleaseUrl('https://github.com/Mo7amadd/Best/releases/tag/v1.0.3', 'Mo7amadd/Best'), 'v1.0.3');
  assert.equal(tagFromReleaseUrl('https://github.com/mo7amadd/best/releases/tag/v1.0.4-beta.1', 'Mo7amadd/Best'), 'v1.0.4-beta.1');
  assert.equal(tagFromReleaseUrl('https://github.com/XTLS/Xray-core/releases/tag/v26.11.9', 'XTLS/Xray-core'), 'v26.11.9');
  for (const bad of [
    'https://github.com/Other/Best/releases/tag/v9.9.9', // another repository
    'https://github.com/Mo7amadd/Best/releases', // no release yet: GitHub stays on the list
    'https://evil.example/Mo7amadd/Best/releases/tag/v9.9.9',
    'http://github.com/Mo7amadd/Best/releases/tag/v9.9.9',
    'https://github.com/Mo7amadd/Best/releases/tag/v1%2F..%2Fx',
    'https://github.com/Mo7amadd/Best/releases/tag/%E0%A4%A',
  ]) assert.equal(tagFromReleaseUrl(bad, 'Mo7amadd/Best'), '', bad);
});

test('the releases feed gives the tags in order, without other repositories or odd names', () => {
  const xml = `<feed><entry><link rel="alternate" type="text/html" href="https://github.com/Mo7amadd/Best/releases/tag/v1.0.4-beta.1"/></entry>
    <entry><link rel="alternate" href="https://github.com/Mo7amadd/Best/releases/tag/v1.0.3"/></entry>
    <entry><link rel="alternate" href="https://github.com/Other/Best/releases/tag/v9.9.9"/></entry>
    <entry><link rel="alternate" href="https://github.com/Mo7amadd/Best/releases/tag/v1.0.3"/></entry>
    <entry><link rel="alternate" href="https://github.com/Mo7amadd/Best/releases/tag/a%20b"/></entry></feed>`;
  assert.deepEqual(tagsFromAtom(xml, 'Mo7amadd/Best'), ['v1.0.4-beta.1', 'v1.0.3']);
  assert.deepEqual(tagsFromAtom('<html>rate limited</html>', 'Mo7amadd/Best'), []);
});

test('checksum files: Xray .dgst, sha256sum, SHA256SUMS with several files', () => {
  assert.equal(digestFromSumFile(`MD5= 00\nSHA1= 11\nSHA2-256= ${H1}\nSHA2-512= 22`, 'Xray-windows-64.zip'), H1);
  assert.equal(digestFromSumFile(`${H2}  geoip.dat\n`, 'geoip.dat'), H2);
  assert.equal(digestFromSumFile(`${H2}  ./dist/geoip.dat`, 'geoip.dat'), H2);
  assert.equal(digestFromSumFile(`${H2.toUpperCase()}`, 'dlc.dat'), H2);
  const sums = `${H1}  Best-Setup-v1.0.4.exe\n${H2} *Best-v1.0.4-portable.zip\n`;
  assert.equal(digestFromSumFile(sums, 'Best-Setup-v1.0.4.exe'), H1);
  assert.equal(digestFromSumFile(sums, 'Best-v1.0.4-portable.zip'), H2);
  // a list that does not name the file never gives some other file's hash
  assert.equal(digestFromSumFile(sums, 'Best-Setup-v9.9.9.exe'), '');
  assert.equal(digestFromSumFile(`${H2}  geosite.dat`, 'geoip.dat'), '');
  assert.equal(digestFromSumFile('<html>Not Found</html>', 'geoip.dat'), '');
});

test('download addresses are github.com release downloads, names encoded', () => {
  assert.equal(downloadUrl('Mo7amadd/Best', 'v1.0.4-beta.1', 'SHA256SUMS'), 'https://github.com/Mo7amadd/Best/releases/download/v1.0.4-beta.1/SHA256SUMS');
  assert.equal(downloadUrl('a/b', 'v1', 'x y.zip'), 'https://github.com/a/b/releases/download/v1/x%20y.zip');
});
