// UI tests: start the development app on a throw-away data folder (its own ports, Windows proxy
// never touched), drive it over the DevTools protocol with real mouse / keyboard input, check the
// result, then quit and remove the folder.   npm run test:ui
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// ---------------------------------------------------------------- start the app
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'best-ui-test-'));
fs.mkdirSync(path.join(dataRoot, 'data'));
const base = 21000 + Math.floor(Math.random() * 3000);
fs.writeFileSync(path.join(dataRoot, 'data', 'settings.json'), JSON.stringify({
  language: 'fa', socksPort: base, httpPort: base + 1, pacPort: base + 2, lanSocksPort: base + 3, lanHttpPort: base + 4,
  proxyMode: 'off', autoCheckUpdates: false, autoStart: false, closeToTray: false, globalHotkey: false, sidebarCollapsed: false,
}));
const cdpPort = await freePort();
// A window hidden behind others would have its animations paused by Chromium and the checks would
// wait forever: keep it rendering as if it were in front.
const KEEP_RENDERING = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion'];
const app = spawn(ELECTRON, [ROOT, `--remote-debugging-port=${cdpPort}`, ...KEEP_RENDERING], { env: { ...process.env, BEST_DEV_DATA: dataRoot }, stdio: 'ignore' });

async function connect(match) {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
      const t = list.find((x) => x.type === 'page' && x.url.includes(match));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
        let id = 0; const pending = new Map(); const errors = [];
        ws.addEventListener('message', (m) => {
          const msg = JSON.parse(m.data);
          if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
          else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
          else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
        });
        const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
        await send('Runtime.enable');
        const ev = async (expr) => {
          const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
          if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate failed');
          return r.result.result.value;
        };
        return { ws, send, ev, errors };
      }
    } catch { /* not up yet */ }
    await wait(250);
  }
  throw new Error(`no ${match} page`);
}

// ---------------------------------------------------------------- tiny test runner
const results = [];
class Skip extends Error {}
const CHECK_TIMEOUT = 30000; // one stuck check must not hang the whole run
async function check(name, fn) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${CHECK_TIMEOUT / 1000} s`)), CHECK_TIMEOUT); });
  try { await Promise.race([fn(), limit]); results.push([true, name]); } catch (e) { results.push([e instanceof Skip ? 'skip' : false, name, String(e.message || e).split('\n')[0]]); } finally { clearTimeout(timer); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

let page;
try {
  page = await connect('index');
  const { send, ev } = page;
  await ev(`new Promise((r) => { const t = () => (document.querySelector('aside .nav-btn') ? r() : setTimeout(t, 100)); t(); })`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 820, deviceScaleFactor: 1, mobile: false });
  await wait(400);
  let mx = 700; let my = 400;
  const move = async (x, y, steps = 10) => { for (let i = 1; i <= steps; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(mx + (x - mx) * i / steps), y: Math.round(my + (y - my) * i / steps) }); await wait(8); } mx = x; my = y; };
  const click = async (x, y) => { await move(x, y, 4); await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); };
  const center = (sel, i = 0) => ev(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${i}]; if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)]; })()`);
  const iconPositions = () => ev(`[document.querySelector('.brand img'), ...document.querySelectorAll('aside .nav-btn .icon')].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })`);
  const same = (a, b) => a.length === b.length && a.every((p, i) => Math.abs(p[0] - b[i][0]) <= 1 && Math.abs(p[1] - b[i][1]) <= 1);
  const setSettings = async (patch) => { await ev(`best.setSettings(${JSON.stringify(patch)})`); await wait(450); };

  // ------------------------------------------------------------ pages
  await check('every page opens without errors', async () => {
    const n = await ev(`document.querySelectorAll('aside .nav .nav-btn:not(.nav-help)').length`);
    for (let i = 0; i < n; i++) {
      const [x, y] = await center('aside .nav .nav-btn:not(.nav-help)', i);
      await click(x, y); await wait(350);
      const ok = await ev(`Boolean(document.querySelector('main .page'))`);
      assert(ok, `page ${i + 1} did not draw`);
    }
    const [x, y] = await center('aside .nav .nav-btn:not(.nav-help)', 0);
    await click(x, y); await wait(300);
    assert(page.errors.length === 0, `errors: ${page.errors.slice(0, 2).join(' | ')}`);
  });

  await check('settings page shows all its sections', async () => {
    await ev(`[...document.querySelectorAll('aside .nav-btn')][6].click()`); await wait(400);
    const cards = await ev(`document.querySelectorAll('.settings .card').length`);
    assert(cards >= 9, `only ${cards} sections`);
    await ev(`[...document.querySelectorAll('aside .nav-btn')][0].click()`); await wait(300);
  });

  await check('settings search: finds a setting and jumps to it with a highlight', async () => {
    await ev(`[...document.querySelectorAll('aside .nav-btn')][6].click()`); await wait(500);
    await ev(`document.querySelector('[data-scroll=page-settings]').scrollTop = 0`);
    const box = await center('.set-find input');
    await click(box[0], box[1]);
    await send('Input.insertText', { text: 'webdav' }); await wait(250);
    const n = await ev(`document.querySelectorAll('.set-find-item').length`);
    assert(n > 0, 'no results for "webdav"');
    const first = await center('.set-find-item');
    await click(first[0], first[1]); await wait(600);
    const r = await ev(`(() => { const t = document.querySelector('.set-flash'); if (!t) return null; const b = t.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: innerHeight, list: Boolean(document.querySelector('.set-find-list')) }; })()`);
    assert(r, `nothing highlighted (results: ${n}, list open: ${await ev("Boolean(document.querySelector('.set-find-list'))")}, page scroll: ${await ev("Math.round(document.querySelector('[data-scroll=page-settings]')?.scrollTop ?? -1)")})`);
    assert(r.top >= 0 && r.bottom <= r.h, 'highlighted setting is not on screen');
    assert(!r.list, 'result list still open');
    await ev(`(() => { const i = document.querySelector('.set-find input'); i.value = ''; i.blur(); })()`);
  });

  // ------------------------------------------------------------ menus
  await check('clicking the "Routing" caption does not open its menu; the menu button does', async () => {
    await ev(`[...document.querySelectorAll('aside .nav-btn')][0].click()`); await wait(400); // servers page
    const cap = await center('#routing-cap');
    assert(cap, 'routing caption missing');
    await click(cap[0], cap[1]); await wait(250);
    assert(!(await ev(`Boolean(document.querySelector('.menu'))`)), 'menu opened from the caption');
    const btn = await center('#routing-sel');
    await click(btn[0], btn[1]); await wait(250);
    assert(await ev(`Boolean(document.querySelector('.menu'))`), 'menu did not open from its button');
    await click(btn[0], btn[1]); await wait(250);
    assert(!(await ev(`Boolean(document.querySelector('.menu'))`)), 'second click did not close the menu');
  });

  // ------------------------------------------------------------ side menu
  await check('side menu: icons stay put between pinned, unpinned and open-on-hover', async () => {
    await setSettings({ sidebarCollapsed: false }); await move(700, 400); await wait(300);
    const pinned = await iconPositions();
    await setSettings({ sidebarCollapsed: true }); await move(700, 400); await wait(500);
    const closed = await iconPositions();
    const [rx] = await center('.brand img');
    await move(rx, 300); await wait(450);
    assert(await ev(`document.querySelector('aside').classList.contains('peek')`), 'did not open on hover');
    const open = await iconPositions();
    assert(same(closed, open), 'icons moved when it opened');
    assert(same(closed, pinned), 'icons differ between pinned and unpinned');
  });

  await check('side menu: opens at once on hover, stays open after a click, closes as soon as the mouse leaves', async () => {
    const [sx, sy] = await center('aside .nav-btn', 6);
    await click(sx, sy); await wait(400);
    assert(await ev(`document.querySelector('aside').classList.contains('peek')`), 'closed after a click');
    await move(600, 400); await wait(450);
    assert(!(await ev(`document.querySelector('aside').classList.contains('peek')`)), 'did not close when the mouse left');
    const [rx] = await center('.brand img');
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rx, y: 300 }); await wait(120);
    assert(await ev(`document.querySelector('aside').classList.contains('peek')`), 'did not open at once');
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y: 400 }); mx = 600; my = 400; await wait(120);
    assert(!(await ev(`document.querySelector('aside').classList.contains('peek')`)), 'did not close at once');
  });

  await check('side menu: opens with the keyboard (Tab)', async () => {
    await move(600, 400); await wait(400);
    await ev('document.activeElement && document.activeElement.blur()');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await wait(300);
    const r = await ev(`({ inMenu: Boolean(document.activeElement && document.activeElement.closest('aside')), open: document.querySelector('aside').classList.contains('peek') })`);
    assert(r.inMenu, 'Tab did not reach the menu');
    assert(r.open, 'menu did not open for keyboard focus');
    await ev('document.activeElement.blur()'); await wait(200);
  });

  await check('side menu: pinning animates the page width (no jump) and is remembered', async () => {
    const [rx] = await center('.brand img');
    await move(rx, 300); await wait(450);
    const pin = await center('.side-toggle');
    await ev(`window.__w = []; (function f(){ window.__w.push(Math.round(document.querySelector('main').getBoundingClientRect().width)); if (window.__w.length < 45) requestAnimationFrame(f); })()`);
    await click(pin[0], pin[1]); await wait(700);
    const steps = await ev(`new Set(window.__w).size`);
    assert(steps >= 6, `page width changed in ${steps} step(s)`);
    assert(!(await ev(`best.getState().then((s) => s.settings.sidebarCollapsed)`)), 'pin not saved');
  });

  await check('side menu: narrow window has no pin button', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 820, deviceScaleFactor: 1, mobile: false }); await wait(500);
    assert(await ev(`document.querySelector('aside').classList.contains('small')`), 'not icons-only');
    assert(!(await ev(`Boolean(document.querySelector('.side-toggle'))`)), 'pin button shown');
    await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 820, deviceScaleFactor: 1, mobile: false }); await wait(500);
  });

  // ------------------------------------------------------------ drawing
  await check('a state update keeps the existing elements (clicks are not lost)', async () => {
    await ev(`document.querySelector('aside .nav-btn').__mark = 1`);
    await setSettings({ density: 'compact' }); await setSettings({ density: 'comfortable' });
    assert(await ev(`document.querySelector('aside .nav-btn').__mark === 1`), 'the window was rebuilt from scratch');
  });

  await check('typing in a settings box survives a state update (value and focus kept)', async () => {
    await ev(`[...document.querySelectorAll('aside .nav-btn')][6].click()`); await wait(400);
    await ev(`(() => { const i = document.querySelector('input[data-keep="set-testUrl"]'); i.focus(); i.value = 'https://example.org/typing'; })()`);
    await setSettings({ density: 'compact' });
    const r = await ev(`(() => { const i = document.querySelector('input[data-keep="set-testUrl"]'); return { v: i.value, focused: document.activeElement === i }; })()`);
    await ev('document.activeElement.blur()'); await setSettings({ density: 'comfortable' });
    assert(r.v === 'https://example.org/typing', `value lost: ${r.v}`);
    assert(r.focused, 'focus lost');
  });

  await check('number box arrows: a click steps once, holding keeps counting, saved once on release', async () => {
    await ev(`[...document.querySelectorAll('aside .nav-btn')][6].click()`); await wait(400);
    await setSettings({ testConcurrency: 8 });
    const SEL = 'input[data-keep="set-testConcurrency"]';
    await ev(`document.querySelector(${JSON.stringify(SEL)}).scrollIntoView({ block: 'center' })`); await wait(300);
    const pos = await ev(`(() => { const box = document.querySelector(${JSON.stringify(SEL)}).closest('.num-box'); const c = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)]; }; return { up: c(box.querySelector('.num-step.up')), down: c(box.querySelector('.num-step.down')) }; })()`);
    await click(pos.up[0], pos.up[1]); await wait(400);
    assert((await ev(`best.getState().then((s) => s.settings.testConcurrency)`)) === 9, 'one click did not step to 9');
    await ev(`window.__saves = 0; window.__offSaves = best.on('state', () => window.__saves++)`);
    await move(pos.down[0], pos.down[1], 2);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.down[0], y: pos.down[1], button: 'left', clickCount: 1 });
    await wait(900);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.down[0], y: pos.down[1], button: 'left', clickCount: 1 });
    await wait(400);
    const v = await ev(`best.getState().then((s) => s.settings.testConcurrency)`);
    const saves = await ev('window.__saves');
    await ev('window.__offSaves()'); await setSettings({ testConcurrency: 8 });
    assert(v <= 3, `holding only reached ${v}`);
    assert(saves === 1, `saved ${saves} times while holding`);
  });

  await check('server search keeps focus and filters while typing', async () => {
    await ev(`[...document.querySelectorAll('aside .nav-btn')][0].click()`); await wait(400);
    await ev(`best.importText('vless://b831381d-6324-4d53-ad4f-8cda48b30811@127.0.0.2:9?security=none&type=tcp#alpha-node')`); await wait(500);
    const box = await center('.toolbar input[type="search"]');
    await click(box[0], box[1]);
    await send('Input.insertText', { text: 'alpha' }); await wait(400);
    const r = await ev(`({ focused: document.activeElement && document.activeElement.type === 'search', value: document.activeElement && document.activeElement.value, rows: document.querySelectorAll('.srow').length })`);
    assert(r.focused && r.value === 'alpha', `search box lost focus or text (${r.value})`);
    assert(r.rows === 1, `filter shows ${r.rows} rows`);
    await ev(`(() => { const i = document.activeElement; i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); })()`); await wait(300);
  });

  await check('language and theme switch redraw cleanly', async () => {
    const before = page.errors.length;
    for (const p of [{ language: 'en' }, { language: 'ru' }, { theme: 'light' }, { theme: 'midnight' }, { language: 'fa', theme: 'dark' }]) await setSettings(p);
    const title = await ev(`document.querySelector('aside .nav-btn .nav-label').textContent`);
    assert(title === 'سرورها', `menu text after switching back: ${title}`);
    assert(page.errors.length === before, `errors: ${page.errors.slice(before).join(' | ')}`);
  });

  await check('server editor opens and closes', async () => {
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyN', key: 'n', ctrlKey: true, bubbles: true }))`); await wait(500);
    assert(await ev(`Boolean(document.querySelector('.overlay, .drawer'))`), 'editor did not open');
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await wait(500);
    assert(!(await ev(`Boolean(document.querySelector('.overlay, .drawer'))`)), 'editor did not close');
  });

  // ------------------------------------------------------------ connection
  await check('Disconnect stops the core (connection card)', async () => {
    await ev(`best.importText('vless://b831381d-6324-4d53-ad4f-8cda48b30811@127.0.0.1:9?security=none&type=tcp#ui-test')`);
    const sid = await ev(`best.getState().then((s) => s.servers.find((x) => x.remark === 'ui-test').id)`);
    await ev(`best.connect(${JSON.stringify(sid)})`); await wait(800);
    await ev(`[...document.querySelectorAll('aside .nav-btn')][0].click()`); await wait(400); // servers page
    assert(await ev(`best.getState().then((s) => s.core.running)`), 'core did not start');
    const btn = await ev(`(() => { const b = [...document.querySelectorAll('.conn button')].find((x) => x.querySelector('.icon') && /قطع اتصال/.test(x.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
    assert(btn, 'no Disconnect button');
    await click(btn[0], btn[1]); await wait(900);
    assert(!(await ev(`best.getState().then((s) => s.core.running)`)), 'core still running');
  });

  await check('tray window: Disconnect button shows while connected and stops the core', async () => {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    if (!list.some((x) => x.url.includes('tray.html'))) throw new Skip('the tray window only exists after a click on the tray icon');
    const tray = await connect('tray.html');
    try {
      const sid = await ev(`best.getState().then((s) => s.servers.find((x) => x.remark === 'ui-test').id)`);
      await ev(`best.connect(${JSON.stringify(sid)})`); await wait(900);
      const label = await tray.ev(`[...document.querySelectorAll('.tray-foot button')].map((b) => b.textContent.trim()).join('|')`);
      assert(/قطع اتصال/.test(label), `tray buttons: ${label}`);
      await tray.ev(`[...document.querySelectorAll('.tray-foot button')].find((b) => /قطع اتصال/.test(b.textContent)).click()`); await wait(900);
      assert(!(await ev(`best.getState().then((s) => s.core.running)`)), 'core still running');
    } finally { tray.ws.close(); }
  });
} catch (e) {
  results.push([false, 'test run', String(e.message || e)]);
} finally {
  try { await page?.ev('best.quit()'); } catch { /* closing */ }
  await wait(1500);
  // End the whole process tree (renderer, GPU and any core it started), not only the main process.
  try { if (process.platform === 'win32') spawn('C:/Windows/System32/taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); else app.kill(); } catch { /* gone */ }
  await wait(500);
  try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* still locked: the OS temp cleaner removes it */ }
}

let failed = 0; let skipped = 0;
for (const [ok, name, why] of results) {
  if (ok === 'skip') { skipped++; console.log(`- ${name}  (skipped: ${why})`); continue; }
  console.log(`${ok ? '✔' : '✖'} ${name}${ok ? '' : `  — ${why}`}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed - skipped}/${results.length - skipped} UI checks passed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed ? 1 : 0);
