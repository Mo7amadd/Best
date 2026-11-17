'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeRouting, effectiveRouting, importRules, exportRules } = require('../src/core/routing');

test('migrates the old single-mode routing into profiles', () => {
  const r = sanitizeRouting({ mode: 'bypass-ir', blockAds: false, rules: [{ type: 'domain', values: ['example.com'], outbound: 'proxy' }] });
  assert.equal(r.country, 'ir');
  assert.equal(r.activeId, 'p-local');
  assert.equal(r.profiles.length, 3);
  const eff = effectiveRouting(r);
  assert.equal(eff.mode, 'bypass-local');
  assert.equal(eff.blockAds, false);
  assert.deepEqual(eff.rules[0].domain, ['example.com']);
});

test('built-in profiles cannot disappear and ids stay unique', () => {
  const r = sanitizeRouting({ profiles: [{ id: 'p-x', name: 'Mine', base: 'direct' }, { id: 'p-x', name: 'dup' }], activeId: 'p-x' });
  assert.deepEqual(r.profiles.map((p) => p.id).sort(), ['p-direct', 'p-global', 'p-local', 'p-x']);
  assert.equal(r.activeId, 'p-x');
});

test('imports v2rayN routing rules (compound, block alias, string port)', () => {
  const v2 = JSON.stringify([
    { remarks: 'block ads', outboundTag: 'block', domain: ['geosite:category-ads-all'] },
    { remarks: 'ir', outboundTag: 'direct', domain: ['domain:ir', 'geosite:category-ir'], enabled: true },
    { outboundTag: 'direct', ip: ['geoip:private', '10.0.0.0/8'] },
    { outboundTag: 'proxy', port: '443,1000-2000', network: 'tcp' },
    { outboundTag: 'blackhole', protocol: ['bittorrent'] },
    { outboundTag: 'proxy' }, // no matcher → dropped
    { outboundTag: 'nowhere', domain: ['x.com'] }, // unknown target → dropped
  ]);
  const { rules } = importRules(v2);
  assert.equal(rules.length, 5);
  assert.deepEqual(rules[3].port, ['443', '1000-2000']);
  assert.equal(rules[3].network, 'tcp');
  assert.equal(rules[4].outbound, 'block');
  const round = importRules(JSON.stringify(exportRules({ rules })));
  assert.equal(round.rules.length, 5);
});

test('rejects garbage and hostile values', () => {
  assert.throws(() => importRules('not json'));
  assert.throws(() => importRules('[]'));
  const { rules } = importRules(JSON.stringify([{ outboundTag: 'direct', domain: ['ok.com', 'bad "quote', '<script>'] }]));
  assert.deepEqual(rules[0].domain, ['ok.com']);
});
