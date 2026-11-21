'use strict';
// Device id for subscription panels that limit how many devices a user may have (Remnawave and
// others): the client sends "x-hwid" with the subscription request, and the optional
// "x-device-os", "x-ver-os" and "x-device-model" (the headers Happ introduced).
//  - The id is not the computer's hardware id: a random secret made once on this computer (kept
//    encrypted, never in a backup), mixed with the panel's host name. A panel sees the same id
//    every time, also after a subscription is removed and added again, but two panels cannot tell
//    that they talk to the same computer.
//  - The computer's name is not sent (it often holds the owner's name): "Windows PC" unless the
//    user chose another name.
// Remnawave (v3) ignores an id that does not match /^[a-zA-Z0-9=-]{10,64}$/: 32 hex characters.

const crypto = require('crypto');

const DEFAULT_MODEL = 'Windows PC';

function newSecret() {
  return crypto.randomBytes(32).toString('hex');
}

const validSecret = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

/** The id one panel sees: the same for its host every time, a different one for any other host. */
function hwidFor(secret, url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* no host: still a stable id */ }
  return crypto.createHmac('sha256', String(secret)).update(`best-hwid\n${host}`).digest('hex').slice(0, 32);
}

/** A header value: printable ASCII only, short (a name typed by the user, the OS version). */
const headerText = (v, max) => String(v || '').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Request headers for a subscription fetch ({} when the user turned it off or there is no secret).
 * `os` / `defaultModel`: the system's name and the device name used when the user chose none
 * (Windows: "Windows" / "Windows PC"; macOS: "macOS" / "Mac").
 */
function hwidHeaders({ enabled = true, secret, url, osVersion = '', model = '', os = 'Windows', defaultModel = DEFAULT_MODEL }) {
  if (!enabled || !validSecret(secret)) return {};
  const h = { 'x-hwid': hwidFor(secret, url), 'x-device-os': headerText(os, 20) || 'Windows' };
  const ver = headerText(osVersion, 32);
  if (ver) h['x-ver-os'] = ver;
  h['x-device-model'] = headerText(model, 40) || headerText(defaultModel, 40) || DEFAULT_MODEL;
  return h;
}

/**
 * What a panel said about the device limit: 'limit' (this subscription has its maximum number of
 * devices), 'required' (the panel wants an id and none was sent), or ''.
 */
function hwidStatus(getHeader) {
  const on = (n) => String(getHeader(n) || '').trim().toLowerCase() === 'true';
  if (on('x-hwid-max-devices-reached') || on('x-hwid-limit')) return 'limit';
  if (on('x-hwid-not-supported')) return 'required';
  return '';
}

module.exports = { newSecret, validSecret, hwidFor, hwidHeaders, hwidStatus, DEFAULT_MODEL };
