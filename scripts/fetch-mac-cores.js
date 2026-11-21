'use strict';
// Puts the cores of the macOS build in resources/cores-mac-arm64 and resources/cores-mac-x64
// (electron-builder takes the one of each processor; package.json › build.mac.extraResources).
//  - The same versions Windows ships. Every download must have the SHA-256 written below: the
//    numbers were read from two places (the project's own checksum file and GitHub's), so a file
//    changed later on GitHub is refused. To move to a new version, change both lines and the hashes.
//  - Geo files (they change every day): the newest, checked against the checksum file published
//    with them; or the copies of the Windows build when they are already here.
//   node scripts/fetch-mac-cores.js [arm64|x64]   (both when no processor is given)

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const XRAY = 'v26.11.9';
const SINGBOX = 'v1.14.4';
const FILES = {
  arm64: {
    xray: { name: 'Xray-macos-arm64-v8a.zip', sha256: '233f0c66681cd0726f81a6b2b6ed6a5710869e312047b522e46ed53035bebd26' },
    singbox: { name: 'sing-box-1.14.4-darwin-arm64.tar.gz', sha256: '0d8c7f5ed5d587b0f1a5e9772a708ec3bfa4ac4c9329604b01d8d9c2ba406838' },
  },
  x64: {
    xray: { name: 'Xray-macos-64.zip', sha256: '488963e676e06f5e48547f9dd38116aaca8de4234959b4272ae8f284e658dfd0' },
    singbox: { name: 'sing-box-1.14.4-darwin-amd64.tar.gz', sha256: 'eae86b9b033bba50b7c44ab719e4bfac0aca05efd28483390ed3aa510f32db25' },
  },
};
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'best-build' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url);
        if (next.protocol !== 'https:') return reject(new Error(`refusing ${next.protocol} redirect`));
        return resolve(get(next.toString(), redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function fetchChecked(url, expected) {
  const data = await get(url);
  const got = sha256(data);
  if (got !== expected) throw new Error(`${path.basename(url)}: SHA-256 ${got} is not the expected ${expected}`);
  return data;
}

/** Unpack `data` and return the path of the file called `want` inside it (regular files only). */
function unpack(data, format, want, work) {
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const pkg = path.join(work, format === 'zip' ? 'pkg.zip' : 'pkg.tar.gz');
  fs.writeFileSync(pkg, data);
  const out = path.join(work, 'x');
  fs.mkdirSync(out);
  execFileSync(TAR, ['-xf', pkg, '-C', out]);
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && want.includes(e.name)) found.push(p);
    }
  };
  walk(out);
  return Object.fromEntries(want.map((w) => [w, found.find((p) => path.basename(p) === w)]));
}

async function geoFiles(work) {
  const bundled = path.join(ROOT, 'resources', 'cores', 'xray');
  if (['geoip.dat', 'geosite.dat'].every((f) => fs.existsSync(path.join(bundled, f)))) {
    return { 'geoip.dat': fs.readFileSync(path.join(bundled, 'geoip.dat')), 'geosite.dat': fs.readFileSync(path.join(bundled, 'geosite.dat')) };
  }
  const out = {};
  for (const [repo, asset, target] of [['v2fly/geoip', 'geoip.dat', 'geoip.dat'], ['v2fly/domain-list-community', 'dlc.dat', 'geosite.dat']]) {
    const base = `https://github.com/${repo}/releases/latest/download/`;
    const sum = (/^([0-9a-f]{64})/m.exec((await get(`${base}${asset}.sha256sum`)).toString('utf8')) || [])[1];
    if (!sum) throw new Error(`no checksum for ${asset}`);
    out[target] = await fetchChecked(`${base}${asset}`, sum);
  }
  fs.rmSync(work, { recursive: true, force: true });
  return out;
}

async function main() {
  const arches = process.argv[2] ? [process.argv[2]] : ['arm64', 'x64'];
  if (!arches.every((a) => FILES[a])) throw new Error('processor must be arm64 or x64');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'best-mac-cores-'));
  try {
    const geo = await geoFiles(path.join(work, 'geo'));
    for (const arch of arches) {
      const dest = path.join(ROOT, 'resources', `cores-mac-${arch}`);
      fs.rmSync(dest, { recursive: true, force: true });
      const x = FILES[arch].xray;
      const xf = unpack(await fetchChecked(`https://github.com/XTLS/Xray-core/releases/download/${XRAY}/${x.name}`, x.sha256), 'zip', ['xray', 'LICENSE'], path.join(work, 'x'));
      const s = FILES[arch].singbox;
      const sf = unpack(await fetchChecked(`https://github.com/SagerNet/sing-box/releases/download/${SINGBOX}/${s.name}`, s.sha256), 'tgz', ['sing-box', 'LICENSE'], path.join(work, 's'));
      if (!xf.xray || !sf['sing-box']) throw new Error('a core program is missing in its package');
      fs.mkdirSync(path.join(dest, 'xray'), { recursive: true });
      fs.mkdirSync(path.join(dest, 'sing-box'), { recursive: true });
      fs.copyFileSync(xf.xray, path.join(dest, 'xray', 'xray'));
      if (xf.LICENSE) fs.copyFileSync(xf.LICENSE, path.join(dest, 'xray', 'LICENSE'));
      for (const [name, data] of Object.entries(geo)) fs.writeFileSync(path.join(dest, 'xray', name), data);
      fs.copyFileSync(sf['sing-box'], path.join(dest, 'sing-box', 'sing-box'));
      if (sf.LICENSE) fs.copyFileSync(sf.LICENSE, path.join(dest, 'sing-box', 'LICENSE'));
      for (const p of [path.join(dest, 'xray', 'xray'), path.join(dest, 'sing-box', 'sing-box')]) fs.chmodSync(p, 0o755);
      console.log(`cores for macOS ${arch}: Xray ${XRAY}, sing-box ${SINGBOX} → ${path.relative(ROOT, dest)}`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
