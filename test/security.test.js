'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { withOwnInbounds, xrayTestConfig } = require('../src/core/custom');
const { profileFromPanelRouting } = require('../src/core/routing');
const { buildTunConfig } = require('../src/core/singbox-config');
const { DEFAULT_SETTINGS } = require('../src/core/settings');

const settings = { ...DEFAULT_SETTINGS, socksPort: 20808, httpPort: 20809 };

test('JSON subscription: dangerous Xray sections are dropped', () => {
  const evil = {
    log: { loglevel: 'debug', access: 'C:/Users/x/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/a.bat' },
    api: { tag: 'api', listen: '0.0.0.0:10085', services: ['HandlerService'] },
    metrics: { listen: '0.0.0.0:11111' },
    stats: {},
    reverse: { bridges: [{ tag: 'bridge', domain: 'r.example' }] },
    inbounds: [{ tag: 'dok', protocol: 'dokodemo-door', listen: '0.0.0.0', port: 5555 }, { tag: 'socks', protocol: 'socks', port: 1080, settings: { accounts: [{ user: 'a', pass: 'b' }] } }],
    outbounds: [{ tag: 'proxy', protocol: 'vless' }, { tag: 'direct', protocol: 'freedom' }],
    routing: { rules: [{ inboundTag: ['bridge'], outboundTag: 'direct' }, { inboundTag: ['dok'], outboundTag: 'direct' }, { inboundTag: ['socks'], outboundTag: 'proxy' }, { domain: ['geosite:cn'], outboundTag: 'direct' }] },
  };
  const c = withOwnInbounds(evil, 'xray', settings);
  for (const k of ['api', 'metrics', 'stats', 'reverse']) assert.strictEqual(c[k], undefined, k);
  assert.deepStrictEqual(c.log, { loglevel: 'debug' });
  assert.deepStrictEqual(c.inbounds.map((i) => [i.protocol, i.listen, i.port]), [['socks', '127.0.0.1', 20808], ['http', '127.0.0.1', 20809]]);
  assert.strictEqual(c.inbounds[0].settings.accounts, undefined);
  assert.deepStrictEqual(c.routing.rules.map((r) => r.outboundTag), ['proxy', 'direct']);
  const t = xrayTestConfig(evil, 30000);
  assert.strictEqual(t.reverse, undefined);
  assert.strictEqual(t.inbounds.length, 1);
});

test('JSON subscription: dangerous sing-box sections are dropped', () => {
  const evil = {
    log: { level: 'debug', output: 'C:/evil.txt' },
    experimental: { clash_api: { external_controller: '0.0.0.0:9090', external_ui: 'C:/Startup', external_ui_download_url: 'https://x/ui.zip' } },
    services: [{ type: 'resolved' }],
    endpoints: [{ type: 'wireguard', tag: 'wg', listen_port: 51820 }, { type: 'tailscale', tag: 'ts' }],
    inbounds: [{ type: 'mixed', listen: '0.0.0.0', listen_port: 7890 }, { type: 'socks', tag: 's', users: [{ username: 'u', password: 'p' }] }],
    outbounds: [{ type: 'vless', tag: 'proxy' }],
    route: { rules: [{ inbound: ['s'], outbound: 'proxy' }, { inbound: ['mixed-in'], outbound: 'direct' }], rule_set: [{ type: 'local', tag: 'x', path: 'C:/Windows/win.ini' }, { type: 'remote', tag: 'y', url: 'https://x/y.srs' }] },
  };
  const c = withOwnInbounds(evil, 'sing-box', { ...settings, allowLan: true });
  assert.strictEqual(c.experimental, undefined);
  assert.strictEqual(c.services, undefined);
  assert.deepStrictEqual(c.log, { level: 'debug', timestamp: false });
  assert.deepStrictEqual(c.endpoints, [{ type: 'wireguard', tag: 'wg' }]);
  // Local ports stay on 127.0.0.1 without a password; LAN sharing gets its own ports.
  assert.deepStrictEqual(c.inbounds.map((i) => [i.type, i.listen, i.listen_port]), [['socks', '127.0.0.1', 20808], ['http', '127.0.0.1', 20809], ['socks', '0.0.0.0', 10820], ['http', '0.0.0.0', 10821]]);
  assert.ok(c.route.rules[0].inbound.includes('socks-lan'));
  assert.deepStrictEqual(c.route.rule_set.map((r) => r.tag), ['y']);
  // LAN sharing: names are resolved, then loopback is refused, before anything else; the foreign inbound rule is gone.
  assert.deepStrictEqual(c.route.rules.slice(0, 2).map((r) => r.action), ['resolve', 'reject']);
  assert.ok(!c.route.rules.some((r) => r.inbound && r.inbound.includes('mixed-in')));
});

test('panel routing cannot send everything direct', () => {
  const p = profileFromPanelRouting(JSON.stringify({ DirectIp: ['0.0.0.0/0', '::/0', '0.0.0.0/1', 'geoip:!ir', '10.0.0.0/8'], DirectSites: ['regexp:.*', 'keyword:', 'geosite:category-ir'] }));
  const direct = p.rules.filter((r) => r.outbound === 'direct');
  assert.deepStrictEqual(direct.flatMap((r) => [...r.domain, ...r.ip]), ['geosite:category-ir', '10.0.0.0/8']);
});

test('TUN always captures IPv6 and refuses it when IPv6 is off', () => {
  const off = buildTunConfig({ ...settings, tunIpv6: false });
  assert.ok(off.inbounds[0].address.some((a) => a.includes(':')));
  assert.ok(off.route.rules.some((r) => r.ip_version === 6 && r.action === 'reject'));
  const on = buildTunConfig({ ...settings, tunIpv6: true });
  assert.ok(!on.route.rules.some((r) => r.ip_version === 6));
});

// ---- second security review (2026-11-16): each attack input from the review stays harmless
test('JSON configs: programs, file paths, reverse tunnels and webhooks are removed', () => {
  const { sanitizeConfig, hardenRaw } = require('../src/core/custom');
  const sb = sanitizeConfig({
    outbounds: [{ type: 'tor', tag: 'proxy', executable_path: 'C:/x/evil.exe', extra_args: ['-f'], data_directory: 'C:/x' }, { type: 'ssh', tag: 's', private_key_path: 'C:/k' }, { type: 'vless', tag: 'v', server: 'a.com', server_port: 443, uuid: 'u', tls: { enabled: true, certificate_path: 'C:/secret.pem' } }],
    endpoints: [{ type: 'openconnect', tag: 'oc', csd: { wrapper_path: 'C:/x/a.bat' } }, { type: 'wireguard', tag: 'wg' }],
    dns: { servers: [{ type: 'hosts', tag: 'h', path: ['C:/Windows/System32/drivers/etc/hosts'] }] },
  }, 'sing-box', []);
  assert.deepStrictEqual(sb.outbounds.map((o) => o.type), ['vless']);
  assert.strictEqual(sb.outbounds[0].tls.certificate_path, undefined);
  assert.deepStrictEqual(sb.endpoints.map((e) => e.type), ['wireguard']);
  assert.strictEqual(sb.dns.servers[0].path, undefined);
  const x = sanitizeConfig({
    outbounds: [{ protocol: 'vless', tag: 'proxy', settings: { reverse: { tag: 'r-in' }, vnext: [] }, streamSettings: { tlsSettings: { masterKeyLog: 'C:/k.log' } } }, { protocol: 'loopback', tag: 'l' }, { protocol: 'freedom', tag: 'direct' }],
    routing: { rules: [{ network: 'tcp,udp', outboundTag: 'direct', webhook: { url: 'https://attacker/' } }, { domain: ['ext:../../secret.dat:x', 'full:a.com'], outboundTag: 'direct' }] },
  }, 'xray', []);
  assert.deepStrictEqual(x.outbounds.map((o) => o.protocol), ['vless', 'freedom']);
  assert.strictEqual(x.outbounds[0].settings.reverse, undefined);
  assert.strictEqual(x.outbounds[0].streamSettings.tlsSettings.masterKeyLog, undefined);
  assert.strictEqual(x.routing.rules[0].webhook, undefined);
  assert.deepStrictEqual(x.routing.rules[1].domain, ['full:a.com']);
  // A raw config kept "as written" loses the same parts, plus api / log files / TUN.
  const raw = hardenRaw({ api: { tag: 'api' }, log: { access: 'C:/Windows/x.log', loglevel: 'debug' }, inbounds: [{ protocol: 'socks', port: 1 }, { protocol: 'tun' }], outbounds: [{ protocol: 'freedom', settings: { reverse: {} } }] }, 'xray');
  assert.deepStrictEqual([raw.api, raw.log, raw.inbounds.length, raw.outbounds[0].settings.reverse], [undefined, { loglevel: 'debug' }, 1, undefined]);
  const rawSb = hardenRaw({ experimental: { clash_api: {} }, log: { output: 'C:/x.log' }, inbounds: [{ type: 'tun' }, { type: 'mixed' }] }, 'sing-box');
  assert.deepStrictEqual([rawSb.experimental, rawSb.log.output, rawSb.inbounds.map((i) => i.type)], [undefined, undefined, ['mixed']]);
});

test('LAN sharing: names that point at this computer are caught after resolving', () => {
  const { parseLink } = require('../src/core/links');
  const { sanitizeRouting, effectiveRouting } = require('../src/core/routing');
  const lan = { ...DEFAULT_SETTINGS, allowLan: true, lanUser: 'u', lanPass: 'p' };
  const { buildXrayConfig } = require('../src/core/xray-config');
  const x = buildXrayConfig(parseLink('vless://b831381d-6324-4d53-ad4f-8cda48b30811@1.2.3.4:443?security=tls&sni=a.com#a'), lan, effectiveRouting(sanitizeRouting({})), {});
  assert.deepStrictEqual(x.outbounds.find((o) => o.tag === 'direct').settings.finalRules[0].ip.slice(0, 2), ['127.0.0.0/8', '::1/128']);
  const { buildMihomoConfig } = require('../src/core/mihomo-config');
  const m = buildMihomoConfig(parseLink('vless://b831381d-6324-4d53-ad4f-8cda48b30811@1.2.3.4:443?security=tls&sni=a.com&type=ws#a'), lan, effectiveRouting(sanitizeRouting({})), {});
  assert.ok(m.rules.includes('AND,((IN-NAME,socks-lan),(DOMAIN,localhost)),REJECT'));
  assert.ok(!m.rules.some((r) => r.includes('IN-NAME') && r.includes('no-resolve')));
});

test('panel routing cannot send everything direct; mihomo values cannot inject rules', () => {
  const { profileFromPanelRouting } = require('../src/core/routing');
  const p = profileFromPanelRouting(JSON.stringify({ DirectSites: ['keyword:.', 'regexp:^', 'regexp:[a-z]', 'keyword:ab', 'domain:bank.example', 'geosite:category-ir'], DirectIp: Array.from({ length: 223 }, (_, i) => `${i + 1}.0.0.0/8`) }));
  const direct = p.rules.filter((r) => r.outbound === 'direct');
  assert.deepStrictEqual(direct.find((r) => r.domain && r.domain.length).domain, ['domain:bank.example', 'geosite:category-ir']);
  const ips = (direct.find((r) => r.ip && r.ip.length) || { ip: [] }).ip;
  assert.ok(ips.length <= 16, `too many /8 ranges kept: ${ips.length}`);
  const { ruleLines } = require('../src/core/mihomo-config');
  assert.deepStrictEqual(ruleLines({ outbound: 'proxy', domain: ['regexp:.*,DIRECT'], ip: [], port: [], process: [] }), []);
});

test('subscriptions: addresses of this computer are info lines, never servers', () => {
  const { splitInfoNodes } = require('../src/core/subscription');
  const r = splitInfoNodes(['::ffff:7f00:1', '[::1]', '0.0.0.0', 'x.localhost', '1.1.1.1'].map((address) => ({ address })));
  assert.deepStrictEqual(r.servers.map((s) => s.address), ['1.1.1.1']);
});

test('TUN: Best cores are matched by full path, not by file name', () => {
  const { buildTunConfig } = require('../src/core/singbox-config');
  const W = (...p) => p.join(String.fromCharCode(92)); // Windows path without escape trouble
  const c = buildTunConfig({ ...DEFAULT_SETTINGS, tunCorePaths: [W('C:', 'Program Files', 'Best', 'resources', 'cores', 'xray', 'xray.exe')] });
  const re = new RegExp(c.route.rules[0].process_path_regex[0].replace('(?i)', ''), 'i');
  assert.ok(re.test(W('c:', 'program files', 'best', 'resources', 'cores', 'xray', 'xray.exe')));
  assert.ok(!re.test(W('C:', 'Users', 'x', 'Downloads', 'xray.exe')));
});

test('WebDAV over http only for real local addresses', () => {
  // webdav.js needs Electron's session only when a client is made; the address check is plain.
  const Module = require('module');
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? { session: {} } : orig.call(this, req, ...rest); };
  try {
    const { isPrivateHost } = require('../electron/webdav');
    assert.deepStrictEqual(['192.168.1.5', 'localhost', 'nas.local', '10.0.0.2', '[::1]'].map(isPrivateHost), [true, true, true, true, true]);
    assert.deepStrictEqual(['192.168.evil.com', 'localhost.attacker.com', '10.example.org', '8.8.8.8', 'a.b.local'].map(isPrivateHost), [false, false, false, false, false]);
  } finally { Module._load = orig; }
});
