# Best updater task (runs as SYSTEM, started on demand by the "\Best\Updater" scheduled task).
# It installs the newest official Best release, and nothing else:
#  - the version and the SHA-256 come from GitHub itself (api.github.com, https), never from the user;
#  - only a version newer than the installed one is installed (no downgrades);
#  - the installer that Best already downloaded (ProgramData\Best\incoming) is only reused when its
#    copy in an administrators-only folder has exactly that SHA-256; otherwise it is downloaded here;
#  - it takes no parameters, so starting it can do nothing but update Best.
# This file and its folder (Program Files\Best Updater) are written by the installer and only
# administrators can change them.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repo = 'Mo7amadd/Best'
$self = Split-Path -Parent $PSCommandPath
$work = Join-Path $self 'work'
$incoming = Join-Path $env:ProgramData 'Best\incoming'
$log = Join-Path $env:ProgramData 'Best\update.log'

function Log([string]$m) {
  try {
    if ((Test-Path $log) -and (Get-Item $log).Length -gt 256KB) { Remove-Item $log -Force }
    "$(Get-Date -Format s) $m" | Out-File -LiteralPath $log -Append -Encoding utf8
  } catch { }
}
function Sha256([string]$f) { (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower() }

try {
  $exe = (Get-Content -LiteralPath (Join-Path $self 'target.txt') -TotalCount 1).Trim()
  if (-not (Test-Path -LiteralPath $exe)) { throw "Best.exe not found: $exe" }
  $current = [version](((Get-Item -LiteralPath $exe).VersionInfo.ProductVersion) -replace '^(\d+\.\d+\.\d+).*$', '$1')

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'Best-updater' } -TimeoutSec 60
  $tag = [string]$rel.tag_name -replace '^v', ''
  if ($rel.draft -or $rel.prerelease -or $tag -notmatch '^\d+\.\d+\.\d+$') { throw "unexpected release '$tag'" }
  if ([version]$tag -le $current) { Log "nothing newer than $current (latest $tag)"; exit 0 }
  $name = "Best-Setup-v$tag.exe"
  $asset = @($rel.assets | Where-Object { $_.name -eq $name })[0]
  if (-not $asset -or [string]$asset.digest -notmatch '^sha256:([0-9a-f]{64})$') { throw "no checksum for $name" }
  $want = $Matches[1]

  New-Item -ItemType Directory -Force -Path $work | Out-Null
  Get-ChildItem -LiteralPath $work -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  $file = Join-Path $work $name
  $given = Join-Path $incoming $name
  if (Test-Path -LiteralPath $given) { Copy-Item -LiteralPath $given -Destination $file -Force }
  if (-not (Test-Path -LiteralPath $file) -or (Sha256 $file) -ne $want) {
    Log "downloading $name"
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $file -UseBasicParsing -TimeoutSec 1800 -Headers @{ 'User-Agent' = 'Best-updater' }
  }
  if ((Sha256 $file) -ne $want) { throw "checksum of $name does not match the release" }

  # Best has to be closed before its files are replaced.
  $dir = Split-Path -Parent $exe
  for ($i = 0; $i -lt 60; $i++) {
    $busy = Get-Process -Name Best -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($dir + '\', [StringComparison]::OrdinalIgnoreCase) }
    if (-not $busy) { break }
    Start-Sleep -Seconds 1
  }
  Log "installing $tag (was $current)"
  $p = Start-Process -FilePath $file -ArgumentList '/S' -Wait -PassThru
  Log "installer finished with code $($p.ExitCode)"
  Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $given -Force -ErrorAction SilentlyContinue
  exit $p.ExitCode
} catch {
  Log "failed: $($_.Exception.Message)"
  exit 1
}
