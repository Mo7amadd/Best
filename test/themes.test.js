'use strict';
// Themes: every theme the Settings page offers is a saved value, has its colours in the style sheet
// and its name in every language; an unknown value never gets through.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeSettings, ENUMS, DEFAULT_SETTINGS } = require('../src/core/settings');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'renderer', 'styles.css'), 'utf8');
const i18n = fs.readFileSync(path.join(ROOT, 'renderer', 'i18n.js'), 'utf8');
const page = fs.readFileSync(path.join(ROOT, 'renderer', 'pages', 'settings.js'), 'utf8');

test('the new light themes are kept when saved; an unknown theme falls back to the default', () => {
  for (const theme of ['paper', 'sky', 'light', 'dark', 'system']) assert.strictEqual(sanitizeSettings({ theme }).theme, theme);
  assert.strictEqual(sanitizeSettings({ theme: 'neon' }).theme, DEFAULT_SETTINGS.theme);
  assert.strictEqual(sanitizeSettings({ theme: '"><script>' }).theme, DEFAULT_SETTINGS.theme);
});

test('every theme on the Settings page is allowed, has colours, and a name in all four languages', () => {
  const offered = [...page.matchAll(/\{ id: '([a-z]+)', a: '#/g)].map((m) => m[1]);
  assert.deepStrictEqual([...offered].sort(), [...ENUMS.theme].sort());
  for (const th of offered.filter((x) => x !== 'system')) {
    assert.ok(css.includes(`[data-theme="${th}"]`) || th === 'dark', `no colours for ${th}`);
    assert.strictEqual((i18n.match(new RegExp(`\\btheme_${th}:`, 'g')) || []).length, 4, `theme_${th} not in four languages`);
  }
});

test('light themes use the darker accent colours (readable on a light background)', () => {
  for (const th of ['light', 'paper', 'sky']) {
    for (const acc of ['green', 'blue', 'purple', 'orange', 'pink']) assert.ok(css.includes(`[data-theme="${th}"][data-accent="${acc}"]`), `${th} + ${acc}`);
    assert.match(css, new RegExp(`\\[data-theme="${th}"\\] \\{[^}]*color-scheme: light`), `${th} is not marked light`);
  }
});
