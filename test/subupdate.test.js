'use strict';
// Subscription update: which servers count as unchanged, and so keep their test results.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseLink, normalizeServer, serverKey, sameConnection } = require('../src/core/links');

const UUID = '0b6d8a1c-1111-4c2d-9e3f-123456789abc';
const PBK = 'Z84J2IelR9ch3k8VtlVhhs5ycBUlXA7wHBWcBLJ8XzQ';
const reality = (sni, pbk = PBK, name = 'nl-1') => `vless://${UUID}@nl.example.com:443?type=tcp&security=reality&sni=${sni}&fp=chrome&pbk=${pbk}&sid=6ba85179e30d4fc2&flow=xtls-rprx-vision#${name}`;

// A server as Best keeps it on disk (with its results) and reads it back.
const stored = (s) => normalizeServer(JSON.parse(JSON.stringify({ ...s, id: 'srv1', subId: 'sub1', delay: 120, speed: 3.5, udp: true, usageUp: 10, usageDown: 20 })));

test('every sample link: the same server read back from disk counts as unchanged', () => {
  // Every fixed link written in the tests of this project, plus a few full ones.
  const links = new Set([
    reality('www.microsoft.com'),
    `vmess://${Buffer.from(JSON.stringify({ v: '2', ps: 'de', add: 'de.example.com', port: '443', id: UUID, aid: '0', net: 'ws', type: 'none', host: 'cdn.example.com', path: '/ws', tls: 'tls', sni: 'cdn.example.com', fp: 'chrome' })).toString('base64')}`,
    `trojan://secret@tr.example.com:443?security=tls&sni=tr.example.com&type=grpc&serviceName=gun#tr`,
    `hysteria2://pass@hy.example.com:8443?sni=hy.example.com&obfs=salamander&obfs-password=xyz#hy`,
    `tuic://${UUID}:pw@tu.example.com:443?congestion_control=bbr&alpn=h3&sni=tu.example.com#tu`,
  ]);
  for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js'))) {
    for (const m of fs.readFileSync(path.join(__dirname, f), 'utf8').matchAll(/'((?:vless|vmess|trojan|ss|hysteria2|hy2|tuic|wireguard|socks|http|anytls|naive\+https):\/\/[^'\s]+)'/g)) links.add(m[1]);
  }
  let checked = 0;
  for (const link of links) {
    let a; let b;
    try { a = parseLink(link); b = parseLink(link); } catch { continue; } // links that tests expect to fail
    if (!a || !b) continue;
    assert.ok(sameConnection(stored(a), b), `changed after a round trip: ${link.slice(0, 70)}`);
    checked++;
  }
  assert.ok(checked >= 10, `only ${checked} links checked`);
});

test('Clash list (the sample of formats.test.js): every server read back from disk counts as unchanged', () => {
  const { parseContent } = require('../src/core/subscription');
  const src = fs.readFileSync(path.join(__dirname, 'formats.test.js'), 'utf8');
  const clash = src.slice(src.indexOf('const CLASH = `') + 15, src.indexOf('\n`;', src.indexOf('const CLASH = `'))).replaceAll('${UUID}', UUID);
  const first = parseContent(clash, { subId: 'sub1' }).servers;
  const again = parseContent(clash, { subId: 'sub1' }).servers;
  assert.ok(first.length >= 2, `only ${first.length} servers in the sample`);
  first.forEach((s, i) => assert.ok(sameConnection(stored(s), again[i]), `changed after a round trip: ${s.remark}`));
});

test('a new name only: unchanged; a new SNI, Reality key or flow: changed (old results dropped)', () => {
  const before = stored(parseLink(reality('www.microsoft.com')));
  assert.ok(sameConnection(before, parseLink(reality('www.microsoft.com', PBK, 'renamed'))), 'renaming must keep the results');
  for (const [what, link] of [
    ['SNI', reality('www.apple.com')],
    ['Reality key', reality('www.microsoft.com', 'aaaaJ2IelR9ch3k8VtlVhhs5ycBUlXA7wHBWcBLJ8XzQ')],
    ['flow', reality('www.microsoft.com').replace('flow=xtls-rprx-vision', 'flow=')],
  ]) {
    const after = parseLink(link);
    assert.equal(serverKey(after), serverKey(before), `${what}: still the same server (keeps its place and selection)`);
    assert.ok(!sameConnection(before, after), `${what} changed but the old results would stay`);
  }
});
