// Copies the signed release APKs into dist/android-v<version>/ with the names the in-app updater
// looks for (Best-android-v<version>-<abi>.apk) and writes SHA256SUMS next to them.
// Run after: gradle assembleRelease. Nothing is uploaded anywhere.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gradle = readFileSync(join(root, 'app', 'build.gradle.kts'), 'utf8');
const version = (/versionName = "([^"]+)"/.exec(gradle) || [])[1];
if (!version) throw new Error('versionName not found in app/build.gradle.kts');

const src = join(root, 'app', 'build', 'outputs', 'apk', 'release');
const out = join(root, '..', 'dist', `android-v${version}`);
mkdirSync(out, { recursive: true });

const sums = [];
for (const abi of ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86', 'universal']) {
  const from = join(src, `app-${abi}-release.apk`);
  if (!existsSync(from)) throw new Error(`missing ${from} (unsigned or not built?)`);
  const name = `Best-android-v${version}-${abi}.apk`;
  copyFileSync(from, join(out, name));
  const hash = createHash('sha256').update(readFileSync(join(out, name))).digest('hex');
  sums.push(`${hash}  ${name}`);
  console.log(`${name}  ${hash}`);
}
writeFileSync(join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`);
console.log(`→ ${out}`);
