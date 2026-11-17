'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseContent } = require('../src/core/subscription');
const { withOwnInbounds, xrayTestConfig } = require('../src/core/custom');
const { b64encode } = require('../src/core/util');

const UUID = '0b6d8a1c-1111-4c2d-9e3f-123456789abc';

const CLASH = `
port: 7890
proxies:
  - name: "DE 🇩🇪"
    type: vless
    server: de.example.com
    port: 443
    uuid: ${UUID}
    network: ws
    tls: true
    servername: de.example.com
    client-fingerprint: chrome
    ws-opts:
      path: /ws
      headers:
        Host: cdn.example.com
  - name: reality
    type: vless
    server: r.example.com
    port: 443
    uuid: ${UUID}
    flow: xtls-rprx-vision
    network: tcp
    tls: true
    servername: www.microsoft.com
    reality-opts:
      public-key: Z84J2IelR9ch3k8VtlVhhs5ycBUlXA7wHBWcBrjqnAw
      short-id: ab12
  - { name: tr, type: trojan, server: t.example.com, port: 443, password: pw, sni: t.example.com, network: grpc, grpc-opts: { grpc-service-name: svc } }
  - { name: ss-obfs, type: ss, server: s.example.com, port: 8388, cipher: aes-256-gcm, password: pw, plugin: obfs, plugin-opts: { mode: http, host: bing.com } }
  - { name: hy2, type: hysteria2, server: h.example.com, port: 443, password: pw, sni: h.example.com, obfs: salamander, obfs-password: x, ports: "20000-30000" }
  - { name: tuic, type: tuic, server: u.example.com, port: 443, uuid: ${UUID}, password: pw, congestion-controller: bbr, alpn: [h3] }
  - { name: vm, type: vmess, server: v.example.com, port: 443, uuid: ${UUID}, alterId: 0, cipher: auto, tls: true, network: h2, h2-opts: { host: [v.example.com], path: /h2 } }
  - { name: awg, type: wireguard, server: w.example.com, port: 51820, private-key: a, public-key: b, ip: 10.0.0.2, amnezia-wg-option: { jc: 4 } }
  - { name: weird, type: snell, server: x.example.com, port: 1 }
proxy-groups: []
`;

test('Clash / Mihomo YAML subscription', () => {
  const r = parseContent(CLASH, { subId: 'sub1' });
  assert.equal(r.servers.length, 7);
  assert.equal(r.errors.length, 2); // AmneziaWG + unknown type
  const de = r.servers[0];
  assert.equal(de.protocol, 'vless');
  assert.equal(de.network, 'ws');
  assert.equal(de.host, 'cdn.example.com');
  assert.equal(de.tls, 'tls');
  assert.equal(de.subId, 'sub1');
  assert.equal(r.servers[1].tls, 'reality');
  assert.equal(r.servers[1].flow, 'xtls-rprx-vision');
  assert.equal(r.servers[2].serviceName, 'svc');
  assert.equal(r.servers[3].plugin, 'obfs-local');
  assert.equal(r.servers[4].hopPorts, '20000-30000');
  assert.equal(r.servers[6].network, 'h2');
});

test('Clash YAML wrapped in base64', () => {
  const r = parseContent(b64encode(CLASH));
  assert.equal(r.servers.length, 7);
});

const XRAY_CFG = (remarks, port) => ({
  remarks,
  inbounds: [
    { tag: 'socks', protocol: 'socks', listen: '127.0.0.1', port: 10808, settings: { udp: true } },
    { tag: 'http', protocol: 'http', listen: '127.0.0.1', port: 10809 },
    { tag: 'api', protocol: 'dokodemo-door', port: 62789 },
  ],
  outbounds: [
    { tag: 'proxy', protocol: 'vless', settings: { vnext: [{ address: 'j.example.com', port, users: [{ id: UUID, encryption: 'none' }] }] }, streamSettings: { network: 'tcp', security: 'tls' } },
    { tag: 'direct', protocol: 'freedom' },
  ],
  routing: { rules: [] },
});

test('JSON subscription: array of full Xray configs', () => {
  const r = parseContent(JSON.stringify([XRAY_CFG('A 🇩🇪', 443), XRAY_CFG('B', 8443)]), { subId: 'j' });
  assert.equal(r.servers.length, 2);
  const a = r.servers[0];
  assert.equal(a.protocol, 'custom');
  assert.equal(a.core, 'xray');
  assert.equal(a.remark, 'A 🇩🇪');
  assert.equal(a.managedInbounds, true);
  assert.equal(a.address, 'j.example.com');
  assert.equal(a.port, 443);
  assert.equal(a.subId, 'j');
});

test('JSON configs run on Best ports; extra inbounds (and TUN) are dropped', () => {
  const settings = { socksPort: 20808, httpPort: 20809, allowLan: false };
  const cfg = withOwnInbounds({ ...XRAY_CFG('x', 443), inbounds: [...XRAY_CFG('x', 443).inbounds, { protocol: 'tun', tag: 'tun' }] }, 'xray', settings);
  assert.deepEqual(cfg.inbounds.map((i) => [i.protocol, i.listen, i.port]), [['socks', '127.0.0.1', 20808], ['http', '127.0.0.1', 20809]]);
  const sb = withOwnInbounds({ inbounds: [{ type: 'tun' }, { type: 'mixed', listen_port: 2080 }], outbounds: [{ type: 'direct' }] }, 'sing-box', settings);
  assert.deepEqual(sb.inbounds.map((i) => [i.type, i.listen, i.listen_port]), [['socks', '127.0.0.1', 20808], ['http', '127.0.0.1', 20809]]);
  const t = xrayTestConfig(XRAY_CFG('x', 443), 40000);
  assert.deepEqual(t.inbounds.map((i) => i.port), [40000]);
});
