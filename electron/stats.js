'use strict';
// Live traffic: polls the running core once a second over a local, private endpoint and turns its
// byte counters into speeds and session totals.
//  - Xray: "metrics" listener (127.0.0.1, random port) → /debug/vars → stats.outbound.<tag>
//  - sing-box: clash_api (127.0.0.1, random port, random secret) → /connections
// Nothing is sent anywhere else; the endpoints only listen on the loopback address.

const http = require('http');
const EventEmitter = require('events');

function getJson(port, path, secret) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 2000, headers: secret ? { Authorization: `Bearer ${secret}` } : {} }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 8 * 1024 * 1024) req.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

class StatsPoller extends EventEmitter {
  constructor() {
    super();
    this.timer = null;
    this.target = null;
    this.reset();
  }

  reset() {
    this.last = null; // previous counters { up, down, proxyUp, proxyDown, at }
    this.prevConns = null;
    this.proxyAcc = null;
    this.session = { up: 0, down: 0, proxyUp: 0, proxyDown: 0 };
    this.current = { upSpeed: 0, downSpeed: 0, ...this.session };
  }

  /** target: { core: 'xray' | 'sing-box', port, secret } */
  start(target) {
    this.stop();
    this.target = target;
    this.reset();
    this.timer = setInterval(() => this.tick().catch(() => {}), 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.target = null;
    this.reset();
    this.emit('stats', null);
  }

  async read() {
    const t = this.target;
    if (t.core === 'xray') {
      const j = await getJson(t.port, '/debug/vars');
      const out = (j && j.stats && j.stats.outbound) || {};
      let up = 0; let down = 0;
      // loop-out carries the same bytes as the proxy outbound (local forwarder): count it once.
      for (const [tag, v] of Object.entries(out)) {
        if (tag === 'loop-out' || tag === 'loop-out-f' || tag === 'metrics' || tag === 'f-0') continue; // same bytes counted elsewhere
        up += Number(v.uplink) || 0; down += Number(v.downlink) || 0;
      }
      let proxyUp = 0; let proxyDown = 0;
      for (const [tag, v] of Object.entries(out)) {
        if (tag === 'proxy' || tag === 'proxy-hosts' || /^m-\d+$/.test(tag)) { proxyUp += Number(v.uplink) || 0; proxyDown += Number(v.downlink) || 0; }
      }
      return { up, down, proxyUp, proxyDown };
    }
    const j = await getJson(t.port, '/connections', t.secret);
    // Proxied bytes = growth of every open connection that does not go direct (a connection that
    // closed between two polls loses at most its last second).
    const conns = Array.isArray(j.connections) ? j.connections : [];
    const prev = this.prevConns || new Map();
    const next = new Map();
    let pUp = 0; let pDown = 0;
    for (const c of conns) {
      const u = Number(c.upload) || 0; const d = Number(c.download) || 0;
      next.set(c.id, { u, d });
      if ((c.chains || []).some((x) => /^(direct|block|reject)$/i.test(x))) continue;
      const o = prev.get(c.id) || { u: 0, d: 0 };
      pUp += Math.max(0, u - o.u); pDown += Math.max(0, d - o.d);
    }
    this.prevConns = next;
    this.proxyAcc = { up: ((this.proxyAcc && this.proxyAcc.up) || 0) + pUp, down: ((this.proxyAcc && this.proxyAcc.down) || 0) + pDown };
    return { up: Number(j.uploadTotal) || 0, down: Number(j.downloadTotal) || 0, proxyUp: this.proxyAcc.up, proxyDown: this.proxyAcc.down, connections: conns };
  }

  async tick() {
    if (!this.target) return;
    const now = Date.now();
    const c = await this.read();
    if (!this.target) return;
    if (this.last) {
      const secs = Math.max(0.2, (now - this.last.at) / 1000);
      const d = (k) => Math.max(0, c[k] - this.last[k]); // counters restart with the core
      const up = d('up'); const down = d('down');
      this.session.up += up; this.session.down += down;
      this.session.proxyUp += d('proxyUp'); this.session.proxyDown += d('proxyDown');
      this.current = { upSpeed: Math.round(up / secs), downSpeed: Math.round(down / secs), ...this.session };
      this.emit('stats', this.current, { proxyUp: d('proxyUp'), proxyDown: d('proxyDown') });
    }
    this.last = { ...c, at: now };
    if (c.connections) this.emit('connections', c.connections);
  }
}

module.exports = { StatsPoller, getJson };
