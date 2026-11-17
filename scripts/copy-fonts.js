'use strict';
// Copies the bundled fonts (all SIL Open Font License) from node_modules into renderer/fonts,
// so the app works fully offline and never loads anything from the internet.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'renderer', 'fonts');
fs.mkdirSync(OUT, { recursive: true });

const files = [
  ['vazirmatn/fonts/webfonts/Vazirmatn[wght].woff2', 'Vazirmatn.woff2'],
  ['@fontsource/inter/files/inter-latin-400-normal.woff2', 'Inter-400.woff2'],
  ['@fontsource/inter/files/inter-latin-500-normal.woff2', 'Inter-500.woff2'],
  ['@fontsource/inter/files/inter-latin-600-normal.woff2', 'Inter-600.woff2'],
  ['@fontsource/inter/files/inter-latin-700-normal.woff2', 'Inter-700.woff2'],
  ['@fontsource/inter/files/inter-cyrillic-400-normal.woff2', 'Inter-cyr-400.woff2'],
  ['@fontsource/inter/files/inter-cyrillic-500-normal.woff2', 'Inter-cyr-500.woff2'],
  ['@fontsource/inter/files/inter-cyrillic-600-normal.woff2', 'Inter-cyr-600.woff2'],
  ['@fontsource/inter/files/inter-cyrillic-700-normal.woff2', 'Inter-cyr-700.woff2'],
  ['@fontsource/jetbrains-mono/files/jetbrains-mono-cyrillic-400-normal.woff2', 'JetBrainsMono-cyr-400.woff2'],
  ['@fontsource/jetbrains-mono/files/jetbrains-mono-cyrillic-500-normal.woff2', 'JetBrainsMono-cyr-500.woff2'],
  ['@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2', 'JetBrainsMono-400.woff2'],
  ['@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2', 'JetBrainsMono-500.woff2'],
  // Flag-only emoji font (Windows has no flag emoji). Code MIT (TalkJS), Twemoji artwork CC-BY 4.0.
  ['country-flag-emoji-polyfill/dist/TwemojiCountryFlags.woff2', 'TwemojiCountryFlags.woff2'],
];
for (const [src, dst] of files) fs.copyFileSync(path.join(ROOT, 'node_modules', src), path.join(OUT, dst));
console.log('fonts copied');
