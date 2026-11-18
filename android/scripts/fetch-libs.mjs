// Puts the Xray core library (AndroidLibXrayLite) into app/libs, checked by SHA-256.
// A copy already downloaded by hand can be passed: node scripts/fetch-libs.mjs <path-to-libv2ray.aar>
// Without a path it is downloaded from the project's GitHub release. Either way the file is used
// only when its SHA-256 matches; the same hash is checked again by the Gradle build.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 'v26.11.9';
const SHA256 = 'cdfef146218233a31a8b52c8b1016557730d3b63fc121d4c84cacea50e669155';
const URL_ = `https://github.com/2dust/AndroidLibXrayLite/releases/download/${VERSION}/libv2ray.aar`;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'app', 'libs', 'libv2ray.aar');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

if (existsSync(target) && sha256(readFileSync(target)) === SHA256) {
  console.log(`libv2ray.aar ${VERSION} is already in place.`);
  process.exit(0);
}
mkdirSync(dirname(target), { recursive: true });

const given = process.argv[2];
let data;
if (given) {
  data = readFileSync(given);
} else {
  console.log(`Downloading ${URL_}`);
  const res = await fetch(URL_, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  data = Buffer.from(await res.arrayBuffer());
}
const got = sha256(data);
if (got !== SHA256) {
  console.error(`SHA-256 mismatch: got ${got}, expected ${SHA256}. The file was not used.`);
  process.exit(1);
}
const tmp = `${target}.part`;
if (given) copyFileSync(given, tmp); else writeFileSync(tmp, data);
renameSync(tmp, target);
console.log(`libv2ray.aar ${VERSION} checked and placed in app/libs.`);
