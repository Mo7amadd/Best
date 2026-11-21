'use strict';
// What differs between Windows and macOS, as plain functions (no Electron here, so the tests run in
// Node): core file names, the GitHub release files for this system and processor, the file of
// Best's own update, and the small text formats of the macOS tools Best uses (networksetup, ps,
// launchd). Nothing in here runs a program.

const PLATFORM = process.platform;
const IS_MAC = PLATFORM === 'darwin';
const IS_WIN = PLATFORM === 'win32';

/** Processor name used in Best's own files: 'arm64' (Apple Silicon) or 'x64' (Intel). */
function archOf(arch = process.arch) {
  return arch === 'arm64' ? 'arm64' : 'x64';
}

/** File name of a core's program: xray.exe on Windows, xray on macOS. */
function exeName(core, platform = PLATFORM) {
  const base = core === 'xray' ? 'xray' : core === 'mihomo' ? 'mihomo' : 'sing-box';
  return platform === 'win32' ? `${base}.exe` : base;
}

/**
 * The release file of a core for this system and processor, and how it is packed:
 * 'zip', 'tgz' (tar.gz) or 'gz' (one gzip-compressed program, mihomo on macOS).
 * Windows keeps the files it always used (64-bit Intel/AMD builds).
 */
function coreAsset(id, tag, platform = PLATFORM, arch = archOf()) {
  const version = String(tag).replace(/^v/, '');
  const mac = platform === 'darwin';
  const arm = archOf(arch) === 'arm64';
  switch (id) {
    case 'xray':
      return { name: mac ? (arm ? 'Xray-macos-arm64-v8a.zip' : 'Xray-macos-64.zip') : 'Xray-windows-64.zip', format: 'zip' };
    case 'singbox':
      return mac
        ? { name: `sing-box-${version}-darwin-${arm ? 'arm64' : 'amd64'}.tar.gz`, format: 'tgz' }
        : { name: `sing-box-${version}-windows-amd64.zip`, format: 'zip' };
    case 'mihomo':
      return mac
        ? { name: `mihomo-darwin-${arm ? 'arm64' : 'amd64-compatible'}-${tag}.gz`, format: 'gz' }
        : { name: `mihomo-windows-amd64-compatible-${tag}.zip`, format: 'zip' };
    default:
      throw new Error(`unknown core ${id}`);
  }
}

/**
 * Files taken from a core's package: the program first, then what it needs next to it
 * (sing-box for Windows loads libcronet.dll; the macOS build has it built in).
 */
function coreFiles(id, platform = PLATFORM) {
  if (id === 'xray') return [exeName('xray', platform)];
  if (id === 'mihomo') return [exeName('mihomo', platform)];
  return platform === 'win32' ? ['sing-box.exe', 'libcronet.dll'] : ['sing-box'];
}

/**
 * Folder under resources/ with the cores the development app runs (npm start, the tests): the
 * Windows ones, or on a Mac those scripts/fetch-mac-cores.js put there for its processor.
 */
function devCoresFolder(platform = PLATFORM, arch = archOf()) {
  return platform === 'darwin' ? `cores-mac-${archOf(arch)}` : 'cores';
}

/** The release file of Best itself for this kind of install. */
function appAssetName(version, { portable = false, platform = PLATFORM, arch = archOf() } = {}) {
  if (platform === 'darwin') return `Best-v${version}-mac-${archOf(arch)}.zip`;
  return portable ? `Best-v${version}-portable.zip` : `Best-Setup-v${version}.exe`;
}

// ------------------------------------------------------------------ macOS system proxy

/**
 * The Windows-style bypass list of Settings ("localhost;127.*;10.*;…;<local>") as macOS writes it:
 * "10.*" becomes "10.0.0.0/8", "<local>" becomes the plain local names and link-local addresses.
 * Anything that is not a plain host, address, network or *-pattern is dropped.
 */
function macBypassList(text) {
  const out = [];
  for (const raw of String(text || '').split(/[;,\s]+/)) {
    const s = raw.trim();
    if (!s) continue;
    if (s.toLowerCase() === '<local>') { out.push('*.local', '169.254/16'); continue; }
    const wild = /^(\d{1,3}(?:\.\d{1,3}){0,2})\.\*$/.exec(s);
    if (wild) {
      const parts = wild[1].split('.');
      if (parts.every((p) => Number(p) <= 255)) out.push(`${[...parts, '0', '0', '0'].slice(0, 4).join('.')}/${parts.length * 8}`);
      continue;
    }
    if (/^[A-Za-z0-9.*:_\-[\]/]{1,253}$/.test(s) && !/^[-/]/.test(s)) out.push(s);
  }
  return [...new Set(out)].slice(0, 300);
}

/** Network services from `networksetup -listallnetworkservices` (disabled ones, marked *, left out). */
function parseNetworkServices(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  // The first line is a note about the asterisk, not a service.
  if (lines.length && /asterisk/i.test(lines[0])) lines.shift();
  return lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('*') && l.length <= 128 && !/[\u0000-\u001f\u007f]/.test(l));
}

/** "Key: value" lines of networksetup; an empty value stays empty (the next line is never taken). */
const field = (stdout, k) => ((new RegExp(`^${k}:[ \\t]*(.*)$`, 'mi').exec(String(stdout || '')) || [])[1] || '').trim();

/** `networksetup -getwebproxy <service>` (and -getsecurewebproxy) → { enabled, server, port }. */
function parseProxyState(stdout) {
  const get = (k) => field(stdout, k);
  return { enabled: /^yes$/i.test(get('Enabled')), server: get('Server'), port: Number(get('Port')) || 0 };
}

/** `networksetup -getautoproxyurl <service>` → { enabled, url }. */
function parseAutoProxy(stdout) {
  const get = (k) => field(stdout, k);
  const url = get('URL');
  return { enabled: /^yes$/i.test(get('Enabled')), url: /^\(null\)$/i.test(url) ? '' : url };
}

const isLoopback = (host) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host || '').toLowerCase());
/** Is this PAC address one Best serves (http://127.0.0.1:<port>/proxy.pac…)? */
const isOwnPac = (url) => /^http:\/\/127\.0\.0\.1:\d{1,5}\/proxy\.pac(\?|$)/.test(String(url || ''));

/**
 * The networksetup steps for one network service. `current` is what is set there now
 * ({ web, secure, auto } from the parse functions above); only what Best set itself is turned off.
 */
function macProxySteps(service, mode, settings, current) {
  const port = (p) => {
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('bad port');
    return String(p);
  };
  const steps = [];
  // Best's own: this computer at Best's HTTP port. Another program's local proxy (say Clash on
  // 7890) is left alone.
  const offIfOurs = (state, flag) => {
    if (state && state.enabled && isLoopback(state.server) && state.port === settings.httpPort) steps.push([flag, service, 'off']);
  };
  if (mode === 'on') {
    const p = port(settings.httpPort);
    steps.push(['-setwebproxy', service, '127.0.0.1', p]);
    steps.push(['-setsecurewebproxy', service, '127.0.0.1', p]);
    const bypass = macBypassList(settings.proxyBypass);
    steps.push(['-setproxybypassdomains', service, ...(bypass.length ? bypass : ['Empty'])]);
    if (current.auto && current.auto.enabled) steps.push(['-setautoproxystate', service, 'off']);
  } else if (mode === 'pac') {
    const url = `http://127.0.0.1:${port(settings.pacPort)}/proxy.pac?t=${Date.now()}`;
    offIfOurs(current.web, '-setwebproxystate');
    offIfOurs(current.secure, '-setsecurewebproxystate');
    steps.push(['-setautoproxyurl', service, url]);
  } else if (mode === 'off') {
    offIfOurs(current.web, '-setwebproxystate');
    offIfOurs(current.secure, '-setsecurewebproxystate');
    if (current.auto && current.auto.enabled && isOwnPac(current.auto.url)) steps.push(['-setautoproxystate', service, 'off']);
  }
  return steps;
}

// ------------------------------------------------------------------ macOS processes and login

/** `ps -axww -o pid=,comm=` → [{ pid, path }] (only lines whose program is a full path). */
function parsePs(stdout) {
  const out = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\/.*?)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), path: m[2] });
  }
  return out;
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The per-user LaunchAgent that opens Best when the user logs in, hidden in the menu bar
 * (the same as Windows' "--hidden" start). `open` starts it the normal way (LaunchServices).
 */
function launchAgentPlist(label, appPath) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${xml(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/usr/bin/open</string>',
    '    <string>-g</string>',
    '    <string>-a</string>',
    `    <string>${xml(appPath)}</string>`,
    '    <string>--args</string>',
    '    <string>--hidden</string>',
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>LimitLoadToSessionType</key><string>Aqua</string>',
    '  <key>ProcessType</key><string>Interactive</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/**
 * The .app folder a macOS program runs from (…/Best.app/Contents/MacOS/Best → …/Best.app), or ''.
 * '' too when it runs from a place it cannot be kept or replaced: the disk image itself (/Volumes)
 * or the read-only copy macOS makes for an app opened straight from Downloads (App Translocation).
 */
function macAppBundle(execPath) {
  const m = /^(\/.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(String(execPath || ''));
  if (!m) return '';
  if (/\/AppTranslocation\//.test(m[1]) || m[1].startsWith('/Volumes/')) return '';
  return m[1];
}

module.exports = {
  PLATFORM, IS_MAC, IS_WIN, archOf, exeName, coreAsset, coreFiles, appAssetName, devCoresFolder,
  macBypassList, parseNetworkServices, parseProxyState, parseAutoProxy, macProxySteps, isLoopback, isOwnPac,
  parsePs, launchAgentPlist, macAppBundle,
};
