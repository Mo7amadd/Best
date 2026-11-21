'use strict';
// Builds Best's TUN helper for macOS (helper/mac/BestTunHelper.swift) with Apple's Swift compiler
// and puts it with its install / remove scripts in resources/helper-mac-<processor>, which
// electron-builder copies into Best.app (package.json › build.mac.extraResources). Mac only.
//   node scripts/build-mac-helper.js [arm64|x64]   (both when no processor is given)

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'helper', 'mac');
if (process.platform !== 'darwin') { console.error('the TUN helper is built on a Mac (Xcode command line tools)'); process.exit(1); }

const arches = process.argv[2] ? [process.argv[2]] : ['arm64', 'x64'];
for (const arch of arches) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('processor must be arm64 or x64');
  const out = path.join(ROOT, 'resources', `helper-mac-${arch}`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const target = `${arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos12.0`;
  execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', target,
    path.join(SRC, 'BestTunHelper.swift'), '-o', path.join(out, 'best-tun-helper')], { stdio: 'inherit' });
  for (const f of ['install.sh', 'uninstall.sh']) {
    fs.copyFileSync(path.join(SRC, f), path.join(out, f));
    fs.chmodSync(path.join(out, f), 0o755);
  }
  fs.chmodSync(path.join(out, 'best-tun-helper'), 0o755);
  console.log(`TUN helper for macOS ${arch} → ${path.relative(ROOT, out)}`);
}
