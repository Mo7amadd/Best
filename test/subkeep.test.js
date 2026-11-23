'use strict';
// A subscription update never replaces the servers by nothing (links that cannot be read keep the old ones).
const test = require('node:test');
const assert = require('node:assert');
const { updateOutcome, parseContent } = require('../src/core/subscription');

test('subscription update: servers are replaced only by servers', () => {
  assert.strictEqual(updateOutcome({ servers: 3 }), 'replace');
  assert.strictEqual(updateOutcome({ servers: 2, errors: 5 }), 'replace');
  assert.strictEqual(updateOutcome({ info: 2 }), 'notice'); // expired: only "Traffic: 0" lines
  // Links that could not be read (a protocol Best does not know): the old servers stay.
  assert.strictEqual(updateOutcome({ errors: 4 }), 'NO_VALID_SERVERS');
  assert.strictEqual(updateOutcome({}), 'EMPTY');
  assert.strictEqual(updateOutcome({ device: 'limit' }), 'HWID_LIMIT');
  assert.strictEqual(updateOutcome({ device: 'required' }), 'HWID_REQUIRED');
  // The case from the field: every line looks like a link and none can be read.
  const r = parseContent('vless://@1.2.3.4:443#a\ntrojan://@1.2.3.4:443#b\nvmess://not-base64!!#c');
  assert.deepStrictEqual([r.servers.length, r.errors.length], [0, 3]);
  assert.strictEqual(updateOutcome({ servers: r.servers.length, errors: r.errors.length }), 'NO_VALID_SERVERS');
});
