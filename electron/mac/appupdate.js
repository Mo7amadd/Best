'use strict';
// Best's own update on macOS. The zip of the new Best.app has already matched the SHA-256 published
// with the release (appupdate.js). Here it is unpacked and checked once more (it must be Best, of
// exactly that version, and its signature must cover every file unchanged), then a small script
// that outlives Best puts it in place of the running app once Best has quit, and opens it again.
// Apple's updater (Squirrel.Mac) needs a paid developer signature, so it is not used.
//  - Nothing goes through a shell command line: the script is fixed text and gets the paths as
//    arguments; the tools are started by their full paths.
//  - When Best cannot replace itself (opened from the disk image, from Downloads without being
//    moved, or from a folder only an administrator can change), the checked app is put in Downloads
//    and shown in Finder instead, for the user to drag to Applications.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { shell } = require('electron');
const { macAppBundle } = require('../platform');

const DITTO = '/usr/bin/ditto';
const CODESIGN = '/usr/bin/codesign';
const PLUTIL = '/usr/bin/plutil';
const BUNDLE_ID = 'com.best.client';

function run(file, args, timeout = 300000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().slice(0, 300))) : resolve(String(stdout))));
  });
}

/** The running Best.app when it may be replaced in place, else ''. */
function replaceableBundle(execPath = process.execPath) {
  const bundle = macAppBundle(execPath);
  if (!bundle) return '';
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    fs.accessSync(bundle, fs.constants.W_OK);
  } catch { return ''; }
  return bundle;
}

const plistValue = async (plist, key) => (await run(PLUTIL, ['-extract', key, 'raw', '-o', '-', plist], 15000)).trim();

/** Unpack the verified zip into `dir` and check that it holds exactly Best `version`. */
async function unpackAndCheck(zipFile, dir, version) {
  const out = path.join(dir, 'x');
  fs.mkdirSync(out, { mode: 0o700 });
  await run(DITTO, ['-x', '-k', zipFile, out]);
  const fresh = path.join(out, 'Best.app');
  const st = fs.lstatSync(fresh, { throwIfNoEntry: false });
  if (!st || !st.isDirectory() || !fs.existsSync(path.join(fresh, 'Contents', 'MacOS', 'Best'))) throw new Error('UPDATE_BAD_PACKAGE');
  const plist = path.join(fresh, 'Contents', 'Info.plist');
  if ((await plistValue(plist, 'CFBundleIdentifier')) !== BUNDLE_ID) throw new Error('UPDATE_BAD_PACKAGE');
  if ((await plistValue(plist, 'CFBundleShortVersionString')) !== version) throw new Error('UPDATE_BAD_PACKAGE');
  // The (free, ad-hoc) signature seals every file of the app: nothing may have changed or been added.
  try { await run(CODESIGN, ['--verify', '--deep', '--strict', fresh]); } catch { throw new Error('UPDATE_BAD_PACKAGE'); }
  return fresh;
}

// Runs after Best has quit: $1 Best's process id, $2 the app to replace, $3 the new app, $4 the
// work folder (a best-update-* folder made by appupdate.js; removed at the end unless something
// went wrong, then update.log stays there). Anything else is refused before a file is touched.
const SWAP_SCRIPT = `#!/bin/sh
pid="$1"; target="$2"; fresh="$3"; work="$4"; log="$work/update.log"
case "$target" in /*.app) ;; *) exit 2 ;; esac
case "$fresh" in /*/Best.app) ;; *) exit 2 ;; esac
case "$work" in /*/best-update-*) ;; *) exit 2 ;; esac
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 240 ]; then echo "Best did not quit" >> "$log"; /usr/bin/open "$target"; exit 1; fi
  sleep 0.25
done
old="$target.old-$$"
if mv "$target" "$old"; then
  if mv "$fresh" "$target"; then
    rm -rf "$old"
  else
    echo "the new app could not be moved into place" >> "$log"
    rm -rf "$target"
    mv "$old" "$target"
  fi
else
  echo "the old app could not be moved aside" >> "$log"
fi
/usr/bin/open "$target"
[ -s "$log" ] || rm -rf "$work"
`;

/**
 * Hand the verified zip over. Resolves 'restart' (Best should quit now; the script brings the new
 * version up) or 'manual' (the new app is in Downloads, shown in Finder; Best keeps running).
 */
async function applyMacUpdate(zipFile, dir, info, { markPending } = {}) {
  const fresh = await unpackAndCheck(zipFile, dir, info.latest);
  const target = replaceableBundle();
  if (!target) {
    const dest = uniquePath(path.join(os.homedir(), 'Downloads', `Best ${info.latest}.app`));
    await run(DITTO, [fresh, dest]);
    fs.rmSync(dir, { recursive: true, force: true });
    shell.showItemInFolder(dest);
    return 'manual';
  }
  const script = path.join(dir, 'swap.sh');
  fs.writeFileSync(script, SWAP_SCRIPT, { mode: 0o700 });
  if (markPending) markPending();
  const child = spawn('/bin/sh', [script, String(process.pid), target, fresh, dir], { detached: true, stdio: 'ignore' });
  child.unref();
  return 'restart';
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, -ext.length);
  for (let i = 2; i < 100; i++) if (!fs.existsSync(`${base} ${i}${ext}`)) return `${base} ${i}${ext}`;
  return `${base} ${Date.now()}${ext}`;
}

module.exports = { applyMacUpdate, replaceableBundle, SWAP_SCRIPT };
