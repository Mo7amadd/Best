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
const ELECTRON = process.platform === 'darwin'
  ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  : path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
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
const mainPort = await freePort(); // the main process (to minimize / restore the real window)
// A window hidden behind others would have its animations paused by Chromium and the checks would
// wait forever: keep it rendering as if it were in front.
const KEEP_RENDERING = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion'];
const app = spawn(ELECTRON, [`--inspect=127.0.0.1:${mainPort}`, ROOT, `--remote-debugging-port=${cdpPort}`, ...KEEP_RENDERING], { env: { ...process.env, BEST_DEV_DATA: dataRoot }, stdio: 'ignore' });

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
          for (let attempt = 0; ; attempt++) {
            const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
            // A page still loading (slow machines) has no place to run code yet: wait and ask again.
            if (r.error) {
              if (attempt < 40 && /context|navigat|not found|destroyed/i.test(r.error.message || '')) { await wait(250); continue; }
              throw new Error(`debugger: ${r.error.message || JSON.stringify(r.error)}`);
            }
            if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate failed');
            return r.result.result.value;
          }
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
// Best's command key: Ctrl on Windows, ⌘ on macOS (CDP modifier bits: 2 = Ctrl, 4 = Meta).
const MAC = process.platform === 'darwin';
const CMD_BIT = MAC ? 4 : 2;
const CMD_PROP = MAC ? 'metaKey' : 'ctrlKey';
const CHECK_TIMEOUT = 30000; // one stuck check must not hang the whole run
// UI_ONLY=<text>: run only the checks whose name contains it (quicker while fixing one thing).
const ONLY = process.env.UI_ONLY || '';
async function check(name, fn, ms = CHECK_TIMEOUT) {
  if (ONLY && !name.includes(ONLY)) return;
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000} s`)), ms); });
  try { await Promise.race([fn(), limit]); results.push([true, name]); } catch (e) { results.push([e instanceof Skip ? 'skip' : false, name, String(e.message || e).split('\n')[0]]); } finally { clearTimeout(timer); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

let page;
try {
  page = await connect('index');
  const { send, ev } = page;
  await ev(`new Promise((r) => { const t = () => (document.querySelector('aside .nav-btn') ? r() : setTimeout(t, 100)); t(); })`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 820, deviceScaleFactor: 1, mobile: false });
  if (MAC) {
    // macOS slows the timers and animation frames of a window that is behind others (the build
    // machine's window is never in front): bring it forward and keep it running at full speed.
    const target = (await (await fetch(`http://127.0.0.1:${mainPort}/json`)).json())[0];
    const mws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { mws.addEventListener('open', r); mws.addEventListener('error', j); });
    const expression = "(() => { const { app, BrowserWindow } = require('electron'); const w = BrowserWindow.getAllWindows().find((x) => /index/.test(x.webContents.getURL())); app.focus({ steal: true }); w.webContents.setBackgroundThrottling(false); w.moveTop(); w.focus(); return true; })()";
    await new Promise((r) => { mws.addEventListener('message', r, { once: true }); mws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, includeCommandLineAPI: true, returnByValue: true } })); });
    mws.close();
  }
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

  // ------------------------------------------------------------ settings (pages, menu, search)
  const SP = '[data-scroll=page-settings]';
  // An update check started by an earlier check (opening the Updates page) can end at any moment and
  // add a banner above the page, moving everything down between aiming and clicking: wait for it.
  const updatesSettled = () => ev(`(async () => { const m = await import(new URL('app.js', document.baseURI).href); for (let i = 0; i < 150 && m.S.updates && m.S.updates.checking; i++) await new Promise((r) => setTimeout(r, 100)); })()`);
  const openSettings = async () => { await updatesSettled(); await ev(`[...document.querySelectorAll('aside .nav-btn')][6].click()`); await wait(500); };
  const setView = () => ev(`(() => {
    const page = document.querySelector('${SP}');
    const m = document.querySelector('.set-nav .subs.open .sub-marker');
    const on = document.querySelector('.set-nav .subs.open .sub.on');
    return {
      page: [...document.querySelectorAll('.set-nav .pg')].findIndex((b) => b.classList.contains('on')),
      shown: [...document.querySelectorAll('.set-pages > .pg-body')].findIndex((b) => b.classList.contains('shown')),
      sub: [...document.querySelectorAll('.set-nav .subs.open .sub')].findIndex((b) => b.classList.contains('on')),
      subs: document.querySelectorAll('.set-nav .subs.open .sub').length,
      heads: document.querySelectorAll('.pg-body.shown .sec-head').length,
      open: document.querySelectorAll('.set-nav .subs.open').length,
      marker: Boolean(m && on && Math.abs(m.getBoundingClientRect().top - on.getBoundingClientRect().top) < 2 && m.getBoundingClientRect().height > 20),
      scroll: Math.round(page.scrollTop), max: Math.round(page.scrollHeight - page.clientHeight),
    };
  })()`);
  const wheel = async (dy) => {
    // the edge of the pages column: on the cards, never over a text box (which would scroll itself)
    const [x, y] = await ev(`(() => { const r = document.querySelector('.set-pages').getBoundingClientRect(); return [Math.round(r.left + 5), 500]; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });
  };

  await check('settings: five pages in the side menu; the first is open with its subsections', async () => {
    await openSettings();
    await ev(`document.querySelectorAll('.set-nav .pg')[0].click()`); await wait(400);
    const n = await ev(`document.querySelectorAll('.set-nav .pg').length`);
    assert(n === 5, `${n} pages`);
    const v = await setView();
    assert(v.page === 0 && v.shown === 0, `open page ${v.page}, shown ${v.shown}`);
    assert(v.open === 1 && v.subs === v.heads && v.subs >= 2, `subsections in the menu ${v.subs}, on the page ${v.heads}, open menus ${v.open}`);
    assert(v.sub === 0 && v.marker, `subsection ${v.sub}, marker in place ${v.marker}`);
  });

  await check('settings: every page opens from the side menu with the mouse; its subsections unfold, the marker sits on the first', async () => {
    await openSettings();
    for (let i = 0; i < 5; i++) {
      // click only once the menu has stopped moving (the subsections of the last page fold up)
      let at = await center('.set-nav .pg', i);
      for (let k = 0; k < 20; k++) { await wait(80); const again = await center('.set-nav .pg', i); if (again[1] === at[1]) break; at = again; }
      const [x, y] = at;
      await click(x, y); await wait(450);
      const v = await setView();
      assert(v.page === i && v.shown === i, `clicked page ${i + 1} at ${x},${y}: open ${v.page + 1}, shown ${v.shown + 1}`);
      assert(v.open === 1 && v.subs === v.heads, `page ${i + 1}: ${v.subs} subsections in the menu, ${v.heads} on the page`);
      assert(v.sub === 0 && v.scroll === 0 && v.marker, `page ${i + 1}: subsection ${v.sub}, scroll ${v.scroll}, marker ${v.marker}`);
    }
    assert(page.errors.length === 0, `errors: ${page.errors.slice(0, 2).join(' | ')}`);
  });

  await check('settings: scrolling with the wheel walks the menu through every subsection in order, on every page, and back up', async () => {
    await openSettings();
    for (let p = 0; p < 5; p++) {
      const [x, y] = await center('.set-nav .pg', p);
      await click(x, y); await wait(450);
      for (const dir of [1, -1]) {
        const seen = [(await setView()).sub];
        for (let k = 0; k < 60; k++) {
          await wheel(100 * dir); await wait(60);
          const v = await setView();
          seen.push(v.sub);
          if (dir > 0 ? v.scroll >= v.max : v.scroll <= 0) break;
        }
        await wait(250);
        const order = seen.filter((s, i) => i === 0 || s !== seen[i - 1]);
        const v = await setView();
        const want = [...Array(v.heads).keys()];
        if (v.max < 1) { assert(order.join(',') === '0', `page ${p + 1} (no scrolling): ${order.join(' → ')}`); break; }
        if (dir < 0) want.reverse();
        assert(order.join(',') === want.join(','), `page ${p + 1} scrolling ${dir > 0 ? 'down' : 'up'}: ${order.join(' → ')} (scroll ${v.scroll} of ${v.max})`);
        assert(v.sub === (dir > 0 ? v.heads - 1 : 0) && v.marker, `page ${p + 1} at the ${dir > 0 ? 'bottom' : 'top'}: subsection ${v.sub + 1} of ${v.heads}, marker ${v.marker}`);
      }
    }
  }, 90000);

  await check('settings: clicking a subsection scrolls to its heading; the menu does not flicker on the way', async () => {
    await openSettings();
    await ev(`document.querySelectorAll('.set-nav .pg')[1].click()`); await wait(400);
    await ev(`document.querySelector('${SP}').scrollTop = 1e6`); await wait(300);
    const [x, y] = await center('.set-nav .subs.open .sub', 1);
    await click(x, y);
    const during = [];
    for (let k = 0; k < 10; k++) { await wait(40); during.push((await setView()).sub); }
    await wait(400);
    const v = await setView();
    const top = await ev(`Math.round(document.querySelectorAll('.pg-body.shown .sec-head')[1].getBoundingClientRect().top - document.querySelector('${SP}').getBoundingClientRect().top)`);
    assert([...new Set(during)].join(',') === '1', `menu during the scroll: ${[...new Set(during)].join(',')}`);
    assert(v.sub === 1 && v.marker, `after: subsection ${v.sub}, marker ${v.marker}`);
    assert(top >= 0 && top < 40, `heading is ${top}px from the top`);
    // every subsection in turn: after its scroll the menu stays on it, even after another scroll event
    const n = await ev(`document.querySelectorAll('.set-nav .subs.open .sub').length`);
    for (let s = n - 1; s >= 0; s--) {
      const [xs, ys] = await center('.set-nav .subs.open .sub', s);
      await click(xs, ys); await wait(700);
      await ev(`document.querySelector('${SP}').dispatchEvent(new Event('scroll'))`); await wait(50);
      const vs = await setView();
      assert(vs.sub === s && vs.marker, `clicked subsection ${s + 1}: the menu shows ${vs.sub + 1} (scroll ${vs.scroll} of ${vs.max})`);
    }
    // the first subsection goes back to the very top
    const [x0, y0] = await center('.set-nav .subs.open .sub', 0);
    await click(x0, y0); await wait(700);
    const v0 = await setView();
    assert(v0.sub === 0 && v0.scroll === 0, `first subsection: ${v0.sub}, scroll ${v0.scroll}`);
  });

  await check('settings: previous / next buttons at the bottom of the pages (none before the first or after the last)', async () => {
    await openSettings();
    for (let i = 0; i < 5; i++) {
      await ev(`document.querySelectorAll('.set-nav .pg')[${i}].click()`); await wait(300);
      const has = await ev(`({ prev: Boolean(document.querySelector('.pg-body.shown .pg-nav .prev')), next: Boolean(document.querySelector('.pg-body.shown .pg-nav .next')) })`);
      assert(has.prev === (i > 0) && has.next === (i < 4), `page ${i + 1}: previous ${has.prev}, next ${has.next}`);
    }
    await ev(`document.querySelectorAll('.set-nav .pg')[1].click()`); await wait(300);
    await ev(`document.querySelector('${SP}').scrollTop = 1e6`); await wait(200);
    let [x, y] = await center('.pg-body.shown .pg-nav .next');
    await click(x, y); await wait(450);
    let v = await setView();
    assert(v.page === 2 && v.scroll === 0 && v.sub === 0, `next: page ${v.page + 1}, scroll ${v.scroll}, subsection ${v.sub}`);
    await ev(`document.querySelector('${SP}').scrollTop = 1e6`); await wait(200);
    [x, y] = await center('.pg-body.shown .pg-nav .prev');
    await click(x, y); await wait(450);
    v = await setView();
    assert(v.page === 1 && v.scroll === 0, `previous: page ${v.page + 1}, scroll ${v.scroll}`);
  });

  await check('settings: the arrows on previous / next point outwards in right-to-left and left-to-right', async () => {
    await openSettings();
    await ev(`document.querySelectorAll('.set-nav .pg')[1].click()`); await wait(300);
    // which way the arrow points on screen: rotated "down" chevron → b of the matrix (1: left, -1: right)
    const dirs = () => ev(`(() => {
      const way = (sel) => { const m = new DOMMatrix(getComputedStyle(document.querySelector(sel)).transform); return Math.round(m.b) === 1 ? 'left' : Math.round(m.b) === -1 ? 'right' : 'down'; };
      const side = (sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return b.left + b.width / 2 < document.querySelector('.pg-body.shown .pg-nav').getBoundingClientRect().left + document.querySelector('.pg-body.shown .pg-nav').getBoundingClientRect().width / 2 ? 'left' : 'right'; };
      return { next: way('.pg-body.shown .pg-nav .next .icon'), prev: way('.pg-body.shown .pg-nav .prev .icon'), nextSide: side('.pg-body.shown .pg-nav .next'), prevSide: side('.pg-body.shown .pg-nav .prev'), adv: way('.pg-body.shown .adv:not(.open) .adv-head .icon') };
    })()`);
    const fa = await dirs();
    assert(fa.next === 'left' && fa.nextSide === 'left' && fa.prev === 'right' && fa.prevSide === 'right', `Persian: ${JSON.stringify(fa)}`);
    assert(fa.adv === 'left', `Persian: closed "Advanced" arrow points ${fa.adv}`);
    await setSettings({ language: 'en' }); await wait(300);
    const en = await dirs();
    await setSettings({ language: 'fa' }); await wait(300);
    assert(en.next === 'right' && en.nextSide === 'right' && en.prev === 'left' && en.prevSide === 'left', `English: ${JSON.stringify(en)}`);
    assert(en.adv === 'right', `English: closed "Advanced" arrow points ${en.adv}`);
  });

  await check('settings: an "Advanced" box opens and closes with the mouse, and stays open through a redraw', async () => {
    await openSettings();
    await ev(`document.querySelectorAll('.set-nav .pg')[1].click()`); await wait(300);
    const SEL = '.pg-body.shown .adv[data-adv=tun]';
    await ev(`document.querySelector('${SEL}').scrollIntoView({ block: 'center' })`); await wait(200);
    const visible = () => ev(`(() => { const i = document.querySelector('input[data-keep="set-tunMtu"]'); return Boolean(i && i.offsetWidth); })()`);
    assert(!(await visible()), 'MTU visible before opening');
    let [x, y] = await center(`${SEL} .adv-head`);
    await click(x, y); await wait(250);
    assert(await visible(), 'MTU not visible after opening');
    await setSettings({ density: 'compact' }); await setSettings({ density: 'comfortable' });
    assert(await visible(), 'closed again by a redraw');
    [x, y] = await center(`${SEL} .adv-head`);
    await click(x, y); await wait(250);
    assert(!(await visible()), 'did not close');
  });

  await check('settings: a redraw keeps the open page, the subsection and the scroll', async () => {
    await openSettings();
    await ev(`document.querySelectorAll('.set-nav .pg')[1].click()`); await wait(300);
    await ev(`document.querySelectorAll('.set-nav .subs.open .sub')[2].click()`); await wait(700);
    const before = await setView();
    await setSettings({ density: 'compact' });
    const after = await setView();
    await setSettings({ density: 'comfortable' });
    assert(after.page === 1 && after.sub === 2 && Math.abs(after.scroll - before.scroll) <= 1 && after.marker, `before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);
  });

  await check('settings: a setting changed from its default gets a dot, and its page in the menu too', async () => {
    await openSettings();
    await setSettings({ mux: true });
    const on = await ev(`({ page: document.querySelectorAll('.set-nav .pg .mod-dot')[4].classList.contains('on'), label: document.querySelector('.switch-row[data-s=mux] .txt span').classList.contains('changed'), others: [...document.querySelectorAll('.set-nav .pg .mod-dot')].slice(0, 4).map((d) => d.classList.contains('on')) })`);
    await setSettings({ mux: false });
    const off = await ev(`({ page: document.querySelectorAll('.set-nav .pg .mod-dot')[4].classList.contains('on'), label: document.querySelector('.switch-row[data-s=mux] .txt span').classList.contains('changed') })`);
    assert(on.page && on.label, `after turning Mux on: page dot ${on.page}, setting dot ${on.label}`);
    assert(!off.page && !off.label, `after turning it back: page dot ${off.page}, setting dot ${off.label}`);
  });

  await check('settings search: a setting on another page — clicked in the list, its page opens and it glows on screen', async () => {
    await openSettings();
    await ev(`document.querySelectorAll('.set-nav .pg')[0].click()`); await wait(300);
    const box = await center('.set-find input');
    await click(box[0], box[1]);
    await send('Input.insertText', { text: 'webdav' }); await wait(250);
    const n = await ev(`document.querySelectorAll('.set-find-item').length`);
    assert(n > 0, 'no results for "webdav"');
    const where = await ev(`document.querySelector('.set-find-item .set-find-sec').textContent`);
    assert(where.includes('›'), `result has no page › section: ${where}`);
    const first = await center('.set-find-item');
    await click(first[0], first[1]); await wait(700);
    const r = await ev(`(() => { const t = document.querySelector('.set-flash'); if (!t) return null; const b = t.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: innerHeight, list: Boolean(document.querySelector('.set-find-list')) }; })()`);
    assert(r, `nothing highlighted (results: ${n}, page ${(await setView()).page + 1})`);
    assert((await setView()).page === 3, `opened page ${(await setView()).page + 1}, not Backup`);
    assert(r.top >= 0 && r.bottom <= r.h, 'highlighted setting is not on screen');
    assert(!r.list, 'result list still open');
    await ev(`(() => { const i = document.querySelector('.set-find input'); i.value = ''; i.blur(); })()`);
  });

  await check('settings search: a setting inside a closed "Advanced" box — Enter opens its page and the box, and it glows', async () => {
    await openSettings();
    await ev(`document.querySelectorAll('.set-nav .pg')[0].click()`); await wait(300);
    const box = await center('.set-find input');
    await click(box[0], box[1]);
    await send('Input.insertText', { text: 'MTU' }); await wait(250);
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await wait(700);
    const v = await setView();
    const r = await ev(`(() => { const t = document.querySelector('.set-flash'); if (!t) return null; const b = t.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: innerHeight, open: Boolean(t.closest('.adv.open')) }; })()`);
    assert(v.page === 1 && v.sub === 1 && v.marker, `page ${v.page + 1}, subsection ${v.sub}, marker ${v.marker}`);
    assert(r && r.open && r.top >= 0 && r.bottom <= r.h, `highlight ${JSON.stringify(r)}`);
    await ev(`(() => { const i = document.querySelector('.set-find input'); i.value = ''; i.blur(); })()`);
    await ev(`document.querySelector('.adv[data-adv=tun] .adv-head').click()`);
  });

  await check('settings: Ctrl+F puts the cursor in the settings search without moving the page; Escape leaves it', async () => {
    await openSettings();
    await ev(`document.querySelectorAll('.set-nav .pg')[1].click()`); await wait(300);
    await ev(`document.querySelector('${SP}').scrollTop = 500`); await wait(150);
    const before = (await setView()).scroll;
    // the "Ctrl F" label sits at the far end of the box, clear of the magnifier and of the text
    for (const lang of ['fa', 'en']) {
      await setSettings({ language: lang }); await wait(250);
      const k = await ev(`(() => { const r = (sel) => document.querySelector(sel).getBoundingClientRect(); const ic = r('.set-find > .icon'), kb = r('.set-find .find-kbd'), box = r('.set-find .input'); const pad = parseFloat(getComputedStyle(document.querySelector('.set-find .input')).paddingInlineEnd); const rtl = document.documentElement.dir === 'rtl'; return { apart: kb.right < ic.left || kb.left > ic.right, endSide: rtl ? kb.left < ic.left : kb.left > ic.left, room: pad >= kb.width + 8 }; })()`);
      assert(k.apart && k.endSide && k.room, `${lang}: Ctrl F label ${JSON.stringify(k)}`);
    }
    await setSettings({ language: 'fa' }); await wait(250);
    await ev(`document.querySelector('${SP}').scrollTop = 500`); await wait(150);
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: CMD_BIT });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: CMD_BIT });
    await wait(200);
    const r = await ev(`({ focused: document.activeElement === document.querySelector('.set-find input'), scroll: Math.round(document.querySelector('${SP}').scrollTop) })`);
    assert(r.focused, 'search box not focused');
    assert(Math.abs(r.scroll - before) <= 1, `page moved from ${before} to ${r.scroll}`);
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await wait(150);
    assert(!(await ev(`document.activeElement === document.querySelector('.set-find input')`)), 'Escape did not leave the box');
  });

  await check('settings: narrow window — pages and subsections move to two rows on top and follow the scroll', async () => {
    await openSettings();
    await send('Emulation.setDeviceMetricsOverride', { width: 860, height: 820, deviceScaleFactor: 1, mobile: false });
    await wait(600);
    try {
      const shape = await ev(`({ top: Boolean(document.querySelector('.set-top')), side: Boolean(document.querySelector('.set-side')), find: Boolean(document.querySelector('.page-head .set-find')) })`);
      assert(shape.top && !shape.side && shape.find, `narrow layout: ${JSON.stringify(shape)}`);
      const [x, y] = await center('.set-top .row1 button', 1);
      await click(x, y); await wait(450);
      const r1 = await ev(`[...document.querySelectorAll('.set-top .row1 button')].findIndex((b) => b.classList.contains('on'))`);
      assert(r1 === 1, `pages row: ${r1}`);
      await ev(`document.querySelector('${SP}').scrollTop = 1e6`); await wait(400);
      const r = await ev(`(() => { const b = [...document.querySelectorAll('.set-top .row2 button')]; const on = b.findIndex((x) => x.classList.contains('on')); const bar = document.querySelector('.set-top .bar'); const page = document.querySelector('${SP}'); return { on, n: b.length, bar: Math.abs(parseFloat(bar.style.left) - b[on].offsetLeft) < 1 && parseFloat(bar.style.width) > 10, hscroll: page.scrollWidth > page.clientWidth, sticky: Math.round(document.querySelector('.set-top').getBoundingClientRect().top - page.getBoundingClientRect().top) }; })()`);
      assert(r.on === r.n - 1 && r.bar, `subsections row at the bottom: ${r.on + 1} of ${r.n}, underline under it ${r.bar}`);
      assert(!r.hscroll, 'the page scrolls sideways');
      assert(r.sticky <= 0, `rows not stuck to the top (${r.sticky}px)`);
      const [x2, y2] = await center('.set-top .row2 button', 0);
      await click(x2, y2); await wait(700);
      assert((await ev(`Math.round(document.querySelector('${SP}').scrollTop)`)) === 0, 'first subsection did not scroll to the top');
    } finally {
      await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 820, deviceScaleFactor: 1, mobile: false });
      await wait(600);
    }
    assert(await ev(`Boolean(document.querySelector('.set-side'))`), 'side menu did not come back when wide again');
  });

  await check('settings: a one-line note with a button has its text in the middle of the box', async () => {
    await openSettings();
    await ev(`document.querySelectorAll('.set-nav .pg')[1].click()`); await wait(300);
    const r = await ev(`(() => { const n = [...document.querySelectorAll('.pg-body.shown .note')].find((x) => x.querySelector(':scope > .btn')); if (!n) return null; const b = n.getBoundingClientRect(); const s = n.querySelector('.grow').getBoundingClientRect(); return Math.abs((b.top + b.bottom) / 2 - (s.top + s.bottom) / 2); })()`);
    if (r === null) throw new Skip('running as administrator: no note with a button');
    assert(r <= 1.5, `text is ${r}px off the middle`);
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

  await check('dropdown arrow: up while its menu is open (also through a redraw), down after every way of closing', async () => {
    await ev(`[...document.querySelectorAll('aside .nav-btn')][0].click()`); await wait(400);
    const btn = await center('#routing-sel');
    const state = () => ev(`({ open: Boolean(document.querySelector('.menu')), arrow: document.querySelector('#routing-sel').getAttribute('aria-expanded') })`);
    const expect = async (open, step) => { const s = await state(); assert(s.open === open && s.arrow === String(open), `${step}: menu ${s.open ? 'open' : 'closed'}, arrow ${s.arrow === 'true' ? 'up' : 'down'}`); };
    await click(btn[0], btn[1]); await wait(250); await expect(true, 'opened');
    await setSettings({ testConcurrency: 7 }); await expect(true, 'redraw while open');
    await click(btn[0], btn[1]); await wait(250); await expect(false, 'second click on the button');
    await click(btn[0], btn[1]); await wait(250); await expect(true, 'opened again');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await wait(250); await expect(false, 'Escape');
    await click(btn[0], btn[1]); await wait(250);
    const cur = await ev(`document.querySelector('#routing-sel .select-label').textContent.trim()`);
    const i = await ev(`[...document.querySelectorAll('.menu [role=option]')].findIndex((b) => b.textContent.trim() !== ${JSON.stringify(cur)})`);
    const op = await ev(`(() => { const r = document.querySelectorAll('.menu [role=option]')[${i}].getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
    await click(op[0], op[1]); await wait(400); await expect(false, 'after choosing');
    await click(btn[0], btn[1]); await wait(250);
    const away = await center('.conn-name .name'); // plain text, away from the side menu
    await click(away[0], away[1]); await wait(250); await expect(false, 'click elsewhere');
    await setSettings({ testConcurrency: 8 });
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

  await check('side menu: no window-drag area inside it; the logo is a GitHub button', async () => {
    // Windows sends a page no mouse events over a drag area (it acts as the title bar): passing over
    // one closed the open-on-hover menu. Synthetic test input never sees that, so check the styles.
    // The check must see a drag area where there is one (the title bar), or it proves nothing.
    assert(await ev(`(() => { const s = getComputedStyle(document.querySelector('.titlebar')); return s.webkitAppRegion === 'drag' || s.getPropertyValue('app-region') === 'drag'; })()`), 'drag areas cannot be detected');
    for (const collapsed of [true, false]) {
      await setSettings({ sidebarCollapsed: collapsed }); await wait(300);
      const drag = await ev(`[...document.querySelectorAll('aside.sidebar, aside.sidebar *')].filter((e) => getComputedStyle(e).webkitAppRegion === 'drag' || getComputedStyle(e).getPropertyValue('app-region') === 'drag').map((e) => e.className || e.tagName)`);
      assert(!drag.length, `${collapsed ? 'unpinned' : 'pinned'}: drag areas in the side menu: ${drag.join(', ')}`);
    }
    const logo = await ev(`(() => { const b = document.querySelector('aside .brand-logo'); return b ? { tag: b.tagName, label: b.getAttribute('aria-label'), img: Boolean(b.querySelector('img')) } : null; })()`);
    assert(logo && logo.tag === 'BUTTON' && logo.img && /GitHub|گیت‌هاب/.test(logo.label), `logo: ${JSON.stringify(logo)}`);
    await setSettings({ sidebarCollapsed: true });
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

  await check('side menu: stays closed when the window comes back from the taskbar (focus was on a menu button)', async () => {
    await setSettings({ sidebarCollapsed: true });
    await move(600, 400); await wait(300);
    const [bx, by] = await center('aside .nav .nav-btn:not(.nav-help)', 1);
    await move(bx, by); await wait(300);
    await click(bx, by); await wait(300);
    await move(600, 400); await wait(500);
    const before = await ev(`({ inMenu: Boolean(document.activeElement && document.activeElement.closest('aside')), open: document.querySelector('aside').classList.contains('peek') })`);
    assert(before.inMenu, 'the click did not leave the focus on the menu button (test setup)');
    assert(!before.open, 'menu still open after the mouse left (test setup)');
    // Minimize and restore the real window (as from the taskbar), from the main process.
    const target = (await (await fetch(`http://127.0.0.1:${mainPort}/json`)).json())[0];
    const mws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { mws.addEventListener('open', r); mws.addEventListener('error', j); });
    let mid = 0;
    const inMain = (expression) => new Promise((r) => { const n = ++mid; const on = (m) => { const msg = JSON.parse(m.data); if (msg.id === n) { mws.removeEventListener('message', on); r(msg.result && msg.result.result && msg.result.result.value); } }; mws.addEventListener('message', on); mws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, includeCommandLineAPI: true, returnByValue: true } })); });
    const win = "require('electron').BrowserWindow.getAllWindows().find((w) => /index/.test(w.webContents.getURL()))";
    try {
      await inMain(`(${win}).minimize()`);
      // macOS minimizes with an animation: the state changes a moment later
      for (let i = 0; i < 20 && !(await inMain(`(${win}).isMinimized()`)); i++) await wait(150);
      assert(await inMain(`(${win}).isMinimized()`), 'window did not minimize');
      await wait(700);
    } finally {
      // always brought back: a window left minimized slows every later check down
      await inMain(`(${win}).restore(), (${win}).focus()`).catch(() => {}); await wait(900);
      mws.close();
    }
    const after = await ev(`({ open: document.querySelector('aside').classList.contains('peek'), w: Math.round(document.querySelector('aside .side-panel').getBoundingClientRect().width) })`);
    assert(!after.open && after.w < 100, `menu opened by itself after the window came back (width ${after.w})`);
    await ev('document.activeElement && document.activeElement.blur()');
    await ev(`[...document.querySelectorAll('aside .nav-btn')][0].click()`); await wait(300);
  });

  await check('theme "follow Windows": the window buttons change colour with Windows light / dark', async () => {
    if (MAC) throw new Skip('macOS draws its own window buttons');
    await setSettings({ theme: 'system' });
    const target = (await (await fetch(`http://127.0.0.1:${mainPort}/json`)).json())[0];
    const mws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { mws.addEventListener('open', r); mws.addEventListener('error', j); });
    let mid = 0;
    const inMain = (expression) => new Promise((r) => { const n = ++mid; const on = (m) => { const msg = JSON.parse(m.data); if (msg.id === n) { mws.removeEventListener('message', on); r(msg.result && msg.result.result && msg.result.result.value); } }; mws.addEventListener('message', on); mws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, includeCommandLineAPI: true, returnByValue: true } })); });
    const win = "require('electron').BrowserWindow.getAllWindows().find((w) => /index/.test(w.webContents.getURL()))";
    try {
      // record what the window buttons are given, then let "Windows" switch (Electron's nativeTheme)
      await inMain(`(() => { const w = ${win}; const set = w.setTitleBarOverlay.bind(w); globalThis.__overlay = []; w.setTitleBarOverlay = (o) => { globalThis.__overlay.push(o.color + '/' + o.symbolColor); return set(o); }; })()`);
      // switch to the opposite of what Windows uses now, then back (a switch to the same mode is no change)
      const darkNow = await inMain(`require('electron').nativeTheme.shouldUseDarkColors`);
      const [first, second] = darkNow ? ['light', 'dark'] : ['dark', 'light'];
      await inMain(`require('electron').nativeTheme.themeSource = '${first}'`); await wait(500);
      await inMain(`require('electron').nativeTheme.themeSource = '${second}'`); await wait(500);
      const seen = await inMain('globalThis.__overlay');
      assert(Array.isArray(seen) && seen.length >= 2, `window buttons not updated: ${JSON.stringify(seen)}`);
      const light = (c) => /^#F5F6F8\//i.test(c);
      assert(light(seen[0]) === (first === 'light') && light(seen[seen.length - 1]) === (second === 'light'), `wrong colours: ${JSON.stringify(seen)}`);
      // the page itself follows too (to the mode applied last)
      await wait(300);
      const pageLight = await ev(`getComputedStyle(document.body).backgroundColor === 'rgb(245, 246, 248)'`);
      assert(pageLight === (second === 'light'), `page did not follow Windows to ${second}`);
    } finally {
      await inMain(`require('electron').nativeTheme.themeSource = 'system'`).catch(() => {});
      mws.close();
      await setSettings({ theme: 'dark' });
    }
  });

  await check('side menu: pinning animates the page width (no jump) and is remembered', async () => {
    // The Mac build machine draws a window that is on no real screen only now and then: frames of a
    // CSS transition cannot be counted there (the same CSS is counted on Windows).
    if (MAC && process.env.CI) throw new Skip('animation frames are not drawn reliably on the build machine');
    const [rx] = await center('.brand img');
    await move(rx, 300); await wait(450);
    const pin = await center('.side-toggle');
    await ev(`window.__w = []; (function f(){ window.__w.push(Math.round(document.querySelector('main').getBoundingClientRect().width)); if (window.__w.length < 45) requestAnimationFrame(f); })()`);
    await click(pin[0], pin[1]); await wait(700);
    const steps = await ev(`new Set(window.__w).size`);
    assert(steps >= 6, `page width changed in ${steps} step(s)`);
    assert(!(await ev(`best.getState().then((s) => s.settings.sidebarCollapsed)`)), 'pin not saved');
  });

  await check('side menu: with a long test-version number, the pin button stays inside the menu in every language', async () => {
    await setSettings({ sidebarCollapsed: false });
    const bad = [];
    for (const lang of ['fa', 'en', 'ru', 'zh']) {
      await setSettings({ language: lang });
      const r = await ev(`(async () => {
        const m = await import(new URL('app.js', document.baseURI).href);
        m.S.version = '10.12.13-beta.14'; m.render();
        const p = document.querySelector('aside .side-panel').getBoundingClientRect(); const b = document.querySelector('.side-toggle').getBoundingClientRect();
        return { inside: b.left >= p.left - 0.5 && b.right <= p.right + 0.5, mark: Boolean(document.querySelector('.brand-name .beta-pill')) };
      })()`);
      if (!r.inside) bad.push(`${lang}: pin button outside the menu`);
      if (!r.mark) bad.push(`${lang}: no test-version mark`);
    }
    await setSettings({ language: 'fa' });
    await ev(`(async () => { const m = await import(new URL('app.js', document.baseURI).href); m.S.version = (await best.getState()).version || m.S.version; m.render(); })()`);
    assert(!bad.length, bad.join('; '));
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
    await ev(`document.querySelectorAll('.set-nav .pg')[2].click()`); await wait(300);
    await ev(`(() => { const a = document.querySelector('.adv[data-adv=tests]'); if (!a.classList.contains('open')) a.querySelector('.adv-head').click(); })()`);
    await ev(`(() => { const i = document.querySelector('input[data-keep="set-testUrl"]'); i.focus(); i.value = 'https://example.org/typing'; })()`);
    await setSettings({ density: 'compact' });
    const r = await ev(`(() => { const i = document.querySelector('input[data-keep="set-testUrl"]'); return { v: i.value, focused: document.activeElement === i }; })()`);
    await ev('document.activeElement.blur()'); await setSettings({ density: 'comfortable' });
    assert(r.v === 'https://example.org/typing', `value lost: ${r.v}`);
    assert(r.focused, 'focus lost');
  });

  await check('number box arrows: a click steps once, holding keeps counting, saved once on release', async () => {
    await ev(`[...document.querySelectorAll('aside .nav-btn')][6].click()`); await wait(400);
    await ev(`document.querySelectorAll('.set-nav .pg')[2].click()`); await wait(300);
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
    for (const p of [{ language: 'en' }, { language: 'ru' }, { language: 'zh' }, { theme: 'light' }, { theme: 'midnight' }, { language: 'fa', theme: 'dark' }]) await setSettings(p);
    const title = await ev(`document.querySelector('aside .nav-btn .nav-label').textContent`);
    assert(title === 'سرورها', `menu text after switching back: ${title}`);
    assert(page.errors.length === before, `errors: ${page.errors.slice(before).join(' | ')}`);
  });

  await check('every language on every page: no untranslated keys, no clipped buttons, the right font', async () => {
    const before = page.errors.length;
    const bad = [];
    for (const lang of ['en', 'ru', 'zh', 'fa']) {
      await setSettings({ language: lang }); await wait(300);
      const n = await ev(`document.querySelectorAll('aside .nav-btn:not(.nav-help)').length`);
      for (let p = 0; p < n; p++) {
        await ev(`[...document.querySelectorAll('aside .nav-btn:not(.nav-help)')][${p}].click()`); await wait(450);
        const subPages = Math.max(1, await ev(`document.querySelectorAll('.set-nav .pg').length`));
        for (let k = 0; k < subPages; k++) {
        if (subPages > 1) { await ev(`document.querySelectorAll('.set-nav .pg')[${k}].click()`); await wait(300); await ev(`document.querySelectorAll('.pg-body.shown .adv:not(.open) > .adv-head').forEach((b) => b.click())`); await wait(100); }
        const r = await ev(`(() => {
          const text = document.body.innerText;
          // t() shows the key itself when a translation is missing: snake_case words like upd_help
          const keys = [...new Set(text.match(/\\b[a-z]{2,}_[a-zA-Z_]{2,}\\b/g) || [])].filter((k) => !/^(geoip|geosite|full|keyword|regexp|domain|xtls|ip_|http_)/.test(k));
          const clipped = [...document.querySelectorAll('main button, aside button, main .seg-btn, main .tab')]
            .filter((b) => b.offsetParent && b.scrollWidth > b.clientWidth + 2 && getComputedStyle(b).textOverflow !== 'ellipsis' && ![...b.querySelectorAll('*')].some((c) => getComputedStyle(c).textOverflow === 'ellipsis'))
            .map((b) => b.textContent.trim().slice(0, 30));
          return { keys, clipped, lang: document.documentElement.lang, font: getComputedStyle(document.body).fontFamily, cjk: /[\\u4e00-\\u9fff]/.test(text) };
        })()`);
        const where = `${lang} page ${p + 1}${subPages > 1 ? `.${k + 1}` : ''}`;
        if (r.lang !== lang) bad.push(`${where}: html lang is ${r.lang}`);
        if (r.keys.length) bad.push(`${where}: untranslated ${r.keys.slice(0, 4).join(', ')}`);
        if (r.clipped.length) bad.push(`${where}: clipped ${r.clipped.slice(0, 3).join(' | ')}`);
        if (lang === 'zh' && (!r.cjk || !/YaHei/.test(r.font))) bad.push(`${where}: Chinese text ${r.cjk} font ${r.font}`);
        }
      }
    }
    await setSettings({ language: 'fa' });
    const errs = page.errors.slice(before);
    assert(!bad.length && !errs.length, [...bad.slice(0, 8), ...errs.slice(0, 2)].join(' | '));
  }, 180000);

  // ------------------------------------------------------------ every control in the forms
  // Real clicks on every dropdown, switch and choice button of a dialog: the choice must show at
  // once, even when the form does not redraw (a dropdown once kept showing the old value).
  await ev(`window.__skip = '[data-s="autoStart"], [data-s="allowLan"], [data-s="tun"], [data-s="globalHotkey"], [data-s="autoCheckUpdates"], .ctl-proxy, .tun-btn, .ctl:has(.tun-btn)';
    window.__list = (sel) => [...document.querySelectorAll(sel)].filter((x) => !x.closest(window.__skip)); // never touch what changes Windows itself
    window.__pt = (sel, i) => { const e = window.__list(sel)[i]; if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; };
    window.__key = (el) => { const f = el.closest('.field, .switch-row, .ctl'); const l = f && f.querySelector('.field-label, .txt span, .section-label'); return l ? l.textContent.trim() : ''; };`);
  async function sweep(root, where) {
    const bad = [];
    // dropdowns
    for (let i = 0; i < 40; i++) {
      const sel = `${root} .select-btn`;
      const pos = await ev(`window.__pt(${JSON.stringify(sel)}, ${i})`);
      if (!pos) break;
      const key = await ev(`window.__key(window.__list(${JSON.stringify(sel)})[${i}]) || '#${i}'`);
      const before = await ev(`window.__list(${JSON.stringify(sel)})[${i}].querySelector('.select-label').textContent`);
      await click(pos[0], pos[1]); await wait(200);
      const opts = await ev(`[...document.querySelectorAll('.menu [role=option]')].map((b) => b.textContent.trim())`);
      const pick = opts.findIndex((o) => o && o !== before.trim());
      if (pick < 0) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await wait(150); continue; }
      const op = await ev(`(() => { const e = document.querySelectorAll('.menu [role=option]')[${pick}]; if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
      if (!op) { bad.push(`${where} › ${key}: its menu closed before a choice`); continue; }
      await click(op[0], op[1]); await wait(200);
      const now = await ev(`(() => { const all = [...window.__list(${JSON.stringify(sel)})]; const b = all.find((x) => (window.__key(x) || '') === ${JSON.stringify(key)}) || all[${i}]; return b ? b.querySelector('.select-label').textContent.trim() : '(gone)'; })()`);
      // A choice saved by the main process may show the old value for a moment while an earlier
      // update is still arriving; it must be right after a second at the latest.
      let shown = now;
      if (shown !== opts[pick]) { await wait(1000); shown = await ev(`(() => { const all = [...window.__list(${JSON.stringify(sel)})]; const b = all.find((x) => (window.__key(x) || '') === ${JSON.stringify(key)}) || all[${i}]; return b ? b.querySelector('.select-label').textContent.trim() : '(gone)'; })()`); }
      if (shown !== opts[pick]) bad.push(`${where} › ${key}: picked “${opts[pick]}”, shows “${shown}”`);
    }
    // switches: on, then back
    for (let i = 0; i < 30; i++) {
      const sel = `${root} button[role=switch]:not([disabled])`;
      const pos = await ev(`window.__pt(${JSON.stringify(sel)}, ${i})`);
      if (!pos) break;
      const key = await ev(`window.__key(window.__list(${JSON.stringify(sel)})[${i}]) || '#${i}'`);
      const state = () => ev(`(() => { const all = [...window.__list(${JSON.stringify(sel)})]; const b = all.find((x) => window.__key(x) === ${JSON.stringify(key)}) || all[${i}]; return b ? b.getAttribute('aria-checked') : null; })()`);
      const a = await state();
      await click(pos[0], pos[1]); await wait(200);
      const b = await state();
      const pos2 = await ev(`(() => { const all = [...window.__list(${JSON.stringify(sel)})]; const x = all.find((y) => window.__key(y) === ${JSON.stringify(key)}) || all[${i}]; if (!x) return null; x.scrollIntoView({ block: 'center' }); const r = x.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
      if (!pos2) { bad.push(`${where} › switch ${key}: gone after one click`); continue; }
      await click(pos2[0], pos2[1]); await wait(200);
      const c = await state();
      if (b === a || c !== a) bad.push(`${where} › switch ${key}: ${a} → ${b} → ${c}`);
    }
    // choice buttons: press one that is not pressed
    for (let g = 0; g < 10; g++) {
      const n = await ev(`(() => { const s = window.__list(${JSON.stringify(`${root} .seg`)})[${g}]; if (!s) return -1; return [...s.children].findIndex((b) => b.getAttribute('aria-pressed') !== 'true'); })()`);
      if (n === -1) { if (!(await ev(`Boolean(window.__list(${JSON.stringify(`${root} .seg`)})[${g}])`))) break; continue; }
      const label = await ev(`window.__list(${JSON.stringify(`${root} .seg`)})[${g}].children[${n}].textContent`);
      if (label === 'JSON') continue; // switching the editor to its JSON view is covered elsewhere
      const pos = await ev(`(() => { const b = window.__list(${JSON.stringify(`${root} .seg`)})[${g}].children[${n}]; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
      await click(pos[0], pos[1]); await wait(200);
      const ok = await ev(`window.__list(${JSON.stringify(`${root} .seg-btn[aria-pressed="true"]`)}).some((b) => b.textContent === ${JSON.stringify(label)})`);
      if (!ok) bad.push(`${where} › choice “${label}” not shown as chosen`);
    }
    return bad;
  }

  await check('server editor: every dropdown, switch and choice shows at once, for every protocol', async () => {
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyN', key: 'n', ${CMD_PROP}: true, bubbles: true }))`); await wait(500);
    assert(await ev(`Boolean(document.querySelector('.drawer'))`), 'editor did not open');
    const protos = await ev(`[...document.querySelectorAll('.drawer .ed-proto')].map((b) => b.textContent)`);
    const bad = [];
    for (let p = 0; p < protos.length; p++) {
      if (protos[p] === 'JSON') continue; // a text box only
      const pos = await ev(`window.__pt('.drawer .ed-proto', ${p})`);
      if (!pos) { bad.push(`protocol button ${protos[p]} not found`); continue; }
      await click(pos[0], pos[1]); await wait(250);
      bad.push(...(await sweep('.drawer', protos[p])));
    }
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await wait(400);
    if (await ev(`Boolean(document.querySelector('.drawer'))`)) { await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await wait(400); }
    assert(!bad.length, bad.slice(0, 6).join(' | '));
  }, 240000);

  await check('subscription editor: every dropdown and switch shows at once (switch also turns back)', async () => {
    await ev(`best.importText('vless://b831381d-6324-4d53-ad4f-8cda48b30811@127.0.0.1:10?security=none&type=tcp#ui-front')`); // not the ui-test server (a duplicate is skipped)
    await ev(`[...document.querySelectorAll('aside .nav-btn')][0].click()`); await wait(400);
    const add = await ev(`window.__pt('.tab-add', 0)`);
    await click(add[0], add[1]); await wait(500);
    const root = await ev(`document.querySelector('.modal') ? '.modal' : document.querySelector('.drawer') ? '.drawer' : ''`);
    assert(root, 'subscription editor did not open');
    const bad = await sweep(root, 'subscription');
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await wait(400);
    assert(!bad.length, bad.slice(0, 6).join(' | '));
  }, 120000);

  await check('subscription editor: "pre-resolve server names" is chosen with the mouse and saved', async () => {
    const T = (k) => ev(`import(new URL('i18n.js', document.baseURI).href).then((m) => m.t(${JSON.stringify(k)}))`);
    const [label, save] = await Promise.all([T('sub_preResolve'), T('save')]);
    await ev(`[...document.querySelectorAll('aside .nav-btn')][0].click()`); await wait(400);
    const add = await ev(`window.__pt('.tab-add', 0)`);
    await click(add[0], add[1]); await wait(500);
    const url = await ev(`(() => { const i = document.querySelector('.drawer input[placeholder^="https"]'); const r = i.getBoundingClientRect(); return [Math.round(r.left + 30), Math.round(r.top + r.height / 2)]; })()`);
    await click(url[0], url[1]); await send('Input.insertText', { text: 'https://sub.example.com/ui-preresolve' }); await wait(150);
    const btn = await ev(`(() => { const f = [...document.querySelectorAll('.drawer .field')].find((x) => x.querySelector('.field-label')?.textContent === ${JSON.stringify(label)}); const b = f && f.querySelector('.select-btn'); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
    assert(btn, 'no pre-resolve choice in the editor');
    await click(btn[0], btn[1]); await wait(250);
    const opt = await ev(`(() => { const o = [...document.querySelectorAll('.menu [role=option]')].find((x) => x.textContent.includes('1.1.1.1')); if (!o) return null; const r = o.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
    assert(opt, 'the Cloudflare option is missing');
    await click(opt[0], opt[1]); await wait(250);
    const sv = await ev(`(() => { const b = [...document.querySelectorAll('.drawer button')].find((x) => x.textContent.trim() === ${JSON.stringify(save)}); const r = b.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
    await click(sv[0], sv[1]); await wait(600);
    const sub = await ev(`best.getState().then((s) => s.subs.find((x) => x.url.includes('ui-preresolve')))`);
    assert(sub && sub.preResolve === 'https://1.1.1.1/dns-query', 'saved: ' + JSON.stringify(sub && sub.preResolve));
    await ev(`best.removeSub ? best.removeSub(${JSON.stringify(sub.id)}, false) : null`); await wait(300);
  });

  await check('every page: every dropdown, switch and choice works, no script errors', async () => {
    const pages = await ev(`[...document.querySelectorAll('aside .nav-btn:not(.nav-help)')].map((b) => b.getAttribute('aria-label') || b.textContent.trim())`);
    const before = page.errors.length;
    const bad = [];
    for (let p = 0; p < pages.length; p++) {
      await ev(`[...document.querySelectorAll('aside .nav-btn:not(.nav-help)')][${p}].click()`); await wait(600);
      await move(1300, 300); await wait(200); // mouse off the side menu
      const name = await ev(`[...document.querySelectorAll('aside .nav-btn:not(.nav-help)')][${p}].getAttribute('aria-label')`);
      const subPages = await ev(`document.querySelectorAll('.set-nav .pg').length`);
      if (!subPages) bad.push(...(await sweep('main', name)));
      for (let k = 0; k < subPages; k++) { // Settings: one page at a time (the others are hidden)
        await ev(`document.querySelectorAll('.set-nav .pg')[${k}].click()`); await wait(350);
        await ev(`document.querySelectorAll('.pg-body.shown .adv:not(.open) > .adv-head').forEach((b) => b.click())`); await wait(150);
        const sub = await ev(`document.querySelectorAll('.set-nav .pg')[${k}].textContent.trim()`);
        bad.push(...(await sweep('main .pg-body.shown', `${name} › ${sub}`)));
      }
      if (await ev(`Boolean(document.querySelector('.overlay, .modal, .drawer'))`)) { await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await wait(300); }
    }
    await setSettings({ language: 'fa', theme: 'dark', uiZoom: 1, density: 'comfortable' });
    const errs = page.errors.slice(before);
    assert(!bad.length && !errs.length, [...bad.slice(0, 6), ...errs.slice(0, 2).map((x) => `error: ${String(x).slice(0, 160)}`)].join(' | '));
  }, 420000);

  await check('updates page: from a test version, "back to the release" asks first and installs nothing on cancel', async () => {
    const n = await ev(`[...document.querySelectorAll('aside .nav .nav-btn')].findIndex((b) => b.getAttribute('data-page') === 'updates' || /به‌روزرسانی/.test(b.textContent))`);
    assert(n >= 0, 'no updates button in the menu');
    await ev(`[...document.querySelectorAll('aside .nav .nav-btn')][${n}].click()`); await wait(500);
    // opening the page starts a check; its result would replace what this test sets
    await ev(`(async () => { const m = await import(new URL('app.js', document.baseURI).href); for (let i = 0; i < 100 && m.S.updates && m.S.updates.checking; i++) await new Promise((r) => setTimeout(r, 100)); })()`); await wait(400);
    // what the main process sends while a test version is installed and test versions are off
    const fake = `(async () => { const m = await import(new URL('app.js', document.baseURI).href); m.S.version = '1.0.3-beta.1'; m.S.appUpdate = { configured: true, latest: '1.0.2', available: true, back: true, busy: false, progress: 0, error: '' }; m.render(); })()`;
    await ev(fake); await wait(150);
    const seen = await ev(`(() => { const r = document.querySelector('.upd-app'); return r ? r.textContent : ''; })()`);
    assert(/بازگشت به نسخه‌ی اصلی/.test(seen) && /نسخه‌ی اصلی/.test(seen), `no way back shown: ${seen.slice(0, 120)}`);
    // the installed test version is marked next to the name in the menu; on this page the number
    // itself ("1.0.3-beta.1") says it, so no extra mark under it
    const marks = await ev(`({ menu: (document.querySelector('.brand-name .beta-pill') || {}).textContent || '', page: document.querySelectorAll('.upd-app .upd-ver .pill').length })`);
    assert(marks.menu === 'آزمایشی', `no test-version mark next to the name in the menu: "${marks.menu}"`);
    assert(marks.page === 0, `${marks.page} extra mark(s) under the version numbers`);
    await ev(fake);
    await ev(`[...document.querySelectorAll('.upd-app .upd-actions button')].find((b) => /بازگشت/.test(b.textContent)).click()`); await wait(400);
    const msg = await ev(`(() => { const m = document.querySelector('.modal-body'); return m ? m.textContent : ''; })()`);
    assert(/1\.0\.3-beta\.1/.test(msg) && /1\.0\.2/.test(msg), `confirm dialog wrong: ${msg.slice(0, 120)}`);
    await ev(`[...document.querySelectorAll('.modal-actions button')].find((b) => /انصراف/.test(b.textContent)).click()`); await wait(400);
    assert(!(await ev(`Boolean(document.querySelector('.modal-body'))`)), 'dialog did not close');
    assert(!(await ev(`best.getState().then((s) => Boolean(s.appUpdate && s.appUpdate.busy))`)), 'an install started after cancel');
    assert(page.errors.length === 0, `errors: ${page.errors.slice(0, 2).join(' | ')}`);
    await ev(`[...document.querySelectorAll('aside .nav-btn')][0].click()`); await wait(300);
  });

  await check('update bar: shows with the count on the menu; × closes it for good (also after a restart); a newer version brings it back', async () => {
    await ev(`[...document.querySelectorAll('aside .nav-btn')][0].click()`); await wait(300); // servers page
    const fake = (xray) => ev(`(async () => {
      const m = await import(new URL('app.js', document.baseURI).href);
      // only what this test sets: a real new core version out today must not change the count
      const items = Object.fromEntries(Object.entries((m.S.updates && m.S.updates.items) || {}).map(([k, v]) => [k, { ...v, available: false }]));
      m.S.updates = { ...(m.S.updates || {}), items: { ...items, xray: { ...(items.xray || {}), available: true, latest: ${JSON.stringify(xray)}, busy: false, error: '' } } };
      m.S.appUpdate = { configured: true, latest: '9.9.9', available: true, back: false, busy: false, progress: 0, error: '' };
      m.render();
    })()`);
    const bar = () => ev(`(() => { const b = document.querySelector('.main > .upd-banner'); return b ? b.textContent : ''; })()`);
    const badge = () => ev(`(() => { const b = [...document.querySelectorAll('aside .nav-btn .badge-accent')][0]; return b ? b.textContent.replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)) : ''; })()`);
    await ev(`localStorage.removeItem('best.updatesBannerClosed')`);
    await ev(`import(new URL('app.js', document.baseURI).href).then((m) => { m.ui.updatesBannerClosed = ''; })`);
    await fake('99.0.0'); await wait(150);
    const text = await bar();
    assert(/Best 9\.9\.9/.test(text) && /Xray 99\.0\.0/.test(text), `bar missing or wrong: ${text.slice(0, 120)}`);
    assert((await badge()) === '2', `menu count is ${await badge()}, not 2`);
    await fake('99.0.0');
    const [x, y] = await center('.upd-banner-close');
    await click(x, y); await wait(300);
    assert(!(await bar()), 'bar still there after ×');
    assert((await badge()) === '2', 'menu count gone after closing the bar');
    // a state update, and a restart (only what was saved counts), do not bring it back
    await ev(`import(new URL('app.js', document.baseURI).href).then((m) => { m.ui.updatesBannerClosed = ''; })`);
    await fake('99.0.0'); await wait(150);
    assert(!(await bar()), 'bar came back for the same versions');
    // a newer version shows it once more
    await fake('99.0.1'); await wait(150);
    assert(/Xray 99\.0\.1/.test(await bar()), 'bar did not come back for a newer version');
    // never on the Updates page itself
    const n = await ev(`[...document.querySelectorAll('aside .nav .nav-btn')].findIndex((b) => /به‌روزرسانی/.test(b.textContent))`);
    await ev(`[...document.querySelectorAll('aside .nav .nav-btn')][${n}].click()`); await wait(400);
    await fake('99.0.1'); await wait(150);
    assert(!(await bar()), 'bar shown on the Updates page');
    assert(page.errors.length === 0, `errors: ${page.errors.slice(0, 2).join(' | ')}`);
    // back to the real state
    await ev(`localStorage.removeItem('best.updatesBannerClosed')`);
    await ev(`(async () => { const m = await import(new URL('app.js', document.baseURI).href); const s = await best.getState(); m.S.updates = s.updates; m.S.appUpdate = s.appUpdate; m.ui.updatesBannerClosed = ''; m.render(); })()`);
    await ev(`[...document.querySelectorAll('aside .nav-btn')][0].click()`); await wait(300);
  });

  await check('server editor opens and closes', async () => {
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyN', key: 'n', ${CMD_PROP}: true, bubbles: true }))`); await wait(500);
    assert(await ev(`Boolean(document.querySelector('.overlay, .drawer'))`), 'editor did not open');
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await wait(500);
    assert(!(await ev(`Boolean(document.querySelector('.overlay, .drawer'))`)), 'editor did not close');
  });

  await check('server editor: a MASQUE server is filled with the keyboard, WARP switches the sign-in fields, it saves without a share link', async () => {
    const T = (k) => ev(`import(new URL('i18n.js', document.baseURI).href).then((m) => m.t(${JSON.stringify(k)}))`);
    const [lAddr, lUser, lPass, lRemark, noLink, lWarp, lWarpKey, lSave, lShare, lCopy] = await Promise.all(['f_address', 'f_username', 'f_password', 'f_remark', 'MASQUE_NO_LINK', 'f_warp', 'f_warpPrivateKey', 'save', 'm_share', 'm_copyLink'].map(T));
    const fieldInput = (label) => ev(`(() => { const f = [...document.querySelectorAll('.drawer .field')].find((x) => x.querySelector('.field-label')?.textContent === ${JSON.stringify(label)}); const i = f && f.querySelector('input, textarea'); if (!i) return null; i.scrollIntoView({ block: 'center' }); const r = i.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
    const typeInto = async (label, text) => { const p = await fieldInput(label); assert(p, `no field ${label}`); await click(p[0], p[1]); await wait(80); await send('Input.insertText', { text }); await wait(120); };
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyN', key: 'n', ${CMD_PROP}: true, bubbles: true }))`); await wait(500);
    const idx = await ev(`[...document.querySelectorAll('.drawer .ed-proto')].findIndex((b) => b.textContent === 'MASQUE')`);
    assert(idx >= 0, 'no MASQUE button');
    const pb = await ev(`window.__pt('.drawer .ed-proto', ${idx})`);
    await click(pb[0], pb[1]); await wait(300);
    assert((await ev(`document.querySelector('.drawer .ed-proto[aria-pressed="true"]')?.textContent`)) === 'MASQUE', 'MASQUE not chosen');
    await typeInto(lRemark, 'masque-ui');
    await typeInto(lAddr, 'example.com');
    await typeInto(lUser, 'best-user');
    await typeInto(lPass, 'secret-pass');
    await wait(500);
    assert((await ev(`document.querySelector('.drawer .ed-preview')?.textContent || ''`)).includes(noLink), 'preview should say there is no share link');
    // WARP on: key boxes instead of user name / password; off again: back.
    const sw = await ev(`(() => { const r = [...document.querySelectorAll('.drawer .switch-row')].find((x) => x.textContent.includes(${JSON.stringify(lWarp)})); const b = r && r.querySelector('.switch'); if (!b) return null; b.scrollIntoView({ block: 'center' }); const q = b.getBoundingClientRect(); return [Math.round(q.left + q.width / 2), Math.round(q.top + q.height / 2)]; })()`);
    assert(sw, 'no WARP switch');
    await click(sw[0], sw[1]); await wait(300);
    assert(await fieldInput(lWarpKey), 'WARP key box missing');
    assert(!(await fieldInput(lUser)), 'user name still shown with WARP');
    const sw2 = await ev(`(() => { const b = [...document.querySelectorAll('.drawer .switch-row')].find((x) => x.textContent.includes(${JSON.stringify(lWarp)})).querySelector('.switch'); const q = b.getBoundingClientRect(); return [Math.round(q.left + q.width / 2), Math.round(q.top + q.height / 2)]; })()`);
    await click(sw2[0], sw2[1]); await wait(300);
    assert(await fieldInput(lUser), 'user name did not come back');
    assert((await ev(`document.querySelector('.drawer [aria-checked]') && [...document.querySelectorAll('.drawer .field input')].some((i) => i.value === 'best-user')`)), 'typed user name lost');
    const save = await ev(`(() => { const b = [...document.querySelectorAll('.drawer button')].find((x) => x.textContent.trim() === ${JSON.stringify(lSave)}); const q = b.getBoundingClientRect(); return [Math.round(q.left + q.width / 2), Math.round(q.top + q.height / 2)]; })()`);
    await click(save[0], save[1]); await wait(700);
    assert(!(await ev(`Boolean(document.querySelector('.drawer'))`)), 'editor did not close after saving');
    // The list never carries credentials; the full server is asked for on its own (as the editor does).
    const saved = await ev(`best.getState().then((s) => s.servers.find((x) => x.remark === 'masque-ui')).then((x) => x && best.getServer(x.id))`);
    assert(saved && saved.protocol === 'masque' && saved.username === 'best-user' && saved.password === 'secret-pass' && saved.tls === 'tls' && !saved.warpPrivateKey, 'saved server is wrong: ' + JSON.stringify(saved && { p: saved.protocol, u: saved.username, tls: saved.tls, warp: Boolean(saved.warpPrivateKey) }));
    // Its row menu has no share / copy-link entries.
    const row = await ev(`(() => { const r = document.querySelector('.srow[data-id="${saved.id}"]'); if (!r) return null; r.scrollIntoView({ block: 'center' }); const q = r.getBoundingClientRect(); return [Math.round(q.left + 40), Math.round(q.top + q.height / 2)]; })()`);
    assert(row, 'MASQUE row not in the list');
    await move(row[0], row[1], 3);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: row[0], y: row[1], button: 'right', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: row[0], y: row[1], button: 'right', clickCount: 1 });
    await wait(300);
    const items = await ev(`[...document.querySelectorAll('.menu .menu-item')].map((b) => b.textContent.trim())`);
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await wait(200);
    assert(items.length > 3, 'row menu did not open');
    assert(!items.some((x) => x.includes(lShare) || x.includes(lCopy)), 'MASQUE row offers a share link: ' + items.join(', '));
    await ev(`best.removeServers([${JSON.stringify(saved.id)}])`); await wait(300);
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
