'use strict';
// Does the connected server reach IPv6? (electron/ipv6probe.js; the real handshakes are tried live.)
const test = require('node:test');
const assert = require('node:assert');
const { serverHasIpv6, ipv6Bytes } = require('../electron/ipv6probe');

test('IPv6 addresses become their 16 bytes for the SOCKS request', () => {
  assert.strictEqual(ipv6Bytes('2606:4700:4700::1111').toString('hex'), '26064700470000000000000000001111');
  assert.strictEqual(ipv6Bytes('::1').toString('hex'), '00000000000000000000000000000001');
  assert.strictEqual(ipv6Bytes('2001:db8:0:0:1:0:0:1').toString('hex'), '20010db8000000000001000000000001');
  assert.throws(() => ipv6Bytes('1:2:3'));
});

const fake = (answers) => {
  const asked = [];
  return { asked, probe: async (port, target) => { asked.push(target.host.includes(':') ? 'v6' : 'v4'); return answers[asked.length - 1]; } };
};

test('decides only when IPv4 works: IPv6 there → true; IPv6 missing twice → false; IPv4 down too → unknown', async () => {
  let f = fake([true, true]);
  assert.strictEqual(await serverHasIpv6(1, { probe: f.probe }), true);
  f = fake([true, false, false]);
  assert.strictEqual(await serverHasIpv6(1, { probe: f.probe }), false);
  assert.deepStrictEqual(f.asked, ['v4', 'v6', 'v6'], 'IPv6 not asked a second time before deciding');
  f = fake([true, false, true]); // a lost first handshake: the second one decides
  assert.strictEqual(await serverHasIpv6(1, { probe: f.probe }), true);
  f = fake([false, false]); // slow or broken network: no conclusion, nothing changes
  assert.strictEqual(await serverHasIpv6(1, { probe: f.probe }), null);
  f = fake([false, true]);
  assert.strictEqual(await serverHasIpv6(1, { probe: f.probe }), true);
});
