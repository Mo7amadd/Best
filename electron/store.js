'use strict';
// JSON persistence in the user's profile folder.
// Files with secrets (servers, subscriptions) are encrypted with Windows DPAPI through Electron's
// safeStorage, so copying the file to another account or machine does not reveal any key.
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

function readJson(name, fallback) {
  const file = path.join(dataDir(), name);
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.startsWith(MAGIC)) {
      if (!canEncrypt()) throw new Error('encryption unavailable');
      text = safeStorage.decryptString(Buffer.from(text.slice(MAGIC.length), 'base64'));
    }
    return JSON.parse(text);
  } catch (e) {
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

module.exports = { readJson, writeJson, dataDir, canEncrypt };
