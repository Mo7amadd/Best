'use strict';
// Packs dist/win-unpacked into dist/Best-v<version>-portable.zip with the "portable" marker,
// so the extracted app keeps its data in .\data next to Best.exe (like v2rayN).
// Uses the tar.exe that ships with Windows 10+ (it can write zip files).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { version } = require(path.join(ROOT, 'package.json'));
const src = path.join(ROOT, 'dist', 'win-unpacked');
const stage = path.join(ROOT, 'dist', `portable-stage`, 'Best');
const tag = process.argv[2] ? `-${process.argv[2].replace(/[^a-z0-9]/gi, '')}` : '';
const out = path.join(ROOT, 'dist', `Best-v${version}${tag}-portable.zip`);
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

if (!fs.existsSync(path.join(src, 'Best.exe'))) throw new Error('build the app first (dist/win-unpacked)');
fs.rmSync(path.dirname(stage), { recursive: true, force: true });
fs.cpSync(src, stage, { recursive: true });
fs.writeFileSync(path.join(stage, 'portable'),
  'This file switches Best to portable mode: settings and servers are kept in the "data" folder next to Best.exe.\r\n' +
  'Delete this file to use the normal per-user data folder instead.\r\n');
if (fs.existsSync(out)) throw new Error(`${path.basename(out)} already exists; bump the version first`);
execFileSync(TAR, ['-a', '-c', '-f', out, '-C', path.dirname(stage), 'Best'], { stdio: 'inherit' });
fs.rmSync(path.dirname(stage), { recursive: true, force: true });
console.log(`portable zip written: ${path.relative(ROOT, out)} (${Math.round(fs.statSync(out).size / 1e6)} MB)`);
