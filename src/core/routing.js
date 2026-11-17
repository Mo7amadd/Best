'use strict';
// Routing profiles (like v2rayN "rule sets") with compound rules.
//
// Stored model:
//   { activeId, country, domainStrategy, singboxStrategy, profiles: [Profile] }
//   Profile = { id, name, base: 'global' | 'bypass-local' | 'direct', blockAds, builtin, rules: [Rule] }
//   Rule    = { id, enabled, remark, outbound: 'proxy'|'direct'|'block',
//               domain[], ip[], port[], process[], network: ''|'tcp'|'udp'|'tcp,udp', protocol[] }
//   All non-empty matchers of one rule must match (AND), exactly like Xray / v2rayN rules.
//
// The config builders consume the flattened "effective routing" from effectiveRouting().

const { cleanText, randomId } = require('./util');

const DOMAIN_ENTRY = /^((geosite|domain|full|regexp|keyword|ext):)?[^\s"'`<>\\]{1,253}$/;
const IP_ENTRY = /^(geoip:!?[a-z0-9-]{1,40}|[0-9a-fA-F:.]{2,45}(\/\d{1,3})?)$/;
const PORT_ENTRY = /^\d{1,5}(-\d{1,5})?$/;
const PROCESS_ENTRY = /^[^\s"'`<>\\/:*?|]{1,128}$/;
const PROTOCOLS = ['http', 'tls', 'quic', 'bittorrent'];
const BASES = ['global', 'bypass-local', 'direct'];
const SB_STRATEGIES = ['', 'prefer_ipv4', 'prefer_ipv6', 'ipv4_only', 'ipv6_only'];

const BUILTIN = [
  { id: 'p-global', name: 'Global', base: 'global' },
  { id: 'p-local', name: 'My country direct', base: 'bypass-local' },
  { id: 'p-direct', name: 'Direct', base: 'direct' },
];

function list(v, test, max = 2000) {
  const raw = Array.isArray(v) ? v : String(v || '').split(/[\n,]+/);
  return raw.map((x) => cleanText(x, 253)).filter((x) => x && test.test(x)).slice(0, max);
}

/** Validate one rule. Accepts the current shape and the old {type, values} shape. */
function sanitizeRule(r) {
  if (!r || typeof r !== 'object') return null;
  const outbound = ['proxy', 'direct', 'block'].includes(r.outbound) ? r.outbound : null;
  if (!outbound) return null;
  const src = { ...r };
  if (r.type && r.values) src[r.type] = r.values; // pre-0.1.3 rules
  const network = String(src.network || '').toLowerCase().replace(/\s/g, '');
  const rule = {
    id: /^[a-f0-9]{6,32}$/.test(r.id || '') ? r.id : randomId(),
    enabled: r.enabled !== false,
    remark: cleanText(r.remark, 80),
    outbound,
    domain: list(src.domain, DOMAIN_ENTRY),
    ip: list(src.ip, IP_ENTRY),
    port: list(src.port, PORT_ENTRY, 200),
    process: list(src.process, PROCESS_ENTRY, 200),
    network: ['tcp', 'udp', 'tcp,udp'].includes(network) ? network : '',
    protocol: list(src.protocol, /^[a-z]+$/, 8).filter((p) => PROTOCOLS.includes(p)),
  };
  const hasMatcher = rule.domain.length || rule.ip.length || rule.port.length || rule.process.length || rule.network || rule.protocol.length;
  return hasMatcher ? rule : null;
}

function sanitizeProfile(p, fallbackName) {
  if (!p || typeof p !== 'object') return null;
  return {
    id: /^[a-z0-9-]{3,40}$/.test(p.id || '') ? p.id : `p-${randomId(8)}`,
    name: cleanText(p.name, 60) || fallbackName || 'Profile',
    base: BASES.includes(p.base) ? p.base : 'bypass-local',
    blockAds: typeof p.blockAds === 'boolean' ? p.blockAds : true,
    builtin: Boolean(p.builtin) && BUILTIN.some((b) => b.id === p.id),
    // Set when the profile was sent by a subscription panel ("Routing" header); refreshed with it.
    source: /^[a-f0-9]{6,32}$/.test(p.source || '') ? p.source : '',
    rules: (Array.isArray(p.rules) ? p.rules : []).map(sanitizeRule).filter(Boolean).slice(0, 500),
  };
}

function sanitizeRouting(input) {
  const src = input && typeof input === 'object' ? input : {};
  const legacyIr = src.mode === 'bypass-ir';
  const country = String(legacyIr && !src.country ? 'ir' : src.country || '').toLowerCase();
  let profiles = Array.isArray(src.profiles) ? src.profiles.map((p) => sanitizeProfile(p)).filter(Boolean) : null;
  let activeId = typeof src.activeId === 'string' ? src.activeId : '';

  if (!profiles) {
    // Migrate the single-mode model (0.1.0 – 0.1.2): its rules go into the profile of its mode.
    const oldMode = legacyIr ? 'bypass-local' : BASES.includes(src.mode) ? src.mode : 'global';
    const oldRules = Array.isArray(src.rules) ? src.rules : [];
    const blockAds = typeof src.blockAds === 'boolean' ? src.blockAds : true;
    profiles = BUILTIN.map((b) => sanitizeProfile({ ...b, builtin: true, blockAds, rules: b.base === oldMode ? oldRules : [] }));
    activeId = BUILTIN.find((b) => b.base === oldMode).id;
  }
  // The three built-in profiles always exist (they can be edited, not deleted).
  for (const b of BUILTIN) {
    const existing = profiles.find((p) => p.id === b.id);
    if (existing) { existing.builtin = true; existing.base = b.base; } else profiles.push(sanitizeProfile({ ...b, builtin: true }));
  }
  const seen = new Set();
  profiles = profiles.filter((p) => (seen.has(p.id) ? false : seen.add(p.id))).slice(0, 50);
  if (!profiles.some((p) => p.id === activeId)) activeId = profiles[0].id;

  return {
    activeId,
    country: /^[a-z]{2}$/.test(country) ? country : '',
    domainStrategy: ['AsIs', 'IPIfNonMatch', 'IPOnDemand'].includes(src.domainStrategy) ? src.domainStrategy : 'AsIs',
    singboxStrategy: SB_STRATEGIES.includes(src.singboxStrategy) ? src.singboxStrategy : '',
    profiles,
  };
}

/** What the config builders need: the active profile flattened with the global options. */
function effectiveRouting(routing) {
  const p = routing.profiles.find((x) => x.id === routing.activeId) || routing.profiles[0];
  return {
    mode: p.base,
    country: routing.country,
    domainStrategy: routing.domainStrategy,
    singboxStrategy: routing.singboxStrategy,
    blockAds: p.blockAds,
    rules: p.rules,
    profileName: p.name,
  };
}

/**
 * Import rules from text: v2rayN routing JSON (array of rules, or an object with "rules"),
 * a Best export, or a Xray "routing" object. Returns { rules, name }.
 */
function importRules(text) {
  let data;
  try { data = JSON.parse(String(text || '').trim()); } catch { throw new Error('INVALID_RULES'); }
  let name = '';
  if (data && data.app === 'best-routing' && data.profile) { name = data.profile.name || ''; data = data.profile.rules; }
  else if (data && !Array.isArray(data)) {
    name = data.remarks || data.name || '';
    data = data.rules || (data.routing && data.routing.rules) || [];
  }
  if (!Array.isArray(data)) throw new Error('INVALID_RULES');
  const rules = [];
  for (const r of data.slice(0, 1000)) {
    if (!r || typeof r !== 'object') continue;
    const outbound = String(r.outboundTag || r.outbound || '').toLowerCase();
    const mapped = sanitizeRule({
      enabled: r.enabled !== false,
      remark: r.remarks || r.remark || '',
      outbound: ['proxy', 'direct', 'block'].includes(outbound) ? outbound : outbound === 'blackhole' ? 'block' : '',
      domain: r.domain,
      ip: r.ip,
      port: typeof r.port === 'string' || typeof r.port === 'number' ? String(r.port).split(',') : r.port,
      process: r.process,
      network: r.network,
      protocol: r.protocol,
    });
    if (mapped) rules.push(mapped);
  }
  if (!rules.length) throw new Error('INVALID_RULES');
  return { rules, name: cleanText(name, 60) };
}

/** Export a profile's rules in the v2rayN rule format (also understood by Best's importer). */
function exportRules(profile) {
  return profile.rules.map((r) => {
    const o = { remarks: r.remark || undefined, outboundTag: r.outbound, enabled: r.enabled };
    if (r.domain.length) o.domain = r.domain;
    if (r.ip.length) o.ip = r.ip;
    if (r.port.length) o.port = r.port.join(',');
    if (r.process.length) o.process = r.process;
    if (r.network) o.network = r.network;
    if (r.protocol.length) o.protocol = r.protocol;
    return o;
  });
}

/**
 * Routing profile sent by a panel in the "Routing" response header (3x-ui / Happ / Incy format):
 * happ://routing/onadd/<base64 JSON> (or /add/, incy://…, or the JSON itself).
 * Returns { name, rules, domainStrategy } or null.
 */
function profileFromPanelRouting(value) {
  let text = String(value || '').trim();
  const m = /^(?:happ|incy):\/\/routing\/(?:onadd|add)\/(.+)$/i.exec(text);
  if (m) {
    try {
      const b = m[1].replace(/-/g, '+').replace(/_/g, '/');
      text = new TextDecoder().decode(Uint8Array.from(atob(b + '='.repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0)));
    } catch { return null; }
  }
  if (!text.startsWith('{') || text.length > 1024 * 1024) return null;
  let o;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const arr = (k) => (Array.isArray(o[k]) ? o[k] : typeof o[k] === 'string' && o[k] ? o[k].split(',') : []);
  const order = String(o.RouteOrder || 'block-direct-proxy').split('-').filter((x, i, a) => ['block', 'direct', 'proxy'].includes(x) && a.indexOf(x) === i);
  for (const g of ['block', 'direct', 'proxy']) if (!order.includes(g)) order.push(g);
  const lists = {
    block: { domain: arr('BlockSites'), ip: arr('BlockIp') },
    direct: { domain: arr('DirectSites'), ip: arr('DirectIp') },
    proxy: { domain: arr('ProxySites'), ip: arr('ProxyIp') },
  };
  // A panel may add direct exceptions, but never a catch-all "everything direct" that would
  // quietly take all traffic out of the tunnel.
  const catchAll = (x) => {
    const v = String(x).trim().toLowerCase();
    const cidr = /^[0-9a-f:.]+\/(\d{1,3})$/.exec(v);
    if (cidr) return Number(cidr[1]) < 8; // 0.0.0.0/0, ::/0, 0.0.0.0/1 …
    if (v.startsWith('geoip:!')) return true; // "everything except one country"
    return /^(regexp:\^?\.[*+]?\$?|regexp:|keyword:|domain:|full:)$/.test(v);
  };
  // Direct names: geosite lists, real domain names and longer keywords only. Regular expressions
  // and one-letter keywords ("regexp:[a-z]", "keyword:.") could match every site.
  const directName = (x) => {
    const v = String(x).trim().toLowerCase();
    if (catchAll(v) || v.startsWith('regexp:')) return false;
    if (v.startsWith('geosite:')) return /^geosite:[a-z0-9@!_.-]{2,60}$/.test(v);
    if (v.startsWith('keyword:')) return /^keyword:[a-z0-9-]{4,60}$/.test(v) && /[a-z]/.test(v.slice(8));
    const name = v.replace(/^(domain|full):/, '');
    return /^([a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/.test(name);
  };
  lists.direct.domain = lists.direct.domain.filter(directName).slice(0, 5000);
  // Direct addresses: no huge ranges, and all of them together at most 2^28 IPv4 addresses
  // (about 6% of the internet) — 223 "/8" entries would otherwise send everything direct.
  let budget = 2 ** 28;
  lists.direct.ip = lists.direct.ip.filter((x) => {
    const v = String(x).trim().toLowerCase();
    if (catchAll(v)) return false;
    if (v.startsWith('geoip:')) return /^geoip:[a-z0-9-]{2,30}$/.test(v);
    const m = /^([0-9a-f:.]+)(?:\/(\d{1,3}))?$/.exec(v);
    if (!m) return false;
    if (m[1].includes(':')) return m[2] === undefined || Number(m[2]) >= 16;
    const size = 2 ** (32 - (m[2] === undefined ? 32 : Number(m[2])));
    if (size > budget) return false;
    budget -= size;
    return true;
  }).slice(0, 5000);
  const rules = [];
  for (const g of order) {
    for (const key of ['domain', 'ip']) {
      const r = sanitizeRule({ outbound: g, remark: `${g} ${key}`, [key]: lists[g][key] });
      if (r) rules.push(r);
    }
  }
  const ds = ['AsIs', 'IPIfNonMatch', 'IPOnDemand'].includes(o.DomainStrategy) ? o.DomainStrategy : '';
  return { name: cleanText(o.Name, 60), rules, domainStrategy: ds };
}

module.exports = {
  profileFromPanelRouting,
  sanitizeRouting, sanitizeRule, sanitizeProfile, effectiveRouting, importRules, exportRules,
  BUILTIN, PROTOCOLS, SB_STRATEGIES,
};
