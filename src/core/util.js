'use strict';
// Small helpers shared by the core modules. Pure JS (works in Node, Electron and browsers)
// so the same code can be reused by a future mobile app.

const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g;

/** Trim, strip control / bidi-override characters and cap the length of untrusted text. */
function cleanText(value, max = 256) {
  if (value === undefined || value === null) return '';
  // Well-formed after the cut: a lone half of an emoji (from the input or from slicing through
  // one) makes encodeURIComponent throw later, e.g. when the share link is built.
  const s = String(value).replace(CONTROL_CHARS, '').trim().slice(0, max);
  return typeof s.toWellFormed === 'function' ? s.toWellFormed() : s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�');
}

function safeDecodeURIComponent(s) {
  if (!s) return '';
  try { return decodeURIComponent(s.replace(/\+/g, '%20')); } catch { return s; }
}

/** Decode a URI fragment/userinfo component without turning '+' into a space. */
function decodeComponent(s) {
  if (!s) return '';
  try { return decodeURIComponent(s); } catch { return s; }
}

function normalizeBase64(s) {
  let t = String(s).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  t = t.replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(t)) return null;
  if (t.length % 4 === 1) return null;
  while (t.length % 4) t += '=';
  return t;
}

function looksLikeBase64(s) {
  return normalizeBase64(s) !== null;
}

function b64decode(s) {
  const t = normalizeBase64(s);
  if (t === null) throw new Error('invalid base64');
  const bin = atob(t);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function b64encode(str, urlSafe = false) {
  const bytes = new TextEncoder().encode(String(str));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  let out = btoa(bin);
  if (urlSafe) out = out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return out;
}

function parsePort(p) {
  const n = Number(String(p).trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('invalid port: ' + cleanText(p, 20));
  return n;
}

/** Accept domain names (incl. IDN), IPv4 and IPv6 literals. Rejects anything that could break a config. */
function parseHost(h) {
  let host = cleanText(decodeComponent(h), 253);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host) throw new Error('empty address');
  if (/[\s/\\@?#"'<>`{}|^[\]]/.test(host)) throw new Error('invalid address');
  // A colon is only valid in an IPv6 address (e.g. "::1]" from a broken link is not one).
  if (host.includes(':') && !isIPv6(host)) throw new Error('invalid address');
  return host;
}

/** Strict IPv6 literal check (optional %zone and dotted IPv4 tail); no Node "net" so it runs anywhere. */
function isIPv6(h) {
  const m = /^([0-9a-f:.]+)(%[0-9a-z._-]{1,32})?$/i.exec(h);
  if (!m) return false;
  let addr = m[1];
  // A dotted IPv4 tail (::ffff:1.2.3.4) stands for the last two groups.
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (v4) {
    if (v4.slice(1).some((x) => Number(x) > 255) || !/(^|:)$/.test(addr.slice(0, v4.index))) return false;
    addr = addr.slice(0, v4.index) + '0:0';
  }
  if (addr.includes('.')) return false;
  const halves = addr.split('::');
  if (halves.length > 2) return false;
  const groups = halves.map((x) => (x === '' ? [] : x.split(':')));
  if (groups.flat().some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return false;
  const n = groups.flat().length;
  return halves.length === 2 ? n <= 7 : n === 8;
}

function randomId(len = 12) {
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, len);
}

function splitList(s, max = 16) {
  if (!s) return [];
  return String(s).split(',').map((x) => cleanText(x, 128)).filter(Boolean).slice(0, max);
}

function boolish(v) {
  if (v === true || v === 1) return true;
  const s = String(v ?? '').toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

/**
 * Shadowsocks 2022 keys must be base64 of exactly 16 bytes (aes-128) or 32 bytes (aes-256,
 * chacha20); a multi-user link joins server and user keys with ":". A wrong key makes the core
 * refuse to start at all, so check it up front. Throws SS_BAD_KEY.
 */
function checkSs2022Key(s) {
  if (!s || s.protocol !== 'shadowsocks' || !/^2022-/.test(s.cipher || '')) return;
  const want = s.cipher.includes('aes-128') ? 16 : 32;
  const parts = String(s.password || '').split(':');
  const bytes = (k) => {
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(k)) return -1;
    const t = k.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
    try { return atob(t + '='.repeat((4 - (t.length % 4)) % 4)).length; } catch { return -1; }
  };
  const ok = parts.every((k) => bytes(k) === want);
  if (!ok) throw new Error('SS_BAD_KEY');
}

module.exports = {
  cleanText, safeDecodeURIComponent, decodeComponent, looksLikeBase64, b64decode, b64encode,
  parsePort, parseHost, randomId, splitList, boolish, checkSs2022Key,
};
