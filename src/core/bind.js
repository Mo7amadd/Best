'use strict';
// "Send through": make outgoing connections leave through a chosen network adapter and / or local
// IP address (for computers with several connections). Outbounds that only talk to Best's own
// local forwarders (127.0.0.1) and chained ones (they dial through another outbound) are skipped.

const LOOP = /^(127\.|::1$|localhost$)/i;

function xrayTarget(o) {
  const st = o.settings || {};
  const v = (st.vnext && st.vnext[0]) || (st.servers && st.servers[0]) || st;
  return v.address || '';
}

function applyBinding(config, core, settings) {
  const iface = settings.bindInterface || '';
  const src = settings.sendThrough || '';
  if (!iface && !src) return config;
  if (core === 'mihomo') {
    if (iface) config['interface-name'] = iface; // mihomo has no per-connection source address
    return config;
  }
  if (core === 'xray') {
    for (const o of config.outbounds || []) {
      if (['blackhole', 'dns', 'loopback'].includes(o.protocol)) continue;
      if (LOOP.test(xrayTarget(o))) continue;
      const dialer = o.streamSettings && o.streamSettings.sockopt && o.streamSettings.sockopt.dialerProxy;
      if (dialer && dialer !== 'fragment') continue;
      if (src) o.sendThrough = src;
      if (iface) {
        o.streamSettings = o.streamSettings || {};
        o.streamSettings.sockopt = { ...(o.streamSettings.sockopt || {}), interface: iface };
      }
    }
    return config;
  }
  for (const o of [...(config.outbounds || []), ...(config.endpoints || [])]) {
    if (['block', 'dns', 'selector', 'urltest'].includes(o.type)) continue;
    if (o.server && LOOP.test(o.server)) continue;
    if (o.detour) continue;
    if (iface) o.bind_interface = iface;
    if (src) o[src.includes(':') ? 'inet6_bind_address' : 'inet4_bind_address'] = src;
  }
  return config;
}

module.exports = { applyBinding };
