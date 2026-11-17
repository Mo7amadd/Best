'use strict';
// Custom hosts ("domain ip" lines, like the Windows hosts file but in the tunnel's own DNS).

const { cleanText } = require('./util');

const DOMAIN = /^(?=.{1,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9-]{1,63}$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:]{2,39}$/i;

/**
 * "1.2.3.4 example.com" (hosts-file order) or "example.com 1.2.3.4 5.6.7.8" lines → { domain: [ips] }.
 * Comments (#) and invalid lines are skipped. `skipLocal` drops localhost-style entries.
 */
function parseHosts(text, { skipLocal = false, max = 500 } = {}) {
  const out = {};
  let n = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = cleanText(raw.replace(/#.*/, ''), 2000).trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const ips = parts.filter((p) => IPV4.test(p) || (p.includes(':') && IPV6.test(p)));
    const names = parts.filter((p) => DOMAIN.test(p) && !IPV4.test(p)).map((d) => d.toLowerCase());
    if (!ips.length || !names.length) continue;
    if (skipLocal && ips.every((ip) => /^(127\.|::1$)/.test(ip))) continue; // 0.0.0.0 blocking lines are kept
    for (const d of names) {
      if (skipLocal && /(^|\.)localhost$/.test(d)) continue;
      out[d] = [...new Set([...(out[d] || []), ...ips])].slice(0, 8);
      if (++n >= max) return out;
    }
  }
  return out;
}

module.exports = { parseHosts };
