'use strict';
// Fuzz: thousands of broken / hostile share links and subscription bodies. Each one must either be
// refused with a normal Error or give a server whose configs are valid for every core. Nothing may
// crash, hang, pollute prototypes or open a local port beyond 127.0.0.1.
const test = require('node:test');
const assert = require('node:assert');
const { parseLink, normalizeServer, toLink } = require('../src/core/links');
const { parseContent } = require('../src/core/subscription');
const { buildXrayConfig, buildXrayTestConfig } = require('../src/core/xray-config');
const { buildSingBoxTestConfig, singBoxOutbound, wireguardEndpoint } = require('../src/core/singbox-config');
const { buildMihomoTestConfig, mihomoProxy } = require('../src/core/mihomo-config');
const { DEFAULT_SETTINGS, DEFAULT_ROUTING } = require('../src/core/settings');

// Small seeded PRNG so a failure can be replayed.
const SEED = Number(process.env.FUZZ_SEED || 20261117);
let st = SEED >>> 0;
const rnd = () => { st ^= st << 13; st ^= st >>> 17; st ^= st << 5; return (st >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (n) => Math.floor(rnd() * n);

const U = 'b831381d-6324-4d53-ad4f-8cda48b30811';
const b64 = (s) => Buffer.from(s).toString('base64');
const SEEDS = [
  `vless://${U}@a.example:443?security=reality&pbk=jMamUbtCOrl6Hxo3u4XYTUNMIB2T29_R8dptw_msbjA&sid=ab12&sni=www.cloudflare.com&fp=chrome&flow=xtls-rprx-vision&type=tcp&support-x25519mlkem768=true#r`,
  `vless://${U}@a.example:443?security=tls&sni=a.example&type=ws&path=%2Fws&host=a.example#w`,
  `vless://${U}@a.example:443?security=tls&type=xhttp&path=%2Fx&mode=auto&extra=%7B%22xPaddingBytes%22%3A%22100-200%22%7D#x`,
  `vless://${U}@1.2.3.4:80?encryption=mlkem768x25519plus.native.0rtt.2LJhRxfvyUsaZITgEHrHhDZKyeC47Rv9QSuSjt-a6wo&type=tcp#e`,
  `vless://${U}@a.example:443?security=tls&type=grpc&serviceName=g&authority=a#g`,
  'vmess://' + b64(JSON.stringify({ v: '2', ps: 'm', add: 'a.example', port: '443', id: U, net: 'ws', tls: 'tls', path: '/v', host: 'a.example', scy: 'auto' })),
  'vmess://' + b64(JSON.stringify({ v: '2', add: '1.2.3.4', port: 80, id: U, net: 'tcp', type: 'http', host: 'b.com', path: '/' })),
  'vmess://' + b64(JSON.stringify({ v: '2', add: '1.2.3.4', port: 80, id: U, net: 'kcp', type: 'none', path: 'seed' })),
  'trojan://pass@a.example:443?security=tls&sni=a.example&type=grpc&serviceName=t#t',
  'ss://' + b64('chacha20-ietf-poly1305:pw') + '@1.2.3.4:8388#s',
  'ss://2022-blake3-aes-128-gcm:PMV%2BPn6i28gBymkqG5lNdg%3D%3D@1.2.3.4:8388#s22',
  'ss://' + b64('aes-256-gcm:pw') + '@1.2.3.4:8388/?plugin=obfs-local%3Bobfs%3Dhttp%3Bobfs-host%3Db.com#p',
  'hysteria2://auth@a.example:443?sni=a.example&obfs=salamander&obfs-password=x&mport=1000-2000#h',
  'hy2://auth@a.example:443/?insecure=1#h2',
  `tuic://${U}:pw@a.example:443?congestion_control=bbr&alpn=h3&sni=a.example#tu`,
  'wireguard://wME9TJvSQIDz8%2FTEQn9NSp%2BhugLAgotUnFbQNbCCNl8%3D@1.2.3.4:51820?publickey=NV3%2FZSY9353D%2FSaxlK5l5gHr5AOSO3DLFmDsYIJWaG0%3D&address=10.0.0.2%2F32&mtu=1420#wg',
  'socks://' + b64('u:p') + '@1.2.3.4:1080#so',
  'anytls://pw@a.example:443/?sni=a.example#a',
  'naive+https://u:p@a.example:443#n',
];
const NASTY = ['%', '%zz', '%00', '\u0000', '\n', '\r\n', '#', '?', '&', '=', '@', ':', '/', '\\', '"', "'", '<script>', '${x}', '../../', '__proto__', 'constructor', '‮', '\ud800', '😀', 'ي', ' ', '\t',
  '99999999', '-1', '0', '65536', 'NaN', 'Infinity', 'true', 'null', '[]', '{}', '{"__proto__":{"x":1}}', 'A'.repeat(5000), '%41'.repeat(3000)];
const KEYS = ['security', 'type', 'path', 'host', 'sni', 'alpn', 'fp', 'pbk', 'sid', 'spx', 'flow', 'encryption', 'serviceName', 'mode', 'extra', 'fm', 'mport', 'obfs', 'obfs-password', 'plugin', 'publickey', 'address', 'reserved', 'mtu', 'allowInsecure', 'ech', 'pcs', '__proto__', 'constructor'];

function mutate(s) {
  const n = 1 + int(4);
  for (let i = 0; i < n; i++) {
    const at = int(s.length + 1);
    switch (int(7)) {
      case 0: s = s.slice(0, at) + pick(NASTY) + s.slice(at); break; // insert
      case 1: s = s.slice(0, at) + s.slice(at + 1 + int(8)); break; // delete
      case 2: s = s.slice(0, at); break; // truncate
      case 3: { const v = pick(NASTY); let e; try { e = encodeURIComponent(v); } catch { e = v; } s += `${s.includes('?') ? '&' : '?'}${pick(KEYS)}=${e}`; break; } // extra param
      case 4: s = s.replace(/:\d+/, `:${pick(['0', '65536', '-5', '1e9', '', 'abc', '443443'])}`); break; // port
      case 5: s = s.replace(/@[^:/?#]+/, `@${pick(['', '[::1]', '127.0.0.1', 'localhost', 'a'.repeat(300), '1.2.3', '-bad-', 'xn--bcher-kva.example', '[zz::1'])}`); break; // host
      default: { const c = s.split(''); for (let k = 0; k < 3; k++) c[int(c.length)] = String.fromCharCode(32 + int(95)); s = c.join(''); } // flip chars
    }
  }
  return s;
}

const LOCAL = /^(127\.0\.0\.1|::1|localhost)$/;
function checkConfigs(s) {
  // Xray full config (proxy + routing) and per-core test configs.
  const json = (o) => JSON.parse(JSON.stringify(o));
  const tryBuild = (fn) => { try { return fn(); } catch (e) { assert.ok(e instanceof Error, 'threw a non-Error'); return null; } };
  const x = tryBuild(() => json(buildXrayConfig(s, DEFAULT_SETTINGS, DEFAULT_ROUTING)));
  if (x) for (const ib of x.inbounds || []) assert.ok(!ib.listen || LOCAL.test(ib.listen) || ib.listen === '0.0.0.0' && DEFAULT_SETTINGS.allowLan, `xray inbound on ${ib.listen}`);
  const xt = tryBuild(() => json(buildXrayTestConfig([s], DEFAULT_SETTINGS, 40000)));
  if (xt) for (const ib of xt.inbounds) assert.match(ib.listen, LOCAL);
  const sb = tryBuild(() => json(buildSingBoxTestConfig([s], 40000)));
  if (sb) for (const ib of sb.inbounds) assert.match(ib.listen, LOCAL);
  const mh = tryBuild(() => json(buildMihomoTestConfig([s], 40000)));
  if (mh) for (const l of mh.listeners) assert.match(l.listen, LOCAL);
  tryBuild(() => (s.protocol === 'wireguard' ? wireguardEndpoint(s, 'x') : singBoxOutbound(s, 'x')));
  tryBuild(() => mihomoProxy(s, 'x'));
}

test(`fuzz: hostile share links never crash, hang or open ports (seed ${SEED})`, () => {
  const ROUNDS = Number(process.env.FUZZ_ROUNDS || 6000);
  let accepted = 0; let slowest = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const input = mutate(pick(SEEDS));
    const t0 = performance.now();
    let s = null;
    try { s = parseLink(input); } catch (e) { assert.ok(e instanceof Error, `non-Error thrown for ${JSON.stringify(input.slice(0, 120))}`); }
    if (s) {
      accepted++;
      assert.strictEqual(typeof s.protocol, 'string');
      assert.ok(Number.isInteger(s.port) && s.port >= 1 && s.port <= 65535, `bad port ${s.port} from ${JSON.stringify(input.slice(0, 120))}`);
      assert.ok(typeof s.address === 'string' && s.address.length > 0 && s.address.length <= 253 + 2, `bad address from ${JSON.stringify(input.slice(0, 120))}`);
      let n;
      try { n = normalizeServer(s); } catch (e) { assert.ok(e instanceof Error); }
      if (n) {
        // A share link made by Best must read back as the same server.
        let again;
        try { again = parseLink(toLink(n)); } catch (e) { assert.fail(`toLink → parseLink failed (${e.message}) for ${JSON.stringify(input.slice(0, 700))}`); }
        assert.strictEqual(again.protocol, n.protocol); assert.strictEqual(again.address, n.address); assert.strictEqual(again.port, n.port);
        checkConfigs(n);
      }
    }
    slowest = Math.max(slowest, performance.now() - t0);
  }
  assert.strictEqual(({}).x, undefined, 'Object.prototype was polluted');
  assert.strictEqual(({}).polluted, undefined, 'Object.prototype was polluted');
  assert.ok(accepted > ROUNDS * 0.05, `only ${accepted} of ${ROUNDS} inputs were accepted: the mutations are too destructive to test anything`);
  assert.ok(slowest < 250, `one link took ${Math.round(slowest)} ms`);
});

test('fuzz: hostile subscription bodies (base64, YAML, JSON, junk) never crash', () => {
  const bodies = [];
  for (let i = 0; i < 300; i++) {
    const lines = Array.from({ length: 1 + int(30) }, () => (rnd() < 0.7 ? mutate(pick(SEEDS)) : pick(NASTY)));
    const text = lines.join(pick(['\n', '\r\n', ' ', '\n\n']));
    bodies.push(rnd() < 0.5 ? text : b64(text));
  }
  bodies.push('proxies:\n  - {name: a, type: vless, server: 1.2.3.4, port: 443, uuid: x}\n  - !!js/function "function(){}"\n', '[{"outbounds":[{"protocol":"freedom"}],"__proto__":{"polluted":1}}]',
    '{"outbounds":' + '['.repeat(5000) + ']'.repeat(5000) + '}', 'A'.repeat(2_000_000), b64('vless://' + 'x'.repeat(100000)));
  for (const body of bodies) {
    const t0 = performance.now();
    try { const r = parseContent(body); assert.ok(Array.isArray(r.servers)); } catch (e) { assert.ok(e instanceof Error, 'non-Error thrown'); }
    assert.ok(performance.now() - t0 < 3000, 'a subscription body took over 3 s');
  }
  assert.strictEqual(({}).polluted, undefined, 'Object.prototype was polluted');
});

test('addresses: strict IPv6, no stray brackets or colons, no broken emoji halves', () => {
  const { parseHost, cleanText } = require('../src/core/util');
  for (const ok of ['::1', '[::1]', '2001:db8::1', 'fe80::1%eth0', '::ffff:1.2.3.4', '2001:0db8:0000:0000:0000:ff00:0042:8329', '::', '1.2.3.4', 'a.example', 'xn--bcher-kva.example']) assert.doesNotThrow(() => parseHost(ok), ok);
  for (const bad of ['::1]', 'aaa:aaa', '1:2:3:4:5:6:7:8:9', '1::2::3', '12345::1', '::ffff:1.2.3.256', 'a.b:c', 'g::1', ':::', '[a.example', 'a]b']) assert.throws(() => parseHost(bad), /invalid address/, bad);
  assert.strictEqual(cleanText('ab\ud800cd'), 'ab�cd');
  assert.doesNotThrow(() => encodeURIComponent(cleanText('😀😀😀', 5))); // slicing through an emoji
});
