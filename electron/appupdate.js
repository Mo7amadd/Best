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

// Versions: 1.0.3, or a test version of it such as 1.0.3-beta.2 (semantic versioning).
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$/;

/** a > b by semantic versioning: 1.2.10 > 1.2.9, and 1.0.3-beta.1 < 1.0.3-beta.2 < 1.0.3. */
function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre = ''] = String(v).replace(/^v/, '').split(/-(.*)/s);
    return { n: core.split('.').map((x) => Number.parseInt(x, 10) || 0), pre: pre ? pre.split('.') : [] };
  };
  const x = split(a); const y = split(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] || 0) !== (y.n[i] || 0)) return (x.n[i] || 0) > (y.n[i] || 0) ? 1 : -1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1; // a release beats its test versions
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]; const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    const pn = /^\d+$/.test(p); const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) > Number(q) ? 1 : -1;
    if (pn !== qn) return pn ? -1 : 1; // numbers sort before words
    if (!pn && p !== q) return p > q ? 1 : -1;
  }
  return 0;
}
const newer = (a, b) => compareVersions(a, b) > 0;

function assetName(version, portable) {
  return portable ? `Best-v${version}-portable.zip` : `Best-Setup-v${version}.exe`;
}

/**
 * { latest, available, asset, digest } for this kind of install, or null when not configured.
 * beta: also offer test versions (GitHub pre-releases); without it only official releases count.
 */
async function checkApp(updater, portable, beta = false) {
  if (!REPO_OK) return null;
  // Read from github.com, not its API (see updater.latestTag): no hourly limit to run into.
  let tag;
  if (beta) {
    // The newest of the recent releases and pre-releases (drafts are never in the list).
    const tags = (await updater.releaseTags(REPO)).filter((t) => VERSION.test(String(t).replace(/^v/, '')));
    tag = tags.reduce((best, t) => (!best || newer(t, best) ? t : best), '');
    if (!tag) return { latest: '', available: false };
  } else {
    tag = await updater.latestTag(REPO); // GitHub's "latest" is never a pre-release or a draft
  }
  const latest = String(tag).replace(/^v/, '');
  if (!VERSION.test(latest) || (!beta && latest.includes('-'))) return { latest: beta ? latest : '', available: false };
  const installed = app.getVersion();
  // A test version is installed and test versions are turned off: the official release may be
  // installed even though it is older ("back"), but only when the user asks for it.
  const back = !beta && installed.includes('-') && !latest.includes('-') && compareVersions(latest, installed) < 0;
  // Nothing to install: no need to fetch the checksum (one request less on every check).
  if (!newer(latest, installed) && !back) return { latest, available: false, back: false };
  const name = assetName(latest, portable);
  // The checksum file published with the release (SHA256SUMS); releases before it: the API.
  let digest = await updater.publishedDigest(REPO, `v${latest}`, 'SHA256SUMS', name);
  let asset = { name, browser_download_url: `https://github.com/${REPO}/releases/download/v${latest}/${name}`, size: 0 };
  if (!digest) {
    const rel = await updater.releaseByTag(REPO, `v${latest}`).catch(() => null);
    const a = rel && !rel.draft && (rel.assets || []).find((x) => x.name === name);
    digest = (a && (/^sha256:([0-9a-f]{64})$/.exec(a.digest || '') || [])[1]) || '';
    if (a) asset = a;
  }
  return { latest, available: (newer(latest, installed) || back) && Boolean(asset && digest), back, asset, digest };
}

/** Download, verify and hand over to the installer / swap script. Resolves when Best should quit. */
async function applyApp(updater, info, portable, onProgress, signal = null) {
  // The size GitHub lists for the file (at most 800 MB) is the limit; slow connections get 40 minutes.
  // (Without the API the size is not known: then 800 MB.)
  const maxBytes = Math.min(Number(info.asset.size) || 800 * 1024 * 1024, 800 * 1024 * 1024) + 1024 * 1024;
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
 * only installs a newer published release (or, from a test version, the latest official release).
 * A small script, running as this user, waits for it and
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
    // (the target may also be older: back from a test version to the official release)
    return p && VERSION.test(p.version) && p.version !== app.getVersion() ? p.version : '';
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

module.exports = { checkApp, applyApp, newer, compareVersions, failedTaskUpdate, REPO, REPO_OK };
