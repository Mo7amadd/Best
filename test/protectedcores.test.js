'use strict';
// Cores installed while Best runs as administrator (all-users install in Program Files) must
// survive an app update: the installer removes the whole install folder first, so they live in
// Program Files\Best Updater\cores, outside it, and still only administrators can change them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('cores installed as administrator live outside the install folder, and only admin copies run elevated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'best-pf-'));
  const pf = path.join(root, 'Program Files');
  const resources = path.join(pf, 'Best', 'resources');
  const userData = path.join(root, 'AppData', 'Best');
  const exe = process.platform === 'win32' ? 'mihomo.exe' : 'mihomo';
  const saved = { ProgramW6432: process.env.ProgramW6432, ProgramFiles: process.env.ProgramFiles };
  const savedRes = process.resourcesPath;
  const electronKey = require.resolve('electron');
  const savedElectron = require.cache[electronKey];
  const updaterKey = require.resolve('../electron/updater');
  try {
    process.env.ProgramW6432 = pf;
    process.env.ProgramFiles = pf;
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true, writable: true });
    fs.mkdirSync(path.join(resources, 'cores'), { recursive: true });
    require.cache[electronKey] = { id: electronKey, filename: electronKey, loaded: true, exports: { app: { isPackaged: true, getPath: () => userData, getVersion: () => '1.0.6' }, session: {}, net: {} } };
    delete require.cache[updaterKey];
    const u = require('../electron/updater');
    assert.strictEqual(u.protectedInstall(), true, 'test setup: not seen as a Program Files install');
    u.setElevated(true);
    const admin = path.join(pf, 'Best Updater', 'cores');
    // Every place an elevated core may run from: the bundled folder or Best Updater\cores — never
    // inside resources (wiped by updates) apart from the bundled cores, never the user folder.
    const where = u.allCoreExes().filter((p) => p.includes(`${path.sep}mihomo${path.sep}`));
    assert.ok(where.some((p) => p.startsWith(admin + path.sep)), 'Best Updater\\cores is not used');
    assert.ok(!where.some((p) => p.includes('cores-updated')), 'the old place inside the install folder is still used');
    assert.ok(!admin.startsWith(path.join(pf, 'Best') + path.sep), 'the admin cores folder is inside the install folder');
    // mihomo installed as administrator (in Best Updater\cores) is found when elevated…
    assert.strictEqual(u.mihomoInstalled(), false);
    fs.mkdirSync(path.join(admin, 'mihomo'), { recursive: true });
    fs.writeFileSync(path.join(admin, 'mihomo', exe), 'x');
    assert.strictEqual(u.mihomoInstalled(), true);
    assert.strictEqual(u.coreExe('mihomo'), path.join(admin, 'mihomo', exe));
    // …and still found after an app update replaced the install folder.
    fs.rmSync(path.join(pf, 'Best'), { recursive: true, force: true });
    fs.mkdirSync(path.join(resources, 'cores'), { recursive: true });
    assert.strictEqual(u.mihomoInstalled(), true);
    // A copy in the user's own folder (writable by any program) is never run elevated.
    fs.rmSync(path.join(admin, 'mihomo'), { recursive: true, force: true });
    fs.mkdirSync(path.join(userData, 'cores', 'mihomo'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'cores', 'mihomo', exe), 'x');
    assert.strictEqual(u.mihomoInstalled(), false, 'an elevated Best would run a core from the user folder');
    // Not elevated: the user folder is used as before.
    u.setElevated(false);
    assert.strictEqual(u.coreExe('mihomo'), path.join(userData, 'cores', 'mihomo', exe));
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    Object.defineProperty(process, 'resourcesPath', { value: savedRes, configurable: true, writable: true });
    if (savedElectron) require.cache[electronKey] = savedElectron; else delete require.cache[electronKey];
    delete require.cache[updaterKey];
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mihomo installed only in the user folder is reported as such when Best runs as administrator', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'best-pf-'));
  const pf = path.join(root, 'Program Files');
  const resources = path.join(pf, 'Best', 'resources');
  const userData = path.join(root, 'AppData', 'Best');
  const exe = process.platform === 'win32' ? 'mihomo.exe' : 'mihomo';
  const saved = { ProgramW6432: process.env.ProgramW6432, ProgramFiles: process.env.ProgramFiles };
  const savedRes = process.resourcesPath;
  const electronKey = require.resolve('electron');
  const savedElectron = require.cache[electronKey];
  const updaterKey = require.resolve('../electron/updater');
  try {
    process.env.ProgramW6432 = pf;
    process.env.ProgramFiles = pf;
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true, writable: true });
    fs.mkdirSync(path.join(resources, 'cores'), { recursive: true });
    require.cache[electronKey] = { id: electronKey, filename: electronKey, loaded: true, exports: { app: { isPackaged: true, getPath: () => userData, getVersion: () => '1.0.6' }, session: {}, net: {} } };
    delete require.cache[updaterKey];
    const u = require('../electron/updater');
    u.setElevated(true);
    assert.strictEqual(u.mihomoUserOnly(), false, 'nothing installed');
    fs.mkdirSync(path.join(userData, 'cores', 'mihomo'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'cores', 'mihomo', exe), 'x');
    assert.strictEqual(u.mihomoInstalled(), false);
    assert.strictEqual(u.mihomoUserOnly(), true, 'the user copy is not reported');
    // installed again as administrator: usable, nothing to report
    const admin = path.join(pf, 'Best Updater', 'cores', 'mihomo');
    fs.mkdirSync(admin, { recursive: true });
    fs.writeFileSync(path.join(admin, exe), 'x');
    assert.strictEqual(u.mihomoUserOnly(), false);
    // without administrator rights the user copy is simply installed
    fs.rmSync(admin, { recursive: true, force: true });
    u.setElevated(false);
    assert.strictEqual(u.mihomoInstalled(), true);
    assert.strictEqual(u.mihomoUserOnly(), false);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    Object.defineProperty(process, 'resourcesPath', { value: savedRes, configurable: true, writable: true });
    if (savedElectron) require.cache[electronKey] = savedElectron; else delete require.cache[electronKey];
    delete require.cache[updaterKey];
    fs.rmSync(root, { recursive: true, force: true });
  }
});
