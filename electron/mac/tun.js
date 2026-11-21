'use strict';
// TUN on macOS through Best's helper service (helper/mac/BestTunHelper.swift): installing and
// removing it with macOS' own password prompt, and running TUN through its local socket. Best
// itself never runs as root.

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const { execFile } = require('child_process');
const { app } = require('electron');
const { archOf, appleScriptAdmin } = require('../platform');

const SOCKET = '/var/run/com.best.client.tun.socket';
const HELPER_VERSION = '1'; // must match helperVersion in BestTunHelper.swift

function helperDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'helper') : path.join(__dirname, '..', '..', 'resources', `helper-mac-${archOf()}`);
}

const digests = new Map(); // file → { mtimeMs, sha256 }
function sha256File(file) {
  const st = fs.statSync(file);
  const known = digests.get(file);
  if (known && known.mtimeMs === st.mtimeMs) return known.sha256;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  digests.set(file, { mtimeMs: st.mtimeMs, sha256 });
  return sha256;
}

/** One request, its first answer (a short-lived connection). */
function request(obj, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCKET);
    let buf = '';
    const done = (fn, v) => { clearTimeout(timer); sock.destroy(); fn(v); };
    const timer = setTimeout(() => done(reject, new Error('the TUN helper did not answer')), timeout);
    sock.on('connect', () => sock.write(`${JSON.stringify(obj)}\n`));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try { done(resolve, JSON.parse(buf.slice(0, nl))); } catch (e) { done(reject, e); }
    });
    sock.on('error', (e) => done(reject, e));
  });
}

/**
 * 'ready', 'outdated' (from another Best, or another sing-box than the one this Best ships: install
 * again, so the root copy is never an old one) or 'missing'.
 */
async function helperStatus(singBox) {
  if (!fs.existsSync(SOCKET)) return 'missing';
  try {
    const r = await request({ cmd: 'hello' });
    if (!r || !r.ok) return 'missing';
    if (r.version !== HELPER_VERSION) return 'outdated';
    if (singBox && fs.existsSync(singBox) && r.singbox !== sha256File(singBox)) return 'outdated';
    return 'ready';
  } catch { return 'missing'; }
}

/** Run a script as root after the macOS password prompt; its text goes in the command itself. */
function runAsAdmin(scriptFile, args, prompt) {
  const text = fs.readFileSync(scriptFile, 'utf8');
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', appleScriptAdmin(['/bin/sh', '-c', text, 'best-tun', ...args], prompt)], { timeout: 180000 }, (err, stdout, stderr) => {
      if (!err) return resolve();
      // -128: the user pressed Cancel in the password prompt
      if (/-128|User canceled/i.test(`${stderr} ${err.message}`)) return reject(new Error('TUN_HELPER_CANCELLED'));
      reject(new Error(`TUN_HELPER_FAILED:${String(stderr || err.message).trim().split('\n').pop().slice(0, 200)}`));
    });
  });
}

/**
 * Install (or bring up to date) the helper. `singBox` is the sing-box program shipped inside
 * Best.app: the helper keeps its own root-owned copy of it, checked against the SHA-256 taken here.
 */
async function installHelper(singBox, prompt) {
  const dir = helperDir();
  const helper = path.join(dir, 'best-tun-helper');
  if (!fs.existsSync(helper) || !fs.existsSync(singBox)) throw new Error('TUN_HELPER_FAILED:the helper is missing from this copy of Best');
  await runAsAdmin(path.join(dir, 'install.sh'), [helper, singBox, String(process.getuid()), sha256File(helper), sha256File(singBox)], prompt);
  for (let i = 0; i < 40; i++) {
    if ((await helperStatus(singBox)) === 'ready') return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('TUN_HELPER_FAILED:the helper did not start');
}

function removeHelper(prompt) {
  return runAsAdmin(path.join(helperDir(), 'uninstall.sh'), [], prompt);
}

/**
 * A TUN run by the helper, with the face of a core process (cores.js): 'line' and 'exit' events,
 * stop(), exited. `ready` settles once the helper has started it (or refused). The connection stays
 * open while TUN runs: if Best goes away, the helper stops TUN.
 */
class HelperTun extends EventEmitter {
  constructor(config) {
    super();
    this.exited = false;
    this.sock = net.createConnection(SOCKET);
    let buf = '';
    let settle = null;
    this.ready = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    this.ready.catch(() => {}); // the caller awaits it; never an unhandled rejection
    const end = (code) => {
      if (this.exited) return;
      this.exited = true;
      if (settle) { settle.reject(new Error('the TUN helper closed the connection')); settle = null; }
      this.emit('exit', code);
    };
    this.sock.on('connect', () => this.sock.write(`${JSON.stringify({ cmd: 'start', config })}\n`));
    this.sock.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (typeof msg.log === 'string') this.emit('line', msg.log);
        if (msg.started && settle) { settle.resolve(); settle = null; }
        if (typeof msg.error === 'string') {
          this.emit('line', msg.error);
          if (settle) { settle.reject(new Error(msg.error)); settle = null; this.sock.destroy(); }
        }
        if (msg.exit !== undefined) end(Number(msg.exit));
      }
    });
    this.sock.on('error', (e) => { this.emit('line', `TUN helper: ${e.message}`); });
    this.sock.on('close', () => end(-1));
  }

  stop() {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.sock.destroy(); resolve(); }, 5000);
      this.once('exit', () => { clearTimeout(t); resolve(); });
      try { this.sock.write(`${JSON.stringify({ cmd: 'stop' })}\n`); } catch { /* closed */ }
      // the helper answers {"stopped"}; closing the connection then ends this TUN for good
      setTimeout(() => this.sock.end(), 300);
    });
  }
}

module.exports = { helperStatus, installHelper, removeHelper, HelperTun, SOCKET, HELPER_VERSION };
