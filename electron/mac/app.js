'use strict';
// The macOS parts of the window shell: the app menu, the login item and the menu bar icon.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Menu } = require('electron');
const { launchAgentPlist, macAppBundle } = require('../platform');

const LOGIN_LABEL = 'com.best.client.login';

/**
 * The menu bar menus of a Mac app. Without an Edit menu, ⌘C / ⌘V / ⌘A do not work in text fields.
 * Best's own shortcuts still work: the page sees a key before the menu does.
 */
function setAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
}

function loginAgentFile() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LOGIN_LABEL}.plist`);
}

/**
 * Open Best (hidden in the menu bar) when the user logs in: a per-user LaunchAgent, which works on
 * every macOS version without a paid signature and passes "--hidden" like the Windows start entry.
 * False when it cannot be set up from where Best runs now (the disk image, or Downloads without
 * being moved to Applications): the old entry, if any, is left as it is.
 */
function setOpenAtLogin(on, execPath = process.execPath) {
  const file = loginAgentFile();
  if (!on) {
    fs.rmSync(file, { force: true });
    return true;
  }
  const bundle = macAppBundle(execPath);
  if (!bundle) return false;
  const text = launchAgentPlist(LOGIN_LABEL, bundle);
  let current = '';
  try { current = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
  if (current !== text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode: 0o644 });
  }
  return true;
}

/** Menu bar icon (a template image macOS colours for a light or dark menu bar). */
function trayIconFile(iconsDir, state) {
  return path.join(iconsDir, `mac-${state}Template.png`);
}

module.exports = { setAppMenu, setOpenAtLogin, trayIconFile, LOGIN_LABEL };
