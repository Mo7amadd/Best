// Checks of the built macOS app, run on a Mac (the GitHub build machine) right after electron-builder:
//   node test/mac/smoke.mjs <arm64|x64> [out-folder]
//  1. The bundle: Best's id and version, minimum macOS, the processor of every program in it.
//  2. The free (ad-hoc) signature seals the whole app; the update zip unpacks to the same sealed app.
//  3. What Gatekeeper says about a downloaded copy (only reported: unsigned apps are refused by design).
//  4. The bundled cores run.
//  5. Best opens; screenshots of its pages (Persian dark, English light) and of the whole screen.
//  6. With BEST_TEST_LINK (a share link of a test server, kept as a repository secret): connect,
//     turn the system proxy on, check networksetup and an exit address through the tunnel, turn it
//     off, quit Best with ⌘Q and check the proxy is gone.
// Results go to <out-folder>/report.md (and the pictures next to it); the exit code is 1 if a must-pass
// check failed.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARCH = process.argv[2] === 'x64' ? 'x64' : 'arm64';
const OUT = path.resolve(process.argv[3] || path.join(ROOT, 'dist', `smoke-${ARCH}`));
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
fs.mkdirSync(OUT, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [`# Best ${PKG.version} — macOS ${ARCH} checks`, '', `- macOS ${sh('/usr/bin/sw_vers', ['-productVersion']).trim()} (${os.arch()})`, ''];
let failed = 0;
// Every tool gets a time limit: on a machine with nobody at the screen, a macOS permission prompt
// would otherwise wait forever.
function sh(file, args, opts = {}) { return execFileSync(file, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 90000, ...opts }); }
function trySh(file, args, timeout = 90000) { try { return { ok: true, out: sh(file, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout }) }; } catch (e) { return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}${e.code === 'ETIMEDOUT' || e.signal ? ' (timed out)' : ''}` }; } }
const within = (ms, what, p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what}: no answer in ${ms / 1000} s`)), ms))]);
function result(must, name, ok, detail = '') {
  if (!ok && must) failed++;
  const mark = ok ? '✅' : must ? '❌' : '⚠️';
  lines.push(`- ${mark} ${name}${detail ? ` — ${String(detail).trim().split('\n').slice(0, 4).join(' / ').slice(0, 400)}` : ''}`);
  console.log(`${ok ? 'PASS' : must ? 'FAIL' : 'NOTE'} ${name}${detail ? `: ${String(detail).trim().split('\n')[0].slice(0, 200)}` : ''}`);
}
async function check(must, name, fn) {
  try { const d = await fn(); result(must, name, true, typeof d === 'string' ? d : ''); } catch (e) { result(must, name, false, e.message); }
}

const dist = path.join(ROOT, 'dist');
const appDir = [path.join(dist, `mac-${ARCH}`, 'Best.app'), path.join(dist, 'mac', 'Best.app')].find((p) => fs.existsSync(p));
const zip = path.join(dist, `Best-v${PKG.version}-mac-${ARCH}.zip`);
const dmg = path.join(dist, `Best-v${PKG.version}-mac-${ARCH}.dmg`);
const plist = (app, key) => sh('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')]).trim();

// ------------------------------------------------------------------ 1. the bundle
lines.push('## Package');
await check(true, 'app, zip and dmg were built', () => {
  if (!appDir) throw new Error('no Best.app in dist');
  for (const f of [zip, dmg]) if (!fs.existsSync(f)) throw new Error(`${path.basename(f)} missing`);
  return `${path.relative(ROOT, appDir)}, zip ${(fs.statSync(zip).size / 1e6).toFixed(0)} MB, dmg ${(fs.statSync(dmg).size / 1e6).toFixed(0)} MB`;
});
if (!appDir) { finish(); process.exit(1); }
await check(true, 'id, version and minimum macOS', () => {
  const id = plist(appDir, 'CFBundleIdentifier'); const v = plist(appDir, 'CFBundleShortVersionString'); const min = plist(appDir, 'LSMinimumSystemVersion');
  if (id !== 'com.best.client' || v !== PKG.version || min !== '12.0') throw new Error(`${id} ${v} ${min}`);
  return `${id} ${v}, macOS ${min}+`;
});
const want = ARCH === 'arm64' ? 'arm64' : 'x86_64';
await check(true, `every program is built for ${want}`, () => {
  const progs = [path.join(appDir, 'Contents', 'MacOS', 'Best'), ...['xray/xray', 'sing-box/sing-box'].map((c) => path.join(appDir, 'Contents', 'Resources', 'cores', c))];
  const bad = progs.filter((p) => !sh('/usr/bin/lipo', ['-archs', p]).split(/\s+/).includes(want));
  if (bad.length) throw new Error(`wrong processor: ${bad.map((p) => path.basename(p)).join(', ')}`);
  return progs.map((p) => path.basename(p)).join(', ');
});
await check(true, 'no Windows file in the app', () => {
  const found = sh('/usr/bin/find', [appDir, '-iname', '*.exe', '-o', '-iname', '*.dll', '-o', '-iname', '*.ps1']).trim();
  if (found) throw new Error(found);
});

// ------------------------------------------------------------------ 2. signature and update zip
lines.push('', '## Signature and update package');
await check(true, 'the ad-hoc signature seals the whole app (codesign --verify --deep --strict)', () => {
  const r = trySh('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appDir]);
  if (!r.ok) throw new Error(r.out);
  const info = trySh('/usr/bin/codesign', ['-dv', appDir]).out;
  return (/Signature=(\S+)/.exec(info) || [])[0] || 'signed';
});
await check(true, 'the update zip holds the same sealed app (the way Best updates itself)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'best-zip-'));
  sh('/usr/bin/ditto', ['-x', '-k', zip, tmp]);
  const app = path.join(tmp, 'Best.app');
  if (plist(app, 'CFBundleIdentifier') !== 'com.best.client' || plist(app, 'CFBundleShortVersionString') !== PKG.version) throw new Error('wrong app inside');
  const r = trySh('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!r.ok) throw new Error(r.out);
});

// ------------------------------------------------------------------ 3. Gatekeeper (report only)
lines.push('', '## Gatekeeper (what a user who downloads the dmg meets)');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'best-gk-'));
  const app = path.join(tmp, 'Best.app');
  sh('/usr/bin/ditto', [appDir, app]);
  sh('/usr/bin/xattr', ['-w', 'com.apple.quarantine', `0081;${Math.floor(Date.now() / 1000).toString(16)};Safari;`, app]);
  const q = trySh('/usr/sbin/spctl', ['--assess', '--type', 'execute', '-vv', app]);
  result(false, 'downloaded copy (quarantined): Gatekeeper asks the user first (expected without a paid signature)', !q.ok, q.out);
  sh('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', app]);
  const left = trySh('/usr/bin/xattr', ['-p', 'com.apple.quarantine', app]);
  result(true, 'the Terminal fix of the guide ("xattr -dr com.apple.quarantine") clears the mark', !left.ok, left.ok ? left.out : '');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ------------------------------------------------------------------ 4. cores
lines.push('', '## Cores');
await check(true, 'Xray runs', () => sh(path.join(appDir, 'Contents', 'Resources', 'cores', 'xray', 'xray'), ['version']).split('\n')[0]);
await check(true, 'sing-box runs', () => sh(path.join(appDir, 'Contents', 'Resources', 'cores', 'sing-box', 'sing-box'), ['version']).split('\n')[0]);

// ------------------------------------------------------------------ 5. the app
lines.push('', '## The app');
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const cdpPort = await freePort();
const logFile = path.join(OUT, 'best-console.log');
const child = spawn(path.join(appDir, 'Contents', 'MacOS', 'Best'), [`--remote-debugging-port=${cdpPort}`], { stdio: ['ignore', fs.openSync(logFile, 'w'), fs.openSync(logFile, 'a')], detached: false });

async function connect(match) {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json`, { signal: AbortSignal.timeout(3000) })).json();
      const t = list.find((x) => x.type === 'page' && x.url.includes(match));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await within(5000, 'debugger connection', new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); }));
        let id = 0; const pending = new Map();
        ws.addEventListener('message', (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
        const send = (method, params = {}) => within(45000, method, new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); }));
        const ev = async (expr) => {
          const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
          if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate failed');
          return r.result?.result?.value;
        };
        return { ws, send, ev };
      }
    } catch { /* not up yet */ }
    await wait(500);
  }
  throw new Error('the window did not open');
}

// Best keeps its encryption key in the Keychain ("Best Safe Storage"). The interface tests before
// made one with the development app (another signature), which would make macOS ask for the
// password: remove it, so this is a first install as on a user's Mac (the key is made silently).
{
  const del = trySh('/usr/bin/security', ['delete-generic-password', '-s', 'Best Safe Storage'], 15000);
  result(false, 'first install: no "Best Safe Storage" key left from the development app', true, del.ok ? 'the development app\'s key was removed' : 'there was none');
}

let page = null;
await check(true, 'Best opens its window', async () => {
  page = await connect('index');
  const plat = await page.ev('window.best.platform');
  if (plat !== 'mac') throw new Error(`platform is ${plat}`);
  // The page draws after its first answer from the main process (which reads the encrypted data).
  await page.ev(`new Promise((r) => { const t = () => (document.querySelector('aside .nav-btn') ? r() : setTimeout(t, 100)); t(); })`);
  return 'window.best.platform = mac';
});
if (!page || !(await page.ev(`Boolean(document.querySelector('aside .nav-btn'))`).catch(() => false))) {
  // Stuck: keep what explains it (a picture of the screen shows any macOS prompt, and Best's output).
  const pic = trySh('/usr/sbin/screencapture', ['-x', path.join(OUT, 'stuck-screen.png')], 20000);
  result(false, 'picture of the screen while stuck', pic.ok, pic.out);
  const log = trySh('/usr/bin/log', ['show', '--last', '3m', '--style', 'compact', '--predicate', 'process == "Best" OR process == "SecurityAgent" OR process == "securityd"'], 60000);
  fs.writeFileSync(path.join(OUT, 'system-log.txt'), log.out);
  lines.push('', '```', fs.readFileSync(logFile, 'utf8').split('\n').slice(-30).join('\n'), '```');
  page = null; // the checks below need a working window
}

const shot = async (name) => {
  await wait(1200);
  const r = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'));
};
if (page) {
  const { ev } = page;
  const navTo = (label) => ev(`[...document.querySelectorAll('aside .nav-btn')].find((b) => b.textContent.includes(${JSON.stringify(label)}))?.click()`);
  const sample = ['vless://11111111-1111-4111-8111-111111111111@203.0.113.10:443?type=tcp&security=reality&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sni=example.com&fp=chrome#Sample%201',
    'trojan://pass@203.0.113.11:443?type=ws&path=%2F&security=tls&sni=example.com#Sample%202'].join('\n');
  await check(false, 'screenshots of the pages (Persian dark, English light)', async () => {
    await ev(`window.best.importText(${JSON.stringify(sample)})`);
    await ev(`window.best.setSettings({ language: 'fa', theme: 'dark' })`);
    for (const [label, name] of [['سرورها', 'fa-servers'], ['تنظیمات', 'fa-settings'], ['به‌روزرسانی', 'fa-updates']]) { await navTo(label); await shot(name); }
    await ev(`window.best.setSettings({ language: 'en', theme: 'light' })`);
    await navTo('Servers'); await shot('en-servers');
    await ev(`window.best.setSettings({ language: 'fa', theme: 'dark' })`);
    await navTo('سرورها');
    return 'saved next to this report';
  });
  await check(false, 'texts say macOS (not Windows)', async () => {
    const text = await ev('document.body.innerText');
    if (/Windows|ویندوز/.test(text)) throw new Error((/.{0,60}(Windows|ویندوز).{0,60}/.exec(text) || [''])[0]);
  });
  const full = trySh('/usr/sbin/screencapture', ['-x', path.join(OUT, 'screen.png')], 20000);
  result(false, 'picture of the whole screen (window buttons, menu bar icon)', full.ok && fs.existsSync(path.join(OUT, 'screen.png')), full.out);

  // ---------------------------------------------------------------- 6. a real connection
  const link = process.env.BEST_TEST_LINK || '';
  lines.push('', '## Real connection');
  if (!link) {
    result(false, 'skipped: no BEST_TEST_LINK secret', false);
  } else {
    const services = () => sh('/usr/sbin/networksetup', ['-listallnetworkservices']).split('\n').slice(1).map((s) => s.trim()).filter((s) => s && !s.startsWith('*'));
    const webProxy = (svc) => sh('/usr/sbin/networksetup', ['-getwebproxy', svc]);
    const exitIp = (proxy) => {
      const args = ['-sS', '--max-time', '20', ...(proxy ? ['-x', proxy] : []), 'https://www.cloudflare.com/cdn-cgi/trace'];
      return (/^ip=(.+)$/m.exec(sh('/usr/bin/curl', args)) || [])[1] || '';
    };
    await check(true, 'connect to the test server with the system proxy on', async () => {
      await ev(`window.best.setRouting({ activeId: 'p-global' })`).catch(() => {});
      await ev(`window.best.importText(${JSON.stringify(link)})`);
      const st = await ev('window.best.getState()');
      const s = st.servers[st.servers.length - 1];
      await ev(`window.best.setProxyMode('on')`);
      await ev(`window.best.connect(${JSON.stringify(s.id)})`);
      for (let i = 0; i < 30 && !(await ev('window.best.getState()')).core.running; i++) await wait(500);
      if (!(await ev('window.best.getState()')).core.running) throw new Error('the core did not start');
    });
    const st = await ev('window.best.getState()').catch(() => null);
    const http = st ? st.settings.httpPort : 10809;
    await check(true, 'networksetup shows Best\'s proxy on every active service', () => {
      const bad = services().filter((svc) => { const w = webProxy(svc); return !/Enabled: Yes/.test(w) || !/Server: 127\.0\.0\.1/.test(w) || !new RegExp(`Port: ${http}\\b`).test(w); });
      if (bad.length) throw new Error(`not set on: ${bad.join(', ')}`);
      return `${services().length} services`;
    });
    await check(true, 'traffic leaves through the server (exit address differs from the direct one)', () => {
      const direct = exitIp('');
      const tunnel = exitIp(`http://127.0.0.1:${http}`);
      if (!tunnel || tunnel === direct) throw new Error(`direct ${direct ? 'x.x.x.x' : '—'}, tunnel ${tunnel ? 'same' : '—'}`);
      return 'exit address differs';
    });
    await check(true, 'system proxy off: networksetup is clean again', async () => {
      await ev(`window.best.setProxyMode('off')`);
      await wait(1500);
      const left = services().filter((svc) => /Enabled: Yes/.test(webProxy(svc)) && /127\.0\.0\.1/.test(webProxy(svc)));
      if (left.length) throw new Error(`still set on: ${left.join(', ')}`);
    });
    await check(true, '⌘Q with the proxy on: Best removes it before quitting', async () => {
      await ev(`window.best.setProxyMode('on')`);
      await wait(1500);
      // The same quit as ⌘Q (app.quit → clean-up); osascript would need an Automation permission.
      await ev('window.best.quit()').catch(() => {});
      for (let i = 0; i < 40 && child.exitCode === null; i++) await wait(250);
      const left = services().filter((svc) => /Enabled: Yes/.test(webProxy(svc)) && /127\.0\.0\.1/.test(webProxy(svc)));
      if (left.length) throw new Error(`still set on: ${left.join(', ')}`);
    });
  }
}

try { child.kill(); } catch { /* already gone */ }
finish();
process.exit(failed ? 1 : 0);

function finish() {
  lines.push('', failed ? `**${failed} must-pass check(s) failed.**` : '**All must-pass checks passed.**', '');
  fs.writeFileSync(path.join(OUT, 'report.md'), lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}
