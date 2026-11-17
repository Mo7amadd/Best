'use strict';
// Live test against real servers: every server of a subscription, on every core that claims to run
// it, through the same configs and the same delay / UDP / speed checks Best itself uses.
//
//   set BEST_SUB=https://panel.example:2096/sub/xxxx   (or BEST_SUB_FILE=links.txt)
//   set BEST_MIHOMO=C:\path\to\mihomo.exe               (optional third core)
//   set BEST_SPEED=1                                    (optional 3 s download per server)
//   npm run test:live
//
// Only local ports 127.0.0.1:46000+ are used; the Windows proxy and other apps are not touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { parseContent } = require('../../src/core/subscription');
const { buildXrayTestConfig } = require('../../src/core/xray-config');
const { buildSingBoxTestConfig, singBoxOutbound, wireguardEndpoint, serverNames, useServerIps } = require('../../src/core/singbox-config');
const { buildMihomoTestConfig, canMihomo } = require('../../src/core/mihomo-config');
const { DEFAULT_SETTINGS } = require('../../src/core/settings');
const tester = require('../../electron/tester');

const ROOT = path.join(__dirname, '..', '..');
const CORES = {
  xray: { exe: path.join(ROOT, 'resources', 'cores', 'xray', 'xray.exe'), args: (f) => ['run', '-c', f] },
  'sing-box': { exe: path.join(ROOT, 'resources', 'cores', 'sing-box', 'sing-box.exe'), args: (f) => ['run', '-c', f, '--disable-color'] },
  mihomo: { exe: process.env.BEST_MIHOMO || '', args: (f, dir) => ['-d', dir, '-f', f] },
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settings = { ...DEFAULT_SETTINGS };

async function loadServers() {
  let text = '';
  if (process.env.BEST_SUB_FILE) text = fs.readFileSync(process.env.BEST_SUB_FILE, 'utf8');
  else if (process.env.BEST_SUB) text = await (await fetch(process.env.BEST_SUB, { headers: { 'User-Agent': 'Best/live-test' } })).text();
  else { console.log('Set BEST_SUB (subscription URL) or BEST_SUB_FILE first.'); process.exit(2); }
  const r = parseContent(text);
  for (const e of r.errors) console.log(`  skipped link: ${e.error}`);
  return r.servers;
}

const can = {
  xray: (s) => { try { buildXrayTestConfig([s], settings, 1); return true; } catch { return false; } },
  'sing-box': (s) => { try { if (s.protocol === 'wireguard') wireguardEndpoint(s, 'x'); else singBoxOutbound(s, 'x'); return true; } catch { return false; } },
  mihomo: (s) => canMihomo(s),
};

async function runCore(kind, list, socks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `best-live-${kind}-`));
  const base = 46000 + (kind === 'xray' ? 0 : kind === 'sing-box' ? 1000 : 2000) + (socks ? 500 : 0);
  const cfg = kind === 'xray' ? buildXrayTestConfig(list, settings, base, { socks }) : kind === 'sing-box' ? buildSingBoxTestConfig(list, base, { socks }) : buildMihomoTestConfig(list, base, { socks });
  if (kind === 'sing-box') { // as the app does: server names looked up by Windows first
    const ips = {};
    for (const n of serverNames(cfg)) { try { ips[n] = (await require('dns').promises.lookup(n, { all: true })).map((x) => x.address); } catch { /* core resolves it */ } }
    useServerIps(cfg, ips);
  }
  const file = path.join(dir, kind === 'mihomo' ? 'config.yaml' : 'config.json');
  fs.writeFileSync(file, JSON.stringify(cfg)); // JSON is valid YAML for mihomo
  const log = [];
  const p = spawn(CORES[kind].exe, CORES[kind].args(file, dir), { cwd: path.dirname(CORES[kind].exe), windowsHide: true });
  p.stdout.on('data', (d) => log.push(String(d))); p.stderr.on('data', (d) => log.push(String(d)));
  let exited = false; p.on('exit', () => { exited = true; });
  await wait(2500);
  const stop = async () => { p.kill(); await wait(400); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* locked */ } };
  if (exited) { await stop(); throw new Error(`${kind} did not start: ${log.join('').split(/\r?\n/).filter(Boolean).slice(-2).join(' | ')}`); }
  return { ports: list.map((_, i) => base + i), stop };
}

(async () => {
  const servers = await loadServers();
  console.log(`${servers.length} servers\n`);
  const kinds = ['xray', 'sing-box', ...(CORES.mihomo.exe && fs.existsSync(CORES.mihomo.exe) ? ['mihomo'] : [])];
  let failures = 0;
  for (const kind of kinds) {
    const list = servers.filter(can[kind]);
    if (!list.length) continue;
    const rows = list.map((s) => ({ server: (s.remark || `${s.protocol}:${s.port}`).slice(0, 34), delay: '', udp: '', speed: '' }));
    try {
      const h = await runCore(kind, list, false);
      for (let i = 0; i < list.length; i++) {
        let d = await tester.realDelay(h.ports[i], settings.testUrl, 8000);
        if (d < 0) d = await tester.realDelay(h.ports[i], settings.testUrl, 8000); // one retry: a fresh path may need a moment
        rows[i].delay = d >= 0 ? `${d} ms` : 'FAIL';
        if (d < 0) failures++;
        if (process.env.BEST_SPEED && d >= 0) { const mb = await tester.speedTest(h.ports[i], settings.speedTestUrl, 3); rows[i].speed = mb > 0 ? `${mb.toFixed(1)} MB/s` : 'FAIL'; }
      }
      await h.stop();
      const u = await runCore(kind, list, true);
      for (let i = 0; i < list.length; i++) {
        const d = await tester.udpDelay(u.ports[i], settings.udpTestTarget, 6000);
        rows[i].udp = d >= 0 ? `${d} ms` : '—';
      }
      await u.stop();
    } catch (e) {
      console.log(`✖ ${kind}: ${e.message}`); failures++; continue;
    }
    console.log(`== ${kind} (${list.length})`);
    console.table(rows);
  }
  console.log(failures ? `\n✖ ${failures} failure(s)` : '\n✔ every server connected on every core that runs it');
  process.exit(failures ? 1 : 0);
})();
