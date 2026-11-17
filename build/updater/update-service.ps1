# Best updater task (runs as SYSTEM, started on demand by the "\Best\Updater" scheduled task).
# It installs a published Best release from GitHub, and nothing else:
#  - the version Best asked for (the name of the installer it put in ProgramData\Best\incoming, which
#    may be a test version when the user chose those), or else the newest official release;
#  - that version must be a published (not draft) release on GitHub, and the SHA-256 comes from
#    GitHub itself (api.github.com, https), never from the user;
#  - only a version newer than the installed one is installed (no downgrades), with one exception:
#    while a test version is installed, the latest official release may replace it (the way back);
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

# Semantic versions: 1.0.3, or a test version of it such as 1.0.3-beta.2 (which sorts before 1.0.3).
$VersionPattern = '^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?$'
function Compare-Version([string]$a, [string]$b) {
  if ($a -notmatch $VersionPattern) { throw "bad version '$a'" }; $x = $Matches.Clone()
  if ($b -notmatch $VersionPattern) { throw "bad version '$b'" }; $y = $Matches.Clone()
  for ($i = 1; $i -le 3; $i++) { if ([int]$x[$i] -ne [int]$y[$i]) { return [Math]::Sign([int]$x[$i] - [int]$y[$i]) } }
  if (-not $x[4] -or -not $y[4]) { if (-not $x[4] -and -not $y[4]) { return 0 }; if (-not $x[4]) { return 1 } else { return -1 } }
  $p = $x[4].Split('.'); $q = $y[4].Split('.')
  for ($i = 0; $i -lt [Math]::Max($p.Count, $q.Count); $i++) {
    if ($i -ge $p.Count) { return -1 }; if ($i -ge $q.Count) { return 1 }
    $pn = $p[$i] -match '^\d+$'; $qn = $q[$i] -match '^\d+$'
    if ($pn -and $qn) { if ([long]$p[$i] -ne [long]$q[$i]) { return [Math]::Sign([long]$p[$i] - [long]$q[$i]) } }
    elseif ($pn -ne $qn) { if ($pn) { return -1 } else { return 1 } }
    else { $c = [string]::CompareOrdinal($p[$i], $q[$i]); if ($c -ne 0) { return [Math]::Sign($c) } }
  }
  return 0
}

try {
  $exe = (Get-Content -LiteralPath (Join-Path $self 'target.txt') -TotalCount 1).Trim()
  if (-not (Test-Path -LiteralPath $exe)) { throw "Best.exe not found: $exe" }
  # The file version string holds the full version ("1.0.2", "1.0.3-beta.1"); the product version
  # is only the numeric "1.0.3.0" form, which would hide that a test version is installed.
  $info = (Get-Item -LiteralPath $exe).VersionInfo
  $current = ([string]$info.FileVersion).Trim()
  if ($current -notmatch $VersionPattern) { $current = [string]$info.ProductVersion -replace '^(\d+\.\d+\.\d+)\.\d+$', '$1' }
  if ($current -notmatch $VersionPattern) { throw "unexpected installed version '$current'" }

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $headers = @{ 'User-Agent' = 'Best-updater' }
  # A version Best asked for (its downloaded installer in the drop folder, e.g. a test version when
  # the user chose test versions); otherwise the newest official release. Either way GitHub must
  # list it as a published release, and its checksum comes from there.
  $asked = @(Get-ChildItem -LiteralPath $incoming -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^Best-Setup-v(.+)\.exe$' -and $Matches[1] -match $VersionPattern } |
    ForEach-Object { $_.Name -replace '^Best-Setup-v(.+)\.exe$', '$1' })
  $wanted = $null
  # An old leftover that is not newer than what is installed is ignored, except an official version
  # while a test version is installed: that may be the way back (checked against GitHub below).
  $isTest = $current.Contains('-')
  foreach ($v in $asked) {
    $fits = (Compare-Version $v $current) -gt 0 -or ($isTest -and -not $v.Contains('-'))
    if ($fits -and (-not $wanted -or (Compare-Version $v $wanted) -gt 0)) { $wanted = $v }
  }
  if ($wanted) {
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/tags/v$wanted" -Headers $headers -TimeoutSec 60
  } else {
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers $headers -TimeoutSec 60
  }
  $tag = [string]$rel.tag_name -replace '^v', ''
  if ($rel.draft -or $tag -notmatch $VersionPattern -or ($wanted -and $tag -ne $wanted) -or (-not $wanted -and $rel.prerelease)) { throw "unexpected release '$tag'" }
  if ((Compare-Version $tag $current) -le 0) {
    # Back from a test version: only to the official release GitHub lists as the latest one,
    # never to any other older version.
    $official = $null
    if ($wanted -and $isTest -and -not $rel.prerelease -and -not $tag.Contains('-')) {
      $official = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers $headers -TimeoutSec 60
    }
    if (-not $official -or $official.draft -or $official.prerelease -or [string]$official.tag_name -ne "v$tag") {
      Log "nothing newer than $current (asked $tag)"; exit 0
    }
    Log "going back from test version $current to the official release $tag"
  }
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
