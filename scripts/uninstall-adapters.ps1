<#
.SYNOPSIS
  Uninstall HALOFLUX host adapters (manifest-driven, reversible).
.DESCRIPTION
  Restores each host config from the byte-identical backup recorded at install
  time. If a host config changed after install, only HALOFLUX entries are removed
  and the drift is reported (unrelated changes are preserved).

  Selection: -Hosts, -All, or by default every host that currently has installed
  HALOFLUX entries. Use -DryRun on real user configs to preview without writing.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-adapters.ps1 -DryRun
.EXAMPLE
  .\uninstall-adapters.ps1 -Hosts claude-code -BackupRoot D:\HALOFLUX\tmp\backups
.EXAMPLE
  .\uninstall-adapters.ps1 -All -NonInteractive
#>
[CmdletBinding()]
param(
  [string[]]$Hosts,
  [switch]$All,
  [switch]$NonInteractive,
  [switch]$Json,
  [string]$BackupRoot,
  [string]$NodePath,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$supported = @('claude-code', 'codex', 'cursor', 'trae', 'workbuddy', 'generic')

if (-not $NodePath) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { Write-Error 'node.exe not found on PATH; pass -NodePath.'; exit 1 }
  $NodePath = $cmd.Source
}

# ---------------------------------------------------------------- selection
if (-not $Hosts -and -not $All) {
  # Default: every host that currently reports installed entries.
  $doctorArgs = @((Join-Path $repoRoot 'adapters\_shared\doctor.mjs'), '--json')
  if ($BackupRoot) { $doctorArgs += @('--backup-root', $BackupRoot) }
  $doctorRaw = & $NodePath @doctorArgs 2>$null
  $installed = @()
  try {
    $report = ($doctorRaw | Out-String) | ConvertFrom-Json
    $installed = @($report.hosts | Where-Object { $_.installedEntries -gt 0 } | ForEach-Object { $_.host })
  } catch { }
  if ($installed.Count -eq 0) {
    Write-Host 'No installed HALOFLUX adapters found. Nothing to uninstall.' -ForegroundColor Yellow
    exit 0
  }
  $interactive = -not $NonInteractive -and $env:HALOFLUX_NONINTERACTIVE -ne '1' -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
  if ($interactive) {
    Write-Host ("Installed adapters: {0}" -f ($installed -join ', ')) -ForegroundColor Cyan
    $answer = Read-Host 'Hosts to uninstall (comma separated, Enter = all installed)'
    if ([string]::IsNullOrWhiteSpace($answer)) { $Hosts = $installed } else { $Hosts = @($answer -split ',' | ForEach-Object { $_.Trim() }) }
  } else {
    $Hosts = $installed
    Write-Host ("Non-interactive: uninstalling all installed adapters ({0})." -f ($installed -join ', ')) -ForegroundColor DarkGray
  }
} elseif ($All) {
  $Hosts = $supported
}

$Hosts = @($Hosts | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ } | Select-Object -Unique)
foreach ($hostId in $Hosts) {
  if ($supported -notcontains $hostId) { Write-Error "Unsupported host '$hostId'. Supported: $($supported -join ', ')"; exit 1 }
}

# ---------------------------------------------------------------- execution
$results = @()
$failed = 0
foreach ($hostId in $Hosts) {
  $script = Join-Path $repoRoot "adapters\$hostId\uninstall.ps1"
  if (-not (Test-Path $script)) { Write-Warning "Missing uninstaller for $hostId"; $failed++; continue }
  $params = @{ NodePath = $NodePath; Json = $true }
  if ($BackupRoot) { $params['BackupRoot'] = $BackupRoot }
  if ($DryRun)     { $params['DryRun'] = $true }

  $mode = 'uninstall'
  if ($DryRun) { $mode = 'dry-run' }
  Write-Host ("`n=== {0} ({1}) ===" -f $hostId, $mode) -ForegroundColor Cyan
  $raw = & $script @params 2>&1
  $code = $LASTEXITCODE
  $rawText = ($raw | Out-String).Trim()
  $parsed = $null
  try { $parsed = $rawText | ConvertFrom-Json } catch { }
  if ($code -ne 0) {
    $failed++
    Write-Host $rawText -ForegroundColor Red
    $results += [pscustomobject]@{ Host = $hostId; Status = 'FAILED'; Detail = $rawText }
  } elseif ($parsed) {
    Write-Host ("status={0} restoredSha={1}" -f $parsed.status, $parsed.afterSha256)
    if ($parsed.note) { Write-Host ("note={0}" -f $parsed.note) -ForegroundColor DarkGray }
    $results += [pscustomobject]@{ Host = $hostId; Status = $parsed.status; Detail = $parsed.configPath; Sha = $parsed.afterSha256 }
  } else {
    Write-Host $rawText
    $results += [pscustomobject]@{ Host = $hostId; Status = 'OK'; Detail = '' }
  }
}

Write-Host "`n=== summary ===" -ForegroundColor Cyan
$results | Format-Table -AutoSize
if ($Json) { $results | ConvertTo-Json -Depth 5 }
if ($failed -gt 0) { exit 1 }
exit 0
