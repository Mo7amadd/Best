'use strict';
// Runs the proxy cores (xray.exe / sing-box.exe) as child processes.
//  - Configs are piped through stdin, never written to disk (they contain keys and passwords).
//  - Processes are started with an argument array (no shell) so nothing can be injected.
//  - stdout/stderr are collected into a bounded log buffer.

const { spawn, execFile } = require('child_process');
const EventEmitter = require('events');
const net = require('net');
const path = require('path');
const SYS32 = require('path').join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const SYS_PS = require('path').join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'); // full path: never a powershell.exe from the current folder
const fs = require('fs');
const { app } = require('electron');

const { buildXrayConfig, buildXrayTestConfig, needsSingBox, needsLoopback } = require('../src/core/xray-config');
const { customInboundPorts } = require('../src/core/links');
const { withOwnInbounds, hardenRaw } = require('../src/core/custom');
const { buildComposite } = require('../src/core/group');
const { applyBinding } = require('../src/core/bind');
const { buildMihomoConfig, buildMihomoTestConfig } = require('../src/core/mihomo-config');
const { GEOSITE } = require('../src/core/country');
const { coreExe, geoDir, allCoreExes, runRoot } = require('./updater');
const { buildSingBoxConfig, buildTunConfig, buildSingBoxTestConfig, serverNames, useServerIps } = require('../src/core/singbox-config');

/**
 * Look server names up through Windows (fast; see useServerIps). Not while TUN is up: the question
 * would go into the tunnel. Each name has 2.5 s; a name that fails is simply resolved by the core.
 */
async function lookupServerIps(names, tunUp) {
  const out = {};
  if (tunUp) return out;
  const dns = require('dns');
  await Promise.all([...new Set(names)].slice(0, 64).map(async (name) => {
    let timer;
    try {
      const r = await Promise.race([dns.promises.lookup(name, { all: true, verbatim: true }), new Promise((_, no) => { timer = setTimeout(() => no(new Error('timeout')), 2500); })]);
      const ips = r.map((x) => x.address).filter(Boolean).slice(0, 8);
      if (ips.length) out[name] = ips;
    } catch { /* the core resolves it itself */ } finally { clearTimeout(timer); }
  }));
  return out;
}
const domainsOf = (list) => list.filter(Boolean).map((s) => String(s.address || '').toLowerCase()).filter((a) => a.includes('.') && /[a-z]/.test(a) && /^[a-z0-9.-]{1,253}$/.test(a));

const MAX_LOG = 2000;

/** Everything the TUN config depends on; TUN is rebuilt only when this changes. */
function tunSignature(settings) {
  return JSON.stringify(buildTunConfig(settings));
}

function coresDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'cores')
    : path.join(__dirname, '..', 'resources', 'cores');
}

/** Updated cores in the user profile win over the bundled ones (see updater.js). */
function exe(core) {
  return coreExe(core);
}

function bundledExe(core) {
  return core === 'xray'
    ? path.join(coresDir(), 'xray', 'xray.exe')
    : path.join(coresDir(), 'sing-box', 'sing-box.exe');
}

/**
 * mihomo reads its config from a file: it is written to mihomo's own folder in the user profile
 * just before start and removed as soon as the core is up. Geo files are shared with Xray.
 */
function mihomoPrepare(config, name = 'config.yaml') {
  const dir = workDir('mihomo');
  for (const [from, to] of [['geoip.dat', 'GeoIP.dat'], ['geosite.dat', 'GeoSite.dat']]) {
    const src = path.join(geoDir(), from);
    const dst = path.join(dir, to);
    try {
      const a = fs.statSync(src); let b = null;
      try { b = fs.statSync(dst); } catch { /* missing */ }
      if (!b || b.size !== a.size || b.mtimeMs < a.mtimeMs) fs.copyFileSync(src, dst);
    } catch { /* no geo file */ }
  }
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 }); // JSON is valid YAML
  return { args: ['-d', dir, '-f', file], cleanup: () => { try { fs.rmSync(file, { force: true }); } catch { /* ignore */ } } };
}

function workDir(core) {
  // sing-box keeps its rule-set cache here; Xray reads geo files from its own folder.
  const dir = core === 'xray' ? path.dirname(exe('xray')) : path.join(runRoot(), core === 'mihomo' ? 'mihomo' : 'sing-box');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function waitForPort(port, timeoutMs, isDead) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (isDead()) return reject(new Error('core exited'));
      const sock = net.connect({ host: '127.0.0.1', port });
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error('core did not open its port in time'));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

const LEVEL_RE = /\[(Debug|Info|Warning|Error)\]|\b(DEBUG|INFO|WARN|ERROR|FATAL)\b/;

class CoreProcess extends EventEmitter {
  constructor(core, args, config, label) {
    super();
    this.core = core;
    this.label = label;
    this.exited = false;
    this.child = spawn(exe(core), args, {
      cwd: workDir(core),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, XRAY_LOCATION_ASSET: geoDir() },
    });
    this.child.stdin.on('error', () => {});
    this.child.stdin.end(config === null ? '' : JSON.stringify(config)); // mihomo reads a file instead
    const onData = (buf) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        const text = line.replace(/\u001b\[[0-9;]*m/g, '').trim();
        if (text) this.emit('line', text);
      }
    };
    this.child.stdout.on('data', onData);
    this.child.stderr.on('data', onData);
    this.child.on('error', (e) => { this.exited = true; this.emit('line', `failed to start ${core}: ${e.message}`); this.emit('exit', -1); });
    this.child.on('exit', (code) => { this.exited = true; this.emit('exit', code); });
  }

  stop() {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, 3000);
      this.child.once('exit', () => { clearTimeout(t); resolve(); });
      try { this.child.kill(); } catch { resolve(); }
    });
  }
}

class CoreManager extends EventEmitter {
  constructor() {
    super();
    this.main = null;
    this.tun = null;
    this.logs = [];
    this.state = { running: false, core: null, tun: false, serverId: null, error: '' };
    this.expectedStop = false;
  }

  log(source, text) {
    const m = LEVEL_RE.exec(text);
    const raw = m ? (m[1] || m[2]) : '';
    const level = /err|fatal/i.test(raw) ? 'error' : /warn/i.test(raw) ? 'warning' : /debug/i.test(raw) ? 'debug' : 'info';
    // The cores print their own date/time and level; we show our own time column and a level tag.
    const clean = text
      .replace(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?\s+/, '')
      .replace(/^[+-]\d{4} \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+/, '')
      .replace(/^\[(Debug|Info|Warning|Error)\]\s+/, '')
      .replace(/^(DEBUG|INFO|WARN|ERROR|FATAL)\s+/, '')
      .replace(/^from (tcp:|udp:)?127\.0\.0\.1:\d+ accepted /, '→ ');
    const entry = { time: new Date().toTimeString().slice(0, 8), source, level, text: clean.slice(0, 2000) };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOG) this.logs.splice(0, this.logs.length - MAX_LOG);
    this.emit('log', entry);
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  async start(server, settings, routing, { tun = false, plan = null, core: coreChoice = '' } = {}) {
    // A running TUN stays up while the main core restarts (server switch, settings change, crash):
    // it only forwards to 127.0.0.1:socksPort, so in between connections fail instead of leaking
    // out of the real network card.
    if (!tun || (this.tun && this.tunSig !== tunSignature(settings))) await this.stopTun();
    await this.stopMain();
    this.expectedStop = false;
    const custom = server.protocol === 'custom';
    const core = plan ? plan.core : custom ? server.core : coreChoice || (needsSingBox(server) ? 'sing-box' : 'xray');
    const managed = custom && server.managedInbounds;
    const readyPort = custom && !managed ? (customInboundPorts(server)[0] || 0) : settings.socksPort;
    const ports = custom && !managed ? customInboundPorts(server) : [settings.socksPort, settings.httpPort, ...(settings.allowLan ? [settings.lanSocksPort, settings.lanHttpPort] : [])];
    for (const p of ports) {
      if (!(await portFree(p))) throw new Error(`PORT_BUSY:${p}`);
    }
    let config;
    // Live traffic endpoint on a random loopback port (sing-box also needs a random secret).
    const stats = settings.statsEnabled === false || (custom && !managed) ? null : { core, port: await freePort(), secret: require('crypto').randomBytes(18).toString('base64url') };
    if (plan) {
      // Group and / or chain: one forwarder port per plain member that needs it.
      const members = plan.members || [];
      const loopPorts = [];
      for (const m of members) loopPorts.push(core === 'xray' && needsLoopback(m) ? await freePort() : 0);
      const loopbackPort = !members.length && core === 'xray' && needsLoopback(plan.main) ? await freePort() : 0;
      const frontLoopPort = plan.front && core === 'xray' && needsLoopback(plan.front) ? await freePort() : 0;
      config = buildComposite(plan, settings, routing, { loopPorts, loopbackPort, frontLoopPort, statsPort: stats && core === 'xray' ? stats.port : 0, clashApi: stats && core !== 'xray' ? stats : null });
    } else if (core === 'mihomo') {
      config = buildMihomoConfig(server, settings, routing, { controller: stats, geoSiteCat: GEOSITE[routing.country] || '' });
    } else if (custom) config = managed ? withOwnInbounds(JSON.parse(server.config), core, settings, { stats }) : hardenRaw(JSON.parse(server.config), core);
    else if (core === 'xray') config = buildXrayConfig(server, settings, routing, { ...(needsLoopback(server) ? { loopbackPort: await freePort() } : {}), statsPort: stats ? stats.port : 0 });
    else config = buildSingBoxConfig(server, settings, routing, { clashApi: stats });
    if (!custom) applyBinding(config, core, settings);
    // Server names looked up by Windows for sing-box (and for the TUN front-end started next).
    // Only when sing-box or a new TUN needs them: an Xray-only connection does not wait for it.
    const needIps = !custom && (core === 'sing-box' || (tun && !this.tun));
    this.serverIps = !needIps ? {} : await lookupServerIps(domainsOf([server, plan && plan.main, plan && plan.front, ...((plan && plan.members) || [])]), Boolean(this.tun));
    if (core === 'sing-box' && !custom) useServerIps(config, this.serverIps);
    this.statsTarget = stats;
    let mihomoFiles = null;
    if (core === 'mihomo') mihomoFiles = mihomoPrepare(config);
    const args = core === 'xray' ? ['run', '-c', 'stdin:'] : core === 'mihomo' ? mihomoFiles.args : ['run', '-c', 'stdin', '-D', workDir('sing-box')];
    this.log('app', `starting ${core} → ${server.remark || server.address}`);
    const proc = new CoreProcess(core, args, core === 'mihomo' ? null : config, 'main');
    this.main = proc;
    const recent = [];
    proc.on('line', (t) => { recent.push(t); if (recent.length > 8) recent.shift(); this.log(core, t); });
    proc.on('exit', (code) => {
      if (this.main !== proc) return;
      this.main = null;
      if (!this.expectedStop) {
        // TUN is deliberately left up (kill switch): nothing leaves outside the tunnel until the
        // user reconnects or disconnects.
        this.log('app', `${core} stopped unexpectedly (code ${code})${this.tun ? ' – TUN keeps blocking traffic until you reconnect or disconnect' : ''}`);
        this.setState({ running: false, core: null, error: this.tun ? 'CORE_EXITED_TUN' : 'CORE_EXITED' });
      }
    });
    try {
      if (readyPort) await waitForPort(readyPort, 8000, () => proc.exited);
      else {
        await new Promise((r) => setTimeout(r, 1500));
        if (proc.exited) throw new Error('core exited');
      }
    } catch (e) {
      if (mihomoFiles) mihomoFiles.cleanup();
      await proc.stop();
      this.main = null;
      const detail = recent.slice(-3).join(' | ');
      throw new Error(`CORE_FAILED:${detail || e.message}`);
    }
    if (mihomoFiles) mihomoFiles.cleanup();
    this.setState({ running: true, core, serverId: server.id, error: '' });
    if (tun && !this.tun) await this.startTun(settings);
    return this.state;
  }

  async startTun(settings) {
    await this.stopTun();
    this.log('app', 'starting TUN (sing-box)');
    const proc = new CoreProcess('sing-box', ['run', '-c', 'stdin', '-D', workDir('sing-box')], useServerIps(buildTunConfig(settings), this.serverIps), 'tun');
    this.tun = proc;
    this.tunSig = tunSignature(settings);
    const recent = [];
    proc.on('line', (t) => { recent.push(t); if (recent.length > 8) recent.shift(); this.log('tun', t); });
    let failed = false;
    proc.on('exit', (code) => {
      failed = true;
      if (this.tun !== proc) return;
      this.tun = null;
      if (!this.expectedStop) {
        this.log('app', `TUN stopped (code ${code})`);
        this.setState({ tun: false, error: 'TUN_EXITED' });
      }
    });
    // sing-box needs a moment to create the adapter and routes.
    await new Promise((r) => setTimeout(r, 1500));
    if (failed) {
      this.tun = null;
      throw new Error(`TUN_FAILED:${recent.slice(-2).join(' | ')}`);
    }
    this.setState({ tun: true });
  }

  async stopTun() {
    if (!this.tun) return;
    const p = this.tun;
    this.tun = null;
    await p.stop();
    this.setState({ tun: false });
  }

  /** Stop only the proxy core (TUN, if any, keeps blocking traffic). */
  async stopMain() {
    this.expectedStop = true;
    if (this.main) {
      const p = this.main;
      this.main = null;
      await p.stop();
      this.log('app', 'core stopped');
    }
    this.setState({ running: false, core: null, serverId: null });
  }

  /** Full stop: proxy core and TUN. */
  async stop() {
    this.expectedStop = true;
    await this.stopTun();
    await this.stopMain();
    this.setState({ tun: false });
  }

  /** Start a throw-away core with one HTTP inbound per server. Returns { ports, stop }. */
  /** Run a ready-made test config (custom / JSON-subscription servers) whose HTTP inbound is `port`. */
  async startRawTest(config, kind, port) {
    const args = kind === 'xray' ? ['run', '-c', 'stdin:'] : ['run', '-c', 'stdin', '-D', workDir('sing-box')];
    const proc = new CoreProcess(kind, args, config, 'test');
    try {
      await waitForPort(port, 8000, () => proc.exited);
    } catch {
      await proc.stop();
      throw new Error('test core failed to start');
    }
    return { port, stop: () => proc.stop() };
  }

  async startTestCore(servers, settings, kind, basePort, opts = {}) {
    const config = kind === 'xray' ? buildXrayTestConfig(servers, settings, basePort, opts) : kind === 'mihomo' ? buildMihomoTestConfig(servers, basePort, opts) : buildSingBoxTestConfig(servers, basePort, opts);
    if (kind === 'sing-box') useServerIps(config, await lookupServerIps(serverNames(config), Boolean(this.tun)));
    const files = kind === 'mihomo' ? mihomoPrepare(config, `test-${basePort}.yaml`) : null;
    const args = kind === 'xray' ? ['run', '-c', 'stdin:'] : kind === 'mihomo' ? files.args : ['run', '-c', 'stdin', '-D', workDir('sing-box')];
    const proc = new CoreProcess(kind, args, kind === 'mihomo' ? null : config, 'test');
    proc.on('exit', () => files && files.cleanup());
    const errors = [];
    proc.on('line', (t) => { if (/error|fatal|failed/i.test(t)) errors.push(t); });
    try {
      await waitForPort(basePort, 8000, () => proc.exited);
    } catch {
      await proc.stop();
      throw new Error(errors.slice(-1)[0] || 'test core failed to start');
    }
    // Give the remaining inbounds a moment to bind.
    await new Promise((r) => setTimeout(r, 200));
    return { ports: servers.map((_, i) => basePort + i), stop: () => proc.stop() };
  }

  versions() {
    const run = (file, args) => new Promise((resolve) => {
      execFile(file, args, { windowsHide: true, timeout: 5000 }, (err, out) => resolve(err ? '' : String(out).split('\n')[0].trim()));
    });
    return Promise.all([run(exe('xray'), ['version']), run(exe('sing-box'), ['version'])])
      .then(([x, s]) => ({ xray: (/Xray ([\d.]+)/.exec(x) || [])[1] || '', singbox: (/version ([\d.]+)/.exec(s) || [])[1] || '' }));
  }

  /** Kill cores left running by a previous crash (only our own executables, matched by full path). */
  static killOrphans() {
    const paths = [...new Set([...allCoreExes(), bundledExe('xray'), bundledExe('sing-box')])].map((p) => `'${p.replace(/['‘’‚‛]/g, "$&$&")}'`);
    const script = `Get-Process -Name xray,sing-box,mihomo -ErrorAction SilentlyContinue | Where-Object { @(${paths.join(',')}) -contains $_.Path } | Stop-Process -Force -ErrorAction SilentlyContinue`;
    return new Promise((resolve) => {
      execFile(SYS_PS, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000 }, () => resolve());
    });
  }
}

module.exports = { CoreManager, coresDir, exe };
