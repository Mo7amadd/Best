'use strict';
// Decode subscription content (base64 or plain list of share links) and the
// `subscription-userinfo` header that most panels send.

const { b64decode, looksLikeBase64, cleanText } = require('./util');
const { parseLink, normalizeServer } = require('./links');
const { parseClash, looksLikeClash } = require('./clash');

const MAX_SERVERS = 5000;
const SCHEMES = /^(vmess|vless|trojan|ss|socks5?|hysteria2?|hy2|tuic|wireguard|wg|anytls|naive\+https|naive\+quic|vpn|awg):\/\//i;

/** Turn raw text (clipboard, file, subscription body) into share-link lines. */
function extractLines(text) {
  let body = String(text || '').replace(/^﻿/, '').trim();
  if (!body) return [];
  if (!SCHEMES.test(body) && looksLikeBase64(body)) {
    try { body = b64decode(body); } catch { /* keep as is */ }
  }
  return body.split(/\r?\n|\s+(?=[a-z0-9]+:\/\/)/i).map((l) => l.trim()).filter(Boolean);
}

/**
 * JSON subscriptions (3x-ui "JSON" output, v2rayN custom configs): one full core config, or an
 * array of them, each with an optional "remarks". Returns null when the text is not such JSON.
 */
function parseJsonConfigs(text, subId) {
  const t = String(text || '').trim();
  if (!/^[[{]/.test(t)) return null;
  let data;
  try { data = JSON.parse(t); } catch { return null; }
  const list = Array.isArray(data) ? data : [data];
  if (!list.length || !list.every((c) => c && typeof c === 'object' && Array.isArray(c.outbounds))) return null;
  const servers = [];
  const errors = [];
  list.slice(0, 500).forEach((cfg, i) => {
    try {
      const singBox = cfg.outbounds.some((o) => o && typeof o.type === 'string') || Boolean(cfg.route);
      servers.push(normalizeServer({
        protocol: 'custom', core: singBox ? 'sing-box' : 'xray', config: JSON.stringify(cfg),
        remark: cleanText(cfg.remarks || cfg.remark || `Config ${i + 1}`, 120), subId, managedInbounds: true,
      }));
    } catch (e) { errors.push({ line: `#${i + 1}`, error: cleanText(e.message, 120) }); }
  });
  return { servers, errors, skipped: 0 };
}

/**
 * Parse every link in the text.
 * Returns { servers, errors, skipped } – bad lines never abort the whole import.
 */
function parseContent(text, { subId = '' } = {}) {
  // Other subscription formats first: JSON configs and Clash / Mihomo YAML (also when base64-wrapped).
  const raw = String(text || '').trim();
  if (raw && !/^[[{]/.test(raw) && !looksLikeClash(raw) && looksLikeBase64(raw)) {
    try {
      const decoded = b64decode(raw).trim();
      if (/^[[{]/.test(decoded) || looksLikeClash(decoded)) text = decoded;
    } catch { /* not base64 */ }
  }
  const json = parseJsonConfigs(text, subId);
  if (json) return json;
  if (looksLikeClash(text)) {
    const r = parseClash(text);
    if (subId) for (const s of r.servers) s.subId = subId;
    return { ...r, skipped: 0 };
  }
  const servers = [];
  const errors = [];
  let skipped = 0;
  for (const line of extractLines(text)) {
    if (servers.length >= MAX_SERVERS) { skipped++; continue; }
    if (!SCHEMES.test(line)) { skipped++; continue; }
    try {
      const s = parseLink(line);
      if (subId) s.subId = subId;
      servers.push(s);
    } catch (e) {
      errors.push({ line: cleanText(line, 60), error: cleanText(e.message, 120) });
    }
  }
  // 3x-ui marks only its VLESS links of an Xray 26+ server; the Trojan REALITY links of the same
  // server need Xray just as much, so carry the mark over to every REALITY server on that host.
  const newReality = new Set(servers.filter((s) => s.tls === 'reality' && s.pqKex).map((s) => String(s.address).toLowerCase()));
  for (const s of servers) if (s.tls === 'reality' && newReality.has(String(s.address).toLowerCase())) s.pqKex = true;
  return { servers, errors, skipped };
}

/** `upload=1; download=2; total=3; expire=1700000000` → numbers (bytes / unix seconds). */
function parseUserInfo(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const [k, v] = part.split('=').map((x) => (x || '').trim().toLowerCase());
    const n = Number(v);
    if (['upload', 'download', 'total', 'expire'].includes(k) && Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
}

/**
 * Panels often add info entries such as "Traffic: 10GB" pointing at 127.0.0.1 or 0.0.0.0.
 * They are not real servers, so they are split out and shown as subscription info instead.
 */
function splitInfoNodes(servers) {
  const real = [];
  const info = [];
  for (const s of servers) {
    // Addresses of this computer itself: panels use them for "info" lines (traffic left, expiry).
    // They must never become servers — testing them would send requests to local services.
    const a = String(s.address || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (/^(127\.|0\.0\.0\.0$|0$|localhost$|.*\.localhost$|::1?$|::ffff:(127\.|7f[0-9a-f]{2}:|0:0$|0\.0\.0\.0$)|0:0:0:0:0:0:0:[01]$)/.test(a)) info.push(s.remark || s.address);
    else real.push(s);
  }
  return { servers: real, info };
}

module.exports = { extractLines, parseContent, parseJsonConfigs, parseUserInfo, splitInfoNodes, SCHEMES };
