'use strict';
// JSON persistence in the user's profile folder.
// Files with secrets (servers, subscriptions) are encrypted through Electron's safeStorage (Windows
// DPAPI, the macOS Keychain), so copying the file to another account or machine reveals no key.
// Writes are atomic (tmp file + rename) so a crash never leaves a half-written file.

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const MAGIC = 'BEST-ENC1:';

function dataDir() {
  const dir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function canEncrypt() {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

// macOS keeps the key in the Keychain, and asks the user again after an update (Best has no paid
// signature). Refused there, an encrypted file is not set aside: the caller asks the user first
// (main.js), unless they chose to start empty (allowKeychainReset).
let keychainReset = false;
function allowKeychainReset() { keychainReset = true; }
function keychainError() {
  const e = new Error('KEYCHAIN_LOCKED');
  e.code = 'KEYCHAIN_LOCKED';
  return e;
}

function readJson(name, fallback) {
  const file = path.join(dataDir(), name);
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.startsWith(MAGIC)) {
      const mac = process.platform === 'darwin' && !keychainReset;
      if (!canEncrypt()) throw mac ? keychainError() : new Error('encryption unavailable');
      try {
        text = safeStorage.decryptString(Buffer.from(text.slice(MAGIC.length), 'base64'));
      } catch (e) { throw mac ? keychainError() : e; }
    }
    return JSON.parse(text);
  } catch (e) {
    if (e.code === 'KEYCHAIN_LOCKED') throw e; // the file stays where it is
    if (e.code !== 'ENOENT') {
      // Keep the unreadable file for the user instead of silently overwriting it.
      try { fs.renameSync(file, `${file}.broken-${Date.now()}`); } catch { /* ignore */ }
    }
    return typeof fallback === 'function' ? fallback() : structuredClone(fallback);
  }
}

function writeJson(name, data, { encrypt = false } = {}) {
  const file = path.join(dataDir(), name);
  let text = JSON.stringify(data, null, encrypt ? 0 : 2);
  if (encrypt && canEncrypt()) text = MAGIC + safeStorage.encryptString(text).toString('base64');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

module.exports = { readJson, writeJson, dataDir, canEncrypt, allowKeychainReset };
