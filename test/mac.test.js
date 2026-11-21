'use strict';
// The macOS version: what differs from Windows (electron/platform.js and the macOS parts that run
// without Electron). On Windows these check the text formats and names; on a Mac (the build machine)
// the same tests also run Apple's real tools.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const P = require('../electron/platform');
const { hwidHeaders, newSecret } = require('../src/core/hwid');
const { buildTunConfig } = require('../src/core/singbox-config');
const { DEFAULT_SETTINGS } = require('../src/core/settings');

const ON_MAC = process.platform === 'darwin';

test('core files: Windows keeps exactly its old names; macOS gets the right file per processor', () => {
  // Windows (what Best always downloaded)
  assert.deepStrictEqual(P.coreAsset('xray', 'v26.11.9', 'win32', 'x64'), { name: 'Xray-windows-64.zip', format: 'zip' });
  assert.deepStrictEqual(P.coreAsset('singbox', 'v1.14.4', 'win32', 'x64'), { name: 'sing-box-1.14.4-windows-amd64.zip', format: 'zip' });
  assert.deepStrictEqual(P.coreAsset('mihomo', 'v1.19.34', 'win32', 'x64'), { name: 'mihomo-windows-amd64-compatible-v1.19.34.zip', format: 'zip' });
  // macOS (names as published on GitHub)
  assert.deepStrictEqual(P.coreAsset('xray', 'v26.11.9', 'darwin', 'arm64'), { name: 'Xray-macos-arm64-v8a.zip', format: 'zip' });
  assert.deepStrictEqual(P.coreAsset('xray', 'v26.11.9', 'darwin', 'x64'), { name: 'Xray-macos-64.zip', format: 'zip' });
  assert.deepStrictEqual(P.coreAsset('singbox', 'v1.14.4', 'darwin', 'arm64'), { name: 'sing-box-1.14.4-darwin-arm64.tar.gz', format: 'tgz' });
  assert.deepStrictEqual(P.coreAsset('singbox', 'v1.14.4', 'darwin', 'x64'), { name: 'sing-box-1.14.4-darwin-amd64.tar.gz', format: 'tgz' });
  assert.deepStrictEqual(P.coreAsset('mihomo', 'v1.19.34', 'darwin', 'arm64'), { name: 'mihomo-darwin-arm64-v1.19.34.gz', format: 'gz' });
  assert.deepStrictEqual(P.coreAsset('mihomo', 'v1.19.34', 'darwin', 'x64'), { name: 'mihomo-darwin-amd64-compatible-v1.19.34.gz', format: 'gz' });
  assert.throws(() => P.coreAsset('other', 'v1', 'darwin', 'x64'));
  // program names
  assert.deepStrictEqual(['xray', 'sing-box', 'mihomo'].map((c) => P.exeName(c, 'win32')), ['xray.exe', 'sing-box.exe', 'mihomo.exe']);
  assert.deepStrictEqual(['xray', 'sing-box', 'mihomo'].map((c) => P.exeName(c, 'darwin')), ['xray', 'sing-box', 'mihomo']);
  assert.deepStrictEqual(P.coreFiles('singbox', 'win32'), ['sing-box.exe', 'libcronet.dll']);
  assert.deepStrictEqual(P.coreFiles('singbox', 'darwin'), ['sing-box']); // the macOS build has no libcronet
  assert.strictEqual(P.archOf('arm64'), 'arm64');
  assert.strictEqual(P.archOf('x64'), 'x64');
  assert.strictEqual(P.archOf('ia32'), 'x64');
});

test('Best\'s own update file: Windows unchanged, macOS per processor', () => {
  assert.strictEqual(P.appAssetName('1.0.6', { platform: 'win32' }), 'Best-Setup-v1.0.6.exe');
  assert.strictEqual(P.appAssetName('1.0.6', { platform: 'win32', portable: true }), 'Best-v1.0.6-portable.zip');
  assert.strictEqual(P.appAssetName('1.0.6', { platform: 'darwin', arch: 'arm64' }), 'Best-v1.0.6-mac-arm64.zip');
  assert.strictEqual(P.appAssetName('1.0.6-beta.1', { platform: 'darwin', arch: 'x64' }), 'Best-v1.0.6-beta.1-mac-x64.zip');
  // the name electron-builder gives the macOS files (package.json › build.mac.artifactName)
  const pkg = require('../package.json');
  assert.strictEqual(pkg.build.mac.artifactName, 'Best-v${version}-mac-${arch}.${ext}');
  assert.strictEqual(pkg.build.dmg.artifactName, pkg.build.mac.artifactName);
});

test('macOS bypass list: the Windows list becomes networks macOS understands; junk is dropped', () => {
  const list = P.macBypassList(DEFAULT_SETTINGS.proxyBypass);
  for (const want of ['localhost', '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/16', '172.31.0.0/16', '192.168.0.0/16', '*.local', '169.254/16']) {
    assert.ok(list.includes(want), `${want} missing`);
  }
  assert.ok(!list.some((x) => x.includes('*') && /^\d/.test(x)), 'an "10.*" pattern was left as it is');
  assert.ok(!list.includes('<local>'));
  assert.deepStrictEqual(P.macBypassList('-rf;$(reboot);a b;`x`;10.*;300.*;example.com;*.corp.example;fe80::/10'),
    ['a', 'b', '10.0.0.0/8', 'example.com', '*.corp.example', 'fe80::/10']);
  assert.deepStrictEqual(P.macBypassList(''), []);
});

test('networksetup output: services, proxy state and PAC address are read correctly', () => {
  const services = P.parseNetworkServices('An asterisk (*) denotes that a network service is disabled.\nUSB 10/100/1000 LAN\nWi-Fi\n*Thunderbolt Bridge\nBluetooth PAN\n\n');
  assert.deepStrictEqual(services, ['USB 10/100/1000 LAN', 'Wi-Fi', 'Bluetooth PAN']);
  assert.deepStrictEqual(P.parseProxyState('Enabled: Yes\nServer: 127.0.0.1\nPort: 10809\nAuthenticated Proxy Enabled: 0\n'), { enabled: true, server: '127.0.0.1', port: 10809 });
  assert.deepStrictEqual(P.parseProxyState('Enabled: No\nServer: \nPort: 0\nAuthenticated Proxy Enabled: 0\n'), { enabled: false, server: '', port: 0 });
  assert.deepStrictEqual(P.parseAutoProxy('URL: http://127.0.0.1:10810/proxy.pac?t=1\nEnabled: Yes\n'), { enabled: true, url: 'http://127.0.0.1:10810/proxy.pac?t=1' });
  assert.deepStrictEqual(P.parseAutoProxy('URL: (null)\nEnabled: No\n'), { enabled: false, url: '' });
  assert.ok(P.isOwnPac('http://127.0.0.1:10810/proxy.pac?t=5'));
  assert.ok(!P.isOwnPac('http://wpad.corp.example/proxy.pac'));
});

test('macOS proxy steps: on, PAC and off; only what Best set is ever turned off', () => {
  const s = { ...DEFAULT_SETTINGS, httpPort: 10809, pacPort: 10810 };
  const none = { web: { enabled: false }, secure: { enabled: false }, auto: { enabled: false, url: '' } };
  const on = P.macProxySteps('Wi-Fi', 'on', s, none);
  assert.deepStrictEqual(on.slice(0, 2), [['-setwebproxy', 'Wi-Fi', '127.0.0.1', '10809'], ['-setsecurewebproxy', 'Wi-Fi', '127.0.0.1', '10809']]);
  assert.strictEqual(on[2][0], '-setproxybypassdomains');
  assert.ok(on[2].includes('*.local'));
  assert.strictEqual(on.length, 3, 'no PAC to turn off');
  // a PAC that was on is turned off so the proxy takes effect
  assert.deepStrictEqual(P.macProxySteps('Wi-Fi', 'on', s, { ...none, auto: { enabled: true, url: 'http://wpad/x.pac' } }).at(-1), ['-setautoproxystate', 'Wi-Fi', 'off']);
  const pac = P.macProxySteps('Wi-Fi', 'pac', s, { web: { enabled: true, server: '127.0.0.1', port: 10809 }, secure: { enabled: true, server: '127.0.0.1', port: 10809 }, auto: { enabled: false } });
  assert.deepStrictEqual(pac.slice(0, 2), [['-setwebproxystate', 'Wi-Fi', 'off'], ['-setsecurewebproxystate', 'Wi-Fi', 'off']]);
  assert.match(pac[2][2], /^http:\/\/127\.0\.0\.1:10810\/proxy\.pac\?t=\d+$/);
  // off: Best's own proxy and PAC go; a company proxy or PAC stays
  const ours = { web: { enabled: true, server: '127.0.0.1', port: 10809 }, secure: { enabled: true, server: 'localhost', port: 10809 }, auto: { enabled: true, url: 'http://127.0.0.1:10810/proxy.pac?t=1' } };
  assert.deepStrictEqual(P.macProxySteps('Wi-Fi', 'off', s, ours).map((x) => x[0]), ['-setwebproxystate', '-setsecurewebproxystate', '-setautoproxystate']);
  const theirs = { web: { enabled: true, server: 'proxy.corp.example', port: 8080 }, secure: { enabled: true, server: '10.0.0.5', port: 8080 }, auto: { enabled: true, url: 'http://wpad.corp.example/proxy.pac' } };
  assert.deepStrictEqual(P.macProxySteps('Wi-Fi', 'off', s, theirs), []);
  // another program's proxy on this computer (another port) stays too
  const clash = { web: { enabled: true, server: '127.0.0.1', port: 7890 }, secure: { enabled: true, server: '127.0.0.1', port: 7890 }, auto: { enabled: false } };
  assert.deepStrictEqual(P.macProxySteps('Wi-Fi', 'off', s, clash), []);
  assert.deepStrictEqual(P.macProxySteps('Wi-Fi', 'keep', s, ours), []);
  assert.throws(() => P.macProxySteps('Wi-Fi', 'on', { ...s, httpPort: 70000 }, none), /bad port/);
  assert.throws(() => P.macProxySteps('Wi-Fi', 'pac', { ...s, pacPort: '1; rm' }, none), /bad port/);
});

test('ps output: process ids and full program paths (also with spaces)', () => {
  const out = P.parsePs('    1 /sbin/launchd\n  812 /Users/a b/Library/Application Support/Best/cores/xray/xray\n  900 (zombie)\n 1000 node\n');
  assert.deepStrictEqual(out, [{ pid: 1, path: '/sbin/launchd' }, { pid: 812, path: '/Users/a b/Library/Application Support/Best/cores/xray/xray' }]);
});

test('login item: a valid LaunchAgent that opens Best hidden; odd characters are escaped', () => {
  const xml = P.launchAgentPlist('com.best.client.login', '/Applications/R&D <Best>.app');
  assert.match(xml, /<string>\/Applications\/R&amp;D &lt;Best&gt;\.app<\/string>/);
  assert.match(xml, /<string>--hidden<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key><true\/>/);
  assert.ok(!xml.includes('<Best>'));
});

test('the app bundle Best runs from, and when it cannot replace itself', () => {
  assert.strictEqual(P.macAppBundle('/Applications/Best.app/Contents/MacOS/Best'), '/Applications/Best.app');
  assert.strictEqual(P.macAppBundle('/Users/a/Apps/My Best.app/Contents/MacOS/Best'), '/Users/a/Apps/My Best.app');
  assert.strictEqual(P.macAppBundle('/private/var/folders/x/T/AppTranslocation/ABC/d/Best.app/Contents/MacOS/Best'), '');
  assert.strictEqual(P.macAppBundle('/Volumes/Best 1.0.6/Best.app/Contents/MacOS/Best'), '');
  assert.strictEqual(P.macAppBundle('C:\\Program Files\\Best\\Best.exe'), '');
  assert.strictEqual(P.macAppBundle('/usr/local/bin/electron'), '');
});

test('device id headers: macOS names itself; Windows stays as it was', () => {
  const secret = newSecret();
  const win = hwidHeaders({ secret, url: 'https://p.example/sub', osVersion: '10.0.26100' });
  assert.strictEqual(win['x-device-os'], 'Windows');
  assert.strictEqual(win['x-device-model'], 'Windows PC');
  const mac = hwidHeaders({ secret, url: 'https://p.example/sub', os: 'macOS', osVersion: '15.1.0', defaultModel: 'Mac' });
  assert.strictEqual(mac['x-device-os'], 'macOS');
  assert.strictEqual(mac['x-ver-os'], '15.1.0');
  assert.strictEqual(mac['x-device-model'], 'Mac');
  assert.strictEqual(hwidHeaders({ secret, url: 'x', os: 'macOS', defaultModel: 'Mac', model: 'Work laptop' })['x-device-model'], 'Work laptop');
  assert.strictEqual(mac['x-hwid'], win['x-hwid'], 'the id itself does not depend on the system');
});

test('TUN: Best\'s own cores go direct, matched by their full macOS paths too', () => {
  const cfg = buildTunConfig({ ...DEFAULT_SETTINGS, tunCorePaths: ['/Applications/Best.app/Contents/Resources/cores/xray/xray', '/Users/a b/Library/Application Support/Best/cores/sing-box/sing-box'] });
  const rule = cfg.route.rules.find((r) => r.process_path_regex);
  assert.ok(rule, 'no rule for the cores');
  const re = new RegExp(rule.process_path_regex[0].replace('(?i)', ''), 'i');
  assert.ok(re.test('/Applications/Best.app/Contents/Resources/cores/xray/xray'));
  assert.ok(re.test('/Users/a b/Library/Application Support/Best/cores/sing-box/sing-box'));
  assert.ok(!re.test('/tmp/xray'));
  // Windows paths keep working
  const w = buildTunConfig({ ...DEFAULT_SETTINGS, tunCorePaths: ['C:\\Program Files\\Best\\resources\\cores\\xray\\xray.exe'] });
  assert.ok(w.route.rules.some((r) => r.process_path_regex));
});

test('macOS texts: every one in all four languages, same placeholders, never "Windows"', async () => {
  const { MAC } = await import(`file://${path.join(__dirname, '..', 'renderer', 'i18n-mac.js').replace(/\\/g, '/')}`);
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'i18n.js'), 'utf8');
  const base = (name) => {
    const a = src.indexOf(`const ${name} = {`);
    const e = src.indexOf('\n};', a);
    return Function(`return ${src.slice(a + `const ${name} = `.length, e + 2)}`)();
  };
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const keys = Object.keys(MAC.en);
  for (const l of ['fa', 'en', 'ru', 'zh']) {
    assert.deepStrictEqual(Object.keys(MAC[l]).sort(), [...keys].sort(), `${l}: not the same keys as English`);
    const b = base(l);
    for (const k of keys) {
      assert.ok(String(MAC[l][k]).trim(), `${l}.${k} is empty`);
      assert.strictEqual(ph(MAC[l][k]), ph(MAC.en[k]), `${l}.${k}: placeholders differ from English`);
      if (k in b) assert.strictEqual(ph(MAC[l][k]), ph(b[k]), `${l}.${k}: placeholders differ from the Windows text`);
      assert.ok(!/Windows|ویندوز|UAC|DPAPI/.test(MAC[l][k]), `${l}.${k} still names Windows`);
    }
  }
});

test('package: the macOS build takes its own cores, signs for free (ad-hoc) and keeps Windows as before', () => {
  const b = require('../package.json').build;
  assert.deepStrictEqual(b.win.extraResources, [{ from: 'resources/cores', to: 'cores' }]);
  assert.deepStrictEqual(b.mac.extraResources[0], { from: 'resources/cores-mac-${arch}', to: 'cores' });
  assert.ok(!b.extraResources.some((r) => /cores/.test(r.from)), 'cores in the shared list would put Windows programs into the Mac app');
  // the menu bar icons go into the Mac app only (the Windows package stays exactly as it was)
  assert.deepStrictEqual(b.extraResources.find((r) => r.from === 'resources/icons').filter, ['**/*', '!mac-*']);
  assert.deepStrictEqual(b.mac.extraResources.find((r) => r.from === 'resources/icons').filter, ['mac-*']);
  assert.strictEqual(b.mac.identity, '-');
  assert.strictEqual(b.mac.hardenedRuntime, false);
  for (const t of b.mac.target) assert.deepStrictEqual(t.arch.sort(), ['arm64', 'x64']);
  assert.ok(fs.existsSync(path.join(__dirname, '..', b.mac.icon)));
  assert.ok(fs.existsSync(path.join(__dirname, '..', b.dmg.background)));
  for (const c of b.dmg.contents) if (c.path && c.type === 'file') assert.ok(fs.existsSync(path.join(__dirname, '..', c.path)), `${c.path} missing`);
  for (const s of ['off', 'on', 'tun']) assert.ok(fs.existsSync(path.join(__dirname, '..', 'resources', 'icons', `mac-${s}Template@2x.png`)));
});

test('TUN helper: the password prompt gets every argument as one quoted piece', () => {
  const s = P.appleScriptAdmin(['/bin/sh', '/Applications/My "Best".app/Contents/Resources/helper/install.sh', 'a\\b', '501'], 'Best wants to install its TUN helper.');
  assert.strictEqual(s, 'do shell script quoted form of "/bin/sh" & " " & quoted form of "/Applications/My \\"Best\\".app/Contents/Resources/helper/install.sh" & " " & quoted form of "a\\\\b" & " " & quoted form of "501" with prompt "Best wants to install its TUN helper." with administrator privileges');
  // a line break cannot end the AppleScript text early: it is written as \n inside the text
  const multi = P.appleScriptAdmin(['/bin/sh', '-c', 'echo a\r\necho "b"'], 'p');
  assert.ok(!/[\r\n]/.test(multi));
  assert.ok(multi.includes('quoted form of "echo a\\necho \\"b\\""'));
  assert.throws(() => P.appleScriptAdmin([], 'p'));
  assert.throws(() => P.appleScriptAdmin(['/bin/sh', 'a\0b'], 'p'));
});

test('TUN for the macOS helper: the Windows adapter name goes, nothing else changes', () => {
  const cfg = buildTunConfig({ ...DEFAULT_SETTINGS, tunCorePaths: ['/Applications/Best.app/Contents/Resources/cores/xray/xray'] });
  const mac = P.macTunConfig(cfg);
  assert.strictEqual(cfg.inbounds[0].interface_name, 'BestTun', 'the original was changed');
  assert.ok(!('interface_name' in mac.inbounds[0]));
  delete cfg.inbounds[0].interface_name;
  assert.deepStrictEqual(mac, cfg);
  // what the helper accepts (helper/mac/BestTunHelper.swift): these parts only, no file anywhere
  assert.deepStrictEqual(Object.keys(mac).sort(), ['dns', 'inbounds', 'log', 'outbounds', 'route']);
  assert.ok(mac.outbounds.every((o) => ['socks', 'direct', 'block'].includes(o.type)));
  assert.ok(mac.outbounds.filter((o) => o.type === 'socks').every((o) => o.server === '127.0.0.1'));
  assert.ok(!JSON.stringify(mac).includes('"output"') && !JSON.stringify(mac).includes('rule_set'));
});

test('package: the TUN helper and its scripts go into the Mac app only', () => {
  const b = require('../package.json').build;
  assert.ok(b.mac.extraResources.some((r) => r.from === 'resources/helper-mac-${arch}' && r.to === 'helper'));
  assert.ok(!b.extraResources.some((r) => /helper/.test(r.from)) && !b.win.extraResources.some((r) => /helper/.test(r.from)));
  for (const f of ['BestTunHelper.swift', 'install.sh', 'uninstall.sh']) assert.ok(fs.existsSync(path.join(__dirname, '..', 'helper', 'mac', f)), `${f} missing`);
  // the version the app expects is the one the helper reports
  const swift = fs.readFileSync(path.join(__dirname, '..', 'helper', 'mac', 'BestTunHelper.swift'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'electron', 'mac', 'tun.js'), 'utf8');
  assert.strictEqual((/helperVersion = "(\d+)"/.exec(swift) || [])[1], (/HELPER_VERSION = '(\d+)'/.exec(js) || [])[1]);
  // the socket path and the folder are the same in the app, the helper and the scripts
  assert.ok(swift.includes('/var/run/com.best.client.tun.socket') && js.includes('/var/run/com.best.client.tun.socket'));
  const install = fs.readFileSync(path.join(__dirname, '..', 'helper', 'mac', 'install.sh'), 'utf8');
  assert.ok(swift.includes('/Library/PrivilegedHelperTools/com.best.client.tun') && install.includes('dir=/Library/PrivilegedHelperTools/$label'));
});

// ------------------------------------------------------------------ on a Mac only

test('on a Mac: networksetup lists services and parses; ps shows this test with its path', { skip: !ON_MAC }, () => {
  const services = P.parseNetworkServices(execFileSync('/usr/sbin/networksetup', ['-listallnetworkservices'], { encoding: 'utf8' }));
  assert.ok(services.length > 0, 'no network service');
  const state = P.parseProxyState(execFileSync('/usr/sbin/networksetup', ['-getwebproxy', services[0]], { encoding: 'utf8' }));
  assert.strictEqual(typeof state.enabled, 'boolean');
  const ps = P.parsePs(execFileSync('/bin/ps', ['-axww', '-o', 'pid=,comm='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  const me = ps.find((p) => p.pid === process.pid);
  assert.ok(me, 'this process is not in the list');
  assert.strictEqual(fs.realpathSync(me.path), fs.realpathSync(process.execPath));
});

test('on a Mac: the login item is a valid property list', { skip: !ON_MAC }, () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'best-plist-')), 'x.plist');
  fs.writeFileSync(file, P.launchAgentPlist('com.best.client.login', '/Applications/Best.app'));
  execFileSync('/usr/bin/plutil', ['-lint', file]);
  assert.strictEqual(execFileSync('/usr/bin/plutil', ['-extract', 'ProgramArguments.3', 'raw', '-o', '-', file], { encoding: 'utf8' }).trim(), '/Applications/Best.app');
});

test('the update swap script: waits for Best, swaps the app, keeps the old one when the new one is missing', { skip: process.platform === 'win32' }, () => {
  const { SWAP_SCRIPT } = loadSwapScript();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'best-swap-'));
  const script = path.join(root, 'swap.sh');
  fs.writeFileSync(script, SWAP_SCRIPT, { mode: 0o700 });
  const make = (dir, mark) => { fs.mkdirSync(path.join(dir, 'Contents'), { recursive: true }); fs.writeFileSync(path.join(dir, 'Contents', 'mark'), mark); };
  // 1) normal: the old app is replaced, the work folder removed
  const target = path.join(root, 'Apps', 'Best.app');
  const work = path.join(root, 'best-update-abc');
  const fresh = path.join(work, 'x', 'Best.app');
  make(target, 'old'); make(fresh, 'new');
  const dead = spawnSync(process.execPath, ['-e', '0']).pid; // a process id that has already ended
  spawnSync('/bin/sh', [script, String(dead), target, fresh, work]);
  assert.strictEqual(fs.readFileSync(path.join(target, 'Contents', 'mark'), 'utf8'), 'new');
  assert.ok(!fs.existsSync(work), 'work folder left behind');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(target)), ['Best.app'], 'the old copy was not removed');
  // 2) the new app is missing: the old one stays, the log explains
  fs.mkdirSync(path.join(work, 'x'), { recursive: true });
  spawnSync('/bin/sh', [script, String(dead), target, fresh, work]);
  assert.strictEqual(fs.readFileSync(path.join(target, 'Contents', 'mark'), 'utf8'), 'new');
  assert.match(fs.readFileSync(path.join(work, 'update.log'), 'utf8'), /could not be moved/);
  // 3) arguments that are not an app, or another work folder, are refused before anything moves
  assert.strictEqual(spawnSync('/bin/sh', [script, String(dead), '/', fresh, work]).status, 2);
  assert.strictEqual(spawnSync('/bin/sh', [script, String(dead), target, fresh, root]).status, 2);
  assert.ok(fs.existsSync(root));
});

/** mac/appupdate.js needs Electron's `shell`; the script text alone does not. */
function loadSwapScript() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'mac', 'appupdate.js'), 'utf8');
  const m = /const SWAP_SCRIPT = `([\s\S]*?)`;/.exec(src);
  assert.ok(m, 'SWAP_SCRIPT not found');
  return { SWAP_SCRIPT: m[1].replace(/\r\n/g, '\n') }; // as JavaScript reads the template (line ends become \n)
}
