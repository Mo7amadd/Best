'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLink, toLink, normalizeServer, transportLabel } = require('../src/core/links');
const { parseContent, parseUserInfo, splitInfoNodes } = require('../src/core/subscription');
const { b64encode } = require('../src/core/util');

const UUID = '0b6d8a1c-1111-4c2d-9e3f-123456789abc';

test('vless reality + vision', () => {
  const s = parseLink(`vless://${UUID}@example.com:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.microsoft.com&fp=chrome&pbk=abcDEF123_-&sid=6ba85179&type=tcp#My%20Server%20%F0%9F%87%A9%F0%9F%87%AA`);
  assert.equal(s.protocol, 'vless');
  assert.equal(s.address, 'example.com');
  assert.equal(s.port, 443);
  assert.equal(s.flow, 'xtls-rprx-vision');
  assert.equal(s.tls, 'reality');
  assert.equal(s.publicKey, 'abcDEF123_-');
  assert.equal(s.network, 'raw');
  assert.equal(s.remark, 'My Server 🇩🇪');
  assert.equal(transportLabel(s), 'TCP + REALITY');
});

test('vless ws tls round trip', () => {
  const link = `vless://${UUID}@1.2.3.4:8443?type=ws&security=tls&host=cdn.example.org&path=%2Fws%3Fed%3D2048&sni=cdn.example.org&alpn=h2,http/1.1#DE`;
  const s = parseLink(link);
  assert.equal(s.path, '/ws?ed=2048');
  assert.deepEqual(s.alpn, ['h2', 'http/1.1']);
  const again = parseLink(toLink(s));
  assert.equal(again.path, s.path);
  assert.equal(again.host, s.host);
  assert.equal(again.remark, 'DE');
});

test('vmess base64 json', () => {
  const json = { v: '2', ps: 'vm', add: 'vm.example.com', port: '2083', id: UUID, aid: '0', scy: 'auto', net: 'grpc', type: 'gun', host: '', path: 'svc', tls: 'tls', sni: 'vm.example.com' };
  const s = parseLink('vmess://' + b64encode(JSON.stringify(json)));
  assert.equal(s.network, 'grpc');
  assert.equal(s.serviceName, 'svc');
  assert.equal(s.tls, 'tls');
  const back = parseLink(toLink(s));
  assert.equal(back.serviceName, 'svc');
});

test('shadowsocks SIP002 and legacy', () => {
  const a = parseLink('ss://' + b64encode('aes-256-gcm:pass word', true) + '@5.6.7.8:8388#ss1');
  assert.equal(a.cipher, 'aes-256-gcm');
  assert.equal(a.password, 'pass word');
  const b = parseLink('ss://' + b64encode('chacha20-ietf-poly1305:pw@host.example:443') + '#legacy');
  assert.equal(b.address, 'host.example');
  const c = parseLink('ss://2022-blake3-aes-128-gcm:' + encodeURIComponent('abc+/=') + '@[2001:db8::1]:443#v6');
  assert.equal(c.address, '2001:db8::1');
  assert.equal(c.password, 'abc+/=');
  assert.match(toLink(c), /\[2001:db8::1\]:443/);
});

test('trojan defaults to tls', () => {
  const s = parseLink('trojan://secret@t.example.com:443?sni=t.example.com#tr');
  assert.equal(s.tls, 'tls');
  assert.equal(s.password, 'secret');
});

test('hysteria2, tuic, wireguard', () => {
  const h = parseLink('hy2://pw@h.example.com:8443/?sni=h.example.com&obfs=salamander&obfs-password=x&insecure=1#hy');
  assert.equal(h.protocol, 'hysteria2');
  assert.equal(h.obfs, 'salamander');
  assert.equal(h.allowInsecure, true);
  const t = parseLink(`tuic://${UUID}:pw@t.example.com:443?congestion_control=cubic&alpn=h3&sni=t.example.com#tu`);
  assert.equal(t.congestion, 'cubic');
  const w = parseLink('wireguard://' + encodeURIComponent('cHJpdmF0ZWtleQ==') + '@162.159.192.1:2408/?publickey=cHVibGlja2V5&address=172.16.0.2/32,2606:4700::2/128&reserved=1,2,3&mtu=1280#wg');
  assert.deepEqual(w.reserved, [1, 2, 3]);
  assert.deepEqual(w.localAddress, ['172.16.0.2/32', '2606:4700::2/128']);
});

test('rejects malicious or broken input', () => {
  assert.throws(() => parseLink('vless://id@exa mple.com:443#x'));
  assert.throws(() => parseLink('vless://id@example.com:99999#x'));
  assert.throws(() => parseLink('vless://id@example.com:443?security=reality#no-key'));
  assert.throws(() => parseLink('javascript://alert(1)'));
  assert.throws(() => parseLink('vless://id@ex"ample.com:443'));
  assert.throws(() => normalizeServer({ protocol: 'vless', address: 'a.com', port: 1 }));
  const s = parseLink(`vless://${UUID}@example.com:443#%E2%80%AEevil%00name`);
  assert.equal(s.remark, 'evilname');
});

test('subscription content: base64 body, info nodes, bad lines', () => {
  const lines = [
    `vless://${UUID}@a.example.com:443?security=tls#A`,
    'trojan://pw@127.0.0.1:1080#Traffic: 10GB',
    'not a link',
    'vless://broken',
  ].join('\n');
  const r = parseContent(b64encode(lines), { subId: 'sub1' });
  assert.equal(r.servers.length, 2);
  assert.equal(r.errors.length, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.servers[0].subId, 'sub1');
  const split = splitInfoNodes(r.servers);
  assert.equal(split.servers.length, 1);
  assert.deepEqual(split.info, ['Traffic: 10GB']);
});

test('subscription-userinfo header', () => {
  assert.deepEqual(parseUserInfo('upload=10; download=20; total=1000; expire=1700000000'), { upload: 10, download: 20, total: 1000, expire: 1700000000 });
  assert.deepEqual(parseUserInfo('total=-5; foo=1'), {});
});

test('3x-ui link parameters: fm, ech, pcs, vcn, cs, pqv, authority, kcp mtu/tti, xhttp extra', () => {
  const fm = JSON.stringify({ tcp: [{ type: 'fragment', settings: { packets: 'tlshello', length: '100-200' } }] });
  const s = parseLink(`vless://${UUID}@a.example.com:443?type=grpc&serviceName=svc&authority=cdn.example.com&security=tls&sni=a.example.com&ech=AEX%2BDQ&pcs=${'b'.repeat(64)}&vcn=a.example.com&cs=TLS_AES_128_GCM_SHA256&fm=${encodeURIComponent(fm)}#x`);
  assert.equal(s.authority, 'cdn.example.com');
  assert.equal(s.ech, 'AEX+DQ');
  assert.equal(s.pcs, 'b'.repeat(64));
  assert.equal(s.vcn, 'a.example.com');
  assert.equal(s.cipherSuites, 'TLS_AES_128_GCM_SHA256');
  assert.deepEqual(JSON.parse(s.finalmask), JSON.parse(fm));
  const back = parseLink(toLink(s));
  assert.equal(back.pcs, s.pcs);
  assert.equal(back.finalmask, s.finalmask);
  const r = parseLink(`vless://${UUID}@r.example.com:443?type=tcp&security=reality&pbk=abc&sid=1&pqv=QUJD#r`);
  assert.equal(r.pqv, 'QUJD');
  const k = parseLink(`vless://${UUID}@k.example.com:443?type=kcp&security=tls&mtu=1350&tti=20#k`);
  assert.equal(k.mtu, 1350);
  assert.equal(k.tti, 20);
  const x = parseLink(`vless://${UUID}@x.example.com:443?type=xhttp&security=tls&x_padding_bytes=100-1000#x`);
  assert.equal(JSON.parse(x.extra).xPaddingBytes, '100-1000');
});

test('rejects malformed new parameters instead of passing them to the core', () => {
  const s = parseLink(`vless://${UUID}@a.example.com:443?security=tls&pcs=${encodeURIComponent('"};evil')}&fm=notjson&cs=${encodeURIComponent('a b')}#x`);
  assert.equal(s.pcs, undefined);
  assert.equal(s.finalmask, undefined);
  assert.equal(s.cipherSuites, undefined);
});

test('hysteria2 gecko obfs, pin and port hopping', () => {
  const s = parseLink(`hysteria2://pw@h.example.com:443/?sni=h.example.com&obfs=gecko&obfs-password=x&minPacketSize=100&maxPacketSize=1200&pinSHA256=${'c'.repeat(64)}&mport=20000-30000,443#h`);
  assert.equal(s.obfs, 'gecko');
  assert.equal(s.packetSize, '100-1200');
  assert.equal(s.hopPorts, '20000-30000,443');
  assert.equal(s.pcs, 'c'.repeat(64));
  const back = parseLink(toLink(s));
  assert.equal(back.packetSize, '100-1200');
  assert.equal(back.hopPorts, '20000-30000,443');
});

test('vmess JSON with 3x-ui extras', () => {
  const json = { v: '2', ps: 'vm', add: 'v.example.com', port: '443', id: UUID, net: 'xhttp', mode: 'auto', path: '/x', tls: 'tls', sni: 'v.example.com', ech: 'QUJD', pcs: 'd'.repeat(64), xPaddingBytes: '100-1000', xmux: { maxConcurrency: '16-32' } };
  const s = parseLink('vmess://' + b64encode(JSON.stringify(json)));
  assert.equal(s.ech, 'QUJD');
  assert.deepEqual(JSON.parse(s.extra), { xPaddingBytes: '100-1000', xmux: { maxConcurrency: '16-32' } });
});
