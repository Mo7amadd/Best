'use strict';
// Tiny PAC server bound to 127.0.0.1 only. It serves one file and nothing else.
// The PAC never falls back to DIRECT for proxied hosts, so a stopped core cannot leak traffic.

const http = require('http');

function buildPac(settings, routing) {
  const direct = ['localhost', '*.local', '*.lan'];
  if (routing.mode === 'bypass-local' && /^[a-z]{2}$/.test(routing.country || '')) direct.push(`*.${routing.country}`);
  for (const r of routing.rules || []) {
    if (!r.enabled || r.type !== 'domain' || r.outbound !== 'direct') continue;
    for (const v of r.values) {
      if (/^(domain:)?[a-z0-9.-]+$/i.test(v)) direct.push('*.' + v.replace(/^domain:/, ''), v.replace(/^domain:/, ''));
      else if (/^full:[a-z0-9.-]+$/i.test(v)) direct.push(v.slice(5));
    }
  }
  const proxy = `PROXY 127.0.0.1:${settings.httpPort}; SOCKS5 127.0.0.1:${settings.socksPort}`;
  return `// Best PAC
var DIRECT_HOSTS = ${JSON.stringify(direct)};
function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  if (isPlainHostName(host)) return "DIRECT";
  for (var i = 0; i < DIRECT_HOSTS.length; i++) {
    if (shExpMatch(host, DIRECT_HOSTS[i])) return "DIRECT";
  }
  if (/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(host)) {
    if (isInNet(host, "10.0.0.0", "255.0.0.0") || isInNet(host, "172.16.0.0", "255.240.0.0") ||
        isInNet(host, "192.168.0.0", "255.255.0.0") || isInNet(host, "127.0.0.0", "255.0.0.0")) return "DIRECT";
  }
  return "${proxy}";
}
`;
}

class PacServer {
  constructor() { this.server = null; this.body = ''; this.port = 0; }

  async start(settings, routing) {
    this.body = buildPac(settings, routing);
    if (this.server && this.port === settings.pacPort) return;
    await this.stop();
    this.port = settings.pacPort;
    this.server = http.createServer((req, res) => {
      if (req.method !== 'GET' || !req.url.startsWith('/proxy.pac')) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig', 'Cache-Control': 'no-store' });
      res.end(this.body);
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', resolve);
    });
  }

  update(settings, routing) { this.body = buildPac(settings, routing); }

  async stop() {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    await new Promise((r) => s.close(() => r()));
  }
}

module.exports = { PacServer, buildPac };
