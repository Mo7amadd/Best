// Load test: the development app on a throw-away data folder gets the largest allowed list
// (5000 servers), then we time import, page drawing, search, scrolling, a delay test of 500
// servers and memory. Nothing leaves the computer: every server points to 127.0.0.1 on a closed
// port.   npm run test:perf
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const N = Number(process.env.PERF_SERVERS || 5000);
const TESTED = Number(process.env.PERF_TESTED || 500);

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'best-perf-'));
fs.mkdirSync(path.join(dataRoot, 'data'));
const base = 24000 + Math.floor(Math.random() * 3000);
fs.writeFileSync(path.join(dataRoot, 'data', 'settings.json'), JSON.stringify({
  language: 'en', socksPort: base, httpPort: base + 1, pacPort: base + 2, lanSocksPort: base + 3, lanHttpPort: base + 4,
  proxyMode: 'off', autoCheckUpdates: false, autoStart: false, closeToTray: false, globalHotkey: false, testTimeout: 3000,
}));
const cdpPort = await freePort();
const KEEP_RENDERING = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion'];
const app = spawn(ELECTRON, [ROOT, `--remote-debugging-port=${cdpPort}`, ...KEEP_RENDERING], { env: { ...process.env, BEST_DEV_DATA: dataRoot }, stdio: 'ignore' });

async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const t = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((x) => x.type === 'page' && x.url.includes('index'));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
        let id = 0; const pending = new Map();
        ws.addEventListener('message', (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
        const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
        const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.error) throw new Error(r.error.message); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate failed'); return r.result.result.value; };
        return { ws, send, ev };
      }
    } catch { /* not up yet */ }
    await wait(250);
  }
  throw new Error('app did not start');
}

// Deterministic list: every protocol / transport mix, all on 127.0.0.1 closed ports.
function links(n) {
  const b64 = (s) => Buffer.from(s).toString('base64');
  const out = [];
  for (let i = 0; i < n; i++) {
    const port = 1 + (i % 1000); // low ports: nothing listens there
    const U = 'b831381d-6324-4d53-ad4f-' + (0x8cda48b30000 + i).toString(16); // one user per server, so none is a duplicate
    const name = encodeURIComponent(`Server ${i} · ${['Germany', 'Netherlands', 'Finland', 'Japan', 'Canada'][i % 5]}`);
    switch (i % 6) {
      case 0: out.push(`vless://${U}@127.0.0.1:${port}?security=reality&pbk=jMamUbtCOrl6Hxo3u4XYTUNMIB2T29_R8dptw_msbjA&sni=www.cloudflare.com&fp=chrome&type=tcp&flow=xtls-rprx-vision#${name}`); break;
      case 1: out.push(`vless://${U}@127.0.0.1:${port}?security=tls&sni=a.example&type=ws&path=%2Fws#${name}`); break;
      case 2: out.push('vmess://' + b64(JSON.stringify({ v: '2', ps: decodeURIComponent(name), add: '127.0.0.1', port: String(port), id: U, net: 'grpc', tls: 'tls', path: 'g' }))); break;
      case 3: out.push(`trojan://pw${i}@127.0.0.1:${port}?security=tls&sni=a.example#${name}`); break;
      case 4: out.push(`ss://${b64('chacha20-ietf-poly1305:pw' + i)}@127.0.0.1:${port}#${name}`); break;
      default: out.push(`hysteria2://pw${i}@127.0.0.1:${port}?sni=a.example#${name}`);
    }
  }
  return out.join('\n');
}

const results = [];
const note = (name, value, limit, unit = 'ms') => { const x = { name, value: Math.round(value), limit, unit, ok: limit == null || value <= limit }; results.push(x); console.error(`  … ${name}: ${x.value} ${unit}`); };
let page; let step = 'start';
try {
  page = await connect();
  const { send, ev } = page;
  await ev(`new Promise((r) => { const t = () => (document.querySelector('aside .nav-btn') ? r() : setTimeout(t, 100)); t(); })`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 820, deviceScaleFactor: 1, mobile: false });
  await send('Performance.enable');
  const heap = async () => { const m = (await send('Performance.getMetrics')).result.metrics; return m.find((x) => x.name === 'JSHeapUsedSize').value / 1048576; };
  const heap0 = await heap();

  // 1) import
  step = "1) import";
  const text = links(N);
  let t0 = Date.now();
  await ev('window.__t = ""');
  for (let i = 0; i < text.length; i += 200000) await ev(`window.__t += ${JSON.stringify(text.slice(i, i + 200000))}`);
  t0 = Date.now();
  const r = await ev('best.importText(window.__t)');
  note(`import ${N} servers (main process)`, Date.now() - t0, 8000);
  const count = await ev(`best.getState().then((s) => s.servers.length)`);
  if (count < N) throw new Error(`only ${count} of ${N} servers imported (${JSON.stringify(r).slice(0, 200)})`);

  // 2) servers page with the full list
  step = "2) servers page with the full list";
  await ev(`[...document.querySelectorAll('aside .nav-btn')][1].click()`); await wait(300);
  t0 = await ev('performance.now()');
  const drawn = await ev(`new Promise((r) => { document.querySelector('aside .nav-btn').click(); requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now()))); })`);
  note('open the servers page (draw to screen)', drawn - t0, 1500);
  note('rows drawn (the rest are spacers)', await ev(`document.querySelectorAll('[data-key^="s-"]').length`), 300, 'rows');

  // 3) a state update while the big list is shown (e.g. live traffic numbers every second)
  step = "3) a state update while the big list is shown (e.g. live traffic numbers every second)";
  t0 = await ev('performance.now()');
  const upd = await ev(`best.setSettings({ testConcurrency: 9 }).then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now())))))`);
  note('redraw after a settings change', upd - t0, 800);

  // 4) search: type one letter at a time, every key must stay responsive
  step = "4) search: type one letter at a time, every key must stay responsive";
  const box = await ev(`(() => { const e = document.querySelector('[data-keep="search"]'); const b = e.getBoundingClientRect(); return [b.left + 20, b.top + b.height / 2]; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box[0], y: box[1], button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box[0], y: box[1], button: 'left', clickCount: 1 });
  let worstKey = 0;
  for (const ch of 'server 49') {
    const a = await ev('performance.now()');
    await send('Input.insertText', { text: ch });
    const b = await ev(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now()))))`);
    worstKey = Math.max(worstKey, b - a);
  }
  note('slowest key press in search', worstKey, 300);
  const found = await ev(`document.querySelectorAll('[data-key^="s-"]').length`);
  if (found < 1) throw new Error('search found nothing');
  await ev(`(() => { const e = document.querySelector('[data-keep="search"]'); e.value = 'server 4321 ·'; e.dispatchEvent(new Event('input', { bubbles: true })); })()`); await wait(400);
  const one = await ev(`[...document.querySelectorAll('.srow .n1')].map((e) => e.textContent)`);
  if (one.length !== 1 || !one[0].startsWith('Server 4321 ')) throw new Error(`search for one server gave ${JSON.stringify(one.slice(0, 3))}`);
  await ev(`(() => { const e = document.querySelector('[data-keep="search"]'); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); })()`); await wait(800);

  // 5) scrolling the full list: frame times while it scrolls top to bottom
  step = "5) scrolling the full list: frame times while it scrolls top to bottom";
  await ev(`window.__scroller = () => { for (let p = document.querySelector('.servers .table').parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowY; if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p; } return document.scrollingElement; }`);
  const frames = await ev(`new Promise((r) => {
    const sc = window.__scroller(); const max = sc.scrollHeight - sc.clientHeight;
    const times = []; let last = performance.now(); let y = 0;
    const f = (now) => { times.push(now - last); last = now; y += max / 90; sc.scrollTop = y; if (times.length < 90) requestAnimationFrame(f); else r(times); };
    requestAnimationFrame(f);
  })`);
  frames.sort((a, b) => a - b);
  note('scrolling: 95th percentile frame time', frames[Math.floor(frames.length * 0.95)], 50);
  await wait(300);
  const lastOk = await ev(`best.getState().then((s) => { const id = s.servers[s.servers.length - 1].id; const el = document.querySelector('.srow[data-id="' + id + '"]'); if (!el) return 'last server not drawn'; const b = el.getBoundingClientRect(); const v = window.__scroller().getBoundingClientRect(); return b.bottom <= v.bottom + 2 && b.top >= v.top - 2 ? 'ok' : 'last server drawn off screen (' + Math.round(b.top) + ' vs ' + Math.round(v.top) + '-' + Math.round(v.bottom) + ')'; })`);
  if (lastOk !== 'ok') throw new Error(lastOk);
  // keyboard: from the first row, 80 × ArrowDown must land on server 80 (through rows not drawn yet)
  await ev('window.__scroller().scrollTop = 0'); await wait(300);
  await ev(`document.querySelector('.srow').focus()`);
  for (let i = 0; i < 80; i++) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }); }
  await wait(300);
  const kb = await ev(`best.getState().then((s) => ({ want: s.servers[80].id, got: document.activeElement && document.activeElement.dataset.id }))`);
  if (kb.want !== kb.got) throw new Error(`arrow keys did not reach server 80 (focus on index ${await ev(`best.getState().then((s) => s.servers.findIndex((x) => x.id === (document.activeElement && document.activeElement.dataset.id)))`)}, active element: ${await ev('document.activeElement && document.activeElement.className')})`);

  // 6) delay test of many servers: batches of cores, every result must arrive
  step = "6) delay test of many servers: batches of cores, every result must arrive";
  const ids = await ev(`best.getState().then((s) => s.servers.slice(0, ${TESTED}).map((x) => x.id))`);
  await ev(`window.__res = 0; window.__off = best.on('test-result', () => window.__res++)`);
  t0 = Date.now();
  await ev(`best.runTest(${JSON.stringify(ids)}, 'real')`);
  let got = 0;
  for (let i = 0; i < 600 && got < ids.length; i++) { await wait(500); got = await ev('window.__res'); }
  note(`delay test of ${ids.length} servers (all results back)`, Date.now() - t0, 180000);
  if (got < ids.length) throw new Error(`only ${got} of ${ids.length} test results arrived`);
  const ui = await ev(`new Promise((r) => { const a = performance.now(); requestAnimationFrame(() => r(performance.now() - a)); })`);
  note('window still responsive after the test (one frame)', ui, 100);

  // 7) memory
  step = "7) memory";
  await send('HeapProfiler.collectGarbage');
  note('renderer memory growth', (await heap()) - heap0, 150, 'MB');
  const rss = await ev('best.getState().then(() => 0)');
  void rss;
} catch (e) {
  results.push({ name: `perf run (at step ${step})`, value: String(e.message || e), ok: false });
} finally {
  try { await Promise.race([page?.ev('best.quit()'), wait(3000)]); } catch { /* closing */ }
  await wait(1500);
  try { spawn('C:/Windows/System32/taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  await wait(800);
  try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* locked: the OS temp cleaner removes it */ }
}
let failed = 0;
for (const x of results) { if (!x.ok) failed++; console.log(`${x.ok ? '✔' : '✖'} ${x.name}: ${x.value}${x.unit && typeof x.value === 'number' ? ' ' + x.unit : ''}${x.limit != null ? `  (limit ${x.limit})` : ''}`); }
process.exit(failed ? 1 : 0);
