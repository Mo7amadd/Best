'use strict';
// Updates of Best itself, from the GitHub releases of the repository named in package.json
// ("best.updateRepo"). The downloaded file must match the SHA-256 GitHub publishes for it.
//  - Installed copy: the new installer (Best-Setup-vX.Y.Z.exe) is started and Best quits.
//  - Portable copy:  the new zip (Best-vX.Y.Z-portable.zip) is unpacked next to Best and a small
//    script swaps the files after Best has closed (the data folder is never touched), then restarts.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { app, shell } = require('electron');

const REPO = (() => { try { return String(require('../package.json').best.updateRepo || ''); } catch { return ''; } })();
const REPO_OK = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(REPO);
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const ROBOCOPY = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'Robocopy.exe');
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** 1.2.10 > 1.2.9; pre-release tags (1.3.0-beta) are ignored. */
function newer(a, b) {
  const p = (v) => String(v).replace(/^v/, '').split('.').map((x) => Number.parseInt(x, 10) || 0);
  const x = p(a); const y = p(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

function assetName(version, portable) {
  return portable ? `Best-v${version}-portable.zip` : `Best-Setup-v${version}.exe`;
}

/** { latest, available, asset, digest } for this kind of install, or null when not configured. */
async function checkApp(updater, portable) {
  if (!REPO_OK) return null;
  const rel = await updater.latestRelease(REPO);
  if (rel.prerelease || rel.draft) return { latest: '', available: false };
  const latest = String(rel.tag_name).replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(latest)) return { latest, available: false };
  const asset = (rel.assets || []).find((a) => a.name === assetName(latest, portable));
  const digest = asset && (/^sha256:([0-9a-f]{64})$/.exec(asset.digest || '') || [])[1];
  return { latest, available: newer(latest, app.getVersion()) && Boolean(asset && digest), asset, digest };
}

/** Download, verify and hand over to the installer / swap script. Resolves when Best should quit. */
async function applyApp(updater, info, portable, onProgress, signal = null) {
  // The size GitHub lists for the file (at most 800 MB) is the limit; slow connections get 40 minutes.
  const maxBytes = Math.min(Number(info.asset.size) || 0, 800 * 1024 * 1024) + 1024 * 1024;
  const data = await updater.fetch(info.asset.browser_download_url, { binary: true, onProgress, maxBytes, timeoutMs: 40 * 60000, signal });
  if (signal && signal.aborted) throw new Error('CANCELLED');
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  if (hash !== info.digest) throw new Error('CHECKSUM_MISMATCH');
  // Elevated in a Program Files install, the installer is kept where only administrators can write,
  // so nothing can swap it between the checksum test and the start.
  const { adminOnly, runRoot } = require('./updater');
  const base = adminOnly() ? path.join(runRoot(), 'update') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'best-update-'));
  const file = path.join(dir, info.asset.name);
  fs.writeFileSync(file, data);
  // Checked again from disk right before it is used.
  const again = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (again !== info.digest) throw new Error('CHECKSUM_MISMATCH');

  if (!portable) {
    // 1) The updater task set up by the installer: no administrator prompt (see build/updater).
    if (await viaUpdaterTask(file, info)) return true;
    // 2) Otherwise the installer itself, which needs administrator rights (Program Files). WMI cannot
    // show the UAC prompt, so it refused to start it whenever Best ran as a standard user; Windows'
    // own ShellExecute shows the prompt, and the installer it starts is not tied to Best.
    const err = await shell.openPath(file);
    if (err) throw new Error(/cancel/i.test(err) ? 'UPDATE_UAC_DECLINED' : `UPDATE_START_FAILED: ${err}`);
    return true;
  }
  const out = path.join(dir, 'x');
  fs.mkdirSync(out);
  await new Promise((resolve, reject) => execFile(TAR, ['-xf', file, '-C', out], { windowsHide: true, timeout: 300000 }, (e) => (e ? reject(e) : resolve())));
  const src = fs.existsSync(path.join(out, 'Best', 'Best.exe')) ? path.join(out, 'Best') : out;
  if (!fs.existsSync(path.join(src, 'Best.exe'))) throw new Error('Best.exe missing in the package');
  const target = path.dirname(process.execPath);
  const q = (s) => `'${String(s).replace(/['‘’‚‛]/g, '$&$&')}'`;
  const exe = path.join(target, 'Best.exe');
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `$log = ${q(path.join(dir, 'update.log'))}`,
    'try {',
    `  Wait-Process -Id ${process.pid} -Timeout 60 -ErrorAction SilentlyContinue`,
    // Every Best.exe of this folder (renderer, GPU helper…) must be gone before files are replaced.
    `  for ($i = 0; $i -lt 60; $i++) { $busy = Get-Process -Name Best -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith(${q(target + path.sep)}, [StringComparison]::OrdinalIgnoreCase) }; if (-not $busy) { break }; Start-Sleep -Seconds 1 }`,
    '  Start-Sleep -Milliseconds 500',
    // Mirror the program files; the data folder and the portable marker stay as they are.
    `  & ${q(ROBOCOPY)} ${q(src)} ${q(target)} /E /R:10 /W:1 /XD data /XF portable /NP /NFL /NDL *> $log`,
    "  if ($LASTEXITCODE -ge 8) { throw \"robocopy failed with code $LASTEXITCODE\" }",
    `  Start-Process -FilePath ${q(exe)}`,
    `  Remove-Item -LiteralPath ${q(dir)} -Recurse -Force -ErrorAction SilentlyContinue`,
    '} catch {',
    // Whatever happened, the user gets Best back (the old files if nothing was copied); the log stays.
    "  \"$(Get-Date -Format s) $($_.Exception.Message)\" | Out-File -LiteralPath $log -Append -Encoding utf8",
    `  Start-Process -FilePath ${q(exe)}`,
    '}',
  ].join('\r\n');
  const file2 = path.join(dir, 'swap.ps1');
  fs.writeFileSync(file2, `﻿${script}`, 'utf8');
  await launchIndependent(`"${PS}" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${file2}"`);
  return true;
}

const SCHTASKS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'schtasks.exe');
const TASK = '\\Best\\Updater';
const run = (exe, args) => new Promise((resolve) => execFile(exe, args, { windowsHide: true, timeout: 20000 }, (e) => resolve(!e)));

/** Where Best notes the version an update should bring (checked on the next start). */
function pendingFile() { return path.join(app.getPath('userData'), 'update-pending.json'); }

/**
 * Hand the verified installer to the "\Best\Updater" task (runs as SYSTEM, installs without the
 * administrator prompt). The task trusts nothing it gets from here: it takes GitHub's checksum and
 * only installs a newer official release. A small script, running as this user, waits for it and
 * opens Best again. False when the task is not there or cannot be started.
 */
async function viaUpdaterTask(file, info) {
  if (!(await run(SCHTASKS, ['/Query', '/TN', TASK]))) return false;
  const incoming = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Best', 'incoming');
  try { fs.copyFileSync(file, path.join(incoming, info.asset.name)); } catch { return false; }
  if (!(await run(SCHTASKS, ['/Run', '/TN', TASK]))) return false;
  try { fs.writeFileSync(pendingFile(), JSON.stringify({ version: info.latest, at: Date.now() })); } catch { /* only for the message */ }
  const q = (s) => `'${String(s).replace(/['‘’‚‛]/g, '$&$&')}'`;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$t0 = Get-Date; $seen = $false',
    // Wait for the task to start and then to finish (at most 45 minutes), then open Best again.
    'while (((Get-Date) - $t0).TotalMinutes -lt 45) {',
    "  $s = (Get-ScheduledTask -TaskPath '\\Best\\' -TaskName 'Updater').State",
    "  if ($s -eq 'Running') { $seen = $true } elseif ($seen -or ((Get-Date) - $t0).TotalSeconds -gt 30) { break }",
    '  Start-Sleep -Seconds 2',
    '}',
    'Start-Sleep -Seconds 1',
    `Start-Process -FilePath ${q(process.execPath)}`,
    `Remove-Item -LiteralPath $PSCommandPath -Force`,
  ].join('\r\n');
  const f = path.join(os.tmpdir(), `best-restart-${process.pid}.ps1`);
  fs.writeFileSync(f, `﻿${script}`, 'utf8');
  await launchIndependent(`"${PS}" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${f}"`);
  return true;
}

/** On start: an update through the task that did not arrive → its target version (else ''). */
function failedTaskUpdate() {
  try {
    const p = JSON.parse(fs.readFileSync(pendingFile(), 'utf8'));
    fs.rmSync(pendingFile(), { force: true });
    return p && /^\d+\.\d+\.\d+$/.test(p.version) && newer(p.version, app.getVersion()) ? p.version : '';
  } catch { return ''; }
}

/**
 * Start a program that must outlive Best (the installer, the file-swap script). A normal child is
 * ended together with Best when it quits, so it is created by Windows (WMI) instead.
 */
function launchIndependent(commandLine) {
  const q = (s) => `'${String(s).replace(/['‘’‚‛]/g, '$&$&')}'`;
  const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${q(commandLine)} }; if ($r.ReturnValue -ne 0) { exit 1 }`;
  return new Promise((resolve, reject) => execFile(PS, ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 30000 },
    (e) => (e ? reject(new Error('UPDATE_START_FAILED')) : resolve())));
}

module.exports = { checkApp, applyApp, newer, failedTaskUpdate, REPO, REPO_OK };
