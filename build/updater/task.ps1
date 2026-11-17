# Registers (or removes) the "\Best\Updater" scheduled task. Run by the installer, as administrator,
# from Program Files\Best Updater (written there by the installer itself).
#   task.ps1 -Register -Exe "C:\Program Files\Best\Best.exe"
#   task.ps1 -Unregister
param([switch]$Register, [switch]$Unregister, [string]$Exe)
$ErrorActionPreference = 'Stop'
$taskPath = '\Best\'
$taskName = 'Updater'
$self = Split-Path -Parent $PSCommandPath

if ($Unregister) {
  Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  exit 0
}
if (-not $Register -or -not $Exe) { exit 2 }

# Where Best is installed (read by the task; only administrators can change this file).
Set-Content -LiteralPath (Join-Path $self 'target.txt') -Value $Exe -Encoding UTF8
New-Item -ItemType Directory -Force -Path (Join-Path $self 'work') | Out-Null

# Drop folder: Best (running as the user) leaves the downloaded installer here. The task never runs
# it from here; it copies it into its own folder and checks it against GitHub's checksum first.
$data = Join-Path $env:ProgramData 'Best'
$incoming = Join-Path $data 'incoming'
New-Item -ItemType Directory -Force -Path $incoming | Out-Null
# Owned by administrators even if someone created the folder earlier.
& "$env:SystemRoot\System32\icacls.exe" $data /setowner '*S-1-5-32-544' /T | Out-Null
& "$env:SystemRoot\System32\icacls.exe" $data /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
& "$env:SystemRoot\System32\icacls.exe" $incoming /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null

# The task is being used for an update right now: leave it as it is.
$existing = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and $existing.State -eq 'Running') { exit 0 }

$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$script = Join-Path $self 'update-service.ps1'
$esc = { param($s) [Security.SecurityElement]::Escape($s) }
# SYSTEM and administrators: full control; signed-in users: read and start only (no changes).
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Best</Author>
    <Description>Installs updates of Best: only official releases, checked against their published SHA-256.</Description>
    <SecurityDescriptor>D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;AU)</SecurityDescriptor>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$(& $esc $ps)</Command>
      <Arguments>-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$(& $esc $script)"</Arguments>
    </Exec>
  </Actions>
</Task>
"@
Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Xml $xml -Force | Out-Null
exit 0
