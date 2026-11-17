'use strict';
// The interface dictionaries: the file loads (a stray backslash such as "\update" once broke it),
// every language has every key, and each translation keeps the placeholders ({n}, {d}…).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'i18n.js'), 'utf8');
const dict = (name) => {
  const a = src.indexOf(`const ${name} = {`);
  const e = src.indexOf('\n};', a);
  assert.ok(a >= 0 && e > a, `dictionary ${name} not found`);
  return Function(`return ${src.slice(a + `const ${name} = `.length, e + 2)}`)();
};
const LANGS = ['fa', 'en', 'ru', 'zh'];

test('i18n: the dictionary file parses as a module', async () => {
  await assert.doesNotReject(import(`file://${path.join(__dirname, '..', 'renderer', 'i18n.js').replace(/\\/g, '/')}`));
});

test('i18n: every language has every key, with the same placeholders, and no empty text', () => {
  const d = Object.fromEntries(LANGS.map((l) => [l, dict(l)]));
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const l of LANGS) {
    const missing = Object.keys(d.en).filter((k) => !(k in d[l]));
    const extra = Object.keys(d[l]).filter((k) => !(k in d.en));
    assert.deepStrictEqual([missing, extra], [[], []], `${l}: missing ${missing.slice(0, 5)} extra ${extra.slice(0, 5)}`);
    for (const k of Object.keys(d.en)) {
      assert.strictEqual(ph(d[l][k]), ph(d.en[k]), `${l}.${k}: placeholders differ`);
      assert.ok(String(d[l][k]).trim(), `${l}.${k} is empty`);
    }
  }
  assert.match(src, /DICTS = \{ fa, en, ru, zh \}/);
});
