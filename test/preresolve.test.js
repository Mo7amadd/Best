'use strict';
// Pre-resolving a subscription's server names: names become IPs, TLS and HTTP keep the name, an
// answer pointing at this computer or the LAN is refused, and the server is still recognised
// after the next update even when its IP changed.
const test = require('node:test');
const assert = require('node:assert');
const { isPublicIp, dnsQuery, dnsAnswers, applyResolved, preResolveServers, PRE_RESOLVERS } = require('../src/core/preresolve');
const { parseLink, normalizeServer, serverKey } = require('../src/core/links');

const ID = 'b831381d-6324-4d53-ad4f-8cda48b30811';

/** A DNS answer for `query` with the given A / AAAA records (compressed names, as servers send). */
function answer(query, records, rcode = 0) {
  const head = Buffer.from(query.subarray(0, 12));
  head[2] = 0x81; head[3] = 0x80 | rcode;
  head.writeUInt16BE(records.length, 6);
  const rr = records.map(([type, data]) => {
    const b = Buffer.alloc(12);
    b.writeUInt16BE(0xc00c, 0); b.writeUInt16BE(type, 2); b.writeUInt16BE(1, 4); b.writeUInt32BE(60, 6); b.writeUInt16BE(data.length, 10);
    return Buffer.concat([b, data]);
  });
  return Buffer.concat([head, query.subarray(12), ...rr]);
}

test('DNS wire format: a query and the A / AAAA records of its answer', () => {
  const q = dnsQuery('nl.example.com', 1, 0x1234);
  assert.deepStrictEqual([...q.subarray(0, 6)], [0x12, 0x34, 1, 0, 0, 1]);
  assert.strictEqual(q.subarray(12).toString('latin1'), '\x02nl\x07example\x03com\x00\x00\x01\x00\x01');
  const a = answer(q, [[5, Buffer.from([0, 0])], [1, Buffer.from([93, 184, 216, 34])], [1, Buffer.from([93, 184, 216, 35])]]);
  assert.deepStrictEqual(dnsAnswers(a, 1), ['93.184.216.34', '93.184.216.35']);
  const q6 = dnsQuery('nl.example.com', 28);
  const v6 = Buffer.from('2606470000000000000000006810' + '1234', 'hex');
  assert.deepStrictEqual(dnsAnswers(answer(q6, [[28, v6]]), 28), ['2606:4700:0:0:0:0:6810:1234']);
  // Errors and garbage give nothing (never a throw).
  assert.deepStrictEqual(dnsAnswers(answer(q, [[1, Buffer.from([1, 2, 3, 4])]], 3), 1), []);
  assert.deepStrictEqual(dnsAnswers(Buffer.from('nonsense'), 1), []);
  assert.deepStrictEqual(dnsAnswers(answer(q, [[1, Buffer.from([1, 2, 3])]]), 1), []);
  assert.throws(() => dnsQuery('bad name.com', 1));
  assert.throws(() => dnsQuery('a..com', 1));
});

test('only public IPs are taken: never this computer, the LAN or special ranges', () => {
  for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700::1111', '65.109.198.233']) assert.ok(isPublicIp(ip), ip);
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.1.1', '0.0.0.0', '100.64.0.1', '224.0.0.1', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:192.168.0.1', '2001:db8::1', 'example.com', '']) assert.ok(!isPublicIp(ip), ip);
  assert.deepStrictEqual(PRE_RESOLVERS.filter((r) => r.startsWith('https://')).every((r) => /^https:\/\/[0-9.]+\/dns-query$/.test(r)), true);
});

test('a resolved server keeps its name for TLS and HTTP', () => {
  const ws = parseLink(`vless://${ID}@cdn.example.com:443?type=ws&security=tls&path=%2Fws#a`);
  const r = applyResolved(ws, '93.184.216.34');
  assert.deepStrictEqual([r.address, r.resolvedFrom, r.sni, r.host], ['93.184.216.34', 'cdn.example.com', 'cdn.example.com', 'cdn.example.com']);
  // Values from the link are kept.
  const own = applyResolved(parseLink(`vless://${ID}@cdn.example.com:443?type=ws&security=tls&sni=front.com&host=back.com#a`), '93.184.216.34');
  assert.deepStrictEqual([own.sni, own.host], ['front.com', 'back.com']);
  // REALITY: its server name is part of the link; nothing else added.
  const re = applyResolved(parseLink(`vless://${ID}@nl.example.com:443?type=tcp&security=reality&sni=www.microsoft.com&pbk=Z84J2IelR9ch3k8VtlVhhs5ycBUlXA7wHBWcBLJ8XzQ&sid=6b#r`), '93.184.216.34');
  assert.deepStrictEqual([re.sni, re.host], ['www.microsoft.com', undefined]);
  // Own TLS (Hysteria2): SNI becomes the name.
  const hy = applyResolved(parseLink('hysteria2://p@hy.example.com:443#h'), '93.184.216.34');
  assert.strictEqual(hy.sni, 'hy.example.com');
  // Plain TCP without TLS: only the address.
  const plain = applyResolved(parseLink(`vless://${ID}@10.example.com:80?type=tcp&security=none#p`), '93.184.216.34');
  assert.deepStrictEqual([plain.address, plain.sni, plain.host], ['93.184.216.34', undefined, undefined]);
  // Never to a private address, never for an IP already.
  assert.strictEqual(applyResolved(ws, '127.0.0.1').address, 'cdn.example.com');
  const ipServer = parseLink(`vless://${ID}@1.2.3.4:443?type=tcp&security=tls&sni=a.com#i`);
  assert.strictEqual(applyResolved(ipServer, '93.184.216.34'), ipServer);
  // The result is a valid server and stays recognisable by its name.
  const n = normalizeServer(r);
  assert.strictEqual(n.resolvedFrom, 'cdn.example.com');
  assert.strictEqual(serverKey(n), serverKey(normalizeServer(applyResolved(ws, '93.184.216.99'))));
  // resolvedFrom only means something next to an IP.
  assert.strictEqual(normalizeServer({ ...ws, resolvedFrom: 'x.com' }).resolvedFrom, undefined);
});

test('a list: each name asked once, failures and bad answers leave the server by name', async () => {
  const list = [
    parseLink(`vless://${ID}@a.example.com:443?type=tcp&security=tls#1`),
    parseLink(`vless://${ID}@A.example.com:8443?type=tcp&security=tls#2`),
    parseLink(`vless://${ID}@b.example.com:443?type=tcp&security=tls#3`),
    parseLink(`vless://${ID}@c.example.com:443?type=tcp&security=tls#4`),
    parseLink(`vless://${ID}@d.example.com:443?type=tcp&security=tls#5`),
    parseLink(`vless://${ID}@9.9.9.9:443?type=tcp&security=tls&sni=x.com#6`),
  ];
  const asked = [];
  const answers = { 'a.example.com': '93.184.216.34', 'b.example.com': '192.168.1.10', 'c.example.com': '' };
  const out = await preResolveServers(list, async (n) => { asked.push(n); if (n === 'd.example.com') throw new Error('timeout'); return answers[n]; });
  assert.deepStrictEqual(asked.sort(), ['a.example.com', 'b.example.com', 'c.example.com', 'd.example.com']);
  assert.deepStrictEqual(out.map((s) => s.address), ['93.184.216.34', '93.184.216.34', 'b.example.com', 'c.example.com', 'd.example.com', '9.9.9.9']);
  assert.deepStrictEqual(out.map((s) => s.remark), ['1', '2', '3', '4', '5', '6']);
});
