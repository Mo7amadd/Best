'use strict';
// "My country direct": the direct resolver is really asked directly (Xray), and is the one from Settings (sing-box).
const test = require('node:test');
const assert = require('node:assert');
const { parseLink } = require('../src/core/links');
const { buildXrayConfig } = require('../src/core/xray-config');
const { buildSingBoxConfig } = require('../src/core/singbox-config');
const { DEFAULT_SETTINGS } = require('../src/core/settings');
const { sanitizeRouting, effectiveRouting } = require('../src/core/routing');

const server = parseLink('vless://b831381d-6324-4d53-ad4f-8cda48b30811@1.2.3.4:443?type=tcp&security=tls&sni=a.com#x');
const routing = (mode) => ({ ...effectiveRouting(sanitizeRouting({})), mode, country: 'ir' });

test('Xray, my country direct: the direct resolver has its own tag, routed direct before anything else', () => {
  const c = buildXrayConfig(server, { ...DEFAULT_SETTINGS, directDns: '8.8.8.8' }, routing('bypass-local'), {});
  const direct = c.dns.servers.find((s) => typeof s === 'object' && s.tag === 'dns-direct');
  assert.ok(direct && direct.address === '8.8.8.8' && direct.domains.length, 'no tagged direct resolver');
  assert.deepStrictEqual(c.routing.rules[0], { type: 'field', inboundTag: ['dns-direct'], outboundTag: 'direct' });
  // The rest of the DNS still goes through the proxy.
  assert.ok(c.routing.rules.some((r) => r.inboundTag && r.inboundTag[0] === 'dns-internal' && r.outboundTag === 'proxy'));
  // Other modes: no such rule.
  for (const mode of ['global', 'direct']) {
    assert.ok(!buildXrayConfig(server, { ...DEFAULT_SETTINGS, directDns: '8.8.8.8' }, routing(mode), {}).routing.rules.some((r) => (r.inboundTag || [])[0] === 'dns-direct'), mode);
  }
});

test('sing-box: the direct resolver from Settings is used (by name: found by the system DNS)', () => {
  const sb = (directDns, mode = 'bypass-local') => buildSingBoxConfig(server, { ...DEFAULT_SETTINGS, directDns }, routing(mode)).dns;
  const ip = sb('8.8.8.8');
  assert.deepStrictEqual(ip.servers.find((s) => s.tag === 'direct-dns'), { tag: 'direct-dns', type: 'udp', server: '8.8.8.8' });
  assert.ok(ip.rules.length && ip.rules.every((r) => r.server === 'direct-dns'));
  assert.ok(!('detour' in ip.servers.find((s) => s.tag === 'direct-dns')), 'the direct resolver must not go through the proxy');
  assert.deepStrictEqual(sb('https://dns.google/dns-query').servers.find((s) => s.tag === 'direct-dns'), { tag: 'direct-dns', type: 'https', server: 'dns.google', path: '/dns-query', domain_resolver: 'local' });
  // "localhost" (the default) stays this computer's own DNS, as before.
  const own = sb('localhost');
  assert.ok(!own.servers.some((s) => s.tag === 'direct-dns'));
  assert.ok(own.rules.every((r) => r.server === 'local'));
  assert.strictEqual(sb('1.1.1.1', 'direct').final, 'direct-dns');
  assert.strictEqual(sb('1.1.1.1', 'global').final, 'remote');
});
