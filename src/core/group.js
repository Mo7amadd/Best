'use strict';
// Server groups and proxy chains.
//
//  Group  = { protocol: 'group', id, remark, members: [server ids], memberSub: sub id ('' = none),
//             strategy: 'leastPing' | 'random' | 'roundRobin' | 'leastLoad' }
//           Connects through one of its members: the fastest live one (leastPing, re-checked every
//           30 s, so a dead server is left automatically), or spreads connections over all of them.
//  Chain  = any server with `via` (or a subscription with `via`): it is reached *through* the
//           "front" server, e.g. a nearby server first, then the real exit.
//
// Both are built on top of the normal single-server configs: the "proxy" outbound is replaced by
// the members (Xray balancer / sing-box urltest), and a front server is added as dialer / detour.

const { cleanText, randomId } = require('./util');

const STRATEGIES = ['leastPing', 'random', 'roundRobin', 'leastLoad'];
const ID = /^[a-f0-9]{6,32}$/;

function normalizeGroup(input) {
  const out = {
    id: ID.test(input.id || '') ? input.id : randomId(),
    protocol: 'group',
    remark: cleanText(input.remark, 120) || 'Group',
    strategy: STRATEGIES.includes(input.strategy) ? input.strategy : 'leastPing',
    members: (Array.isArray(input.members) ? input.members : []).filter((x) => ID.test(String(x))).slice(0, 200),
    memberSub: ID.test(input.memberSub || '') ? input.memberSub : '',
    subId: '',
  };
  if (Number.isFinite(input.delay)) out.delay = input.delay;
  for (const k of ['usageUp', 'usageDown']) if (Number.isFinite(input[k]) && input[k] >= 0) out[k] = input[k];
  return out;
}

// --------------------------------------------------------------------------- which core
/** 'xray' when every server can run on Xray, else 'sing-box' when all can, else an error. */
function pickCore(list, { needsSingBox, canSingBox }) {
  if (list.some((s) => !s || s.protocol === 'custom' || s.protocol === 'group')) throw new Error('GROUP_BAD_MEMBER');
  if (list.every((s) => !needsSingBox(s))) return 'xray';
  if (list.every((s) => canSingBox(s))) return 'sing-box';
  throw new Error('GROUP_MIXED_CORES');
}

// --------------------------------------------------------------------------- Xray
/**
 * Replace the single "proxy" outbound of a built Xray config with the group members and a
 * balancer called "proxy". `x` = helpers from xray-config; `loopPorts[i]` = forwarder port for
 * member i when it needs one (plain VLESS / Trojan to a public address).
 */
function xrayGroup(config, members, settings, strategy, x, loopPorts = []) {
  const tags = members.map((_, i) => `m-${i}`);
  const memberOutbounds = members.map((s, i) => (loopPorts[i] ? x.proxyOutbound(x.viaLoopback(s, loopPorts[i]), settings, tags[i]) : x.proxyOutbound(s, settings, tags[i])));
  config.outbounds = [...memberOutbounds, ...config.outbounds.filter((o) => o.tag !== 'proxy' && o.tag !== 'loop-out')];
  members.forEach((s, i) => {
    if (!loopPorts[i]) return;
    config.inbounds.push(x.loopbackInbound(s, loopPorts[i], `loop-in-${i}`));
  });
  if (loopPorts.some(Boolean)) config.outbounds.push({ tag: 'loop-out', protocol: 'freedom' });
  config.inbounds = config.inbounds.filter((i) => i.tag !== 'loop-in');
  const rules = (config.routing.rules || []).filter((r) => !(r.inboundTag && r.inboundTag.includes('loop-in')));
  for (const r of rules) if (r.outboundTag === 'proxy') { delete r.outboundTag; r.balancerTag = 'proxy'; }
  const loopRules = members.map((_, i) => (loopPorts[i] ? { type: 'field', inboundTag: [`loop-in-${i}`], outboundTag: 'loop-out' } : null)).filter(Boolean);
  config.routing.rules = [...loopRules, ...rules, { type: 'field', network: 'tcp,udp', balancerTag: 'proxy' }];
  config.routing.balancers = [{ tag: 'proxy', selector: tags, strategy: { type: strategy } }];
  const probe = { subjectSelector: tags };
  if (strategy === 'leastPing') {
    config.observatory = { ...probe, probeUrl: settings.testUrl || 'https://www.gstatic.com/generate_204', probeInterval: '30s', enableConcurrency: true };
  } else if (strategy === 'leastLoad') {
    config.burstObservatory = { ...probe, pingConfig: { destination: settings.testUrl || 'https://www.gstatic.com/generate_204', interval: '30s', sampling: 3, timeout: '5s' } };
  }
  return config;
}

/**
 * Chain for Xray: every outbound in `targets` (tags) dials through the front server `f-0`.
 * A plain front server (VLESS / Trojan without TLS) goes through its own local forwarder
 * (`frontLoopPort`); fragment (if on) applies to the front.
 */
function xrayChain(config, front, settings, x, targets, frontLoopPort = 0) {
  const f = x.proxyOutbound(frontLoopPort ? x.viaLoopback(front, frontLoopPort) : front, settings, 'f-0');
  if (frontLoopPort) {
    config.inbounds.push(x.loopbackInbound(front, frontLoopPort, 'loop-in-f'));
    config.outbounds.push({ tag: 'loop-out-f', protocol: 'freedom' });
    config.routing.rules.unshift({ type: 'field', inboundTag: ['loop-in-f'], outboundTag: 'loop-out-f' });
  }
  for (const o of config.outbounds) {
    if (!targets.includes(o.tag)) continue;
    o.streamSettings = o.streamSettings || {};
    o.streamSettings.sockopt = { ...(o.streamSettings.sockopt || {}), dialerProxy: 'f-0' };
  }
  config.outbounds.push(f);
  return config;
}

// --------------------------------------------------------------------------- sing-box
function singBoxGroup(config, members, settings, sb) {
  const tags = members.map((_, i) => `m-${i}`);
  const outs = []; const eps = [];
  members.forEach((s, i) => (s.protocol === 'wireguard' ? eps.push(sb.wireguardEndpoint(s, tags[i])) : outs.push(sb.singBoxOutbound(s, tags[i]))));
  config.outbounds = [
    { type: 'urltest', tag: 'proxy', outbounds: tags, url: settings.testUrl || 'https://www.gstatic.com/generate_204', interval: '1m', tolerance: 50, idle_timeout: '30m' },
    ...outs,
    ...config.outbounds.filter((o) => o.tag !== 'proxy'),
  ];
  const keepEps = (config.endpoints || []).filter((e) => e.tag !== 'proxy');
  if (eps.length || keepEps.length) config.endpoints = [...keepEps, ...eps]; else delete config.endpoints;
  return config;
}

function singBoxChain(config, front, sb, targets) {
  const f = front.protocol === 'wireguard' ? sb.wireguardEndpoint(front, 'f-0') : sb.singBoxOutbound(front, 'f-0');
  for (const o of [...config.outbounds, ...(config.endpoints || [])]) if (targets.includes(o.tag)) o.detour = 'f-0';
  if (front.protocol === 'wireguard') config.endpoints = [...(config.endpoints || []), f];
  else config.outbounds.push(f);
  return config;
}

module.exports = { normalizeGroup, pickCore, xrayGroup, xrayChain, singBoxGroup, singBoxChain, STRATEGIES };

/**
 * Full config for a group and/or a chain.
 * plan = { core, main (single server) | members (group), strategy, front (or null) }
 */
function buildComposite(plan, settings, routing, { loopPorts = [], loopbackPort = 0, frontLoopPort = 0, statsPort = 0, clashApi = null } = {}) {
  const x = require('./xray-config');
  const sb = require('./singbox-config');
  const group = Array.isArray(plan.members) && plan.members.length > 0;
  const first = group ? plan.members[0] : plan.main;
  if (plan.core === 'xray') {
    // The base is built for one server; its proxy / forwarder parts are replaced below.
    const base = x.buildXrayConfig(first, settings, routing, { loopbackPort: x.needsLoopback(first) ? (group ? 1 : loopbackPort) : 0, statsPort });
    let targets;
    if (group) {
      xrayGroup(base, plan.members, settings, plan.strategy, x, loopPorts);
      targets = [...plan.members.map((_, i) => (loopPorts[i] ? null : `m-${i}`)).filter(Boolean), ...(loopPorts.some(Boolean) ? ['loop-out'] : [])];
    } else {
      targets = x.needsLoopback(first) ? ['loop-out'] : ['proxy'];
    }
    if (plan.front) xrayChain(base, plan.front, settings, x, targets, frontLoopPort);
    return base;
  }
  const base = sb.buildSingBoxConfig(first, settings, routing, { clashApi });
  if (group) singBoxGroup(base, plan.members, settings, sb);
  if (plan.front) singBoxChain(base, plan.front, sb, group ? plan.members.map((_, i) => `m-${i}`) : ['proxy']);
  return base;
}

module.exports.buildComposite = buildComposite;
