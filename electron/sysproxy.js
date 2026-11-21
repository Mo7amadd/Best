'use strict';
// Windows system proxy (WinINet: Edge, Chrome, most desktop apps). macOS: mac/sysproxy.js.
// All values written here are validated numbers / whitelisted characters, and PowerShell is called
// with an argument array, so nothing user-controlled can be executed.

const { execFile } = require('child_process');
const SYS32 = require('path').join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const SYS_PS = require('path').join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'); // full path: never a powershell.exe from the current folder

const KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

const REFRESH = `
$sig = '[DllImport("wininet.dll", SetLastError = true)] public static extern bool InternetSetOption(System.IntPtr h, int o, System.IntPtr b, int l);'
$t = Add-Type -MemberDefinition $sig -Name WinInet -Namespace BestProxy -PassThru
[void]$t::InternetSetOption([System.IntPtr]::Zero, 39, [System.IntPtr]::Zero, 0)
[void]$t::InternetSetOption([System.IntPtr]::Zero, 37, [System.IntPtr]::Zero, 0)
`;

function ps(script) {
  return new Promise((resolve, reject) => {
    execFile(SYS_PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}

function quote(s) {
  return `'${String(s).replace(/['‘’‚‛]/g, "$&$&")}'`;
}

function checkPort(p) {
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('bad port');
  return p;
}

/** mode: 'off' | 'on' | 'pac' | 'keep' */
async function applySystemProxy(mode, settings) {
  if (process.platform !== 'win32' || mode === 'keep') return;
  let script;
  if (mode === 'on') {
    const server = `127.0.0.1:${checkPort(settings.httpPort)}`;
    const bypass = /^[A-Za-z0-9.*;:<>_\-[\]]*$/.test(settings.proxyBypass) ? settings.proxyBypass : '<local>';
    script = `
Set-ItemProperty -Path ${quote(KEY)} -Name ProxyEnable -Value 1 -Type DWord
Set-ItemProperty -Path ${quote(KEY)} -Name ProxyServer -Value ${quote(server)}
Set-ItemProperty -Path ${quote(KEY)} -Name ProxyOverride -Value ${quote(bypass)}
Remove-ItemProperty -Path ${quote(KEY)} -Name AutoConfigURL -ErrorAction SilentlyContinue`;
  } else if (mode === 'pac') {
    const url = `http://127.0.0.1:${checkPort(settings.pacPort)}/proxy.pac?t=${Date.now()}`;
    script = `
Set-ItemProperty -Path ${quote(KEY)} -Name ProxyEnable -Value 0 -Type DWord
Set-ItemProperty -Path ${quote(KEY)} -Name AutoConfigURL -Value ${quote(url)}`;
  } else {
    // Only remove a PAC address if it is ours.
    script = `
Set-ItemProperty -Path ${quote(KEY)} -Name ProxyEnable -Value 0 -Type DWord
$pac = (Get-ItemProperty -Path ${quote(KEY)} -Name AutoConfigURL -ErrorAction SilentlyContinue).AutoConfigURL
if ($pac -and $pac -like 'http://127.0.0.1:*/proxy.pac*') { Remove-ItemProperty -Path ${quote(KEY)} -Name AutoConfigURL -ErrorAction SilentlyContinue }`;
  }
  await ps(script + '\n' + REFRESH);
}

// macOS has its own (networksetup); the Windows code above is not used there.
module.exports = process.platform === 'darwin' ? require('./mac/sysproxy') : { applySystemProxy };
