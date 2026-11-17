// Soak test: the development app (throw-away data folder, Windows proxy untouched) connects to
// three local test servers run by our own Xray on 127.0.0.1, keeps traffic flowing for a few
// minutes, connects / disconnects and switches servers many times, and watches memory, leftover
// core processes and ports.   npm run test:soak   (SOAK_MINUTES=5 by default)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const XRAY = path.join(ROOT, 'resources', 'cores', 'xray', 'xray.exe');
const PS = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const MINUTES = Number(process.env.SOAK_MINUTES || 5);
const CYCLES = Number(process.env.SOAK_CYCLES || 40);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// ------------------------------------------------------------ local target + local "servers"
const PAYLOAD = Buffer.alloc(512 * 1024, 7);
const target = http.createServer((req, res) => { res.writeHead(200, { 'content-length': PAYLOAD.length }); res.end(PAYLOAD); });
const targetPort = await new Promise((r) => target.listen(0, '127.0.0.1', () => r(target.address().port)));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'best-soak-'));
const U = 'b831381d-6324-4d53-ad4f-8cda48b30811';
const sp = [await freePort(), await freePort(), await freePort()];
fs.writeFileSync(path.join(work, 'server.json'), JSON.stringify({
  log: { loglevel: 'warning' },
  inbounds: [
    { listen: '127.0.0.1', port: sp[0], protocol: 'vless', settings: { clients: [{ id: U }], decryption: 'none' } },
    { listen: '127.0.0.1', port: sp[1], protocol: 'vmess', settings: { clients: [{ id: U }] } },
    { listen: '127.0.0.1', port: sp[2], protocol: 'shadowsocks', settings: { method: 'chacha20-ietf-poly1305', password: 'soak-pass', network: 'tcp,udp' } },
  ],
  outbounds: [{ protocol: 'freedom' }],
}));
const server = spawn(XRAY, ['run', '-c', path.join(work, 'server.json')], { stdio: 'ignore', windowsHide: true });

// ------------------------------------------------------------ the app
const dataRoot = path.join(work, 'app');
fs.mkdirSync(path.join(dataRoot, 'data'), { recursive: true });
const base = 28000 + Math.floor(Math.random() * 2000);
fs.writeFileSync(path.join(dataRoot, 'data', 'settings.json'), JSON.stringify({
  language: 'en', socksPort: base, httpPort: base + 1, pacPort: base + 2, lanSocksPort: base + 3, lanHttpPort: base + 4,
  proxyMode: 'off', tun: false, autoCheckUpdates: false, autoStart: false, closeToTray: false, globalHotkey: false, showExitIp: false,
}));
const cdpPort = await freePort();
const KEEP_RENDERING = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion'];
const app = spawn(ELECTRON, [ROOT, `--remote-debugging-port=${cdpPort}`, ...KEEP_RENDERING], { env: { ...process.env, BEST_DEV_DATA: dataRoot }, stdio: 'ignore' });

let ws; let id = 0; const pending = new Map();
for (let i = 0; i < 80 && !ws; i++) {
  try { const t = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((x) => x.type === 'page' && x.url.includes('index')); if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r)); } } catch { /* not up yet */ }
  if (!ws) await wait(250);
}
ws.addEventListener('message', (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.error) throw new Error(r.error.message); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description); return r.result.result.value; };

// One request through Best's local HTTP proxy port.
function viaBest(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({ host: '127.0.0.1', port: base + 1, method: 'GET', path: url, headers: { Host: u.host }, timeout: 8000 }, (res) => {
      let n = 0; res.on('data', (d) => { n += d.length; }); res.on('end', () => resolve(res.statusCode === 200 ? n : -1));
    });
    req.on('timeout', () => { req.destroy(); resolve(-1); });
    req.on('error', () => resolve(-1));
    req.end();
  });
}
// Memory of the app's own processes and the cores it started (matched by path / command line).
function sample() {
  const out = execFileSync(PS, ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${ROOT.replace(/\//g, '\\')}*' } | ForEach-Object { "$($_.ProcessId)|$($_.Name)|$([math]::Round($_.WorkingSetSize/1MB))|$($_.HandleCount)|$($_.CommandLine -like '*stdin*')" }`], { encoding: 'utf8' });
  const rows = out.trim().split(/\r?\n/).filter(Boolean).map((l) => { const [pid, name, mb, handles, stdin] = l.split('|'); return { pid: Number(pid), name, mb: Number(mb), handles: Number(handles), core: stdin === 'True' && name !== 'electron.exe' }; });
  const appRows = rows.filter((r) => r.name === 'electron.exe');
  return { appMB: appRows.reduce((a, r) => a + r.mb, 0), appHandles: appRows.reduce((a, r) => a + r.handles, 0), cores: rows.filter((r) => r.core) };
}
const portFree = (p) => new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(p, '127.0.0.1', () => s.close(() => r(true))); });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.error(`  ${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`); };
try {
  await ev(`new Promise((r) => { const t = () => (document.querySelector('aside .nav-btn') ? r() : setTimeout(t, 100)); t(); })`);
  await send('Performance.enable');
  const heap = async () => (await send('Performance.getMetrics')).result.metrics.find((x) => x.name === 'JSHeapUsedSize').value / 1048576;
  const links = [
    `vless://${U}@127.0.0.1:${sp[0]}?type=tcp&security=none#soak-vless`,
    'vmess://' + Buffer.from(JSON.stringify({ v: '2', ps: 'soak-vmess', add: '127.0.0.1', port: String(sp[1]), id: U, net: 'tcp', scy: 'aes-128-gcm' })).toString('base64'),
    `ss://${Buffer.from('chacha20-ietf-poly1305:soak-pass').toString('base64')}@127.0.0.1:${sp[2]}#soak-ss`,
  ];
  await ev(`best.importText(${JSON.stringify(links.join('\n'))})`);
  const ids = await ev(`best.getState().then((s) => s.servers.map((x) => x.id))`);
  if (ids.length !== 3) throw new Error(`imported ${ids.length} servers`);
  const local = `http://127.0.0.1:${targetPort}/payload`;

  // 1) connect / disconnect / switch many times
  let bad = 0; let orphan = 0; let busy = 0;
  for (let c = 0; c < CYCLES; c++) {
    await ev(`best.connect(${JSON.stringify(ids[c % 3])})`);
    if ((await viaBest(local)) !== PAYLOAD.length) bad++;
    if (c % 2) { await ev(`best.connect(${JSON.stringify(ids[(c + 1) % 3])})`); if ((await viaBest(local)) !== PAYLOAD.length) bad++; } // switch while connected
    await ev('best.disconnect()');
    await wait(150);
    if (sample().cores.length) orphan++;
    if (!(await portFree(base)) || !(await portFree(base + 1))) busy++;
  }
  check(`${CYCLES} connect / switch / disconnect cycles: every request through the proxy worked`, bad === 0, `${bad} failed`);
  check('no core left running after disconnect', orphan === 0, `${orphan} time(s)`);
  check('local ports free again after disconnect', busy === 0, `${busy} time(s)`);

  // 2) steady traffic for a few minutes, memory sampled
  await ev(`best.connect(${JSON.stringify(ids[0])})`);
  await wait(1500);
  await send('HeapProfiler.collectGarbage');
  const m0 = sample(); const h0 = await heap();
  const coreMB0 = m0.cores.reduce((a, r) => a + r.mb, 0);
  const end = Date.now() + MINUTES * 60000;
  let reqs = 0; let fails = 0; let bytes = 0;
  const workers = Array.from({ length: 6 }, async () => {
    // ~40 requests a second in all: real browsing, not a flood (a flood of new connections only
    // measures how fast Windows recycles its temporary ports)
    while (Date.now() < end) { const n = await viaBest(local); reqs++; if (n < 0) fails++; else bytes += n; await wait(150); }
  });
  const samples = [];
  const sampler = (async () => { while (Date.now() < end) { await wait(20000); const s = sample(); samples.push({ app: s.appMB, core: s.cores.reduce((a, r) => a + r.mb, 0) }); console.error(`    … ${Math.round((end - Date.now()) / 1000)} s left, ${reqs} requests, app ${s.appMB} MB, core ${samples.at(-1).core} MB`); } })();
  await Promise.all([...workers, sampler]);
  await wait(3000);
  await send('HeapProfiler.collectGarbage');
  const m1 = sample(); const h1 = await heap();
  const coreMB1 = m1.cores.reduce((a, r) => a + r.mb, 0);
  check(`${MINUTES} min of traffic: ${reqs} requests, ${Math.round(bytes / 1048576)} MB`, fails <= reqs * 0.005, `${fails} failed`);
  check('page memory (JS heap) stays flat', h1 - h0 < 25, `${Math.round(h0)} → ${Math.round(h1)} MB`);
  check('app processes memory stays flat', m1.appMB - m0.appMB < 120, `${m0.appMB} → ${m1.appMB} MB`);
  check('core memory stays flat', coreMB1 - coreMB0 < 120, `${coreMB0} → ${coreMB1} MB`);
  check('app handles stay flat', m1.appHandles - m0.appHandles < 500, `${m0.appHandles} → ${m1.appHandles}`);
  check('window still answers', (await ev('1 + 1')) === 2);
  await ev('best.disconnect()');
} catch (e) {
  check('soak run', false, String(e.message || e));
} finally {
  try { await Promise.race([ev('best.quit()'), wait(3000)]); } catch { /* closing */ }
  await wait(1500);
  for (const p of [app, server]) { try { spawn('C:/Windows/System32/taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
  target.close();
  await wait(1000);
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* locked: the OS temp cleaner removes it */ }
}
const failed = results.filter((r) => !r.ok).length;
console.log('');
for (const r of results) console.log(`${r.ok ? '✔' : '✖'} ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
process.exit(failed ? 1 : 0);
