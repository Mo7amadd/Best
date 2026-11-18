// Puts the official sing-box program for Android into app/src/main/jniLibs/<abi>/libsingbox.so
// (Android lets an app run programs only from its library folder). The release archives can be
// downloaded by hand and their folder passed: node scripts/fetch-singbox.mjs <folder>
// Without a folder they are downloaded from SagerNet/sing-box's GitHub release. Each archive is used
// only when its SHA-256 matches; the Gradle build checks the unpacked programs again.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const VERSION = '1.14.4';
const ARCHIVES = {
  'arm64-v8a': { name: `sing-box-${VERSION}-android-arm64.tar.gz`, sha256: 'fb3a6c5197f4044f82c8fd75e01ce14c28b6abdd4c3df84bb987d41a962a320f' },
  'armeabi-v7a': { name: `sing-box-${VERSION}-android-arm.tar.gz`, sha256: 'a89f48c4f2691bf37476308212175ba7b7315db5ca03c0bf9b20d15f26bc70e9' },
  x86_64: { name: `sing-box-${VERSION}-android-amd64.tar.gz`, sha256: 'e72a8eead1ace9ce84a4ed07dfbf364e87562b736463fc00967b845cf9b3b8ac' },
  x86: { name: `sing-box-${VERSION}-android-386.tar.gz`, sha256: '6b715f5ee3d1ad1738da99e7c207db807a06560f623a2a44105dd3c34339fd93' },
};
// Files taken from each archive (by base name) and what they are called in the APK.
const TAKE = { 'sing-box': 'libsingbox.so', 'libcronet.so': 'libcronet.so' };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Regular files of a (ustar / GNU) tar archive: [{ name, data }]. */
function untar(buf) {
  const out = [];
  let off = 0;
  let longName = '';
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    let name = str(0, 100);
    const prefix = str(345, 500);
    if (prefix) name = `${prefix}/${name}`;
    const size = Number.parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const body = buf.subarray(off + 512, off + 512 + size);
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else {
      if (longName) { name = longName; longName = ''; }
      if (type === '0' || type === '\0') out.push({ name, data: Buffer.from(body) });
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

const folder = process.argv[2];
for (const [abi, a] of Object.entries(ARCHIVES)) {
  let data;
  const local = folder && join(folder, a.name);
  if (local && existsSync(local)) {
    data = readFileSync(local);
  } else {
    const url = `https://github.com/SagerNet/sing-box/releases/download/v${VERSION}/${a.name}`;
    console.log(`Downloading ${url}`);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    data = Buffer.from(await res.arrayBuffer());
  }
  const got = sha256(data);
  if (got !== a.sha256) {
    console.error(`${a.name}: SHA-256 ${got}, expected ${a.sha256}. Not used.`);
    process.exit(1);
  }
  const files = untar(gunzipSync(data));
  const dir = join(root, 'app', 'src', 'main', 'jniLibs', abi);
  mkdirSync(dir, { recursive: true });
  let program = false;
  for (const f of files) {
    const base = f.name.split('/').pop();
    const target = TAKE[base];
    if (!target) continue;
    const tmp = join(dir, `${target}.part`);
    writeFileSync(tmp, f.data);
    renameSync(tmp, join(dir, target));
    if (base === 'sing-box') program = true;
    console.log(`${abi}/${target}  ${sha256(f.data)}`);
  }
  if (!program) {
    console.error(`${a.name}: no sing-box program inside.`);
    process.exit(1);
  }
}
console.log(`sing-box ${VERSION} checked and placed in app/src/main/jniLibs.`);
