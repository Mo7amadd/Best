'use strict';
// Microsoft Store (UWP) apps are not allowed to connect to 127.0.0.1, so they cannot use the local
// proxy. Windows' own CheckNetIsolation tool can exempt chosen apps ("loopback exemption").
// Listing needs no rights; changing the list asks for administrator approval (UAC) once.

const { execFile } = require('child_process');
const path = require('path');

const PFN = /^[A-Za-z0-9.-]{1,120}_[a-z0-9]{13}$/;
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const TOOL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'CheckNetIsolation.exe');

function run(file, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(String(out))));
  });
}

/** Installed Store apps with their exemption state: [{ name, pfn, exempt }]. */
async function listApps() {
  const script = "Get-AppxPackage | Where-Object { -not $_.IsFramework -and -not $_.IsResourcePackage -and $_.SignatureKind -ne 'System' } | Select-Object Name, PackageFamilyName | Sort-Object Name -Unique | ConvertTo-Json -Compress";
  const [apps, exempt] = await Promise.all([
    run(PS, ['-NoProfile', '-NonInteractive', '-Command', script]).then((t) => { const j = JSON.parse(t || '[]'); return Array.isArray(j) ? j : [j]; }),
    run(TOOL, ['LoopbackExempt', '-s']).catch(() => ''),
  ]);
  const on = new Set([...exempt.matchAll(/Name:\s*(\S+)/gi)].map((m) => m[1].toLowerCase()));
  return apps
    .filter((a) => a && PFN.test(a.PackageFamilyName || ''))
    .map((a) => ({ name: String(a.Name || a.PackageFamilyName).slice(0, 120), pfn: a.PackageFamilyName, exempt: on.has(a.PackageFamilyName.toLowerCase()) }));
}

/** Add / remove exemptions in one elevated run. Resolves false when the UAC prompt was declined. */
async function setExempt(add = [], remove = []) {
  const lines = exemptScript(add, remove);
  if (!lines) return true; // nothing to change
  // The inner script is passed base64-encoded (UTF-16LE), so nothing in it needs quoting.
  const encoded = Buffer.from(lines.join('\n'), 'utf16le').toString('base64');
  const outer = `$p = Start-Process -FilePath '${PS}' -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`;
  try {
    await run(PS, ['-NoProfile', '-NonInteractive', '-Command', outer], 120000);
    return true;
  } catch {
    return false; // declined or failed
  }
}

function exemptScript(add, remove) {
  const ok = (l) => (Array.isArray(l) ? l : []).filter((x) => PFN.test(String(x))).slice(0, 300);
  // '-n=...' must be quoted: unquoted, PowerShell splits "-n=Microsoft.WindowsCalculator_x" at the
  // first dot and the tool rejects it (Invalid Parameters). Names never contain quotes (PFN check).
  // Every step must succeed, otherwise the run reports failure.
  const lines = [
    "$ErrorActionPreference = 'Stop'; $bad = 0",
    ...ok(add).map((p) => `& '${TOOL}' LoopbackExempt -a '-n=${p}' | Out-Null; if ($LASTEXITCODE -ne 0) { $bad++ }`),
    ...ok(remove).map((p) => `& '${TOOL}' LoopbackExempt -d '-n=${p}' | Out-Null; if ($LASTEXITCODE -ne 0) { $bad++ }`),
    'exit $bad',
  ];
  return lines.length > 2 ? lines : null; // first and last lines are fixed
}

module.exports = { listApps, setExempt, exemptScript };
