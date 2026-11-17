'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseLink, normalizeServer } = require('../src/core/links');
const { pickCore, buildComposite, normalizeGroup } = require('../src/core/group');
const { needsSingBox } = require('../src/core/xray-config');
const { singBoxOutbound } = require('../src/core/singbox-config');
const { parseHosts } = require('../src/core/dns');
const { ruleLines, mihomoProxy, buildMihomoConfig } = require('../src/core/mihomo-config');
const { applyBinding } = require('../src/core/bind');
const { DEFAULT_SETTINGS, sanitizeSettings } = require('../src/core/settings');
const { sanitizeRouting, effectiveRouting } = require('../src/core/routing');

const U = 'b831381d-6324-4d53-ad4f-8cda48b30811';
const vless = parseLink(`vless://${U}@1.1.1.1:443?security=tls&sni=a.com&type=ws#a`);
const plain = parseLink('trojan://pw@2.2.2.2:80?security=none#plain');
const hy2 = parseLink('hysteria2://pw@5.5.5.5:443?sni=h.com#h');
const xhttp = parseLink(`vless://${U}@7.7.7.7:443?security=tls&sni=x.com&type=xhttp#x`);
const naive = parseLink('naive+https://u:p@8.8.4.4:443#n');
const settings = { ...DEFAULT_SETTINGS, socksPort: 20808, httpPort: 20809 };
const routing = effectiveRouting(sanitizeRouting({}));
const canSingBox = (s) => { try { singBoxOutbound(s); return true; } catch { return false; } };

test('groups: normalised, core chosen, mixed cores refused', () => {
  const g = normalizeServer({ protocol: 'group', remark: 'G', members: ['abcdef12', 'nope!'], strategy: 'weird' });
  assert.deepStrictEqual([g.protocol, g.members, g.strategy], ['group', ['abcdef12'], 'leastPing']);
  assert.strictEqual(normalizeGroup({}).remark, 'Group');
  assert.strictEqual(pickCore([vless, plain], { needsSingBox, canSingBox }), 'xray');
  assert.strictEqual(pickCore([hy2, vless], { needsSingBox, canSingBox }), 'sing-box');
  assert.throws(() => pickCore([xhttp, naive], { needsSingBox, canSingBox }), /GROUP_MIXED_CORES/);
});

test('group config: balancer, observatory and forwarders', () => {
  const c = buildComposite({ core: 'xray', members: [vless, plain], strategy: 'leastPing' }, settings, routing, { loopPorts: [0, 31000] });
  assert.deepStrictEqual(c.routing.balancers[0].selector, ['m-0', 'm-1']);
  assert.ok(c.observatory && c.observatory.subjectSelector.length === 2);
  assert.ok(c.inbounds.some((i) => i.tag === 'loop-in-1' && i.port === 31000));
  assert.ok(!c.outbounds.some((o) => o.tag === 'proxy'));
  assert.strictEqual(c.routing.rules.at(-1).balancerTag, 'proxy');
});

test('chain: main dials through the front server', () => {
  const x = buildComposite({ core: 'xray', main: vless, front: hy2 }, settings, routing, {});
  assert.strictEqual(x.outbounds.find((o) => o.tag === 'proxy').streamSettings.sockopt.dialerProxy, 'f-0');
  const s = buildComposite({ core: 'sing-box', main: hy2, front: vless }, settings, routing, {});
  assert.strictEqual(s.outbounds.find((o) => o.tag === 'proxy').detour, 'f-0');
});

test('hosts parsing', () => {
  assert.deepStrictEqual(parseHosts('1.2.3.4 a.com b.com\nexample.org 5.6.7.8 # c\n127.0.0.1 localhost\nbad', { skipLocal: true }), { 'a.com': ['1.2.3.4'], 'b.com': ['1.2.3.4'], 'example.org': ['5.6.7.8'] });
});

test('mihomo: proxies and rules', () => {
  assert.strictEqual(mihomoProxy(vless).network, 'ws');
  assert.strictEqual(mihomoProxy(hy2).type, 'hysteria2');
  assert.deepStrictEqual(ruleLines({ outbound: 'direct', domain: ['geosite:cn'], ip: ['10.0.0.0/8'], port: [], process: [] }), ['AND,((GEOSITE,cn),(IP-CIDR,10.0.0.0/8)),DIRECT']);
  const cfg = buildMihomoConfig(vless, settings, { ...routing, mode: 'bypass-local', country: 'de' }, { controller: { port: 1, secret: 's' } });
  assert.strictEqual(cfg['bind-address'], '127.0.0.1');
  assert.ok(cfg.rules.includes('GEOIP,de,DIRECT') && cfg.rules.at(-1) === 'MATCH,proxy');
});

test('send-through skips loopback forwarders', () => {
  const cfg = { outbounds: [{ tag: 'proxy', protocol: 'vless', settings: { vnext: [{ address: '127.0.0.1' }] } }, { tag: 'direct', protocol: 'freedom' }] };
  applyBinding(cfg, 'xray', { sendThrough: '192.168.1.5' });
  assert.deepStrictEqual(cfg.outbounds.map((o) => o.sendThrough), [undefined, '192.168.1.5']);
});

test('settings: shortcuts, core choice and LAN ports are validated', () => {
  const s = sanitizeSettings({ hotkeys: { toggleProxy: 'Control+Alt+B', showWindow: 'evil;cmd', toggleTun: 'Shift+F5' }, coreFor: { vless: 'sing-box', vmess: 'nope' }, lanSocksPort: 20808, socksPort: 20808 });
  assert.deepStrictEqual([s.hotkeys.showWindow, s.hotkeys.toggleTun], ['', 'Shift+F5']);
  assert.deepStrictEqual(s.coreFor, { vless: 'sing-box' });
  assert.notStrictEqual(s.lanSocksPort, s.socksPort); // clashing ports fall back to the defaults
});

test('TUN: server names use the normal DNS (no deadlock), core processes incl. mihomo go direct, IPv6 off by default', () => {
  const { buildTunConfig } = require('../src/core/singbox-config');
  const c = buildTunConfig({ ...settings, tunServerDomains: ['srv.example.com'], hostsMap: { 'a.com': ['1.2.3.4'] }, tunFakeIp: true });
  const rules = c.dns.rules;
  assert.strictEqual(rules[0].server, 'hosts'); // the user's hosts still win
  assert.deepStrictEqual(rules[1], { domain: ['srv.example.com'], server: 'local' });
  assert.strictEqual(rules.at(-1).server, 'fakeip'); // after the server names
  assert.ok(c.route.rules[0].process_name.includes('mihomo.exe'));
  assert.strictEqual(DEFAULT_SETTINGS.tunIpv6, false);
  assert.ok(c.route.rules.some((r) => r.ip_version === 6 && r.action === 'reject'));
});

test('Store apps: package names are quoted for PowerShell and every step is checked', () => {
  const { exemptScript } = require('../electron/loopback');
  assert.strictEqual(exemptScript([], []), null);
  assert.strictEqual(exemptScript(["bad'; calc"], []), null);
  const one = exemptScript(['Microsoft.WindowsCalculator_8wekyb3d8bbwe'], []);
  assert.strictEqual(one.length, 3); // a single app must still run
  assert.match(one[1], /-a '-n=Microsoft\.WindowsCalculator_8wekyb3d8bbwe'/);
  assert.match(one[1], /\$LASTEXITCODE -ne 0/);
});

// Found while testing against a real 3x-ui panel (Xray 26).
test('3x-ui: a bad Shadowsocks 2022 key is caught before any core starts', () => {
  const { checkSs2022Key } = require('../src/core/util');
  const { proxyOutbound } = require('../src/core/xray-config');
  const k16 = 'PMV+Pn6i28gBymkqG5lNdg==', k32 = 'QT0FtW3DxjgT73fFwt8Du1IGWA9cQWva+r3ZfvoWHBA=';
  const ss = (cipher, password) => ({ protocol: 'shadowsocks', address: '1.1.1.1', port: 1, cipher, password });
  assert.doesNotThrow(() => checkSs2022Key(ss('2022-blake3-aes-128-gcm', `${k16}:${k16}`)));
  assert.doesNotThrow(() => checkSs2022Key(ss('2022-blake3-aes-256-gcm', k32)));
  assert.doesNotThrow(() => checkSs2022Key(ss('chacha20-ietf-poly1305', 'anything')));
  assert.throws(() => checkSs2022Key(ss('2022-blake3-aes-128-gcm', `${k16}:${k32}`)), /SS_BAD_KEY/);
  assert.throws(() => proxyOutbound(ss('2022-blake3-aes-256-gcm', k16), DEFAULT_SETTINGS), /SS_BAD_KEY/);
  assert.throws(() => singBoxOutbound(ss('2022-blake3-aes-256-gcm', 'x')), /SS_BAD_KEY/);
  assert.throws(() => mihomoProxy(ss('2022-blake3-aes-256-gcm', 'x')), /SS_BAD_KEY/);
});

test('3x-ui: REALITY of an Xray 26 server runs on Xray only, also for its Trojan links', () => {
  const { parseContent } = require('../src/core/subscription');
  const { toLink } = require('../src/core/links');
  const q = 'security=reality&pbk=jMamUbtCOrl6Hxo3u4XYTUNMIB2T29_R8dptw_msbjA&sni=www.cloudflare.com&fp=chrome';
  const r = parseContent([
    `vless://${U}@srv.example:1?${q}&support-x25519mlkem768=true&type=tcp#a`,
    `trojan://pw@srv.example:2?${q}&type=grpc&serviceName=t#b`,
    `trojan://pw@other.example:3?${q}&type=tcp#c`,
  ].join('\n'));
  assert.deepStrictEqual(r.servers.map((s) => !!s.pqKex), [true, true, false]);
  assert.throws(() => singBoxOutbound(r.servers[1]), /REALITY/);
  assert.throws(() => mihomoProxy(r.servers[1]), /REALITY/);
  assert.doesNotThrow(() => singBoxOutbound(r.servers[2]));
  assert.ok(normalizeServer(r.servers[0]).pqKex);
  assert.match(toLink(r.servers[0]), /support-x25519mlkem768=true/);
});

test('3x-ui: VMess "auto" on sing-box, VLESS Encryption, VMess HTTP header on mihomo', () => {
  const vm = parseLink('vmess://' + Buffer.from(JSON.stringify({ v: '2', add: 'a.com', port: '443', id: U, net: 'tcp', tls: 'tls', sni: 'a.com', scy: 'auto' })).toString('base64'));
  assert.strictEqual(singBoxOutbound(vm).security, 'aes-128-gcm'); // sing-box "auto" fails against Xray over TLS
  const enc = parseLink(`vless://${U}@1.1.1.1:443?encryption=mlkem768x25519plus.native.0rtt.2LJhRxfvyUsaZITgEHrHhDZKyeC47Rv9QSuSjt-a6wo&security=none&type=tcp#e`);
  assert.throws(() => singBoxOutbound(enc), /VLESS Encryption/);
  assert.match(mihomoProxy(enc).encryption, /^mlkem768x25519plus/);
  const hh = parseLink('vmess://' + Buffer.from(JSON.stringify({ v: '2', add: 'a.com', port: '80', id: U, net: 'tcp', type: 'http', host: 'www.bing.com', path: '/' })).toString('base64'));
  const p = mihomoProxy(hh);
  assert.strictEqual(p.network, 'http');
  assert.deepStrictEqual(p['http-opts'].headers.Host, ['www.bing.com']);
});

test('sing-box: server names looked up by Windows are answered at once, the name stays for TLS', () => {
  const { buildSingBoxTestConfig, useServerIps, serverNames, buildTunConfig } = require('../src/core/singbox-config');
  const a = parseLink(`vless://${U}@srv.example:443?security=tls&sni=srv.example&type=ws#a`);
  const wg = parseLink('wireguard://wME9TJvSQIDz8%2FTEQn9NSp%2BhugLAgotUnFbQNbCCNl8%3D@wg.example:51820?publickey=NV3%2FZSY9353D%2FSaxlK5l5gHr5AOSO3DLFmDsYIJWaG0%3D&address=10.0.0.2%2F32#w');
  const c = buildSingBoxTestConfig([a, wg, vless], 40000);
  assert.deepStrictEqual(serverNames(c).sort(), ['srv.example', 'wg.example']);
  useServerIps(c, { 'srv.example': ['203.0.113.7'], 'wg.example': ['203.0.113.8'], 'bad name!': ['1.1.1.1'], 'x.example': ['not an ip; rm'] });
  assert.deepStrictEqual(c.dns.servers.at(-1), { type: 'hosts', tag: 'server-ips', predefined: { 'srv.example': ['203.0.113.7'], 'wg.example': ['203.0.113.8'] } });
  assert.strictEqual(c.dns.final, 'local'); // other names still go to the normal DNS
  assert.strictEqual(c.outbounds[0].server, 'srv.example'); // the name is kept (SNI / Host)
  assert.strictEqual(c.outbounds[0].domain_resolver, 'server-ips');
  assert.strictEqual(c.endpoints[0].peers[0].address, '203.0.113.8'); // WireGuard: the address itself
  assert.strictEqual(c.outbounds[1].domain_resolver, undefined); // 1.1.1.1: already an address
  // The user's own hosts entry for a server wins.
  const t = buildTunConfig({ ...DEFAULT_SETTINGS, hostsMap: { 'srv.example': ['10.9.9.9'] }, tunServerDomains: ['srv.example'] });
  useServerIps(t, { 'srv.example': ['203.0.113.7'] });
  assert.ok(!t.dns.servers.some((s) => s.tag === 'server-ips'));
  // Nothing found: config unchanged.
  const before = JSON.stringify(buildSingBoxTestConfig([a], 40000));
  assert.strictEqual(JSON.stringify(useServerIps(JSON.parse(before), {})), before);
});
