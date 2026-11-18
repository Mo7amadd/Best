'use strict';
// The servers' own names are looked up with this computer's DNS, not with Xray's remote DNS that
// goes through the tunnel (WireGuard: "connected" but no traffic, since the tunnel never came up).
const test = require('node:test');
const assert = require('node:assert');
const { parseLink } = require('../src/core/links');
const { buildXrayConfig } = require('../src/core/xray-config');
const { buildComposite } = require('../src/core/group');
const { DEFAULT_SETTINGS } = require('../src/core/settings');

const settings = { ...DEFAULT_SETTINGS, socksPort: 20808, httpPort: 20809 };
const routing = { mode: 'proxy-all', domainStrategy: 'AsIs', rules: [] };
const WG = (host) => `wireguard://wME9TJvSQIDz8%2FTEQn9NSp%2BhugLAgotUnFbQNbCCNl8%3D@${host}:51820?publickey=NV3%2FZSY9353D%2FSaxlK5l5gHr5AOSO3DLFmDsYIJWaG0%3D&address=10.0.0.2%2F32#w`;
const VLESS = (host) => `vless://0b6d8a1c-1111-4c2d-9e3f-123456789abc@${host}:443?security=tls&sni=${host}&type=tcp#v`;
const entry = (config) => config.dns.servers.find((d) => d && d.tag === 'server-names');

test('WireGuard on Xray: its server name is looked up with the system DNS', () => {
  const c = buildXrayConfig(parseLink(WG('Fafann.Example.ir')), settings, routing);
  const e = entry(c);
  assert.ok(e, 'no DNS entry for the server name');
  assert.strictEqual(e.address, 'localhost');
  assert.deepStrictEqual(e.domains, ['full:fafann.example.ir']);
  assert.strictEqual(e.skipFallback, true);
  // the remote DNS stays the first (default) one for everything else
  assert.strictEqual(c.dns.servers[0], settings.remoteDns || 'https://1.1.1.1/dns-query');
});

test('a server given as an IP address needs no DNS entry', () => {
  const c = buildXrayConfig(parseLink(WG('162.159.192.1')), settings, routing);
  assert.strictEqual(entry(c), undefined);
});

test('group and chain: every member and the front server, each name once', () => {
  const members = [parseLink(WG('a.example.ir')), parseLink(VLESS('b.example.ir')), parseLink(WG('A.example.ir'))];
  const front = parseLink(VLESS('front.example.ir'));
  const c = buildComposite({ core: 'xray', members, strategy: 'leastPing', front }, settings, routing);
  assert.deepStrictEqual(entry(c).domains.sort(), ['full:a.example.ir', 'full:b.example.ir', 'full:front.example.ir']);
  assert.strictEqual(c.dns.servers.filter((d) => d && d.tag === 'server-names').length, 1, 'more than one entry');
});
